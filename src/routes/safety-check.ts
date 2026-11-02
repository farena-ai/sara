// Phase 121 part B (docs/design/BEGIN.md §5.13): the safety check-up. The owner's only: never on
// the demo, never in a member's space (the household gate answers members 403 ownerOnly, the family
// is OWNER_ONLY in test/household-isolation.test.ts); nothing here calls a model.
//   GET  /api/safety-check            runs the checks → {verdict, title, words, fine, total, checks, fixes: recent}
//   POST /api/safety-check/fix        {check, fix, current?, items?} → {ok, check, fixId, undo, token?}; 400 guided / no token, 403 wrong token, 409 already fine, 422 the gate refused
//   POST /api/safety-check/undo       {fixId} → {ok}; 409 changed since / can't be undone / 30 days passed
//   POST /api/safety-check/accept     {check, accept} (amber only; 400 for red)
//   GET  /api/safety-check/today      {line} when the last run has a red row (Today's *Needs you*)
import { HttpError, readJson, send } from '../http.ts';
import { acceptCheck, applyFix, runSafetyCheck, SafetyError, safetyLogFor, type SafetyDeps, sweepUndo, todaySafetyLine, undoFix } from '../safety-check.ts';
import type { AppContext } from '../chat.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** The check-up's view of this server (also used by her safety_report tool and the weekly check). */
export function safetyDepsOf(ctx: Pick<RouteCtx, 'app' | 'auth' | 'rootDir' | 'updater' | 'info' | 'opts'>): SafetyDeps {
  const { app } = ctx;
  return {
    app,
    auth: ctx.auth,
    dataDir: ctx.rootDir,
    ...(app.sandbox ? { sandbox: app.sandbox } : {}),
    updateStatus: () => {
      try {
        return ctx.updater.status() as { state?: string; latest?: string; changes?: string[] };
      } catch {
        return undefined;
      }
    },
    companions: () => (app.companions?.all().map((c) => c.app) ?? [app]) as AppContext[],
    members: () => ctx.opts.household?.store.members().filter((m) => m.status !== 'leaving').length ?? 0,
    version: ctx.info.version,
  };
}

export function createSafetyCheckRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  // Her read-only tool and the weekly check use the same view (set once per server).
  (app as AppContext & { safetyDeps?: () => SafetyDeps }).safetyDeps = () => safetyDepsOf(ctx);
  const wrap = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof SafetyError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'safety-check') return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (c) throw new HttpError(404, 'Not found');
    const deps = safetyDepsOf(ctx);
    if (!b && method === 'GET') {
      sweepUndo(app);
      const r = await runSafetyCheck(deps, 'page');
      const recent = safetyLogFor(app).recent(10).filter((f) => f.undoOf === null).map((f) => ({ id: f.id, at: f.at, check: f.checkId, fix: f.fixId, undo: f.undo, undoUntil: f.undoUntil, undone: Boolean(f.undoneAt), canUndo: f.undo !== 'none' && !f.undoneAt && !(f.undoUntil && Date.parse(f.undoUntil) <= app.now().getTime()) }));
      return send(res, 200, { ...r, fixes: recent, weekly: app.settings.get().safetyCheck?.weekly === true });
    }
    if (b === 'today' && method === 'GET') return send(res, 200, { line: todaySafetyLine(app) });
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = await readJson(req);
    if (b === 'fix') {
      const r = await wrap(() => applyFix(deps, String(body.check ?? ''), String(body.fix ?? ''), { current: body.current, items: body.items }));
      return send(res, 200, r);
    }
    if (b === 'undo') return send(res, 200, await wrap(() => undoFix(deps, Number(body.fixId))));
    if (b === 'accept') {
      await wrap(() => acceptCheck(deps, String(body.check ?? ''), body.accept !== false));
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
