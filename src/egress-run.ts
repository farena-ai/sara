// EC9 (docs/ops/EC89_DESIGN.md): the egress allowlist applied to one sandboxed run. Picks the
// strongest enforcement the run's sandbox has and hands back what the runner adds (variables,
// mounts, a command prefix, a container network), plus a close() that tears it down and writes the
// refusals to the audit trail (EC4): one `egress.refused` row per host per run.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from './audit-trail.ts';
import { outboundAllowed } from './net-guard.ts';
import { egressPlan, EGRESS_PORT } from './container.ts';
import { proxyEnv, startEgressProxy, type EgressEntry, type EgressProxy, type EgressRefusal } from './egress.ts';
import type { Bind, SandboxInfo } from './tools/sandbox.ts';

/** This very file's sibling, mounted into sidecars and bubblewrap. */
export const EGRESS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'egress.ts');

// ---- the server's one allowlist (main.ts sets it from settings and the policy pin) ----
let source: () => EgressEntry[] | undefined = () => undefined;
let secretOf: (name: string) => string | undefined = () => undefined;
/** undefined = open (today's behaviour); a list (maybe empty) = only these hosts. */
export function setEgressSource(fn: () => EgressEntry[] | undefined, secret?: (name: string) => string | undefined): void {
  source = fn;
  if (secret) secretOf = secret;
}
/** Tests only: resolve fake names to the local fake targets (never set by Sara itself). */
let overrides: { resolve?: (host: string) => Promise<string>; privateOk?: boolean } = {};
export function setEgressProxyOverrides(o: typeof overrides = {}): void {
  overrides = o;
}
export function egressAllowlist(): EgressEntry[] | undefined {
  try {
    return source();
  } catch {
    return []; // a damaged list never opens everything
  }
}

/** How a run's allowlist is enforced, in the run's own words (Settings, cards, results). */
export type EgressEnforcement = 'container' | 'namespace' | 'seatbelt' | 'node-guard' | 'variables';
export const ENFORCEMENT_LABELS: Record<EgressEnforcement, string> = {
  container: 'enforced: the container network only reaches the egress proxy',
  namespace: 'enforced: no network inside the sandbox except the egress proxy',
  seatbelt: 'enforced: the macOS sandbox only allows the egress proxy',
  'node-guard': 'enforced by a Node guard inside the job (not an OS boundary)',
  variables: 'not enforced here: only programs that honour proxy settings use the egress proxy',
};
export function enforcementFor(mode: SandboxInfo['mode'] | 'node-only'): EgressEnforcement {
  return mode === 'container' ? 'container' : mode === 'bwrap' ? 'namespace' : mode === 'seatbelt' ? 'seatbelt' : mode === 'node-only' ? 'node-guard' : 'variables';
}

export function auditRefusal(who: string) {
  return (r: EgressRefusal) => audit({ action: 'egress.refused', who, role: 'system', channel: 'system', outcome: 'refused', target: `${r.host}:${r.port}`.slice(0, 120), keys: [r.why] });
}

/** Runs the engine CLI without a shell; resolves with its exit code and output. */
export function engineCall(c: NonNullable<SandboxInfo['container']>, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((ok) => {
    let out = '';
    let child;
    try {
      child = spawn(c.exe, [...(c.pre ?? []), ...args], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return ok({ code: null, out: (err as Error).message });
    }
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => (out += err.message));
    child.on('close', (code) => {
      clearTimeout(t);
      ok({ code, out });
    });
  });
}

/** What the engine CLI itself needs from Sara's environment (never her keys). */
export function engineEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_CONF', 'CONTAINERS_STORAGE_CONF', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ProgramData', 'ProgramFiles', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'];
  const out: Record<string, string> = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

export interface EgressSetup {
  enforcement: EgressEnforcement;
  /** Variables for the program inside (the proxy address). */
  env: Record<string, string>;
  binds: Bind[];
  /** bubblewrap: started before the command (the in-sandbox forwarder). */
  prefix?: string;
  /** The sandbox the command now runs in (network off where the proxy is the only way out). */
  sandbox: SandboxInfo;
  /** container: the per-run internal network. */
  network?: string;
  /** seatbelt: the proxy port the profile allows. */
  proxyPort?: number;
  close(): Promise<void>;
}

/** Where Sara's Node is inside bubblewrap, and what must be mounted for it. */
export function sandboxNode(execPath: string, runtimeMounted: boolean, runtimeMount: string): { path: string; binds: Bind[] } {
  const root = dirname(dirname(execPath));
  if (root.startsWith('/usr')) return { path: execPath, binds: [] };
  if (runtimeMounted) return { path: posix.join(runtimeMount, 'bin', 'node'), binds: [] };
  return { path: execPath, binds: [{ src: root, dest: root }] };
}

/**
 * Sets up the allowlist for one run in `sandbox` (which has network on). `node` locates Sara's
 * Node inside bubblewrap; `who` names the run in refusal rows.
 */
export async function openEgress(sandbox: SandboxInfo, entries: EgressEntry[], o: { who: string; node?: { path: string; binds: Bind[] } }): Promise<EgressSetup> {
  const onRefused = auditRefusal(o.who);
  const enforcement = enforcementFor(sandbox.mode);
  if (sandbox.mode === 'container' && sandbox.container) {
    const c = sandbox.container;
    const plan = egressPlan({ id: randomUUID().replace(/-/g, '').slice(0, 12), image: c.image, proxyFile: EGRESS_FILE });
    const base = engineEnv();
    const secrets: Record<string, string> = {};
    for (const e of entries) if (e.key && secretOf(e.key)) secrets[e.key] = secretOf(e.key)!;
    const cleanup = async () => {
      const logs = await engineCall(c, plan.logs, base, 10_000);
      const told = new Set<string>();
      for (const m of logs.out.matchAll(/SARA-EGRESS-REFUSED (\{[^\n]*\})/g)) {
        try {
          const r = JSON.parse(m[1]) as EgressRefusal;
          const k = `${r.host}:${r.port}`;
          if (!told.has(k)) {
            told.add(k);
            onRefused(r);
          }
        } catch {
          /* a damaged line is skipped */
        }
      }
      for (const step of plan.cleanup) await engineCall(c, step, base, 15_000);
    };
    const step = async (args: string[], env: NodeJS.ProcessEnv = base) => {
      const r = await engineCall(c, args, env);
      if (r.code !== 0) throw new Error(`The egress network could not be set up: ${r.out.trim().slice(0, 200)}`);
    };
    try {
      await step(plan.create);
      await step(plan.sidecar, { ...base, SARA_EGRESS_ALLOW: JSON.stringify(entries.map((e) => ({ host: `${e.wildcard ? '*.' : ''}${e.host}${e.port ? `:${e.port}` : ''}`, ...(e.key ? { key: e.key } : {}) }))), SARA_EGRESS_PORT: String(EGRESS_PORT), SARA_EGRESS_SECRETS: JSON.stringify(secrets) });
      await step(plan.connect);
      let ready = false;
      for (let i = 0; i < 50 && !ready; i++) {
        ready = /SARA-EGRESS-READY/.test((await engineCall(c, plan.logs, base, 5000)).out);
        if (!ready) await new Promise((r) => setTimeout(r, 200));
      }
      if (!ready) throw new Error('The egress proxy container did not start.');
    } catch (err) {
      await cleanup();
      throw err;
    }
    return { enforcement, env: proxyEnv(plan.proxyUrl), binds: [], sandbox, network: plan.network, close: cleanup };
  }
  const proxyOpts = { entries, onRefused, secret: (k: string) => secretOf(k), outboundAllowed: (t: string) => outboundAllowed(t), ...overrides };
  if (sandbox.mode === 'bwrap') {
    const dir = mkdtempSync(join(tmpdir(), 'sara-egress-'));
    const sock = join(dir, 'egress.sock');
    let proxy: EgressProxy;
    try {
      proxy = await startEgressProxy({ ...proxyOpts, listen: { path: sock } });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const node = o.node ?? { path: process.execPath, binds: [] };
    const prefix = `${node.path} /opt/sara-egress.ts forward ${EGRESS_PORT} /run/sara-egress/egress.sock /tmp/.sara-egress-ready >/dev/null 2>&1 </dev/null & __i=0; while [ ! -e /tmp/.sara-egress-ready ] && [ $__i -lt 100 ]; do sleep 0.05; __i=$((__i+1)); done; `;
    return {
      enforcement,
      env: proxyEnv(`http://127.0.0.1:${EGRESS_PORT}`),
      binds: [{ src: dir, dest: '/run/sara-egress', rw: true }, { src: EGRESS_FILE, dest: '/opt/sara-egress.ts' }, ...node.binds],
      prefix,
      sandbox: { ...sandbox, network: false },
      close: async () => {
        await proxy.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  const proxy = await startEgressProxy(proxyOpts);
  return {
    enforcement,
    env: proxyEnv(`http://127.0.0.1:${proxy.port}`),
    binds: [],
    sandbox: sandbox.mode === 'seatbelt' ? { ...sandbox, network: false } : sandbox,
    ...(sandbox.mode === 'seatbelt' ? { proxyPort: proxy.port } : {}),
    close: () => proxy.close(),
  };
}
