// R6 (docs/WORK_APPS.md): the booking page and the accounting export, each person's own.
//   GET    /api/booking                              {settings, url, requests, calendars, mailbox}
//   PUT    /api/booking                              settings fields → the same view
//   POST   /api/booking/requests/:id/confirm|decline → {request}
//   GET    /api/accounting/export?from&to&format&what → one CSV file (a download)
// The public page /book/<slug> (no sign-in): server-rendered and escaped, no script, never indexed,
// rate-limited per address, a honeypot box and a signed time token instead of a captcha.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoginLimiter } from '../auth.ts';
import { clientIp, HttpError, readJson, readRaw, SECURITY_HEADERS, send } from '../http.ts';
import { en, LANGUAGES, toLang, tr, trOwner, type Lang } from '../i18n.ts';
import { KeyLimiter } from '../other-apps.ts';
import type { ServerOptions } from '../server.ts';
import { ToolError } from '../tools/types.ts';
import { accountingCsv, ACCOUNTING_FORMATS, ACCOUNTING_PARTS, type AccountingFormat, type AccountingPart } from '../workapps/accounting.ts';
import { BookingError, bookingBySlug, bookingFor, slugify, slugTaken, whenText, type Booking } from '../workapps/booking.ts';
import { ReceptionError, receptionFor } from '../reception.ts';
import { originOf } from './share.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createBookingRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof BookingError) throw new HttpError(err.status, T(err.message));
      if (err instanceof ToolError) throw new HttpError(400, T(err.message));
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'booking' && a !== 'accounting') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (a === 'accounting') {
      if (b !== 'export' || method !== 'GET') throw new HttpError(404, 'Not found');
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const format = String(q.get('format') ?? '') as AccountingFormat;
      const what = String(q.get('what') ?? (format === 'generic' ? 'all' : 'invoices')) as AccountingPart;
      if (!(ACCOUNTING_FORMATS as readonly string[]).includes(format) || !(ACCOUNTING_PARTS as readonly string[]).includes(what)) throw new HttpError(400, T('Pick a format and what to export.'));
      const f = await wrap(() => accountingCsv(app, { from: String(q.get('from') ?? ''), to: String(q.get('to') ?? ''), format, what }));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store', 'x-rows': String(f.rows) });
      res.end(`\ufeff${f.csv}`);
      return;
    }
    // V3.5: the website receptionist (docs/RECEPTION.md), each space's own.
    if (b === 'reception') {
      const rc = receptionFor(app);
      const rview = () => {
        const s = rc.store.settings();
        const base = originOf(req, ctx.opts.trustProxy);
        return { settings: s, url: `${base}/reception/${s.id}`, embed: `<script src="${base}/reception.js" data-sara="${s.id}" async></script>`, docs: rc.docChoices(), log: rc.store.recent(30), chats: rc.store.chats(), approved: rc.store.approved(), followups: rc.store.followups(), business: rc.business, bookingReady: bookingFor(app).store.settings().windows.length > 0, ...bookingFor(app).connections() };
      };
      if (!c && method === 'GET') return send(res, 200, rview());
      if (!c && method === 'PUT') {
        const body = await readJson(req);
        try {
          rc.store.save(body, (ids) => rc.keptDocs(ids));
        } catch (err) {
          if (err instanceof ReceptionError) throw new HttpError(err.status, T(err.message));
          throw err;
        }
        return send(res, 200, rview());
      }
      // W3.5: corrections become approved answers; follow-up drafts are sent only on the owner's OK.
      const rwrap = async (f: () => unknown) => {
        try {
          await f();
        } catch (err) {
          if (err instanceof ReceptionError) throw new HttpError(err.status, T(err.message));
          throw err;
        }
        return send(res, 200, rview());
      };
      if (c === 'correct' && method === 'POST') {
        const body = await readJson(req);
        return rwrap(() => rc.correct(body));
      }
      if (c === 'approved' && d && method === 'DELETE') {
        if (!rc.store.forgetApproved(Number(d))) throw new HttpError(404, 'Not found');
        return send(res, 200, rview());
      }
      if (c === 'followups' && d && (e === 'send' || e === 'dismiss') && method === 'POST') {
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const id = Number(d);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
        return rwrap(() => (e === 'send' ? rc.sendFollowup(id, body) : rc.dismissFollowup(id)));
      }
      if ((c === 'new-id' || c === 'clear-log') && method === 'POST') {
        await readJson(req).catch(() => undefined);
        if (c === 'new-id') rc.store.newId();
        else rc.store.clearLog();
        return send(res, 200, rview());
      }
      throw new HttpError(404, 'Not found');
    }
    const bk = bookingFor(app);
    const view = () => {
      const s = bk.store.settings();
      return { settings: s, url: s.slug ? `${originOf(req, ctx.opts.trustProxy)}/book/${s.slug}` : null, requests: bk.store.requests().slice(0, 50), ...bk.connections() };
    };
    if (!b && method === 'GET') return send(res, 200, view());
    if (!b && method === 'PUT') {
      const body = await readJson(req);
      await wrap(() => {
        const next = { ...bk.store.settings(), ...body } as Record<string, unknown>;
        if (next.on && slugTaken(slugify(next.slug), bk)) throw new BookingError(en('Someone on this server already uses that page name. Pick another.'), 409);
        bk.store.save(body);
      });
      return send(res, 200, view());
    }
    if (b === 'requests' && c && (d === 'confirm' || d === 'decline') && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const id = Number(c);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
      const r = await wrap(() => (d === 'confirm' ? bk.confirm(id) : bk.decline(id)));
      return send(res, 200, { request: r, ...view() });
    }
    throw new HttpError(404, 'Not found');
  };
}

// ---------------------------------------------------------------- the public page

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const HEADERS = { ...SECURITY_HEADERS, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };
export function visitorLang(req: IncomingMessage, fallback: Lang): Lang {
  for (const part of String(req.headers['accept-language'] ?? '').split(',')) {
    const code = part.split(';')[0].trim();
    const l = toLang(code) ?? toLang(code.split('-')[0]);
    if (l && (LANGUAGES as readonly string[]).includes(l)) return l;
  }
  return fallback;
}
const shell = (lang: Lang, title: string, body: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/book.css"></head><body><main class="bk-page">${body}</main></body></html>`;

function form(b: Booking, slots: Date[], lang: Lang, base: string, msg = ''): string {
  const s = b.store.settings();
  const tz = b.tz;
  const days = new Map<string, Date[]>();
  for (const d of slots) {
    const key = d.toLocaleDateString(lang, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
    days.set(key, [...(days.get(key) ?? []), d]);
  }
  const groups = [...days.entries()]
    .map(([day, ds]) => `<fieldset class="bk-day"><legend>${esc(day)}</legend>${ds.map((d) => `<label class="bk-slot"><input type="radio" name="slot" value="${d.toISOString()}" required> ${esc(d.toLocaleTimeString(lang, { timeZone: tz, hour: 'numeric', minute: '2-digit' }))}</label>`).join('')}</fieldset>`)
    .join('');
  const who = b.ownerName;
  const head = `<header class="bk-head"><h1>${esc(s.title)}${who ? ` · ${esc(who)}` : ''}</h1><p class="bk-meta">${esc(tr('{n} minutes. Times are shown in {zone}.', lang, { n: s.duration, zone: tz ?? 'UTC' }))}</p>${s.note ? `<p class="bk-note">${esc(s.note)}</p>` : ''}</header>`;
  if (!slots.length) return `${head}<p class="bk-empty">${esc(tr('No free times right now. Please check back later.', lang))}</p>`;
  return `${head}${msg ? `<p class="bk-msg" role="alert">${esc(msg)}</p>` : ''}<form method="post" action="${esc(base)}" class="bk-form"><h2>${esc(tr('Pick a time', lang))}</h2>${groups}<h2>${esc(tr('Your details', lang))}</h2><label>${esc(tr('Name', lang))} <input name="name" maxlength="80" required autocomplete="name"></label><label>${esc(tr('Email', lang))} <input name="email" type="email" maxlength="200" required autocomplete="email"></label><label>${esc(tr('What is it about? (optional)', lang))} <textarea name="note" rows="3" maxlength="1000"></textarea></label><div class="bk-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div><input type="hidden" name="t" value="${esc(b.token())}"><button type="submit">${esc(tr(s.approval === 'auto' ? 'Book it' : 'Ask for this time', lang))}</button><p class="bk-fine">${esc(tr('Your name, email and note go only to {name}.', lang, { name: who || tr('the owner of this page', lang) }))}</p></form>`;
}

/** `/book/<slug>`: GET shows the free times, POST asks for one. Answers true when handled. */
export function createBookingPublic(o: { opts: ServerOptions; ownerLang: () => Lang }): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  const views = new KeyLimiter(60);
  const posts = new Map<string, number[]>();
  const wrong = new LoginLimiter(20);
  return async (req, res, pathname) => {
    const m = /^\/book\/([a-z0-9-]{3,40})\/?$/.exec(pathname);
    if (!m && !pathname.startsWith('/book/')) return false;
    const method = req.method ?? 'GET';
    const lang = visitorLang(req, o.ownerLang());
    const ip = LoginLimiter.key(clientIp(req, o.opts.trustProxy));
    const page = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...HEADERS });
      res.end(method === 'HEAD' ? undefined : shell(lang, title, body));
      return true;
    };
    const plain = (status: number, text: string) => page(status, text, `<p class="bk-msg">${esc(text)}</p>`);
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return plain(405, tr('Method not allowed', lang));
    if (views.take(ip) || wrong.blocked(ip)) {
      if (method === 'POST') await readRaw(req, 16 * 1024).catch(() => undefined);
      return plain(429, tr('Too many requests. Try again later.', lang));
    }
    const b = m && !o.opts.demo ? bookingBySlug(m[1]) : undefined;
    if (!b) {
      if (method === 'POST') await readRaw(req, 16 * 1024).catch(() => undefined);
      wrong.fail(ip);
      return plain(404, tr('This booking page is not available.', lang));
    }
    const base = `/book/${m![1]}`;
    const title = b.store.settings().title;
    if (method !== 'POST') return page(200, title, form(b, await b.slots(), lang, base));
    // At most 8 requests per address in 10 minutes.
    const now = Date.now();
    const recent = (posts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= 8) {
      await readRaw(req, 16 * 1024).catch(() => undefined);
      return plain(429, tr('Too many requests. Try again later.', lang));
    }
    posts.set(ip, [...recent, now]);
    if (posts.size > 1000) for (const [k, v] of posts) if (!v.some((t) => now - t < 10 * 60_000)) posts.delete(k);
    const raw = (await readRaw(req, 16 * 1024).catch(() => Buffer.alloc(0))).toString('utf8');
    const f = new URLSearchParams(raw);
    const thanks = () => page(200, title, `<p class="bk-msg">${esc(tr('Thanks! Your request was sent.', lang))}</p>`);
    // A filled honeypot or a form sent faster than a person can type: a polite page, nothing booked.
    if (f.get('website') || !b.tokenOk(String(f.get('t') ?? ''))) return thanks();
    try {
      const r = await b.request({ slot: String(f.get('slot') ?? ''), name: String(f.get('name') ?? ''), email: String(f.get('email') ?? ''), note: String(f.get('note') ?? '') });
      const when = whenText(r.start, b.tz, lang);
      return page(200, title, r.status === 'confirmed' ? `<h1>${esc(tr('Booked: confirmed', lang))}</h1><p class="bk-msg">${esc(tr('See you {when}. A confirmation is on its way to {email}.', lang, { when, email: r.email }))}</p>` : `<h1>${esc(tr('Request sent', lang))}</h1><p class="bk-msg">${esc(tr('You asked for {when}. You will get an email at {email} once it is confirmed.', lang, { when, email: r.email }))}</p>`);
    } catch (err) {
      if (err instanceof BookingError) return page(err.status, title, form(b, await b.slots(), lang, base, tr(err.message, lang)));
      throw err;
    }
  };
}
