// EC6 (docs/ops/EC6_DESIGN.md): research runs, the owner's only. Household members, the demo and
// anyone else get 403. Every POST/PUT/DELETE here writes one audit row through the HTTP hook.
//   GET    /api/research                     {runs, ready, why, limits}
//   POST   /api/research                     {question} → {run} (status planning → plan)
//   GET    /api/research/:id                 {run} (sources with their reason in his words)
//   PUT    /api/research/:id/plan            {steps: [{question, searches}], pages} → {run}
//   POST   /api/research/:id/start           his approval of the plan → {run}
//   POST   /api/research/:id/write-now       stop reading, write with what was read → {run}
//   POST   /api/research/:id/stop            stop; a report of what was found is still saved → {run}
//   POST   /api/research/:id/pause           3.1.2: pause after the current page → {run}
//   POST   /api/research/:id/resume          3.1.2: go on from the checkpoint → {run}
//   PUT    /api/research/:id/budget          3.1.2: {pages?, minutes?, tokens?} → {run}
//   POST   /api/research/:id/skill           3.1.2: {refresh?} Save as a skill / Keep it fresh → {run}
//   DELETE /api/research/:id                 forget the run (its Library document stays)
//   GET    /api/research/:id/export?format=md|docx|pdf
import { markdownToDocx, markdownToPdf } from '../doc-write.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { LearnError } from '../learn.ts';
import { RESEARCH, ResearchError, type Research, type ResearchRun } from '../research.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const TYPES = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

export function createResearchRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const view = (r: Research, run: ResearchRun) => {
    const topic = run.topicId ? app.learnTopics?.get(run.topicId) : undefined;
    return {
      ...run,
      sources: run.sources.map((s) => ({ ...s, reasonText: s.status !== 'read' ? r.reasonText(s) : '' })),
      // 3.1.2: the counts the run card shows, and whether the report is partial.
      counts: { read: run.sources.filter((s) => s.status === 'read').length, blocked: run.sources.filter((s) => s.status === 'blocked').length, notFound: run.sources.filter((s) => s.reason === 'not-found').length, failed: run.sources.filter((s) => s.status === 'failed' && s.reason !== 'not-found').length },
      partial: run.cut !== null && run.report !== null,
      topic: topic ? { id: topic.id, status: topic.status, refresh: topic.refresh, skill: topic.skill, partial: topic.partial } : null,
    };
  };
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof ResearchError) throw new HttpError(err.status, err.message);
      if (err instanceof LearnError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'research') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.research) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const r = app.research;
    if (!b) {
      if (method === 'GET') {
        const why = r.refusal();
        return send(res, 200, { runs: r.list().map((x) => ({ ...view(r, x), report: null })), ready: !why, why, limits: { pageChoices: RESEARCH.pageChoices, defaultPages: RESEARCH.defaultPages, maxSteps: RESEARCH.maxSteps, maxSearches: RESEARCH.maxSearches, budgetPages: RESEARCH.budgetPages, budgetMinutes: RESEARCH.budgetMinutes, budgetTokens: RESEARCH.budgetTokens }, model: r.modelChoice() });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { run: view(r, wrap(() => r.create(body as { question?: unknown }))) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || !r.get(id)) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (!c) {
      if (method === 'GET') return send(res, 200, { run: view(r, r.get(id)!) });
      if (method === 'DELETE') return send(res, 200, { ok: wrap(() => r.delete(id)) });
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'plan' && method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, { run: view(r, wrap(() => r.editPlan(id, body))) });
    }
    if ((c === 'start' || c === 'write-now' || c === 'stop' || c === 'pause' || c === 'resume') && method === 'POST') {
      await readJson(req).catch(() => ({}));
      const run = wrap(() => (c === 'start' ? r.start(id) : c === 'write-now' ? r.writeNow(id) : c === 'pause' ? r.pause(id) : c === 'resume' ? r.resume(id) : r.stop(id)));
      return send(res, 200, { run: view(r, run) });
    }
    if (c === 'budget' && method === 'PUT') {
      const body = (await readJson(req)) as { pages?: unknown; minutes?: unknown; tokens?: unknown };
      return send(res, 200, { run: view(r, wrap(() => r.setBudget(id, body ?? {}))) });
    }
    if (c === 'skill' && method === 'POST') {
      const body = (await readJson(req).catch(() => ({}))) as { refresh?: unknown };
      return send(res, 200, { run: view(r, wrap(() => r.saveAsSkill(id, body?.refresh ?? 'never'))) });
    }
    if (c === 'export' && method === 'GET') {
      const format = new URL(req.url ?? '/', 'http://x').searchParams.get('format') ?? 'md';
      if (format !== 'md' && format !== 'docx' && format !== 'pdf') throw new HttpError(400, 'Pick Markdown, Word or PDF.');
      const run = r.get(id)!;
      if (!run.report) throw new HttpError(409, 'The report isn’t written yet.');
      const bytes = format === 'md' ? Buffer.from(run.report, 'utf8') : format === 'docx' ? markdownToDocx(run.report, run.question) : markdownToPdf(run.report, run.question);
      const name = `Research - ${run.question.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 120)}.${format}`;
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, { 'content-type': TYPES[format], 'content-length': bytes.length, 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(bytes);
      return;
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
