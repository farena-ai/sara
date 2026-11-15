// R1 (c): "Check everything" (Settings → Data & health → Health). Owner only.
//   POST /api/self-test {draft?, event?, push?}   → {lines: SelfTestLine[], report: string}
// The consent flags allow the checks that write something (a draft, a test event, a notification);
// each is removed again (the notification just shows). src/self-test.ts has the checks.
import { appInstallView, AppInstalls } from '../app-installs.ts';
import { autoOn, modelStats } from '../auto-route.ts';
import { resolveChain } from '../chat.ts';
import { HttpError, readJson, send } from '../http.ts';
import { formatSelfTest, runSelfTest, type SelfTestDeps } from '../self-test.ts';
import type { Conversation } from '../store.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function selfTestDepsOf(ctx: RouteCtx): SelfTestDeps {
  const { app } = ctx;
  const s = () => app.settings.get();
  return {
    now: () => app.now(),
    timeZone: s().timeZone ?? 'UTC',
    ...(app.mailAccounts ? { mail: app.mailAccounts } : {}),
    ...(app.google ? { google: app.google } : {}),
    ...(app.push ? { push: app.push } : {}),
    ...(app.hands ? { hands: app.hands } : {}),
    serverVersion: ctx.info?.version ?? '',
    apps: () => Object.entries(new AppInstalls(ctx.rootDir, () => app.now()).read().apps).map(([id, a]) => appInstallView(id, a, ctx.info?.version ?? '')),
    ...(app.inbox ? { inbox: () => app.inbox!.status() } : {}),
    lastAutomation: () => {
      try {
        return app.store.db.prepare('SELECT a.name AS name, r.at AS at, r.outcome AS outcome FROM automation_runs r JOIN automations a ON a.id = r.automation_id ORDER BY r.id DESC LIMIT 1').get() as { name: string; at: string; outcome: string } | undefined;
      } catch {
        return undefined;
      }
    },
    auto: () => {
      try {
        const conv = { id: '', channel: 'web', mode: 'chat', private: false } as unknown as Conversation;
        const [first] = resolveChain(app, conv, 'turn', false, true);
        if (!first) return undefined;
        const st = modelStats(app.store.db, app.now()).get(`${first.provider.config.id}/${first.model}`);
        const v = [...(st?.firstMs ?? [])].sort((a, b) => a - b);
        return { model: first.model, provider: first.provider.config.label, auto: first.from === 'auto' && autoOn(s(), 'chat'), ...(first.why ? { why: first.why } : {}), ...(v.length ? { firstMs: v[Math.floor(v.length / 2)]! } : {}) };
      } catch {
        return undefined;
      }
    },
  };
}

export function createSelfTestRoutes(ctx: RouteCtx): RouteHandler {
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'self-test') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || b) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = ((await readJson(req).catch(() => ({}))) ?? {}) as Record<string, unknown>;
    res.setHeader('cache-control', 'no-store');
    const lines = await runSelfTest(selfTestDepsOf(ctx), { draft: body.draft === true, event: body.event === true, push: body.push === true });
    return send(res, 200, { lines, report: formatSelfTest(lines, ctx.info?.version ?? '') });
  };
}
