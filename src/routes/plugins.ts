// Phase 98 (ST3, docs/design/STAPLES.md §6.10): Settings → Abilities → Plugins. Every route is the
// owner's: `plugins` is not a member route family (src/household.ts), so a household member gets 403
// ownerOnly before reaching here, and the demo refuses it (not in DEMO_READS / DEMO_WRITES).
//   GET    /api/plugins                          the list, the fence, calls waiting for the owner
//   POST   /api/plugins/install                  a .zip body, or { url } / { path } → the review card
//   GET    /api/plugins/install/:review          the review again
//   DELETE /api/plugins/install/:review          cancel
//   POST   /api/plugins/:id/approve              { review, trust? } install (or update) what was reviewed
//   POST   /api/plugins/:id/enable               { companion, on }
//   GET    /api/plugins/:id/settings?companion=  its settings for one companion (secrets: only "set")
//   PUT    /api/plugins/:id/settings             { companion, values, bridge? }
//   POST   /api/plugins/:id/update-check         the same git address or folder again → review or up to date
//   POST   /api/plugins/:id/rollback             back to the kept version
//   DELETE /api/plugins/:id                      remove (folders, its data, its secrets)
//   GET    /api/plugins/:id/log                  what it did (scrubbed; 30 days)
//   POST   /api/plugins/:id/calls/:call          { approved } a Sara tool it asked to use
//   POST   /api/plugins/:id/action               { companion, tool, args } a card button (the owner's click)
//   GET    /api/plugins/:id/file?path=           a picture from its own folder (cards)
// Phase 117 (BRIDGES3 §6.2):
//   GET    /api/plugins/builtin                  the plugins that come with Sara (installed? update?)
//   POST   /api/plugins/install                  { builtin: 'signal' } → the same review card (origin builtin)
//   POST   /api/plugins/:id/link                 { companion } → { code, expires } (10 minutes)
//   DELETE /api/plugins/:id/link/:chat?companion= unlink a chat (and its id and pinned identity)
//   POST   /api/plugins/:id/test                 { companion } → { ok, steps } (sends nothing to anyone)
//   GET    /api/plugins/:id/bridge?companion=    the status chip, Today, sockets, linked chats, a changed identity
//   POST   /api/plugins/:id/identity             { companion, chat, action: confirm | unlink }
//   POST   /api/plugins/:id/group                { companion, chat, on } (*Answer here*)
//   POST   /api/plugins/:id/leave                { companion, chat } (*Leave this group*)
//   POST   /api/plugins/:id/check-sender         { companion } → waits ≤ 10 min for his next mail: { got, from, headers };
//                                                { companion, use } → that provider id counts (email)
import { readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { HttpError, readJson, readRaw, SECURITY_HEADERS, send } from '../http.ts';
import { isPrivateLocalError } from '../net-guard.ts';
import { fromFolder, fromGit, fromZip, PackageError } from '../packages.ts';
import { ManifestError } from '../plugins/manifest.ts';
import { PLUGIN_LIMITS } from '../plugins/manager.ts';
import { checkServerFolder } from '../skill-store.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function createPluginRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const asHttp = (err: unknown): never => {
    if (err instanceof HttpError) throw err;
    if (isPrivateLocalError(err)) throw new HttpError(403, 'Private local mode is on ("Nothing leaves this computer"): git addresses are paused. A .zip or a folder on this server still works.');
    if (err instanceof ManifestError || err instanceof PackageError) throw new HttpError(400, err.message);
    throw new HttpError(400, (err as Error).message);
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'plugins') return NEXT;
    const pm = app.pluginManager;
    if (!pm || app.member) {
      if (method !== 'GET') await readRaw(req, PLUGIN_LIMITS.maxZipBytes + 1).catch(() => undefined);
      throw new HttpError(404, 'Plugins are not available here.');
    }
    const companion = (v: unknown) => String(v ?? app.companionId ?? 'main');

    if (!b && method === 'GET') {
      return send(res, 200, { plugins: pm.list(), fence: pm.fence, waiting: pm.waiting(), companions: (app.companions?.all() ?? []).map((x) => ({ id: x.id, name: x.app.persona.name })), version: pm.version });
    }

    if (b === 'builtin' && !c && method === 'GET') return send(res, 200, { builtin: pm.builtinList() });
    if (b === 'install') {
      if (!c && method === 'POST') {
        const type = String(req.headers['content-type'] ?? '');
        try {
          if (type.startsWith('application/json')) {
            const body = await readJson(req);
            if (typeof body.builtin === 'string' && body.builtin.trim()) return send(res, 200, pm.stageBuiltin(body.builtin.trim()));
            if (typeof body.path === 'string' && body.path.trim()) {
              const dir = checkServerFolder(body.path);
              return send(res, 200, pm.stage(fromFolder(dir, PLUGIN_LIMITS), { kind: 'folder', where: dir }));
            }
            if (typeof body.url === 'string' && body.url.trim()) {
              const files = await fromGit(body.url, join(app.dataDir, 'cache', 'plugin-imports'), PLUGIN_LIMITS);
              return send(res, 200, pm.stage(files, { kind: 'git', where: body.url.trim() }));
            }
            throw new HttpError(400, 'Send a .zip, a git address or a folder on the server.');
          }
          const buf = await readRaw(req, PLUGIN_LIMITS.maxZipBytes + 1);
          const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'plugin.zip';
          return send(res, 200, pm.stage(fromZip(buf, PLUGIN_LIMITS), { kind: 'zip', where: name.slice(0, 200) }));
        } catch (err) {
          if (err instanceof HttpError && err.status === 413) throw new HttpError(413, 'The zip is larger than 10 MB.');
          return asHttp(err);
        }
      }
      if (c && !d && method === 'GET') {
        const r = pm.review(c);
        if (!r) throw new HttpError(404, 'That review has expired. Add the plugin again.');
        return send(res, 200, r);
      }
      if (c && !d && method === 'DELETE') {
        pm.cancel(c);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const id = b;
    // Install (or update) what the owner reviewed: the plugin may not exist yet.
    if (c === 'approve' && method === 'POST') {
      const body = await readJson(req);
      const r = pm.review(String(body.review ?? ''));
      if (!r || r.manifest.id !== id) throw new HttpError(404, 'That review has expired. Add the plugin again.');
      try {
        await pm.approve(r.id, { trust: body.trust === true });
      } catch (err) {
        return asHttp(err);
      }
      return send(res, 200, pm.view(pm.store.get(id)!));
    }
    const row = pm.store.get(id);
    if (!row) {
      if (method !== 'GET') await readJson(req).catch(() => ({}));
      throw new HttpError(404, 'No such plugin.');
    }
    if (!c && method === 'DELETE') {
      try {
        await pm.remove(id);
      } catch (err) {
        return asHttp(err);
      }
      return send(res, 200, { ok: true });
    }
    if (c === 'enable' && method === 'POST') {
      const body = await readJson(req);
      try {
        await pm.setEnabled(id, companion(body.companion), body.on === true);
      } catch (err) {
        return asHttp(err);
      }
      return send(res, 200, pm.view(pm.store.get(id)!));
    }
    if (c === 'settings') {
      if (method === 'GET') {
        try {
          return send(res, 200, pm.settingsView(id, companion(new URL(req.url ?? '/', 'http://x').searchParams.get('companion') ?? undefined)));
        } catch (err) {
          return asHttp(err);
        }
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        try {
          await pm.putSettings(id, companion(body.companion), body.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {}, body.bridge && typeof body.bridge === 'object' ? (body.bridge as { ownerChats?: unknown; others?: unknown; allow?: unknown; workInGroups?: unknown; nameCalls?: unknown }) : undefined);
        } catch (err) {
          return asHttp(err);
        }
        return send(res, 200, pm.settingsView(id, companion(body.companion)));
      }
    }
    if (c === 'update-check' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      try {
        return send(res, 200, await pm.updateCheck(id));
      } catch (err) {
        return asHttp(err);
      }
    }
    if (c === 'rollback' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      try {
        await pm.rollback(id);
      } catch (err) {
        return asHttp(err);
      }
      return send(res, 200, pm.view(pm.store.get(id)!));
    }
    if (c === 'log' && method === 'GET') return send(res, 200, { log: pm.store.logs(id, 200) });
    // Phase 117: linking, the Test button, the status chip, identities, groups.
    const q = () => new URL(req.url ?? '/', 'http://x').searchParams;
    try {
      if (c === 'link' && !d && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, pm.linkCode(id, companion(body.companion)));
      }
      if (c === 'link' && d && method === 'DELETE') {
        pm.unlink(id, companion(q().get('companion') ?? undefined), decodeURIComponent(d));
        return send(res, 200, pm.bridgeView(id, companion(q().get('companion') ?? undefined)));
      }
      if (c === 'test' && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, await pm.testBridge(id, companion(body.companion)));
      }
      if (c === 'bridge' && method === 'GET') return send(res, 200, pm.bridgeView(id, companion(q().get('companion') ?? undefined)));
      if (c === 'identity' && method === 'POST') {
        const body = await readJson(req);
        const action = body.action === 'unlink' ? 'unlink' : body.action === 'confirm' ? 'confirm' : undefined;
        if (!action || typeof body.chat !== 'string') throw new HttpError(400, 'Say which chat, and confirm or unlink.');
        if (!pm.identityAction(id, companion(body.companion), body.chat, action)) throw new HttpError(404, 'That safety number is no longer waiting for you.');
        return send(res, 200, pm.bridgeView(id, companion(body.companion)));
      }
      if ((c === 'group' || c === 'leave') && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.chat !== 'string' || !body.chat) throw new HttpError(400, 'Say which group.');
        if (c === 'group') pm.setGroup(id, companion(body.companion), body.chat, body.on === true);
        else pm.leaveGroup(id, companion(body.companion), body.chat);
        return send(res, 200, pm.settingsView(id, companion(body.companion)));
      }
      // Phase 117 part B (email): *Check my sender* waits up to 10 minutes for his next mail;
      // `{use}` makes one of the provider ids it carried the one that counts.
      if (c === 'check-sender' && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.use === 'string') {
          pm.useAuthserv(id, companion(body.companion), body.use);
          return send(res, 200, pm.bridgeView(id, companion(body.companion)));
        }
        const r = await pm.checkSender(id, companion(body.companion));
        return send(res, 200, r ? { got: true, from: r.from, headers: r.headers } : { got: false });
      }
    } catch (err) {
      return asHttp(err);
    }
    if (c === 'calls' && d && method === 'POST') {
      const body = await readJson(req);
      if (!pm.decideCall(d, body.approved === true)) throw new HttpError(404, 'That request is no longer waiting.');
      return send(res, 200, { ok: true });
    }
    if (c === 'action' && method === 'POST') {
      const body = await readJson(req);
      try {
        return send(res, 200, await pm.cardAction(id, companion(body.companion), String(body.tool ?? ''), body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {}));
      } catch (err) {
        return asHttp(err);
      }
    }
    if (c === 'file' && method === 'GET') {
      const rel = String(new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '').replace(/\\/g, '/');
      const type = IMAGE_TYPES[extname(rel).toLowerCase()];
      const root = resolve(row.dir);
      const abs = resolve(root, ...rel.split('/'));
      if (!type || !rel || rel.split('/').includes('..') || !abs.startsWith(root + sep)) throw new HttpError(404, 'Not found');
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        throw new HttpError(404, 'Not found');
      }
      if (buf.length > 2 * 1024 * 1024) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'content-type': type, 'content-length': String(buf.length), 'cache-control': 'private, max-age=300', 'content-security-policy': "default-src 'none'", ...SECURITY_HEADERS });
      res.end(buf);
      return;
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
