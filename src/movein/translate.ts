// Phase 106 (MI3, docs/design/MOVE_IN.md §9, §11.5, §11.6): the translation cards and what Import does
// with them. After a bundle is read, its config trees become PROPOSALS (src/movein/config.ts) and its
// hooks and plugins become CODE CARDS (src/movein/code-read.ts); both wait in the staging database
// for the owner to Confirm or Skip each one. At Import only confirmed cards change Sara, and only in
// these ways (each one listed so Undo puts it back):
//   provider / local / sign-in   a provider entry added, key blank (never routed to by itself)
//   voice                         the voice engine + voice id
//   timezone                      Sara's time zone (only when she had none)
//   rule (hook)                   one line on her sheet under "How you talk" (safety-checked)
//   guard (hook)                  a tool that ran by itself now asks first (only ever stricter)
// Channels, peers, webhooks and MCP servers are "connect this" cards: confirming them puts the
// reconnect steps in the report; nothing is connected. Approvals, sandboxes and allowlists are shown,
// never copied. The hook and plugin text is kept at <data>/movein/<batch>/code/ as .txt files: outside
// every workspace, skill and plugin folder, and never on a path anything runs from.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveChain, type AppContext } from '../chat.ts';
import { isCloudModelName } from '../model-names.ts';
import { writeFileAtomic } from '../fs-util.ts';
import { netFetch } from '../net-guard.ts';
import { validatePersona } from '../persona.ts';
import { PROVIDER_PRESETS, validateProviderConfig } from '../providers/registry.ts';
import type { ProviderConfig } from '../providers/types.ts';
import type { Settings } from '../settings.ts';
import { askModel } from '../security/pass.ts';
import type { ReportLine } from './batch.ts';
import type { Bundle } from './bundle.ts';
import { codeForModel, codeInputs, codePrompt, mergeModelRead, readCode, type CodeCard, type CodeInput } from './code-read.ts';
import { configTrees, enabledPlugins, keyPaths, presetLabel, reachable, translateConfig, type Proposal } from './config.ts';
import { parseAnswer } from './mapping.ts';
import type { Staging } from './staging.ts';
import { unsafeLine } from './text.ts';

/** Where each kind of old agent keeps its hooks and plugins inside the bundle. */
export const CODE_ROOTS: Record<'hermes' | 'openclaw' | 'custom', { hooks: string[]; plugins: string[] }> = {
  hermes: { hooks: ['files/home/hooks/'], plugins: ['files/home/plugins/'] },
  openclaw: { hooks: ['files/ws/hooks/', 'files/state/hooks/'], plugins: ['files/state/extensions/', 'files/state/plugins/'] },
  custom: { hooks: [], plugins: [] },
};

export interface SettingChange {
  /** "voice.tts", "timeZone", "toolPermissions.shell", or a provider added. */
  path: string;
  before?: unknown;
  after?: unknown;
  provider?: string;
}

export interface TranslationView {
  config: Proposal[];
  code: CodeCard[];
  busy: boolean;
  /** Config key names found, for the counts-only runs (no values). */
  keys: number;
  undecided: number;
}

export interface TranslateDeps {
  app: AppContext;
  staging: Staging;
  bundle: () => Promise<Bundle>;
  publish: () => void;
}

export class Translations {
  readonly #d: TranslateDeps;
  #busy: Promise<void> = Promise.resolve();
  #working = 0;
  #abort?: AbortController;

  constructor(d: TranslateDeps) {
    this.#d = d;
  }

  get config(): Proposal[] {
    return this.#d.staging.meta<Proposal[]>('config') ?? [];
  }
  get code(): CodeCard[] {
    return this.#d.staging.meta<CodeCard[]>('code') ?? [];
  }
  #setConfig(p: Proposal[]): void {
    this.#d.staging.setMeta('config', p);
    this.#d.publish();
  }
  #setCode(c: CodeCard[]): void {
    this.#d.staging.setMeta('code', c);
    this.#d.publish();
  }

  /** Builds the cards for a bundle that was just read (no model calls; the local-model checks are quick). */
  async discover(b: Bundle, signal?: AbortSignal): Promise<void> {
    const app = this.#d.app;
    const s = app.settings.get();
    const kind = b.manifest.source.kind;
    const trees = await configTrees(b);
    const config = translateConfig(trees, { kind, agentId: b.manifest.source.agentId, timeZone: s.timeZone, providers: s.providers });
    // §9.1: local models only if Sara's server reaches that address (through net-guard).
    for (const p of config.filter((x) => x.kind === 'local')) {
      if (signal?.aborted) break;
      const ok = await reachable(p.data?.baseUrl ?? '', (u, init) => netFetch(u, init)).catch(() => false);
      p.reach = ok ? 'yes' : 'no';
      if (!ok) {
        p.mode = 'info';
        p.why = "That address is the old machine's own (or Sara's server can't reach it). Set up Ollama where Sara runs, or give its address in Settings → Models.";
      }
    }
    this.#d.staging.setMeta('configKeys', trees.reduce((n, t) => n + (t.tree ? keyPaths(t.tree).length : (t.keys?.length ?? 0)), 0));
    this.#setConfig(config);
    const inputs = await codeInputs(b, CODE_ROOTS[kind] ?? CODE_ROOTS.custom, enabledPlugins(trees));
    this.#setCode(inputs.map((i) => readCode(i)));
  }

  view(): TranslationView {
    const config = this.config;
    const code = this.code;
    return { config, code, busy: this.#working > 0, keys: this.#d.staging.meta<number>('configKeys') ?? 0, undecided: [...config.filter((p) => p.mode !== 'info'), ...code.filter((c) => ['rule', 'guard', 'feature'].includes(c.translation.type))].filter((x) => x.state === 'proposed').length };
  }
  busy(): boolean {
    return this.#working > 0;
  }

  /** Confirm / Skip / back to undecided, and the pick on a pick-list (provider kind, voice engine). */
  decideConfig(key: string, decision: 'confirm' | 'skip' | 'reset', choice?: string): Proposal {
    const list = this.config;
    const p = list.find((x) => x.key === key);
    if (!p) throw new Error('That card is gone.');
    if (p.mode === 'info') throw new Error('This one is only shown: Sara never copies it.');
    if (choice !== undefined) {
      if (!p.options?.some((o) => o.value === choice)) throw new Error('Pick one of the choices on the card.');
      p.choice = choice;
    }
    p.state = decision === 'confirm' ? 'confirmed' : decision === 'skip' ? 'skipped' : 'proposed';
    this.#setConfig(list);
    return p;
  }
  decideCode(key: string, decision: 'confirm' | 'skip' | 'reset'): CodeCard {
    const list = this.code;
    const c = list.find((x) => x.key === key);
    if (!c) throw new Error('That card is gone.');
    c.state = decision === 'confirm' ? 'confirmed' : decision === 'skip' ? 'skipped' : 'proposed';
    this.#setCode(list);
    return c;
  }

  /** The text of one hook/plugin (for the explainer's "Show the code" and the model read). Never run. */
  async input(key: string): Promise<CodeInput | undefined> {
    const c = this.code.find((x) => x.key === key);
    if (!c) return undefined;
    const b = await this.#d.bundle();
    const kind = b.manifest.source.kind;
    return (await codeInputs(b, CODE_ROOTS[kind] ?? CODE_ROOTS.custom, { hooks: new Set(), plugins: new Set() })).find((i) => `${i.kind}:${i.folder}` === key);
  }

  /** "Ask her to read it": one model call per card, quotes checked; in the background. */
  ask(key: string, opts: { localOnly?: boolean } = {}): void {
    const c = this.code.find((x) => x.key === key);
    if (!c) throw new Error('That card is gone.');
    const chain = chainFor(this.#d.app, opts.localOnly !== false);
    if (!chain?.length) throw new Error(opts.localOnly !== false ? 'No model on your own hardware is set up for this.' : 'No model is set up for this yet.');
    this.#abort ??= new AbortController();
    const signal = this.#abort.signal;
    this.#working++;
    this.#d.publish();
    this.#busy = this.#busy.then(async () => {
      try {
        const inp = await this.input(key);
        if (!inp || signal.aborted) return;
        const card = this.code.find((x) => x.key === key)!;
        const r = await askModel(chain, [{ role: 'user', content: codePrompt(card, codeForModel(inp)) }] as never, 900, signal).catch((err: Error) => ({ text: '', model: '', error: err.message }));
        const raw = parseAnswer(r.text);
        const list = this.code;
        const at = list.findIndex((x) => x.key === key);
        if (at < 0) return;
        list[at] = raw ? mergeModelRead(list[at], inp, raw, r.model) : { ...list[at], translation: { ...list[at].translation, why: `${list[at].translation.why ?? ''} Her read didn't come back as the answer asked for; this is Sara's own reading.`.trim() } };
        this.#setCode(list);
      } finally {
        this.#working--;
        this.#d.publish();
      }
    });
  }
  stop(): void {
    this.#abort?.abort();
    this.#abort = undefined;
  }
  async idle(): Promise<void> {
    for (let i = 0; i < 3; i++) await this.#busy;
  }
}

/** The background route for her reading (local models only unless the owner allows others). */
function chainFor(app: AppContext, localOnly: boolean): ReturnType<typeof resolveChain> | undefined {
  try {
    const conv = { id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: localOnly, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '', updatedAt: '' };
    const chain = resolveChain(app, conv as never, 'background');
    const first = chain[0];
    if (!first || (localOnly && (!first.provider.config.local || isCloudModelName(first.model)))) return undefined;
    return chain;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Import: what confirmed cards do (and the report lines for every card)
// ---------------------------------------------------------------------------------------------
export interface ApplyResult {
  translated: ReportLine[];
  needsYou: ReportLine[];
  leftBehind: ReportLine[];
  /** Rows for movein_items: kind, native table, native id, source ref. */
  items: { kind: string; table: string; id: string; ref: string }[];
  changes: SettingChange[];
  /** Lines added to her sheet (the persona snapshot is taken by the caller first). */
  rules: string[];
}

const line = (key: string, text: string, extra: Partial<ReportLine> = {}): ReportLine => ({ key, count: 1, text, ...extra });
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function uniqueId(base: string, taken: Set<string>): string {
  const b = base.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'moved-in';
  let id = b;
  for (let k = 2; taken.has(id); k++) id = `${b}-${k}`;
  return id;
}

/** The provider entry a confirmed provider/local/sign-in card adds (key blank: the owner pastes it). */
export function providerFor(p: Proposal, existing: ProviderConfig[]): ProviderConfig {
  const pick = p.choice ?? 'openai';
  const preset = PROVIDER_PRESETS.find((x) => x.id === pick);
  const taken = new Set(existing.map((x) => x.id));
  const labels = new Set(existing.map((x) => x.label));
  const base = p.data?.baseUrl ?? '';
  let cfg: ProviderConfig;
  if (preset) {
    const url = pick === 'ollama-local' && base ? ollamaV1(base) : preset.baseUrl;
    cfg = { ...preset, id: uniqueId(`${preset.id}-moved`, taken), baseUrl: url, ...(p.data?.model ? { defaultModel: p.data.model } : {}) };
  } else {
    cfg = { id: uniqueId(`${p.data?.name || 'moved'}-moved`, taken), label: `${p.data?.name || 'Provider'} (moved in)`, kind: 'openai-compatible', baseUrl: base, needsKey: true, ...(p.data?.model ? { defaultModel: p.data.model } : {}) };
  }
  if (labels.has(cfg.label)) cfg.label = `${cfg.label} (moved in)`.slice(0, 60);
  return validateProviderConfig(cfg);
}
function ollamaV1(url: string): string {
  try {
    const u = new URL(url);
    return /\/v1\/?$/.test(u.pathname) ? url.replace(/\/+$/, '') : `${u.protocol}//${u.host}/v1`;
  } catch {
    return url;
  }
}

const VOICE_LABEL: Record<string, string> = { local: "Sara's own voice", openai: 'OpenAI', elevenlabs: 'ElevenLabs', xai: 'xAI (Grok voice)', off: 'no voice' };

/**
 * Applies the confirmed cards to Sara's settings and her sheet, and writes one report line for every
 * card (so each item lands in exactly one of the four lists). Never loosens a permission: a guard only
 * turns an "auto" tool into "ask"; nothing is enabled, connected or given a key.
 */
/** The bundle keeps a config file as `<name>.json` (redacted copy); the report names the old file (`config.yaml`, `openclaw.json`). */
export function shownFrom(from: string): string {
  return from.replace(/(\.(?:json5?|ya?ml|toml|ini|env))\.json(?=#|$)/i, '$1');
}

export function applyTranslations(app: AppContext, config: Proposal[], code: CodeCard[]): ApplyResult {
  const r: ApplyResult = { translated: [], needsYou: [], leftBehind: [], items: [], changes: [], rules: [] };
  const s = app.settings.get();
  const patch: Partial<Settings> = {};
  let providers = [...s.providers];
  const keys: string[] = [];
  const routes: string[] = [];
  for (const p of config) {
    const where = `(${p.lives})`;
    if (p.mode === 'info') {
      if (p.kind === 'route') routes.push(p.old);
      else if (p.kind === 'roster' || p.kind === 'sign-in' || (p.kind === 'local' && p.reach === 'no') || (p.kind === 'channel' && p.why?.includes("doesn't speak"))) r.needsYou.push(line(`cfg-${p.kind}`, `${p.title}: ${p.why ?? p.old}`, { examples: [shownFrom(p.from)], ...(p.page ? { page: p.page } : {}) } as Partial<ReportLine>));
      else r.leftBehind.push(line(`cfg-${p.kind}`, `${p.title}: ${p.why ?? 'shown, not copied'} ${where}`.trim(), { examples: [shownFrom(p.from)], ...(p.page ? { page: p.page } : {}) } as Partial<ReportLine>));
      continue;
    }
    if (p.state === 'skipped') {
      r.leftBehind.push(line('cfg-skipped', `${p.title} (${p.old}): you skipped it`, { examples: [shownFrom(p.from)] }));
      continue;
    }
    if (p.state !== 'confirmed') {
      r.needsYou.push(line('cfg-undecided', `${p.title} (${p.old}): not decided, so nothing changed. Import the bundle again to decide.`, { examples: [shownFrom(p.from)] }));
      continue;
    }
    if (p.mode === 'connect') {
      r.needsYou.push(line(`connect-${p.kind}`, `${p.kind === 'channel' ? 'Reconnect' : 'Connect'} ${p.title}: ${(p.steps ?? []).join(' ')}`, { examples: [shownFrom(p.from)], ...(p.page ? { page: p.page } : {}) } as Partial<ReportLine>));
      r.translated.push(line(`tr-${p.kind}`, `${p.title} → ${p.lives} (off until you connect it)`, { examples: [shownFrom(p.from)] }));
      continue;
    }
    if (p.kind === 'provider' || p.kind === 'local' || p.kind === 'sign-in') {
      try {
        const cfg = providerFor(p, providers);
        providers = [...providers, cfg];
        r.changes.push({ path: 'providers', provider: cfg.id });
        r.items.push({ kind: 'setting', table: 'settings.providers', id: cfg.id, ref: `${p.from}|${p.key}` });
        r.translated.push(line('tr-provider', `${p.old} → provider "${cfg.label}" in Settings → Models${cfg.defaultModel ? ` (${cfg.defaultModel})` : ''}`, { examples: [shownFrom(p.from)] }));
        if (p.kind === 'sign-in') r.needsYou.push(line('sign-in', `Sign in to ${cfg.label} with your own account (Settings → Models).`, { page: 'models' } as Partial<ReportLine>));
        else if (cfg.needsKey) keys.push(cfg.label);
      } catch (err) {
        r.needsYou.push(line('cfg-failed', `${p.title}: couldn't be added (${(err as Error).message}). Add it by hand in Settings → Models.`));
      }
      continue;
    }
    if (p.kind === 'voice') {
      const engine = p.choice ?? 'local';
      const before = s.voice ?? {};
      const v = { ...before, tts: engine } as NonNullable<Settings['voice']>;
      const id = p.data?.voiceId;
      if (id && engine === 'elevenlabs') v.elevenlabs = { model: 'eleven_multilingual_v2', ...(before.elevenlabs ?? {}), voiceId: id } as never;
      if (id && engine === 'xai') v.xai = { language: 'en', ...(before.xai ?? {}), voiceId: id.toLowerCase() } as never;
      if (id && engine === 'openai' && /^[a-z]+$/.test(id)) v.openai = { ...(before.openai ?? {}), ttsVoice: id } as never;
      patch.voice = v;
      r.changes.push({ path: 'voice', before: s.voice, after: v });
      r.items.push({ kind: 'setting', table: 'settings', id: 'voice', ref: `${p.from}|${p.key}` });
      r.translated.push(line('tr-voice', `voice ${p.old} → ${VOICE_LABEL[engine] ?? engine}${id && engine !== 'local' && engine !== 'off' ? `, voice ${id}` : ''} (Settings → Voice)`, { examples: [shownFrom(p.from)] }));
      if (engine === 'openai' || engine === 'elevenlabs' || engine === 'xai') keys.push(VOICE_LABEL[engine]);
      continue;
    }
    if (p.kind === 'timezone' && p.data?.zone && !s.timeZone) {
      patch.timeZone = p.data.zone;
      r.changes.push({ path: 'timeZone', before: undefined, after: p.data.zone });
      r.items.push({ kind: 'setting', table: 'settings', id: 'timeZone', ref: `${p.from}|${p.key}` });
      r.translated.push(line('tr-timezone', `time zone → ${p.data.zone} (Settings → You)`, { examples: [shownFrom(p.from)] }));
      continue;
    }
    r.leftBehind.push(line('cfg-kept', `${p.title}: Sara kept her own setting`, { examples: [shownFrom(p.from)] }));
  }
  if (keys.length) r.needsYou.unshift(line('keys', `Paste keys: ${[...new Set(keys)].join(', ')} (Settings → Models / Voice). Keys never move with a bundle.`, { count: new Set(keys).size, page: 'models' } as Partial<ReportLine>));
  if (routes.length) r.needsYou.push(line('routes', `Pick the models for each job once the providers work: ${routes.slice(0, 4).join('; ')} (Settings → Models → Which model does what).`, { count: routes.length, page: 'models' } as Partial<ReportLine>));

  // ---------------- hooks and plugins ----------------
  const perms = { ...(patch.toolPermissions ?? s.toolPermissions ?? {}) };
  let permsChanged = false;
  for (const c of code) {
    const label = `${c.kind} "${c.name}"`;
    const t = c.translation;
    if (c.state === 'skipped') {
      r.leftBehind.push(line('code-skipped', `${label}: you skipped it (its text is kept with this move-in)`, { examples: [c.folder] }));
      continue;
    }
    if (t.type === 'flag') {
      r.needsYou.push(line('code-flag', `${label}: ${c.summary} ${t.why ?? ''}`.trim(), { examples: [c.folder] }));
      continue;
    }
    if (t.type === 'rebuild') {
      r.needsYou.push(line('rebuild', `${label} → a rebuild plan: ${c.summary} Press "Rebuild as a Sara plugin" to start a coding task you approve.`, { examples: [c.folder], ref: c.key } as Partial<ReportLine>));
      continue;
    }
    if (t.type === 'left') {
      r.leftBehind.push(line('code-left', `${label}: ${t.why ?? t.feature ?? 'not needed in Sara'}`, { examples: [c.folder] }));
      continue;
    }
    if (c.state !== 'confirmed') {
      r.needsYou.push(line('code-undecided', `${label}: not decided, so nothing changed. Import the bundle again to decide.`, { examples: [c.folder] }));
      continue;
    }
    if (t.type === 'feature') {
      r.translated.push(line('tr-feature', `${label} → ${t.feature}${t.where ? ` (${t.where})` : ''}`, { examples: [c.folder] }));
      continue;
    }
    if (t.type === 'rule' && t.rule) {
      // §11.1: a rule that would weaken the safety layer never reaches her sheet (checked again here).
      if (unsafeLine(t.rule)) {
        r.leftBehind.push(line('safety-layer', `${label}: "${t.rule}" conflicts with Sara's safety layer`, { examples: [c.folder] }));
        continue;
      }
      r.rules.push(t.rule);
      r.items.push({ kind: 'persona-rule', table: 'persona.json', id: t.rule, ref: c.key });
      r.translated.push(line('tr-rule', `${label} → personality rule "${t.rule}" (Settings → Her → How she talks)`, { examples: [c.folder] }));
      continue;
    }
    if (t.type === 'guard' && t.tool) {
      const now = app.tools.permission(t.tool, perms);
      if (now === 'auto') {
        r.changes.push({ path: `toolPermissions.${t.tool}`, before: perms[t.tool], after: 'ask' });
        perms[t.tool] = 'ask';
        permsChanged = true;
        r.items.push({ kind: 'setting', table: 'settings', id: `toolPermissions.${t.tool}`, ref: c.key });
        r.translated.push(line('tr-guard', `${label} → Sara asks before "${t.tool}" (Settings → Coding → Tools and approvals)`, { examples: [c.folder] }));
      } else r.translated.push(line('tr-guard', `${label} → Sara already ${now === 'never' ? 'never uses' : 'asks before'} "${t.tool}"`, { examples: [c.folder] }));
      continue;
    }
    r.needsYou.push(line('code-flag', `${label}: ${c.summary}`, { examples: [c.folder] }));
  }
  if (permsChanged) patch.toolPermissions = perms;
  if (providers.length !== s.providers.length) patch.providers = providers;
  if (Object.keys(patch).length) app.settings.update(patch);
  return r;
}

/** Adds the confirmed rules to her sheet under "How you talk" (after the caller snapshotted persona.json). */
export function addRules(app: AppContext, rules: string[], write: (p: ReturnType<typeof validatePersona>) => void): number {
  const cur = app.persona;
  const add = rules.filter((x) => !cur.speech.includes(x) && !unsafeLine(x));
  if (!add.length) return 0;
  write(validatePersona({ ...cur, speech: [...cur.speech, ...add].slice(0, 40) }));
  return add.length;
}

/** The hook and plugin text, kept as .txt files (never runnable, outside every workspace). */
export async function keepCode(dir: string, inputs: CodeInput[]): Promise<number> {
  let n = 0;
  for (const i of inputs) {
    for (const [rel, text] of i.files) {
      const safe = rel.split('/').map((x) => x.replace(/[^\w.@+-]/g, '_')).filter((x) => x && x !== '..' && x !== '.').join('/');
      if (!safe) continue;
      const p = join(dir, 'code', `${i.kind}-${i.name.replace(/[^\w.-]/g, '_')}`, `${safe}.txt`);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileAtomic(p, text, 0o600);
      n++;
    }
  }
  return n;
}

const CHANGES = 'settings.changes.json';
export function saveChanges(dir: string, changes: SettingChange[]): void {
  if (!changes.length) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, CHANGES), JSON.stringify(changes, null, 1), 0o600);
}

/**
 * Undo for settings (§7.4): providers it added are removed; a value it changed goes back unless the
 * owner changed it again since (then the owner's value stays and it is listed).
 */
export function undoChanges(app: AppContext, dir: string): { restored: number; kept: string[] } {
  const f = join(dir, CHANGES);
  if (!existsSync(f)) return { restored: 0, kept: [] };
  const changes = JSON.parse(readFileSync(f, 'utf8')) as SettingChange[];
  const s = app.settings.get();
  const patch: Partial<Settings> = {};
  let restored = 0;
  const kept: string[] = [];
  const drop = new Set(changes.filter((c) => c.provider).map((c) => c.provider!));
  if (drop.size) {
    patch.providers = s.providers.filter((p) => !drop.has(p.id));
    restored += s.providers.length - patch.providers.length;
    // Routes the owner pointed at a removed provider fall back to the default.
    if (s.routes) patch.routes = Object.fromEntries(Object.entries(s.routes).filter(([, r]) => r && !drop.has(r.providerId))) as Settings['routes'];
    if (s.defaultProviderId && drop.has(s.defaultProviderId)) patch.defaultProviderId = undefined;
  }
  for (const c of changes.reverse()) {
    if (c.provider) continue;
    if (c.path.startsWith('toolPermissions.')) {
      const tool = c.path.slice('toolPermissions.'.length);
      const perms = { ...(patch.toolPermissions ?? s.toolPermissions ?? {}) };
      if (perms[tool] !== c.after) {
        kept.push(c.path);
        continue;
      }
      if (c.before === undefined) delete perms[tool];
      else perms[tool] = c.before as never;
      patch.toolPermissions = perms;
      restored++;
      continue;
    }
    const k = c.path as keyof Settings;
    if (!sameJson(s[k], c.after)) {
      kept.push(c.path);
      continue;
    }
    (patch as Record<string, unknown>)[k] = c.before;
    restored++;
  }
  if (Object.keys(patch).length) app.settings.update(patch);
  rmSync(f, { force: true });
  return { restored, kept };
}
