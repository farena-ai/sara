// ROADMAP_T T5 (docs/REMOTE_REPAIR.md): remote repair's owner API and its peer endpoint. Owner only:
// household members, kid mode and the demo get 403 here and no peer endpoint at all (404).
//   GET    /api/remote-repair                          {given, held, plans, scopes, hours}
//   POST   /api/remote-repair/requests                 {link, problem, hours, scope, draft?} → {pass}  helped: ask a friend
//   DELETE /api/remote-repair/requests/:id             helped: drop a draft card (nothing was sent)
//   DELETE /api/remote-repair/passes/:id               either side: end the fix pass (the other side is told)
//   POST   /api/remote-repair/passes/:id/accept        {accept} helper: Accept / Decline
//   POST   /api/remote-repair/look                     {link} → {report, findings, problems, can}   helper
//   POST   /api/remote-repair/plans                    {link, steps, note?} → {plan}   helper
//   POST   /api/remote-repair/plans/:id/approve        {approve} helped: one OK for the plan ("within this pass")
//   POST   /api/remote-repair/plans/:id/steps/:n       {approve} helped: OK for one step
//   POST   /api/remote-repair/plans/:id/steps/:n/undo  helped
//   POST   /api/remote-repair/plans/:id/stop           either side
// Peer: POST /msg/v1/repair/{request|accept|decline|revoke|look|plan|stop|status}, signed with scope 'repair'.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { audit } from '../audit-trail.ts';
import { HttpError, readJson, send } from '../http.ts';
import { remoteRepairOf, REPAIR_SCOPES } from '../remote-repair.ts';
import { SUPPORT_HOURS, supportFindings, SupportError } from '../support.ts';
import { readPeerBody, supportReport } from './support.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

function http(err: unknown): never {
  if (err instanceof SupportError) throw new HttpError(err.status, err.message);
  throw err;
}

export function createRemoteRepairRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d, e, f] = parts;
    if (a !== 'remote-repair') return NEXT;
    const rr = ctx.opts.demo || ctx.opts.member ? undefined : remoteRepairOf(app);
    if (!rr) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 64 * 1024);
    try {
      if (!b && method === 'GET') return send(res, 200, { given: rr.passes('given'), held: rr.passes('held'), plans: rr.plans(), scopes: REPAIR_SCOPES, hours: SUPPORT_HOURS });
      if (b === 'requests' && !c && method === 'POST') return send(res, 200, { pass: await rr.request(String(body.link ?? ''), body) });
      if (b === 'requests' && c && method === 'DELETE') return (rr.discardDraft(c), send(res, 200, { ok: true }));
      if (b === 'passes' && c && !d && method === 'DELETE') return (await rr.revoke(c), send(res, 200, { ok: true }));
      if (b === 'passes' && c && d === 'accept' && method === 'POST') return send(res, 200, { pass: await rr.answer(c, body.accept === true) });
      if (b === 'look' && method === 'POST') {
        const link = String(body.link ?? '');
        const peer = rr.support.peer(link);
        const pass = rr.activePass(link, 'held');
        if (!pass) throw new SupportError(403, 'You need a valid fix pass first.');
        const r = await rr.support.call(link, 'look', {}, 'repair');
        rr.markAsked(pass.id);
        rr.support.log(link, peer.name, 'helper', 'repair-look');
        const report = (r.report ?? {}) as Record<string, unknown>;
        return send(res, 200, { peer: peer.name, scope: pass.scope, report, findings: supportFindings(report), problems: r.problems ?? [], can: r.can ?? {} });
      }
      if (b === 'plans' && !c && method === 'POST') return send(res, 200, { plan: await rr.send(String(body.link ?? ''), body.steps, body.note) });
      if (b === 'plans' && c && d === 'approve' && method === 'POST') return send(res, 200, { plan: await rr.approvePlan(c, body.approve === true) });
      if (b === 'plans' && c && d === 'stop' && method === 'POST') return send(res, 200, { plan: await rr.stop(c) });
      if (b === 'plans' && c && d === 'steps' && e && !f && method === 'POST') return send(res, 200, { plan: await rr.decideStep(c, Number(e), body.approve === true) });
      if (b === 'plans' && c && d === 'steps' && e && f === 'undo' && method === 'POST') return send(res, 200, { plan: await rr.undoStep(c, Number(e)) });
    } catch (err) {
      http(err);
    }
    throw new HttpError(404, 'Not found');
  };
}

const OPS = ['request', 'accept', 'decline', 'revoke', 'look', 'plan', 'stop', 'status'];

/** POST /msg/v1/repair/<op> from the other linked server (mounted in server.ts for the owner only). */
export async function handleRepairPeer(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const rr = remoteRepairOf(ctx.app);
  if (!rr) return reply(404, { error: 'not found' });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const op = path.slice('/msg/v1/repair/'.length);
  if (!OPS.includes(op)) return reply(404, { error: 'not found' });
  let raw = '';
  try {
    raw = await readPeerBody(req);
  } catch {
    return reply(413, { error: 'too big' });
  }
  const who = (name: string) => `link:${name}`.slice(0, 80);
  try {
    const { linkId, name } = rr.support.verify(req.headers, op, raw, 'repair');
    const b = JSON.parse(raw) as Record<string, unknown>;
    if (op === 'request') return (rr.heldRequest(linkId, name, b), reply(200, { ok: true }));
    if (op === 'accept' || op === 'decline') return (rr.answered(linkId, name, b, op === 'accept'), reply(200, { ok: true }));
    if (op === 'revoke') return (rr.heldRevoked(linkId, name, b), reply(200, { ok: true }));
    if (op === 'status') return (rr.statusIn(linkId, name, b), reply(200, { ok: true }));
    // look, plan and stop need a fix pass this owner gave on this link, accepted and still valid.
    if (rr.deps.privateLocal()) {
      audit({ action: `remote-repair.${op}`, who: who(name), role: 'system', channel: 'repair-link', outcome: 'refused' });
      return reply(403, { error: 'Private local mode is on there, so fix passes are paused.' });
    }
    if (!rr.activePass(linkId, 'given')) {
      audit({ action: `remote-repair.${op}`, who: who(name), role: 'system', channel: 'repair-link', outcome: 'refused' });
      return reply(403, { error: 'no valid pass' });
    }
    if (op === 'stop') return (await rr.stopFromPeer(linkId, name, b), reply(200, { ok: true }));
    if (op === 'look') {
      const report = await supportReport(ctx);
      const problems = await rr.problems();
      rr.support.log(linkId, name, 'helped', 'repair-look');
      audit({ action: 'remote-repair.look', who: who(name), role: 'system', channel: 'repair-link', outcome: 'ok' });
      rr.support.onChange?.(linkId);
      return reply(200, { report, problems, can: rr.can() });
    }
    const plan = await rr.received(linkId, name, b);
    return reply(200, { id: plan.id, status: plan.status, steps: plan.steps });
  } catch (err) {
    if (err instanceof SupportError) {
      if (op === 'plan' && err.status === 400) audit({ action: 'remote-repair.plan', who: 'link', role: 'system', channel: 'repair-link', outcome: 'refused', content: err.message });
      return reply(err.status, { error: err.message });
    }
    return reply(400, { error: 'bad request' });
  }
}
