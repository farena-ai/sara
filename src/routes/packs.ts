// Phase 127 (2.60.0, docs/design/PACKS.md §13.2): companion packs, for the owner only (`packs` is not
// a member route family, like `store`: members answer 403 ownerOnly; §16 Q9, members don't install
// packs in 2.60). The demo refuses writes.
//   GET  /api/packs/build/:companion             the Share her preview (sections, sizes, locked counts; ?lines=1)
//   POST /api/packs/build/:companion             build + checkCompanion → { report, token }
//   GET  /api/packs/build/:token/file            the zip (clean report only; one use; 15 minutes)
//   POST /api/packs/build/:token/store           keep it for Submit yours (kind: companion)
//   POST /api/packs/preview                      a pack zip, a card PNG/JSON/CHARX or a character file → { token, card }
//   GET|DELETE /api/packs/:token                 the card again / cancel (deletes the staging folder)
//   POST /api/packs/:token/install               { name, skills, picture } → { companion, followUps }
//   GET  /api/packs/installed                    pack_installs rows (and the update state)
//   POST /api/packs/:companion/update            (raw: a newer file) → the update card
//   POST /api/packs/:companion/update/apply      { token, picks }
//   POST /api/packs/:companion/goback | held | strip | keep
//   POST /api/packs/:companion/skills/:review/accept   a follow-up skill review, into her scope
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../chat.ts';
import { CardError } from '../character-cards.ts';
import { writeFileAtomic } from '../fs-util.ts';
import { HttpError, readJson, readRaw, send, SECURITY_HEADERS } from '../http.ts';
import { en } from '../i18n.ts';
import { PackageError } from '../packages.ts';
import { buildPack, packZip, previewModel, type BuildOptions } from '../packs/build.ts';
import { fileToPack } from '../packs/card.ts';
import { applyUpdate, goBack, updateCard, type Pick } from '../packs/diff.ts';
import { PACK_EXT, STORE_COMPANION_LIMITS } from '../packs/format.ts';
import { PackInstaller, PackInstalls, packPaused } from '../packs/install.ts';
import { ownerNames } from '../packs/scrub.ts';
import { SARA_VERSION } from '../plugins/manager.ts';
import { InstallError } from '../store/install.ts';
import { sha256 } from '../store/verify.ts';
import { compareSemver } from '../plugins/manifest.ts';
import { shelfView } from '../store/client.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const TOKEN = /^[A-Za-z0-9_-]{16}$/;
const COMPANION = /^(main|[a-z0-9-]{4,40})$/;
const builds = new Map<string, { zip: Buffer; name: string; report: Record<string, unknown>; ready: boolean; expires: number }>();
let shared: { key: string; installer: PackInstaller } | undefined;

/** The one installer for this server (the owner's main companion's database holds pack_installs). */
export function packInstallerFor(ctx: RouteCtx): PackInstaller | undefined {
  const cm = ctx.opts.companions;
  if (!cm) return undefined;
  const main = cm.main?.app ?? ctx.app;
  const key = `${ctx.rootDir}|${main.dataDir}`;
  if (shared?.key === key) return shared.installer;
  const installer = new PackInstaller({ app: main, companions: cm, rootDir: ctx.rootDir, saraVersion: ctx.info.version, installs: new PackInstalls(main.store.db), ...(main.storeClient ? { client: main.storeClient } : {}), ...(main.storeInstalls ? { storeInstalls: main.storeInstalls } : {}) });
  shared = { key, installer };
  return installer;
}

function fail(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof InstallError) throw new HttpError(err.status || 400, err.message, { code: err.code, ...((err as unknown as { report?: unknown }).report ? { report: slim((err as unknown as { report: Record<string, unknown> }).report) } : {}) });
  if (err instanceof CardError || err instanceof PackageError) throw new HttpError(400, err.message);
  throw new HttpError(400, (err as Error).message);
}
/** The report without her whole sheet (the card carries that). */
const slim = (r: Record<string, unknown>) => {
  const { pack: _p, persona: _s, ...rest } = r;
  void _p;
  void _s;
  return rest;
};

export function createPackRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'packs') return NEXT;
    if (opts.member || app.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    if (opts.demo && method !== 'GET') {
      await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Not on the demo server.'));
    }
    const cm = opts.companions;
    const installer = packInstallerFor(ctx);
    if (!cm || !installer) throw new HttpError(404, en('More companions are not available on this server.'));
    const comp = (id: string | undefined): AppContext => {
      const x = id && COMPANION.test(id) ? cm.get(id) : undefined;
      if (!x) throw new HttpError(404, en('No such companion.'));
      return x.app;
    };
    const url = new URL(req.url ?? '/', 'http://x');
    const peopleNames = (x: AppContext): string[] => {
      try {
        return (x.store.db.prepare('SELECT name, full_name FROM people').all() as { name: string; full_name: string | null }[]).flatMap((r) => [r.name, r.full_name ?? '']).filter((n) => n.trim().length >= 2);
      } catch {
        return [];
      }
    };

    // ---- Share her ----
    if (b === 'build' && c && !d) {
      if (method === 'GET') return send(res, 200, previewModel(comp(c), { lines: url.searchParams.get('lines') === '1' }));
      if (method === 'POST') {
        const target = comp(c);
        const body = await readJson(req);
        const inc = (body.include ?? {}) as Record<string, unknown>;
        const o: BuildOptions = {
          include: {
            dials: inc.dials !== false,
            look: inc.look !== false,
            closet: Array.isArray(inc.closet) ? inc.closet.map(String).slice(0, 6) : [],
            reference: inc.reference === true,
            voice: inc.voice !== false,
            greeting: inc.greeting !== false,
            skills: Array.isArray(inc.skills) ? inc.skills.map(String).slice(0, 8) : [],
            routines: Array.isArray(inc.routines) ? (inc.routines as unknown[]).slice(0, 5).map((r) => (typeof r === 'string' ? { id: r } : (r as { id: string }))) : [],
          },
          rating: body.rating === 'mature' || body.rating === 'explicit' ? body.rating : 'general',
          romance: body.romance === true,
          license: typeof body.license === 'string' ? body.license.slice(0, 40) : 'CC-BY-4.0',
          remix: body.remix === 'ask' || body.remix === 'no' ? body.remix : 'yes',
          author: String(body.author ?? '').slice(0, 60),
          ...(body.rights && typeof body.rights === 'object' ? { rights: body.rights as BuildOptions['rights'] } : {}),
          consent: body.consent === true,
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          saraVersion: app.pluginManager?.version ?? SARA_VERSION,
          people: peopleNames(target),
        };
        if (body.made !== true) throw new HttpError(400, en('Tick “I made her, or I have the right to share everything in this pack” first.'));
        let built;
        try {
          built = buildPack(target, o);
        } catch (err) {
          fail(err);
        }
        const token = sha256(`${Date.now()}:${Math.random()}`).slice(0, 16);
        const now = Date.now();
        for (const [k, v] of builds) if (v.expires < now) builds.delete(k);
        const zip = packZip(built.files);
        builds.set(token, { zip, name: `${built.manifest.id}${PACK_EXT}`, report: slim(built.report as unknown as Record<string, unknown>), ready: built.report.ready, expires: now + 15 * 60_000 });
        return send(res, 200, { token, report: slim(built.report as unknown as Record<string, unknown>), notes: built.notes, replaced: built.replaced.length, size: zip.length, manifest: built.manifest });
      }
    }
    if (b === 'build' && c && TOKEN.test(c) && d === 'file' && method === 'GET') {
      const x = builds.get(c);
      if (!x || x.expires < Date.now()) throw new HttpError(404, en('Check it again first.'));
      if (!x.ready) throw new HttpError(409, en('Fix the problems in the report first.'));
      builds.delete(c);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${x.name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end(x.zip);
    }
    if (b === 'build' && c && TOKEN.test(c) && d === 'store' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const x = builds.get(c);
      if (!x || x.expires < Date.now()) throw new HttpError(404, en('Check it again first.'));
      // The store's own rules (listing, rights, licence) on the same files, with the owner-name check run here.
      const { packFiles, readStoreZip } = await import('../store/pack.ts');
      const pack = await packFiles(readStoreZip(x.zip), { saraVersion: app.pluginManager?.version ?? SARA_VERSION, ownerNames: [...ownerNames(app.settings.get().ownerName), ...peopleNames(app)], consent: true, smoke: false });
      const dir = join(app.dataDir, 'store', 'packs');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(dir, `${pack.sha256}.zip`), pack.zip);
      writeFileAtomic(join(dir, `${pack.sha256}.json`), JSON.stringify(pack.report));
      return send(res, 200, { pack: pack.sha256, size: pack.size, report: pack.report });
    }

    // ---- From a file (a pack, a card or a character file) ----
    if (b === 'preview' && !c && method === 'POST') {
      const raw = await readRaw(req, STORE_COMPANION_LIMITS.maxZipBytes + 1);
      if (!raw.length) throw new HttpError(400, en('Choose a companion pack, a character card or a character file.'));
      try {
        const got = fileToPack(raw);
        const update = url.searchParams.get('update');
        if (update) {
          const target = comp(update);
          const { checkCompanion } = await import('../packs/checks.ts');
          const report = checkCompanion(got.files, { mode: 'install' });
          if (report.minors) throw new InstallError(400, 'minors', report.results.find((r) => r.id === 'minors')!.problems[0]);
          return send(res, 200, { update: updateCard(target, update, got.files, report, app.settings.get().ownerName) });
        }
        const { card } = installer.preview(got.files, { origin: got.pack ? 'file' : 'card', ...(got.pack ? {} : { source: got.source, creator: got.creator }), notes: got.notes });
        return send(res, 200, { token: card.token, card: { ...card, face: faceOf(installer, card.token) } });
      } catch (err) {
        fail(err);
      }
    }
    if (b === 'installed' && !c && method === 'GET') {
      const shelf = app.storeClient ? ((shelfView(app.storeClient, { saraVersion: app.pluginManager?.version ?? SARA_VERSION, on: true, community: true }).items as { id: string; version: string }[]) ?? []) : [];
      const rows = installer.d.installs.all().map((r) => {
        const s = r.origin === 'store' ? shelf.find((x) => x.id === r.pack_id) : undefined;
        const c0 = cm.get(r.companion_id);
        return { ...r, name: c0?.app.persona.name ?? null, update: s && compareSemver(s.version, r.version) > 0 ? s.version : null, paused: c0 ? (packPaused(c0.app.dataDir) ?? null) : null };
      });
      return send(res, 200, { installs: rows });
    }
    // ---- the card ----
    if (b && TOKEN.test(b) && installer.pending(b)) {
      if (!c && method === 'GET') return send(res, 200, { card: { ...installer.pending(b)!, face: faceOf(installer, b) } });
      if (!c && method === 'DELETE') return send(res, 200, { ok: installer.cancel(b) });
      if (c === 'install' && method === 'POST') {
        const body = await readJson(req);
        try {
          return send(res, 200, await installer.install(b, { ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(Array.isArray(body.skills) ? { skills: body.skills.map(String) } : {}), ...(body.picture === false ? { picture: false } : {}) }));
        } catch (err) {
          fail(err);
        }
      }
    }
    if (b && TOKEN.test(b) && (c === 'install' || !c) && method !== 'GET') {
      await readJson(req).catch(() => undefined);
      throw new HttpError(404, en('This card has expired. Choose the pack again.'));
    }
    // ---- a companion made from a pack ----
    if (b && COMPANION.test(b) && c && method === 'POST') {
      const target = comp(b);
      const now = app.now();
      try {
        if (c === 'update' && !d) {
          const raw = await readRaw(req, STORE_COMPANION_LIMITS.maxZipBytes + 1);
          const got = fileToPack(raw);
          const { checkCompanion } = await import('../packs/checks.ts');
          const report = checkCompanion(got.files, { mode: 'install' });
          if (report.minors) throw new InstallError(400, 'minors', report.results.find((r) => r.id === 'minors')!.problems[0]);
          return send(res, 200, updateCard(target, b, got.files, report, app.settings.get().ownerName));
        }
        if (c === 'update' && d === 'apply') {
          const body = await readJson(req);
          return send(res, 200, applyUpdate(target, String(body.token ?? ''), (body.picks ?? {}) as Record<string, Pick>, installer.d.installs, now));
        }
        if (c === 'goback') {
          await readJson(req).catch(() => undefined);
          return send(res, 200, goBack(target, b, installer.d.installs, now));
        }
        if (c === 'held') {
          await readJson(req).catch(() => undefined);
          return send(res, 200, installer.addHeld(b));
        }
        if (c === 'strip' || c === 'keep') {
          const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
          if (c === 'keep' && body.confirm !== true) throw new HttpError(400, en('The Sara team pulled her. Keep her anyway?'));
          installer.resolve(b, c);
          return send(res, 200, { ok: true });
        }
        if (c === 'skills' && d && e === 'accept') {
          const body = await readJson(req);
          if (!target.skills) throw new HttpError(404, en('Skills aren’t available here.'));
          const added = target.skills.accept(d, 'companion', Array.isArray(body.names) ? body.names.map(String) : undefined);
          return send(res, 200, { skills: added.map((s) => s.name) });
        }
      } catch (err) {
        fail(err);
      }
    }
    if (method !== 'GET') await readJson(req).catch(() => undefined);
    throw new HttpError(404, 'Not found');
  };
}

/** Her face on the card: the pack's portrait or cover (a data: URL, shown with the card). */
function faceOf(installer: PackInstaller, token: string): string | null {
  const files = installer.stagedFiles(token) ?? [];
  const f = files.find((x) => x.path === 'look/sara-portrait.jpg') ?? files.find((x) => x.path === 'cover.png');
  if (!f || f.data.length > 1024 * 1024) return null;
  return `data:${f.path.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${f.data.toString('base64')}`;
}
