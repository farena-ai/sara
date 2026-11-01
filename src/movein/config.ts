// Phase 106 (MI3, docs/design/MOVE_IN.md §9.1, §9.2, §9.4): the old agent's settings, translated into
// PROPOSALS the owner decides one by one. The collector already parsed config.yaml / openclaw.json
// (+ its $include files) and replaced every secret value with {"$redacted": …}; this file reads those
// trees from the bundle (resolving $include across the packed files), and never sees a key. Nothing
// here changes Sara: src/movein/settings-apply.ts applies the confirmed proposals at Import.
//   provider   a provider entry per distinct endpoint, matched to Sara's catalog; key blank (re-enter it)
//   sign-in    subscription logins (ChatGPT, Claude, Grok): sign in again; others: needs you
//   local      Ollama / vLLM / llama.cpp: only if Sara's server reaches that address (net-guard)
//   route      which model did what (chat, vision, summaries, fallbacks): shown, set by hand
//   voice      the text-to-speech vendor + voice when Sara has it
//   channel    Telegram / Discord: "connect this" cards (never connected here); others: needs you
//   peer, webhook, mcp   connect cards (they arrive off; new keys and URLs are made in Sara)
//   timezone   Sara's time zone when hers is not set
//   approvals, sandbox, tools   shown ("you had allowed…"), never copied (§11.5)
//   roster     other agents of the same install: "make it a separate companion?"
//   knob       memory/compression/streaming knobs: left behind, "Sara manages this differently"
import { isIP } from 'node:net';
import type { Bundle } from './bundle.ts';
import { PROVIDER_PRESETS } from '../providers/registry.ts';
import type { ProviderConfig } from '../providers/types.ts';

export type ProposalKind = 'provider' | 'sign-in' | 'local' | 'route' | 'voice' | 'channel' | 'peer' | 'webhook' | 'mcp' | 'timezone' | 'approvals' | 'roster' | 'knob';
/** apply: becomes a Sara setting when confirmed · connect: a "connect this" card (steps for the owner) · info: shown, never copied. */
export type ProposalMode = 'apply' | 'connect' | 'info';
export type DecisionState = 'proposed' | 'confirmed' | 'skipped';

export interface Proposal {
  key: string;
  kind: ProposalKind;
  mode: ProposalMode;
  /** Short name ("OpenRouter", "Telegram"). */
  title: string;
  /** Bundle path + key path it came from (names only). */
  from: string;
  /** The old setting in plain words (no values that could be secret). */
  old: string;
  /** Pick-list (provider presets, voice engines…) and the proposed pick. */
  options?: { value: string; label: string }[];
  choice?: string;
  /** Payload for apply proposals (base URL, model, voice id, zone). Never a secret. */
  data?: Record<string, string>;
  /** Steps the owner does (connect cards; reconnect after apply). */
  steps?: string[];
  warn?: string;
  /** Where this lives in Sara now (a Settings path) and the page to open. */
  lives: string;
  page?: string;
  /** Names of the secret values that were removed (never the values). */
  secrets?: string[];
  /** local models: did Sara's server reach the address? */
  reach?: 'yes' | 'no' | 'unchecked';
  /** Why it is shown but not copied (info cards) or why it can't be applied. */
  why?: string;
  state: DecisionState;
}

/** A parsed, redacted config tree as the collector packed it. */
export interface ConfigTree {
  path: string;
  format: 'yaml' | 'json5' | 'skeleton' | string;
  tree: Record<string, unknown> | null;
  keys?: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const redacted = (v: unknown): boolean => isObj(v) && '$redacted' in v;
/** A plain string value (never a redacted one). */
const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), o);

/** Every key path in a tree whose value was removed as a secret (names only). */
export function secretNames(v: unknown, base = ''): string[] {
  if (redacted(v)) return [base || '(value)'];
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => secretNames(x, base ? `${base}.${k}` : k));
  if (Array.isArray(v)) return v.flatMap((x, i) => secretNames(x, `${base}[${i}]`));
  return [];
}

/** Every key path of a tree (for the "found, not understood" list and the counts-only runs). */
export function keyPaths(v: unknown, base = '', depth = 0): string[] {
  if (!isObj(v) || redacted(v) || depth > 6) return base ? [base] : [];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    const p = base ? `${base}.${k}` : k;
    if (isObj(x) && !redacted(x) && Object.keys(x).length) out.push(...keyPaths(x, p, depth + 1));
    else out.push(p);
  }
  return out;
}

/** The packed config trees of a bundle, with OpenClaw `$include` files merged in (depth ≤ 8, no loops). */
export async function configTrees(b: Bundle): Promise<ConfigTree[]> {
  const items = b.manifest.items.filter((it) => it.kind === 'config');
  const raw = new Map<string, ConfigTree>();
  for (const it of items) {
    try {
      const j = JSON.parse(await b.text(it.path, 8 * 1024 * 1024)) as { $format?: string; tree?: unknown; keys?: string[] };
      raw.set(it.path, { path: it.path, format: j.$format ?? it.format ?? 'json5', tree: isObj(j.tree) ? j.tree : null, ...(Array.isArray(j.keys) ? { keys: j.keys.map(String).slice(0, 2000) } : {}) });
    } catch {
      raw.set(it.path, { path: it.path, format: 'skeleton', tree: null, keys: [] });
    }
  }
  const byRel = (from: string, inc: string): ConfigTree | undefined => {
    // The include is relative to the including file; the collector packs it at its own path + ".json".
    const dir = from.split('/').slice(0, -1);
    const parts = [...dir];
    for (const p of inc.replace(/\\/g, '/').split('/')) {
      if (p === '..') parts.pop();
      else if (p && p !== '.') parts.push(p);
    }
    const want = `${parts.join('/')}.json`;
    return raw.get(want) ?? [...raw.values()].find((t) => t.path.endsWith(`/${inc.split('/').at(-1)}.json`));
  };
  const included = new Set<string>();
  const merge = (t: ConfigTree, v: unknown, depth: number, seen: Set<string>): unknown => {
    if (Array.isArray(v)) return v.map((x) => merge(t, x, depth, seen));
    if (!isObj(v) || redacted(v)) return v;
    const out: Obj = {};
    const inc = v.$include;
    for (const one of Array.isArray(inc) ? inc : inc ? [inc] : []) {
      const sub = typeof one === 'string' && depth < 8 ? byRel(t.path, one) : undefined;
      if (!sub || seen.has(sub.path) || !sub.tree) continue;
      included.add(sub.path);
      const m = merge(sub, sub.tree, depth + 1, new Set([...seen, sub.path]));
      if (isObj(m)) Object.assign(out, m);
    }
    for (const [k, x] of Object.entries(v)) if (k !== '$include') out[k] = merge(t, x, depth, seen);
    return out;
  };
  const out: ConfigTree[] = [];
  for (const t of raw.values()) out.push(t.tree ? { ...t, tree: merge(t, t.tree, 0, new Set([t.path])) as Obj } : t);
  return out.filter((t) => !included.has(t.path));
}

// ---------------------------------------------------------------------------------------------
// Matching providers to Sara's catalog (src/providers/registry.ts PROVIDER_PRESETS)
// ---------------------------------------------------------------------------------------------
const VENDOR: { re: RegExp; preset: string }[] = [
  { re: /openrouter/i, preset: 'openrouter' },
  { re: /anthropic|claude/i, preset: 'anthropic' },
  { re: /\bx\.?ai\b|grok/i, preset: 'xai' },
  { re: /ollama\.com|ollama[-_ ]?cloud/i, preset: 'ollama-cloud' },
  { re: /ollama|vllm|llama\.?cpp|lm[-_ ]?studio|localai/i, preset: 'ollama-local' },
  { re: /openai|gpt/i, preset: 'openai' },
];
/** Old login kinds → Sara's own sign-in (ChatGPT plan, Claude, Grok) when she has one. */
const SIGN_IN: { re: RegExp; preset: string }[] = [
  { re: /codex|chatgpt|openai[-_ ]?(oauth|codex|plan)/i, preset: 'chatgpt' },
  { re: /claude[-_ ]?(code|max|pro|sub|oauth)|anthropic[-_ ]?oauth/i, preset: 'claude-sub' },
  { re: /grok[-_ ]?(cli|sub|oauth)|supergrok|x[-_ ]?premium/i, preset: 'grok-sub' },
];
const OTHER = 'other-openai';

export const presetLabel = (id: string): string => PROVIDER_PRESETS.find((p) => p.id === id)?.label ?? (id === OTHER ? 'Other (OpenAI-compatible, same address)' : id);
/** The pick-list on every provider card: Sara's catalog names (key-based and local only). */
export function providerOptions(): { value: string; label: string }[] {
  return [...PROVIDER_PRESETS.filter((p) => p.kind === 'openai-compatible' || p.kind === 'anthropic').map((p) => ({ value: p.id, label: p.label })), { value: OTHER, label: presetLabel(OTHER) }];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
/** True for an address that points at the old machine itself or its home network. */
export function localAddress(url: string): boolean {
  const h = hostOf(url).replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.ts.net') || h.endsWith('.internal') || h.endsWith('.home')) return true;
  if (isIP(h) === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(h);
  if (isIP(h) === 6) return h === '::1' || /^(fc|fd|fe80)/i.test(h);
  return !h.includes('.');
}

export function matchPreset(name: string, baseUrl: string): string {
  const hay = `${name} ${baseUrl}`;
  if (baseUrl && localAddress(baseUrl)) return 'ollama-local';
  return VENDOR.find((v) => v.re.test(hay))?.preset ?? (baseUrl ? OTHER : 'openai');
}

interface Endpoint {
  name: string;
  baseUrl: string;
  models: Set<string>;
  from: string;
  secrets: string[];
  api?: string;
}

/** "openrouter/meta-llama/x" → provider "openrouter", model "meta-llama/x" (OpenClaw style). */
function splitModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: '', model: ref };
}

// ---------------------------------------------------------------------------------------------
// The translation
// ---------------------------------------------------------------------------------------------
export interface TranslateContext {
  kind: 'hermes' | 'openclaw' | 'custom';
  agentId: string;
  /** Sara's own time zone (a proposal only when it is not set). */
  timeZone?: string;
  /** Sara's providers already set up (an endpoint she has is not proposed twice). */
  providers: ProviderConfig[];
}

/** Voice vendors Sara speaks with (src/voice.ts TtsEngine) and the old names that mean them. */
const TTS: { re: RegExp; engine: string; label: string }[] = [
  { re: /eleven/i, engine: 'elevenlabs', label: 'ElevenLabs' },
  { re: /\bx\.?ai\b|grok/i, engine: 'xai', label: 'xAI (Grok voice)' },
  { re: /openai/i, engine: 'openai', label: 'OpenAI' },
  { re: /edge|piper|kokoro|local|coqui|neutts|kitten|system|say/i, engine: 'local', label: "Sara's own voice on the server" },
];
const TTS_OPTIONS = [
  { value: 'local', label: "Sara's own voice on the server" },
  { value: 'openai', label: 'OpenAI' },
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'xai', label: 'xAI (Grok voice)' },
  { value: 'off', label: 'No voice' },
];

const CHANNELS: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp', imessage: 'iMessage', bluebubbles: 'iMessage', signal: 'Signal', slack: 'Slack', matrix: 'Matrix', mattermost: 'Mattermost', email: 'Email', sms: 'SMS', teams: 'Microsoft Teams', msteams: 'Microsoft Teams', googlechat: 'Google Chat', line: 'LINE', irc: 'IRC', twitch: 'Twitch', nostr: 'Nostr', homeassistant: 'Home Assistant', webchat: 'Web chat', api_server: 'API server', webhook: 'Webhook' };
/** Sara's own bridges (the rest: "Sara doesn't speak X yet"). */
const BRIDGED = new Set(['telegram', 'discord']);

/** Knobs Sara manages her own way: the Sara setting to look at instead. */
const KNOBS: [RegExp, string, string][] = [
  [/^(memory|memories|compression|compaction|context|session|sessions|history|summar)/i, 'Settings → Memory', 'memory'],
  [/^(display|ui|theme|streaming|stream|cli|terminal|tui|skin|banner)/i, 'Settings → Look', 'look'],
  [/^(max_tokens|max_turns|temperature|reasoning|thinking|iterations|budget|limits?|rate)/i, 'Settings → Abilities → Budgets', 'budgets'],
  [/^(gateway|server|port|host|bind|logging|log|telemetry|metrics|update|updates|diagnostics|debug)/i, 'Settings → Data & health', 'checkup'],
  [/^(browser|web|search)/i, 'Settings → Abilities → Web search', 'abilities'],
  [/^(cron|automations?|schedules?)/i, 'Your planner (schedules came across as tasks)', 'planner'],
  [/^(skills?|plugins?|hooks?|extensions?)/i, 'Settings → Abilities', 'abilities'],
  [/^(agent|agents|personalit|persona|soul|identity)/i, 'Settings → Her', 'her'],
];

const SKIP_TOP = new Set(['$include', '$schema', 'version', 'meta', 'wizard', 'lastRunVersion']);

export function translateConfig(trees: ConfigTree[], ctx: TranslateContext): Proposal[] {
  const out: Proposal[] = [];
  const add = (p: Omit<Proposal, 'state'>) => {
    if (!out.some((x) => x.key === p.key)) out.push({ ...p, state: 'proposed' });
  };
  const handled = new Set<string>();
  for (const t of trees) {
    if (!t.tree) {
      // Only key names survived (the collector couldn't read the file confidently).
      add({ key: `skeleton:${t.path}`, kind: 'knob', mode: 'info', title: t.path.split('/').at(-1)!.replace(/\.json$/, ''), from: t.path, old: `${t.keys?.length ?? 0} setting names (the file couldn't be read confidently, so only its key names came along)`, lives: 'Settings', why: 'Only the names of these settings came along; set the ones you need by hand.' });
      continue;
    }
    if (ctx.kind === 'openclaw' || t.path.endsWith('openclaw.json.json')) openclaw(t, ctx, add, handled);
    else hermes(t, ctx, add, handled);
    // Everything else at the top: left behind with the Sara setting to look at (never silent).
    for (const [k, v] of Object.entries(t.tree)) {
      if (handled.has(`${t.path}#${k}`) || SKIP_TOP.has(k)) continue;
      const knob = KNOBS.find(([re]) => re.test(k));
      const names = isObj(v) ? Object.keys(v).slice(0, 6).join(', ') : '';
      add({ key: `knob:${k}`, kind: 'knob', mode: 'info', title: k, from: `${t.path}#${k}`, old: names ? `${k}: ${names}${isObj(v) && Object.keys(v).length > 6 ? '…' : ''}` : k, lives: knob?.[1] ?? 'Settings', ...(knob ? { page: knob[2] } : {}), why: 'Sara manages this differently.', ...(secretNames(v, k).length ? { secrets: secretNames(v, k).slice(0, 12) } : {}) });
    }
  }
  return out;
}

type Add = (p: Omit<Proposal, 'state'>) => void;

/** Endpoints → provider proposals (one per distinct address), with their models. */
function providers(eps: Endpoint[], ctx: TranslateContext, add: Add): void {
  const seen = new Map<string, Endpoint>();
  for (const e of eps) {
    const key = (e.baseUrl || e.name).toLowerCase().replace(/\/+$/, '');
    const was = seen.get(key);
    if (was) {
      for (const m of e.models) was.models.add(m);
      was.secrets.push(...e.secrets);
    } else seen.set(key, { ...e, models: new Set(e.models), secrets: [...e.secrets] });
  }
  for (const e of seen.values()) {
    const login = SIGN_IN.find((x) => x.re.test(`${e.name} ${e.api ?? ''}`));
    const model = [...e.models][0] ?? '';
    if (login) {
      add({ key: `sign-in:${e.name}`, kind: 'sign-in', mode: 'apply', title: presetLabel(login.preset), from: e.from, old: `signed in to ${e.name}${model ? ` (model ${model})` : ''}`, choice: login.preset, options: [{ value: login.preset, label: presetLabel(login.preset) }], data: { preset: login.preset, ...(model ? { model } : {}) }, steps: [`Settings → Models → ${presetLabel(login.preset)}: sign in with your own account.`], lives: 'Settings → Models', page: 'models' });
      continue;
    }
    if (/nous|portal|copilot|gemini[-_ ]?cli|qwen[-_ ]?(oauth|portal)|minimax[-_ ]?portal/i.test(e.name) && !e.baseUrl) {
      add({ key: `sign-in:${e.name}`, kind: 'sign-in', mode: 'info', title: e.name, from: e.from, old: `signed in to ${e.name}`, lives: 'Settings → Models', page: 'models', why: `Sara can't sign in to ${e.name}. Add another model in Settings → Models, or that service's API key if it has one.` });
      continue;
    }
    const preset = matchPreset(e.name, e.baseUrl);
    const base = e.baseUrl || PROVIDER_PRESETS.find((p) => p.id === preset)?.baseUrl || '';
    if (preset === 'ollama-local') {
      add({ key: `local:${base || e.name}`, kind: 'local', mode: 'apply', title: e.name || 'Local models', from: e.from, old: `${e.name || 'local models'} at ${base}${model ? ` (model ${model})` : ''}`, choice: 'ollama-local', options: providerOptions(), data: { baseUrl: base, ...(model ? { model } : {}), name: e.name }, reach: 'unchecked', lives: 'Settings → Models', page: 'models', warn: "That address is the old machine's own. Sara checks whether her server can reach it before it is added." });
      continue;
    }
    if (ctx.providers.some((p) => p.baseUrl.replace(/\/+$/, '').toLowerCase() === base.replace(/\/+$/, '').toLowerCase())) {
      add({ key: `provider:${e.name}`, kind: 'provider', mode: 'info', title: presetLabel(preset), from: e.from, old: `${e.name}${model ? ` (model ${model})` : ''}`, lives: 'Settings → Models', page: 'models', why: 'Sara already has this provider set up.' });
      continue;
    }
    add({ key: `provider:${e.name}`, kind: 'provider', mode: 'apply', title: presetLabel(preset), from: e.from, old: `${e.name}${base ? ` at ${base}` : ''}${model ? ` (model ${model})` : ''}`, options: providerOptions(), choice: preset, data: { baseUrl: base, ...(model ? { model } : {}), name: e.name }, ...(e.secrets.length ? { secrets: [...new Set(e.secrets)].slice(0, 6) } : {}), steps: ['Paste your key in Settings → Models (keys never move with the bundle).'], lives: 'Settings → Models', page: 'models' });
  }
}

function voice(t: ConfigTree, path: string, v: unknown, add: Add): void {
  if (!isObj(v)) return;
  const vendor = s(v.provider) || s(v.engine) || s(v.backend) || Object.keys(v).find((k) => isObj(v[k]) && TTS.some((x) => x.re.test(k))) || '';
  if (!vendor) return;
  const sub = isObj(v[vendor]) ? (v[vendor] as Obj) : v;
  const voiceId = s(sub.voice_id) || s(sub.voiceId) || s(sub.voice) || s(v.voice) || s(v.voiceId);
  const m = TTS.find((x) => x.re.test(vendor));
  add({ key: 'voice', kind: 'voice', mode: 'apply', title: m?.label ?? vendor, from: `${t.path}#${path}`, old: `${vendor}${voiceId ? `, voice ${voiceId}` : ''}`, options: TTS_OPTIONS, choice: m?.engine ?? 'local', data: { vendor, ...(voiceId ? { voiceId } : {}) }, ...(secretNames(v, path).length ? { secrets: secretNames(v, path).slice(0, 6) } : {}), ...(m ? {} : { warn: `Sara has no ${vendor} voice; her own voice on the server is the nearest.` }), steps: m && m.engine !== 'local' ? [`Paste your ${m.label} key in Settings → Voice.`] : [], lives: 'Settings → Voice', page: 'voice' });
}

function channel(t: ConfigTree, path: string, name: string, v: unknown, add: Add): void {
  const id = name.toLowerCase();
  const label = CHANNELS[id] ?? name;
  const on = isObj(v) ? v.enabled !== false : Boolean(v);
  const allow = isObj(v) ? [v.allowFrom, v.allowlist, v.allowed_users, v.allowedUsers, v.allow_from, v.dmAllowFrom].find(Array.isArray) as unknown[] | undefined : undefined;
  const phones = (allow ?? []).filter((x) => /^\+?\d[\d\s*().-]{6,}$/.test(String(x))).length;
  const groups = isObj(v) && (isObj(v.groups) || Array.isArray(v.groups)) ? Object.keys(v.groups as object).length : 0;
  const secrets = secretNames(v, path);
  const facts = [on ? 'on' : 'off', allow?.length ? `${allow.length} allowed senders${phones ? ` (${phones} phone numbers)` : ''}` : '', groups ? `${groups} groups` : '', secrets.length ? `token removed (${secrets.map((x) => x.split('.').at(-1)).join(', ')})` : ''].filter(Boolean).join(', ');
  if (BRIDGED.has(id)) {
    add({
      key: `channel:${id}`, kind: 'channel', mode: 'connect', title: label, from: `${t.path}#${path}`, old: `${label}: ${facts}`,
      steps: id === 'telegram'
        ? ['Stop the old agent\'s Telegram bot first, or both of us will answer.', 'Settings → Telegram: paste the bot token (or make a new bot with @BotFather).', 'Send your bot /start to link your private chat.']
        : ['Stop the old agent\'s Discord bot first, or both of us will answer.', 'Settings → Discord: paste the bot token (or make a new bot in the Discord developer portal).', 'Invite the bot and send it a direct message to link yourself.'],
      warn: `Stop the old agent's ${label} bot before turning this on, or both of us will answer.`,
      ...(allow?.length ? { why: `The old allowlist is not copied: in Sara only you can talk to her there until you switch on "Let others talk to her". ${phones ? 'Phone numbers are personal data and stay out of her memory.' : ''}`.trim() } : {}),
      ...(secrets.length ? { secrets: secrets.slice(0, 6) } : {}), lives: `Settings → ${label}`, page: id,
    });
    return;
  }
  add({ key: `channel:${id}`, kind: 'channel', mode: 'info', title: label, from: `${t.path}#${path}`, old: `${label}: ${facts}`, lives: 'Settings → Abilities → Plugins', page: 'plugins', why: `Sara doesn't speak ${label} yet. A plugin bridge can add it (Settings → Abilities → Plugins).`, ...(secrets.length ? { secrets: secrets.slice(0, 6) } : {}) });
}

function approvals(t: ConfigTree, path: string, v: unknown, what: string, add: Add): void {
  const list = Array.isArray(v) ? v.length : isObj(v) ? Object.values(v).reduce<number>((n, x) => n + (Array.isArray(x) ? x.length : 1), 0) : 1;
  add({ key: `approvals:${path}`, kind: 'approvals', mode: 'info', title: what, from: `${t.path}#${path}`, old: `On the old agent you had allowed: ${what.toLowerCase()} (${list} ${list === 1 ? 'entry' : 'entries'})`, lives: 'Settings → Abilities → Tools', page: 'abilities', why: 'Sara asks in her own way: an old allowlist never becomes "Always allowed" here. Look at Settings → Abilities.' });
}

function timezone(t: ConfigTree, path: string, zone: string, ctx: TranslateContext, add: Add): void {
  if (!zone) return;
  let ok = true;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    ok = false;
  }
  if (!ok) return;
  if (ctx.timeZone) add({ key: 'timezone', kind: 'timezone', mode: 'info', title: zone, from: `${t.path}#${path}`, old: `time zone ${zone}`, lives: 'Settings → You', page: 'you', why: ctx.timeZone === zone ? 'Sara already uses this time zone.' : `Sara already has a time zone (${ctx.timeZone}); she keeps hers.` });
  else add({ key: 'timezone', kind: 'timezone', mode: 'apply', title: zone, from: `${t.path}#${path}`, old: `time zone ${zone}`, data: { zone }, lives: 'Settings → You', page: 'you' });
}

function webhooks(t: ConfigTree, path: string, v: unknown, add: Add): void {
  const maps = isObj(v) && Array.isArray(v.mappings) ? v.mappings.length : 0;
  const names = isObj(v) && Array.isArray(v.mappings) ? (v.mappings as unknown[]).map((m) => s(get(m, 'name')) || s(get(m, 'id')) || s(get(m, 'match.path'))).filter(Boolean).slice(0, 5) : [];
  add({ key: `webhook:${path}`, kind: 'webhook', mode: 'connect', title: 'Incoming webhooks', from: `${t.path}#${path}`, old: `HTTP webhooks into the old agent${maps ? ` (${maps} mappings${names.length ? `: ${names.join(', ')}` : ''})` : ''}`, steps: ['Settings → Webhooks: make a new webhook for each sender (it starts off).', 'Give the sender the new signed address; the old one stops working when the old agent stops.'], lives: 'Settings → Webhooks', page: 'hooks', why: 'Old webhook addresses and tokens are not carried over; Sara makes new signed ones.', ...(secretNames(v, path).length ? { secrets: secretNames(v, path).slice(0, 6) } : {}) });
}

function peers(t: ConfigTree, path: string, v: unknown, add: Add): void {
  const list = Array.isArray(v) ? v : isObj(v) ? Object.entries(v).filter(([, x]) => isObj(x)).map(([k, x]) => ({ name: k, ...(x as Obj) })) : [];
  for (const [i, p] of list.slice(0, 20).entries()) {
    const name = s(get(p, 'name')) || s(get(p, 'label')) || s(get(p, 'id')) || `peer ${i + 1}`;
    const url = s(get(p, 'url')) || s(get(p, 'card_url')) || s(get(p, 'cardUrl')) || s(get(p, 'agent_card'));
    add({ key: `peer:${name}`, kind: 'peer', mode: 'connect', title: name, from: `${t.path}#${path}`, old: `another agent: ${name}${url ? ` (${hostOf(url) || 'address'})` : ''}`, steps: ['Settings → Other agents: add it again and issue it a new key (it starts off).'], lives: 'Settings → Other agents', page: 'agents', why: 'Agent-to-agent keys are not carried over.' });
  }
}

function mcp(t: ConfigTree, path: string, v: unknown, add: Add): void {
  if (!isObj(v)) return;
  for (const [name, x] of Object.entries(v).slice(0, 30)) {
    const cmd = s(get(x, 'command')) || s(get(x, 'url'));
    add({ key: `mcp:${name}`, kind: 'mcp', mode: 'connect', title: name, from: `${t.path}#${path}.${name}`, old: `MCP server ${name}${cmd ? ` (${cmd.split(/[\\/]/).at(-1)!.slice(0, 40)})` : ''}`, steps: ['Settings → Abilities → MCP servers: add it again if you still want it (programs never start from a move-in).'], lives: 'Settings → Abilities → MCP servers', page: 'mcp', ...(secretNames(x, `${path}.${name}`).length ? { secrets: secretNames(x, `${path}.${name}`).slice(0, 6) } : {}) });
  }
}

function hermes(t: ConfigTree, ctx: TranslateContext, add: Add, handled: Set<string>): void {
  const c = t.tree!;
  const mark = (k: string) => handled.add(`${t.path}#${k}`);
  const eps: Endpoint[] = [];
  // model: "name" or { default, provider, base_url }
  const m = c.model;
  const main = typeof m === 'string' ? { provider: '', model: m, base: '' } : isObj(m) ? { provider: s(m.provider), model: s(m.default) || s(m.name) || s(m.model), base: s(m.base_url) || s(m.baseUrl) } : undefined;
  if (main) {
    mark('model');
    eps.push({ name: main.provider || (main.base ? hostOf(main.base) : 'openai'), baseUrl: main.base, models: new Set(main.model ? [main.model] : []), from: `${t.path}#model`, secrets: secretNames(m, 'model') });
    if (main.model) add({ key: 'route:chat', kind: 'route', mode: 'info', title: 'Chat model', from: `${t.path}#model`, old: `chat with ${main.model}${main.provider ? ` on ${main.provider}` : ''}`, lives: 'Settings → Models → Which model does what', page: 'models', why: 'Pick it for Chat once its provider works (after you paste the key).' });
  }
  if (isObj(c.providers)) {
    mark('providers');
    for (const [name, p] of Object.entries(c.providers)) eps.push({ name, baseUrl: s(get(p, 'base_url')) || s(get(p, 'baseUrl')) || s(get(p, 'api_base')), models: new Set([s(get(p, 'model')), s(get(p, 'default_model'))].filter(Boolean)), from: `${t.path}#providers.${name}`, secrets: secretNames(p, `providers.${name}`), api: s(get(p, 'auth')) || s(get(p, 'type')) });
  }
  for (const k of ['fallback_providers', 'fallback_model', 'fallbacks']) {
    const f = c[k];
    if (f === undefined) continue;
    mark(k);
    const list = (Array.isArray(f) ? f : [f]).map((x) => (typeof x === 'string' ? x : s(get(x, 'model')) || s(get(x, 'provider')))).filter(Boolean);
    for (const x of list) {
      const r = splitModelRef(x);
      if (r.provider && !eps.some((e) => e.name === r.provider)) eps.push({ name: r.provider, baseUrl: '', models: new Set([r.model]), from: `${t.path}#${k}`, secrets: [] });
    }
    if (list.length) add({ key: `route:fallback:${k}`, kind: 'route', mode: 'info', title: 'Backup models', from: `${t.path}#${k}`, old: `backup models in order: ${list.slice(0, 4).join(', ')}`, lives: 'Settings → Models → Which model does what', page: 'models', why: 'Set the same order under "if it fails" once the providers work.' });
  }
  if (isObj(c.auxiliary)) {
    mark('auxiliary');
    for (const [task, a] of Object.entries(c.auxiliary)) {
      const model = s(get(a, 'model'));
      const job = /vision|image/i.test(task) ? 'Pictures (vision)' : /compress|summar|memory|title/i.test(task) ? 'Background' : /web|search|extract/i.test(task) ? 'Research' : 'Quick';
      if (s(get(a, 'provider')) || s(get(a, 'base_url'))) eps.push({ name: s(get(a, 'provider')) || hostOf(s(get(a, 'base_url'))), baseUrl: s(get(a, 'base_url')), models: new Set(model ? [model] : []), from: `${t.path}#auxiliary.${task}`, secrets: secretNames(a, `auxiliary.${task}`) });
      if (model) add({ key: `route:aux:${task}`, kind: 'route', mode: 'info', title: job, from: `${t.path}#auxiliary.${task}`, old: `${task} with ${model}`, lives: 'Settings → Models → Which model does what', page: 'models', why: `Pick it for "${job}" once its provider works.` });
    }
  }
  providers(eps, ctx, add);
  if (c.tts !== undefined) {
    mark('tts');
    voice(t, 'tts', c.tts, add);
  }
  for (const k of ['platforms', 'messaging', 'gateway_platforms']) {
    if (!isObj(c[k])) continue;
    mark(k);
    for (const [name, v] of Object.entries(c[k] as Obj)) channel(t, `${k}.${name}`, name, v, add);
  }
  for (const k of ['approvals', 'command_allowlist', 'allowlist', 'permissions', 'tool_permissions']) {
    if (c[k] === undefined) continue;
    mark(k);
    approvals(t, k, c[k], k === 'approvals' ? 'Commands approved "always"' : 'Allowed commands and tools', add);
  }
  if (isObj(c.terminal) && (c.terminal.backend === 'local' || c.terminal.sandbox === false)) approvals(t, 'terminal', c.terminal, 'Commands without a sandbox', add);
  for (const k of ['timezone', 'time_zone', 'tz']) if (s(c[k])) {
    mark(k);
    timezone(t, k, s(c[k]), ctx, add);
  }
  for (const k of ['mcp_servers', 'mcpServers', 'mcp']) if (isObj(c[k])) {
    mark(k);
    mcp(t, k, isObj((c[k] as Obj).servers) ? (c[k] as Obj).servers : c[k], add);
  }
  for (const k of ['a2a', 'peers', 'agents_peers']) if (c[k] !== undefined) {
    mark(k);
    peers(t, k, isObj(c[k]) && (c[k] as Obj).peers !== undefined ? (c[k] as Obj).peers : c[k], add);
  }
  for (const k of ['webhooks', 'webhook', 'webhook_subscriptions']) if (c[k] !== undefined) {
    mark(k);
    webhooks(t, k, c[k], add);
  }
  // agent.personalities and plugins.enabled are read elsewhere (persona drafts, the code cards).
  if (isObj(c.agent) && Object.keys(c.agent).every((k) => k === 'personalities')) mark('agent');
  if (isObj(c.plugins) && Object.keys(c.plugins).every((k) => k === 'enabled' || k === 'disabled')) mark('plugins');
}

function openclaw(t: ConfigTree, ctx: TranslateContext, add: Add, handled: Set<string>): void {
  const c = t.tree!;
  const mark = (k: string) => handled.add(`${t.path}#${k}`);
  const eps: Endpoint[] = [];
  const agents = isObj(c.agents) ? c.agents : {};
  const defaults = isObj(agents.defaults) ? agents.defaults : {};
  if (isObj(c.agents)) mark('agents');
  // Model choice: agents.defaults.model ("provider/model" or { primary, fallbacks }) and per agent.
  const entries: [string, Obj][] = isObj(agents.entries) ? Object.entries(agents.entries).filter(([, v]) => isObj(v)).map(([k, v]) => [k, v as Obj]) : Array.isArray(agents.list) ? (agents.list as unknown[]).filter(isObj).map((v) => [s(v.id) || s(v.name) || 'agent', v]) : [];
  const mine = entries.find(([id]) => id === ctx.agentId)?.[1] ?? {};
  const modelOf = (v: unknown): { primary: string; fallbacks: string[] } => (typeof v === 'string' ? { primary: v, fallbacks: [] } : isObj(v) ? { primary: s(v.primary) || s(v.default), fallbacks: Array.isArray(v.fallbacks) ? v.fallbacks.map(s).filter(Boolean) : [] } : { primary: '', fallbacks: [] });
  const chosen = modelOf(mine.model ?? defaults.model);
  const image = modelOf(mine.imageModel ?? defaults.imageModel);
  for (const ref of [chosen.primary, ...chosen.fallbacks, image.primary].filter(Boolean)) {
    const r = splitModelRef(ref);
    eps.push({ name: r.provider || 'openai', baseUrl: '', models: new Set([r.model]), from: `${t.path}#agents.defaults.model`, secrets: [] });
  }
  if (chosen.primary) add({ key: 'route:chat', kind: 'route', mode: 'info', title: 'Chat model', from: `${t.path}#agents.defaults.model`, old: `chat with ${chosen.primary}`, lives: 'Settings → Models → Which model does what', page: 'models', why: 'Pick it for Chat once its provider works (after you paste the key).' });
  if (chosen.fallbacks.length) add({ key: 'route:fallback', kind: 'route', mode: 'info', title: 'Backup models', from: `${t.path}#agents.defaults.model.fallbacks`, old: `backup models in order: ${chosen.fallbacks.slice(0, 4).join(', ')}`, lives: 'Settings → Models → Which model does what', page: 'models', why: 'Set the same order under "if it fails" once the providers work.' });
  if (image.primary) add({ key: 'route:vision', kind: 'route', mode: 'info', title: 'Pictures (vision)', from: `${t.path}#agents.defaults.imageModel`, old: `pictures with ${image.primary}`, lives: 'Settings → Models → Which model does what', page: 'models', why: 'Pick it for "Pictures (vision)" once its provider works.' });
  // models.providers: { name: { baseUrl, apiKey, api, models: [...] } }
  const mp = get(c, 'models.providers');
  if (isObj(mp)) {
    mark('models');
    for (const [name, p] of Object.entries(mp)) {
      const ms = Array.isArray(get(p, 'models')) ? (get(p, 'models') as unknown[]).map((x) => (typeof x === 'string' ? x : s(get(x, 'id')))).filter(Boolean) : [];
      const at = eps.findIndex((e) => e.name === name && !e.baseUrl);
      const ep: Endpoint = { name, baseUrl: s(get(p, 'baseUrl')) || s(get(p, 'baseURL')) || s(get(p, 'base_url')), models: new Set([...(at >= 0 ? eps[at].models : []), ...ms.slice(0, 3)]), from: `${t.path}#models.providers.${name}`, secrets: secretNames(p, `models.providers.${name}`), api: s(get(p, 'api')) };
      if (at >= 0) eps.splice(at, 1, ep);
      else eps.push(ep);
    }
  }
  // Subscription logins (auth profiles: names only; the profiles file itself is never collected).
  const profiles = get(c, 'auth.profiles');
  if (isObj(profiles)) {
    mark('auth');
    for (const [name, p] of Object.entries(profiles)) eps.push({ name: `${s(get(p, 'provider')) || name}`, baseUrl: '', models: new Set(), from: `${t.path}#auth.profiles.${name}`, secrets: [], api: `${s(get(p, 'mode'))} oauth` });
  }
  providers(eps, ctx, add);
  // Voice: tts / messages.tts / talk
  for (const k of ['tts', 'messages.tts', 'talk', 'voice']) {
    const v = get(c, k);
    if (isObj(v)) {
      mark(k.split('.')[0]);
      voice(t, k, v, add);
      break;
    }
  }
  if (isObj(c.channels)) {
    mark('channels');
    for (const [name, v] of Object.entries(c.channels)) {
      if (/^(a2a|agents?)$/i.test(name)) peers(t, `channels.${name}`, isObj(v) && v.peers !== undefined ? v.peers : v, add);
      else if (name !== 'defaults') channel(t, `channels.${name}`, name, v, add);
    }
  }
  // hooks.enabled = HTTP ingress (webhooks); hooks.internal = the hook code (read as code cards).
  if (isObj(c.hooks)) {
    mark('hooks');
    if (c.hooks.enabled === true || Array.isArray(c.hooks.mappings)) webhooks(t, 'hooks', c.hooks, add);
  }
  const sandbox = defaults.sandbox ?? mine.sandbox;
  if (sandbox !== undefined) approvals(t, 'agents.defaults.sandbox', sandbox, isObj(sandbox) && s(sandbox.mode) === 'off' ? 'Commands without a sandbox' : 'Sandbox settings', add);
  if (isObj(c.tools)) {
    mark('tools');
    approvals(t, 'tools', c.tools, 'Allowed tools and commands', add);
  }
  if (isObj(c.approvals)) {
    mark('approvals');
    approvals(t, 'approvals', c.approvals, 'Commands approved "always"', add);
  }
  timezone(t, 'agents.defaults.userTimezone', s(defaults.userTimezone) || s(mine.userTimezone), ctx, add);
  for (const [id, e] of entries) {
    if (id === ctx.agentId || entries.length < 2) continue;
    add({ key: `roster:${id}`, kind: 'roster', mode: 'info', title: s(e.name) || id, from: `${t.path}#agents.entries.${id}`, old: `another agent on the same install: ${s(e.name) || id}`, lives: 'Settings → Companions', page: 'companions', why: 'Make it a separate companion? Run the collector again for that agent and move it into a new companion; it is never merged into this one.' });
  }
  if (isObj(c.mcp) || isObj(c.mcpServers)) {
    mark(isObj(c.mcp) ? 'mcp' : 'mcpServers');
    mcp(t, 'mcp', isObj(c.mcpServers) ? c.mcpServers : isObj(get(c, 'mcp.servers')) ? get(c, 'mcp.servers') : c.mcp, add);
  }
  // skills.entries.* keys and plugin configs: names of removed secrets (the skills/code cards say what).
  if (isObj(c.skills)) {
    mark('skills');
    const names = secretNames(c.skills, 'skills');
    if (names.length) add({ key: 'skill-keys', kind: 'knob', mode: 'info', title: 'Skill keys', from: `${t.path}#skills`, old: `${names.length} keys for skills (removed)`, secrets: names.slice(0, 12), lives: 'Settings → Abilities → Skills', page: 'skills', why: 'Add the keys again for the skills that need them.' });
  }
  if (isObj(c.plugins)) mark('plugins');
}

/** Plugin and hook names switched on in the old config (Hermes plugins.enabled, OpenClaw plugins.entries / hooks.internal.entries). */
export function enabledPlugins(trees: ConfigTree[]): { hooks: Set<string>; plugins: Set<string> } {
  const plugins = new Set<string>();
  const hooks = new Set<string>();
  for (const t of trees) {
    const p = t.tree?.plugins;
    if (isObj(p) && Array.isArray(p.enabled)) for (const x of p.enabled) plugins.add(String(x));
    if (isObj(p) && isObj(p.entries)) for (const [k, v] of Object.entries(p.entries)) if (!isObj(v) || v.enabled !== false) plugins.add(k);
    const h = get(t.tree, 'hooks.internal.entries');
    if (isObj(h)) for (const [k, v] of Object.entries(h)) if (!isObj(v) || v.enabled !== false) hooks.add(k);
  }
  return { hooks, plugins };
}

/** §9.1 local models: does Sara's server reach that address? (net-guard; loopback/LAN addresses only.) */
export async function reachable(baseUrl: string, fetcher: (u: string, init: RequestInit) => Promise<Response>, ms = 2500): Promise<boolean> {
  if (!localAddress(baseUrl)) return false;
  let root: string;
  try {
    const u = new URL(baseUrl);
    root = `${u.protocol}//${u.host}`;
  } catch {
    return false;
  }
  for (const path of ['/api/tags', '/v1/models']) {
    try {
      const r = await fetcher(`${root}${path}`, { signal: AbortSignal.timeout(ms) });
      await r.body?.cancel().catch(() => undefined);
      if (r.ok) return true;
    } catch {
      /* not reachable from here */
    }
  }
  return false;
}
