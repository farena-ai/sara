// Phase 113: Sara's hub client (docs/SUPPORT.md, docs/PRIVACY.md). Two things, both through the
// network guard (src/net-guard.ts) and never from the browser:
//
//  1. An anonymous daily check-in: a random install id (128 bits, made here, Reset makes a new one)
//     and a few on/off facts: the version, how she was installed, the kind of computer, the app
//     language, how many companions and household members, which bridges and features are on, and
//     whether her models are local or cloud. `buildPing` is the ONLY place the body is made, with a
//     fixed shape (test/phase113.test.ts checks its keys against the contract list exactly).
//     Never sent from the demo, in private local mode, when the guard blocks the hub, when the
//     owner turned it off, from a household member's space (the server checks in once), in tests
//     (unless SARA_HUB_URL points at a local fake), or before the owner has seen the first-run notice.
//  2. Report a problem / Suggest something: a ticket with optional diagnostics that are built here,
//     shown to the person in full (a tick per part) and scrubbed (the redactor, emails, home-folder
//     paths) before anything leaves. The hub answers with a ticket id and a reply token, kept in the
//     person's own space for *My reports*.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isLoopbackHost, netFetch, outboundAllowed, privateLocalOn } from './net-guard.ts';

/** The hub's address (SARA_HUB_URL overrides it: tests and self-hosted hubs). */
export const HUB_DEFAULT = 'https://backstagecoding.com/sara/hub';

/** Wire contract v1: the ping's keys, exactly (nothing else is ever added). */
export const PING_KEYS = ['v', 'id', 'version', 'channel', 'os', 'arch', 'lang', 'companions', 'members', 'bridges', 'features', 'model'] as const;
export const CHANNELS = ['installer', 'docker', 'source', 'desktop-app', 'homebrew', 'winget'] as const;
export type Channel = (typeof CHANNELS)[number];
export type HubOs = 'windows' | 'macos' | 'linux' | 'other';
export type HubArch = 'x64' | 'arm64' | 'other';
export type ModelKind = 'local' | 'cloud' | 'both' | 'none';
/** The bridge and feature ids a ping may carry (anything else is dropped). */
export const BRIDGE_IDS = ['telegram', 'discord', 'alexa', 'home_assistant', 'plugin_bridge'] as const;
export const FEATURE_IDS = ['computer_use', 'plugins', 'a2a', 'keep_up', 'webhooks', 'mcp', 'web_search', 'gmail', 'github', 'ssh', 'agenda', 'voice_local', 'offsite_backup', 'household', 'skills', 'library', 'other_apps', 'two_step'] as const;
const LANGS = ['en', 'es', 'fr', 'de', 'pt-BR', 'it'];

export interface PingPayload {
  v: 1;
  id: string;
  version: string;
  channel: Channel;
  os: HubOs;
  arch: HubArch;
  lang: string;
  companions: number;
  members: number;
  bridges: string[];
  features: string[];
  model: ModelKind;
}

/** What main.ts knows about this server (counts and on/off ids only). */
export interface HubFacts {
  version: string;
  channel: Channel;
  os: HubOs;
  arch: HubArch;
  lang: string;
  companions: number;
  members: number;
  bridges: readonly string[];
  features: readonly string[];
  model: ModelKind;
}

const count = (n: unknown): number => Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => ((allowed as readonly string[]).includes(String(v)) ? (v as T) : dflt);
const ids = (list: readonly unknown[] | undefined, allowed: readonly string[]): string[] => [...new Set((list ?? []).map(String).filter((x) => allowed.includes(x)))].sort().slice(0, 32);

/**
 * The check-in body: the one function that makes it. Every value is checked against a fixed list
 * or clamped, so no name, path, address or model name can get in by accident.
 */
export function buildPing(id: string, f: HubFacts): PingPayload {
  return {
    v: 1,
    id: /^[0-9a-f]{32}$/.test(id) ? id : '0'.repeat(32),
    version: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(f.version) ? f.version : '0.0.0',
    channel: pick(f.channel, CHANNELS, 'source'),
    os: pick(f.os, ['windows', 'macos', 'linux', 'other'] as const, 'other'),
    arch: pick(f.arch, ['x64', 'arm64', 'other'] as const, 'other'),
    lang: pick(f.lang, LANGS, 'en'),
    companions: count(f.companions),
    members: count(f.members),
    bridges: ids(f.bridges, BRIDGE_IDS),
    features: ids(f.features, FEATURE_IDS),
    model: pick(f.model, ['local', 'cloud', 'both', 'none'] as const, 'none'),
  };
}

export const hubOs = (p: NodeJS.Platform = process.platform): HubOs => (p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p === 'linux' ? 'linux' : 'other');
export const hubArch = (a: string = process.arch): HubArch => (a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : 'other');

/**
 * How this copy was installed, from markers that already exist: SARA_HUB_CHANNEL (packagers), a
 * Homebrew Cellar or WinGet path, the Mac app bundle, Docker (/.dockerenv or the /data volume), the
 * installers (SARA_INSTALLED=1, /usr/local/bin/sara), else a source checkout.
 */
export function detectChannel(o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; root?: string; exists?: (p: string) => boolean } = {}): Channel {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const root = String(o.root ?? '').replace(/\\/g, '/');
  const forced = String(env.SARA_HUB_CHANNEL ?? '').trim();
  if ((CHANNELS as readonly string[]).includes(forced)) return forced as Channel;
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(root)) return 'homebrew';
  if (/\/WinGet\//i.test(root)) return 'winget';
  if (/\.app\/Contents\//.test(root)) return 'desktop-app';
  const linuxInstall = platform === 'linux' && exists('/usr/local/bin/sara');
  if (!linuxInstall && (exists('/.dockerenv') || env.SARA_DATA === '/data')) return 'docker';
  if (linuxInstall || env.SARA_INSTALLED === '1') return platform === 'darwin' ? 'desktop-app' : 'installer';
  return 'source';
}

/** local, cloud, both or none, from the providers' addresses (never their names). */
export function modelKind(providers: readonly { baseUrl?: string; local?: boolean; kind?: string }[]): ModelKind {
  let local = false;
  let cloud = false;
  for (const p of providers) {
    let isLocal = p.local === true;
    try {
      const h = new URL(String(p.baseUrl ?? '')).hostname.replace(/^\[|\]$/g, '');
      if (/^(localhost|127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || h.endsWith('.local')) isLocal = true;
    } catch {
      /* a subscription sign-in without an address: cloud */
    }
    if (isLocal) local = true;
    else cloud = true;
  }
  return local && cloud ? 'both' : local ? 'local' : cloud ? 'cloud' : 'none';
}

/** The hub's base address: SARA_HUB_URL (http or https, no credentials) or the default. */
export function hubBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.SARA_HUB_URL ?? '').trim();
  if (!raw) return HUB_DEFAULT;
  try {
    const u = new URL(raw);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) return u.href.replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  return HUB_DEFAULT;
}

// ---------------------------------------------------------------------------------------------
// The owner's hub state (<data>/hub.json): install id, the switch, the schedule, notices
// ---------------------------------------------------------------------------------------------

export interface HubNotice {
  id: string;
  text: string;
  level: 'info' | 'update' | 'known-issue';
  url?: string;
}

export interface HubStateData {
  id: string;
  on: boolean;
  createdAt: string;
  /** The first-run notice: when it was shown to the owner and when it was dismissed. */
  noticeShownAt: string | null;
  noticeDismissedAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  nextAt: string | null;
  failures: number;
  /** An announcement from the hub, until it has been shown once. */
  banner: HubNotice | null;
  seenNotices: string[];
  /** The proof-of-work difficulty the hub last asked for (428). */
  powBits: number;
}

export const newInstallId = (): string => randomBytes(16).toString('hex');
export const NOTICE_MAX = 280;

/** Announcement text as plain text: control characters and tags' angle brackets gone, capped. */
export function cleanNotice(raw: unknown): HubNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const id = String(n.id ?? '').replace(/[^\w.-]/g, '').slice(0, 64);
  // eslint-disable-next-line no-control-regex
  const text = String(n.text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTICE_MAX);
  if (!id || !text) return null;
  const level = pick(n.level, ['info', 'update', 'known-issue'] as const, 'info');
  let url: string | undefined;
  try {
    const u = new URL(String(n.url ?? ''));
    if (u.protocol === 'https:' && !u.username && !u.password) url = u.href.slice(0, 300);
  } catch {
    url = undefined;
  }
  return { id, text, level, ...(url ? { url } : {}) };
}

export class HubState {
  readonly file: string;
  #d: HubStateData;
  readonly #now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.file = join(dir, 'hub.json');
    this.#now = now;
    let d: Partial<HubStateData> = {};
    try {
      d = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HubStateData>;
    } catch {
      d = {};
    }
    this.#d = {
      id: /^[0-9a-f]{32}$/.test(String(d.id)) ? String(d.id) : newInstallId(),
      on: d.on !== false,
      createdAt: d.createdAt ?? now().toISOString(),
      noticeShownAt: d.noticeShownAt ?? null,
      noticeDismissedAt: d.noticeDismissedAt ?? null,
      lastSentAt: d.lastSentAt ?? null,
      lastError: d.lastError ?? null,
      nextAt: d.nextAt ?? null,
      failures: Math.max(0, Number(d.failures) || 0),
      banner: cleanNotice(d.banner),
      seenNotices: Array.isArray(d.seenNotices) ? d.seenNotices.map(String).slice(-100) : [],
      powBits: Math.min(28, Math.max(8, Number(d.powBits) || 18)),
    };
    if (d.id !== this.#d.id) this.#save();
  }
  get(): Readonly<HubStateData> {
    return this.#d;
  }
  update(p: Partial<HubStateData>): HubStateData {
    this.#d = { ...this.#d, ...p };
    this.#save();
    return this.#d;
  }
  /** A new install id (the old one is forgotten here; the hub drops ids it no longer sees). */
  resetId(): string {
    this.update({ id: newInstallId(), lastSentAt: null });
    return this.#d.id;
  }
  /** A notice from a ping answer: kept until shown once (unless it was seen before). */
  takeNotice(raw: unknown): void {
    const n = cleanNotice(raw);
    if (n && !this.#d.seenNotices.includes(n.id)) this.update({ banner: n });
  }
  /** The banner was shown (or dismissed): never again. */
  noticeSeen(id: string): void {
    const seen = [...new Set([...this.#d.seenNotices, id])].slice(-100);
    this.update({ seenNotices: seen, banner: this.#d.banner?.id === id ? null : this.#d.banner });
  }
  #save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#d, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  /** The time now (the state's own clock: tests pass a fake one). */
  now(): Date {
    return this.#now();
  }
}

const testing = (env: NodeJS.ProcessEnv): boolean => Boolean(env.NODE_TEST_CONTEXT) || env.SARA_TESTING === '1';
/** A hub on this computer (the tests' fake). */
export function localHub(base: string): boolean {
  try {
    return isLoopbackHost(new URL(base).hostname);
  } catch {
    return false;
  }
}

/** Why a check-in may not be sent right now (undefined: it may). */
export type BlockReason = 'demo' | 'member' | 'private' | 'offline' | 'off' | 'tests' | 'notice';
export function pingBlocked(o: { demo?: boolean; member?: boolean; on: boolean; noticeShown: boolean; base: string; env?: NodeJS.ProcessEnv }): BlockReason | undefined {
  const env = o.env ?? process.env;
  if (o.demo || env.SARA_DEMO === '1') return 'demo';
  if (o.member) return 'member';
  if (privateLocalOn()) return 'private';
  if (!outboundAllowed(`${o.base}/v1/ping`)) return 'offline';
  if (!o.on) return 'off';
  // Tests never reach a real hub: only a local fake (SARA_HUB_URL on this computer).
  if (testing(env) && !localHub(o.base)) return 'tests';
  if (!o.noticeShown) return 'notice';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Talking to the hub (JSON, X-Sara-Hub: 1, no cookies, through the guard)
// ---------------------------------------------------------------------------------------------

export interface HubAnswer {
  status: number;
  json: Record<string, unknown>;
}
/** Tests: a stand-in for the network (default: netFetch). */
export type HubSend = (url: string, init: RequestInit) => Promise<Response>;

export async function hubRequest(base: string, path: string, o: { method?: string; body?: unknown; timeoutMs?: number; send?: HubSend } = {}): Promise<HubAnswer> {
  const init: RequestInit = {
    method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
    headers: { 'x-sara-hub': '1', accept: 'application/json', ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
  };
  const res = await (o.send ?? netFetch)(`${base}${path}`, init);
  const text = (await res.text()).slice(0, 256 * 1024);
  let json: Record<string, unknown> = {};
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

const DAY = 24 * 3600_000;
const MIN = 60_000;

export interface PingerOptions {
  state: HubState;
  facts: () => HubFacts;
  /** Why not now (see pingBlocked); checked at every tick. */
  blocked: () => BlockReason | undefined;
  base: string;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  send?: HubSend;
  log?: (line: string) => void;
  /** Only for a hub on this computer (a local check): the first wait instead of 10–60 minutes (at least a minute). */
  firstDelayMs?: number;
}

/**
 * The daily check-in's clock: the first one 10–60 minutes after start (or at the saved time when
 * that is later), then about every 24 hours ± 2; the hub's `next` (seconds) is honoured; errors
 * back off (30 min, 1 h, 2 h… up to a day). The schedule and last-sent time are saved in hub.json.
 */
export class HubPinger {
  readonly #o: PingerOptions;
  #timer: unknown;
  readonly #now: () => number;
  readonly #random: () => number;
  /** When the next tick is due (ms since epoch). */
  dueAt = 0;
  constructor(o: PingerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#random = o.random ?? Math.random;
  }
  /** About a day: 22 to 26 hours. */
  day(): number {
    return DAY + (this.#random() * 4 - 2) * 3600_000;
  }
  start(): void {
    const first = this.#o.firstDelayMs !== undefined && localHub(this.#o.base) ? this.#o.firstDelayMs : (10 + this.#random() * 50) * MIN;
    const saved = Date.parse(this.#o.state.get().nextAt ?? '') - this.#now();
    this.#schedule(Number.isFinite(saved) ? Math.max(first, saved) : first);
  }
  stop(): void {
    if (this.#timer !== undefined) (this.#o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.#timer);
    this.#timer = undefined;
  }
  #schedule(ms: number): void {
    this.stop();
    const wait = Math.max(MIN, Math.min(7 * DAY, ms));
    this.dueAt = this.#now() + wait;
    this.#o.state.update({ nextAt: new Date(this.dueAt).toISOString() });
    const set = this.#o.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t).unref());
    this.#timer = set(() => void this.tick().catch(() => undefined), wait);
  }
  /** One check-in now (if allowed); then the next one is scheduled. Returns what happened. */
  async tick(): Promise<{ sent: boolean; blocked?: BlockReason; status?: number; error?: string }> {
    const why = this.#o.blocked();
    if (why) {
      // Not now: look again in about a day (an hour while the first-run notice waits to be seen).
      this.#schedule(why === 'notice' ? 3600_000 : this.day());
      return { sent: false, blocked: why };
    }
    const st = this.#o.state;
    const body = buildPing(st.get().id, this.#o.facts());
    try {
      const r = await hubRequest(this.#o.base, '/v1/ping', { body, send: this.#o.send, timeoutMs: 15_000 });
      const next = Number(r.json.next);
      const told = Number.isFinite(next) && next > 0 ? Math.min(7 * 86400, Math.max(3600, next)) * 1000 : undefined;
      if (r.status >= 200 && r.status < 300 && r.json.ok !== false) {
        st.update({ lastSentAt: new Date(this.#now()).toISOString(), lastError: null, failures: 0 });
        st.takeNotice(r.json.notice);
        this.#schedule(told ?? this.day());
        return { sent: true, status: r.status };
      }
      return this.#failed(`HTTP ${r.status}`, told, r.status);
    } catch (err) {
      return this.#failed(String((err as Error)?.message ?? err).slice(0, 120));
    }
  }
  #failed(error: string, told?: number, status?: number): { sent: false; error: string; status?: number } {
    const failures = this.#o.state.get().failures + 1;
    this.#o.state.update({ failures, lastError: error });
    const back = Math.min(DAY, 30 * MIN * 2 ** (failures - 1)) * (0.8 + this.#random() * 0.4);
    this.#schedule(told ?? back);
    this.#o.log?.(`Hub check-in failed (${error}); trying again later.`);
    return { sent: false, error, ...(status ? { status } : {}) };
  }
}

// ---------------------------------------------------------------------------------------------
// Proof of work (tickets): sha256(`${id}:${title}:${nonce}`) has ≥ bits leading zero bits
// ---------------------------------------------------------------------------------------------

export function leadingZeroBits(buf: Uint8Array): number {
  let n = 0;
  for (const b of buf) {
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}
export const powOk = (id: string, title: string, nonce: string, bits: number): boolean => leadingZeroBits(createHash('sha256').update(`${id}:${title}:${nonce}`).digest()) >= bits;

/**
 * Finds a nonce in chunks, yielding to the event loop between them, so the server (and the page
 * waiting on it) never freezes. 18 bits is about 260,000 hashes: well under a second.
 */
export async function solvePow(id: string, title: string, bits: number, o: { chunk?: number; signal?: AbortSignal } = {}): Promise<string> {
  const chunk = o.chunk ?? 4096;
  const start = randomBytes(4).readUInt32BE(0);
  for (let i = 0; i < 2 ** 32; i += chunk) {
    for (let j = 0; j < chunk; j++) {
      const nonce = ((start + i + j) % 2 ** 32).toString(16);
      if (powOk(id, title, nonce, bits)) return nonce;
    }
    if (o.signal?.aborted) throw new Error('stopped');
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('no nonce');
}

// ---------------------------------------------------------------------------------------------
// Diagnostics: built here, shown in full, scrubbed before they leave
// ---------------------------------------------------------------------------------------------

export const DIAG_PARTS = ['system', 'log', 'error', 'settingsShape', 'steps'] as const;
export type DiagPart = (typeof DIAG_PARTS)[number];
export const LOG_MAX = 64 * 1024;

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Scrubs one text: the redactor (vault secrets, key-shaped strings), other key shapes (Stripe-style
 * keys), long random-looking tokens, email addresses, home-folder and data-folder paths, and
 * internet addresses. Over-scrubbing is fine here; leaking is not.
 */
export function scrubText(text: string, redact: (s: string) => string, o: { homes?: string[]; dirs?: string[] } = {}): string {
  let s = redact(String(text ?? ''));
  s = s.replace(/\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{6,}/g, '[REDACTED]');
  s = s.replace(/\bsara_[a-z]+\.[\w.-]{12,}/g, '[REDACTED]');
  s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  for (const d of [...(o.dirs ?? [])].filter((x) => x && x.length > 3).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([d, d.replace(/\\/g, '/'), d.replace(/\//g, '\\')])) s = s.replace(new RegExp(escRe(form), 'gi'), '<data>');
  }
  for (const h of [...(o.homes ?? [homedir()])].filter((x) => x && x.length > 3).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([h, h.replace(/\\/g, '/'), h.replace(/\//g, '\\')])) s = s.replace(new RegExp(escRe(form), 'gi'), '~');
  }
  // Anyone's home folder, in every system's spelling.
  s = s.replace(/(?:[A-Za-z]:)?[\\/](?:Users|home|Documents and Settings)[\\/][^\\/\s"'<>:]+/gi, '~');
  s = s.replace(/\/root(?=[\\/\s]|$)/g, '~');
  // Folders under the home folder can name private things: keep only the file name (~/…/notes.txt).
  s = s.replace(/~((?:[\\/][^\\/\s"'<>:]+)+)/g, (_m, rest: string) => {
    const segs = rest.split(/[\\/]/).filter(Boolean);
    return segs.length > 1 ? `~/…/${segs.at(-1)}` : `~/${segs[0] ?? ''}`;
  });
  s = s.replace(/\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  return s;
}

/** Settings as a shape: which keys are set and which switches are on; never a value. */
export function settingsShape(settings: Record<string, unknown>): Record<string, boolean | number> {
  const out: Record<string, boolean | number> = {};
  for (const [k, v] of Object.entries(settings ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z]\w{0,40}$/.test(k) || v === undefined || v === null) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.length;
    else if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out[k] = typeof o.enabled === 'boolean' ? o.enabled : typeof o.on === 'boolean' ? o.on : Object.keys(o).length > 0;
    } else out[k] = true;
  }
  return out;
}

export interface DiagStep {
  tool: string;
  status: string;
}

export interface Diagnostics {
  system?: string;
  log?: string;
  error?: string;
  settingsShape?: Record<string, boolean | number>;
  steps?: DiagStep[];
}

/** Cleans what the person ticked (as it was shown to them) once more before it leaves, and caps it. */
export function cleanDiagnostics(raw: unknown, scrub: (s: string) => string): Diagnostics | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const out: Diagnostics = {};
  if (typeof d.system === 'string' && d.system.trim()) out.system = scrub(d.system).slice(0, 2000);
  if (typeof d.log === 'string' && d.log.trim()) out.log = scrub(d.log).slice(-LOG_MAX);
  if (typeof d.error === 'string' && d.error.trim()) out.error = scrub(d.error).slice(0, 16_000);
  if (d.settingsShape && typeof d.settingsShape === 'object' && !Array.isArray(d.settingsShape)) {
    const s: Record<string, boolean | number> = {};
    for (const [k, v] of Object.entries(d.settingsShape as Record<string, unknown>).slice(0, 200)) {
      if (/^[A-Za-z]\w{0,40}$/.test(k) && (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) s[k] = typeof v === 'number' ? Math.min(9999, Math.max(0, Math.floor(v))) : v;
    }
    out.settingsShape = s;
  }
  if (Array.isArray(d.steps)) {
    out.steps = d.steps
      .slice(0, 100)
      .map((x) => ({ tool: String((x as DiagStep)?.tool ?? '').replace(/[^\w.:-]/g, '').slice(0, 64), status: String((x as DiagStep)?.status ?? '').replace(/[^\w-]/g, '').slice(0, 16) }))
      .filter((x) => x.tool);
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------------------------
// My reports: the tickets a person sent, in their own space's database
// ---------------------------------------------------------------------------------------------

export const TICKET_KINDS = ['bug', 'idea', 'question'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export const TICKET_STATUS = ['new', 'triaged', 'in-progress', 'waiting', 'fixed', 'closed'] as const;

export interface TicketReply {
  at: string;
  from: 'team' | 'you';
  text: string;
}
export interface TicketRow {
  ticket: string;
  kind: TicketKind;
  title: string;
  createdAt: string;
  status: string;
  fixedIn: string | null;
  replies: TicketReply[];
  checkedAt: string | null;
}

const TICKET_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_tickets (
  ticket TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  fixed_in TEXT,
  replies TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT
);`;

// eslint-disable-next-line no-control-regex
const plain = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);

export class TicketStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(TICKET_SCHEMA);
  }
  add(t: { ticket: string; token: string; kind: TicketKind; title: string; createdAt: string }): void {
    this.#db.prepare('INSERT OR REPLACE INTO hub_tickets (ticket, token, kind, title, created_at) VALUES (?, ?, ?, ?, ?)').run(t.ticket, t.token, t.kind, t.title, t.createdAt);
  }
  #row(r: Record<string, unknown>): TicketRow {
    let replies: TicketReply[] = [];
    try {
      replies = JSON.parse(String(r.replies ?? '[]')) as TicketReply[];
    } catch {
      replies = [];
    }
    return { ticket: String(r.ticket), kind: r.kind as TicketKind, title: String(r.title), createdAt: String(r.created_at), status: String(r.status), fixedIn: (r.fixed_in as string | null) ?? null, replies, checkedAt: (r.checked_at as string | null) ?? null };
  }
  list(): TicketRow[] {
    return (this.#db.prepare('SELECT * FROM hub_tickets ORDER BY created_at DESC LIMIT 200').all() as Record<string, unknown>[]).map((r) => this.#row(r));
  }
  get(ticket: string): (TicketRow & { token: string }) | undefined {
    const r = this.#db.prepare('SELECT * FROM hub_tickets WHERE ticket = ?').get(ticket) as Record<string, unknown> | undefined;
    return r ? { ...this.#row(r), token: String(r.token) } : undefined;
  }
  /** What the hub said about a ticket (plain text, capped). */
  refresh(ticket: string, j: Record<string, unknown>, at: string): void {
    const status = pick(j.status, TICKET_STATUS, 'new');
    const fixedIn = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(j.fixedIn ?? '')) ? String(j.fixedIn) : null;
    const replies = (Array.isArray(j.replies) ? j.replies : []).slice(-100).map((x) => ({ at: plain((x as TicketReply).at, 40), from: (x as TicketReply).from === 'you' ? 'you' : 'team', text: plain((x as TicketReply).text, 4000) }));
    this.#db.prepare('UPDATE hub_tickets SET status = ?, fixed_in = ?, replies = ?, checked_at = ? WHERE ticket = ?').run(status, fixedIn, JSON.stringify(replies), at, ticket);
  }
}

export const isTicketId = (s: string): boolean => /^[A-Z]{2,8}-\d{1,9}$/.test(s);

/** A ticket from the form: checked and capped (the contract's limits). */
export function cleanTicket(body: Record<string, unknown>): { kind: TicketKind; title: string; body: string; contact?: string } {
  const kind = pick(body.kind, TICKET_KINDS, 'bug');
  // eslint-disable-next-line no-control-regex
  const title = String(body.title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
  const contact = String(body.contact ?? '').trim();
  if (!title) throw new Error('title');
  if (contact && (contact.length > 200 || !/^[^\s@<>()"]{1,64}@[\w-]+(\.[\w-]+)+$/.test(contact))) throw new Error('email');
  return { kind, title, body: text, ...(contact ? { contact } : {}) };
}

/**
 * Sends a ticket: proof of work at the difficulty the hub last asked for (18 at first); a 428
 * `{ error: 'pow', bits }` answer means solve again at that difficulty and retry once.
 */
export async function sendTicket(o: { base: string; state: HubState; payload: Record<string, unknown>; send?: HubSend }): Promise<HubAnswer & { bits: number }> {
  const id = o.state.get().id;
  const title = String(o.payload.title ?? '');
  let bits = o.state.get().powBits;
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = await solvePow(id, title, bits);
    const r = await hubRequest(o.base, '/v1/tickets', { body: { v: 1, id, ...o.payload, pow: { nonce, bits } }, send: o.send, timeoutMs: 30_000 });
    const asked = Number(r.json.bits);
    if (r.status === 428 && r.json.error === 'pow' && Number.isFinite(asked) && attempt === 0) {
      bits = Math.min(26, Math.max(8, Math.floor(asked)));
      o.state.update({ powBits: bits });
      continue;
    }
    return { ...r, bits };
  }
  return { status: 428, json: { ok: false, error: 'pow' }, bits };
}

// ---------------------------------------------------------------------------------------------
// One person's hub (src/routes/hub.ts): the owner's state and clock, their own tickets
// ---------------------------------------------------------------------------------------------

export interface HubSpace {
  /** The server's hub state (one install id; only the owner changes it). */
  state: HubState;
  base: string;
  /** A household member's space: tickets of their own, never the check-in settings. */
  member: boolean;
  demo: boolean;
  tickets: TicketStore;
  facts: () => HubFacts;
  blocked: () => BlockReason | undefined;
  pinger?: HubPinger;
  /** The scrubber every diagnostics part passes (redactor + scrubText). */
  scrub: (s: string) => string;
  /** The owner's last log lines (members: none, the log is the server's). */
  logLines?: (n: number) => string;
  send?: HubSend;
}

/** Diagnostics built here for the sheet: every part already scrubbed, shown in full before sending. */
export function buildDiagnostics(h: HubSpace, o: { error?: string; settings: Record<string, unknown>; steps?: DiagStep[] }): Diagnostics {
  const f = h.facts();
  const d: Diagnostics = {
    system: `Sara ${f.version} · ${f.os} ${f.arch} · ${f.channel} · Node ${process.versions.node} · ${f.lang}`,
    settingsShape: settingsShape(o.settings),
  };
  const log = h.member ? '' : (h.logLines?.(200) ?? '');
  if (log.trim()) d.log = h.scrub(log).slice(-LOG_MAX);
  if (o.error?.trim()) d.error = h.scrub(o.error).slice(0, 16_000);
  if (o.steps?.length) d.steps = o.steps.slice(0, 100);
  return d;
}

/** Fred fix C: the hub's reason in one short plain line (its `message`, else its `error` code). */
export function hubReason(json: Record<string, unknown>, status: number): string {
  const m = typeof json.message === 'string' && json.message.trim() ? json.message : typeof json.error === 'string' && json.error.trim() ? json.error : `HTTP ${status}`;
  // eslint-disable-next-line no-control-regex
  return m.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Where a ticket may not go now: the demo, private local mode, or the guard blocking the hub. */
export function ticketBlocked(h: HubSpace): 'demo' | 'private' | 'offline' | undefined {
  if (h.demo || process.env.SARA_DEMO === '1') return 'demo';
  if (privateLocalOn()) return 'private';
  if (!outboundAllowed(`${h.base}/v1/tickets`)) return 'offline';
  if (testing(process.env) && !localHub(h.base)) return 'offline';
  return undefined;
}

export type FileResult = { ok: true; ticket: string } | { ok: false; code: 'demo' | 'private' | 'title' | 'email' | 'limit' | 'down' | 'refused'; reason?: string };

/**
 * Fred fix C: exactly what the hub's ticket schema accepts (sara-hub src/validate.ts TICKET_SCHEMA:
 * kind, title, body ≥ 1 character, contact, lang, version, os, and diagnostics with only log, error,
 * settingsShape, steps). The system line the person saw rides at the top of the log; an empty body
 * becomes the title. Anything else (a field a newer app adds) never goes, so the hub can't refuse it.
 */
export function ticketWire(p: { kind: string; title: string; body: string; contact?: string; lang?: string; version?: string; os?: string; diagnostics?: Diagnostics }): { kind: string; title: string; body: string; contact?: string; lang?: string; version?: string; os?: string; diagnostics?: Omit<Diagnostics, 'system'> } {
  const body = String(p.body ?? '').trim() || String(p.title ?? '').trim();
  const out: ReturnType<typeof ticketWire> = { kind: p.kind, title: p.title, body: body.slice(0, 8000) };
  if (p.contact) out.contact = p.contact;
  if (typeof p.lang === 'string' && p.lang) out.lang = p.lang;
  if (typeof p.version === 'string' && p.version) out.version = p.version;
  if (typeof p.os === 'string' && p.os) out.os = p.os;
  const d = p.diagnostics;
  if (d) {
    const w: Omit<Diagnostics, 'system'> = {};
    const system = typeof d.system === 'string' ? d.system.trim().slice(0, 2000) : '';
    const log = typeof d.log === 'string' ? d.log : '';
    if (system || log.trim()) w.log = system ? `${system}\n${log.slice(-(LOG_MAX - system.length - 1))}`.trimEnd() : log.slice(-LOG_MAX);
    if (typeof d.error === 'string' && d.error.trim()) w.error = d.error.slice(0, 16_000);
    if (d.settingsShape && typeof d.settingsShape === 'object') w.settingsShape = d.settingsShape;
    if (Array.isArray(d.steps) && d.steps.length) w.steps = d.steps.slice(0, 100).map((x) => ({ tool: String(x.tool).slice(0, 64), status: String(x.status).slice(0, 32) }));
    if (Object.keys(w).length) out.diagnostics = w;
  }
  return out;
}

/**
 * Sends one report from this space and keeps its ticket id and reply token here (the routes, the
 * /bug and /idea commands). Diagnostics are what the person ticked, scrubbed once more.
 */
export async function fileTicket(h: HubSpace, body: Record<string, unknown>, at = new Date()): Promise<FileResult> {
  const why = ticketBlocked(h);
  if (why === 'demo') return { ok: false, code: 'demo' };
  if (why) return { ok: false, code: 'private' };
  let t;
  try {
    t = cleanTicket(body);
  } catch (err) {
    return { ok: false, code: (err as Error).message === 'email' ? 'email' : 'title' };
  }
  const f = h.facts();
  const diagnostics = cleanDiagnostics(body.diagnostics, h.scrub);
  const payload = ticketWire({ kind: t.kind, title: t.title, body: h.scrub(t.body), ...(t.contact ? { contact: t.contact } : {}), lang: f.lang, version: f.version, os: f.os, ...(diagnostics ? { diagnostics } : {}) });
  let r;
  try {
    r = await sendTicket({ base: h.base, state: h.state, payload, send: h.send });
  } catch (err) {
    console.warn(`hub: the ticket didn't reach the support desk (${h.base}): ${(err as Error).name}: ${(err as Error).message}`);
    return { ok: false, code: 'down' };
  }
  if (r.status === 429) return { ok: false, code: 'limit' };
  const ticket = String(r.json.ticket ?? '');
  const token = String(r.json.token ?? '');
  // Fred fix C: the hub's own words when it refuses (a 4xx), logged and shown; never "didn't answer".
  if (r.status >= 400 && r.status < 500) {
    const reason = hubReason(r.json, r.status);
    console.warn(`hub: the support desk refused the ticket (${r.status}): ${reason}`);
    return { ok: false, code: 'refused', reason };
  }
  if (r.status >= 300 || !isTicketId(ticket) || !/^[0-9a-f]{32}$/.test(token)) {
    console.warn(`hub: the support desk gave no ticket (${r.status}): ${hubReason(r.json, r.status)}`);
    return { ok: false, code: 'down' };
  }
  h.tickets.add({ ticket, token, kind: t.kind, title: t.title, createdAt: at.toISOString() });
  return { ok: true, ticket };
}
