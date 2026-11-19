// V5.3: legacy and emergency access routes (docs/design/LEGACY.md).
//   GET    /api/data-rights/legacy          → view + choices (kept documents, chats) + sealed labels
//   PUT    /api/data-rights/legacy          {on,name,email,days,waitDays,linkDays,emailThem,allowAsk,gets,sealed?,vaultConfirm?,token|code|passkey}
//   DELETE /api/data-rights/legacy          → off (never needs proof)
//   POST   /api/data-rights/legacy/here     → "I'm here" (cancels anything waiting)
//   POST   /api/data-rights/legacy/link     {proof} → a new link (the old one stops)
// Public, no sign-in: GET /legacy/<t>, GET /legacy/<t>/doc/<id>, POST /legacy/<t>/ask.
// Owner only: the data-rights family is refused for members, the demo and device API keys.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../chat.ts';
import { clientIp, HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { LoginLimiter } from '../auth.ts';
import { tr, type Lang } from '../i18n.ts';
import { legacyContent, LegacyError, legacyOf, rememberLegacyOrigin, sealedName, type LegacyConfig } from '../legacy.ts';
import { KeyLimiter } from '../other-apps.ts';
import type { ServerOptions } from '../server.ts';
import type { RouteCtx } from './context.ts';
import { originOf, sharePage, shareEsc as esc, SHARE_PUBLIC_HEADERS, visitorLang } from './share.ts';

const linkOf = (req: IncomingMessage, opts: ServerOptions, token: string) => `${originOf(req, opts.trustProxy)}/legacy/${token}`;

function patchOf(body: Record<string, unknown>): Partial<LegacyConfig> {
  const p: Partial<LegacyConfig> = {};
  for (const k of ['on', 'emailThem', 'allowAsk'] as const) if (typeof body[k] === 'boolean') p[k] = body[k] as boolean;
  for (const k of ['name', 'email'] as const) if (typeof body[k] === 'string') p[k] = body[k] as string;
  for (const k of ['days', 'waitDays', 'linkDays'] as const) if (body[k] !== undefined) p[k] = Number(body[k]);
  if (body.gets && typeof body.gets === 'object') p.gets = body.gets as LegacyConfig['gets'];
  return p;
}

/** Owner routes inside the data-rights family; `c` is the segment after `legacy`. */
export async function legacyRoute(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, method: string, c: string | undefined): Promise<void> {
  const { app, opts } = ctx;
  const lg = legacyOf(app);
  if (!lg) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
  const view = () => {
    const v = lg.view();
    const labels = v.config.gets.labels ?? {};
    return { ...v, sealed: v.config.gets.vault.map((name) => ({ name, label: labels[name] ?? name.slice(7) })), mail: Boolean((app.mailAccounts as { default?: () => unknown } | undefined)?.default?.()) };
  };
  try {
    if (!c && method === 'GET') {
      const lib = app.library as { list(o?: object): { id: number; name: string; title: string | null; keep: boolean }[] } | undefined;
      const docs = (lib?.list() ?? []).filter((d) => d.keep).slice(0, 300).map((d) => ({ id: d.id, title: d.title || d.name }));
      const chats = app.store.listConversations().filter((x) => !x.archivedAt).slice(0, 150).map((x) => ({ id: x.id, title: x.title }));
      return send(res, 200, { ...view(), choices: { docs, chats } });
    }
    if (!c && method === 'PUT') {
      const body = await readJson(req);
      const patch = patchOf(body);
      // Sealed notes: written to the vault only after the change passed its checks.
      let sealed: { name: string; label: string; value?: string }[] | undefined;
      if (Array.isArray(body.sealed)) {
        sealed = (body.sealed as { label?: unknown; value?: unknown }[]).slice(0, 20).flatMap((x) => {
          const label = String(x?.label ?? '').trim().slice(0, 60);
          if (!label) return [];
          return [{ name: sealedName(label), label, ...(typeof x.value === 'string' && x.value ? { value: x.value.slice(0, 4000) } : {}) }];
        });
        const cur = lg.view().config.gets;
        patch.gets = { ...cur, ...(patch.gets ?? {}), vault: sealed.map((s) => s.name), labels: Object.fromEntries(sealed.map((s) => [s.name, s.label])) };
        if (sealed.some((s) => s.value === undefined && !app.vault.has(s.name))) throw new HttpError(400, 'Type what the sealed note says.');
      }
      const proven = lg.needsProof(patch) || (sealed ?? []).some((s) => s.value !== undefined);
      if (proven) ctx.confirmIdentity(req, body, { passkey: true });
      rememberLegacyOrigin(app, originOf(req, opts.trustProxy));
      const before = lg.view().config.gets.vault;
      const { token } = lg.configure(patch, { proven, vaultConfirm: body.vaultConfirm === true });
      if (sealed) {
        for (const s of sealed) if (s.value !== undefined) app.vault.set(s.name, s.value);
        for (const n of before) if (!sealed.some((s) => s.name === n)) app.vault.delete(n);
      }
      return send(res, 200, { ...view(), ...(token ? { link: linkOf(req, opts, token) } : {}) });
    }
    if (!c && method === 'DELETE') {
      lg.turnOff();
      return send(res, 200, view());
    }
    if (c === 'here' && method === 'POST') {
      lg.seen('here');
      return send(res, 200, view());
    }
    if (c === 'link' && method === 'POST') {
      const body = await readJson(req);
      ctx.confirmIdentity(req, body, { passkey: true });
      rememberLegacyOrigin(app, originOf(req, opts.trustProxy));
      return send(res, 200, { ...view(), link: linkOf(req, opts, lg.newLink()) });
    }
  } catch (err) {
    if (err instanceof LegacyError) throw new HttpError(err.status, err.key, err.params ? { params: err.params } : undefined);
    throw err;
  }
  throw new HttpError(404, 'Not found');
}

const when = (iso: string, lang: Lang) => new Date(iso).toLocaleDateString(lang, { dateStyle: 'long', timeZone: 'UTC' });

/** The public page for the trusted person. Returns false when the path isn't ours. */
export function createLegacyPublic(o: { opts: ServerOptions; app: AppContext; ownerLang: () => Lang }): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  const views = new KeyLimiter(60);
  const wrong = new LoginLimiter(20);
  return async (req, res, pathname) => {
    const m = /^\/legacy\/([A-Za-z0-9_-]{1,100})(?:\/(ask|doc)(?:\/(\d{1,9}))?)?\/?$/.exec(pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    const lang = visitorLang(req, o.ownerLang());
    const ip = LoginLimiter.key(clientIp(req, o.opts.trustProxy));
    const html = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SHARE_PUBLIC_HEADERS });
      res.end(method === 'HEAD' ? undefined : sharePage(lang, title, body));
      return true;
    };
    const plain = (status: number, text: string) => html(status, text, `<p class="sh-gone">${esc(text)}</p>`);
    if (wrong.blocked(ip) || views.take(ip)) return plain(429, tr('Too many requests. Try again later.', lang));
    const lg = o.opts.demo || o.opts.member ? undefined : legacyOf(o.app);
    const token = m[1];
    if (!lg || !lg.check(token)) {
      wrong.fail(ip);
      return plain(404, tr('This link has expired or was revoked.', lang));
    }
    lg.tick();
    const v = lg.view();
    const owner = o.app.settings.get().ownerName || tr('The owner', lang);
    if (m[2] === 'ask') {
      if (method !== 'POST') return plain(405, tr('Method not allowed', lang));
      lg.ask(token);
      res.writeHead(303, { location: `/legacy/${token}`, ...SECURITY_HEADERS, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (method !== 'GET' && method !== 'HEAD') return plain(405, tr('Method not allowed', lang));
    if (m[2] === 'doc') {
      const id = Number(m[3]);
      const lib = o.app.library as { get(id: number): { id: number; name: string; keep: boolean } | undefined; file(d: { id: number }): Buffer | undefined } | undefined;
      const d = v.stage === 'open' && v.config.gets.docs.includes(id) ? lib?.get(id) : undefined;
      const bytes = d?.keep ? lib?.file(d as never) : undefined;
      if (!d || !bytes) return plain(404, tr('Not found', lang));
      const name = d.name.replace(/[^\w. -]+/g, '_').slice(0, 120) || 'document';
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'content-disposition': `attachment; filename="${name}"`, ...SHARE_PUBLIC_HEADERS });
      res.end(method === 'HEAD' ? undefined : bytes);
      return true;
    }
    const head = `<header class="sh-head"><h1>${esc(tr('For {name}', lang, { name: v.config.name }))}</h1><p class="sh-meta">${esc(tr('{owner} set this page up for you in Sara.', lang, { owner }))}</p></header>`;
    if (v.stage !== 'open') {
      let body = `<p>${esc(tr('This page is closed for now.', lang))}</p>`;
      if (v.request && v.stage === 'waiting') body += `<p>${esc(tr('You asked for access. {owner} was told and can say no. If nobody answers, it opens on {date}.', lang, { owner, date: when(v.request.opensAt, lang) }))}</p>`;
      else if (v.config.allowAsk && v.stage !== 'closed') body += `<form method="post" action="/legacy/${esc(token)}/ask"><p>${esc(tr('In an emergency you can ask for access. {owner} is told at once and can say no; the page opens only after a waiting period.', lang, { owner }))}</p><button type="submit">${esc(tr('Ask for access', lang))}</button></form>`;
      return html(200, tr('For {name}', lang, { name: v.config.name }), head + body);
    }
    lg.viewed();
    const k = legacyContent(o.app, v.config);
    const part = (title: string, inner: string) => `<section class="sh-msg"><h2 class="sh-who">${esc(title)}</h2>${inner}</section>`;
    let body = `<p class="sh-meta">${esc(tr('Open until {date}.', lang, { date: when(v.expiresAt ?? new Date().toISOString(), lang) }))}</p>`;
    if (k.letter) body += part(tr('A letter', lang), `<div class="sh-text">${esc(k.letter)}</div>`);
    if (k.notes.length) body += part(tr('Notes', lang), `<ul>${k.notes.map((n) => `<li class="sh-text">${esc(n)}</li>`).join('')}</ul>`);
    if (k.vault.length) body += part(tr('Sealed notes', lang), `<dl>${k.vault.map((x) => `<dt>${esc(x.name)}</dt><dd class="sh-text">${esc(x.value)}</dd>`).join('')}</dl>`);
    if (k.details.length) body += part(tr('My details', lang), `<ul>${k.details.map((n) => `<li class="sh-text">${esc(n)}</li>`).join('')}</ul>`);
    if (k.docs.length) body += part(tr('Documents', lang), `<ul>${k.docs.map((d) => `<li><a href="/legacy/${esc(token)}/doc/${d.id}" rel="noreferrer">${esc(d.title)}</a></li>`).join('')}</ul>`);
    for (const ch of k.chats) body += part(tr('Chat: {title}', lang, { title: ch.title }), ch.messages.map((x) => `<article class="sh-msg"><h3 class="sh-who">${esc(x.who)}</h3><div class="sh-text">${esc(x.text)}</div></article>`).join(''));
    return html(200, tr('For {name}', lang, { name: v.config.name }), head + body);
  };
}
