// Phases 124–125 (2.57.0–2.58.0, docs/store/SARA_STORE.md §6.2, §8, §9.4, §10.1, §12.2): the Sara
// Store for the owner. Owner only (`store` is not a member route family, like `plugins`); the demo
// refuses it; private local mode allows no store reads or writes. The page never talks to the store
// or the desk itself: everything comes from here.
//   GET  /api/store                      the read model (shelf, freshness, installed state, held ids)
//   POST /api/store/check                fetch the list now (Check now)
//   GET  /api/store/items/:id            an item page: the entry + permission lines computed by Sara
//   GET  /api/store/shots/:sha           a cached, hash-checked picture
//   POST /api/store/install {id}         download, verify, stage: a plugin review, a skill import or the MCP card
//   GET|DELETE /api/store/mcp/:review    the tool-server card again / cancel
//   POST /api/store/mcp/:review/approve  add and start (vault, validateMcpConfig), then Test
//   POST /api/store/test {item}          Test a tool server again
//   GET  /api/store/mine                 My add-ons (store and not)
//   POST /api/store/update|goback|remove|override {item}
//   POST /api/store/report               a report to the Sara team (no diagnostics unless ticked)
//   POST /api/store/pack                 the pack report (nothing sent)
//   POST /api/store/submit               the upload to the Sara team's desk
//   GET  /api/store/submissions[/:sub], POST /api/store/submissions/:sub/reply   My submissions
//   GET  /api/store/author               the author key's fingerprint (if made)
//   GET|PUT /api/store/settings          { on, community }
//   POST /api/store/notices/:item/dismiss
import { policy } from '../policy-profile.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs-util.ts';
import { en } from '../i18n.ts';
import { HttpError, readJson, readRaw, send } from '../http.ts';
import { hubOs, scrubText, ticketBlocked } from '../hub.ts';
import { privateLocalOn } from '../net-guard.ts';
import { fromZip, PackageError } from '../packages.ts';
import { SARA_VERSION } from '../plugins/manager.ts';
import { checkServerFolder } from '../skill-store.ts';
import { imageType, STORE_PLUGIN_LIMITS } from '../store/checks.ts';
import { pluginInstallation, shelfView } from '../store/client.ts';
import { isStoreId, shortKey } from '../store/format.ts';
import { entryLines, InstallError, StoreInstaller } from '../store/install.ts';
import { packFiles, packPath, readStoreZip, type Pack } from '../store/pack.ts';
import { STORE_COMPANION_LIMITS } from '../packs/format.ts';
import { ownerNames } from '../packs/scrub.ts';
import { adultModeOn } from '../settings.ts';
import { packInstallerFor } from './packs.ts';
import { prereqService } from './prereqs.ts';
import { smokeFence } from '../store/pack-cli.ts';
import { authorKey, DeskError, deskDown, refreshSubmission, replySubmission, sendReport, submissions, submit } from '../store/submit.ts';
import { sha256, StoreRefused } from '../store/verify.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export interface StoreSettings {
  on: boolean;
  community: boolean;
}
export function storeSettings(s: { store?: { on?: unknown; community?: unknown } } | undefined): StoreSettings {
  // EC5: the admin's pin reads through: off = no Store at all, official = the signed shelf only.
  const pin = policy().pins.store;
  return { on: s?.store?.on !== false && pin !== 'off', community: s?.store?.community === true && !pin };
}

/** Pictures the item pages showed (sha → path in the store), so /shots/:sha can fetch them. */
const shotPaths = new Map<string, string>();
const remember = (sha: string, path: string) => {
  shotPaths.set(sha, path);
  if (shotPaths.size > 500) shotPaths.delete(shotPaths.keys().next().value!);
};
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/** A refusal from the store code, said as is (its words are already plain). */
function fail(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof InstallError || err instanceof DeskError) throw new HttpError(err.status || 503, err.message, { code: err.code, ...(err instanceof DeskError && deskDown(err.status) ? { deskDown: true } : {}) });
  if (err instanceof StoreRefused || err instanceof PackageError) throw new HttpError(400, err.message);
  throw new HttpError(400, (err as Error).message);
}

interface Draft {
  pack: string;
  name: string;
  contact: string;
  item: string;
  version: string;
  at: string;
}
const draftsFile = (dataDir: string) => join(dataDir, 'store', 'drafts.json');
function drafts(dataDir: string): Draft[] {
  try {
    return JSON.parse(readFileSync(draftsFile(dataDir), 'utf8')) as Draft[];
  } catch {
    return [];
  }
}
function saveDrafts(dataDir: string, list: Draft[]): void {
  mkdirSync(join(dataDir, 'store'), { recursive: true, mode: 0o700 });
  writeFileSync(draftsFile(dataDir), JSON.stringify(list.slice(-10)));
}

export function createStoreRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;

  /** *My add-ons* (§8.7): every add-on that didn't come with Sara, from the store or not. */
  const mine = (): Record<string, unknown> => {
    const rows = new Map((app.storeInstalls?.all() ?? []).map((r) => [`${r.kind}:${r.local_ref}`, r]));
    const shelf = app.storeClient ? (shelfView(app.storeClient, { saraVersion: app.pluginManager?.version ?? SARA_VERSION, installs: app.storeInstalls, plugins: app.pluginManager, ...storeSettings(app.settings.get() as never) }).items as { id: string; version: string; updateAvailable: boolean }[]) : [];
    const upd = (item?: string) => shelf.find((x) => x.id === item && x.updateAvailable)?.version ?? null;
    const out: Record<string, unknown>[] = [];
    for (const p of app.pluginManager?.store.all() ?? []) {
      let origin = 'zip';
      try {
        origin = (JSON.parse(p.origin ?? '{}') as { kind?: string }).kind ?? 'zip';
      } catch {
        /* an old row */
      }
      if (origin === 'builtin') continue;
      const r = rows.get(`plugin:${p.id}`);
      const source = pluginInstallation(app.pluginManager, p.id, r);
      out.push({ kind: 'plugin', ref: p.id, name: p.name, version: p.version, origin, item: r?.item ?? null, trust: r?.trust ?? null, status: p.status, note: p.status_note ?? null, state: r?.state ?? null, stateNote: r?.state_note ?? null, update: source.installHeld ? null : upd(r?.item), ...(source.installHeld ? { installHeld: source.installHeld, installHeldCode: source.installHeldCode } : {}), canGoBack: Boolean(p.prev_version) });
    }
    for (const s of app.skills?.list() ?? []) {
      if (s.source !== 'imported') continue;
      const ref = `${s.scope}/${s.name}`;
      const r = rows.get(`skill:${ref}`);
      const o = String(s.origin ?? '');
      out.push({ kind: 'skill', ref, name: s.name, version: r?.version ?? '', origin: r ? 'store' : /^(https?:|git)/.test(o) ? 'git' : /^[\\/]|^[A-Za-z]:/.test(o) ? 'folder' : 'zip', item: r?.item ?? null, trust: r?.trust ?? null, status: s.status, note: null, state: r?.state ?? null, stateNote: r?.state_note ?? null, update: upd(r?.item), canGoBack: false });
    }
    for (const m of app.settings.get().mcpServers ?? []) {
      const r = rows.get(`mcp:${m.name}`);
      const conn = app.mcp?.get(m.name);
      out.push({ kind: 'mcp', ref: m.name, name: m.name, version: r?.version ?? '', origin: r ? 'store' : 'typed', item: r?.item ?? null, trust: r?.trust ?? null, status: m.enabled ? (conn?.status ?? 'stopped') : 'disabled', tools: conn?.tools.length ?? 0, note: conn?.error || null, state: r?.state ?? null, stateNote: r?.state_note ?? null, update: upd(r?.item), canGoBack: Boolean(r?.prev_recipe) });
    }
    return { addons: out, updates: out.filter((x) => x.update).length };
  };

  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'store') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Add-ons aren’t in the demo.'));
    }
    if (ctx.opts.member || app.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    const client = app.storeClient;
    const settings = () => storeSettings(app.settings.get() as never);
    // Phase 127: explicit companions show only where Adult mode is on for at least one of his companions.
    const adultAny = () => (ctx.opts.companions?.all().map((x) => x.app) ?? [app]).some((x) => adultModeOn(x.settings.get()));
    const saraVersion = app.pluginManager?.version ?? SARA_VERSION;
    const view = () => {
      if (!client) return { ...settings(), blocked: 'demo', freshness: 'none', items: [], held: [], notices: [] };
      return shelfView(client, { saraVersion, installs: app.storeInstalls, plugins: app.pluginManager, ...settings(), adultAny: adultAny() });
    };
    const installer = () => {
      if (!client || !app.storeInstalls) throw new HttpError(404, en('The Sara Store is not available here.'));
      const packs = packInstallerFor(ctx);
      return new StoreInstaller({ app, client, installs: app.storeInstalls, ...(app.pluginManager ? { plugins: app.pluginManager } : {}), ...(packs ? { packs } : {}), programs: prereqService(app) });
    };
    const url = new URL(req.url ?? '/', 'http://x');
    const desk = () => {
      const hub = app.hub;
      if (!hub) throw new HttpError(404, en('The Sara Store is not available here.'));
      const why = ticketBlocked(hub);
      if (why === 'private') throw new HttpError(409, en('Private local mode is on, so the Sara Store is off. Your add-ons keep working.'), { code: 'private' });
      if (why) throw new HttpError(503, "Our desk isn't answering right now. Try again later.", { code: why, deskDown: true });
      return hub;
    };
    const packsDir = join(app.dataDir, 'store', 'packs');
    const db = () => app.storeInstalls?.db ?? app.store.db;

    // Private local mode: nothing from the store is fetched, installed or sent (§8.1); reads show the line.
    if (method !== 'GET' && privateLocalOn() && !(b === 'notices' || b === 'settings' || b === 'pack')) throw new HttpError(409, en('Private local mode is on, so the Sara Store is off. Your add-ons keep working.'), { code: 'private' });
    if (!b && method === 'GET') return send(res, 200, view());
    if (b === 'check' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      if (!client) throw new HttpError(404, en('The Sara Store is not available here.'));
      const r = await client.check();
      return send(res, 200, { result: r, store: view() });
    }
    if (b === 'settings' && !c) {
      if (method === 'PUT') {
        const body = await readJson(req);
        const cur = settings();
        const next: StoreSettings = { on: typeof body.on === 'boolean' ? body.on : cur.on, community: typeof body.community === 'boolean' ? body.community : cur.community };
        policy().guard('store', (next.on && !cur.on) || (next.community && !cur.community));
        app.settings.update({ store: next } as never);
        return send(res, 200, next);
      }
      if (method === 'GET') return send(res, 200, settings());
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'notices' && c && d === 'dismiss' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      if (!isStoreId(c)) throw new HttpError(400, 'Not a store id.');
      client?.dismiss(c);
      return send(res, 200, view());
    }

    // ---- reading: an item page and its pictures ----
    if (b === 'items' && c && !d && method === 'GET') {
      if (!client || !isStoreId(c)) throw new HttpError(404, 'Not found');
      const hit = client.version(c, url.searchParams.get('version') ?? undefined);
      if (!hit) throw new HttpError(404, en('That add-on is not in the store.'));
      let entry;
      try {
        entry = await client.entry(c, hit.v.version);
      } catch (err) {
        fail(err);
      }
      for (const s of entry.shots) remember(s.sha256, s.file);
      if (hit.item.icon && hit.item.iconSha) remember(hit.item.iconSha, hit.item.icon);
      const row = app.storeInstalls?.get(c);
      const source = hit.item.kind === 'plugin' ? pluginInstallation(app.pluginManager, c, row) : undefined;
      const { lines, error } = entryLines(entry, saraVersion);
      const held = client.held().some((h) => h.id === c);
      return send(res, 200, {
        item: { id: hit.item.id, kind: hit.item.kind, name: hit.item.name, summary: hit.item.summary, trust: hit.item.trust, category: hit.item.category ?? 'more', author: { name: hit.item.author.name, key: shortKey(hit.item.author.key) }, ...(hit.item.iconSha ? { icon: hit.item.iconSha } : {}), ...(hit.item.kind === 'companion' ? { rating: hit.item.rating, romance: hit.item.romance } : {}) },
        version: hit.v.version,
        versions: hit.item.versions.map((v) => ({ version: v.version, published: v.published, ...(v.yanked ? { yanked: v.yanked } : {}) })),
        size: hit.v.size ?? null,
        entry: { description: entry.description, about: entry.about, license: entry.license, source: entry.source ?? null, contact: entry.author.contact ?? null, shots: entry.shots.map((s) => ({ sha: s.sha256, alt: s.alt })), changes: entry.changes, checks: entry.checks, review: entry.review ?? null, tested: entry.tested ?? [], needs: entry.needs ?? [], works: entry.works ?? [], ...(entry.mcp ? { mcp: entry.mcp } : {}), ...(entry.companion ? { companion: entry.companion } : {}) },
        lines,
        ...(error ? { linesError: error } : {}),
        installed: source ? source.installed ? { version: source.version, origin: source.origin, state: row?.state ?? null, note: row?.state_note ?? null } : null : row ? { version: row.version, state: row.state, note: row.state_note } : null,
        ...(source?.installHeld ? { installHeld: source.installHeld, installHeldCode: source.installHeldCode } : {}),
        held,
        installAllowed: client.installAllowed() && !held && !source?.installHeld,
      });
    }
    if (b === 'shots' && c && !d && method === 'GET') {
      if (!client || !/^[0-9a-f]{64}$/.test(c)) throw new HttpError(404, 'Not found');
      // PL2d: a card's icon on the first screen is known from the signed list itself (the item page
      // was never opened, so it isn't remembered yet); before, every icon there was a 404 in the console.
      const path = shotPaths.get(c) ?? client.current()?.index.items.find((i) => i.iconSha === c)?.icon;
      if (!path) throw new HttpError(404, 'Not found');
      let buf: Buffer;
      try {
        buf = await client.shot(path, c);
      } catch (err) {
        fail(err);
      }
      const type = imageType(buf);
      if (!type) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'content-type': TYPES[type], 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      res.end(buf);
      return;
    }

    // ---- installing ----
    if (b === 'install' && !c && method === 'POST') {
      const body = await readJson(req);
      if (!isStoreId(body.id)) throw new HttpError(400, 'Not a store id.');
      policy().guard('store', policy().pins.store === 'off');
      try {
        return send(res, 200, await installer().install(body.id, { ...(typeof body.version === 'string' ? { version: body.version } : {}), community: settings().community, understand: body.understand === true }));
      } catch (err) {
        fail(err);
      }
    }
    if (b === 'mcp' && c) {
      const ins = installer();
      if (!d && method === 'GET') {
        const r = ins.mcpPending(c);
        if (!r) throw new HttpError(404, en('That review has expired.'));
        return send(res, 200, r);
      }
      if (!d && method === 'DELETE') return send(res, 200, { ok: ins.mcpCancel(c) });
      // PRQ: look again for what it needs (after *Install it for me*), then *Continue install*.
      if (d === 'recheck' && method === 'POST') {
        await readJson(req).catch(() => undefined);
        const r = ins.mcpRecheck(c);
        if (!r) throw new HttpError(404, en('That review has expired.'));
        return send(res, 200, r);
      }
      if (d === 'approve' && method === 'POST') {
        const body = await readJson(req);
        try {
          return send(res, 200, await ins.mcpApprove(c, { values: (body.values ?? {}) as Record<string, unknown>, secrets: (body.secrets ?? {}) as Record<string, unknown>, trust: body.trust === true }));
        } catch (err) {
          fail(err);
        }
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (['test', 'update', 'goback', 'remove', 'override'].includes(b ?? '') && !c && method === 'POST') {
      const body = await readJson(req);
      if (!isStoreId(body.item)) throw new HttpError(400, 'Not a store id.');
      const ins = installer();
      try {
        if (b === 'test') {
          const row = app.storeInstalls?.get(body.item);
          if (row?.kind !== 'mcp') throw new InstallError(404, 'missing', 'That tool server was not installed from the store.');
          return send(res, 200, await ins.test(row.local_ref));
        }
        if (b === 'update') return send(res, 200, await ins.update(body.item, { community: settings().community }));
        if (b === 'goback') return send(res, 200, await ins.goBack(body.item));
        if (b === 'remove') {
          await ins.remove(body.item);
          return send(res, 200, { ok: true });
        }
        return send(res, 200, await ins.override(body.item, body.confirm === true));
      } catch (err) {
        fail(err);
      }
    }
    if (b === 'mine' && !c && method === 'GET') return send(res, 200, mine());

    // ---- reports ----
    if (b === 'report' && !c && method === 'POST') {
      const body = await readJson(req);
      if (!isStoreId(body.item)) throw new HttpError(400, 'Not a store id.');
      const row = app.storeInstalls?.get(body.item);
      // The log goes only when ticked, scrubbed, and shown in full first (preview, which sends nothing).
      const scrub = app.hub ? app.hub.scrub.bind(app.hub) : (s: string) => scrubText(s, (x) => app.redactor?.redact(x) ?? x, { dirs: [app.dataDir] });
      const log = body.log === true && row?.kind === 'plugin' && app.pluginManager ? scrub(app.pluginManager.store.logs(row.local_ref, 200).map((l) => `${l.at} ${l.kind} ${l.detail}`).join('\n')).slice(0, 64 * 1024) : undefined;
      if (body.preview === true) return send(res, 200, { log: log ?? '' });
      const hub = desk();
      const text = String(body.text ?? '').trim();
      if (!text) throw new HttpError(400, en('Say what happened.'));
      try {
        const report = await sendReport({ base: hub.base, installId: hub.state.get().id, item: body.item, ...(typeof body.version === 'string' ? { version: body.version } : row ? { version: row.version } : {}), reason: String(body.reason ?? ''), text: hub.scrub(text), ...(typeof body.contact === 'string' ? { contact: body.contact } : {}), ...(log ? { log } : {}), ...(hub.send ? { send: hub.send } : {}) });
        return send(res, 200, { report });
      } catch (err) {
        fail(err);
      }
    }

    // ---- submitting ----
    if (b === 'author' && !c && method === 'GET') {
      const k = authorKey(app.vault, { create: false });
      return send(res, 200, k ? { key: k.fingerprint, short: shortKey(k.fingerprint) } : { key: null });
    }
    if (b === 'pack' && !c && method === 'POST') {
      const type = String(req.headers['content-type'] ?? '');
      let pack: Pack;
      try {
        const k = authorKey(app.vault, { create: false });
        const index = client?.current()?.index;
        const o = { saraVersion, smoke: smokeFence(), dataDirs: [app.dataDir], ...(index ? { index } : {}), ...(k ? { authorKey: k.fingerprint } : {}), ownerNames: ownerNames(app.settings.get().ownerName) };
        if (type.startsWith('application/json')) {
          const body = await readJson(req);
          pack = await packPath(checkServerFolder(String(body.path ?? '')), o);
        } else {
          const buf = await readRaw(req, STORE_COMPANION_LIMITS.maxZipBytes + 1);
          pack = await packFiles(readStoreZip(buf), o, (url.searchParams.get('name') ?? '').replace(/\.zip$/i, '').slice(0, 60));
        }
      } catch (err) {
        fail(err);
      }
      if (pack.size) {
        mkdirSync(packsDir, { recursive: true, mode: 0o700 });
        writeFileAtomic(join(packsDir, `${pack.sha256}.zip`), pack.zip);
        writeFileAtomic(join(packsDir, `${pack.sha256}.json`), JSON.stringify(pack.report));
      }
      return send(res, 200, { pack: pack.size ? pack.sha256 : null, size: pack.size, report: pack.report });
    }
    if (b === 'submit' && !c && method === 'POST') {
      const body = await readJson(req);
      const id = String(body.pack ?? '');
      if (!/^[0-9a-f]{64}$/.test(id) || !existsSync(join(packsDir, `${id}.zip`))) throw new HttpError(404, en('Check it again first.'));
      const name = String(body.name ?? '').trim();
      if (!name) throw new HttpError(400, en('Add the name shown on the store.'));
      if (body.rights !== true || body.rules !== true) throw new HttpError(400, en('Tick both boxes first.'));
      const zip = readFileSync(join(packsDir, `${id}.zip`));
      if (sha256(zip) !== id) throw new HttpError(409, en('Check it again first.'));
      const report = JSON.parse(readFileSync(join(packsDir, `${id}.json`), 'utf8'));
      const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, 200) : '';
      const draft: Draft = { pack: id, name, contact, item: String(report.id), version: String(report.version), at: app.now().toISOString() };
      const hub = desk();
      try {
        const out = await submit({ base: hub.base, installId: hub.state.get().id, vault: app.vault, db: db(), pack: { zip, sha256: id, size: zip.length, report }, name, ...(contact ? { contact } : {}), saraVersion, os: hubOs(), ...(hub.send ? { send: hub.send } : {}) });
        saveDrafts(app.dataDir, drafts(app.dataDir).filter((x) => x.pack !== id));
        return send(res, 200, out);
      } catch (err) {
        // Our desk isn't answering: the draft is kept (nothing is lost; Send again later).
        if (err instanceof DeskError && deskDown(err.status)) saveDrafts(app.dataDir, [...drafts(app.dataDir).filter((x) => x.pack !== id), draft]);
        fail(err);
      }
    }
    if (b === 'submissions') {
      if (!c && method === 'GET') {
        const k = authorKey(app.vault, { create: false });
        return send(res, 200, { submissions: submissions(db()).map(({ token: _t, ...r }) => ({ ...r, messages: JSON.parse(r.messages) })), drafts: drafts(app.dataDir), key: k ? shortKey(k.fingerprint) : null });
      }
      if (!/^SUB-\d{1,9}$/.test(c ?? '')) throw new HttpError(404, 'Not found');
      const hub = desk();
      try {
        if (!d && method === 'GET') {
          const { token: _t, ...r } = await refreshSubmission(db(), hub.base, c!, { ...(hub.send ? { send: hub.send } : {}) });
          return send(res, 200, { ...r, messages: JSON.parse(r.messages) });
        }
        if (d === 'reply' && method === 'POST') {
          const body = await readJson(req);
          await replySubmission(db(), hub.base, c!, hub.scrub(String(body.text ?? '')), { ...(hub.send ? { send: hub.send } : {}) });
          return send(res, 200, { ok: true });
        }
      } catch (err) {
        fail(err);
      }
    }
    if (method !== 'GET') await readJson(req).catch(() => undefined);
    throw new HttpError(404, 'Not found');
  };
}
