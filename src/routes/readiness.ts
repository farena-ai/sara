// EC28 (docs/ops/EC1828_DESIGN.md): the readiness and recovery center. The owner's only: the demo
// and household members never reach it (the household gate answers members 403 ownerOnly), apps
// signed in with a device code get 403 (DEVICE_TOKEN_DENIED in src/server.ts).
//   GET  /api/readiness          {verdict, counts, areas[], drill: {running, last}}
//   POST /api/readiness/drill    202 {running: true}; 409 while one runs
//   POST /api/readiness/probe    lists the default provider's models again, then the report
import { audit } from '../audit-trail.ts';
import type { AppContext } from '../chat.ts';
import { HttpError, readJson, send } from '../http.ts';
import type { OperationsMonitor } from '../operations.ts';
import { gatherReadiness, probeModel, readinessReport, type ReadinessDeps } from '../readiness.ts';
import { type DrillRecord, runRestoreDrill } from '../restore-drill.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';
import { safetyDepsOf } from './safety-check.ts';

/** Chat-app pages of the plugin bridges (the rest open the Plugins page). */
const BRIDGE_PAGES: Record<string, string> = { slack: 'co-slack', teams: 'co-teams', whatsapp: 'co-whatsapp', signal: 'co-signal', matrix: 'co-matrix', imessage: 'co-imessage', email: 'co-email' };

/** One drill per data root at a time (a server's companions share the root). */
const running = new Map<string, Promise<DrillRecord>>();

export const drillRecord = (app: AppContext): DrillRecord | undefined => (app.settings.get() as { readiness?: { drill?: DrillRecord } }).readiness?.drill;

/** Starts a drill in the background; records it in settings and the audit trail when done. */
export function startDrill(app: AppContext, rootDir: string): Promise<DrillRecord> | undefined {
  if (running.has(rootDir)) return undefined;
  const p = runRestoreDrill({ rootDir, now: app.now() })
    .then((rec) => {
      app.settings.update({ readiness: { ...(app.settings.get() as { readiness?: object }).readiness, drill: rec } } as never);
      audit({ action: 'readiness.drill', who: 'system', role: 'system', channel: 'system', outcome: rec.ok ? 'ok' : 'failed', ...(rec.backup ? { target: rec.backup } : {}) });
      return rec;
    })
    .finally(() => running.delete(rootDir));
  running.set(rootDir, p);
  return p;
}

export function readinessDepsOf(ctx: RouteCtx, operations?: OperationsMonitor): ReadinessDeps {
  const { app } = ctx;
  return {
    app,
    rootDir: ctx.rootDir,
    safety: safetyDepsOf(ctx),
    ...(operations ? { operations } : {}),
    pluginBridges: () => {
      const pm = app.pluginManager;
      const id = app.companionId;
      if (!pm || !id) return [];
      return pm.store.all().flatMap((row) => {
        if (row.status !== 'installed' || !pm.enabledFor(row.id, id)) return [];
        const m = pm.manifestOf(row);
        return m.permissions.bridges.map((b) => ({ name: m.name, page: BRIDGE_PAGES[b] ?? 'ab-plugins', running: Boolean(pm.processOf(row.id, id)) }));
      });
    },
  };
}

export function createReadinessRoutes(ctx: RouteCtx, operations?: OperationsMonitor): RouteHandler {
  const { app } = ctx;
  const report = async (probe = true) => {
    const facts = await gatherReadiness(readinessDepsOf(ctx, operations), { probe });
    return { ...readinessReport(facts, app.now()), drill: { running: running.has(ctx.rootDir), last: drillRecord(app) ?? null } };
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'readiness') return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (c) throw new HttpError(404, 'Not found');
    res.setHeader('cache-control', 'no-store');
    if (!b && method === 'GET') return send(res, 200, await report());
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    await readJson(req).catch(() => undefined);
    if (b === 'drill') {
      if (!startDrill(app, ctx.rootDir)) throw new HttpError(409, 'A restore drill is already running.');
      return send(res, 202, { running: true });
    }
    if (b === 'probe') {
      await probeModel(app, { force: true });
      return send(res, 200, await report(false));
    }
    throw new HttpError(404, 'Not found');
  };
}
