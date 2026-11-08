// EC8 + EC9 (docs/ops/EC89_DESIGN.md): which sandbox the server uses (the native one or a container)
// and which hosts sandboxed work may reach. Server-wide settings of the owner; the admin's policy pins
// (`containerSandbox`, `egressAllowlist`) only tighten them and are enforced here and in the routes.
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { BACKEND_PREFS, detectEngine, ENGINES, selectBackend, type BackendPref, type Engine, type EngineInfo, type EnginePref, type Probe } from './container.ts';
import { EgressError, parseAllowlist, type EgressEntry, type EgressInput } from './egress.ts';
import { enforcementFor, ENFORCEMENT_LABELS, type EgressEnforcement } from './egress-run.ts';
import { HttpError } from './http.ts';
import type { PolicyPins } from './policy-profile.ts';
import type { SandboxInfo } from './tools/sandbox.ts';

export interface IsolationSettings {
  backend: BackendPref;
  engine: EnginePref;
}
export interface EgressSettings {
  mode: 'open' | 'allowlist';
  hosts: EgressInput[];
}
type S = { isolation?: Partial<IsolationSettings>; egress?: Partial<EgressSettings> };

export function isolationSettings(s: S): IsolationSettings {
  const i = s.isolation ?? {};
  return { backend: BACKEND_PREFS.includes(i.backend as BackendPref) ? (i.backend as BackendPref) : 'auto', engine: i.engine === 'podman' || i.engine === 'docker' ? i.engine : 'auto' };
}
export function egressSettings(s: S): EgressSettings {
  const e = s.egress ?? {};
  return { mode: e.mode === 'allowlist' ? 'allowlist' : 'open', hosts: Array.isArray(e.hosts) ? e.hosts : [] };
}

/** The allowlist in force: the admin's pinned list, else the owner's when switched on; undefined = open. */
export function effectiveEgress(s: S, pins: PolicyPins): EgressEntry[] | undefined {
  if (pins.egressAllowlist) return parseAllowlist(pins.egressAllowlist);
  const e = egressSettings(s);
  return e.mode === 'allowlist' ? parseAllowlist(e.hosts) : undefined;
}

/** Checks a PUT /api/isolation body against the current settings and the pins; returns the patch. */
export function isolationPatch(body: Record<string, unknown>, cur: S, pins: PolicyPins, refusal: (key: 'containerSandbox' | 'egressAllowlist') => Error): { isolation?: IsolationSettings; egress?: EgressSettings } {
  const out: { isolation?: IsolationSettings; egress?: EgressSettings } = {};
  if (body.backend !== undefined || body.engine !== undefined) {
    const i = isolationSettings(cur);
    if (body.backend !== undefined && !BACKEND_PREFS.includes(body.backend as BackendPref)) throw new HttpError(400, 'backend must be auto, native or container.');
    if (body.engine !== undefined && body.engine !== 'auto' && !ENGINES.includes(body.engine as Engine)) throw new HttpError(400, 'engine must be auto, podman or docker.');
    const next: IsolationSettings = { backend: (body.backend as BackendPref) ?? i.backend, engine: (body.engine as EnginePref) ?? i.engine };
    if (pins.containerSandbox && next.backend !== 'container') throw refusal('containerSandbox');
    out.isolation = next;
  }
  if (body.egressMode !== undefined || body.egressHosts !== undefined) {
    const e = egressSettings(cur);
    if (body.egressMode !== undefined && body.egressMode !== 'open' && body.egressMode !== 'allowlist') throw new HttpError(400, 'egressMode must be open or allowlist.');
    const hosts = body.egressHosts === undefined ? e.hosts : body.egressHosts;
    try {
      parseAllowlist(hosts);
    } catch (err) {
      if (err instanceof EgressError) throw new HttpError(400, err.message);
      throw err;
    }
    const next: EgressSettings = { mode: (body.egressMode as EgressSettings['mode']) ?? e.mode, hosts: hosts as EgressInput[] };
    if (pins.egressAllowlist && (next.mode !== 'allowlist' || JSON.stringify(next.hosts) !== JSON.stringify(pins.egressAllowlist))) throw refusal('egressAllowlist');
    out.egress = next;
  }
  return out;
}

/** Known install folders (a running Sara's PATH is stale after an install on Windows). */
export function engineExe(engine: Engine, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const known = engine === 'docker' ? win32.join(pf, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe') : win32.join(pf, 'RedHat', 'Podman', 'podman.exe');
    if (exists(known)) return known;
  }
  if (platform === 'darwin' && engine === 'docker' && exists('/usr/local/bin/docker')) return '/usr/local/bin/docker';
  if (platform === 'darwin' && engine === 'podman' && exists('/opt/podman/bin/podman')) return '/opt/podman/bin/podman';
  return engine;
}

export interface IsolationOptions {
  native: SandboxInfo;
  target: SandboxInfo;
  settings: () => IsolationSettings;
  image: () => string;
  required: () => boolean;
  probe?: Probe;
  platform?: NodeJS.Platform;
  onChange?: (s: SandboxInfo) => void;
}

export interface IsolationStatus {
  backend: BackendPref;
  engine: EnginePref;
  sandbox: { mode: SandboxInfo['mode']; detail: string; isolated: boolean; refused: boolean };
  found?: Pick<EngineInfo, 'engine' | 'rootless' | 'version' | 'image'>;
  tried: { engine: Engine; ok: boolean; why?: string }[];
  image: string;
  checkedAt: string | null;
}

/**
 * The live sandbox: `target` is the very object every part of Sara holds (commands, plugin jobs,
 * tool servers, health), updated in place when the owner changes the choice, a pin changes or
 * *Look again* finds a newly installed engine.
 */
export class IsolationService {
  #found?: EngineInfo;
  #tried: IsolationStatus['tried'] = [];
  #at: string | null = null;
  readonly o: IsolationOptions;
  constructor(o: IsolationOptions) {
    this.o = o;
  }

  /** Detects (only when a container could be used) and applies the choice. */
  recheck(): IsolationStatus {
    const platform = this.o.platform ?? process.platform;
    const s = this.o.settings();
    const required = this.o.required();
    const wanted = required || s.backend === 'container' || (s.backend === 'auto' && this.o.native.mode === 'none');
    this.#found = undefined;
    this.#tried = [];
    if (wanted) {
      try {
        const r = detectEngine({ image: this.o.image(), prefer: s.engine, ...(this.o.probe ? { probe: this.o.probe } : {}), exes: { docker: engineExe('docker', process.env, existsSync, platform), podman: engineExe('podman', process.env, existsSync, platform) } });
        this.#found = r.found;
        this.#tried = r.tried.map(({ engine, ok, why }) => ({ engine, ok, ...(why ? { why } : {}) }));
      } catch (err) {
        this.#tried = [{ engine: 'docker', ok: false, why: (err as Error).message }];
      }
    }
    this.#at = new Date().toISOString();
    const why = this.#tried.map((t) => t.why).filter(Boolean).join(' ');
    const next = selectBackend({ platform, native: this.o.native, ...(this.#found ? { engine: this.#found } : {}), pref: s.backend, required, ...(why ? { why } : {}) });
    const t = this.o.target as unknown as Record<string, unknown>;
    for (const k of Object.keys(t)) delete t[k];
    Object.assign(t, next);
    this.o.onChange?.(this.o.target);
    return this.status();
  }

  status(): IsolationStatus {
    const s = this.o.settings();
    const t = this.o.target;
    return {
      ...s,
      sandbox: { mode: t.mode, detail: t.detail, isolated: t.mode !== 'none', refused: Boolean(t.refuse) },
      ...(this.#found ? { found: { engine: this.#found.engine, rootless: this.#found.rootless, version: this.#found.version, image: this.#found.image } } : {}),
      tried: this.#tried,
      image: this.o.image(),
      checkedAt: this.#at,
    };
  }
}

/** How the allowlist is enforced for commands and for plugin jobs on this sandbox (Settings shows it in words). */
export function enforcementNote(sb: SandboxInfo): { commands: EgressEnforcement; jobs: EgressEnforcement; commandsText: string; jobsText: string } {
  const commands = enforcementFor(sb.mode);
  const jobs: EgressEnforcement = sb.mode === 'bwrap' || sb.mode === 'container' ? commands : 'node-guard';
  return { commands, jobs, commandsText: ENFORCEMENT_LABELS[commands], jobsText: ENFORCEMENT_LABELS[jobs] };
}

let current: IsolationService | undefined;
export function setIsolation(s: IsolationService | undefined): void {
  current = s;
}
export function isolation(): IsolationService | undefined {
  return current;
}
