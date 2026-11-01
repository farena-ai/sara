// Admin: settings, backups, logs, doctor, status, health history, updates, access, desktop apps, safety stats, search, tools, MCP, checklist.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupName, BACKUPS_DIR, createBackup, DEFAULT_BACKUP, listBackups } from '../backup.ts';
import { HISTORY_BUDGET_CHARS } from '../chat.ts';
import { checklist } from '../checklist.ts';
import { CONTRADICT_MODES, type ContradictMode, contradictSettings } from '../contradict.ts';
import { runDoctor } from '../doctor.ts';
import { healthReport } from '../health.ts';
import { as400, HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { appLanguage, toLang } from '../i18n.ts';
import { mcpSecrets, mergeSecrets, searchConfig } from '../integrations.ts';
import { proactiveSettings } from '../life.ts';
import { isCloudModel } from '../modelpicks.ts';
import { privateLocalOn } from '../net-guard.ts';
import { copyOffsite, offsiteSettings, testOffsite } from '../offsite-run.ts';
import { OFFSITE_PASS_VAULT, OFFSITE_S3_VAULT } from '../offsite.ts';
import { accessInfo, adminHelp, systemName } from '../platform.ts';
import { onThisComputer } from '../private-local.ts';
import { qrSvg } from '../qr.ts';
import { ROUTE_PURPOSES, type RoutePurpose, type Settings } from '../settings.ts';
import { MCP_PRESETS, type McpServerConfig, mcpVaultKey, validateMcpConfig } from '../tools/mcp.ts';
import { noSandboxNote } from '../tools/sandbox.ts';
import { SEARCH_PROVIDERS, type SearchProvider, searchVaultKey } from '../tools/search.ts';
import { type Permission, PERMISSIONS } from '../tools/types.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** Phase 38: up to two backup models ({providerId, model}) from a request, checked. */
function cleanModelList(v: unknown, localOnly: boolean): { providerId: string; model: string }[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'Backups must be a list.');
  return v.slice(0, 2).flatMap((x) => {
    const r = (x ?? {}) as { providerId?: unknown; model?: unknown };
    const providerId = String(r.providerId ?? '');
    const model = String(r.model ?? '').trim().slice(0, 200);
    if (!providerId || !model) return [];
    if (localOnly && isCloudModel(model)) throw new HttpError(400, '{model} is an Ollama cloud model; private conversations need a model on your own hardware.', { params: { model } });
    return [{ providerId, model }];
  });
}

export function createAdminRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, info, opts, rootDir, updater } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a === 'settings') {
      if (method === 'GET') {
        const s = app.settings.get();
        return send(res, 200, {
          ownerName: s.ownerName ?? '',
          timeZone: s.timeZone ?? '',
          historyBudgetChars: s.historyBudgetChars ?? HISTORY_BUDGET_CHARS,
          defaultProviderId: s.defaultProviderId ?? null,
          defaultModel: s.defaultModel ?? null,
          routes: s.routes ?? {},
          safetyClassifier: s.safetyClassifier ?? null,
          claimJudge: s.claimJudge ?? null,
          fallbackAfterSec: s.fallbackAfterSec ?? 60,
          defaultFallbacks: s.defaultFallbacks ?? [],
          companionModel: s.companionModel ?? null,
          // Phase 56: retired models in use switch to their replacement (default on).
          modelAutoSwitch: s.modelAutoSwitch !== false,
          innerLife: s.persona?.innerLife !== false,
          typing: s.persona?.typing ?? 'instant',
          proactive: proactiveSettings(app),
          // Phase 53: app language, her talk language, the yearly look back.
          language: s.language ?? 'auto',
          languageDetected: s.languageDetected ?? null,
          appLanguage: appLanguage(s),
          talkLanguage: s.talkLanguage ?? 'auto',
          storyYearly: s.story?.yearly === true,
          // Phase 46: how the owner reaches her (read-only; the installer sets it).
          access: accessInfo(),
          // Phase 46c: admin commands in this system's words (sudo sara … / sara … / docker …).
          admin: adminHelp(),
        });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const patch: Partial<Settings> = {};
        // Phase 67: while nothing may leave this computer, a newly picked model must be on it.
        const pausedPick = (prov: { kind: import('../providers/types.ts').ProviderKind; baseUrl: string; label: string }, model: string | undefined, was?: { providerId: string; model: string }) => {
          if (!privateLocalOn() || onThisComputer(prov, model)) return;
          if (was && was.model === model && app.settings.get().providers.find((p) => p.id === was.providerId)?.label === prov.label) return; // unchanged: kept (and paused)
          throw new HttpError(409, '{provider} is paused in private local mode: it isn\'t on this computer. Pick a model on this computer, or turn "Nothing leaves this computer" off first.', { params: { provider: prov.label } });
        };
        if (body.ownerName !== undefined) patch.ownerName = String(body.ownerName).slice(0, 80);
        // Phase 53: languages ('auto' or one of ours) and the yearly look back.
        const langPick = (v: unknown, what: string) => {
          if (v === 'auto' || v === '' || v === null) return 'auto';
          const l = toLang(v);
          if (!l || l !== v) throw new HttpError(400, '{what}: unknown language.', { params: { what } });
          return l;
        };
        if (body.language !== undefined) patch.language = langPick(body.language, 'Language');
        if (body.talkLanguage !== undefined) patch.talkLanguage = langPick(body.talkLanguage, 'Talk to me in');
        if (body.languageDetected !== undefined) patch.languageDetected = toLang(body.languageDetected) ?? 'en';
        if (body.storyYearly !== undefined) patch.story = { ...app.settings.get().story, yearly: Boolean(body.storyYearly) };
        if (body.historyBudgetChars !== undefined) {
          const n = Number(body.historyBudgetChars);
          if (!Number.isFinite(n) || n < 8_000 || n > 2_000_000) throw new HttpError(400, 'Conversation length must be between 8,000 and 2,000,000 characters.');
          patch.historyBudgetChars = Math.round(n);
        }
        if (body.timeZone !== undefined) {
          const tz = String(body.timeZone);
          if (tz) {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: tz });
            } catch {
              throw new HttpError(400, 'Unknown time zone');
            }
          }
          patch.timeZone = tz || undefined;
        }
        if (body.defaultProviderId !== undefined) {
          const id = body.defaultProviderId ? String(body.defaultProviderId) : undefined;
          if (id && !app.settings.get().providers.some((p) => p.id === id)) throw new HttpError(400, 'Unknown provider');
          const cur = app.settings.get();
          if (id && id !== cur.defaultProviderId) pausedPick(cur.providers.find((p) => p.id === id)!, body.defaultModel ? String(body.defaultModel) : undefined);
          patch.defaultProviderId = id;
        }
        if (body.defaultModel !== undefined) patch.defaultModel = body.defaultModel ? String(body.defaultModel).slice(0, 200) : undefined;
        if (body.routes !== undefined) {
          if (!body.routes || typeof body.routes !== 'object') throw new HttpError(400, 'routes must be an object');
          const routes: NonNullable<Settings['routes']> = {};
          for (const [k, v] of Object.entries(body.routes as Record<string, unknown>)) {
            if (!ROUTE_PURPOSES.includes(k as RoutePurpose)) throw new HttpError(400, 'Unknown route "{route}"', { params: { route: k } });
            if (!v) continue;
            const r = v as { providerId?: unknown; model?: unknown };
            const pid = String(r.providerId ?? '');
            const prov = app.settings.get().providers.find((p) => p.id === pid);
            if (!prov) throw new HttpError(400, 'Route "{route}": unknown provider', { params: { route: k } });
            if (k === 'private' && !prov.local) throw new HttpError(400, 'The private route must use a local provider; {provider} isn\'t marked local.', { params: { provider: prov.label } });
            const model = String(r.model ?? '').trim().slice(0, 200);
            if (!model) throw new HttpError(400, 'Route "{route}": choose a model', { params: { route: k } });
            if (k === 'private' && isCloudModel(model)) throw new HttpError(400, '{model} is an Ollama cloud model (it runs on Ollama\'s servers). Private conversations need a model on your own hardware.', { params: { model } });
            const was = app.settings.get().routes?.[k as RoutePurpose];
            pausedPick(prov, model, was);
            const fallbacks = cleanModelList((v as { fallbacks?: unknown }).fallbacks, k === 'private');
            routes[k as RoutePurpose] = { providerId: pid, model, ...(fallbacks.length ? { fallbacks } : {}) };
          }
          patch.routes = routes;
        }
        // Phase 38: backups for the default model, how long to wait, her own model.
        if (body.defaultFallbacks !== undefined) patch.defaultFallbacks = cleanModelList(body.defaultFallbacks, false);
        if (body.fallbackAfterSec !== undefined) {
          const n = Math.round(Number(body.fallbackAfterSec));
          if (!Number.isFinite(n) || n < 10 || n > 300) throw new HttpError(400, 'Switch after: between 10 and 300 seconds.');
          patch.fallbackAfterSec = n;
        }
        if (body.companionModel !== undefined) {
          const c = body.companionModel as { providerId?: unknown; model?: unknown } | null;
          if (!c || !c.providerId) patch.companionModel = undefined;
          else {
            const prov = app.settings.get().providers.find((p) => p.id === String(c.providerId));
            const model = String(c.model ?? '').trim().slice(0, 200);
            if (!prov || !model) throw new HttpError(400, 'Her model: choose a provider and a model.');
            pausedPick(prov, model, app.settings.get().companionModel);
            patch.companionModel = { providerId: prov.id, model };
          }
        }
        if (body.safetyClassifier !== undefined) {
          const c = body.safetyClassifier as { providerId?: unknown; model?: unknown } | null;
          if (!c || !c.providerId) patch.safetyClassifier = undefined;
          else {
            const prov = app.settings.get().providers.find((p) => p.id === String(c.providerId));
            if (!prov) throw new HttpError(400, 'Safety classifier: unknown provider');
            const model = String(c.model ?? '').trim();
            if (!model) throw new HttpError(400, 'Safety classifier: choose a model');
            patch.safetyClassifier = { providerId: prov.id, model };
          }
        }
        if (body.claimJudge !== undefined) {
          // Phase 62: the claim judge uses only the model picked here (a cloud one only if picked).
          const c = body.claimJudge as { providerId?: unknown; model?: unknown } | null;
          if (!c || !c.providerId) patch.claimJudge = undefined;
          else {
            const prov = app.settings.get().providers.find((p) => p.id === String(c.providerId));
            if (!prov) throw new HttpError(400, 'Claim check: unknown provider');
            const model = String(c.model ?? '').trim();
            if (!model) throw new HttpError(400, 'Claim check: choose a model');
            patch.claimJudge = { providerId: prov.id, model };
          }
        }
        if (body.modelAutoSwitch !== undefined) patch.modelAutoSwitch = Boolean(body.modelAutoSwitch);
        if (body.innerLife !== undefined) patch.persona = { ...app.settings.get().persona, ...patch.persona, innerLife: Boolean(body.innerLife) };
        if (body.typing === 'instant' || body.typing === 'human') patch.persona = { ...app.settings.get().persona, ...patch.persona, typing: body.typing };
        if (body.proactive !== undefined) {
          const p = (body.proactive ?? {}) as Record<string, unknown>;
          const cur = proactiveSettings(app);
          const hour = (x: unknown, d: number) => (x === undefined ? d : Math.min(23, Math.max(0, Math.round(Number(x)))));
          patch.proactive = {
            enabled: p.enabled === undefined ? cur.enabled : Boolean(p.enabled),
            maxPerDay: p.maxPerDay === undefined ? cur.maxPerDay : Math.min(10, Math.max(0, Math.round(Number(p.maxPerDay) || 0))),
            quietStart: hour(p.quietStart, cur.quietStart),
            quietEnd: hour(p.quietEnd, cur.quietEnd),
            minGapHours: p.minGapHours === undefined ? cur.minGapHours : Math.min(168, Math.max(1, Number(p.minGapHours) || cur.minGapHours)),
          };
        }
        const langBefore = appLanguage(app.settings.get());
        app.settings.update(patch);
        // Phase 107: the owner's command menus follow his app language.
        if (appLanguage(app.settings.get()) !== langBefore) for (const b of [app.bridges?.telegram, app.bridges?.discord]) void b?.registerMenus().catch(() => undefined);
        return send(res, 200, { ok: true });
      }
    }

    if (a === 'safety' && b === 'stats' && method === 'GET') return send(res, 200, app.store.safetyEventCounts());

    if (a === 'tools' && !b) {
      if (method === 'GET') {
        const s = app.settings.get();
        return send(res, 200, {
          tools: app.tools.list().map((t) => ({
            name: t.spec.name,
            description: t.spec.description,
            defaultPermission: t.defaultPermission,
            permission: app.tools.permission(t.spec.name, s.toolPermissions),
            source: t.source ?? 'built-in',
            available: t.isAvailable?.() ?? true,
          })),
          sandbox: { mode: app.sandbox.mode, detail: app.sandbox.detail, ...(app.sandbox.mode === 'none' ? { note: noSandboxNote() } : {}) },
          shellNetwork: s.shellNetwork ?? true,
          // Phase 77: check her plans against what you decided (switch + strictness).
          contradict: contradictSettings(s),
          // Phase 49: the browser she tests web apps with.
          browser: app.browsers ? (({ found, name, how }) => ({ found, name: name ?? null, how }))(new URL(req.url ?? '/', 'http://x').searchParams.get('recheck') ? app.browsers.refresh() : app.browsers.status()) : { found: false, name: null, how: 'Not available on this server.' },
        });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const patch: Partial<Settings> = {};
        if (body.permissions !== undefined) {
          if (!body.permissions || typeof body.permissions !== 'object') throw new HttpError(400, 'permissions must be an object');
          const perms: Record<string, Permission> = { ...app.settings.get().toolPermissions };
          for (const [name, value] of Object.entries(body.permissions as Record<string, unknown>)) {
            if (!app.tools.get(name)) throw new HttpError(400, 'Unknown tool {name}', { params: { name } });
            if (!PERMISSIONS.includes(value as Permission)) throw new HttpError(400, 'Invalid permission for {name}', { params: { name } });
            perms[name] = value as Permission;
          }
          patch.toolPermissions = perms;
        }
        if (body.shellNetwork !== undefined) patch.shellNetwork = Boolean(body.shellNetwork);
        if (body.contradict !== undefined) {
          if (!body.contradict || typeof body.contradict !== 'object') throw new HttpError(400, 'contradict must be an object');
          const c = body.contradict as { on?: unknown; mode?: unknown };
          const cur = contradictSettings(app.settings.get());
          patch.contradict = { on: c.on === undefined ? cur.on : Boolean(c.on), mode: CONTRADICT_MODES.includes(c.mode as ContradictMode) ? (c.mode as ContradictMode) : cur.mode };
        }
        app.settings.update(patch);
        return send(res, 200, { ok: true });
      }
    }

    if (a === 'search' && !b) {
      if (method === 'GET') {
        const s = app.settings.get().search;
        return send(res, 200, {
          providers: SEARCH_PROVIDERS,
          provider: s?.provider ?? null,
          url: s?.url ?? '',
          hasKey: s ? app.vault.has(searchVaultKey(s.provider)) : false,
          ready: Boolean(searchConfig(app.settings, app.vault)),
        });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        if (!body.provider) {
          app.settings.update({ search: undefined });
          return send(res, 200, { ok: true });
        }
        const provider = body.provider as SearchProvider;
        if (!SEARCH_PROVIDERS.includes(provider)) throw new HttpError(400, 'Unknown search provider');
        let url: string | undefined;
        if (provider === 'searxng') {
          try {
            url = new URL(String(body.url ?? '')).href;
          } catch {
            throw new HttpError(400, 'SearXNG needs a valid URL');
          }
        }
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) app.vault.set(searchVaultKey(provider), body.apiKey.trim());
        app.settings.update({ search: { provider, ...(url ? { url } : {}) } });
        return send(res, 200, { ok: true });
      }
    }

    if (a === 'mcp' && b === 'presets' && method === 'GET') return send(res, 200, MCP_PRESETS);
    if (a === 'mcp') {
      const view = () =>
        (app.settings.get().mcpServers ?? []).map((cfg) => {
          const conn = app.mcp?.get(cfg.name);
          const sec = mcpSecrets(app.vault, cfg.name);
          return {
            ...cfg,
            status: cfg.enabled ? (conn?.status ?? 'stopped') : 'disabled',
            error: conn?.error ?? '',
            tools: conn?.tools.map((t) => t.name) ?? [],
            envKeys: Object.keys(sec.env ?? {}),
            headerKeys: Object.keys(sec.headers ?? {}),
          };
        });
      if (!b && method === 'GET') return send(res, 200, await view());
      if (b && !c && method === 'PUT') {
        const body = await readJson(req);
        let cfg: McpServerConfig;
        try {
          cfg = validateMcpConfig(body, b);
          const cur = mcpSecrets(app.vault, b);
          const next = { env: mergeSecrets(cur.env, body.env), headers: mergeSecrets(cur.headers, body.headers) };
          app.vault.set(mcpVaultKey(b), JSON.stringify(next));
        } catch (err) {
          throw as400(err);
        }
        const servers = (app.settings.get().mcpServers ?? []).filter((s) => s.name !== b).concat(cfg);
        app.settings.update({ mcpServers: servers });
        await app.mcp?.start(cfg);
        return send(res, 200, await view());
      }
      if (b && !c && method === 'DELETE') {
        app.mcp?.stop(b);
        app.settings.update({ mcpServers: (app.settings.get().mcpServers ?? []).filter((s) => s.name !== b) });
        app.vault.delete(mcpVaultKey(b));
        return send(res, 200, await view());
      }
      if (b && c === 'restart' && method === 'POST') {
        const cfg = (app.settings.get().mcpServers ?? []).find((s) => s.name === b);
        if (!cfg) throw new HttpError(404, 'MCP server not found');
        await app.mcp?.start(cfg);
        return send(res, 200, await view());
      }
    }

    if (a === 'doctor' && !b && method === 'GET') return send(res, 200, await runDoctor({ dataDir: rootDir, settings: app.settings, vault: app.vault, subscriptions: app.subscriptions, now: app.now(), sandbox: app.sandbox, tools: app.tools }));
    if (a === 'status' && !b && method === 'GET') return send(res, 200, healthReport(app, opts.info ?? { version: 'dev', revision: null, startedAt: new Date().toISOString() }));
    // Phase 30: health history (chart) and Sara's log (recent problems, download).
    if (a === 'health' && b === 'history' && method === 'GET') {
      const days = new URL(req.url ?? '/', 'http://x').searchParams.get('days');
      const h = app.healthHistory;
      if (!h) return send(res, 200, { buckets: [], up: 0 });
      return send(res, 200, days ? h.history({ days: Math.min(31, Math.max(1, Number(days) || 7)) }) : h.history({ hours: 24 }));
    }
    if (a === 'logs' && method === 'GET') {
      const log = app.log;
      if (!b) return send(res, 200, { lines: log ? log.recent({ problems: new URL(req.url ?? '/', 'http://x').searchParams.get('problems') === '1', limit: 100 }) : [] });
      if (b === 'download') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="sara-log-${app.now().toISOString().slice(0, 10)}.txt"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(log ? log.text() : '');
      }
    }
    if (a === 'backups' && b === 'offsite') {
      const view = () => {
        const o = offsiteSettings(app);
        return { ...o, hasPassphrase: app.vault.has(OFFSITE_PASS_VAULT), hasS3Secret: app.vault.has(OFFSITE_S3_VAULT) };
      };
      if (!c && method === 'GET') return send(res, 200, await view());
      if (!c && method === 'PUT') {
        const body = await readJson(req);
        const cur = offsiteSettings(app);
        const kind = body.kind === 'folder' || body.kind === 's3' ? body.kind : body.kind === 'off' ? 'off' : cur.kind;
        const next = { ...cur, kind } as typeof cur;
        if (body.path !== undefined) {
          const p = String(body.path).trim();
          if (p && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) throw new HttpError(400, 'Use a full folder path, like {example}.', { params: { example: process.platform === 'win32' ? 'D:\\Backups\\Sara' : process.platform === 'darwin' ? '/Volumes/Backup/Sara' : '/mnt/backup-drive/sara' } });
          next.path = p || undefined;
        }
        for (const k of ['endpoint', 'bucket', 'region', 'accessKeyId', 'prefix'] as const) if (body[k] !== undefined) next[k] = String(body[k]).trim().slice(0, 300) || undefined;
        if (next.endpoint && !/^https?:\/\//.test(next.endpoint)) throw new HttpError(400, 'The storage endpoint must start with https://');
        if (body.keep !== undefined) next.keep = Math.max(1, Math.min(365, Math.round(Number(body.keep) || 14)));
        if (typeof body.passphrase === 'string' && body.passphrase) {
          if (body.passphrase.length < 10) throw new HttpError(400, 'Use a passphrase of at least 10 characters.');
          app.vault.set(OFFSITE_PASS_VAULT, body.passphrase);
        }
        if (typeof body.s3Secret === 'string' && body.s3Secret) app.vault.set(OFFSITE_S3_VAULT, body.s3Secret);
        app.settings.update({ offsite: next });
        return send(res, 200, await view());
      }
      if (c === 'test' && method === 'POST') {
        // Phase 30: restore the newest off-server copy into a temporary folder and check it.
        await testOffsite(app);
        return send(res, 200, await view());
      }
      if (c === 'upload' && method === 'POST') {
        const latest = listBackups(rootDir)[0];
        if (!latest) throw new HttpError(400, 'There is no backup yet. Press "Back up now" first.');
        try {
          await copyOffsite(app, join(rootDir, BACKUPS_DIR, latest.name));
        } catch (err) {
          throw new HttpError(502, (err as Error).message);
        }
        return send(res, 200, await view());
      }
    }
    if (a === 'backups') {
      const cfg = () => ({ ...DEFAULT_BACKUP, ...app.settings.get().backup });
      if (!b && method === 'GET') return send(res, 200, { ...cfg(), backups: listBackups(rootDir) });
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        const keep = body.keep === undefined ? cfg().keep : Math.max(1, Math.min(60, Math.round(Number(body.keep) || 7)));
        app.settings.update({ backup: { auto: body.auto === undefined ? cfg().auto : Boolean(body.auto), keep } });
        return send(res, 200, { ...cfg(), backups: listBackups(rootDir) });
      }
      if (!b && method === 'POST') {
        const name = backupName(app.now());
        const m = createBackup(rootDir, join(rootDir, BACKUPS_DIR, name), { saraVersion: opts.info?.version, now: app.now() });
        return send(res, 200, { name, files: m.files, backups: listBackups(rootDir) });
      }
      if (b && method === 'GET') {
        const item = listBackups(rootDir).find((x) => x.name === b);
        if (!item) throw new HttpError(404, 'No such backup');
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${item.name}"`, 'content-length': item.size, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        createReadStream(join(rootDir, BACKUPS_DIR, item.name)).pipe(res);
        return;
      }
      if (b && method === 'DELETE') {
        const item = listBackups(rootDir).find((x) => x.name === b);
        if (!item) throw new HttpError(404, 'No such backup');
        rmSync(join(rootDir, BACKUPS_DIR, item.name), { force: true });
        return send(res, 200, { ...cfg(), backups: listBackups(rootDir) });
      }
    }
    // Phase 33: the desktop apps, when the owner has put them in <data>/downloads (see docs/desktop.md).
    if (a === 'desktop-apps' && method === 'GET') {
      const dir = join(app.rootDir ?? app.dataDir, 'downloads');
      const files = { windows: 'Sara.exe', mac: 'Sara.dmg' } as const;
      if (!b) {
        const out: Record<string, { size: number; updated: string } | null> = {};
        for (const [k, f] of Object.entries(files)) {
          const st = statSync(join(dir, f), { throwIfNoEntry: false });
          out[k] = st?.isFile() ? { size: st.size, updated: st.mtime.toISOString() } : null;
        }
        return send(res, 200, out);
      }
      const name = files[b as keyof typeof files];
      const st = name ? statSync(join(dir, name), { throwIfNoEntry: false }) : undefined;
      if (!name || !st?.isFile()) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void createReadStream(join(dir, name)).pipe(res);
    }

    // Phase 23: "Getting started" on the Today page.
    if (a === 'checklist' && !b) {
      const view = () =>
        checklist(app, {
          devices: auth.devices().map((d) => d.label),
          pushDevices: (app.push?.list().length ?? 0) + (app.push?.apns?.devices().length ?? 0),
          personaCustom: existsSync(join(app.dataDir, 'persona.json')),
        });
      if (method === 'GET') return send(res, 200, await view());
      if (method === 'PUT') {
        const body = await readJson(req);
        app.settings.update({ checklistHidden: body.hidden === true });
        return send(res, 200, await view());
      }
    }
    // Phase 46: how the owner reaches her (set by the installer; read-only here).
    if (a === 'access' && !b && method === 'GET') {
      const acc = accessInfo();
      return send(res, 200, { ...acc, system: systemName(), ...(acc.url ? { qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(acc.url)).toString('base64')}` } : {}) });
    }
    // Phase 23: updates from Settings (native installs; the root updater does the work).
    if (a === 'update' && !b) {
      const view = () => ({ available: updater.available && !opts.demo, how: updater.how, version: info.version, revision: info.revision, status: updater.status(app.now()) });
      if (method === 'GET') return send(res, 200, await view());
      if (method === 'POST') {
        if (opts.demo) throw new HttpError(403, 'Not in the demo.');
        if (privateLocalOn()) throw new HttpError(409, 'Paused in private local mode: checking for updates needs the internet.');
        const body = await readJson(req);
        // Phase 46: Windows and macOS check the release page; the installer does the update.
        if (updater.how === 'release') {
          const status = body.action === 'update' ? await updater.update(app.now()) : await updater.check(app.now());
          return send(res, 200, { ...view(), status });
        }
        try {
          updater.request(body.action === 'update' ? 'update' : 'check');
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
        return send(res, 202, await view());
      }
    }
    return NEXT;
  };
}
