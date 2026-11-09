// C13 (docs/ops/C13_DESIGN.md): coding depth, the owner's only (members and the demo are refused).
// - /api/worktrees: list (with status), start, and finish: merge, pr-draft, pr (push + open, the
//   owner's click is the OK), close (after a PR), discard (409 with what would be lost until
//   confirmed).
// - /api/coding-depth: the co-author setting and which language servers this computer has.
// - The Workspace view (project page → Workspace): /api/workspaces/:ws/tree, PUT …/file (save),
//   POST …/run (the terminal panel: her shell's permission, sandbox and network rules), GET
//   …/diagnostics (the language server's problems for the open file).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { coAuthorOf, mergeCoAuthor } from '../coding-depth.ts';
import { as400, HttpError, readJson, send, validWorkspace } from '../http.ts';
import { NoServer } from '../lsp.ts';
import { privateLocalOn } from '../net-guard.ts';
import { shq } from '../tools/coding.ts';
import { runCommand } from '../tools/sandbox.ts';
import { assertWritable, isSecretPath, resolveInside, workspaceDir } from '../tools/workspace.ts';
import { worktreeDraft, worktreePr } from '../tools/worktrees.ts';
import { WorktreeError, worktreeRel, type WorktreeRecord } from '../worktrees.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const MAX_TREE = 4000;
const MAX_SAVE = 1_000_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.sara-worktrees', '__pycache__', '.venv', 'venv', 'target', 'dist', 'build', '.next']);

export const hashOf = (b: Buffer | string) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** Files and folders below `dir` (relative to `root`), skipping heavy folders and secrets. */
export function listTree(root: string, dir: string): { entries: { path: string; dir: boolean; size?: number }[]; truncated: boolean } {
  const out: { path: string; dir: boolean; size?: number }[] = [];
  let truncated = false;
  const walk = (abs: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_TREE) return void (truncated = true);
      const p = join(abs, name);
      const rel = relative(root, p).split(sep).join('/');
      if (isSecretPath(rel)) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        out.push({ path: rel, dir: true });
        if (!SKIP_DIRS.has(name) && depth < 12) walk(p, depth + 1);
      } else if (st.isFile()) out.push({ path: rel, dir: false, size: st.size });
    }
  };
  walk(dir, 0);
  return { entries: out, truncated };
}

export function createWorktreeRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts, rootDir } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    const ws = a === 'workspaces' && b && !d && (c === 'tree' || c === 'run' || c === 'diagnostics' || (c === 'file' && method === 'PUT'));
    if (a !== 'worktrees' && a !== 'coding-depth' && !ws) return NEXT;
    if (opts.member || app.member || opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    const url = new URL(req.url ?? '/', 'http://x');

    if (a === 'coding-depth' && !b) {
      if (method === 'PUT') {
        const body = await readJson(req);
        app.settings.update({ coAuthor: mergeCoAuthor(app.settings.get().coAuthor, (body.coAuthor ?? body) as Record<string, unknown>) });
      } else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { coAuthor: coAuthorOf(app.settings.get().coAuthor, app.persona.name), saved: app.settings.get().coAuthor ?? {}, servers: app.lsp?.available() ?? [], running: (app.lsp?.running() ?? []).length });
    }

    if (ws) {
      const name = validWorkspace(b);
      const root = workspaceDir(rootDir, name);
      const inside = (rel: string) => {
        try {
          return resolveInside(root, rel);
        } catch (err) {
          throw as400(err);
        }
      };
      if (c === 'tree' && method === 'GET') {
        const sub = url.searchParams.get('dir') ?? '';
        const t = listTree(root, inside(sub));
        return send(res, 200, { workspace: name, dir: sub, ...t, worktrees: (app.worktrees?.list({ workspace: name }) ?? []).filter((w) => w.state === 'active').map((w) => ({ id: w.id, branch: w.branch, dir: worktreeRel(w), conversationId: w.conversationId })) });
      }
      if (c === 'file' && method === 'PUT') {
        const body = await readJson(req, MAX_SAVE + 10_000);
        const rel = String(body.path ?? '');
        const text = typeof body.text === 'string' ? body.text : undefined;
        if (!rel || text === undefined) throw new HttpError(400, 'Say which file and what to save.');
        if (Buffer.byteLength(text) > MAX_SAVE) throw new HttpError(413, 'That file is too big to save here (over 1 MB).');
        if (isSecretPath(rel)) throw new HttpError(403, 'Files that hold keys or secrets can’t be edited here.');
        const full = inside(rel);
        try {
          assertWritable(root, full);
        } catch (err) {
          throw as400(err);
        }
        const st = statSync(full, { throwIfNoEntry: false });
        if (st && !st.isFile()) throw new HttpError(400, 'That is a folder.');
        if (st && typeof body.hash === 'string' && body.hash !== hashOf(readFileSync(full))) throw new HttpError(409, 'The file changed since you opened it (she or a command may have edited it). Reload it first.');
        writeFileSync(full, text);
        return send(res, 200, { ok: true, path: rel, hash: hashOf(text), size: Buffer.byteLength(text) });
      }
      if (c === 'diagnostics' && method === 'GET') {
        const rel = url.searchParams.get('path') ?? '';
        inside(rel);
        if (!app.lsp) return send(res, 200, { available: false, diagnostics: [] });
        try {
          return send(res, 200, { available: true, diagnostics: await app.lsp.diagnostics(root, rel) });
        } catch (err) {
          if (err instanceof NoServer) return send(res, 200, { available: false, reason: err.message, diagnostics: [] });
          throw new HttpError(502, (err as Error).message);
        }
      }
      if (c === 'run' && method === 'POST') {
        const body = await readJson(req);
        const command = String(body.command ?? '').trim();
        if (!command || command.length > 4000) throw new HttpError(400, 'Type a command (up to 4000 characters).');
        // Her shell's rules: if the owner (or the policy) turned commands off, this terminal is off too.
        if (app.tools.permission('shell', app.settings.get().toolPermissions) === 'never') throw new HttpError(403, 'Commands are turned off (Settings → Tools → shell).');
        const cwd = String(body.cwd ?? '').replace(/\\/g, '/');
        const rel = cwd ? relative(root, inside(cwd)).split(sep).join('/') : '';
        const conv = typeof body.conversationId === 'string' ? app.store.getConversation(body.conversationId) : undefined;
        const network = !(conv?.private || privateLocalOn()) && (app.settings.get().shellNetwork ?? true);
        const r = await runCommand(rel ? `cd ${shq(rel)} && ${command}` : command, root, { ...app.sandbox, network }, { timeoutMs: 120_000, signal: AbortSignal.timeout(125_000), maxBytes: 200_000, ...(app.persona.name !== 'Sara' ? { gitName: app.persona.name } : {}) });
        return send(res, 200, { exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms, output: app.redactor.redact(r.output).slice(0, 200_000), sandbox: app.sandbox.mode });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // /api/worktrees
    const wt = app.worktrees;
    if (!wt) throw new HttpError(404, 'Task worktrees are not available here.');
    const fail = (err: unknown): never => {
      if (err instanceof WorktreeError) throw new HttpError(err.code === 'unsaved' || err.code === 'dirty' || err.code === 'conflict' || err.code === 'active' || err.code === 'base' ? 409 : 400, err.message, { code: err.code, ...(err.detail ? { detail: err.detail } : {}) });
      throw as400(err);
    };
    const view = async (r: WorktreeRecord) => {
      const root = workspaceDir(rootDir, r.workspace);
      return { ...r, folder: worktreeRel(r), ...(r.state === 'active' ? { status: await wt.status(r, root).catch(() => ({ dirty: [], ahead: 0, commits: [] })) } : {}) };
    };
    if (!b) {
      if (method === 'GET') {
        const workspace = url.searchParams.get('workspace');
        const conversationId = url.searchParams.get('conversationId') ?? undefined;
        const list = wt.list({ ...(workspace ? { workspace: validWorkspace(workspace) } : {}), ...(conversationId ? { conversationId } : {}) });
        return send(res, 200, { worktrees: await Promise.all(list.map(view)) });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const conv = app.store.getConversation(String(body.conversationId ?? ''));
        if (!conv) throw new HttpError(404, 'Conversation not found');
        if (conv.mode !== 'coding') throw new HttpError(400, 'Task worktrees are for coding conversations.');
        try {
          const r = await wt.start({ conversationId: conv.id, workspace: conv.workspace, wsDir: workspaceDir(rootDir, conv.workspace), task: String(body.task ?? ''), repo: typeof body.repo === 'string' ? body.repo : '.' });
          return send(res, 201, { worktree: await view(r) });
        } catch (err) {
          return fail(err);
        }
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const rec = wt.get(Number(b));
    if (!rec) throw new HttpError(404, 'No such worktree.');
    const root = workspaceDir(rootDir, rec.workspace);
    if (!c && method === 'GET') return send(res, 200, { worktree: await view(rec) });
    if (method !== 'POST' || d) throw new HttpError(405, 'Method not allowed');
    const body = await readJson(req);
    try {
      if (c === 'merge') return send(res, 200, { worktree: await view(await wt.merge(rec, root)) });
      if (c === 'discard') return send(res, 200, { worktree: await view(await wt.discard(rec, root, { confirm: body.confirm === true })) });
      if (c === 'close') return send(res, 200, { worktree: await view(await wt.closePr(rec, root, { confirm: body.confirm === true })) });
      if (c === 'pr-draft') return send(res, 200, await worktreeDraft(app, rec, root));
      if (c === 'pr') {
        if (body.confirm !== true) throw new HttpError(400, 'Opening a pull request needs your OK (confirm).');
        const r = await worktreePr(app, rec, root, { title: typeof body.title === 'string' ? body.title : undefined, body: typeof body.body === 'string' ? body.body : undefined, draft: body.draft === true, signal: AbortSignal.timeout(150_000), ...(app.githubFetch ? { fetchImpl: app.githubFetch } : {}) });
        return send(res, 200, { worktree: await view(r.record), url: r.url, number: r.number });
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return fail(err);
    }
    throw new HttpError(404, 'Not found');
  };
}
