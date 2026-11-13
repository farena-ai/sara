import { randomUUID } from 'node:crypto';
import { PUBLIC_MCP_INVESTIGATIONS } from '../addons/discovery.ts';
import { PUBLIC_DEVELOPER_CONNECTIONS } from '../addons/developer-connections.ts';
import { createBackupAsync } from '../backup-async.ts';

const activeBackupFiles = new Set<string>();
// Admin: settings, backups, logs, doctor, status, health history, updates, access, desktop apps, safety stats, search, tools, MCP, checklist.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupName, BACKUPS_DIR, DEFAULT_BACKUP, listBackups } from '../backup.ts';
import { HISTORY_BUDGET_CHARS, historyBudgetFor, historyMode, primeBudget } from '../chat.ts';
import { HARD_MAX_CHARS, MIN_HISTORY_CHARS, type HistoryMode } from '../model-context.ts';
import { cleanAppearance } from '../appearance.ts';
import { checklist } from '../checklist.ts';
import { appMenu } from '../bridges/commands.ts';
import { CONTRADICT_MODES, type ContradictMode, contradictSettings } from '../contradict.ts';
import { doctorDataSources, runDoctor } from '../doctor.ts';
import { modelFitness } from '../model-fitness.ts';
import { healthReport } from '../health.ts';
import { LOG_LEVELS, type LogLevel } from '../log.ts';
import { as400, HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { appLanguage, toLang, trOwner } from '../i18n.ts';
import { gatherTrouble } from '../trouble.ts';
import { useOllamaKeyForSearch } from '../web-search-auto.ts';
import { mcpSecrets, mergeSecrets, searchConfig } from '../integrations.ts';
import { proactiveSettings } from '../life.ts';
import { isCloudModel } from '../modelpicks.ts';
import { privateLocalOn } from '../net-guard.ts';
import { DEVICE_TOKEN_PREFIX } from '../auth.ts';
import { copyOffsite, offsiteSettings, testOffsite } from '../offsite-run.ts';
import { OFFSITE_PASS_VAULT, OFFSITE_S3_VAULT } from '../offsite.ts';
import { accessInfo, adminHelp, systemName } from '../platform.ts';
import { onThisComputer } from '../private-local.ts';
import { qrSvg } from '../qr.ts';
import { ROUTE_PURPOSES, type RoutePurpose, type Settings, USE_PATHS, type UsePath, usePathOf } from '../settings.ts';
import { MCP_PRESETS, type McpServerConfig, mcpVaultKey, validateMcpConfig } from '../tools/mcp.ts';
import { recipeEdit } from '../store/install.ts';
import { parseRecipe, type McpRecipe } from '../store/format.ts';
import { noSandboxNote } from '../tools/sandbox.ts';
import { applyServerPolicy, coverage, SERVER_POLICIES, type ServerPolicy, serverTools } from '../tool-policy.ts';
import { SEARCH_PROVIDERS, type SearchProvider, searchVaultKey } from '../tools/search.ts';
import { type Permission, PERMISSIONS } from '../tools/types.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';
import { policy, policy as pinPolicy } from '../policy-profile.ts';

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

/** 3.4.1: the Long conversations line: what she keeps in mind with the default model, in plain numbers. */
export function budgetView(app: RouteCtx['app'], preview?: { mode: HistoryMode; fixedChars?: number }): Record<string, unknown> {
  const b = historyBudgetFor(app, undefined, undefined, preview);
  return {
    model: b.model ?? null,
    provider: b.providerLabel ?? null,
    chars: b.chars,
    tokens: b.tokens,
    words: Math.round(b.tokens * 0.75),
    windowTokens: b.windowTokens,
    source: b.source,
    billing: b.billing,
    capped: b.capped ?? null,
    numCtx: b.numCtx ?? null,
    hardware: b.hardware ?? null,
  };
}

export function createAdminRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, info, opts, rootDir, updater } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    // 3.4.1: the Long conversations line for a choice not saved yet (?mode=auto|full or ?chars=n).
    if (a === 'settings' && b === 'history-budget' && method === 'GET') {
      const u = new URL(req.url ?? '/', 'http://x');
      const mode = u.searchParams.get('mode');
      const chars = Number(u.searchParams.get('chars'));
      const preview = mode === 'auto' || mode === 'full' ? { mode } as const : Number.isFinite(chars) && chars >= MIN_HISTORY_CHARS && chars <= HARD_MAX_CHARS ? { mode: 'fixed' as const, fixedChars: Math.round(chars) } : undefined;
      await primeBudget(app);
      return send(res, 200, budgetView(app, preview));
    }
    if (a === 'settings') {
      if (method === 'GET') {
        await primeBudget(app);
        const s = app.settings.get();
        return send(res, 200, {
          ownerName: s.ownerName ?? '',
          timeZone: s.timeZone ?? '',
          historyBudgetChars: s.historyBudgetChars ?? HISTORY_BUDGET_CHARS,
          // 3.4.1: Auto (the default), the whole window, or a fixed size; and what that means with her default model.
          historyBudgetMode: historyMode(s),
          historyBudget: budgetView(app),
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
          // V1: the look a new device starts from (null until "Use on all my devices").
          appearance: s.appearance ?? null,
          // Phase 114 (PL1b): company, coding or both (this companion's; 'both' when never chosen).
          usePath: usePathOf(s.usePath),
          usePathChosen: s.usePath !== undefined,
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
        if (body.usePath !== undefined) {
          if (!USE_PATHS.includes(body.usePath as UsePath)) throw new HttpError(400, 'Pick company, coding or both.');
          patch.usePath = body.usePath as UsePath;
        }
        if (body.appearance !== undefined) patch.appearance = cleanAppearance(body.appearance);
        if (body.storyYearly !== undefined) patch.story = { ...app.settings.get().story, yearly: Boolean(body.storyYearly) };
        if (body.historyBudgetMode !== undefined) {
          if (body.historyBudgetMode !== 'auto' && body.historyBudgetMode !== 'full' && body.historyBudgetMode !== 'fixed') throw new HttpError(400, 'Pick Auto, the full window or a fixed size.');
          patch.historyBudgetMode = body.historyBudgetMode;
        }
        if (body.historyBudgetChars !== undefined) {
          const n = Number(body.historyBudgetChars);
          if (!Number.isFinite(n) || n < MIN_HISTORY_CHARS || n > HARD_MAX_CHARS) throw new HttpError(400, 'Conversation length must be between 8,000 and 4,000,000 characters.');
          patch.historyBudgetChars = Math.round(n);
          // An older app sends only the size: that is a fixed choice (unless it's the old default).
          if (body.historyBudgetMode === undefined && patch.historyBudgetChars !== HISTORY_BUDGET_CHARS) patch.historyBudgetMode = 'fixed';
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
          if (id && id !== cur.defaultProviderId) policy().checkProvider(cur.providers.find((p) => p.id === id)!);
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
            if (was?.providerId !== pid) policy().checkProvider(prov);
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
          // E7 (A2): one choice per tool server, with exactly which tools each choice covers.
          servers: (s.mcpServers ?? []).map((m) => ({ name: m.name, policy: s.mcpPolicy?.[m.name] ?? null, ...coverage(m.name, serverTools(app.mcp, m.name)) })),
          browser: app.browsers ? (({ found, name, how }) => ({ found, name: name ?? null, how }))(new URL(req.url ?? '/', 'http://x').searchParams.get('recheck') ? app.browsers.refresh() : app.browsers.status()) : { found: false, name: null, how: 'Not available on this server.' },
        });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const patch: Partial<Settings> = {};
        if (body.permissions !== undefined) {
          if (!body.permissions || typeof body.permissions !== 'object') throw new HttpError(400, 'permissions must be an object');
          const saved = app.settings.get().toolPermissions;
          const perms: Record<string, Permission> = { ...saved };
          for (const [name, value] of Object.entries(body.permissions as Record<string, unknown>)) {
            if (!app.tools.get(name)) throw new HttpError(400, 'Unknown tool {name}', { params: { name } });
            if (!PERMISSIONS.includes(value as Permission)) throw new HttpError(400, 'Invalid permission for {name}', { params: { name } });
            // 3.0.3: the page sends every tool; only a real choice is kept (a value the owner set
            // before, or one that differs from what the tool has now), so defaults can still improve.
            if (!Object.hasOwn(saved ?? {}, name) && value === app.tools.permission(name, saved)) continue;
            perms[name] = value as Permission;
          }
          patch.toolPermissions = perms;
        }
        if (body.shellNetwork !== undefined) patch.shellNetwork = Boolean(body.shellNetwork);
        // EC5: nothing above the admin's ceilings, no internet for commands when that is pinned off.
        for (const [name, v] of Object.entries(patch.toolPermissions ?? {})) if (body.permissions && Object.hasOwn(body.permissions as object, name) && policy().clamp(name, v, app.tools.get(name)) !== v) throw policy().refusal('tools');
        policy().guard('shellNetwork', patch.shellNetwork === true);
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

    // E7 (A2): "Always allow the safe ones" (or everything but destructive, Ask, Never) for one server.
    if (a === 'tools' && b === 'policy' && method === 'PUT') {
      if (opts.demo || app.demo || app.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      const body = await readJson(req);
      const server = String(body.server ?? '');
      const s = app.settings.get();
      if (!(s.mcpServers ?? []).some((m) => m.name === server)) throw new HttpError(400, 'Unknown tool server {name}', { params: { name: server } });
      if (!SERVER_POLICIES.includes(body.policy as ServerPolicy)) throw new HttpError(400, 'Pick Ask me first, the safe ones, everything or Never.');
      const policy = body.policy as ServerPolicy;
      // EC5: a server choice that would let a tool past the admin's ceiling is refused.
      if ((policy === 'all' || policy === 'safe') && serverTools(app.mcp, server).some((t) => pinPolicy().ceiling(t.key, app.tools.get(t.key)))) throw pinPolicy().refusal('tools');
      app.settings.update({ toolPermissions: applyServerPolicy(s.toolPermissions ?? {}, policy, server, serverTools(app.mcp, server)), mcpPolicy: { ...(s.mcpPolicy ?? {}), [server]: policy } });
      return send(res, 200, { ok: true, server, policy, ...coverage(server, serverTools(app.mcp, server)) });
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
        // 3.3.0: one tap: Ollama web search with the connected Ollama Cloud key.
        else if (provider === 'ollama' && body.useProviderKey === true && !app.vault.has(searchVaultKey('ollama')) && !useOllamaKeyForSearch(app)) throw new HttpError(400, 'Connect Ollama Cloud with a key first, or paste an Ollama key here.');
        app.settings.update({ search: { provider, ...(url ? { url } : {}) } });
        return send(res, 200, { ok: true });
      }
    }

    if (a === 'mcp' && b === 'discovery' && c === 'previews' && parts.length === 3) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { investigations: PUBLIC_MCP_INVESTIGATIONS, developer: PUBLIC_DEVELOPER_CONNECTIONS });
    }
    if (a === 'mcp' && b === 'presets' && method === 'GET') return send(res, 200, MCP_PRESETS);
    if (a === 'mcp') {
      // B2: a server the Store installed is edited through its recipe's fields (saved values shown, secrets as saved).
      const recipeOf = (name: string): { item: string; recipe: McpRecipe } | undefined => {
        const row = app.storeInstalls?.byRef('mcp', name);
        if (!row?.recipe) return undefined;
        try { const { version: _v, ...raw } = JSON.parse(row.recipe) as Record<string, unknown>; return { item: row.item, recipe: parseRecipe(raw) }; } catch { return undefined; }
      };
      const view = () =>
        (app.settings.get().mcpServers ?? []).map((cfg) => {
          const conn = app.mcp?.get(cfg.name);
          const sec = mcpSecrets(app.vault, cfg.name);
          const r = recipeOf(cfg.name);
          const secretKeys = new Set(r ? [...r.recipe.secrets, ...r.recipe.fields.filter((x) => x.kind === 'secret')].map((f) => f.key) : []);
          return {
            ...cfg,
            ...(r ? { recipe: { item: r.item, fields: [...r.recipe.fields, ...r.recipe.secrets].map((f) => {
              const secret = secretKeys.has(f.key);
              const saved = r.recipe.transport === 'stdio' ? sec.env?.[f.key] : undefined;
              return { key: f.key, label: f.label, tip: f.tip, kind: f.kind, optional: Boolean(f.optional), secret, saved: secret ? Boolean(saved ?? sec.headers?.[f.header ?? f.key]) : Boolean(saved), ...(secret ? {} : { value: saved ?? f.default ?? '' }) };
            }) } } : {}),
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
        const r = recipeOf(b);
        if (r && body.fields && typeof body.fields === 'object') {
          try {
            const cur = mcpSecrets(app.vault, b);
            const out = recipeEdit(app.dataDir, r.recipe, b, cur, body.fields as Record<string, unknown>);
            cfg = { ...out.cfg, enabled: body.enabled !== false, ...(body.apps === false ? { apps: false } : {}) };
            app.vault.set(mcpVaultKey(b), JSON.stringify({ env: mergeSecrets(cur.env, out.env), headers: mergeSecrets(cur.headers, out.headers) }));
          } catch (err) {
            throw as400(err);
          }
          const servers = (app.settings.get().mcpServers ?? []).filter((s) => s.name !== b).concat(cfg);
          app.settings.update({ mcpServers: servers });
          await app.mcp?.start(cfg);
          return send(res, 200, await view());
        }
        // B2: a Store server keeps the recipe's type; its settings are edited instead (fields above).
        if (r && body.transport !== undefined && body.transport !== r.recipe.transport) throw new HttpError(400, 'This tool server came from the Sara Store: change its settings (like the ComfyUI address) instead of its type.');
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

    if (a === 'doctor' && !b && method === 'GET') return send(res, 200, await runDoctor({ dataDir: rootDir, settings: app.settings, vault: app.vault, subscriptions: app.subscriptions, now: app.now(), sandbox: app.sandbox, tools: app.tools, fitness: () => modelFitness(app), ...(app.dataSources ? { dataSources: doctorDataSources(app.dataSources) } : {}) }));
    if (a === 'status' && !b && method === 'GET') return send(res, 200, healthReport(app, opts.info ?? { version: 'dev', revision: null, startedAt: new Date().toISOString() }));
    // 3.3.0: her own trouble now (model down, key rejected, a mailbox signed out, an add-on stopped).
    if (a === 'health' && b === 'trouble' && method === 'GET') return send(res, 200, { trouble: gatherTrouble(app).map((x) => ({ ...x, text: trOwner(x.key, app.settings.get(), x.params) })) });
    // Phase 30: health history (chart) and Sara's log (recent problems, download).
    if (a === 'health' && b === 'history' && method === 'GET') {
      const days = new URL(req.url ?? '/', 'http://x').searchParams.get('days');
      const h = app.healthHistory;
      if (!h) return send(res, 200, { buckets: [], up: 0 });
      return send(res, 200, days ? h.history({ days: Math.min(31, Math.max(1, Number(days) || 7)) }) : h.history({ hours: 24 }));
    }
    // Settings → Data & health: the log level, saved in settings; SARA_LOG_LEVEL (when set) still wins.
    if (a === 'logs' && b === 'level' && !c) {
      const view = () => ({ level: app.log?.level ?? 'info', saved: app.settings.get().logLevel ?? null, env: app.log?.options.levelFromEnv ? app.log.options.level : null, choices: LOG_LEVELS });
      if (method === 'GET') return send(res, 200, view());
      if (method === 'PUT') {
        const level = String(((await readJson(req)) as { level?: unknown }).level ?? '') as LogLevel;
        if (!LOG_LEVELS.includes(level)) throw new HttpError(400, 'Pick debug, info, warn or error.');
        app.settings.update({ logLevel: level });
        app.log?.useSaved(level);
        return send(res, 200, view());
      }
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
        const base = backupName(app.now());
        const name = existsSync(join(rootDir, BACKUPS_DIR, base)) || activeBackupFiles.has(join(rootDir, BACKUPS_DIR, base))
          ? base.replace('.tar.gz', `-${randomUUID()}.tar.gz`) : base;
        const file = join(rootDir, BACKUPS_DIR, name);
        activeBackupFiles.add(file);
        try {
          const m = await createBackupAsync(rootDir, file, { saraVersion: opts.info?.version, now: app.now() });
          return send(res, 200, { name, files: m.files, backups: listBackups(rootDir) });
        } finally { activeBackupFiles.delete(file); }
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

    // Phase 128 (PL2b, N19): the `/` menu of the app's message box (src/bridges/commands.ts APP_MENU).
    if (a === 'chat-menu' && !b && method === 'GET') return send(res, 200, { commands: appMenu(app, { member: Boolean(opts.member) }) });
    // Phase 23: "Getting started" on the Today page.
    if (a === 'checklist' && !b) {
      const view = () =>
        checklist(app, {
          devices: auth.devices().map((d) => d.label),
          pushDevices: (app.push?.list().length ?? 0) + (app.push?.apns?.devices().length ?? 0),
          personaCustom: existsSync(join(app.dataDir, 'persona.json')),
          member: Boolean(opts.member),
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
    // 3.3.0 (easy reach): how other devices reach her (src/reach.ts), the self-test, and
    // "Turn on secure access with Tailscale" (owner only, with confirmation, and Undo).
    if (a === 'access' && b === 'reach' && (!c || c === 'check')) {
      const { browserOrigin, checkReach, listenPort, resolveReach } = await import('../reach.ts');
      const fresh = new URL(req.url ?? '/', 'http://x').searchParams.get('fresh') === '1' || method === 'POST';
      const r = await resolveReach({ origin: browserOrigin(req), dataDir: app.dataDir, fresh, port: listenPort(req) });
      // QR codes for the app stores (Tailscale on the phone; the Sara app), so the phone's camera opens them.
      const svg = (s: string) => `data:image/svg+xml;base64,${Buffer.from(qrSvg(s)).toString('base64')}`;
      if (!c && method === 'GET') return send(res, 200, { ...r, qr: { tailscaleAndroid: svg(r.get.tailscale.android), tailscaleIos: svg(r.get.tailscale.ios), saraAndroid: svg(r.get.android) } });
      if (c === 'check' && method === 'POST') {
        const target = r.awayAddress ?? r.address;
        return send(res, 200, { ...(await checkReach(target)), reach: r });
      }
    }
    if (a === 'access' && b === 'serve' && !c && method === 'POST') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      if (String(req.headers.authorization ?? '').startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`)) throw new HttpError(403, 'Apps signed in with a device code can\'t change how Sara is reached. Use the web app.');
      const body = await readJson(req, 4096);
      const action = body.action === 'off' ? 'off' : body.action === 'on' ? 'on' : null;
      if (!action) throw new HttpError(400, 'Say on or off.');
      if (body.confirm !== true) throw new HttpError(400, 'Confirm first: this changes how your devices reach Sara.', { needsConfirm: true });
      if (action === 'on' && privateLocalOn()) throw new HttpError(409, 'Paused in private local mode: nothing reaches Sara from other devices while it is on.');
      const { browserOrigin, listenPort, resolveReach, serveOff, serveOn } = await import('../reach.ts');
      const r = action === 'on' ? await serveOn({ dataDir: app.dataDir, port: listenPort(req) }) : await serveOff({ dataDir: app.dataDir, port: listenPort(req) });
      const reach = await resolveReach({ origin: browserOrigin(req), dataDir: app.dataDir, fresh: true, port: listenPort(req) });
      return send(res, 200, { ...r, reach });
    }
    // Phase 122 (WHATSAPP §3.1 W2): the public door for /hook/ only. On a tap Sara runs the Tailscale
    // CLI once (desktop apps, installs where it may) and shows its output; otherwise the command to copy.
    if (a === 'access' && b === 'door' && method === 'POST') {
      const body = await readJson(req);
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const { doorCommand, runDoor } = await import('../tailscale.ts');
      const port = Number(process.env.SARA_PORT ?? 7860);
      const action = body.action === 'close' ? 'close' : body.action === 'check' ? 'check' : 'open';
      if (action === 'check') {
        const acc = accessInfo();
        if (!acc.hookUrl) return send(res, 200, { ok: false, code: 'NO_DOOR' });
        // *Check from outside* (the ST7 rule: only when he presses it): Sara fetches its own door.
        const { netFetch } = await import('../net-guard.ts');
        const r = await netFetch(`${acc.hookUrl}/hook/ping`, { signal: AbortSignal.timeout(15_000) }).catch((err: Error) => ({ status: 0, err: err.message }));
        const status = (r as { status: number }).status;
        return send(res, 200, { ok: status === 404 || status === 405, status, code: status === 404 || status === 405 ? undefined : 'DOOR_CLOSED' });
      }
      if (process.env.SARA_DOOR_RUN === '0') return send(res, 200, { ok: false, command: doorCommand(port) });
      const r = runDoor(action, port);
      if (r.ok && action === 'open' && r.url) process.env.SARA_HOOK_URL = r.url;
      if (r.ok && action === 'close') delete process.env.SARA_HOOK_URL;
      return send(res, 200, { ...r, command: doorCommand(port), access: accessInfo() });
    }
    // Phase 23: updates from Settings (native installs; the root updater does the work).
    if (a === 'update' && !b) {
      const view = () => ({ available: updater.available && !opts.demo, how: updater.how, version: info.version, revision: info.revision, status: updater.status(app.now()) });
      if (method === 'GET') return send(res, 200, await view());
      if (method === 'POST') {
        if (opts.demo) throw new HttpError(403, 'Not in the demo.');
        const body = await readJson(req);
        // C15: from a remote device, an update (it restarts her) asks the owner first. A check only
        // looks (the app does it by itself every hour): it never asks, so no device shows an unasked
        // "Your OK is needed" that could hide a real request (computer use) behind it.
        if (body.action === 'update') ctx.askFirst(req, 'restart');
        if (privateLocalOn()) throw new HttpError(409, 'Paused in private local mode: checking for updates needs the internet.');
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
