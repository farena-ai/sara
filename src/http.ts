// HTTP helpers shared by src/server.ts and the route modules (src/routes/*.ts): errors, JSON
// bodies, cookies, client addresses, security headers, body limits. No server state here.
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fill } from './i18n.ts';
import { WORKSPACE_NAME_RE } from './tools/workspace.ts';

/** Requests from Sara's phone apps (their web views add "SaraPhone/<n>" to the user agent). */
export const fromPhoneApp = (req: IncomingMessage): boolean => /\bSaraPhone\/\d/.test(String(req.headers['user-agent'] ?? ''));
/** Phase 33: Sara's phone OR desktop apps (adult mode is turned on from a web browser only). */
export const fromSaraApp = (req: IncomingMessage): boolean => /\bSara(Phone|Desktop)\/\d/.test(String(req.headers['user-agent'] ?? ''));

export function validWorkspace(v: unknown): string {
  const name = String(v ?? '');
  if (!WORKSPACE_NAME_RE.test(name)) throw new HttpError(400, 'Workspace name: letters, digits, dot, dash, underscore (max 64).');
  return name;
}

export class HttpError extends Error {
  readonly status: number;
  /** Extra fields for the JSON error body (e.g. { twoStep: true }). */
  readonly extra?: Record<string, unknown>;
  /**
   * Phase 61: `message` is English. With `extra.params` it is a template ("Send up to {n} photos at a
   * time."): the body then has the filled English `error` plus `errorKey` (the template) and `params`,
   * so the app shows it in the owner's language (web/naming.js serverText). `extra.errorKey` alone
   * names the template of a message the server already personalized.
   */
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    const params = extra?.params && typeof extra.params === 'object' ? (extra.params as Record<string, unknown>) : undefined;
    super(params ? fill(message, params) : message);
    this.status = status;
    if (params) this.extra = { errorKey: message, ...extra };
    else if (extra) this.extra = extra;
  }
}

/** The 400 for an error a cleaning/validating function threw: its message, as it was. */
export function as400(err: unknown): HttpError {
  return new HttpError(400, (err as Error).message);
}

/** decodeURIComponent that answers a garbled address with 400 instead of a crash report. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'That address is not valid.');
  }
}

export const MAX_BODY = 1024 * 1024;
/** A message with up to 4 photos (base64 adds a third). */
export const PHOTO_BODY = 48 * 1024 * 1024;
export const MAX_IMPORT = 200 * 1024 * 1024;
export const MAX_AVATAR = 5 * 1024 * 1024;
/** A character file: the look is ~20 pictures (Phase 21). */
export const MAX_CHARACTER = 60 * 1024 * 1024;
export const AVATAR_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // Phase 24: only the microphone (voice notes, calls) and clipboard are used; nothing else.
  // Phase 69: the camera for video calls (the page asks only after the owner turns it on in a call).
  'permissions-policy': 'camera=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), microphone=(self), clipboard-write=(self)',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(json);
}

/** EC4: the field names (never the values) of each request's JSON body, for its audit row. */
const BODY_KEYS = new WeakMap<IncomingMessage, string[]>();
export const bodyKeys = (req: IncomingMessage): string[] | undefined => BODY_KEYS.get(req);
const keyNames = (v: Record<string, unknown>): string[] =>
  Object.entries(v).flatMap(([k, x]) => (x && typeof x === 'object' && !Array.isArray(x) ? [k, ...Object.keys(x).map((c) => `${k}.${c}`)] : [k])).slice(0, 40);

export async function readJson(req: IncomingMessage, maxBody = MAX_BODY): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  if (Number(req.headers['content-length'] ?? 0) > maxBody) throw new HttpError(413, 'Request body too large');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBody) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    BODY_KEYS.set(req, keyNames(v));
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export async function readRaw(req: IncomingMessage, maxBody: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > maxBody) throw new HttpError(413, 'Request body too large');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBody) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* a malformed cookie (e.g. set by another site on the same domain) is skipped */
    }
  }
  return out;
}

/**
 * The request's Origin, when it sends one, is this server (a request without an Origin, e.g.
 * from an app or a same-site GET, passes). A garbled Origin ("null") is refused.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Client address for rate limiting. Behind a trusted reverse proxy (Apache, nginx, Caddy) the
 * socket address is the proxy, so use the last X-Forwarded-For entry, which the proxy appends.
 * Earlier entries are client-controlled and ignored (see proxyTrust below for when it's trusted).
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean | { secret: string } = false): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return socketIp;
  if (typeof trustProxy === 'object') {
    const given = req.headers['x-sara-proxy'];
    const a = Buffer.from(typeof given === 'string' ? given : '');
    const b = Buffer.from(trustProxy.secret);
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) return socketIp;
  }
  const xff = req.headers['x-forwarded-for'];
  const value = Array.isArray(xff) ? xff.join(',') : xff;
  const last = value?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last || socketIp;
}

/**
 * Security review (L7): how far to trust a local reverse proxy, from sara.env.
 * - SARA_TRUST_PROXY unset/0: not at all.
 * - A per-install secret (SARA_PROXY_SECRET, or <data>/proxy-secret written by `sara access` for
 *   Caddy): X-Forwarded-For only on requests with the matching X-Sara-Proxy header. Any local
 *   program can connect to 127.0.0.1 and send its own X-Forwarded-For; without the secret it is
 *   counted by its connection like everyone else.
 * - Tailscale (SARA_ACCESS=tailscale): `tailscale serve` can't add a header, so never.
 * - Otherwise (a reverse proxy the owner set up by hand: Apache, nginx): as before.
 */
export function proxyTrust(env: NodeJS.ProcessEnv, dataDir: string): boolean | { secret: string } {
  if (env.SARA_TRUST_PROXY !== '1') return false;
  let secret = (env.SARA_PROXY_SECRET ?? '').trim();
  if (!secret) {
    try {
      secret = readFileSync(join(dataDir, 'proxy-secret'), 'utf8').trim();
    } catch {
      secret = '';
    }
  }
  if (secret) return { secret };
  if (env.SARA_ACCESS === 'tailscale' || env.SARA_MAC_TS_SERVE === '1') return { secret: '' };
  return true;
}
