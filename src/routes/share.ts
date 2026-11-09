// EC11 (docs/ops/EC1115_DESIGN.md): share a conversation. The owner's routes (preview, create,
// list, revoke, settings) and the public read-only page `/s/<token>`: server-rendered and escaped,
// no script, never indexed, rate-limited per address. Household members share their own chats unless
// the owner turned that off (settings `members`); the demo can't share.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { audit } from '../audit-trail.ts';
import { LoginLimiter } from '../auth.ts';
import { clientIp, HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { LANGUAGES, toLang, tr, type Lang } from '../i18n.ts';
import { privateLocalOn } from '../net-guard.ts';
import { KeyLimiter } from '../other-apps.ts';
import { policy } from '../policy-profile.ts';
import { buildSnapshot, DEFAULT_EXPIRY, SHARE_EXPIRY, shareRefusal, shares, type ShareExpiry, type ShareOptions, type ShareSnapshot } from '../share.ts';
import type { ServerOptions } from '../server.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const optionsOf = (body: Record<string, unknown>): ShareOptions => ({ tools: body.tools === true, pictures: body.pictures === true });

/** The address the owner is using: https behind a trusted proxy, so links work behind Sara's public URL. */
export function originOf(req: IncomingMessage, trustProxy: ServerOptions['trustProxy']): string {
  const https = Boolean((req.socket as { encrypted?: boolean }).encrypted) || (Boolean(trustProxy) && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https');
  const host = String((trustProxy && req.headers['x-forwarded-host']) || req.headers.host || 'localhost').split(',')[0].trim();
  return `${https ? 'https' : 'http'}://${host}`;
}

export function createShareRoutes(ctx: RouteCtx): RouteHandler {
  const { opts, app, ctxOf, spaceId } = ctx;
  const isMember = () => Boolean(opts.member || app.member);
  /** Audit rows name the member who made or revoked a link (never the token or text). */
  const by = () => (isMember() ? { who: `member:${spaceId}`, role: 'member' as const } : {});
  const ownerOnly = () => {
    if (isMember() || opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
  };
  /** The owner always; a household member while the owner allows member links; never the demo. */
  const canShare = () => {
    if (opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    if (isMember() && !store().settings().members) throw new HttpError(403, 'The owner has turned off share links for household members.', { membersOff: true });
  };
  const store = () => {
    const s = shares();
    if (!s) throw new HttpError(404, 'Not available');
    return s;
  };
  /** The snapshot for a conversation, or the refusal (409) in plain words. */
  const snapshotFor = (id: string, o: ShareOptions) => {
    const cx = ctxOf(id);
    const conv = cx.store.getConversation(id);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    if (!policy().sharingOn) throw policy().refusal('sharing');
    const why = shareRefusal(conv, { offRecord: Boolean(cx.offRecord), privateLocal: privateLocalOn(), allowPrivate: store().settings().allowPrivate });
    if (why) throw new HttpError(409, why, { refused: true });
    const built = buildSnapshot(conv, cx.store.messages(id), o, { redact: app.redactor, companion: app.persona.name, picture: (pid) => cx.uploads?.load(pid) });
    return { conv, cx, ...built };
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a === 'conversations' && b && c === 'share' && d === 'preview' && method === 'POST') {
      canShare();
      const { snapshot } = snapshotFor(b, optionsOf(await readJson(req)));
      return send(res, 200, { snapshot, expiries: Object.keys(SHARE_EXPIRY), defaultExpiry: DEFAULT_EXPIRY });
    }
    if (a !== 'shares') return NEXT;
    if (opts.demo || app.demo) ownerOnly();
    const s = store();
    if (b === 'settings') {
      if (method === 'GET') return send(res, 200, { ...s.settings(), sharing: policy().sharingOn, ...(isMember() ? { member: true } : { memberLinks: s.memberLinks() }) });
      if (method === 'PUT') {
        ownerOnly();
        const body = await readJson(req);
        const keys = (['allowPrivate', 'members'] as const).filter((k) => typeof body[k] === 'boolean');
        s.setSettings(Object.fromEntries(keys.map((k) => [k, body[k] === true])));
        audit({ action: 'share.settings', keys: [...keys] });
        return send(res, 200, { ...s.settings(), memberLinks: s.memberLinks() });
      }
    }
    // A member's own links stay listed (and revocable) while member links are off.
    if (!b && method === 'GET') return send(res, 200, { shares: s.list(spaceId), sharing: policy().sharingOn, ...s.settings(), ...(isMember() ? { member: true } : {}) });
    if (!b && method === 'POST') {
      canShare();
      const body = await readJson(req);
      const expires = String(body.expires ?? DEFAULT_EXPIRY) as ShareExpiry;
      if (!(expires in SHARE_EXPIRY)) throw new HttpError(400, 'Pick an expiry: 1 hour, 1 day, 7 days or 30 days.');
      const o = optionsOf(body);
      const { cx, snapshot, pictures } = snapshotFor(String(body.conversationId ?? ''), o);
      const made = s.create({ space: spaceId, companion: cx.companionId ?? 'main', conversationId: String(body.conversationId), expires, options: o, snapshot, pictures });
      audit({ action: 'share.create', target: `share:${made.id}`, keys: [`expires:${expires}`, ...(o.tools ? ['tools'] : []), ...(o.pictures ? ['pictures'] : [])], ...by() });
      return send(res, 201, { id: made.id, link: `${originOf(req, opts.trustProxy)}/s/${made.token}`, expiresAt: made.expiresAt });
    }
    if (b && !c && method === 'DELETE') {
      const row = s.get(b);
      if (!row || row.space !== spaceId) throw new HttpError(404, 'Not found');
      const r = s.revoke(b)!;
      audit({ action: 'share.revoke', target: `share:${b} views:${r.views}`, ...by() });
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}

// ---- the public page ----

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const PUBLIC_HEADERS = { ...SECURITY_HEADERS, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };

/** The visitor's language from Accept-Language, else the owner's. */
function visitorLang(req: IncomingMessage, fallback: Lang): Lang {
  for (const part of String(req.headers['accept-language'] ?? '').split(',')) {
    const code = part.split(';')[0].trim();
    const l = toLang(code) ?? toLang(code.split('-')[0]);
    if (l && (LANGUAGES as readonly string[]).includes(l)) return l;
  }
  return fallback;
}

function page(lang: Lang, title: string, body: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/share.css"></head><body><main class="sh-page">${body}</main></body></html>`;
}

function render(snap: ShareSnapshot, expiresAt: string, lang: Lang, base: string): string {
  const when = (iso: string) => new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  const who = { user: tr('Owner', lang), assistant: snap.companion || 'Sara' };
  const rows = snap.messages
    .map((m) => {
      const label = m.role === 'tool' ? tr('Tool result: {name}', lang, { name: m.name ?? '' }) : who[m.role];
      const pics = (m.pics ?? []).map((n) => `<img class="sh-pic" src="${base}/p/${n}" alt="${esc(tr('Picture', lang))}">`).join('');
      return `<article class="sh-msg sh-${m.role}"><h2 class="sh-who">${esc(label)}</h2>${m.text ? `<div class="sh-text">${esc(m.text)}</div>` : ''}${pics}</article>`;
    })
    .join('');
  const hidden = snap.hidden.scrubbed + snap.hidden.tools + snap.hidden.pictures;
  return page(
    lang,
    snap.title || tr('Shared conversation', lang),
    `<header class="sh-head"><h1>${esc(snap.title || tr('Shared conversation', lang))}</h1><p class="sh-ai">${esc(tr('A read-only copy, shared by its owner. Replies from {name} were written by an AI.', lang, { name: who.assistant }))}</p><p class="sh-meta">${esc(tr('This link stops working on {date}.', lang, { date: when(expiresAt) }))}${hidden ? ' ' + esc(tr('Some parts were hidden before sharing.', lang)) : ''}</p></header>${rows}`,
  );
}

/** Public read-only page `/s/<token>` (and `/s/<token>/p/<n>` for a picture). Answers true when handled. */
export function createSharePublic(o: { opts: ServerOptions; ownerLang: () => Lang }): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
  const views = new KeyLimiter(60);
  const wrong = new LoginLimiter(20);
  return (req, res, pathname) => {
    const m = /^\/s\/([^/]+)(?:\/p\/(\d{1,2}))?\/?$/.exec(pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    const lang = visitorLang(req, o.ownerLang());
    const ip = LoginLimiter.key(clientIp(req, o.opts.trustProxy));
    const plain = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...PUBLIC_HEADERS });
      res.end(page(lang, text, `<p class="sh-gone">${esc(text)}</p>`));
    };
    if (method !== 'GET' && method !== 'HEAD') return (plain(405, tr('Method not allowed', lang)), true);
    if (views.take(ip) || wrong.blocked(ip)) return (plain(429, tr('Too many requests. Try again later.', lang)), true);
    const s = shares();
    const gone = () => {
      wrong.fail(ip);
      plain(404, tr('This link has expired or was revoked.', lang));
      return true;
    };
    if (!s || o.opts.demo || !policy().sharingOn) return gone();
    // Household members' links answer only while the owner allows member links.
    const allow = (space: string) => space === 'owner' || s.settings().members;
    const token = m[1];
    if (m[2] !== undefined) {
      const pic = s.picture(token, Number(m[2]), allow);
      if (!pic) return gone();
      res.writeHead(200, { 'content-type': pic.mime, 'content-length': pic.data.length, ...PUBLIC_HEADERS });
      res.end(method === 'HEAD' ? undefined : pic.data);
      return true;
    }
    const open = s.open(token, allow);
    if (!open) return gone();
    if (open.first) audit({ action: 'share.view', target: `share:${open.share.id}`, role: 'system', who: 'visitor', channel: 'web' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...PUBLIC_HEADERS });
    res.end(method === 'HEAD' ? undefined : render(open.share.snapshot, open.share.expiresAt, lang, `/s/${token}`));
    return true;
  };
}
