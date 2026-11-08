// EC8 (docs/ops/EC89_DESIGN.md): the container sandbox. Rootless Podman (preferred) or Docker, when
// one is installed and its local image is present (never pulled). Commands, plugin jobs and sandbox
// tries run in a throwaway container that sees only the workspace (or the job's copy) at /workspace,
// with a read-only root, no capabilities, no new privileges, a process and memory cap and no network
// unless the run has it. Everything here builds argv arrays that are spawned WITHOUT a shell: the
// command text is a single argument to /bin/sh inside the container, never parsed on the host.
import { spawnSync } from 'node:child_process';
import type { SandboxInfo } from './tools/sandbox.ts';

export type Engine = 'podman' | 'docker';
export const ENGINES: readonly Engine[] = ['podman', 'docker'];
export type EnginePref = 'auto' | Engine;
export type BackendPref = 'auto' | 'native' | 'container';
export const BACKEND_PREFS: readonly BackendPref[] = ['auto', 'native', 'container'];

export class ContainerRefused extends Error {}

export interface EngineInfo {
  engine: Engine;
  /** The CLI to spawn (a name on PATH or a full path). */
  exe: string;
  rootless: boolean;
  version: string;
  image: string;
  imagePresent: boolean;
}

export type Probe = (file: string, args: string[]) => { status: number | null; stdout: string };
const probeRun: Probe = (file, args) => {
  try {
    const r = spawnSync(file, args, { timeout: 8000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: r.error ? null : r.status, stdout: String(r.stdout ?? '') };
  } catch {
    return { status: null, stdout: '' };
  }
};

/** A local image reference: name[:tag] or name@sha256:…; never something that reads as a flag. */
export const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,120}(:[\w.-]{1,64})?(@sha256:[a-f0-9]{64})?$/i;
export function checkImage(image: string): string {
  if (!IMAGE_RE.test(image)) throw new ContainerRefused(`"${image.slice(0, 60)}" isn't an image name.`);
  return image;
}

export const ENGINE_LABEL: Record<Engine, string> = { podman: 'Podman', docker: 'Docker' };

/**
 * Finds a working engine: the CLI answers, its daemon/service answers (`version`), whether it runs
 * rootless (`info`), and the image is already there (`image inspect`). Nothing is pulled or started.
 */
export function detectEngine(o: { image: string; prefer?: EnginePref; probe?: Probe; exes?: Partial<Record<Engine, string>> }): { found?: EngineInfo; tried: { engine: Engine; exe: string; ok: boolean; why?: string }[] } {
  checkImage(o.image);
  const probe = o.probe ?? probeRun;
  const order: Engine[] = o.prefer === 'docker' ? ['docker', 'podman'] : ['podman', 'docker'];
  const tried: { engine: Engine; exe: string; ok: boolean; why?: string }[] = [];
  for (const engine of order) {
    const exe = o.exes?.[engine] ?? engine;
    const v = probe(exe, engine === 'podman' ? ['version', '--format', '{{.Client.Version}}'] : ['version', '--format', '{{.Server.Version}}']);
    if (v.status !== 0) {
      tried.push({ engine, exe, ok: false, why: v.status === null ? `${ENGINE_LABEL[engine]} is not installed.` : `${ENGINE_LABEL[engine]} is installed but not running.` });
      continue;
    }
    const info = probe(exe, engine === 'podman' ? ['info', '--format', '{{.Host.Security.Rootless}}'] : ['info', '--format', '{{json .SecurityOptions}}']);
    const rootless = engine === 'podman' ? /true/.test(info.stdout) : /rootless/.test(info.stdout);
    const img = probe(exe, ['image', 'inspect', '--format', '{{.Id}}', o.image]);
    const found: EngineInfo = { engine, exe, rootless, version: v.stdout.trim().slice(0, 40), image: o.image, imagePresent: img.status === 0 };
    if (!found.imagePresent) {
      tried.push({ engine, exe, ok: false, why: `${ENGINE_LABEL[engine]} works, but the image ${o.image} is not on this computer (run: ${engine} pull ${o.image}).` });
      continue;
    }
    tried.push({ engine, exe, ok: true });
    return { found, tried };
  }
  return { tried };
}

/**
 * Which sandbox commands and jobs use. `auto`: the native one on Linux (bubblewrap) and macOS
 * (Seatbelt); a container where there is none (Windows, Linux without bubblewrap). `container`: the
 * engine when it works, else the native sandbox with the reason. `required` (the admin's pin): the
 * engine or nothing; without one, runs are refused.
 */
export function selectBackend(i: { platform: NodeJS.Platform; native: SandboxInfo; engine?: EngineInfo; pref: BackendPref; required?: boolean; why?: string }): SandboxInfo {
  const e = i.engine?.imagePresent ? i.engine : undefined;
  const container = (e: EngineInfo): SandboxInfo => ({
    mode: 'container',
    network: i.native.network,
    detail: `${ENGINE_LABEL[e.engine]}${e.rootless ? ' (rootless)' : ''} container: only the workspace is mounted; Sara's data, your home folder and the system are out of reach; no network unless allowed.`,
    container: { engine: e.engine, exe: e.exe, rootless: e.rootless, image: e.image },
    native: i.native,
  });
  if (i.required) {
    if (e) return container(e);
    return { mode: 'none', network: i.native.network, detail: 'Your admin requires the container sandbox, and no working Podman or Docker was found.', refuse: `Your admin requires the container sandbox, and no working Podman or Docker (with its image) was found on this computer.${i.why ? ` ${i.why}` : ''}` };
  }
  if (i.pref === 'native') return i.native;
  if (i.pref === 'container') return e ? container(e) : { ...i.native, detail: `Containers chosen, but no working Podman or Docker was found${i.why ? ` (${i.why})` : ''}. ${i.native.detail}` };
  if (i.native.mode !== 'none') return i.native;
  return e ? container(e) : i.native;
}

// ------------------------------------------------------------------------------------------------
// command construction
// ------------------------------------------------------------------------------------------------

export interface ContainerMount {
  src: string;
  dest: string;
  rw?: boolean;
}
export interface ContainerSpec {
  name: string;
  image: string;
  /** Host folder mounted read-write at /workspace. */
  workspace: string;
  mounts?: ContainerMount[];
  /** `none`, `default` (the engine's own network) or a per-run sidecar network `sara-eg-…`. */
  network: string;
  /** Variable NAMES; values come from the CLI process's environment. */
  env: string[];
  /** A private NAME=value file (the run's own temp folder): values never in argv. */
  envFile?: string;
  /** Podman rootless `keep-id`, or `uid:gid` for rootful Docker on Linux. */
  user?: string;
  /** Inside /workspace (default /workspace). */
  workdir?: string;
  argv: string[];
}

const NAME_RE = /^sara-[a-z0-9-]{1,60}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BAD_PATH = /[,"\0\r\n]/;
const ENGINE_SOCKET = /(docker|podman)\.sock$|^\\\\[.?]\\pipe\\/i;

function hostPath(p: string): string {
  if (BAD_PATH.test(p) || !(/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p))) throw new ContainerRefused(`"${p.slice(0, 80)}" can't be mounted (an absolute path without commas or quotes is needed).`);
  if (ENGINE_SOCKET.test(p)) throw new ContainerRefused('The container engine itself is never mounted.');
  return p;
}
function innerPath(p: string): string {
  if (BAD_PATH.test(p) || !p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '.')) throw new ContainerRefused(`"${p.slice(0, 80)}" isn't a path inside the container.`);
  return p;
}

/** The `run` argv (after the engine executable). Throws ContainerRefused on anything unsafe. */
export function containerRunArgv(s: ContainerSpec): string[] {
  if (!NAME_RE.test(s.name)) throw new ContainerRefused('A container name must start with sara-.');
  checkImage(s.image);
  if (s.network !== 'none' && s.network !== 'default' && !NAME_RE.test(s.network)) throw new ContainerRefused('A run uses no network, the default one or its own egress network.');
  for (const n of s.env) if (!ENV_RE.test(n)) throw new ContainerRefused(`"${n.slice(0, 40)}" isn't a variable name.`);
  if (s.user !== undefined && s.user !== 'keep-id' && !/^\d{1,10}:\d{1,10}$/.test(s.user)) throw new ContainerRefused('The user is keep-id or uid:gid.');
  if (!s.argv.length || s.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new ContainerRefused('Nothing to run.');
  const mounts = (s.mounts ?? []).map((m) => `type=bind,source=${hostPath(m.src)},target=${innerPath(m.dest)}${m.rw ? '' : ',readonly'}`);
  return [
    'run', '--rm', '--init', '--pull=never', '--name', s.name,
    ...(s.network === 'default' ? [] : ['--network', s.network]),
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '512', '--memory', '2g',
    ...(s.user === 'keep-id' ? ['--userns=keep-id'] : s.user ? ['--user', s.user] : []),
    '--mount', `type=bind,source=${hostPath(s.workspace)},target=/workspace`,
    ...mounts.flatMap((m) => ['--mount', m]),
    '-w', innerPath(s.workdir ?? '/workspace'),
    ...s.env.flatMap((n) => ['-e', n]),
    ...(s.envFile ? ['--env-file', hostPath(s.envFile)] : []),
    s.image,
    ...s.argv,
  ];
}

/** The user mapping for this engine on this OS (files written in /workspace stay the owner's). */
export function containerUser(c: Pick<EngineInfo, 'engine' | 'rootless'>, platform: NodeJS.Platform = process.platform): string | undefined {
  if (c.engine === 'podman' && c.rootless) return 'keep-id';
  if (platform === 'linux' && !c.rootless && process.getuid && process.getgid) return `${process.getuid()}:${process.getgid()}`;
  return undefined;
}

export const EGRESS_PORT = 3128;
/** The egress sidecar for one run: an internal network whose only way out is the proxy container. */
export function egressPlan(o: { id: string; image: string; proxyFile: string }): { network: string; proxyName: string; proxyUrl: string; create: string[]; sidecar: string[]; connect: string[]; logs: string[]; cleanup: string[][] } {
  if (!/^[a-z0-9]{1,40}$/.test(o.id)) throw new ContainerRefused('Bad run id.');
  checkImage(o.image);
  const network = `sara-eg-${o.id}`;
  const proxyName = `${network}-proxy`;
  return {
    network,
    proxyName,
    proxyUrl: `http://${proxyName}:${EGRESS_PORT}`,
    create: ['network', 'create', '--internal', network],
    sidecar: [
      'run', '-d', '--rm', '--init', '--pull=never', '--name', proxyName,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m',
      '--mount', `type=bind,source=${hostPath(o.proxyFile)},target=/sara/egress.ts,readonly`,
      '-e', 'SARA_EGRESS_ALLOW', '-e', 'SARA_EGRESS_PORT', '-e', 'SARA_EGRESS_SECRETS',
      o.image, 'node', '/sara/egress.ts', 'serve',
    ],
    connect: ['network', 'connect', network, proxyName],
    logs: ['logs', proxyName],
    cleanup: [['rm', '-f', proxyName], ['network', 'rm', network]],
  };
}
