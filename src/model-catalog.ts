// Phase 56: always-current model lists. Every provider's model list is kept by the server: the last
// good list, when it was checked, when each model first showed up (a "New" badge for a week) and
// when one went missing. A model counts as retired only after two good checks in a row without it;
// an error, a timeout or an empty list never retires anything. Lists refresh once a day in the
// background (owner setting per provider), from the Refresh button, and when a provider is added
// or its key changes.
//
// Ollama daemons (Ollama on the server or on another computer, signed in to ollama.com) can offer
// the whole Ollama Cloud catalog, not only the cloud models already pulled there: an unpulled one
// is pulled (a tiny manifest download) right before its first use. Retired cloud models are hidden
// and, only if the owner says so, removed from the daemon. Local-weight models are never removed.
//
// Anything set to a retired model (default model, a job, her own model, a helper, a backup) moves
// to the best replacement on the same provider and says so in Health and on Today (owner setting
// "Switch to the replacement automatically", on by default); with it off Sara only warns.
import { netFetch, outboundAllowed, privateLocalOn } from './net-guard.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';
import { dirname, join } from 'node:path';
import { isOllama } from './providers/openai-compatible.ts';
import { instanceName } from './updates.ts';
import { ProviderError, SUBSCRIPTION_KINDS, type Provider, type ProviderConfig } from './providers/types.ts';
import { JOBS, recommend, type Candidate } from './modelpicks.ts';
import type { ModelRoute, RoutePurpose, SettingsStore } from './settings.ts';
import { isCloudModelName } from './model-names.ts';
import { noteOllamaDaemon } from './model-context.ts';

export const CATALOG_FILE = 'model-lists.json';
/** Ollama's public cloud catalog (no key needed). */
export const OLLAMA_CLOUD_CATALOG = 'https://ollama.com/v1/models';
/** A list older than this is checked again when a picker opens it (and in the background). */
export const MAX_AGE_MS = 24 * 3600_000;
/** "New" badge for a week after a model first showed up. */
export const NEW_FOR_MS = 7 * 86_400_000;
/** Checks without a model before it counts as retired. */
export const RETIRE_AFTER = 2;
/** Retired entries are forgotten after this long (they stay hidden either way). */
const FORGET_RETIRED_MS = 90 * 86_400_000;
const EMBED = /embed/i;

export interface CatalogModel {
  firstSeen: string;
  lastSeen: string;
  /** Good checks in a row without this model. */
  missCount?: number;
  missingSince?: string;
  retired?: boolean;
  retiredAt?: string;
  /** Ollama daemons: in the cloud catalog but not pulled on this daemon yet. */
  unpulled?: boolean;
}

export interface ProviderCatalog {
  /** The provider's own order from the last good check (Claude newest first, etc.). */
  order?: string[];
  /** The first good check (models seen then are not "new"). */
  since?: string;
  /** The last good check. */
  checkedAt?: string;
  /** The last try, good or not (the background waits a while after a failure). */
  triedAt?: string;
  error?: string;
  models: Record<string, CatalogModel>;
  /** Ollama daemons: the models really on the daemon at the last check. */
  present?: string[];
  /** Ollama daemons: the daemon models that run on Ollama's servers (remote_host set). */
  remote?: string[];
  /** Hardening L1: answers /api/version like an Ollama daemon (probed, kept per address). */
  daemon?: boolean;
  /** The address the daemon probe was for, and when (a changed address is probed again). */
  daemonProbe?: { baseUrl: string; at: string; ok: boolean };
  /** Hardening L1: the last check's list was much shorter than before, so nothing was retired. */
  warning?: ModelListWarning;
}

/** Structured data for a model list that suddenly shrank (Health shows it; the UI translates it). */
export interface ModelListWarning {
  reason: 'list-shrank';
  at: string;
  providerId: string;
  /** The provider's name as shown in Settings. */
  provider: string;
  /** Models known before (not retired) and models in this check. */
  before: number;
  now: number;
  /** English sentence (kept for older apps). */
  text: string;
}

/**
 * A model switch Sara made (Today, Health). UX 19/20: `text` is the English sentence (kept for older
 * apps); the other fields let the app build the sentence in the owner's language. Model names are
 * the ids the pickers show ("gemma4:31b-cloud"), not prettified names.
 */
export interface ModelNotice {
  at: string;
  providerId: string;
  model: string;
  replacement?: string;
  text: string;
  /** Why it changed: the model was retired by its provider. */
  reason?: 'retired';
  /** The retired model (same as `model`) and what replaced it (same as `replacement`). */
  from?: string;
  to?: string;
  /** Who retired it: the provider's name, or "Ollama Cloud" for a daemon's cloud model. */
  provider?: string;
  /** Where it was chosen, in English ("Talking", "Mia's own model") and as a job id ("chat", "default"). */
  where?: string;
  job?: string;
}

/** A retired model still chosen somewhere (no replacement found, or the automatic switch is off). */
export interface RetiredUse {
  where: string;
  job: string;
  providerId: string;
  model: string;
  text: string;
  reason: 'retired-no-replacement' | 'retired-auto-switch-off';
  from: string;
  provider: string;
}

interface CatalogFile {
  version: 1;
  providers: Record<string, ProviderCatalog>;
  notices: ModelNotice[];
}

export interface ModelListOptions {
  /** Keep the model list up to date (daily check). Default on. */
  keepCurrent: boolean;
  /** Ollama daemons: offer every Ollama Cloud model. Default: on when the daemon has a cloud model. */
  ollamaCloud: boolean;
  /** Ollama daemons: remove retired cloud models from the daemon. Default off. */
  removeRetired: boolean;
  /** This provider is an Ollama daemon (the two Ollama options apply). */
  daemon: boolean;
}

export interface ModelListView {
  /** Models to pick from (retired and embedding models left out); unpulled cloud models last. */
  models: string[];
  entries: { id: string; new?: true; unpulled?: true }[];
  /** Embedding models left out of the pickers. */
  hidden: number;
  /** Recently retired (hidden) models. */
  retired: string[];
  checkedAt: string | null;
  error?: string;
  /** The last check looked like a glitch (a much shorter list): nothing was retired. */
  warning?: ModelListWarning;
  options: ModelListOptions;
}

// ---------- names ----------


/** Ollama Cloud catalog id → the name a daemon uses: "gemma4:31b" → "gemma4:31b-cloud", "beam" → "beam:cloud". */
export function cloudDaemonName(id: string): string {
  const i = id.lastIndexOf(':');
  return i > 0 ? `${id}-cloud` : `${id}:cloud`;
}

/** A daemon's cloud model name → the catalog id ("glm-5.2:cloud" → "glm-5.2"); undefined for local models. */
export function catalogIdOf(daemonName: string): string | undefined {
  if (/:cloud$/i.test(daemonName)) return daemonName.slice(0, -6);
  if (/:[^:]+-cloud$/i.test(daemonName)) return daemonName.slice(0, -6);
  return undefined;
}

/**
 * Looks like an Ollama daemon (its usual port, or named after Ollama): a hint only, for messages
 * (sara doctor). The model catalog decides by asking the address itself (/api/version) before it
 * ever pulls or removes a model.
 */
export const isOllamaDaemon = (c: ProviderConfig): boolean => c.kind === 'openai-compatible' && !/ollama\.com/i.test(c.baseUrl) && (isOllama(c.baseUrl) || /ollama/i.test(`${c.id} ${c.label}`));
const daemonRoot = (c: ProviderConfig) => c.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
/** Could be an Ollama daemon worth probing: OpenAI-compatible and not Ollama's own cloud API. */
const mayBeDaemon = (c: ProviderConfig): boolean => c.kind === 'openai-compatible' && !/ollama\.com/i.test(c.baseUrl);
/**
 * Ollama Cloud models through an Ollama daemon run on ollama.com and are billed to whatever account
 * that daemon is signed in to, which on a shared server may not be this Sara's owner. Unless the owner
 * chose, they are on only for the server's first Sara (instance "sara") when the daemon already has
 * one, and always off for any other instance on the same server.
 */
export function ollamaCloudDefault(daemonHasCloud: boolean, instance = instanceName()): boolean {
  return instance === 'sara' && daemonHasCloud;
}
/** The plain refusal when Ollama Cloud models are off for this Sara. */
export const CLOUD_OFF = (label: string, model: string) =>
  `${model} is an Ollama Cloud model: it runs on ollama.com and is billed to the ollama.com account ${label} is signed in to. Ollama Cloud models are turned off for this Sara (Settings → Models → ${label} → Use Ollama Cloud models).`;
/** Hardening L1: a list this much shorter than the last one is treated as a glitch (nothing retired). */
export const SHRINK_LIMIT = 0.5;

/** "gemma4:31b-cloud" → "Gemma 4 31B"; "claude-sonnet-4-5" → "Claude Sonnet 4.5". */
export function prettyModel(model: string): string {
  const base = model.replace(/(:|-)cloud$/i, '').replace(/:latest$/i, '');
  const parts = base.split(/[-_:/\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (/^\d+(\.\d+)?[bm]$/i.test(p)) out.push(p.toUpperCase());
    else if (/^\d+$/.test(p) && out.length && /^\d+(\.\d+)?$/.test(out[out.length - 1]) && p.length <= 2) out[out.length - 1] += `.${p}`;
    else out.push(p.replace(/^([a-z]+)(\d)/i, '$1 $2').replace(/^[a-z]/, (ch) => ch.toUpperCase()));
  }
  return out.join(' ') || model;
}

interface Parsed {
  family: string;
  version: number[];
  size?: string;
}

/** The family, version numbers and size of a model name (for finding its newer version). */
export function parseModel(model: string): Parsed {
  let s = model.toLowerCase().replace(/(:|-)cloud$/, '').replace(/:latest$/, '');
  let size: string | undefined;
  const m = /(?:^|[-_:])(\d+(?:\.\d+)?[bm])(?=$|[-_:])/.exec(s);
  if (m) {
    size = m[1];
    s = `${s.slice(0, m.index)}${s.slice(m.index + m[0].length)}`;
  }
  const colon = s.indexOf(':');
  const name = colon >= 0 ? s.slice(0, colon) : s;
  const tag = colon >= 0 ? s.slice(colon + 1) : '';
  const words: string[] = [];
  const version: number[] = [];
  for (const tok of name.split(/[-_./\s]+/).filter(Boolean)) {
    for (const piece of tok.match(/[a-z]+|\d+/g) ?? []) {
      if (/^\d+$/.test(piece)) version.push(Number(piece));
      else words.push(piece);
    }
  }
  for (const tok of tag.split(/[-_.]+/)) if (/^\d+$/.test(tok)) version.push(Number(tok));
  return { family: words.join('-'), version, ...(size ? { size } : {}) };
}

const cmpVersion = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
};

const NOT_CHAT = /embed|bge-|\be5-|gte-|minilm|caption|whisper|tts|rerank|guard|image|imagine/i;

/**
 * The best replacement for a retired model from the same provider's current list: the same family
 * with the highest version (same size and same place it runs preferred), else the model the "Which
 * model does what" recommendations pick for that job. Undefined when there's nothing sensible.
 */
export function pickReplacement(retired: string, available: string[], job: RoutePurpose | 'default' = 'chat', opts: { local?: boolean } = {}): string | undefined {
  const embed = EMBED.test(retired);
  let pool = available.filter((m) => m !== retired && (embed ? EMBED.test(m) : !NOT_CHAT.test(m)));
  if (job === 'private') pool = pool.filter((m) => !isCloudModelName(m));
  if (!pool.length) return undefined;
  const p = parseModel(retired);
  const cloud = isCloudModelName(retired);
  const same = pool
    .map((m) => ({ m, q: parseModel(m) }))
    .filter((x) => x.q.family === p.family && p.family)
    .sort((a, b) => {
      const where = Number(isCloudModelName(b.m) === cloud) - Number(isCloudModelName(a.m) === cloud);
      if (where) return where;
      const size = Number(b.q.size === p.size) - Number(a.q.size === p.size);
      if (size) return size;
      return cmpVersion(b.q.version, a.q.version);
    });
  if (same.length) return same[0].m;
  const cands: Candidate[] = pool.map((m) => ({ providerId: 'p', provider: 'p', model: m, local: Boolean(opts.local) && !isCloudModelName(m) }));
  const recs = recommend(cands, {});
  const want: RoutePurpose = job === 'default' ? 'chat' : job;
  return (recs[want] ?? recs.planning ?? recs.research)?.model;
}

// ---------- merging a check ----------

/**
 * Folds one successful list into what's known. `retire: false` (a partial check) adds models but
 * never counts anyone as missing. Pure: returns a new record.
 */
export function mergeCheck(prev: ProviderCatalog | undefined, listed: string[], now: Date, opts: { retire?: boolean; unpulled?: Set<string> } = {}): ProviderCatalog {
  const at = now.toISOString();
  const out: ProviderCatalog = { ...(prev ?? { models: {} }), models: {} };
  const seen = new Set(listed);
  for (const [id, m] of Object.entries(prev?.models ?? {})) {
    if (seen.has(id)) {
      out.models[id] = { firstSeen: m.firstSeen, lastSeen: at, ...(opts.unpulled?.has(id) ? { unpulled: true } : {}) };
      continue;
    }
    if (m.retired) {
      if (now.getTime() - Date.parse(m.retiredAt ?? m.lastSeen) < FORGET_RETIRED_MS) out.models[id] = m;
      continue;
    }
    if (opts.retire === false) {
      out.models[id] = m;
      continue;
    }
    const missCount = (m.missCount ?? 0) + 1;
    out.models[id] = { ...m, missCount, missingSince: m.missingSince ?? at, ...(missCount >= RETIRE_AFTER ? { retired: true, retiredAt: at } : {}) };
  }
  for (const id of listed) if (!out.models[id]) out.models[id] = { firstSeen: at, lastSeen: at, ...(opts.unpulled?.has(id) ? { unpulled: true } : {}) };
  out.order = [...listed];
  out.since = prev?.since ?? at;
  out.checkedAt = at;
  out.triedAt = at;
  delete out.error;
  return out;
}

/** Models that turned retired in this check. */
export const newlyRetired = (before: ProviderCatalog | undefined, after: ProviderCatalog): string[] => Object.entries(after.models).filter(([id, m]) => m.retired && !before?.models[id]?.retired).map(([id]) => id);

// ---------- where models are used ----------

export interface ModelUse {
  providerId: string;
  model: string;
  /** Plain words: "Talking", "Your default model", "Mia's own model". */
  where: string;
  job: RoutePurpose | 'default';
  /** Swaps the model in the settings it came from. */
  set: (model: string) => void;
}

export interface CompanionRef {
  name: string;
  settings: SettingsStore;
}

const jobLabel = (p: RoutePurpose) => JOBS.find((j) => j.id === p)?.label ?? p;

/** Every place a model is chosen: default, jobs and their backups, helpers, the safety check, each companion's own model. */
export function modelUses(shared: SettingsStore, companions: CompanionRef[]): ModelUse[] {
  const s = shared.get();
  const out: ModelUse[] = [];
  if (s.defaultProviderId && s.defaultModel) out.push({ providerId: s.defaultProviderId, model: s.defaultModel, where: 'Your default model', job: 'default', set: (m) => shared.update({ defaultModel: m }) });
  (s.defaultFallbacks ?? []).forEach((f, i) =>
    out.push({ providerId: f.providerId, model: f.model, where: 'A backup for the default model', job: 'default', set: (m) => shared.update({ defaultFallbacks: (shared.get().defaultFallbacks ?? []).map((x, k) => (k === i ? { ...x, model: m } : x)) }) }),
  );
  for (const [k, r] of Object.entries(s.routes ?? {}) as [RoutePurpose, ModelRoute | undefined][]) {
    if (!r) continue;
    const patchRoute = (fn: (x: ModelRoute) => ModelRoute) => {
      const cur = shared.get().routes ?? {};
      const route = cur[k];
      if (route) shared.update({ routes: { ...cur, [k]: fn(route) } });
    };
    out.push({ providerId: r.providerId, model: r.model, where: jobLabel(k), job: k, set: (m) => patchRoute((x) => ({ ...x, model: m })) });
    (r.fallbacks ?? []).forEach((f, i) => out.push({ providerId: f.providerId, model: f.model, where: `A backup for ${jobLabel(k)}`, job: k, set: (m) => patchRoute((x) => ({ ...x, fallbacks: (x.fallbacks ?? []).map((y, j) => (j === i ? { ...y, model: m } : y)) })) }));
  }
  (s.helpers ?? []).forEach((h) => {
    if (!h.model) return;
    out.push({ providerId: h.model.providerId, model: h.model.model, where: `Helper ${h.name}`, job: h.role === 'writer' ? 'writing' : h.role === 'researcher' ? 'research' : 'coding', set: (m) => shared.update({ helpers: (shared.get().helpers ?? []).map((x) => (x.id === h.id && x.model ? { ...x, model: { ...x.model, model: m } } : x)) }) });
  });
  if (s.safetyClassifier) out.push({ providerId: s.safetyClassifier.providerId, model: s.safetyClassifier.model, where: 'The safety check', job: 'background', set: (m) => shared.update({ safetyClassifier: { ...shared.get().safetyClassifier!, model: m } }) });
  if (s.claimJudge) out.push({ providerId: s.claimJudge.providerId, model: s.claimJudge.model, where: 'The claim check', job: 'background', set: (m) => shared.update({ claimJudge: { ...shared.get().claimJudge!, model: m } }) });
  for (const c of companions) {
    const cm = c.settings.get().companionModel;
    if (cm) out.push({ providerId: cm.providerId, model: cm.model, where: `${c.name}'s own model`, job: 'chat', set: (m) => c.settings.update({ companionModel: { ...cm, model: m } }) });
  }
  return out;
}

// ---------- the catalog ----------

export interface ModelCatalogOptions {
  /** The server's shared settings (providers, routes, the per-provider options). */
  settings: SettingsStore;
  /** Makes a provider with its key or sign-in. */
  providerFor: (config: ProviderConfig) => Provider;
  /** Every companion (for their own models); default: none besides the shared settings. */
  companions?: () => CompanionRef[];
  now?: () => Date;
  fetch?: typeof fetch;
  /** Ollama's cloud catalog address (tests use a fake). */
  cloudCatalogUrl?: string;
}

const atomicWrite = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, text, 0o666);
};

const ago = (ms: number) => (ms < 90_000 ? 'just now' : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 36 * 3600_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86_400_000)} days ago`);

export class ModelCatalog {
  readonly #file: string;
  readonly #o: ModelCatalogOptions;
  #data: CatalogFile;
  readonly #running = new Map<string, Promise<ModelListView>>();
  readonly #pulling = new Map<string, Promise<void>>();
  #ticking = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string, o: ModelCatalogOptions) {
    this.#file = join(dataDir, CATALOG_FILE);
    this.#o = o;
    this.#data = { version: 1, providers: {}, notices: [] };
    if (existsSync(this.#file)) {
      try {
        const d = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<CatalogFile>;
        this.#data = { version: 1, providers: d.providers ?? {}, notices: d.notices ?? [] };
        // 3.4.1: Ollama daemons found earlier on other ports get num_ctx from the first call.
        for (const p of Object.values(this.#data.providers)) if (p?.daemon === true && p.daemonProbe?.baseUrl) noteOllamaDaemon(p.daemonProbe.baseUrl);
      } catch {
        /* a damaged list is rebuilt by the next check */
      }
    }
  }

  #now = () => (this.#o.now ? this.#o.now() : new Date());
  #fetch: typeof fetch = (...a) => (this.#o.fetch ?? netFetch)(...a);
  #save() {
    atomicWrite(this.#file, `${JSON.stringify(this.#data, null, 1)}\n`);
  }
  #config(id: string) {
    return this.#o.settings.get().providers.find((p) => p.id === id);
  }
  /** Hardening L1: an Ollama daemon by its own answer to /api/version (probed at a check), never by its name. */
  isDaemon(config: ProviderConfig): boolean {
    return this.#isDaemon(config);
  }
  #isDaemon(config: ProviderConfig): boolean {
    const p = this.#data.providers[config.id];
    const daemon = mayBeDaemon(config) && p?.daemonProbe?.baseUrl === config.baseUrl && p.daemon === true;
    // 3.4.1: an Ollama on another port also gets num_ctx (src/model-context.ts).
    if (daemon) noteOllamaDaemon(config.baseUrl);
    return daemon;
  }
  /** Asks the address whether it is an Ollama daemon; kept per address (a failed probe is retried after an hour). */
  async #probeDaemon(config: ProviderConfig, before: ProviderCatalog | undefined): Promise<{ daemon: boolean; probe: ProviderCatalog['daemonProbe'] }> {
    if (!mayBeDaemon(config)) return { daemon: false, probe: undefined };
    const last = before?.daemonProbe;
    if (last?.baseUrl === config.baseUrl && (last.ok || this.#now().getTime() - Date.parse(last.at) < 3600_000)) return { daemon: before?.daemon === true, probe: last };
    const at = this.#now().toISOString();
    try {
      const r = await this.#fetch(`${daemonRoot(config)}/api/version`, { signal: AbortSignal.timeout(5000) });
      const j = r.ok ? ((await r.json().catch(() => ({}))) as { version?: unknown }) : {};
      return { daemon: r.ok && typeof j.version === 'string' && /^\d/.test(j.version), probe: { baseUrl: config.baseUrl, at, ok: true } };
    } catch {
      return { daemon: before?.daemonProbe?.baseUrl === config.baseUrl && before.daemon === true, probe: { baseUrl: config.baseUrl, at, ok: false } };
    }
  }

  /** May this Sara use Ollama Cloud models through this provider's daemon? (the owner's choice, else the default) */
  cloudAllowed(id: string): boolean {
    const o = this.#o.settings.get().modelLists?.[id]?.ollamaCloud;
    return o ?? ollamaCloudDefault((this.#data.providers[id]?.present ?? []).some(isCloudModelName));
  }

  /** The owner's options for a provider, with the defaults filled in. */
  options(id: string): ModelListOptions {
    const config = this.#config(id);
    const o = this.#o.settings.get().modelLists?.[id] ?? {};
    const daemon = Boolean(config && this.#isDaemon(config));
    const hasCloud = (this.#data.providers[id]?.present ?? []).some(isCloudModelName);
    return { keepCurrent: o.keepCurrent !== false, ollamaCloud: daemon && (o.ollamaCloud ?? ollamaCloudDefault(hasCloud)), removeRetired: daemon && o.removeRetired === true, daemon };
  }

  /** What the pickers show for a provider (from the stored list; no network). */
  view(id: string): ModelListView {
    const p = this.#data.providers[id];
    const now = this.#now().getTime();
    const since = p?.since ? Date.parse(p.since) : now;
    const live = Object.entries(p?.models ?? {}).filter(([, m]) => !m.retired);
    const chat = live.filter(([mid]) => !EMBED.test(mid));
    // Keep the provider's own order (Claude lists newest first); models it no longer lists, last.
    const pos = new Map((p?.order ?? []).map((id, i) => [id, i]));
    const at = (id: string) => pos.get(id) ?? Number.MAX_SAFE_INTEGER;
    chat.sort(([a, x], [b, y]) => Number(Boolean(x.unpulled)) - Number(Boolean(y.unpulled)) || at(a) - at(b) || a.localeCompare(b));
    const entries = chat.map(([mid, m]) => {
      const first = Date.parse(m.firstSeen);
      return { id: mid, ...(first > since && now - first < NEW_FOR_MS ? { new: true as const } : {}), ...(m.unpulled ? { unpulled: true as const } : {}) };
    });
    return {
      models: entries.map((e) => e.id),
      entries,
      hidden: live.length - chat.length,
      retired: Object.entries(p?.models ?? {}).filter(([, m]) => m.retired && now - Date.parse(m.retiredAt ?? m.lastSeen) < 30 * 86_400_000).map(([mid]) => mid),
      checkedAt: p?.checkedAt ?? null,
      ...(p?.error ? { error: p.error } : {}),
      ...(p?.warning ? { warning: p.warning } : {}),
      options: this.options(id),
    };
  }

  /** Has this provider's list been checked at least once? */
  known(id: string): boolean {
    return Boolean(this.#data.providers[id]?.checkedAt);
  }

  /** The list, checked again first when it's older than `maxAgeMs` (or never checked). */
  async list(id: string, maxAgeMs = MAX_AGE_MS): Promise<ModelListView> {
    const p = this.#data.providers[id];
    if (p?.checkedAt && this.#now().getTime() - Date.parse(p.checkedAt) < maxAgeMs) return this.view(id);
    return this.refresh(id);
  }

  /** Checks a provider's list now (one check per provider at a time). */
  refresh(id: string): Promise<ModelListView> {
    const running = this.#running.get(id);
    if (running) return running;
    const job = this.#check(id).finally(() => this.#running.delete(id));
    this.#running.set(id, job);
    return job;
  }

  /** A provider was removed: forget its list. */
  forget(id: string): void {
    if (!this.#data.providers[id]) return;
    delete this.#data.providers[id];
    this.#save();
  }

  async #check(id: string): Promise<ModelListView> {
    const config = this.#config(id);
    if (!config) throw new Error('Provider not found');
    const before = this.#data.providers[id];
    const now = this.#now();
    const fail = (msg: string) => {
      this.#data.providers[id] = { ...(before ?? { models: {} }), triedAt: now.toISOString(), error: msg.slice(0, 300) };
      this.#save();
      return this.view(id);
    };
    let models: string[];
    try {
      models = await this.#o.providerFor(config).listModels(AbortSignal.timeout(20_000));
    } catch (err) {
      return fail((err as Error).name === 'TimeoutError' ? `${config.label} didn't answer in time.` : (err as Error).message);
    }
    models = [...new Set(models.map((m) => String(m)).filter(Boolean))];
    if (!models.length) return fail(`${config.label} answered with an empty list (nothing was changed).`);
    let listed = models;
    let retire = true;
    let unpulled: Set<string> | undefined;
    let remote: string[] | undefined;
    const probed = await this.#probeDaemon(config, before);
    const daemon = probed.daemon;
    if (daemon) {
      remote = await this.#daemonRemote(config);
      const isRemote = (m: string) => isCloudModelName(m) && (!remote || remote.includes(m));
      const wantCloud = this.#o.settings.get().modelLists?.[id]?.ollamaCloud ?? ollamaCloudDefault(models.some(isCloudModelName));
      // Off: the daemon's cloud models (billed to the account it is signed in to) aren't offered at all.
      if (!wantCloud) listed = models.filter((m) => !isCloudModelName(m));
      if (wantCloud) {
        const cloud = await this.#cloudCatalog();
        if (cloud) {
          const names = new Set(cloud.map(cloudDaemonName));
          unpulled = new Set([...names].filter((n) => !models.includes(n)));
          // A pulled cloud model that left the catalog counts as missing (hidden after two checks);
          // one seen for the first time is listed once so the two-check rule holds.
          listed = [...models.filter((m) => !(isRemote(m) && !names.has(m) && before?.models[m])), ...unpulled];
        } else {
          // The catalog didn't answer: keep what was known about it, retire nothing.
          const known = Object.entries(before?.models ?? {}).filter(([, m]) => m.unpulled && !m.retired).map(([mid]) => mid).filter((m) => !models.includes(m));
          unpulled = new Set(known);
          listed = [...models, ...known];
          retire = false;
        }
      }
    }
    // Hardening L1: a list less than half as long as the last one is more likely a glitch (an error
    // page, a partial answer) than half the models retired at once: keep the old list, retire nothing,
    // and say so in Health. A real change shows up as the same short list again and stays a warning.
    const known = Object.values(before?.models ?? {}).filter((m) => !m.retired).length;
    let warning: ModelListWarning | undefined;
    if (retire && known >= 4 && listed.length < known * SHRINK_LIMIT) {
      retire = false;
      warning = { reason: 'list-shrank', at: now.toISOString(), providerId: id, provider: this.#byWhom(config, '', daemon), before: known, now: listed.length, text: `${config.label}'s model list shrank from ${known} to ${listed.length} models in one check. That looks like a glitch, so nothing was retired; the earlier list is kept.` };
      console.warn(`model lists: ${warning.text}`);
    }
    const after = mergeCheck(before, listed, now, { retire, ...(unpulled ? { unpulled } : {}) });
    delete after.warning;
    if (warning) after.warning = warning;
    after.daemon = daemon;
    if (daemon) noteOllamaDaemon(config.baseUrl);
    if (probed.probe) after.daemonProbe = probed.probe;
    else delete after.daemonProbe;
    if (daemon) {
      after.present = models;
      if (remote) after.remote = remote;
    } else {
      delete after.present;
      delete after.remote;
    }
    this.#data.providers[id] = after;
    this.#save();
    const gone = newlyRetired(before, after);
    if (gone.length) {
      if (this.options(id).removeRetired) await this.#removeFromDaemon(config, gone, remote);
      this.reviewUses();
    }
    return this.view(id);
  }

  /** The daemon's cloud models (remote_host set in /api/tags); undefined when it can't tell. */
  async #daemonRemote(config: ProviderConfig): Promise<string[] | undefined> {
    try {
      const r = await this.#fetch(`${daemonRoot(config)}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return undefined;
      const j = (await r.json()) as { models?: { name?: string; model?: string; remote_host?: string }[] };
      return (j.models ?? []).filter((m) => m.remote_host).map((m) => String(m.name ?? m.model));
    } catch {
      return undefined;
    }
  }

  /** Ollama Cloud's model ids, or undefined when the catalog can't be read (or comes back empty). */
  async #cloudCatalog(): Promise<string[] | undefined> {
    try {
      const r = await this.#fetch(this.#o.cloudCatalogUrl ?? OLLAMA_CLOUD_CATALOG, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return undefined;
      const j = (await r.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
      const ids = (j.data?.map((m) => m.id) ?? j.models?.map((m) => m.name) ?? []).filter((x): x is string => typeof x === 'string' && Boolean(x));
      return ids.length ? ids : undefined;
    } catch {
      return undefined;
    }
  }

  /** Removes retired cloud models from a daemon (never a local-weight model, never unconfirmed). */
  async #removeFromDaemon(config: ProviderConfig, names: string[], remote: string[] | undefined): Promise<void> {
    const present = this.#data.providers[config.id]?.present ?? [];
    for (const name of names) {
      // Hardening L1: only when the daemon's own /api/tags says it runs on Ollama's servers.
      if (!isCloudModelName(name) || !present.includes(name) || !remote?.includes(name)) continue;
      try {
        const r = await this.#fetch(`${daemonRoot(config)}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(20_000) });
        if (r.ok) {
          const p = this.#data.providers[config.id];
          if (p?.present) p.present = p.present.filter((m) => m !== name);
        }
      } catch {
        /* tried again after the next check */
      }
    }
    this.#save();
  }

  // ---------- pulling a cloud model before its first use ----------

  /** A cloud model from the catalog that isn't on this daemon yet. */
  needsPull(config: ProviderConfig, model: string): boolean {
    if (!this.#isDaemon(config) || !isCloudModelName(model)) return false;
    const p = this.#data.providers[config.id];
    // Hardening L2: only names in the current Ollama Cloud catalog that aren't pulled yet; a typo, a
    // stale setting or another registry's "x-cloud" name is never downloaded.
    return Boolean(p?.present) && !p!.present!.includes(model) && p!.models[model]?.unpulled === true && !p!.models[model]?.retired;
  }

  /** Pulls a cloud model on the daemon (once; later callers wait for the same pull). */
  ensurePulled(config: ProviderConfig, model: string, signal?: AbortSignal): Promise<void> {
    if (!this.needsPull(config, model)) return Promise.resolve();
    const key = `${config.id}\n${model}`;
    const running = this.#pulling.get(key);
    if (running) return running;
    const job = this.#pull(config, model, signal).finally(() => this.#pulling.delete(key));
    this.#pulling.set(key, job);
    return job;
  }

  async #pull(config: ProviderConfig, model: string, signal?: AbortSignal): Promise<void> {
    let r: Response;
    try {
      r = await this.#fetch(`${daemonRoot(config)}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ProviderError(`Couldn't reach ${config.label} to add the cloud model ${model}. Is that computer on and Ollama running?`);
    }
    const text = await r.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string; status?: string };
      if (j.error) detail = j.error;
      else if (r.ok) detail = '';
    } catch {
      /* not JSON */
    }
    if (!r.ok || /"error"/.test(text)) throw new ProviderError(pullError(config, model, r.status, detail), r.status === 200 ? 502 : r.status);
    const p = this.#data.providers[config.id];
    if (p) {
      p.present = [...new Set([...(p.present ?? []), model])];
      if (p.models[model]) delete p.models[model].unpulled;
      this.#save();
    }
  }

  // ---------- retired models that are still chosen somewhere ----------

  /** Is this model retired from this provider's list? */
  isRetired(providerId: string, model: string): boolean {
    return Boolean(this.#data.providers[providerId]?.models[model]?.retired);
  }

  #byWhom(config: ProviderConfig | undefined, model: string, daemon?: boolean): string {
    if (!config) return 'its provider';
    return (daemon ?? this.#isDaemon(config)) && isCloudModelName(model) ? 'Ollama Cloud' : config.label;
  }

  /**
   * Finds settings that still use a retired model. With "Switch to the replacement automatically"
   * on (default) each one moves to the best replacement and a notice is kept; returns what's left
   * (nothing to replace it with, or the switch is off).
   */
  reviewUses(): RetiredUse[] {
    const s = this.#o.settings.get();
    const auto = s.modelAutoSwitch !== false;
    const left: RetiredUse[] = [];
    let changed = false;
    for (const use of modelUses(this.#o.settings, this.#o.companions?.() ?? [])) {
      if (!this.isRetired(use.providerId, use.model)) continue;
      const config = s.providers.find((p) => p.id === use.providerId);
      const by = this.#byWhom(config, use.model);
      const replacement = auto ? pickReplacement(use.model, this.view(use.providerId).models, use.job, { local: config?.local }) : undefined;
      if (replacement) {
        use.set(replacement);
        // UX 20: the ids the pickers show, so the owner can find them there.
        this.#data.notices.unshift({ at: this.#now().toISOString(), providerId: use.providerId, model: use.model, replacement, text: `${use.model} was retired by ${by}; ${use.where} now uses ${replacement}.`, reason: 'retired', from: use.model, to: replacement, provider: by, where: use.where, job: use.job });
        changed = true;
      } else {
        left.push(this.#stuck(use, by, auto));
      }
    }
    if (changed) {
      this.#data.notices = this.#data.notices.slice(0, 50);
      this.#save();
    }
    return left;
  }

  #stuck(use: ModelUse, by: string, auto: boolean): RetiredUse {
    return { where: use.where, job: use.job, providerId: use.providerId, model: use.model, text: `${use.model} was retired by ${by}, but ${use.where} still uses it.${auto ? ' No replacement was found:' : ''} Pick another model in Settings → Models.`, reason: auto ? 'retired-no-replacement' : 'retired-auto-switch-off', from: use.model, provider: by };
  }

  /** Retired models still in use (without changing anything): for Health. */
  retiredInUse(): RetiredUse[] {
    const s = this.#o.settings.get();
    const auto = s.modelAutoSwitch !== false;
    return modelUses(this.#o.settings, this.#o.companions?.() ?? [])
      .filter((u) => this.isRetired(u.providerId, u.model))
      .map((u) => this.#stuck(u, this.#byWhom(s.providers.find((p) => p.id === u.providerId), u.model), auto));
  }

  /** Hardening L1: providers whose last check looked like a glitch (a much shorter list). */
  warnings(): ModelListWarning[] {
    const ids = new Set(this.#o.settings.get().providers.map((p) => p.id));
    return Object.entries(this.#data.providers).filter(([id, p]) => ids.has(id) && p.warning).map(([, p]) => p.warning!);
  }

  /** Switches made in the last `days` days (newest first). */
  notices(days = 14): ModelNotice[] {
    const from = this.#now().getTime() - days * 86_400_000;
    return this.#data.notices.filter((n) => Date.parse(n.at) >= from);
  }

  /** "checked 3 h ago" for a provider. */
  checkedAgo(id: string): string | null {
    const at = this.#data.providers[id]?.checkedAt;
    return at ? ago(this.#now().getTime() - Date.parse(at)) : null;
  }

  // ---------- the daily background check ----------

  /**
   * One step of the background check: the provider whose list is oldest (past a day; after a
   * failure it waits an hour), one per step so the checks are spread out.
   */
  async tick(): Promise<string | undefined> {
    if (this.#ticking) return undefined;
    this.#ticking = true;
    try {
      const now = this.#now().getTime();
      const due = this.#o.settings
        .get()
        .providers.filter((p) => this.options(p.id).keepCurrent)
        // Phase 67: in private local mode only lists on this computer are checked (the rest would be blocked anyway).
        .filter((p) => !privateLocalOn() || (outboundAllowed(p.baseUrl) && !SUBSCRIPTION_KINDS.includes(p.kind)))
        .map((p) => ({ id: p.id, d: this.#data.providers[p.id] }))
        .filter(({ d }) => (!d?.checkedAt || now - Date.parse(d.checkedAt) >= MAX_AGE_MS) && (!d?.triedAt || now - Date.parse(d.triedAt) >= 3600_000))
        .sort((a, b) => (a.d?.checkedAt ?? '').localeCompare(b.d?.checkedAt ?? ''));
      if (!due.length) return undefined;
      await this.refresh(due[0].id).catch(() => undefined);
      return due[0].id;
    } finally {
      this.#ticking = false;
    }
  }

  /** Every 10 minutes (the first 3 minutes after start). Never started on the demo server. */
  start(guard: (name: string, fn: () => unknown) => void): void {
    const run = () => guard('model lists', () => this.tick());
    setTimeout(run, 180_000).unref?.();
    this.#timer = setInterval(run, 600_000);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** The provider as used for requests: Ollama daemons pull an unpulled cloud model first. */
  wrap(provider: Provider): Provider {
    // Decided per request (the probe may come after the provider was made).
    return mayBeDaemon(provider.config) ? withCloudPull(provider, this) : provider;
  }
}

/** A pull that failed, in plain words (the daemon not signed in to ollama.com is the usual case). */
export function pullError(config: ProviderConfig, model: string, status: number, detail: string): string {
  if (status === 401 || status === 403 || /unauthori[sz]ed|sign ?in|not signed|forbidden/i.test(detail)) {
    return `${config.label} isn't signed in to ollama.com, so it can't add the cloud model ${model}. On that computer, run: ollama signin (then try again).`;
  }
  return `Couldn't add the cloud model ${model} to ${config.label}${detail ? `: ${detail}` : ` (HTTP ${status})`}.`;
}

/**
 * Wraps a provider so an unpulled Ollama Cloud model is pulled on the daemon before the first
 * request, and a cloud model the daemon can't use because it isn't signed in says so plainly.
 */
export function withCloudPull(provider: Provider, catalog: ModelCatalog): Provider {
  const config = provider.config;
  // Refused before any request when Ollama Cloud models are off for this Sara (decided per request:
  // the owner may change it, and the daemon probe may come later than the provider).
  const cloudOff = (model: string) => isCloudModelName(model) && (catalog.isDaemon(config) || isOllama(config.baseUrl)) && !catalog.cloudAllowed(config.id);
  return {
    config,
    listModels: async (signal) => {
      const all = await provider.listModels(signal);
      return all.filter((m) => !cloudOff(m));
    },
    ...(provider.modelLimits ? { modelLimits: (model: string, signal?: AbortSignal) => provider.modelLimits!(model, signal) } : {}),
    ...(provider.loadedModels ? { loadedModels: (signal?: AbortSignal) => provider.loadedModels!(signal) } : {}),
    async *stream(req) {
      if (cloudOff(req.model)) throw new ProviderError(CLOUD_OFF(config.label, req.model), 403);
      await catalog.ensurePulled(config, req.model, req.signal);
      try {
        yield* provider.stream(req);
      } catch (err) {
        if (err instanceof ProviderError && (err.status === 401 || err.status === 403) && isCloudModelName(req.model) && catalog.isDaemon(config)) throw new ProviderError(pullError(config, req.model, err.status, err.message), err.status);
        throw err;
      }
    },
  };
}
