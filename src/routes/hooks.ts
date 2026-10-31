// Phase 102 (ST7, docs/design/STAPLES.md §10.8, docs/WEBHOOKS.md): Settings → Connections →
// Webhooks. Every route is the owner's: `hooks` is not a member route family (src/household.ts), so
// a household member gets 403 ownerOnly before reaching here; the demo refuses it (not in
// DEMO_READS/WRITES); an app signed in with a device code can't use it (DEVICE_TOKEN_DENIED).
//   GET    /api/hooks                  the hooks (today's counts, a 7-day sparkline), presets, tools, skills, plugins, boards, access
//   PUT    /api/hooks                  { keepDays } how long the delivery log is kept
//   POST   /api/hooks                  a new hook → its URL and (once) the secret to paste into the sender
//   PUT    /api/hooks/:id              change it (name, filters, action, tools, limits, memory, forward, secret)
//   DELETE /api/hooks/:id              remove it (its secrets leave the vault, its log goes)
//   POST   /api/hooks/:id/rotate       { sender? } a new URL secret (the old address stops working)
//   POST   /api/hooks/:id/test         { source: last|sample|paste, sample?, body?, headers?, real?, curl?, url? }
//   GET    /api/hooks/:id/deliveries   the log (?before=<id>), or one delivery with its body (?id=<n>)
//   POST   /api/hooks/:id/enable       { on }
import { accessInfo } from '../platform.ts';
import { HttpError, readJson, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { HOOK_TOOLS, KEEP_DAYS } from '../webhooks.ts';
import { PRESETS } from '../webhook-verify.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createHookRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (!(a === 'hooks')) return NEXT;
    const hm = app.hooks;
    if (!hm || app.member || ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Webhooks are not available here.');
    }
    const base = `${(req.socket as { encrypted?: boolean }).encrypted || (Boolean(ctx.opts.trustProxy) && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https') ? 'https' : 'http'}://${String(req.headers.host ?? 'localhost')}`;
    const acc = accessInfo();
    const publicBase = acc.url ?? base;

    if (!b && method === 'GET') {
      const board = app.board;
      const boards = board ? board.boards().map((bd) => ({ id: bd.id, name: bd.name, columns: board.columns(bd.id).map((col) => ({ id: col.id, name: col.name, role: col.role })) })) : [];
      return send(res, 200, {
        hooks: hm.store.all().map((h) => hm.view(h)),
        presets: PRESETS.map((p) => ({ id: p.id, sender: p.sender, name: p.name, filters: p.filters, template: p.template, event: p.event })),
        tools: Object.fromEntries(Object.entries(HOOK_TOOLS).map(([k, v]) => [k, { tools: v.tools, auto: v.auto }])),
        skills: (app.skills?.effective() ?? []).filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description.slice(0, 160) })),
        plugins: app.pluginManager?.webhookPlugins(app.companionId ?? 'main') ?? [],
        boards,
        companions: hm.companions(),
        access: { mode: acc.mode, label: acc.label, url: acc.url },
        base: publicBase,
        privateLocal: privateLocalOn(),
        keepDays: app.settings.get().hooks?.keepDays ?? KEEP_DAYS,
      });
    }
    if (!b && method === 'PUT') {
      const body = await readJson(req);
      const days = Math.round(Number(body.keepDays));
      if (![3, 7, 14, 30, 90].includes(days)) throw new HttpError(400, 'Keep the log for 3, 7, 14, 30 or 90 days.');
      app.settings.update({ hooks: { ...(app.settings.get().hooks ?? {}), keepDays: days } });
      hm.store.prune(days);
      return send(res, 200, { keepDays: days });
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      const r = hm.create(body);
      app.events?.publish({ type: 'hooks', hookId: r.hook.id });
      return send(res, 201, { hook: hm.view(r.hook), url: `${publicBase}${r.path}`, ...(r.senderSecret ? { senderSecret: r.senderSecret } : {}), ...(r.outSecret ? { outSecret: r.outSecret } : {}) });
    }
    const hook = b ? hm.store.get(b) : undefined;
    if (!hook) {
      if (method !== 'GET' && method !== 'DELETE') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'No such webhook.');
    }
    if (!c && method === 'PUT') {
      const body = await readJson(req);
      const r = hm.change(hook.id, body);
      app.events?.publish({ type: 'hooks', hookId: hook.id });
      return send(res, 200, { hook: hm.view(r.hook), ...(r.outSecret ? { outSecret: r.outSecret } : {}) });
    }
    if (!c && method === 'DELETE') {
      hm.remove(hook.id);
      app.events?.publish({ type: 'hooks', hookId: hook.id });
      return send(res, 200, { ok: true });
    }
    if (c === 'rotate' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const r = hm.rotate(hook.id, body.sender === true);
      return send(res, 200, { url: `${publicBase}${r.path}`, ...(r.senderSecret ? { senderSecret: r.senderSecret } : {}) });
    }
    if (c === 'enable' && method === 'POST') {
      const body = await readJson(req);
      const h = hm.store.update(hook.id, { enabled: body.on === true });
      app.events?.publish({ type: 'hooks', hookId: hook.id });
      return send(res, 200, { hook: hm.view(h!) });
    }
    if (c === 'test' && method === 'POST') {
      const body = await readJson(req);
      if (body.curl === true) return send(res, 200, { curl: hm.curl(hook.id, { ...(typeof body.url === 'string' ? { url: body.url } : {}), ...(typeof body.sample === 'string' ? { preset: body.sample } : {}) }) });
      return send(res, 200, await hm.test(hook.id, body));
    }
    if (c === 'deliveries' && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const one = Number(q.get('id'));
      if (one) {
        const d = hm.store.delivery(one);
        if (!d || d.hookId !== hook.id) throw new HttpError(404, 'No such delivery.');
        return send(res, 200, { delivery: hm.deliveryView(d, true) });
      }
      const before = Number(q.get('before')) || undefined;
      return send(res, 200, { deliveries: hm.store.deliveries(hook.id, 50, before).map((d) => hm.deliveryView(d)) });
    }
    throw new HttpError(404, 'Not found');
  };
}
