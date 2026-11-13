// Models: providers, model jobs, subscriptions, local models, private local mode, usage.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { policy } from '../policy-profile.ts';
import { APNS_VAULT } from '../apns.ts';
import { vaultKeyFor } from '../chat.ts';
import { as400, HttpError, readJson, send } from '../http.ts';
import { chatModels, CPU_TIERS, detectHardware, detectOllama, GPU_TIERS, installOllamaWithWinget, installStatus, ModelPuller, OLLAMA_DOWNLOAD, ollamaRoot, recommendModel } from '../local-models.ts';
import { localDate } from '../memory-worker.ts';
import { compareModels, comparePrompt, connectedModels, costHint, JOBS, recommend, testModel } from '../modelpicks.ts';
import { blockedRecently, privateLocalOn } from '../net-guard.ts';
import { dayStartUtc } from '../planner.ts';
import { onThisComputer, PrivateLocalStore, whatWouldLeave } from '../private-local.ts';
import { createProvider, PROVIDER_PRESETS, validateProviderConfig } from '../providers/registry.ts';
import { ROUTE_PURPOSES, type RoutePurpose, type Settings } from '../settings.ts';
import { cleanLimits } from '../team.ts';
import { GITHUB_VAULT } from '../tools/coding.ts';
import { HOME_VAULT } from '../tools/home.ts';
import { cleanBudget, cleanPrices, DEFAULT_PRICES, mergeSummaries, priceTable, usageLine } from '../usage.ts';
import { suggestModel } from '../../web/model-suggest.js';
import { modelFitness } from '../model-fitness.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';
import { autoWebSearch } from '../web-search-auto.ts';

/**
 * 3.0.3: a provider that is the default but has no default model (it just became the default: the
 * first provider of a fresh install, a subscription sign-in) gets one from its model list, so chat
 * never stops on "Choose a model" and Settings → Default model shows a model that is really saved.
 * An explicit pick (PUT /settings defaultModel) always wins; this only fills an empty one.
 */
export function adoptDefaultModel(app: RouteCtx['app'], providerId: string, models: string[]): void {
  const s = app.settings.get();
  if (s.defaultProviderId !== providerId || s.defaultModel) return;
  const prov = s.providers.find((p) => p.id === providerId);
  const pick = prov?.defaultModel ?? suggestModel(models);
  // Private local mode: never a model that would leave this computer (the owner picks one).
  if (!prov || !pick || (privateLocalOn() && !onThisComputer(prov, pick))) return;
  app.settings.update({ defaultModel: pick });
}

export function createModelsRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts, rootDir } = ctx;
  function providerView() {
    const s = app.settings.get();
    return {
      presets: PROVIDER_PRESETS,
      // Phase 56: each provider's model list (checked when, its options).
      providers: s.providers.map((p) => ({ ...p, hasKey: app.vault.has(vaultKeyFor(p.id)), ...(app.modelCatalog ? { modelList: { checkedAt: app.modelCatalog.view(p.id).checkedAt, options: app.modelCatalog.options(p.id) } } : {}) })),
      defaultProviderId: s.defaultProviderId ?? null,
      defaultModel: s.defaultModel ?? null,
    };
  }
  // ---- Phase 67: private local mode and a model on this computer ----
  const privateLocalOf = (): PrivateLocalStore => (app.privateLocal ??= new PrivateLocalStore(rootDir));
  /** Chat models that run on this computer: the local Ollama's (providerId '' when Sara has no provider entry for it yet), and loopback providers with a model set. */
  async function modelsOnThisComputer(): Promise<{ providerId: string; model: string }[]> {
    const s = app.settings.get();
    const out: { providerId: string; model: string }[] = [];
    const ollama = await detectOllama(ollamaRoot(s.providers));
    const op = s.providers.find((p) => onThisComputer(p) && ollamaRoot([p]) === ollama.url);
    for (const m of chatModels(ollama.models)) out.push({ providerId: op?.id ?? '', model: m.name });
    for (const p of s.providers) {
      const model = p.defaultModel ?? (p.id === s.defaultProviderId ? s.defaultModel : undefined);
      if (p !== op && model && onThisComputer(p, model)) out.push({ providerId: p.id, model });
    }
    return out;
  }
  /** The "Ollama on the server" provider at this computer's Ollama (added when missing). */
  function ensureLocalOllamaProvider(): string {
    const s = app.settings.get();
    const root = ollamaRoot(s.providers);
    const have = s.providers.find((p) => onThisComputer(p) && p.kind === 'openai-compatible' && ollamaRoot([p]) === root);
    if (have) {
      if (!have.local) app.settings.update({ providers: s.providers.map((p) => (p.id === have.id ? { ...p, local: true } : p)) });
      return have.id;
    }
    const preset = PROVIDER_PRESETS.find((p) => p.id === 'ollama-local')!;
    const id = s.providers.some((p) => p.id === preset.id) ? 'ollama-this-computer' : preset.id;
    app.settings.update({ providers: [...s.providers, { ...preset, id, baseUrl: `${root}/v1`, local: true, needsKey: false }] });
    return id;
  }
  /** Phase 67: a downloaded model becomes her model and the background model (provider marked local). */
  function useLocalModel(model: string): void {
    const providerId = ensureLocalOllamaProvider();
    const s = app.settings.get();
    const pick = { providerId, model };
    app.settings.update({
      companionModel: pick,
      routes: { ...s.routes, background: { ...pick }, ...(s.routes?.private ? {} : { private: { ...pick } }) },
      ...(s.defaultProviderId ? {} : { defaultProviderId: providerId, defaultModel: model }),
    });
    void app.modelCatalog?.refresh(providerId).catch(() => undefined);
  }
  async function privateLocalView(pl: PrivateLocalStore): Promise<Record<string, unknown>> {
    const s = app.settings.get();
    const here = await modelsOnThisComputer().catch(() => []);
    const facts = {
      google: Boolean(app.google?.status().connected) || Boolean(app.mailAccounts?.hasOthers()),
      github: Boolean(app.vault.get(GITHUB_VAULT)),
      pushDevices: app.push?.list().length ?? 0,
      apns: Boolean(app.vault.get(APNS_VAULT)),
      homeToken: Boolean(app.vault.get(HOME_VAULT)),
    };
    return {
      ...pl.get(),
      demo: Boolean(opts.demo),
      localModels: here,
      leave: whatWouldLeave(s, facts),
      blocked: blockedRecently(),
      platform: process.platform,
    };
  }
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    // Phase 67: "Nothing leaves this computer" (private local mode) and a model on this computer.
    if (a === 'private-local' && !b) {
      const pl = privateLocalOf();
      if (method === 'GET') return send(res, 200, await privateLocalView(pl));
      if (method === 'PUT') {
        // Defence in depth: the demo gate in api() already refuses this route. This and the other
        // per-route `if (opts.demo)` checks are deliberate; keep them if the gate changes.
        if (opts.demo) throw new HttpError(403, 'Not available in the demo.');
        const body = await readJson(req);
        const want = body.on === true;
        const cur = pl.get();
        if (want === cur.on) return send(res, 200, await privateLocalView(pl));
        if (!want) {
          policy().guard('privateLocal', true);
          if (cur.locked) throw new HttpError(409, 'SARA_PRIVATE_LOCAL=1 is set on this server, so private local mode stays on.');
          if (body.confirm !== true) throw new HttpError(409, 'Turning it off lets Sara reach the internet again. Confirm to turn it off.', { needsConfirm: true });
        } else {
          const here = await modelsOnThisComputer();
          if (!here.length) throw new HttpError(409, 'Turning this on needs a model on this computer first. Download one on this page (or start Ollama), then try again.', { needsModel: true });
          // Conversations need a model that works offline: if neither the default nor the
          // private-conversation model is on this computer, the private job gets the first one here.
          const s = app.settings.get();
          const priv = s.routes?.private;
          const privOk = priv && s.providers.some((p) => p.id === priv.providerId && onThisComputer(p, priv.model));
          const def = s.providers.find((p) => p.id === s.defaultProviderId);
          const defOk = def && onThisComputer(def, s.defaultModel ?? def.defaultModel);
          if (!privOk && !defOk) {
            const providerId = here[0].providerId || ensureLocalOllamaProvider();
            app.settings.update({ routes: { ...app.settings.get().routes, private: { providerId, model: here[0].model } } });
          }
        }
        pl.set(want);
        // Bridges pause or come back; add-on programs restart with (or without) network.
        void app.bridges?.telegram?.restart().catch(() => {});
        void app.bridges?.discord?.restart().catch(() => {});
        if (app.mcp) {
          app.mcp.stopAll();
          void app.mcp.startAll(app.settings.get().mcpServers ?? []).catch(() => {});
        }
        console.log(`Private local mode ${want ? 'on: nothing leaves this computer' : 'off'}.`);
        return send(res, 200, await privateLocalView(pl));
      }
    }
    if (a === 'local-models') {
      const root = ollamaRoot(app.settings.get().providers);
      const puller = (app.modelPuller ??= new ModelPuller());
      if (!b && method === 'GET') {
        const [hw, ollama] = await Promise.all([detectHardware(), detectOllama(root)]);
        return send(res, 200, {
          hardware: hw,
          recommended: recommendModel(hw),
          tiers: hw.basis === 'cpu' ? CPU_TIERS : GPU_TIERS,
          ollama,
          download: OLLAMA_DOWNLOAD,
          winget: process.platform === 'win32' && !opts.demo,
          install: installStatus() ?? null,
          pull: puller.status() ?? null,
          privateLocal: privateLocalOn(),
          using: app.settings.get().companionModel ?? null,
        });
      }
      if (opts.demo && method !== 'GET') throw new HttpError(403, 'Not available in the demo.');
      if (b === 'pull' && method === 'GET') return send(res, 200, { pull: puller.status() ?? null });
      if (b === 'pull' && method === 'POST') {
        const body = await readJson(req);
        if (privateLocalOn()) throw new HttpError(409, 'Downloading a model needs the internet. Turn "Nothing leaves this computer" off for the download, then on again.');
        const model = String(body.model ?? '').trim();
        try {
          // A chat model becomes hers when it's done (an embedding model is only downloaded).
          puller.onDone = (m) => {
            if (!/embed|minilm|bge-|e5-/i.test(m)) useLocalModel(m);
          };
          return send(res, 202, { pull: puller.start(root, model) });
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      }
      if (b === 'pull' && method === 'DELETE') return send(res, 200, { cancelled: puller.cancel(), pull: puller.status() ?? null });
      if (b === 'use' && method === 'POST') {
        const body = await readJson(req);
        const model = String(body.model ?? '').trim();
        const ollama = await detectOllama(root);
        if (!chatModels(ollama.models).some((m) => m.name === model)) throw new HttpError(400, 'That model is not on this computer yet.');
        useLocalModel(model);
        return send(res, 200, { ok: true, using: app.settings.get().companionModel ?? null });
      }
      if (b === 'install-ollama' && method === 'POST') {
        const body = await readJson(req);
        if (body.confirm !== true) throw new HttpError(400, 'Confirm first.');
        if (privateLocalOn()) throw new HttpError(409, 'Installing Ollama needs the internet. Turn "Nothing leaves this computer" off first.');
        try {
          return send(res, 202, { install: installOllamaWithWinget() });
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      }
    }

    // Phase 38: which model does what: jobs, recommended picks, a test, the side-by-side test.
    if (a === 'model-jobs') {
      if (!b && method === 'GET') {
        const s = app.settings.get();
        return send(res, 200, {
          jobs: JOBS,
          vectors: app.vectors?.status() ?? null,
          costs: Object.fromEntries(s.providers.map((p) => [p.id, { local: Boolean(p.local), hint: costHint(p, p.defaultModel ?? '') }])),
        });
      }
      // E7: is the talking model right for this computer (src/model-fitness.ts)? Read only.
      if (b === 'fitness' && method === 'GET') return send(res, 200, { fitness: (await modelFitness(app)) ?? null });
      if (b === 'recommend' && method === 'GET') {
        const s = app.settings.get();
        const cands = await connectedModels(app);
        return send(res, 200, { picks: recommend(cands, { providerId: s.defaultProviderId, model: s.defaultModel }), models: cands.length });
      }
      if ((b === 'test' || b === 'compare') && method === 'POST') {
        const body = await readJson(req);
        const job = String(body.job ?? '') as RoutePurpose;
        if (!ROUTE_PURPOSES.includes(job)) throw new HttpError(400, 'Unknown job');
        if (b === 'test') {
          const pid = String(body.providerId ?? '');
          const model = String(body.model ?? '').trim();
          if (!pid || !model) throw new HttpError(400, 'Choose a provider and a model first.');
          return send(res, 200, await testModel(app, job, pid, model));
        }
        if (job === 'embeddings') throw new HttpError(400, 'Meaning search has no answers to compare; use Test.');
        const cands = (Array.isArray(body.candidates) ? body.candidates : []).slice(0, 3).map((c: { providerId?: unknown; model?: unknown }) => ({ providerId: String(c?.providerId ?? ''), model: String(c?.model ?? '').trim() })).filter((c: { providerId: string; model: string }) => c.providerId && c.model);
        if (cands.length < 2) throw new HttpError(400, 'Pick two or three models to compare.');
        return send(res, 200, { prompt: comparePrompt(job), results: await compareModels(app, job, cands) });
      }
    }

    if (a === 'subscriptions') {
      const subs = app.subscriptions;
      if (!subs) throw new HttpError(404, 'Subscriptions are not available');
      // Signing in adds the matching provider (and makes it the default when there is none).
      const ensureProvider = (presetId: string) => {
        const s = app.settings.get();
        if (s.providers.some((p) => p.id === presetId)) return;
        const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)!;
        app.settings.update({ providers: [...s.providers, { ...preset }], ...(s.defaultProviderId ? {} : { defaultProviderId: preset.id, defaultModel: preset.defaultModel }) });
        // 3.0.3: ChatGPT and Grok have no preset model: take one from their list once it is known.
        if (app.modelCatalog && !app.settings.get().defaultModel && app.settings.get().defaultProviderId === preset.id) {
          void app.modelCatalog.refresh(preset.id).then((v) => adoptDefaultModel(app, preset.id, v.models), () => undefined);
        }
      };
      const view = () => ({ chatgpt: subs.chatgpt.status(), claude: subs.claudeStatus(), grok: subs.grokStatus() });
      if (!b && method === 'GET') return send(res, 200, await view());
      if (b === 'chatgpt') {
        if (c === 'start' && method === 'POST') {
          const body = await readJson(req);
          return send(res, 200, await subs.chatgpt.start({ forceConsent: body.enablePlan === true }));
        }
        if (c === 'complete' && method === 'POST') {
          const body = await readJson(req);
          try {
            const st = await subs.chatgpt.complete(String(body.url ?? ''));
            if (st.planUsage) ensureProvider('chatgpt');
          } catch (err) {
            throw as400(err);
          }
          return send(res, 200, await view());
        }
        if (c === 'welcomed' && method === 'POST') {
          subs.chatgpt.markWelcomed();
          return send(res, 200, await view());
        }
        if (c === 'signout' && method === 'POST') {
          const r = await subs.chatgpt.signOut();
          return send(res, 200, { ...view(), revoked: r.revoked });
        }
      }
      if (b === 'claude' && c === 'login' && method === 'POST') {
        try {
          const login = await subs.startClaudeLogin();
          return send(res, 200, { ...view(), login });
        } catch (err) {
          throw as400(err);
        }
      }
      if (b === 'claude' && c === 'code' && method === 'POST') {
        const body = await readJson(req);
        try {
          await subs.finishClaudeLogin(String(body.code ?? ''));
        } catch (err) {
          throw as400(err);
        }
        ensureProvider('claude-sub');
        return send(res, 200, await view());
      }
      if (b === 'claude' && !c) {
        if (method === 'PUT') {
          const body = await readJson(req);
          try {
            subs.setClaudeToken(String(body.token ?? ''));
          } catch (err) {
            throw as400(err);
          }
          ensureProvider('claude-sub');
          return send(res, 200, await view());
        }
        if (method === 'DELETE') {
          subs.clearClaude();
          return send(res, 200, await view());
        }
      }
      if (b === 'grok') {
        if (c === 'login' && method === 'POST') {
          try {
            const login = await subs.startGrokLogin();
            return send(res, 200, { ...view(), login });
          } catch (err) {
            throw as400(err);
          }
        }
        if (c === 'logout' && method === 'POST') {
          await subs.grokLogout();
          return send(res, 200, await view());
        }
        if (c === 'check' && method === 'POST') {
          const v = view();
          if (v.grok.signedIn) ensureProvider('grok-sub');
          return send(res, 200, v);
        }
      }
    }
    // Phase 52: the cost and token meter (Settings → Data & health → Usage) and the price table.
    if (a === 'usage') {
      const meter = app.usage;
      if (!meter) throw new HttpError(404, 'Not available');
      if (!b && method === 'GET') {
        const now = app.now().getTime();
        const tz = app.settings.get().timeZone;
        // "Today" starts at local midnight.
        const startOfToday = dayStartUtc(localDate(app.now().toISOString(), tz), tz);
        // M11: every companion's model calls, with a split by companion (prices and budgets are shared).
        const meters = (opts.companions?.all() ?? []).filter((x) => x.app.usage).map((x) => ({ id: x.id, name: x.app.persona.name, meter: x.app.usage! }));
        if (!meters.length) meters.push({ id: app.companionId ?? 'main', name: app.persona.name, meter });
        const range = (since: Date) => {
          const s = mergeSummaries(meters.map((x) => ({ id: x.id, name: x.name, summary: x.meter.summary(since.toISOString()) })));
          return { ...s, line: usageLine(s.total), byModel: s.byModel.map((m) => ({ ...m, line: usageLine(m) })), byPurpose: s.byPurpose.map((m) => ({ ...m, line: usageLine(m) })), byCompanion: meters.length > 1 ? s.byCompanion.map((m) => ({ ...m, line: usageLine(m) })) : [] };
        };
        const st = app.settings.get();
        return send(res, 200, {
          today: range(startOfToday),
          week: range(new Date(now - 7 * 86_400_000)),
          month: range(new Date(now - 30 * 86_400_000)),
          prices: st.prices ?? [],
          defaults: DEFAULT_PRICES,
          jobBudget: cleanBudget(st.jobBudget),
          teamLimits: cleanLimits(st.teamLimits),
          providers: st.providers.map((pr) => ({ id: pr.id, label: pr.label })),
        });
      }
      if (b === 'settings' && method === 'PUT') {
        const body = await readJson(req);
        const patch: Partial<Settings> = {};
        try {
          if (body.prices !== undefined) patch.prices = cleanPrices(body.prices);
          if (body.jobBudget !== undefined) patch.jobBudget = cleanBudget(body.jobBudget);
          if (body.teamUsd !== undefined || body.teamTokens !== undefined) patch.teamLimits = cleanLimits({ ...app.settings.get().teamLimits, ...(body.teamTokens !== undefined ? { tokens: body.teamTokens } : {}), ...(body.teamUsd !== undefined ? { usd: body.teamUsd } : {}) });
        } catch (err) {
          throw as400(err);
        }
        app.settings.update(patch);
        return send(res, 200, { ok: true, prices: priceTable(app.settings.get().prices).length });
      }
    }
    if (a === 'providers') {
      // Phase 71: a member sees only the models the owner allowed them: no addresses, keys or presets.
      if (opts.member) {
        const allowed = opts.member.record()?.limits.models ?? [];
        const s = app.settings.get();
        const mine = (id: string) => allowed.filter((m) => m.providerId === id).map((m) => m.model);
        if (!b && method === 'GET') {
          return send(res, 200, {
            presets: [],
            providers: s.providers.filter((p) => mine(p.id).length).map((p) => ({ id: p.id, label: p.label, kind: p.kind, baseUrl: '', local: Boolean(p.local), needsKey: false, hasKey: true, defaultModel: mine(p.id)[0] })),
            defaultProviderId: s.defaultProviderId ?? null,
            defaultModel: s.defaultModel ?? null,
            member: true,
          });
        }
        if (b && c === 'models' && !parts[3] && method === 'GET') return send(res, 200, { models: mine(b), hidden: 0 });
        throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      }
      if (!b && method === 'GET') return send(res, 200, providerView());
      if (b && !c && method === 'PUT') {
        const body = await readJson(req);
        if (body.preserveDefault !== undefined && typeof body.preserveDefault !== 'boolean') throw new HttpError(400, 'preserveDefault must be a boolean');
        let config;
        try {
          config = validateProviderConfig({ ...body, id: b });
        } catch (err) {
          throw as400(err);
        }
        policy().checkProvider(config);
        const s = app.settings.get();
        const was = s.providers.find((p) => p.id === b);
        const providers = s.providers.filter((p) => p.id !== b).concat(config);
        app.settings.update({ providers, defaultProviderId: body.preserveDefault === true ? s.defaultProviderId : s.defaultProviderId ?? config.id });
        if (typeof body.apiKey === 'string') {
          if (body.apiKey) app.vault.set(vaultKeyFor(b), body.apiKey.trim());
          else app.vault.delete(vaultKeyFor(b));
          // C1 (real OpenBao): an external reference resolves before Save answers (up to 5 s), so the
          // next chat has the key instead of "needs an API key" while it is still being read.
          if (app.vault.reference(vaultKeyFor(b))) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([app.vault.check(vaultKeyFor(b)).catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, 5000)))]);
            clearTimeout(timer);
          }
        }
        // Phase 56: a new provider, a new key or a new address: check its model list now.
        // UX 15: wait for that first check (up to 5 s) so the card shows its result, not "not checked yet".
        if (app.modelCatalog && (!was || was.baseUrl !== config.baseUrl || was.kind !== config.kind || typeof body.apiKey === 'string')) {
          const check = app.modelCatalog.refresh(b).catch(() => undefined);
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([check, new Promise<void>((r) => (timer = setTimeout(r, 5000)))]);
          clearTimeout(timer);
        }
        // 3.0.3: the provider that became the default gets a default model from the list just checked.
        if (app.modelCatalog?.known(b)) adoptDefaultModel(app, b, app.modelCatalog.view(b).models);
        // 3.3.0: an Ollama Cloud key also turns on Ollama web search (when no search is set up yet).
        const searchOn = autoWebSearch(app, config, body.apiKey);
        return send(res, 200, { ...providerView(), ...(searchOn ? { webSearch: 'ollama' } : {}) });
      }
      if (b && !c && method === 'DELETE') {
        const s = app.settings.get();
        app.settings.update({
          providers: s.providers.filter((p) => p.id !== b),
          ...(s.defaultProviderId === b ? { defaultProviderId: undefined, defaultModel: undefined } : {}),
        });
        app.vault.delete(vaultKeyFor(b));
        app.modelCatalog?.forget(b);
        return send(res, 200, providerView());
      }
      // Phase 56: the kept model list (checked again when a day old), Refresh, and its options.
      if (b && c === 'models' && app.modelCatalog && !opts.demo) {
        const catalog = app.modelCatalog;
        const config = app.settings.get().providers.find((p) => p.id === b);
        const d = parts[3];
        if (d === 'options' && method === 'PUT') {
          const body = await readJson(req);
          if (!config) throw new HttpError(404, 'Provider not found');
          const cur = app.settings.get().modelLists ?? {};
          const next = { ...cur[b] };
          for (const k of ['keepCurrent', 'ollamaCloud', 'removeRetired'] as const) if (typeof body[k] === 'boolean') next[k] = body[k];
          app.settings.update({ modelLists: { ...cur, [b]: next } });
          if (typeof body.ollamaCloud === 'boolean') await catalog.refresh(b).catch(() => undefined);
          return send(res, 200, catalog.view(b));
        }
        if (!config) throw new HttpError(404, 'Provider not found');
        if ((d === 'refresh' && method === 'POST') || (!d && method === 'GET')) {
          const view = d === 'refresh' ? await catalog.refresh(b) : await catalog.list(b);
          // Never checked successfully: the reason, as before.
          if (!view.checkedAt && view.error) throw new HttpError(502, view.error);
          return send(res, 200, view);
        }
      }
      if (b && c === 'models' && method === 'GET') {
        const config = app.settings.get().providers.find((p) => p.id === b);
        if (!config) throw new HttpError(404, 'Provider not found');
        const factory = app.providerFactory ?? createProvider;
        try {
          const all = await factory(config, app.vault.get(vaultKeyFor(b)), app.subscriptions).listModels(AbortSignal.timeout(15000));
          // Embedding models can't chat; leave them out of the pickers.
          const models = all.filter((m) => !/embed/i.test(m));
          return send(res, 200, { models, hidden: all.length - models.length });
        } catch (err) {
          throw new HttpError(502, (err as Error).message);
        }
      }
    }
    return NEXT;
  };
}
