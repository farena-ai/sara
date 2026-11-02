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
// Phase 122 (WHATSAPP §6.2): GET /api/plugins/whatsapp/setup and POST …/{terms,webhook,door-url,check,fix,
//   register,send-test,unmute} (src/plugins/whatsapp-setup.ts); removing a plugin removes its bridge hook.
// Phase 122 part 2 (BRIDGES4 §8.2): GET /api/plugins/matrix/setup and POST …/{terms,login,token,check,fix}
//   (src/plugins/matrix-setup.ts); her password is passed once to the plugin and never stored or logged.
// Phase 122 part 3 (BRIDGES4 §8.2): GET /api/plugins/imessage/setup and POST …/{terms,address,password,check,fix}
//   (src/plugins/imessage-setup.ts); the BlueBubbles password goes to the vault and is never sent back.
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
import { hookBase, runCheck, setupState, WA } from '../plugins/whatsapp-setup.ts';
import * as matrix from '../plugins/matrix-setup.ts';
import * as imessage from '../plugins/imessage-setup.ts';
import { bridgeWindowOpen } from '../plugins/bridge-db.ts';
import { en } from '../i18n.ts';
import { InstallError, StoreInstaller } from '../store/install.ts';
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
            // Phase 125 (§12.2): `{store: id}` is the store install (download, verify, the same card).
            if (typeof body.store === 'string' && body.store.trim()) {
              if (!app.storeClient || !app.storeInstalls) throw new HttpError(404, en('The Sara Store is not available here.'));
              const out = await new StoreInstaller({ app, client: app.storeClient, installs: app.storeInstalls, plugins: pm }).install(body.store.trim());
              if (out.kind !== 'plugin') throw new HttpError(400, 'That is not a plugin.');
              return send(res, 200, out.review);
            }
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
          if (err instanceof InstallError) throw new HttpError(err.status, err.message, { code: err.code });
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

    // Phase 122: the WhatsApp setup card (works before the plugin is installed: the card shows the terms box).
    const WA_ROUTES = ['setup', 'terms', 'webhook', 'door-url', 'check', 'fix', 'register', 'send-test', 'unmute'];
    if (b === WA && c && WA_ROUTES.includes(c) && !d) {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (c === 'setup' && method === 'GET') return send(res, 200, setupState(app, pm, companion(q.get('companion'))));
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      const co = companion(body.companion);
      const installed = Boolean(pm.store.get(WA));
      if (c === 'terms') {
        // Stored once the plugin exists; before that the card keeps the tick until Install.
        if (installed) pm.store.kvSet(WA, co, '__terms', app.now().toISOString());
        return send(res, 200, { ok: true });
      }
      if (!installed) throw new HttpError(400, 'Add WhatsApp first (step 1).');
      if (c === 'webhook') {
        const hooks = app.hooks;
        if (!hooks) throw new HttpError(400, 'Webhooks are not available here.');
        const secret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
        if (secret && !/^[0-9a-f]{32}$/i.test(secret)) throw new HttpError(400, 'The App secret is 32 letters and digits (0–9, a–f). Copy it again from App settings → Basic → Show.');
        const r = hooks.ensureBridgeHook(WA, co, secret || undefined);
        const verifyToken = body.newVerifyToken === true ? hooks.newVerifyToken(r.hook.id) : r.verifyToken;
        const base = hookBase(pm, co);
        return send(res, 200, { callbackUrl: base ? `${base}${r.path}` : null, path: r.path, verifyToken, secretSet: hooks.hasSenderSecret(r.hook.id) });
      }
      if (c === 'door-url') {
        const raw = String(body.url ?? '').trim();
        if (!raw) {
          pm.store.kvSet(WA, co, '__door', undefined);
          return send(res, 200, { ok: true, hookUrl: hookBase(pm, co) });
        }
        let u: URL;
        try {
          u = new URL(raw);
        } catch {
          throw new HttpError(400, 'Paste the whole address, starting with https://');
        }
        if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'Meta only calls https addresses.');
        pm.store.kvSet(WA, co, '__door', u.origin);
        return send(res, 200, { ok: true, hookUrl: u.origin });
      }
      if (c === 'check') return send(res, 200, await runCheck(app, pm, co, String(body.step ?? '')));
      if (c === 'fix') {
        const fix = body.fix === 'subscribe' ? 'fix-subscribe' : body.fix === 'identity-check' ? 'fix-identity' : '';
        if (!fix) throw new HttpError(400, 'No such fix.');
        return send(res, 200, await pm.bridgeCheck(WA, co, { step: fix }));
      }
      if (c === 'register') {
        // The PIN is passed once to the plugin and forgotten: never stored, logged or echoed.
        const pin = String(body.pin ?? '');
        if (!/^\d{6}$/.test(pin)) throw new HttpError(400, 'The two-step PIN is 6 digits.');
        return send(res, 200, await pm.bridgeCheck(WA, co, { step: 'register', pin, phoneNumberId: String(body.phoneNumberId ?? '').trim() }));
      }
      if (c === 'send-test') {
        const chat = (pm.settingsView(WA, co).bridge?.ownerChats ?? [])[0];
        if (!chat) throw new HttpError(400, 'Link your WhatsApp first (step 9).');
        if (!bridgeWindowOpen(app, chat)) return send(res, 200, { ok: false, diagnosis: { code: 'WINDOW_CLOSED' } });
        return send(res, 200, await pm.bridgeCheck(WA, co, { step: 'send-test', chatId: chat, text: 'Test from Sara: WhatsApp works.' }));
      }
      if (c === 'unmute') {
        pm.unmute(WA, co, String(body.who ?? ''));
        return send(res, 200, { ok: true });
      }
    }

    // Phase 122 part 2: the Matrix setup card (works before the plugin is installed: the terms box).
    const MX_ROUTES = ['setup', 'terms', 'login', 'token', 'check', 'fix'];
    if (b === matrix.MX && c && MX_ROUTES.includes(c) && !d) {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (c === 'setup' && method === 'GET') return send(res, 200, await matrix.setupState(app, pm, companion(q.get('companion'))));
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      const co = companion(body.companion);
      const installed = Boolean(pm.store.get(matrix.MX));
      if (c === 'terms') {
        if (installed) pm.store.kvSet(matrix.MX, co, '__terms', app.now().toISOString());
        return send(res, 200, { ok: true });
      }
      if (!installed) throw new HttpError(400, 'Add Matrix first.');
      try {
        if (c === 'login') return send(res, 200, await matrix.login(app, pm, co, body.mxid, body.password));
        if (c === 'token') {
          const token = String(body.token ?? '').trim();
          if (!/^[\x21-\x7e]{8,1000}$/.test(token)) throw new HttpError(400, 'Paste the whole access token.');
          return send(res, 200, await matrix.useToken(app, pm, co, String(body.mxid ?? '').trim(), token));
        }
        if (c === 'check') return send(res, 200, await matrix.runCheck(app, pm, co, String(body.step ?? '')));
        return send(res, 200, await matrix.runFix(app, pm, co, String(body.fix ?? ''), body.room));
      } catch (err) {
        return asHttp(err);
      }
    }

    // Phase 122 part 3: the iMessage setup card (works before the plugin is installed: the terms box).
    const IM_ROUTES = ['setup', 'terms', 'address', 'password', 'check', 'fix'];
    if (b === imessage.IM && c && IM_ROUTES.includes(c) && !d) {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (c === 'setup' && method === 'GET') return send(res, 200, await imessage.setupState(app, pm, companion(q.get('companion'))));
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      const co = companion(body.companion);
      const installed = Boolean(pm.store.get(imessage.IM));
      if (c === 'terms') {
        if (installed) pm.store.kvSet(imessage.IM, co, '__terms', app.now().toISOString());
        return send(res, 200, { ok: true });
      }
      if (!installed) throw new HttpError(400, 'Add iMessage first.');
      try {
        if (c === 'address') return send(res, 200, await imessage.setAddress(app, pm, co, body));
        if (c === 'password') return send(res, 200, await imessage.setPassword(app, pm, co, body.password));
        if (c === 'check') return send(res, 200, await imessage.runCheck(app, pm, co, String(body.step ?? '')));
        return send(res, 200, await imessage.runFix(app, pm, co, String(body.fix ?? ''), body));
      } catch (err) {
        return asHttp(err);
      }
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
      // Phase 124 (SARA_STORE.md §6.1): a file whose content hash matches a store entry is recorded as
      // that store add-on, so the store's yanks and blocks reach it.
      if (r.store && app.storeInstalls) {
        const at = app.now().toISOString();
        const hit = app.storeClient?.version(r.store.item, r.store.version);
        app.storeInstalls.upsert({ item: r.store.item, kind: 'plugin', version: r.store.version, trust: r.store.trust, local_ref: id, content_sha: r.sha, entry_sha: hit?.v.entrySha ?? '', installed_at: at, updated_at: at, ...(r.store.yanked ? { state: 'yanked' as const, state_note: r.store.yanked } : {}) });
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
        // Phase 122: a plugin's bridge hooks (and their vault entries) go with it.
        app.hooks?.removeForPlugin(id);
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
