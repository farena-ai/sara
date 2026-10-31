// Phase 67: the one way out of the server. Every outgoing request Sara makes goes through
// `netFetch` (HTTP), `openWebSocket` (WebSockets) or, for the few modules that need raw
// node:http(s)/http2/net connections, a `checkOutbound(url)` right before connecting
// (test/private-local.test.ts scans src/ for anything else).
//
// While "Nothing leaves this computer" (private local mode) is on, only loopback addresses are
// allowed: 127.0.0.0/8, ::1 (and ::ffff:127.x.y.z) and the name `localhost`. The decision is made
// from the URL's host *before* any DNS lookup, so a name that happens to resolve to a local
// address (or a DNS answer that changes) can't slip through: only literal loopback hosts pass.
// Everything else fails with a PrivateLocalError naming what was blocked.
//
// A loopback Ollama can still reach the internet on Sara's behalf (downloading a model, an
// Ollama Cloud model, its web search), so those requests are blocked too (`ollamaEgress`).

/** The error every blocked request fails with. `code` lets callers tell it apart. */
export class PrivateLocalError extends Error {
  readonly code = 'PRIVATE_LOCAL';
  readonly target: string;
  constructor(target: string, why?: string) {
    super(why ?? `Blocked by private local mode: ${target} is not on this computer. While "Nothing leaves this computer" is on, Sara only connects to this computer.`);
    this.name = 'PrivateLocalError';
    this.target = target;
  }
}

export const isPrivateLocalError = (err: unknown): err is PrivateLocalError => err instanceof PrivateLocalError || (Boolean(err) && (err as { code?: unknown }).code === 'PRIVATE_LOCAL');

let privateOn = false;
/** The real fetch, captured before anything can wrap the global one. Tests swap it with setNetTransport. */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
/** Sends through whatever the global fetch is now (tests may stub it), never through our own wrapper. */
const viaGlobal: typeof fetch = (input, init) => (globalThis.fetch === (guardedGlobal as unknown) ? (savedGlobal ?? realFetch) : globalThis.fetch)(input, init);
/** The global fetch that was there before the mode wrapped it (put back when the mode goes off). */
let savedGlobal: typeof fetch | undefined;
let transport: typeof fetch = viaGlobal;
/** Blocked attempts since start (shown on the settings page). */
const blocked: { at: string; target: string }[] = [];

/** Turns the guard on or off for the whole process (src/private-local.ts keeps the saved state). */
export function setPrivateLocal(on: boolean): void {
  privateOn = on;
  // Belt and braces: code that reaches for the global fetch directly (a future module, a
  // dependency of a script) goes through the same check while the mode is on.
  if (on && globalThis.fetch !== (guardedGlobal as unknown)) {
    savedGlobal = globalThis.fetch;
    globalThis.fetch = guardedGlobal as typeof fetch;
  } else if (!on && globalThis.fetch === (guardedGlobal as unknown)) {
    globalThis.fetch = savedGlobal ?? realFetch;
    savedGlobal = undefined;
  }
}

export const privateLocalOn = (): boolean => privateOn;

/** Tests: the function that really sends (a fake records what would have left). */
export function setNetTransport(f?: typeof fetch): void {
  transport = f ?? viaGlobal;
}

export function blockedRecently(): { at: string; target: string }[] {
  return blocked.slice(-20);
}

function noteBlocked(target: string): void {
  blocked.push({ at: new Date().toISOString(), target });
  if (blocked.length > 50) blocked.splice(0, blocked.length - 50);
}

/**
 * True for a literal loopback host: `localhost`, 127.0.0.0/8, ::1, ::ffff:127.x.y.z. Expects the
 * host as the URL parser gives it (`new URL(u).hostname`, which already turns `2130706433` or
 * `0x7f.1` into `127.0.0.1` and `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`).
 */
export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return Number(v4[1]) === 127 && v4.slice(2).every((x) => Number(x) <= 255);
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped loopback, in the forms the URL parser and people write.
  const mapped = /^(?:0:0:0:0:0:|::)ffff:(.+)$/.exec(h);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isLoopbackHost(rest);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) return parseInt(hex[1], 16) >> 8 === 127;
  }
  return false;
}

/**
 * Phase 100: a literal address on the home network (10/8, 172.16/12, 192.168/16, Tailscale's
 * 100.64/10, IPv6 fc00::/7). Only for A2A peers with *Allow agents on my network in private mode*
 * on; names never count (they could resolve anywhere).
 */
export function isLanHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((x) => Number(x) > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h);
}

/** Schemes that never touch the network. */
const OFFLINE = new Set(['data:', 'blob:']);

function toUrl(target: string | URL): URL | undefined {
  try {
    return target instanceof URL ? target : new URL(String(target));
  } catch {
    return undefined;
  }
}

/** May a request to this address leave right now? (Always yes while the mode is off.) `lan`: home-network addresses too (Phase 100). */
export function outboundAllowed(target: string | URL, lan = false): boolean {
  if (!privateOn) return true;
  const u = toUrl(target);
  if (!u) return false;
  if (OFFLINE.has(u.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
  return isLoopbackHost(u.hostname) || (lan && isLanHost(u.hostname));
}

/** Throws PrivateLocalError unless the address is allowed. Call it right before connecting. */
export function checkOutbound(target: string | URL, what?: string, lan = false): void {
  if (outboundAllowed(target, lan)) return;
  const u = toUrl(target);
  const host = u ? u.host || u.protocol : String(target).slice(0, 80);
  noteBlocked(what ? `${what} (${host})` : host);
  throw new PrivateLocalError(what ? `${what} (${host})` : host);
}

/**
 * For things that reach the internet without a URL Sara could check (a program that talks to its
 * vendor: Claude Code, the Grok CLI, winget, the updater): refused while the mode is on.
 */
export function assertOnline(what: string): void {
  if (!privateOn) return;
  noteBlocked(what);
  throw new PrivateLocalError(what, `Paused in private local mode: ${what} needs the internet. Turn "Nothing leaves this computer" off to use it.`);
}

/**
 * Ollama model names that run on Ollama's servers ("gpt-oss:120b-cloud", "beam:cloud"). The same
 * rule as model-names.ts (kept here so the egress gate imports nothing; test/model-names.test.ts
 * pins both to the same answers).
 */
export const CLOUD_MODEL = /(:|-)cloud$/i;

/**
 * Loopback requests that make a local model server reach the internet for us: downloading or
 * uploading a model, Ollama's web search/fetch, and any request naming an Ollama Cloud model.
 * Returns why it's blocked, or undefined.
 */
export function ollamaEgress(url: URL, body: unknown): string | undefined {
  const path = url.pathname.toLowerCase();
  if (/\/api\/(pull|push)\b/.test(path)) return 'Downloading a model needs the internet. Turn "Nothing leaves this computer" off for the download, then on again.';
  if (/web_(search|fetch)/.test(path)) return "Ollama's web search goes to ollama.com, which private local mode blocks.";
  if (typeof body === 'string' && body.length < 2_000_000 && /"model"\s*:/.test(body)) {
    const m = /"model"\s*:\s*"([^"]{1,200})"/.exec(body);
    if (m && CLOUD_MODEL.test(m[1].trim())) return `${m[1]} is an Ollama Cloud model: it runs on Ollama's servers, not this computer.`;
  }
  return undefined;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** fetch() with the private-local-mode check. Use it everywhere instead of the global fetch. */
export async function netFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (privateOn) {
    const href = requestUrl(input);
    checkOutbound(href);
    const u = toUrl(href);
    const why = u && !OFFLINE.has(u.protocol) ? ollamaEgress(u, init?.body) : undefined;
    if (why) {
      noteBlocked(`${u!.host}${u!.pathname}`);
      throw new PrivateLocalError(`${u!.host}${u!.pathname}`, `Blocked by private local mode: ${why}`);
    }
  }
  return transport(input, init);
}

/**
 * Phase 100: netFetch for an A2A peer the owner allowed on the home network: in private local mode a
 * literal LAN address passes too (`lan`); everything else is exactly netFetch.
 */
export async function netFetchPeer(input: string, init: RequestInit | undefined, lan: boolean): Promise<Response> {
  if (privateOn && lan && isLanHost(new URL(input).hostname)) {
    checkOutbound(input, 'agent', true);
    return transport(input, init);
  }
  return netFetch(input, init);
}

/**
 * Phase 102 (ST7): an address no request to an owner-typed URL may reach (SSRF rules): loopback,
 * the home network and Tailscale (isLanHost), link-local (169.254/16 incl. cloud metadata, fe80::/10),
 * "this network" 0/8, multicast and reserved (≥ 224), the unspecified and IPv4-mapped forms.
 */
export function isPrivateAddress(ip: string): boolean {
  let h = ip.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (isLoopbackHost(h) || isLanHost(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || (a === 169 && b === 254) || a >= 224 || (a === 192 && b === 0 && Number(v4[3]) === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return true;
  if (/^fe[89ab][0-9a-f]?:/.test(h) || h.startsWith('ff')) return true;
  const mapped = /^(?:0:0:0:0:0:|::)ffff:(.+)$/.exec(h);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPrivateAddress(rest);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return true;
  }
  return false;
}

/**
 * Phase 102: checks an owner-typed address for an outgoing webhook before anything is sent. It must
 * be https (http only to this computer when `allowLoopback`), carry no user:password, and every
 * address its name resolves to must be public; with `allowLoopback` (SARA_HOOKS_LOCAL_TARGETS=1,
 * for local testing only) a literal loopback address passes too. Private local mode applies as for
 * every request. Returns the parsed URL or throws with the reason.
 */
export async function checkPublicTarget(target: string, opts: { allowLoopback?: boolean; lookup?: (host: string) => Promise<string[]> } = {}): Promise<URL> {
  const u = toUrl(target);
  if (!u) throw new Error('That address is not valid.');
  if (u.username || u.password) throw new Error('The address may not contain a user name or password.');
  const loop = isLoopbackHost(u.hostname);
  if (loop && opts.allowLoopback && (u.protocol === 'http:' || u.protocol === 'https:')) {
    checkOutbound(u, 'outgoing webhook');
    return u;
  }
  if (u.protocol !== 'https:') throw new Error('Use an https:// address.');
  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (isPrivateAddress(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Sara only sends webhooks to public addresses (not this computer, the home network or Tailscale).');
  const literal = /^[\d.]+$/.test(host) || host.includes(':');
  if (!literal) {
    const lookup = opts.lookup ?? (async (h: string) => (await import('node:dns/promises')).lookup(h, { all: true, verbatim: true }).then((r) => r.map((x) => x.address)));
    let addrs: string[] = [];
    try {
      addrs = await lookup(host);
    } catch {
      throw new Error(`Couldn't find ${host}.`);
    }
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('That name points to a private address; Sara only sends webhooks to public addresses.');
  }
  checkOutbound(u, 'outgoing webhook');
  return u;
}

const guardedGlobal = (input: string | URL | Request, init?: RequestInit): Promise<Response> => netFetch(input, init);

/** A WebSocket (Node's built-in client) after the same check. */
export function openWebSocket(url: string, opts?: unknown): WebSocket {
  checkOutbound(url);
  return new WebSocket(url, opts as string[] | undefined);
}
