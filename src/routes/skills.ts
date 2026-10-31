// Phase 96 (ST1, docs/design/STAPLES.md §4.9): Settings → Abilities → Skills. The owner and each
// household member reach their own space's skills (`skills` is a member route family in
// src/household.ts); trusting a workspace's project skills and importing a folder from the server are
// the owner's only. The demo refuses all of it (not in DEMO_READS / DEMO_WRITES).
//   GET    /api/skills                         the list (with diagnostics, scopes, shadowing), untrusted projects, the migration report
//   POST   /api/skills                         { scope?, name, description, body } a new skill
//   GET    /api/skills/export                  every skill of this companion (and the shared ones) as one zip
//   POST   /api/skills/import                  a .zip body (application/zip or octet-stream), or { url } / { path } → the review
//   GET    /api/skills/import/:id              the review again
//   POST   /api/skills/import/:id/accept       { scope: companion | shared, names? }
//   DELETE /api/skills/import/:id              cancel
//   POST   /api/skills/trust-project           { workspace, trusted }   (owner only)
//   POST   /api/skills/from-recipe             { id } one recipe as a skill
//   POST   /api/skills/migration/seen          the one-time "recipes are skills now" note was read
//   GET    /api/skills/:scope/:name            frontmatter, body, files, versions
//   PUT    /api/skills/:scope/:name            { description, body, license?, compatibility?, allowedTools? } save (keeps a version)
//   DELETE /api/skills/:scope/:name            to the scope's .trash (30 days)
//   POST   /api/skills/:scope/:name/enable     { enabled?, pinned?, scriptsAuto? }
//   POST   /api/skills/:scope/:name/copy       { to: companion | shared } (a built-in or another scope's skill as your own)
//   POST   /api/skills/:scope/:name/restore    { version }
//   POST   /api/skills/:scope/:name/approve    keep a changed imported skill as it is now
//   GET    /api/skills/:scope/:name/export     <name>.zip
import { join } from 'node:path';
import { HttpError, readJson, readRaw, SECURITY_HEADERS, send } from '../http.ts';
import { isPrivateLocalError } from '../net-guard.ts';
import { fromFolder, fromGit, fromZip, PackageError, SKILL_LIMITS } from '../packages.ts';
import { checkServerFolder, isScope, type SkillStore, type SkillView } from '../skill-store.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const OWNER_ONLY = 'Only the owner of this server can use this.';
/** Extra files from the editor's "Add a file" (scripts/, references/ or assets/; checked by the store). */
const filesOf = (v: unknown): { path: string; content: string }[] | undefined => (Array.isArray(v) ? v.slice(0, 20).map((f) => ({ path: String((f as { path?: unknown })?.path ?? ''), content: String((f as { content?: unknown })?.content ?? '').slice(0, 256 * 1024) })) : undefined);

export function createSkillRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const asHttp = (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    if (isPrivateLocalError(err)) throw new HttpError(403, 'Private local mode is on ("Nothing leaves this computer"): git addresses are paused. A .zip or a folder on this server still works.');
    throw new HttpError(400, (err as Error).message);
  };
  const brief = (v: SkillView) => ({
    scope: v.scope,
    name: v.name,
    description: v.description,
    source: v.source,
    origin: v.origin,
    enabled: v.enabled,
    status: v.status,
    diagnostics: v.diagnostics,
    effective: v.effective,
    clash: v.clash,
    ...(v.shadowedBy ? { shadowedBy: v.shadowedBy } : {}),
    pinned: v.pinned,
    scriptsAuto: v.scriptsAuto,
    approvedRuns: v.approvedRuns,
    allowedTools: v.allowedTools,
    compatibility: v.compatibility,
    license: v.license,
    uses: v.uses,
    lastUsedAt: v.lastUsedAt,
    updatedAt: v.updatedAt,
    bodyTokens: v.bodyTokens,
    metadata: v.metadata,
  });
  const review = (p: NonNullable<ReturnType<SkillStore['pending']>>) => ({ id: p.id, origin: p.origin, kind: p.kind, skills: p.skills, scopes: app.skills!.writableScopes() });
  const zip = (res: Parameters<RouteHandler>[1], name: string, buf: Buffer) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name.replace(/[^a-z0-9-]/g, '')}.zip"`, 'content-length': String(buf.length), 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(buf);
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (!(a === 'skills')) return NEXT;
    const skills = app.skills;
    if (!skills) {
      if (method !== 'GET') await readRaw(req, SKILL_LIMITS.maxZipBytes + 1).catch(() => undefined);
      throw new HttpError(404, 'Skills are not available here.');
    }
    const member = Boolean(app.member);
    const publish = () => app.events?.publish({ type: 'skills' });

    if (!b) {
      if (method === 'GET') {
        const list = skills.list();
        return send(res, 200, {
          skills: list.map(brief),
          scopes: skills.writableScopes(),
          projects: member ? [] : skills.untrustedProjects(),
          trusted: member ? [] : skills.trustedProjects(),
          migration: skills.migrationReport() ?? null,
          recipes: app.recipes ? app.recipes.list().map((r) => ({ id: r.id, title: r.title, skill: skills.fromRecipeId(r.id)?.name ?? null })) : [],
          member,
        });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const scope = String(body.scope ?? 'companion');
        try {
          const v = skills.save(scope, { name: String(body.name ?? ''), description: String(body.description ?? ''), body: String(body.body ?? ''), ...(filesOf(body.files) ? { files: filesOf(body.files)! } : {}) }, { create: true, source: 'made', why: 'made on the Skills page' });
          publish();
          return send(res, 201, brief(v));
        } catch (err) {
          return asHttp(err);
        }
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (a === 'skills' && (b === 'export' || b === 'migration') && !c && method === 'GET') return b === 'export' ? zip(res, 'skills', skills.exportAllZip()) : send(res, 200, { migration: skills.migrationReport() ?? null });

    if (b === 'migration' && c === 'seen' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      skills.migrationSeen();
      return send(res, 200, { ok: true });
    }

    if (a === 'skills' && b === 'trust-project' && !c) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (member) {
        await readJson(req).catch(() => ({}));
        throw new HttpError(403, OWNER_ONLY, { ownerOnly: true });
      }
      const body = await readJson(req);
      try {
        skills.setTrust(String(body.workspace ?? ''), body.trusted === true);
      } catch (err) {
        return asHttp(err);
      }
      publish();
      return send(res, 200, { ok: true, trusted: skills.trustedProjects(), projects: skills.untrustedProjects() });
    }

    if (a === 'skills' && b === 'from-recipe' && !c && method === 'POST') {
      const body = await readJson(req);
      const r = app.recipes?.get(Math.floor(Number(body.id)));
      if (!r) throw new HttpError(404, 'Recipe not found');
      try {
        const v = skills.recipeToSkill(r);
        publish();
        return send(res, 200, brief(v));
      } catch (err) {
        return asHttp(err);
      }
    }

    if (a === 'skills' && b === 'import') {
      if (!c && method === 'POST') {
        const type = String(req.headers['content-type'] ?? '');
        let p;
        try {
          if (type.startsWith('application/json')) {
            const body = await readJson(req);
            if (typeof body.path === 'string' && body.path.trim()) {
              // A folder on the server: the owner's only (a member could read the owner's files).
              if (member) throw new HttpError(403, OWNER_ONLY, { ownerOnly: true });
              const dir = checkServerFolder(body.path);
              p = skills.stage(fromFolder(dir), dir, 'folder');
            } else if (typeof body.url === 'string' && body.url.trim()) {
              const files = await fromGit(body.url, skills.opts.scratchDir ?? join(app.dataDir, 'cache', 'skill-imports'));
              p = skills.stage(files, body.url.trim(), 'git');
            } else throw new HttpError(400, 'Send a .zip, a git address or a folder on the server.');
          } else {
            const buf = await readRaw(req, SKILL_LIMITS.maxZipBytes + 1);
            const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'skill.zip';
            p = skills.stage(fromZip(buf), name.slice(0, 200), 'zip');
          }
        } catch (err) {
          if (err instanceof HttpError && err.status === 413) throw new HttpError(413, 'The zip is larger than 5 MB.');
          if (err instanceof PackageError) throw new HttpError(400, err.message);
          return asHttp(err);
        }
        return send(res, 200, review(p));
      }
      if (c && !d && method === 'GET') {
        const p = skills.pending(c);
        if (!p) throw new HttpError(404, 'That import has expired. Add the skill again.');
        return send(res, 200, review(p));
      }
      if (c && !d && method === 'DELETE') return send(res, 200, { ok: skills.cancelImport(c) });
      if (c && d === 'accept' && method === 'POST') {
        const body = await readJson(req);
        const scope = body.scope === 'shared' ? 'shared' : 'companion';
        try {
          const out = skills.accept(c, scope, Array.isArray(body.names) ? (body.names as unknown[]).map(String) : undefined);
          publish();
          return send(res, 200, { skills: out.map(brief) });
        } catch (err) {
          return asHttp(err);
        }
      }
      throw new HttpError(404, 'Not found');
    }

    // One skill: /api/skills/:scope/:name[/action]
    if (b && c) {
      if (!isScope(b)) throw new HttpError(404, 'No such skill.');
      const e = parts[3];
      if (!e) {
        if (method === 'GET') {
          const v = skills.detail(b, c);
          if (!v) throw new HttpError(404, 'No such skill.');
          return send(res, 200, { ...brief(v), skillMd: v.skillMd, body: v.body, files: v.files, versions: v.versions, recentUses: skills.uses(b, c, 10) });
        }
        if (method === 'PUT') {
          const body = await readJson(req);
          const cur = skills.get(b, c);
          if (!cur) throw new HttpError(404, 'No such skill.');
          try {
            const v = skills.save(b, { name: c, description: String(body.description ?? cur.description), body: String(body.body ?? ''), metadata: cur.metadata, ...(filesOf(body.files) ? { files: filesOf(body.files)! } : {}), ...(body.license !== undefined ? { license: String(body.license) } : cur.license ? { license: cur.license } : {}), ...(body.compatibility !== undefined ? { compatibility: String(body.compatibility) } : cur.compatibility ? { compatibility: cur.compatibility } : {}), ...(body.allowedTools !== undefined ? { allowedTools: String(body.allowedTools) } : cur.allowedTools ? { allowedTools: cur.allowedTools } : {}) }, { why: 'edited on the Skills page' });
            publish();
            return send(res, 200, brief(v));
          } catch (err) {
            return asHttp(err);
          }
        }
        if (method === 'DELETE') {
          let ok = false;
          try {
            ok = skills.delete(b, c);
          } catch (err) {
            return asHttp(err);
          }
          if (!ok) throw new HttpError(404, 'No such skill.');
          publish();
          return send(res, 200, { ok: true });
        }
        throw new HttpError(405, 'Method not allowed');
      }
      if (e === 'export' && method === 'GET') {
        try {
          return zip(res, c, skills.exportZip(b, c));
        } catch (err) {
          return asHttp(err);
        }
      }
      if (method === 'POST' && (e === 'enable' || e === 'copy' || e === 'restore' || e === 'approve')) {
        const body = await readJson(req);
        try {
          let v: SkillView;
          if (e === 'enable') v = skills.setSwitches(b, c, { ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}), ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}), ...(typeof body.scriptsAuto === 'boolean' ? { scriptsAuto: body.scriptsAuto } : {}) });
          else if (e === 'restore') v = skills.restore(b, c, Math.floor(Number(body.version)));
          else if (e === 'approve') v = skills.approveChange(b, c);
          else v = skills.copy(b, c, body.to === 'shared' ? 'shared' : 'companion');
          publish();
          return send(res, 200, brief(v));
        } catch (err) {
          return asHttp(err);
        }
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
