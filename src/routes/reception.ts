// V3.5 (docs/RECEPTION.md): the website receptionist's public side (no sign-in).
//   GET  /reception.js              the loader a website includes (one <script> tag; builds a button + iframe)
//   GET  /reception/<id>            the chat page inside the iframe (framed only by the owner's sites)
//   POST /reception/<id>/ask        {text, history, t} → {reply, kind, lang, slots?, links?}
//   GET  /reception/<id>/slots      → {slots}
//   POST /reception/<id>/book       {slot, name, email, note, t, website} → {ok, message}
// The owner's side rides the booking family: /api/booking/reception (src/routes/booking.ts).
// Off unless switched on; never on the demo; rate-limited per address; never indexed.
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { LoginLimiter } from '../auth.ts';
import { clientIp, readRaw, SECURITY_HEADERS } from '../http.ts';
import { en, tr, type Lang } from '../i18n.ts';
import { KeyLimiter } from '../other-apps.ts';
import { RECEPTION, ReceptionError, receptionById, type Reception, type VisitorTurn } from '../reception.ts';
import type { ServerOptions } from '../server.ts';
import { BookingError, EMAIL, whenText } from '../workapps/booking.ts';
import { visitorLang } from './booking.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const BASE = { ...SECURITY_HEADERS, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' } as Record<string, string>;
delete BASE['x-frame-options'];
/** The chat page may be framed by Sara itself and the owner's chosen sites only. */
export const pageCsp = (sites: string[]) => `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'${sites.length ? ` ${sites.join(' ')}` : ''}`;

const WIDGET_ID = /^[A-Za-z0-9_-]{12,40}$/;

function chatPage(r: Reception, lang: Lang): string {
  const s = r.store.settings();
  const name = r.business || tr('this business', lang);
  const strings = {
    send: tr('Send', lang),
    wait: tr('One moment…', lang),
    book: tr('Book a time', lang),
    pick: tr('Pick a time', lang),
    name: tr('Name', lang),
    email: tr('Email', lang),
    note: tr('What is it about? (optional)', lang),
    ask: tr('Ask for this time', lang),
    fill: tr('Please give your name and a working email address.', lang),
    error: tr('Sorry, something went wrong. Please try again in a minute.', lang),
    you: tr('You', lang),
    her: tr('Assistant', lang),
  };
  const greeting = s.greeting || tr('Hi! I can answer questions about {name}.', lang, { name });
  return `<!doctype html><html lang="${lang}" data-theme="dark"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)}</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/reception.css"><script type="module" src="/reception-chat.js"></script></head><body class="rc-body"><main class="rc" data-id="${esc(s.id)}" data-t="${esc(r.token())}" data-booking="${s.booking ? '1' : ''}" data-strings="${esc(JSON.stringify(strings))}">
<header class="rc-head"><strong class="rc-name">${esc(name)}</strong><span class="rc-badge">${esc(tr('AI assistant', lang))}</span></header>
<p class="rc-notice">${esc(tr('You are chatting with an AI assistant for {name}. It answers only from {name}’s own information and can be wrong. {name} confirms every booking.', lang, { name }))}</p>
<div class="rc-scroll"><ol class="rc-log" aria-live="polite"><li class="rc-msg rc-her">${esc(greeting)}</li></ol>
<div class="rc-slots" hidden></div>
<form class="rc-book" hidden><p class="rc-when"></p><label>${esc(strings.name)} <input name="name" maxlength="80" required autocomplete="name"></label><label>${esc(strings.email)} <input name="email" type="email" maxlength="200" required autocomplete="email"></label><label>${esc(strings.note)} <textarea name="note" rows="2" maxlength="1000"></textarea></label><div class="rc-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div><button type="submit">${esc(strings.ask)}</button></form></div>
<form class="rc-ask"><label class="rc-sr" for="rc-q">${esc(tr('Your question', lang))}</label><textarea id="rc-q" name="q" rows="2" maxlength="${RECEPTION.maxQuestion}" placeholder="${esc(tr('Ask a question…', lang))}" required></textarea><div class="rc-actions">${s.booking ? `<button type="button" class="rc-book-open ghost">${esc(strings.book)}</button>` : ''}<button type="submit">${esc(strings.send)}</button></div></form>
<p class="rc-fine">${esc(tr('Please don’t share passwords or card numbers. Your questions are kept for {name} for 30 days.', lang, { name }))}</p>
</main></body></html>`;
}

/** The public receptionist routes. Answers true when the request was handled. */
export function createReceptionPublic(o: { opts: ServerOptions; ownerLang: () => Lang; webDir: string }): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  const views = new KeyLimiter(60);
  const asks = new Map<string, number[]>();
  const books = new Map<string, number[]>();
  const wrong = new LoginLimiter(20);
  let loader: string | undefined;
  /** At most `max` in `ms` per address (counted). */
  const within = (m: Map<string, number[]>, ip: string, max: number, ms: number): boolean => {
    const now = Date.now();
    const recent = (m.get(ip) ?? []).filter((t) => now - t < ms);
    if (recent.length >= max) return false;
    m.set(ip, [...recent, now]);
    if (m.size > 2000) for (const [k, v] of m) if (!v.some((t) => now - t < ms)) m.delete(k);
    return true;
  };
  return async (req, res, pathname) => {
    if (pathname !== '/reception.js' && !pathname.startsWith('/reception/')) return false;
    const method = req.method ?? 'GET';
    const lang = visitorLang(req, o.ownerLang());
    const ip = LoginLimiter.key(clientIp(req, o.opts.trustProxy));
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...BASE, 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
      return true;
    };
    const drain = async () => {
      if (method === 'POST') await readRaw(req, 16 * 1024).catch(() => undefined);
    };
    if (pathname === '/reception.js') {
      if (method !== 'GET' && method !== 'HEAD') return json(405, { error: tr('Method not allowed', lang) });
      if (o.opts.demo) return json(404, { error: 'Not found' });
      loader ??= readFileSync(join(o.webDir, 'reception-embed.js'), 'utf8');
      // Any website may load the loader; it only adds a button and an iframe to Sara's chat page.
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'cross-origin-resource-policy': 'cross-origin', 'x-content-type-options': 'nosniff' });
      res.end(method === 'HEAD' ? undefined : loader);
      return true;
    }
    const m = /^\/reception\/([A-Za-z0-9_-]+)(?:\/(ask|slots|book))?\/?$/.exec(pathname);
    if (views.take(ip) || wrong.blocked(ip)) {
      await drain();
      return json(429, { error: tr('Too many requests. Try again later.', lang) }, { 'retry-after': '60' });
    }
    const r = m && WIDGET_ID.test(m[1]) && !o.opts.demo ? receptionById(m[1]) : undefined;
    if (!m || !r) {
      await drain();
      wrong.fail(ip);
      return json(404, { error: tr('This chat is not available.', lang) });
    }
    const s = r.store.settings();
    const what = m[2];
    if (!what) {
      if (method !== 'GET' && method !== 'HEAD') return json(405, { error: tr('Method not allowed', lang) });
      res.writeHead(200, { ...BASE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp(s.sites) });
      res.end(method === 'HEAD' ? undefined : chatPage(r, lang));
      return true;
    }
    if (what === 'slots') {
      if (method !== 'GET') return json(405, { error: tr('Method not allowed', lang) });
      return json(200, { slots: await r.slots(lang) });
    }
    if (method !== 'POST') return json(405, { error: tr('Method not allowed', lang) });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((await readRaw(req, 32 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return json(400, { error: tr('Sorry, something went wrong. Please try again in a minute.', lang) });
    }
    const T = (text: string, p?: Record<string, string | number>) => tr(text, lang, p);
    if (what === 'ask') {
      if (!r.tokenOk(String(body.t ?? ''))) return json(403, { error: T(en('Please reload the page and try again.')) });
      const text = String(body.text ?? '').trim();
      if (!text) return json(400, { error: T(en('Ask a question…')) });
      if (text.length > RECEPTION.maxQuestion) return json(400, { error: T(en('Please keep your question under {n} characters.'), { n: RECEPTION.maxQuestion }) });
      if (!within(asks, ip, 20, 10 * 60_000)) return json(429, { error: T(en('Too many requests. Try again later.')) }, { 'retry-after': '120' });
      const history: VisitorTurn[] = (Array.isArray(body.history) ? body.history : [])
        .slice(-RECEPTION.maxHistory)
        .map((h) => (h && typeof h === 'object' ? (h as Record<string, unknown>) : {}))
        .map((h) => ({ role: h.role === 'reply' ? ('reply' as const) : ('visitor' as const), text: String(h.text ?? '').slice(0, RECEPTION.maxTurn) }))
        .filter((h) => h.text.trim());
      // W3.5: the reply's language is read from the visitor's words; `chat` groups one page's questions.
      return json(200, await r.ask(text, history, { lang, chat: r.chatKey(String(body.t ?? '')) }));
    }
    // what === 'book'
    if (!within(books, ip, 5, 60 * 60_000)) return json(429, { error: T(en('Too many requests. Try again later.')) }, { 'retry-after': '600' });
    const sent = () => json(200, { ok: true, message: T(en('Thanks! Your request was sent.')) });
    // A filled honeypot or a bad/too-fast token: a polite answer, nothing booked.
    if (body.website || !r.tokenOk(String(body.t ?? ''), r.minFormMs)) return sent();
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!String(body.name ?? '').trim() || !EMAIL.test(email)) return json(400, { error: T(en('Please give your name and a working email address.')) });
    try {
      const b = await r.book({ slot: String(body.slot ?? ''), name: String(body.name ?? ''), email, note: String(body.note ?? '') });
      return json(200, { ok: true, message: T(en('You asked for {when}. You will get an email at {email} once it is confirmed.'), { when: whenText(b.start, r.tz, lang), email: b.email }) });
    } catch (err) {
      if (err instanceof BookingError || err instanceof ReceptionError) return json(err.status, { error: T(err.message) });
      throw err;
    }
  };
}
