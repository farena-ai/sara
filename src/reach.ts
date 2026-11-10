// 3.3.0 (easy reach): "how can other devices reach me?" One answer for the phone pairing QR, Add a
// computer, the move-in line, Health and the "Use Sara away from home" page.
//
// The rule: never offer 127.0.0.1 / localhost / ::1 to another device. In order of preference:
//   1. `tailscale serve` already pointing at Sara: https://<machine>.<tailnet>.ts.net[:port] (works
//      anywhere on your own devices, with HTTPS, so the microphone works too);
//   2. the https address the owner (or the installer) set in SARA_PUBLIC_URL;
//   3. the address this browser used, when it isn't this computer's own;
//   4. Tailscale's 100.x address, when Sara listens beyond this computer (SARA_HOST=0.0.0.0);
//   5. the home-network address (192.168.x, 10.x, 172.16–31.x), same condition (at home only).
// When nothing is left, the UI says "Your phone can't reach this computer yet" instead of a QR.
//
// Everything that touches the outside (the tailscale command, network interfaces, fetch) is a
// seam (`setReachDeps`) so the tests run against a fake CLI and never change this PC's Tailscale.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { netFetch } from './net-guard.ts';
import { pickServePort, serveIsOurs } from './sara-windows.ts';
import { findTailscale } from './tailscale.ts';

/** The Android app (Google Play; the listing may still be in review) and the direct download. */
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.backstagecoding.sara';
export const APK_URL = 'https://github.com/farena-ai/sara/releases/latest';
/** The verified App Link the Android app opens (android/app/src/main/AndroidManifest.xml). */
export const PAIR_LINK_BASE = 'https://backstagecoding.com/sara/pair';
/** Tailscale's own download pages (a free app from another company). */
export const TAILSCALE_GET = {
  windows: 'https://tailscale.com/download/windows',
  mac: 'https://tailscale.com/download/mac',
  linux: 'https://tailscale.com/download/linux',
  android: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  ios: 'https://apps.apple.com/app/tailscale/id1470499037',
} as const;

export type ReachKind = 'tailscale-https' | 'tailscale' | 'public' | 'lan';
export interface ReachCandidate {
  url: string;
  kind: ReachKind;
  /** Works away from home (not only on the same Wi-Fi). */
  away: boolean;
  https: boolean;
  from: 'serve' | 'public-url' | 'browser' | 'tailscale-ip' | 'lan';
}
export interface ReachInfo {
  /** The best address for another device, or null (never this computer's own 127.0.0.1). */
  address: string | null;
  kind: ReachKind | null;
  away: boolean;
  https: boolean;
  /** The best address that works away from home (may differ from `address`'s LAN one). */
  awayAddress: string | null;
  candidates: ReachCandidate[];
  listen: { host: string; port: number; loopbackOnly: boolean };
  tailscale: {
    installed: boolean;
    running: boolean;
    /** Running, NeedsLogin, Stopped, … (null when not installed or not answering). */
    state: string | null;
    dnsName: string | null;
    ip: string | null;
    /** HTTPS certificates are on for the tailnet (needed for `tailscale serve`); null = unknown. */
    httpsOk: boolean | null;
    serve: { on: boolean; port: number | null; url: string | null; ours: boolean; byInstaller: boolean };
    /** "Turn on secure access with Tailscale" can be offered here. */
    canServe: boolean;
  };
  /** Where to get things, for the guided page. */
  get: { android: string; apk: string; tailscale: typeof TAILSCALE_GET };
  system: 'windows' | 'mac' | 'linux';
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export interface ReachDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Where the tailscale command is (null: not installed). */
  cli?: () => string | null;
  /** Runs the tailscale command. */
  run?: (cli: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  fetch?: typeof fetch;
  now?: () => number;
}

let deps: ReachDeps = {};
/** Tests: fake the tailscale CLI, the interfaces, the environment and fetch. Pass {} to reset. */
export function setReachDeps(d: ReachDeps): void {
  deps = d;
  cache = undefined;
}

const realRun = (cli: string, args: string[], timeoutMs: number): Promise<RunResult> =>
  new Promise((done) => {
    execFile(cli, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? null : 0;
      done({ status: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(err && code === null ? { error: err } : {}) });
    });
  });

const env = () => deps.env ?? process.env;
const run = (cli: string, args: string[], timeoutMs = 8000) => (deps.run ?? realRun)(cli, args, timeoutMs);

/** 127.x, ::1, localhost, 0.0.0.0: never an address for another device. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0' || h === '' || /^127\./.test(h) || /^::ffff:127\./.test(h);
}
export const isTailscaleIp = (h: string) => {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
};
export const isLanIp = (h: string) => /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(h) || /^169\.254\./.test(h);

/** A plain http(s) origin without user info, or null; never a loopback one. */
export function cleanOrigin(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(String(u).trim());
    if ((p.protocol !== 'https:' && p.protocol !== 'http:') || p.username || p.password) return null;
    if (isLoopbackHost(p.hostname)) return null;
    return p.origin;
  } catch {
    return null;
  }
}

/** The port the request came in on (this server's real one; 0 when unknown). */
export const listenPort = (req: { socket?: unknown }) => Number((req.socket as { localPort?: number } | undefined)?.localPort ?? 0);

/**
 * The address the asking browser used (Origin, else Host with the forwarded protocol), or null.
 * A loopback one comes back as null too: it only works on this computer.
 */
export function browserOrigin(req: { headers: Record<string, string | string[] | undefined>; socket?: unknown }): string | null {
  const o = req.headers.origin;
  if (typeof o === 'string' && o !== 'null') return cleanOrigin(o);
  const host = req.headers.host;
  if (typeof host !== 'string' || !host) return null;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http');
  return cleanOrigin(`${proto === 'https' ? 'https' : 'http'}://${host}`);
}

function classify(origin: string, from: ReachCandidate['from']): ReachCandidate {
  const u = new URL(origin);
  const h = u.hostname.toLowerCase();
  const https = u.protocol === 'https:';
  if (h.endsWith('.ts.net') || isTailscaleIp(h)) return { url: origin, kind: https ? 'tailscale-https' : 'tailscale', away: true, https, from };
  if (isLanIp(h) || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.')) return { url: origin, kind: 'lan', away: false, https, from };
  return { url: origin, kind: 'public', away: true, https, from };
}

const score = (c: ReachCandidate) => (c.away ? 4 : 0) + (c.https ? 2 : 0) + (c.from === 'serve' ? 1 : 0);

function lanIp(): string | null {
  const ifs = (deps.interfaces ?? networkInterfaces)();
  for (const list of Object.values(ifs)) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)) return a.address;
  return null;
}
function tailscaleIfIp(): string | null {
  const ifs = (deps.interfaces ?? networkInterfaces)();
  for (const list of Object.values(ifs)) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && isTailscaleIp(a.address)) return a.address;
  return null;
}

/** <data>/reach.json: what Sara itself turned on (so Undo only touches that). */
interface ReachState {
  servePort?: number;
  target?: string;
  at?: string;
}
const statePath = (dataDir: string) => join(dataDir, 'reach.json');
export function readReachState(dataDir: string | undefined): ReachState {
  if (!dataDir) return {};
  try {
    return JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as ReachState;
  } catch {
    return {};
  }
}
function writeReachState(dataDir: string | undefined, s: ReachState): void {
  if (!dataDir) return;
  try {
    writeFileSync(statePath(dataDir), JSON.stringify(s, null, 1));
  } catch {
    /* a read-only data folder: Undo then checks the serve status alone */
  }
}

interface TsRead {
  installed: boolean;
  cli: string | null;
  running: boolean;
  state: string | null;
  dnsName: string | null;
  ip: string | null;
  httpsOk: boolean | null;
  serveJson: string;
}

async function readTailscale(): Promise<TsRead> {
  const cli = deps.cli ? deps.cli() : findTailscale({ ...(deps.env ? { env: deps.env } : {}), ...(deps.platform ? { platform: deps.platform } : {}) });
  const none: TsRead = { installed: false, cli: null, running: false, state: null, dnsName: null, ip: null, httpsOk: null, serveJson: '' };
  if (!cli) {
    // No command found, but a 100.x interface means Tailscale is there (a portable or store install).
    const ip = tailscaleIfIp();
    return ip ? { ...none, installed: true, running: true, state: 'Running', ip } : none;
  }
  const r = await run(cli, ['status', '--json']).catch((err: Error) => ({ status: null, stdout: '', stderr: '', error: err }) as RunResult);
  const out: TsRead = { ...none, installed: true, cli };
  if (!r.stdout.trim().startsWith('{')) return out;
  try {
    const j = JSON.parse(r.stdout) as { BackendState?: string; CertDomains?: unknown; Self?: { DNSName?: string; TailscaleIPs?: unknown; Capabilities?: unknown } };
    out.state = typeof j.BackendState === 'string' ? j.BackendState : null;
    out.running = out.state === 'Running';
    out.dnsName = typeof j.Self?.DNSName === 'string' && j.Self.DNSName ? j.Self.DNSName.replace(/\.$/, '') : null;
    const ips = Array.isArray(j.Self?.TailscaleIPs) ? (j.Self.TailscaleIPs as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    out.ip = ips.find((x) => isTailscaleIp(x)) ?? null;
    const caps = Array.isArray(j.Self?.Capabilities) ? (j.Self.Capabilities as unknown[]) : [];
    out.httpsOk = Array.isArray(j.CertDomains) ? j.CertDomains.length > 0 : caps.length ? caps.includes('https') : null;
  } catch {
    return out;
  }
  if (out.running) {
    const s = await run(cli, ['serve', 'status', '--json']).catch(() => ({ status: null, stdout: '', stderr: '' }) as RunResult);
    out.serveJson = s.stdout.trim().startsWith('{') ? s.stdout : '';
  }
  return out;
}

/** The HTTPS port `tailscale serve` uses for Sara now (0: none). */
export function servePortFor(serveJson: string, dnsName: string, port: number): number {
  if (!serveJson) return 0;
  for (const target of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    const p = pickServePort(serveJson, dnsName, target);
    if (p.ours) return p.port;
  }
  return 0;
}

let cache: { at: number; key: string; info: ReachInfo } | undefined;

/**
 * How other devices can reach this Sara. `origin` is the address the asking browser used (only
 * counted when it isn't this computer's own). Cached for 10 s (`fresh` skips it).
 */
export async function resolveReach(o: { origin?: string | null; dataDir?: string; fresh?: boolean; port?: number } = {}): Promise<ReachInfo> {
  const e = env();
  const now = (deps.now ?? Date.now)();
  const key = `${o.origin ?? ''}|${o.dataDir ?? ''}|${o.port ?? ''}`;
  if (!o.fresh && cache && cache.key === key && now - cache.at < 10_000) return cache.info;
  const host = String(e.SARA_HOST ?? '127.0.0.1').trim();
  // The port this server really listens on (the request's), else SARA_PORT.
  const port = o.port || Number(e.SARA_PORT ?? 7860);
  const loopbackOnly = isLoopbackHost(host) && host !== '0.0.0.0' && host !== '::' && host !== '';
  const wide = !loopbackOnly;
  const ts = await readTailscale();
  const platform = deps.platform ?? process.platform;
  const system = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';

  const cands: ReachCandidate[] = [];
  const push = (c: ReachCandidate | null) => {
    if (!c) return;
    if (isLoopbackHost(new URL(c.url).hostname)) return;
    if (!cands.some((x) => x.url === c.url)) cands.push(c);
  };
  // 1. tailscale serve → https on the tailnet.
  const sp = ts.running && ts.dnsName ? servePortFor(ts.serveJson, ts.dnsName, port) : 0;
  const serveUrl = sp && ts.dnsName ? `https://${ts.dnsName}${sp === 443 ? '' : `:${sp}`}` : null;
  if (serveUrl) push({ url: serveUrl, kind: 'tailscale-https', away: true, https: true, from: 'serve' });
  // 2. The configured public address (installer / owner).
  const pub = cleanOrigin(e.SARA_PUBLIC_URL);
  if (pub) push(classify(pub, 'public-url'));
  // 3. The address this browser used.
  const br = cleanOrigin(o.origin);
  if (br) push(classify(br, 'browser'));
  // 4./5. Generated addresses, only when Sara listens beyond this computer.
  if (wide) {
    const listensOn = (ip: string) => host === '0.0.0.0' || host === '::' || host === '' || host === ip;
    if (ts.running && ts.ip && listensOn(ts.ip)) push({ url: `http://${ts.ip}:${port}`, kind: 'tailscale', away: true, https: false, from: 'tailscale-ip' });
    const lan = lanIp();
    if (lan && listensOn(lan)) push({ url: `http://${lan}:${port}`, kind: 'lan', away: false, https: false, from: 'lan' });
  }
  const sorted = cands.map((c, i) => ({ c, i })).sort((a, b) => score(b.c) - score(a.c) || a.i - b.i).map((x) => x.c);
  const best = sorted[0] ?? null;
  const awayBest = sorted.find((c) => c.away) ?? null;
  const st = readReachState(o.dataDir);
  const byInstaller = e.SARA_ACCESS === 'tailscale' && Boolean(serveUrl);
  const info: ReachInfo = {
    address: best?.url ?? null,
    kind: best?.kind ?? null,
    away: Boolean(awayBest),
    https: Boolean(best?.https),
    awayAddress: awayBest?.url ?? null,
    candidates: sorted,
    listen: { host, port, loopbackOnly },
    tailscale: {
      installed: ts.installed,
      running: ts.running,
      state: ts.state,
      dnsName: ts.dnsName,
      ip: ts.ip,
      httpsOk: ts.httpsOk,
      serve: { on: Boolean(serveUrl), port: sp || null, url: serveUrl, ours: Boolean(sp && st.servePort === sp), byInstaller },
      canServe: Boolean(ts.cli && ts.running && ts.dnsName && ts.httpsOk !== false && !serveUrl),
    },
    get: { android: PLAY_URL, apk: APK_URL, tailscale: TAILSCALE_GET },
    system,
  };
  cache = { at: now, key, info };
  return info;
}

// ---------------------------------------------------------------- the phone pairing link

/** The link in the phone QR: opens the Sara app (App Link) with the server and one-time code. */
export function phonePairLink(address: string, code: string): string {
  const a = cleanOrigin(address);
  if (!a) throw new Error('No address another device can reach.');
  return `${PAIR_LINK_BASE}#s=${encodeURIComponent(a)}&c=${encodeURIComponent(code)}`;
}
/** The link for another computer (its browser or the desktop app's /pair page). */
export function computerPairLink(address: string, code: string): string {
  const a = cleanOrigin(address);
  if (!a) throw new Error('No address another device can reach.');
  return `${a}/pair#${code}`;
}

// ---------------------------------------------------------------- "can my phone reach Sara?"

/** A random secret for this process: the self-test knows it really reached *this* Sara. */
const INSTANCE = randomBytes(16).toString('hex');
export const reachSignature = (nonce: string) => createHash('sha256').update(`${INSTANCE}:${nonce}`).digest('hex').slice(0, 32);

export interface ReachCheck {
  ok: boolean;
  address: string | null;
  /** NO_ADDRESS, TIMEOUT, OTHER (another server answered), HTTP_<n>, UNREACHABLE, PRIVATE_LOCAL */
  code?: string;
  detail?: string;
  ms?: number;
}

/** Sara asks herself through the address another device would use (GET /api/health/reach). */
export async function checkReach(address: string | null): Promise<ReachCheck> {
  const a = cleanOrigin(address);
  if (!a) return { ok: false, address: null, code: 'NO_ADDRESS' };
  const nonce = randomBytes(12).toString('hex');
  const t0 = Date.now();
  const f = deps.fetch ?? netFetch;
  try {
    const r = await f(`${a}/api/health/reach?n=${nonce}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, address: a, code: `HTTP_${r.status}`, ms: Date.now() - t0 };
    const j = (await r.json().catch(() => ({}))) as { reach?: string };
    if (j.reach !== reachSignature(nonce)) return { ok: false, address: a, code: 'OTHER', ms: Date.now() - t0 };
    return { ok: true, address: a, ms: Date.now() - t0 };
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'PRIVATE_LOCAL') return { ok: false, address: a, code: 'PRIVATE_LOCAL' };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ok: false, address: a, code: 'TIMEOUT' };
    return { ok: false, address: a, code: 'UNREACHABLE', detail: String(e.message ?? '').slice(0, 200) };
  }
}

// ---------------------------------------------------------------- tailscale serve on / off

export interface ServeResult {
  ok: boolean;
  /** NO_TAILSCALE, NOT_RUNNING, NO_HTTPS, PORTS_TAKEN, FAILED, NOT_OURS, NEEDS_APPROVAL */
  code?: string;
  url?: string;
  port?: number;
  /** Tailscale's own words, when it said something useful. */
  output?: string;
  /** A login.tailscale.com link Tailscale asked to open (to allow HTTPS / Serve once). */
  link?: string;
  command: string;
}

export const serveCommand = (port: number, httpsPort = 443) => `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${port}`;

/**
 * Turns on `tailscale serve` for Sara (HTTPS on the tailnet only, never Funnel), on a free HTTPS
 * port: an existing serve on 443 that isn't Sara's stays as it is. Records what it did for Undo.
 */
export async function serveOn(o: { dataDir?: string; port?: number } = {}): Promise<ServeResult> {
  const port = o.port || Number(env().SARA_PORT ?? 7860);
  const target = `http://127.0.0.1:${port}`;
  const ts = await readTailscale();
  const base = { command: serveCommand(port) };
  if (!ts.cli) return { ok: false, code: 'NO_TAILSCALE', ...base };
  if (!ts.running || !ts.dnsName) return { ok: false, code: 'NOT_RUNNING', ...base };
  if (ts.httpsOk === false) return { ok: false, code: 'NO_HTTPS', link: 'https://login.tailscale.com/admin/dns', ...base };
  const pick = pickServePort(ts.serveJson, ts.dnsName, target);
  const url = (p: number) => `https://${ts.dnsName}${p === 443 ? '' : `:${p}`}`;
  if (pick.ours) {
    cache = undefined;
    return { ok: true, url: url(pick.port), port: pick.port, command: serveCommand(port, pick.port) };
  }
  if (!pick.port) return { ok: false, code: 'PORTS_TAKEN', ...base };
  const r = await run(ts.cli, ['serve', '--bg', `--https=${pick.port}`, target], 30_000).catch((err: Error) => ({ status: null, stdout: '', stderr: '', error: err }) as RunResult);
  const output = `${r.stdout}${r.stderr}`.trim().slice(0, 1200);
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0];
  cache = undefined;
  if (r.status !== 0) return { ok: false, code: link ? 'NEEDS_APPROVAL' : 'FAILED', output: output || r.error?.message, ...(link ? { link } : {}), command: serveCommand(port, pick.port) };
  writeReachState(o.dataDir, { servePort: pick.port, target, at: new Date().toISOString() });
  return { ok: true, url: url(pick.port), port: pick.port, command: serveCommand(port, pick.port) };
}

/** Undo: turns off only the serve Sara turned on, and only while it still points at her. */
export async function serveOff(o: { dataDir?: string; port?: number } = {}): Promise<ServeResult> {
  const port = o.port || Number(env().SARA_PORT ?? 7860);
  const target = `http://127.0.0.1:${port}`;
  const st = readReachState(o.dataDir);
  const p = Number(st.servePort ?? 0);
  const command = `tailscale serve --https=${p || 443} off`;
  const ts = await readTailscale();
  if (!ts.cli) return { ok: false, code: 'NO_TAILSCALE', command };
  if (!p || !serveIsOurs(ts.serveJson, p, st.target ?? target)) return { ok: false, code: 'NOT_OURS', command };
  const r = await run(ts.cli, ['serve', `--https=${p}`, 'off'], 20_000).catch((err: Error) => ({ status: null, stdout: '', stderr: '', error: err }) as RunResult);
  cache = undefined;
  if (r.status !== 0) return { ok: false, code: 'FAILED', output: `${r.stdout}${r.stderr}`.trim().slice(0, 1200), command };
  if (o.dataDir && existsSync(statePath(o.dataDir))) writeReachState(o.dataDir, {});
  return { ok: true, port: p, command };
}
