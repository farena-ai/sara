// Model tests ("Test my models", docs/MODEL_TESTS.md): plan, start, status, stop, scores, details, apply.
// Owner only: 'model-tests' is not a member route (src/household.ts), and the demo cannot start runs.
import { HttpError, readJson, send } from '../http.ts';
import { ModelTests, ModelTestsBusy, type Scope, type TestRequest } from '../model-tests.ts';
import { ROUTE_PURPOSES, type RoutePurpose } from '../settings.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** Most models in one "models" scope (2 or 3 when one job is compared). */
export const MAX_SCOPE_MODELS = 20;

function jobsOf(raw: unknown): RoutePurpose[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, 'jobs must be a list.');
  const jobs = raw.map(String);
  const bad = jobs.find((j) => !ROUTE_PURPOSES.includes(j as RoutePurpose));
  if (bad) throw new HttpError(400, 'Unknown job "{job}"', { params: { job: bad } });
  return jobs as RoutePurpose[];
}

/** The body of plan and start, checked. */
export function parseTestRequest(body: Record<string, unknown>): TestRequest {
  const jobs = jobsOf(body.jobs);
  const s = (body.scope ?? {}) as { kind?: unknown; providerId?: unknown; models?: unknown };
  let scope: Scope;
  if (s.kind === 'all') scope = { kind: 'all' };
  else if (s.kind === 'provider') {
    const providerId = String(s.providerId ?? '');
    if (!providerId) throw new HttpError(400, 'Choose a provider first.');
    scope = { kind: 'provider', providerId };
  } else if (s.kind === 'models') {
    if (!Array.isArray(s.models)) throw new HttpError(400, 'Pick the models to test.');
    const models = s.models.map((m: { providerId?: unknown; model?: unknown }) => ({ providerId: String(m?.providerId ?? ''), model: String(m?.model ?? '').trim().slice(0, 200) })).filter((m) => m.providerId && m.model);
    if (jobs?.length === 1 && (models.length < 2 || models.length > 3)) throw new HttpError(400, 'Pick two or three models to compare.');
    if (!models.length) throw new HttpError(400, 'Pick the models to test.');
    if (models.length > MAX_SCOPE_MODELS) throw new HttpError(400, 'Pick at most {n} models.', { params: { n: MAX_SCOPE_MODELS } });
    scope = { kind: 'models', models };
  } else throw new HttpError(400, 'Say which models to test: all, one provider, or a few models.');
  return { scope, ...(jobs ? { jobs } : {}), includePaid: body.includePaid === true };
}

export function createModelTestsRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  const tests = (): ModelTests => (app.modelTests ??= new ModelTests(app));
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'model-tests' || c) return NEXT;
    if (opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    if (b === 'status' && method === 'GET') return send(res, 200, tests().status());
    if (b === 'scores' && method === 'GET') return send(res, 200, await tests().scores());
    if (b === 'details' && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const providerId = q.get('providerId') ?? '';
      const model = (q.get('model') ?? '').trim();
      const job = q.get('job') ?? '';
      if (!providerId || !model) throw new HttpError(400, 'Say which model and which job.');
      if (!ROUTE_PURPOSES.includes(job as RoutePurpose)) throw new HttpError(400, 'Unknown job "{job}"', { params: { job } });
      const d = tests().details({ providerId, model }, job as RoutePurpose);
      if (!d) throw new HttpError(404, 'This model has no results for that job yet.');
      return send(res, 200, d);
    }
    if (b === 'plan' && method === 'POST') return send(res, 200, await tests().plan(parseTestRequest(await readJson(req))));
    if (opts.demo && method !== 'GET') throw new HttpError(403, 'Not available in the demo.');
    if (b === 'start' && method === 'POST') {
      const request = parseTestRequest(await readJson(req));
      try {
        return send(res, 200, await tests().start(request));
      } catch (err) {
        if (err instanceof ModelTestsBusy) throw new HttpError(409, 'A model test is already running.');
        throw err;
      }
    }
    if (b === 'stop' && method === 'POST') {
      tests().stop();
      return send(res, 200, { ok: true });
    }
    if (b === 'apply' && method === 'POST') {
      const body = req.headers['content-type'] ? await readJson(req) : {};
      return send(res, 200, tests().apply(jobsOf(body.jobs)));
    }
    return NEXT;
  };
}
