// E6 (docs/ops/E6_DESIGN.md): one public RSS/Atom feed for Read together. Fetched only when the
// owner presses Open or Reload, never in the background or while a turn is built: https public
// targets only (every redirect checked again, at most 3), 10 s in all, 2 MB, 50 items, 4,000
// characters per item with a visible "(cut)". No cookies or credentials; the linked articles are
// never fetched. The result lives in memory only (src/read-together.ts keeps one per chat).
import { createHash } from 'node:crypto';
import { en } from './i18n.ts';
import { attr, kid, kids, parseXml, textOf, type XmlElement } from './library/xml.ts';
import { blockText, htmlToText } from './library/html.ts';
import { checkOutbound, checkPublicTarget, isPrivateLocalError, netFetch, privateLocalOn, type TargetRefusal } from './net-guard.ts';
import { RT, textHash } from './read-together.ts';

export const FEED = { maxRedirects: 3, timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, maxItems: 50, maxTitle: 300 } as const;
const CUT = ' (cut)';

export interface FeedItem { key: string; title: string; published: string | null; link: string | null; text: string; textSha: string }
export interface Snapshot { url: string; host: string; title: string; rev: string; items: FeedItem[]; at: string }
export interface OpenFeedOptions { lookup?: (host: string) => Promise<string[]>; timeoutMs?: number; now?: () => Date }

export class FeedError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const ADDRESS: Record<TargetRefusal, string> = {
  invalid: en('That address is not valid.'),
  userinfo: en('The address may not contain a user name or password.'),
  https: en('Use an https:// address.'),
  private: en('Sara only opens feeds at public addresses (not this computer, the home network or Tailscale).'),
  dns: en("Couldn't find that site."),
  'private-name': en('That name points to a private address; Sara only opens feeds at public addresses.'),
};
const fail = (status: number, reason: string, message: string): never => {
  throw new FeedError(status, reason, message);
};

async function guard(url: string, lookup: OpenFeedOptions['lookup']): Promise<URL> {
  try {
    return await checkPublicTarget(url, { what: 'feed', ...(lookup ? { lookup } : {}) });
  } catch (err) {
    if (isPrivateLocalError(err)) throw err;
    const code = (err as { code?: TargetRefusal }).code;
    return fail(400, 'address', (code && ADDRESS[code]) || ADDRESS.invalid);
  }
}

/** The body, at most FEED.maxBytes (the declared length is checked first; the stream is cut past it). */
async function readCapped(res: Response, signal: AbortSignal): Promise<Uint8Array> {
  const tooLarge = () => fail(413, 'too-large', en('The feed is too large (over 2 MB).'));
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > FEED.maxBytes) {
    await res.body?.cancel().catch(() => {});
    tooLarge();
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail(504, 'timeout', en('The feed took too long to answer.'));
      if (done) break;
      size += value.byteLength;
      if (size > FEED.maxBytes) {
        await reader.cancel().catch(() => {});
        tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const plain = (el: XmlElement | undefined): string => {
  if (!el) return '';
  const type = attr(el, 'type');
  const raw = textOf(el);
  return oneLine(type === 'html' || type === 'xhtml' ? htmlToText(raw).blocks.map((b) => b.text).join(' ') : raw).slice(0, FEED.maxTitle);
};
const body = (el: XmlElement | undefined): string => (el ? htmlToText(textOf(el)).blocks.map(blockText).join('\n\n') : '');
function when(el: XmlElement | undefined): string | null {
  const raw = oneLine(textOf(el));
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? raw.slice(0, 64) : new Date(t).toISOString();
}
function web(raw: string | undefined, base: URL): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The items of an RSS 2.0, RSS 1.0 (RDF) or Atom document; anything else is not a feed. */
export function parseFeed(src: string, base: URL): { title: string; items: FeedItem[] } {
  let root: XmlElement | undefined;
  try {
    root = kids(parseXml(src))[0];
  } catch {
    root = undefined;
  }
  if (!root || !['rss', 'feed', 'RDF'].includes(root.local)) return fail(422, 'not-feed', en("That address isn't a feed."));
  const atom = root.local === 'feed';
  const channel = atom ? root : kid(root, 'channel');
  const nodes = atom ? kids(root, 'entry') : root.local === 'RDF' ? kids(root, 'item') : kids(channel, 'item');
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (items.length >= FEED.maxItems) break;
    const title = plain(kid(n, 'title'));
    const link = atom ? web(attr(kids(n, 'link').find((l) => !attr(l, 'rel') || attr(l, 'rel') === 'alternate'), 'href'), base) : web(textOf(kid(n, 'link')), base);
    const published = when(atom ? kid(n, 'published') ?? kid(n, 'updated') : kid(n, 'pubDate') ?? kid(n, 'date'));
    let text = body(atom ? kid(n, 'content') ?? kid(n, 'summary') : kid(n, 'encoded') ?? kid(n, 'description'));
    if (text.length > RT.maxChars) text = text.slice(0, RT.maxChars - CUT.length).trimEnd() + CUT;
    const id = oneLine(atom ? textOf(kid(n, 'id')) : textOf(kid(n, 'guid')) || (attr(n, 'about') ?? ''));
    const key = short(id || link || `${title}|${published ?? ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, title, published, link, text, textSha: textHash(`${title}\n\n${text}`) });
  }
  return { title: plain(kid(channel, 'title')), items };
}

/** Open (or Reload) one feed: the guarded fetch, then the parse. Private local mode: PrivateLocalError, no request. */
export async function openFeed(url: string, opts: OpenFeedOptions = {}): Promise<Snapshot> {
  if (privateLocalOn()) checkOutbound(url, 'feed');
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FEED.timeoutMs);
  const first = await guard(url, opts.lookup);
  let target = first;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await netFetch(target.href, { redirect: 'manual', signal, headers: { 'user-agent': 'Sara-Feeds/1', accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1' } });
    } catch (err) {
      if (isPrivateLocalError(err)) throw err;
      if (signal.aborted) return fail(504, 'timeout', en('The feed took too long to answer.'));
      return fail(502, 'network', en("Couldn't reach the feed."));
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= FEED.maxRedirects) fail(502, 'redirects', en('The feed sent Sara on to too many other addresses.'));
      let next: string;
      try {
        next = new URL(location, target).href;
      } catch {
        return fail(400, 'address', ADDRESS.invalid);
      }
      target = await guard(next, opts.lookup);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return fail(502, 'status', en("The feed's site answered with an error."));
    }
    const bytes = await readCapped(res, signal);
    const parsed = parseFeed(new TextDecoder('utf-8').decode(bytes), target);
    return { url: first.href, host: target.hostname.replace(/^\[|\]$/g, ''), title: parsed.title || target.hostname, rev: createHash('sha256').update(bytes).digest('hex'), items: parsed.items, at: (opts.now?.() ?? new Date()).toISOString() };
  }
}
