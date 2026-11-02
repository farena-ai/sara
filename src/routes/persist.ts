// Phase 118 (docs/design/PERSIST.md §4.16, §5.13): keep going until it's done (goals on a chat)
// and repeats (loops). The owner's only: never on the demo, never in a member's space (404), never
// for off-the-record, partner, group or other-app chats (400). /v1, MCP, A2A keys and webhooks
// never reach these routes. Nothing here starts work without the owner's Start.
//   GET    /api/conversations/:id/goal               the standing (or last) goal, its last check, the check options, the caps
//   POST   /api/conversations/:id/goal               { text, checks, caps?, start?, replace? }
//   POST   /api/conversations/:id/goal/<start|pause|resume|stop|retry>   resume: { more?: {rounds?, minutes?, tokens?, usd?} }
//   PUT    /api/conversations/:id/goal/check         { checks }
//   POST   /api/conversations/:id/goal/said          { done }
//   GET    /api/conversations/:id/goal/rounds        rounds with checks, files, spend, run ids
//   GET    /api/goals                                every running and paused goal (Today)
//   POST   /api/conversations/:id/loops/parse        { text } → the card and its estimate
//   POST   /api/conversations/:id/loops              { prompt, everyMin, until?, untilCheck?, forMin? | endsAt? | times?, quiet?, start? }
//   GET    /api/conversations/:id/loops · GET /api/loops
//   POST   /api/loops/:id/<start|pause|resume|stop|run-now>   resume: { allowOnce? }
//   PATCH  /api/loops/:id { everyMin?, endsAt?, quiet? } · DELETE /api/loops/:id · GET /api/loops/:id/ticks?limit=
//   GET    /api/persist · PUT /api/persist            Settings → Abilities → Keep going and repeats
import { goalsFor } from '../goals.ts';
import { HttpError, readJson, send } from '../http.ts';
import { loopsFor, parseLoopCommand } from '../loops.ts';
import { checkOptions, defaultChecks, mergePersist, persistRefusal, persistSettings, GOAL_CHOICES, LOOP_CHOICES, PERSIST_PRESETS, presetOf } from '../persist.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createPersistRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const out = (r: { status: number; error: string } | Record<string, unknown>) => {
    if ('error' in r && 'status' in r && typeof r.status === 'number') throw new HttpError(r.status, String(r.error));
    return r;
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    const goalPath = a === 'conversations' && b && (c === 'goal' || c === 'loops');
    if (!(goalPath || a === 'goals' || a === 'loops' || a === 'persist')) return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const goals = goalsFor(app);
    const loops = loopsFor(app);

    // ---------------------------------------------------------------- settings
    if (a === 'persist' && !b) {
      if (method === 'PUT') mergePersist(app, await readJson(req));
      else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const settings = persistSettings(app);
      return send(res, 200, { settings, choices: { goals: GOAL_CHOICES, loops: LOOP_CHOICES }, presets: PERSIST_PRESETS, preset: presetOf(settings), today: { loops: loops.ledger.get('loops') } });
    }
    if (a === 'goals' && !b && method === 'GET') return send(res, 200, { goals: goals.list().map((g) => ({ ...goals.view(g), conversationTitle: app.store.getConversation(g.conversationId)?.title ?? null })) });
    if (a === 'loops' && !b && method === 'GET') {
      const cutoff = app.now().getTime() - 30 * 86_400_000;
      return send(res, 200, { loops: loops.all().filter((l) => !l.endedAt || Date.parse(l.endedAt) > cutoff).map((l) => loops.view(l)), today: loops.ledger.get('loops'), settings: persistSettings(app).loops });
    }

    // ---------------------------------------------------------------- one loop
    if (a === 'loops' && b) {
      const id = Number(b);
      const l = loops.get(id);
      if (!l || ctx.ctxOf(l.conversationId) !== app) throw new HttpError(404, 'Repeat not found');
      if (!c && method === 'PATCH') return send(res, 200, { loop: loops.view((out(loops.patch(id, await readJson(req))) as { loop: typeof l }).loop) });
      if (!c && method === 'DELETE') {
        if (!loops.remove(id)) throw new HttpError(409, 'Only a draft or an ended repeat can be removed.');
        return send(res, 200, { ok: true });
      }
      if (c === 'ticks' && method === 'GET') {
        const lim = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 50;
        return send(res, 200, { ticks: loops.ticks(id, Math.min(500, Math.max(1, lim))) });
      }
      if (method === 'POST' && c && !d) {
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        if (c === 'start') return send(res, 200, { loop: loops.view((out(loops.start(id)) as { loop: typeof l }).loop) });
        if (c === 'pause') return send(res, 200, { loop: loops.view(loops.pause(id)) });
        if (c === 'resume') return send(res, 200, { loop: loops.view((out(loops.resume(id, { allowOnce: Boolean(body.allowOnce) })) as { loop: typeof l }).loop) });
        if (c === 'stop') return send(res, 200, { loop: loops.view(loops.stop(id)) });
        if (c === 'run-now') return send(res, 200, { loop: loops.view((out(loops.runNow(id)) as { loop: typeof l }).loop) });
      }
      throw new HttpError(404, 'Not found');
    }

    // ---------------------------------------------------------------- a conversation's goal and loops
    const cx = ctx.ctxOf(b!);
    const conv = cx.store.getConversation(b!);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    const refused = persistRefusal(app, conv, { offRecord: cx !== app });
    if (c === 'goal') {
      if (!d && method === 'GET') {
        const g = refused ? undefined : goals.current(conv.id);
        const options = refused ? [] : checkOptions(app, conv);
        const set = persistSettings(app).goals;
        return send(res, 200, { goal: goals.view(g), allowed: !refused, ...(refused ? { why: refused } : {}), checks: options, defaultChecks: defaultChecks(options), caps: { rounds: set.rounds, minutes: set.minutes, tokens: set.tokens, usd: set.usd }, choices: GOAL_CHOICES });
      }
      if (refused) {
        if (method !== 'GET') await readJson(req).catch(() => undefined);
        throw new HttpError(400, refused);
      }
      if (!d && method === 'POST') {
        const body = await readJson(req);
        const r = out(goals.create(conv.id, { text: body.text, checks: body.checks, caps: body.caps, start: Boolean(body.start), replace: Boolean(body.replace), source: 'web' })) as { goal: Parameters<typeof goals.view>[0] };
        return send(res, 201, { goal: goals.view(r.goal) });
      }
      if (d === 'rounds' && method === 'GET') {
        const g = goals.current(conv.id);
        return send(res, 200, { rounds: g ? goals.rounds(g.id) : [] });
      }
      const g = goals.current(conv.id);
      if (!g) {
        if (method !== 'GET') await readJson(req).catch(() => undefined);
        throw new HttpError(404, 'This chat has no goal.');
      }
      const body = method === 'GET' ? {} : await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (d === 'check' && method === 'PUT') return send(res, 200, { goal: goals.view((out(goals.setChecks(g.id, body.checks)) as { goal: typeof g }).goal) });
      if (method === 'POST') {
        if (d === 'start') return send(res, 200, { goal: goals.view((out(goals.start(g.id)) as { goal: typeof g }).goal) });
        if (d === 'pause') return send(res, 200, { goal: goals.view(goals.pause(g.id)) });
        if (d === 'resume') return send(res, 200, { goal: goals.view((out(goals.resume(g.id, (body.more ?? {}) as never)) as { goal: typeof g }).goal) });
        if (d === 'stop') return send(res, 200, { goal: goals.view(goals.stop(g.id)) });
        if (d === 'retry') return send(res, 201, { goal: goals.view((out(goals.retry(g.id)) as { goal: typeof g }).goal) });
        if (d === 'said') return send(res, 200, { goal: goals.view((out(goals.said(g.id, Boolean(body.done))) as { goal: typeof g }).goal) });
      }
      throw new HttpError(404, 'Not found');
    }
    // loops
    if (!d && method === 'GET') return send(res, 200, { loops: refused ? [] : loops.forConversation(conv.id).map((l) => loops.view(l)), allowed: !refused, settings: persistSettings(app).loops });
    if (refused) {
      await readJson(req).catch(() => undefined);
      throw new HttpError(400, refused);
    }
    const body = await readJson(req);
    if (d === 'parse' && method === 'POST') {
      const p = parseLoopCommand(String(body.text ?? '').replace(/^\/loop\s*/i, ''));
      if (p.sub !== 'set') throw new HttpError(400, p.sub === 'error' ? p.error : 'Say /loop every 10m: what to do.');
      const pl = loops.plan(p.spec);
      if (!pl.ok) throw new HttpError(400, pl.error);
      return send(res, 200, { card: pl.card });
    }
    if (!d && method === 'POST') {
      const untilCommand = typeof body.untilCheck === 'string' ? body.untilCheck : (body.untilCheck as { command?: string } | undefined)?.command;
      const r = out(loops.create(conv.id, {
        prompt: String(body.prompt ?? ''),
        everyMin: Number(body.everyMin),
        ...(body.forMin !== undefined ? { forMin: Number(body.forMin) } : {}),
        ...(body.times !== undefined ? { times: Number(body.times) } : {}),
        ...(typeof body.endsAt === 'string' && /^\d{1,2}:\d{2}$/.test(body.endsAt) ? { endsAtLocal: body.endsAt } : {}),
        ...(typeof body.until === 'string' && body.until.trim() ? { untilText: body.until.trim().slice(0, 300) } : {}),
        ...(untilCommand ? { untilCommand: untilCommand.slice(0, 400), untilText: (typeof body.until === 'string' && body.until.trim()) || untilCommand } : {}),
        quiet: body.quiet,
        start: Boolean(body.start),
        source: 'web',
      })) as { loop: Parameters<typeof loops.view>[0] };
      return send(res, 201, { loop: loops.view(r.loop) });
    }
    throw new HttpError(404, 'Not found');
  };
}
