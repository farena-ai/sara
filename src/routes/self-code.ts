// T3 (docs/SELF_CODE.md): her own code changes, the owner's only (members, kid mode and the demo: 403).
//   GET    /api/self-code                  {available, kind, why, mode, cap, minutes, permission, fullUntil, version, changes}
//   PUT    /api/self-code/settings         {capUsd?, minutes?}
//   POST   /api/self-code                  {request} → 202 {change}   prepare a change (background)
//   GET    /api/self-code/:id              the change with its diff (the approval card)
//   POST   /api/self-code/:id/apply        Approve: snapshot, apply, restart, health check (rollback by itself)
//   POST   /api/self-code/:id/undo         take an applied change out (same restart and health check)
//   POST   /api/self-code/:id/discard
//   GET    /api/self-code/:id/report       exactly what "Send this fix to the Sara developers" sends
//   POST   /api/self-code/:id/report       {send: true} sends it
// Every action writes an audit row (src/self-code.ts).
import { audit } from '../audit-trail.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { selfCodeOf, SelfCodeError, selfCodeSettings } from '../self-code.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createSelfCodeRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'self-code') return NEXT;
    const sc = ctx.opts.demo || ctx.opts.member ? undefined : selfCodeOf(app);
    if (!sc) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 16 * 1024);
    try {
      if (!b && method === 'GET') return send(res, 200, sc.status());
      if (!b && method === 'POST') return send(res, 202, { change: sc.start(String(body.request ?? '')) });
      if (b === 'settings' && !c && method === 'PUT') {
        const cur = (app.settings.get() as unknown as { selfCode?: Record<string, unknown> }).selfCode ?? {};
        const next = { ...cur };
        if (body.capUsd !== undefined) next.capUsd = Number(body.capUsd);
        if (body.minutes !== undefined) next.minutes = Number(body.minutes);
        const clean = selfCodeSettings({ selfCode: next });
        app.settings.update({ selfCode: { capUsd: clean.capUsd, minutes: clean.minutes } } as never);
        audit({ action: 'self-code.settings', role: 'owner', outcome: 'ok', keys: Object.keys(body).filter((k) => k === 'capUsd' || k === 'minutes') });
        return send(res, 200, sc.status());
      }
      const id = Number(b);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
      if (!c && method === 'GET') {
        const ch = sc.get(id);
        if (!ch) throw new HttpError(404, en('No such code change.'));
        return send(res, 200, { change: ch });
      }
      if ((c === 'apply' || c === 'undo') && method === 'POST') {
        // It restarts her: from a remote device the owner confirms first (as for updates).
        ctx.askFirst(req, 'restart');
        return send(res, 200, { change: c === 'apply' ? await sc.apply(id) : await sc.undo(id) });
      }
      if (c === 'discard' && method === 'POST') return send(res, 200, { change: sc.discard(id) });
      if (c === 'report' && method === 'GET') return send(res, 200, { preview: sc.reportPreview(id) });
      if (c === 'report' && method === 'POST') {
        if (body.send !== true) throw new HttpError(400, en('Tick "Send this fix to the Sara developers" first.'));
        return send(res, 200, await sc.report(id));
      }
    } catch (err) {
      if (err instanceof SelfCodeError) throw new HttpError(err.status, err.message);
      throw err;
    }
    throw new HttpError(404, 'Not found');
  };
}
