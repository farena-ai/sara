// S4 (docs/PEOPLE.md "Keeping in touch"): the People page's relationship routes, under /api/people
// (same owner/member rules as the cards: each person's own space, never /v1, MCP or A2A).
//   GET  /people/attention             → { on, items, scannedAt }   (needs attention, most urgent first)
//   PUT  /people/attention {key, action: done|later|dismiss}
//   POST /people/scan                  → reads mail headers, calendars and rooms now
//   PUT  /people/ties-on {on}
//   GET  /people/promises?status=      POST /people/promises {personId, text, due}
//   PUT  /people/promises/:id {action: confirm|done|dismiss|reopen, due?}
//   PUT  /people/:id/ties {emails, keepDays, dates}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import type { PeopleTies } from '../people-ties.ts';
import type { RouteCtx } from './context.ts';

/** Returns true when it answered. */
export async function peopleTiesRoute(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<boolean> {
  const [, b, c] = parts;
  const app = ctx.app;
  const ties: PeopleTies | undefined = app.peopleTies;
  const known = b === 'attention' || b === 'scan' || b === 'ties-on' || b === 'promises' || c === 'ties';
  if (!known) return false;
  if (!ties) throw new HttpError(404, 'Keeping in touch is not available here.');
  const changed = () => {
    app.events?.publish({ type: 'people', what: 'ties' });
    app.events?.publish({ type: 'today', part: 'people' });
  };
  const ok = (status: number, body: unknown): true => {
    send(res, status, body);
    return true;
  };
  const view = () => ({ on: ties.on(), items: ties.attention(), scannedAt: (app.store.db.prepare("SELECT value FROM memory_kv WHERE key = 'ties:scanned'").get() as { value?: string } | undefined)?.value ?? null });
  if (b === 'attention' && !c) {
    if (method === 'GET') return ok(200, view());
    if (method === 'PUT') {
      const body = await readJson(req);
      const action = String(body.action);
      if (!['done', 'later', 'dismiss'].includes(action) || !ties.act(String(body.key ?? ''), action as 'done')) throw new HttpError(400, 'Bad request');
      changed();
      return ok(200, view());
    }
  }
  if (b === 'scan' && !c && method === 'POST') {
    await ties.scan();
    changed();
    return ok(200, view());
  }
  if (b === 'ties-on' && !c && method === 'PUT') {
    const body = await readJson(req);
    ties.setOn(body.on !== false);
    changed();
    return ok(200, view());
  }
  if (b === 'promises') {
    const people = app.people!;
    if (!c && method === 'GET') {
      const st = new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 'active';
      return ok(200, { promises: ties.promises({ status: (['active', 'open', 'proposed', 'done', 'all'].includes(st) ? st : 'active') as 'active' }).map((p) => ({ ...p, name: people.get(p.personId)?.name ?? '' })) });
    }
    if (!c && method === 'POST') {
      const body = await readJson(req);
      const pid = Number(body.personId);
      const p = Number.isInteger(pid) ? people.get(pid) : undefined;
      if (!p || p.status !== 'active') throw new HttpError(404, 'Person not found');
      const made = ties.addPromise(pid, { text: String(body.text ?? ''), due: typeof body.due === 'string' ? body.due : null });
      if (!made) throw new HttpError(400, 'Write what you promised (3 characters or more).');
      changed();
      return ok(201, made);
    }
    if (c && method === 'PUT') {
      const body = await readJson(req);
      const action = String(body.action);
      if (!['confirm', 'done', 'dismiss', 'reopen'].includes(action)) throw new HttpError(400, 'Bad request');
      const r = ties.decidePromise(Number(c), action as 'confirm', body.due === undefined ? undefined : typeof body.due === 'string' ? body.due : null);
      if (!r) throw new HttpError(404, 'Promise not found');
      changed();
      return ok(200, r);
    }
  }
  if (c === 'ties' && method === 'PUT') {
    const id = Number(b);
    const p = Number.isInteger(id) ? app.people?.get(id) : undefined;
    if (!p || !['active', 'proposed'].includes(p.status)) throw new HttpError(404, 'Person not found');
    const body = await readJson(req);
    const patch: Parameters<PeopleTies['setTie']>[1] = {};
    if (Array.isArray(body.emails)) patch.emails = body.emails.map(String);
    if (body.keepDays !== undefined) patch.keepDays = body.keepDays === null ? null : Number(body.keepDays);
    if (Array.isArray(body.dates)) patch.dates = (body.dates as { label?: unknown; date?: unknown }[]).map((d) => ({ label: String(d?.label ?? ''), date: String(d?.date ?? '') }));
    ties.setTie(id, patch);
    changed();
    return ok(200, ties.summary(id));
  }
  throw new HttpError(405, 'Method not allowed');
}
