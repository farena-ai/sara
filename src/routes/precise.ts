// Phase 120 (docs/design/PRECISE.md §4.16, §5.12): checks after her edits and @-references. The
// owner's only: the demo and a member's space get 404 (members have no workspaces; their composer's
// @ menu never opens). /v1, MCP, A2A keys and webhooks never reach these routes.
//   GET  /api/precise · PUT /api/precise                 Settings → Abilities → Check her edits
//   GET  /api/workspaces/:ws/checks                      per project: checkers, the choice, the last runs
//   PUT  /api/workspaces/:ws/checks                      { project, state?, checkers?, confirm? }
//   POST /api/workspaces/:ws/checks/run                  { project }: a full check now (409 while one runs)
//   GET  /api/workspaces/:ws/problems?project=&file=     the latest diagnostics (≤ 500)
//   POST /api/conversations/:id/checks/answer            the first-time card: { project, answer: on | later | never }
//   GET  /api/conversations/:id/refs/complete?kind=&q=   ≤ 20 suggestions (file, folder, branch)
//   POST /api/conversations/:id/refs/preview             { content } → sizes only (never an @url body)
//   GET  /api/conversations/:id/refs?message=ID          what one message's references attached ("What she got")
import { detectCheckers, fullCheck, latestProblems, mergePrecise, preciseSettings, projectsOf, setProjectChecks, workspaceChecks, checksDb, PRECISE_CHOICES } from '../diagnostics.ts';
import { HttpError, readJson, send } from '../http.ts';
import { wsOf } from '../persist.ts';
import { completeRefs, previewRefs, refsPlace, refStore } from '../refs.ts';
import { workspaceDir, WORKSPACE_NAME_RE } from '../tools/workspace.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const running = new Set<string>();

export function createPreciseRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    const convPath = a === 'conversations' && b && ((c === 'checks' && d === 'answer') || c === 'refs');
    const wsPath = a === 'workspaces' && b && (c === 'checks' || c === 'problems');
    if (!(a === 'precise' || convPath || wsPath)) return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (a === 'precise' && !b) {
      if (method === 'PUT') mergePrecise(app, await readJson(req));
      else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { settings: preciseSettings(app), choices: PRECISE_CHOICES });
    }
    if (wsPath) {
      if (!WORKSPACE_NAME_RE.test(b)) throw new HttpError(400, 'Invalid workspace name');
      const ws = workspaceDir(ctx.rootDir, b);
      if (c === 'checks' && !d && method === 'GET') return send(res, 200, { projects: workspaceChecks(app, b, ws), settings: preciseSettings(app).checks });
      if (c === 'checks' && !d && method === 'PUT') {
        const r = setProjectChecks(app, b, ws, await readJson(req));
        if (!r.ok) throw new HttpError(r.status, r.error);
        return send(res, 200, { choice: r.choice, projects: workspaceChecks(app, b, ws) });
      }
      if (c === 'checks' && d === 'run' && method === 'POST') {
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const project = projectsOf(ws).find((p) => p.path === String(body.project ?? '.'));
        if (!project) throw new HttpError(404, 'No such project in this workspace.');
        const key = `${b}|${project.path}`;
        if (running.has(key)) throw new HttpError(409, 'A check is already running here.');
        running.add(key);
        try {
          const ch = checksDb(app).choice(b, project.path);
          const list = detectCheckers(project.dir).filter((k) => k.installed && (ch.state !== 'on' || ch.checkers.includes(k.id)));
          const runs = await fullCheck(app, b, ws, project, AbortSignal.timeout(preciseSettings(app).checks.timeoutS * 1000 * Math.max(1, list.length) + 5000), { checkers: list });
          return send(res, 200, { runs: runs.map((r) => ({ checker: r.checker.id, state: r.state, ms: r.ms, errors: r.diags.filter((x) => x.severity === 'error').length, note: r.note ?? null })), projects: workspaceChecks(app, b, ws) });
        } finally {
          running.delete(key);
        }
      }
      if (c === 'problems' && method === 'GET') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams;
        const project = q.get('project') ?? projectsOf(ws)[0]?.path ?? '.';
        const p = latestProblems(app, b, project, q.get('file') || undefined);
        const counts: Record<string, number> = {};
        for (const x of p.diags) counts[x.file] = (counts[x.file] ?? 0) + 1;
        return send(res, 200, { project, checked: p.checked, at: p.at ?? null, checkers: p.checkers, problems: p.diags.slice(0, 500), total: p.diags.length, counts });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    // Conversation routes: the conversation's own companion; partner chats, groups and other apps get 404.
    const cx = ctx.ctxOf(b);
    const conv = cx.store.getConversation(b);
    if (!conv || conv.partner) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Conversation not found');
    }
    if (c === 'checks' && d === 'answer' && method === 'POST') {
      const body = await readJson(req);
      const ws = wsOf(cx, conv);
      const project = String(body.project ?? '.');
      const answer = String(body.answer ?? '');
      const db = checksDb(cx);
      const cur = db.choice(conv.workspace || 'main', project);
      if (answer === 'later') {
        db.setChoice({ ...cur, state: 'ask', askedAt: cx.now().toISOString() });
        return send(res, 200, { choice: db.choice(conv.workspace || 'main', project) });
      }
      if (answer !== 'on' && answer !== 'never') throw new HttpError(400, 'Answer on, later or never.');
      // The card named exactly which checkers run project code: tapping its button is the confirm.
      const r = setProjectChecks(cx, conv.workspace || 'main', ws, { project, state: answer === 'on' ? 'on' : 'off', confirm: true });
      if (!r.ok) throw new HttpError(r.status, r.error);
      // The first OK runs a full check, so her next edit has something to compare with (§4.5).
      if (answer === 'on') {
        const p = projectsOf(ws).find((x) => x.path === project);
        if (p) void fullCheck(cx, conv.workspace || 'main', ws, p, AbortSignal.timeout(600_000)).catch(() => undefined);
      }
      return send(res, 200, { choice: r.choice });
    }
    if (c === 'refs') {
      const place = refsPlace(cx, conv, { owner: true });
      if (d === 'complete' && method === 'GET') {
        const q = new URL(req.url ?? '/', 'http://x').searchParams;
        if (!place?.workspace) return send(res, 200, { items: [] });
        return send(res, 200, { items: completeRefs(cx, conv, q.get('kind') ?? 'file', (q.get('q') ?? '').slice(0, 200)) });
      }
      if (d === 'preview' && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { items: await previewRefs(cx, conv, String(body.content ?? '').slice(0, 100_000), place), place: place ? { workspace: place.workspace, url: place.url } : null });
      }
      if (!d && method === 'GET') {
        const id = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('message'));
        const m = cx.store.messageById(id);
        if (!m || m.conversationId !== conv.id) throw new HttpError(404, 'Message not found');
        return send(res, 200, { refs: refStore(cx).rows(id).map((r) => ({ kind: r.kind, token: r.token, target: r.target, from: r.from, to: r.to, status: r.status, reason: r.reason, header: r.header, text: r.text, chars: r.chars })) });
      }
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
