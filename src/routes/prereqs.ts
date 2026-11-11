// PRQ (docs/ops/PRQ_DESIGN.md): the programs add-ons need, and *Install it for me*. Owner only:
// the demo, household members and apps signed in with a device code (DEVICE_TOKEN_DENIED) are
// refused; the business profile does not mount these routes.
//   GET  /api/prereqs?ids=chrome,uv            found or not, and what Sara would do here
//   POST /api/prereqs/:id/plan                 the approval card (exact commands; nothing runs)
//   POST /api/prereqs/plans/:plan/approve      run it → the job
//   GET  /api/prereqs/jobs/:job                progress, then the re-check
//   POST /api/prereqs/jobs/:job/stop           Stop
//   GET|PUT /api/prereqs/settings              { installs: allowed | ask | off }
//   GET  /api/prereqs/browser                  Sara's own browser (src/browser-setup.ts): ready, downloading…
//   POST /api/prereqs/browser                  get it now / Try again
import { join } from 'node:path';
import { audit } from '../audit-trail.ts';
import { browserSetup, isPlaywrightMcp } from '../browser-setup.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { policy } from '../policy-profile.ts';
import { isProgramId, programFor, type ProgramId } from '../prereqs/catalog.ts';
import { addToPath, INSTALLS, PrereqRefused, PrereqService, prereqOverrides, type InstallsSetting } from '../prereqs/service.ts';
import type { AppContext } from '../chat.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const services = new WeakMap<AppContext, PrereqService>();
/** One service per server (the store card uses it too). */
export function prereqService(app: AppContext): PrereqService {
  let s = services.get(app);
  if (!s) {
    s = new PrereqService({
      tmpRoot: join(app.dataDir, 'cache', 'prereqs'),
      setting: () => (app.settings.get() as { prereqs?: { installs?: InstallsSetting } }).prereqs?.installs,
      addPath: addToPath,
      ...prereqOverrides(),
    });
    services.set(app, s);
  }
  return s;
}

/** Tests: a service with a fake computer and runner. */
export function usePrereqService(app: AppContext, svc: PrereqService): void {
  services.set(app, svc);
}

/** The service's refusals in the app's words (translated in the page). */
function said(err: unknown): never {
  if (!(err instanceof PrereqRefused)) throw err;
  const words: Record<string, string> = {
    unknown: en('Sara does not know that program.'),
    policy: en('Program installs are off on this server.'),
    installed: en('It is already on this computer.'),
    expired: en('That card has expired. Press Install it for me again.'),
    private: en('Private local mode is on: installing a program needs the internet. Turn Nothing leaves this computer off for the install, then on again.'),
    busy: en('Another program is being installed. Wait for it or stop it.'),
  };
  throw new HttpError(err.status, words[err.code] ?? err.message, { code: err.code });
}

/**
 * Which of the owner's add-ons need each program (Settings → Other programs only warns about those).
 * The Browser add-on's Chrome is not counted: Sara gets its browser herself.
 */
export function neededBy(app: AppContext): Map<ProgramId, string[]> {
  const out = new Map<ProgramId, string[]>();
  const rows = app.storeInstalls?.all().filter((r) => r.kind === 'mcp') ?? [];
  for (const s of app.settings.get().mcpServers ?? []) {
    const row = rows.find((r) => r.local_ref === s.name);
    let needs: string[] = [];
    try {
      needs = row?.recipe ? ((JSON.parse(row.recipe) as { needs?: string[] }).needs ?? []) : [];
    } catch {
      needs = [];
    }
    const own = isPlaywrightMcp(s) && browserSetup() !== undefined;
    for (const tok of [s.command ?? '', ...needs]) {
      const id = tok ? programFor(tok) : undefined;
      if (!id || (own && id === 'chrome')) continue;
      const list = out.get(id) ?? [];
      if (!list.includes(s.name)) list.push(s.name);
      out.set(id, list);
    }
  }
  return out;
}

export function createPrereqRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'prereqs') return NEXT;
    if (opts.demo || app.demo || opts.member || app.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    const svc = prereqService(app);
    const settings = () => ({ installs: svc.setting(), own: (app.settings.get() as { prereqs?: { installs?: InstallsSetting } }).prereqs?.installs ?? 'ask', pinned: policy().pinned('programInstalls') });
    if (!b && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('ids');
      const ids = q ? q.split(',').filter(isProgramId) : undefined;
      const need = neededBy(app);
      return send(res, 200, { programs: svc.status(ids as ProgramId[] | undefined).map((p) => ({ ...p, neededBy: need.get(p.id) ?? [] })), ...settings() });
    }
    if (b === 'browser' && !c) {
      const bs = browserSetup();
      if (!bs) throw new HttpError(404, 'Not available');
      if (method === 'GET') return send(res, 200, { browser: bs.status() });
      if (method === 'POST') {
        await readJson(req).catch(() => undefined);
        const st = bs.ensure({ force: true });
        audit({ action: 'prereq.browser', target: 'browser', who: 'owner', role: 'owner', channel: 'web', outcome: 'ok', keys: [st.state] });
        return send(res, 200, { browser: st });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'settings' && !c) {
      if (method === 'GET') return send(res, 200, settings());
      if (method === 'PUT') {
        const body = await readJson(req);
        const v = body.installs;
        if (!INSTALLS.includes(v as InstallsSetting)) throw new HttpError(400, en('Pick allowed, ask or off.'));
        const rank = { allowed: 0, ask: 1, off: 2 } as const;
        const pin = policy().pins.programInstalls;
        policy().guard('programInstalls', Boolean(pin) && rank[v as InstallsSetting] < rank[pin!]);
        app.settings.update({ prereqs: { installs: v as InstallsSetting } } as never);
        return send(res, 200, settings());
      }
      throw new HttpError(405, 'Method not allowed');
    }
    try {
      if (b && c === 'plan' && !d && method === 'POST') {
        await readJson(req).catch(() => undefined);
        const card = svc.propose(b);
        // Allowed: the one click runs the card's plan (the progress view still shows every command).
        if ('id' in card && svc.setting() === 'allowed' && !card.privateLocal) return send(res, 200, { card, job: svc.approve(card.id) });
        return send(res, 200, { card });
      }
      if (b === 'plans' && c && d === 'approve' && method === 'POST') {
        await readJson(req).catch(() => undefined);
        return send(res, 200, { job: svc.approve(c) });
      }
      if (b === 'jobs' && c) {
        if (!d && method === 'GET') {
          const j = svc.job(c);
          if (!j) throw new HttpError(404, 'Not found');
          return send(res, 200, { job: j });
        }
        if (d === 'stop' && method === 'POST') {
          await readJson(req).catch(() => undefined);
          const j = svc.stop(c);
          if (!j) throw new HttpError(404, 'Not found');
          return send(res, 200, { job: j });
        }
      }
    } catch (err) {
      said(err);
    }
    if (method !== 'GET') await readJson(req).catch(() => undefined);
    throw new HttpError(404, 'Not found');
  };
}
