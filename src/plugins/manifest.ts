// Phase 98 (ST3, docs/design/STAPLES.md §6.2): the plugin manifest, `sara-plugin.json`.
// Install refuses a manifest with an unknown key or permission, a hook outside the list, a setting
// without a ? tip, a network entry that is an IP literal, a private name or a bare "*", bad semver,
// or a `sara` range this server doesn't satisfy. Everything here is pure (no files, no network), so
// the review card, the update diff and the tests share one reader.
import { isIP } from 'node:net';

export const MANIFEST_FILE = 'sara-plugin.json';
export const MANIFEST_VERSION = 1;

/** The hook points a plugin may ask for (§6.4). */
export const HOOKS = ['turn.before', 'tool.before', 'tool.after', 'reply.after', 'schedule', 'event:planner', 'event:job', 'event:webhook', 'event:board'] as const;
export type HookName = (typeof HOOKS)[number];
export const TURN_HOOKS = ['turn.before', 'tool.before', 'tool.after', 'reply.after'] as const;
export type TurnHookName = (typeof TURN_HOOKS)[number];

export const SETTING_TYPES = ['text', 'number', 'switch', 'choice', 'secret'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export const PLUGIN_LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;

export interface PluginSetting {
  key: string;
  type: SettingType;
  label: string;
  tip: string;
  default?: string | number | boolean;
  choices?: string[];
  min?: number;
  max?: number;
}
export interface PluginSchedule {
  id: string;
  /** "15m", "6h", "1d" (at least 15 minutes). */
  every: string;
  /** "HH:MM" local time (day schedules). */
  at?: string;
}
export interface PluginPermissions {
  hooks: HookName[];
  tools: string[];
  callTools: string[];
  network: string[];
  files: { read: ('plugin-data' | 'workspace')[]; write: 'plugin-data'[] };
  settings: boolean;
  cards: boolean;
  bridges: string[];
  model: { callsPerDay: number; tokensPerDay: number };
  memory: 'none' | 'shared-notes';
}
export interface PluginManifest {
  manifest: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  sara?: string;
  main: string;
  permissions: PluginPermissions;
  schedules: PluginSchedule[];
  settings: PluginSetting[];
  i18n: Record<string, Record<string, string>>;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const TOP_KEYS = new Set(['manifest', 'id', 'name', 'version', 'description', 'author', 'license', 'homepage', 'sara', 'main', 'permissions', 'schedules', 'settings', 'i18n', '$schema']);
const PERMISSION_KEYS = new Set(['hooks', 'tools', 'callTools', 'network', 'files', 'settings', 'cards', 'bridges', 'model', 'memory']);
export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,39}$/;
const BRIDGE_RE = /^[a-z][a-z0-9-]{0,23}$/;
const SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** Names that only mean something on a home network (never allowed as plugin hosts). */
const PRIVATE_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa|test|invalid|onion)$/i;

const str = (v: unknown, what: string, max: number, min = 1): string => {
  if (typeof v !== 'string') throw new ManifestError(`${what} must be text.`);
  const s = v.trim();
  if (s.length < min) throw new ManifestError(`${what} is missing.`);
  if (s.length > max) throw new ManifestError(`${what} is longer than ${max} characters.`);
  return s;
};
const list = (v: unknown, what: string, max: number): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ManifestError(`${what} must be a list.`);
  if (v.length > max) throw new ManifestError(`${what} has more than ${max} entries.`);
  return v;
};

// ---------------------------------------------------------------------------------------------
// semver and ranges (enough for ">=2.31.0", "^2.31.0", "~2.31.1", "2.31.0", ">=2.31 <3", "a || b")
// ---------------------------------------------------------------------------------------------

export function parseSemver(v: string): [number, number, number, string] | undefined {
  const m = SEMVER_RE.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : undefined;
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new ManifestError(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  // A pre-release sorts before its release.
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** Whether `version` satisfies `range`. Throws ManifestError on a range it can't read. */
export function satisfies(version: string, range: string): boolean {
  const r = String(range ?? '').trim();
  if (!r || r === '*') return true;
  if (r.length > 100) throw new ManifestError('The sara range is too long.');
  return r.split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) throw new ManifestError(`The sara range "${r}" can't be read.`);
    return parts.every((p) => {
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(p);
      if (!m) throw new ManifestError(`The sara range "${r}" can't be read.`);
      const [, op = '=', maj, min, pat, pre = ''] = m;
      const base = `${maj}.${min ?? 0}.${pat ?? 0}${pre}`;
      const c = compareSemver(version, base);
      if (op === '>=') return c >= 0;
      if (op === '>') return c > 0;
      if (op === '<=') return c <= 0;
      if (op === '<') return c < 0;
      if (op === '^') return c >= 0 && parseSemver(version)![0] === Number(maj) && (Number(maj) > 0 || parseSemver(version)![1] === Number(min ?? 0));
      if (op === '~') return c >= 0 && parseSemver(version)![0] === Number(maj) && parseSemver(version)![1] === Number(min ?? 0);
      // "=" or bare: a partial version matches every patch ("2.31" = 2.31.x).
      if (pat === undefined) return parseSemver(version)![0] === Number(maj) && (min === undefined || parseSemver(version)![1] === Number(min));
      return c === 0;
    });
  });
}

// ---------------------------------------------------------------------------------------------
// hosts
// ---------------------------------------------------------------------------------------------

/** A network entry: an exact public host name, or "*.example.com" (one level). Returns it lower-cased. */
export function checkHost(raw: unknown): string {
  const h = str(raw, 'A network entry', 253).toLowerCase().replace(/\.$/, '');
  if (h === '*' || h.includes('**')) throw new ManifestError('A network entry can\'t be "*": list each host.');
  if (/[:/@?#\s]/.test(h)) throw new ManifestError(`The network entry "${h}" must be a host name only (no scheme, port or path).`);
  const bare = h.startsWith('*.') ? h.slice(2) : h;
  if (bare.includes('*')) throw new ManifestError(`The network entry "${h}" may only start with "*." (one level).`);
  if (isIP(bare) || /^\d+(\.\d+){0,3}$/.test(bare) || /^0x[0-9a-f]+$/i.test(bare) || bare.startsWith('[')) throw new ManifestError(`The network entry "${h}" is an IP address; plugins may only name public hosts.`);
  const labels = bare.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) throw new ManifestError(`"${h}" isn't a host name.`);
  if (PRIVATE_NAMES.test(bare)) throw new ManifestError(`The network entry "${h}" is a private or local name.`);
  if (h.startsWith('*.') && labels.length < 2) throw new ManifestError(`"${h}" is too wide.`);
  return h;
}

/** Whether a host name is covered by the manifest's network list (exact, or "*.x" one level). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.slice(0, -(a.length - 1)).split('.').length === 1 && h.length > a.length - 1 : h === a));
}

// ---------------------------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------------------------

const EVERY_RE = /^(\d{1,4})(m|h|d)$/;
/** Minutes in a schedule's "every". */
export function everyMinutes(every: string): number {
  const m = EVERY_RE.exec(every);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 1440);
}

function parsePermissions(v: unknown): PluginPermissions {
  if (v === undefined) v = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ManifestError('permissions must be an object.');
  const p = v as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!PERMISSION_KEYS.has(k)) throw new ManifestError(`Unknown permission "${k}".`);
  const hooks = [...new Set(list(p.hooks, 'permissions.hooks', HOOKS.length).map((h) => {
    if (!(HOOKS as readonly string[]).includes(String(h))) throw new ManifestError(`Unknown hook "${String(h)}". Hooks: ${HOOKS.join(', ')}.`);
    return h as HookName;
  }))];
  const tools = [...new Set(list(p.tools, 'permissions.tools', 20).map((t) => {
    if (typeof t !== 'string' || !TOOL_RE.test(t)) throw new ManifestError(`The tool name "${String(t)}" must be lower-case letters, digits and _ (up to 40).`);
    return t;
  }))];
  const callTools = [...new Set(list(p.callTools, 'permissions.callTools', 20).map((t) => {
    if (typeof t !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t)) throw new ManifestError(`"${String(t)}" in callTools isn't a tool name.`);
    return t;
  }))];
  const network = [...new Set(list(p.network, 'permissions.network', 20).map(checkHost))];
  let files: PluginPermissions['files'] = { read: ['plugin-data'], write: ['plugin-data'] };
  if (p.files !== undefined) {
    if (p.files === 'none') files = { read: [], write: [] };
    else if (!p.files || typeof p.files !== 'object' || Array.isArray(p.files)) throw new ManifestError('permissions.files must be { read, write }.');
    else {
      const f = p.files as Record<string, unknown>;
      for (const k of Object.keys(f)) if (k !== 'read' && k !== 'write') throw new ManifestError(`Unknown permission "files.${k}".`);
      const read = list(f.read, 'files.read', 2).map(String).filter((x) => x !== 'none');
      const write = list(f.write, 'files.write', 1).map(String).filter((x) => x !== 'none');
      for (const r of read) if (r !== 'plugin-data' && r !== 'workspace') throw new ManifestError(`files.read may be plugin-data, workspace or none (not "${r}").`);
      for (const w of write) if (w !== 'plugin-data') throw new ManifestError(`files.write may only be plugin-data or none (not "${w}"); the workspace is read only.`);
      files = { read: [...new Set(read)] as PluginPermissions['files']['read'], write: [...new Set(write)] as PluginPermissions['files']['write'] };
    }
  }
  const bool = (k: string) => {
    if (p[k] === undefined) return false;
    if (typeof p[k] !== 'boolean') throw new ManifestError(`permissions.${k} must be true or false.`);
    return p[k] as boolean;
  };
  const bridges = [...new Set(list(p.bridges, 'permissions.bridges', 4).map((b) => {
    if (typeof b !== 'string' || !BRIDGE_RE.test(b)) throw new ManifestError(`The bridge name "${String(b)}" must be lower-case letters, digits and hyphens.`);
    return b;
  }))];
  let model = { callsPerDay: 0, tokensPerDay: 0 };
  if (p.model !== undefined) {
    if (!p.model || typeof p.model !== 'object') throw new ManifestError('permissions.model must be { callsPerDay, tokensPerDay }.');
    const m = p.model as Record<string, unknown>;
    for (const k of Object.keys(m)) if (k !== 'callsPerDay' && k !== 'tokensPerDay') throw new ManifestError(`Unknown permission "model.${k}".`);
    const n = (x: unknown, max: number, what: string) => {
      const v2 = Number(x ?? 0);
      if (!Number.isInteger(v2) || v2 < 0 || v2 > max) throw new ManifestError(`model.${what} must be a whole number from 0 to ${max}.`);
      return v2;
    };
    model = { callsPerDay: n(m.callsPerDay, 1000, 'callsPerDay'), tokensPerDay: n(m.tokensPerDay, 2_000_000, 'tokensPerDay') };
  }
  const memory = p.memory === undefined ? 'none' : p.memory;
  if (memory !== 'none' && memory !== 'shared-notes') throw new ManifestError('permissions.memory may be none or shared-notes.');
  return { hooks, tools, callTools, network, files, settings: bool('settings'), cards: bool('cards'), bridges, model, memory };
}

function parseSettings(v: unknown, allowed: boolean): PluginSetting[] {
  const out: PluginSetting[] = [];
  const seen = new Set<string>();
  for (const raw of list(v, 'settings', 20)) {
    if (!raw || typeof raw !== 'object') throw new ManifestError('Each setting must be an object.');
    const s = raw as Record<string, unknown>;
    const key = String(s.key ?? '');
    if (!SETTING_KEY_RE.test(key)) throw new ManifestError(`The setting key "${key}" must be letters and digits (up to 32).`);
    if (seen.has(key)) throw new ManifestError(`The setting "${key}" is listed twice.`);
    seen.add(key);
    if (!(SETTING_TYPES as readonly string[]).includes(String(s.type))) throw new ManifestError(`The setting "${key}" has an unknown type "${String(s.type)}" (${SETTING_TYPES.join(', ')}).`);
    const type = s.type as SettingType;
    const label = str(s.label, `The label of setting "${key}"`, 60);
    if (typeof s.tip !== 'string' || s.tip.trim().length < 10) throw new ManifestError(`The setting "${key}" has no tip: every setting needs a ? tip that says what it does.`);
    const tip = str(s.tip, `The tip of setting "${key}"`, 260);
    const one: PluginSetting = { key, type, label, tip };
    if (type === 'choice') {
      const choices = list(s.choices, `The choices of "${key}"`, 20).map((c) => str(c, `A choice of "${key}"`, 60));
      if (!choices.length) throw new ManifestError(`The choice setting "${key}" lists no choices.`);
      one.choices = choices;
    }
    if (type === 'number') {
      if (s.min !== undefined) one.min = Number(s.min);
      if (s.max !== undefined) one.max = Number(s.max);
      if ((one.min !== undefined && !Number.isFinite(one.min)) || (one.max !== undefined && !Number.isFinite(one.max))) throw new ManifestError(`The number setting "${key}" has a bad min or max.`);
    }
    if (s.default !== undefined) {
      if (type === 'secret') throw new ManifestError(`The secret setting "${key}" can't have a default.`);
      const d = s.default;
      if (type === 'switch' ? typeof d !== 'boolean' : type === 'number' ? typeof d !== 'number' : typeof d !== 'string') throw new ManifestError(`The default of "${key}" doesn't fit its type.`);
      if (type === 'choice' && !one.choices!.includes(d as string)) throw new ManifestError(`The default of "${key}" isn't one of its choices.`);
      if (typeof d === 'string' && d.length > 500) throw new ManifestError(`The default of "${key}" is too long.`);
      one.default = d as string | number | boolean;
    }
    out.push(one);
  }
  if (out.length && !allowed) throw new ManifestError('It declares settings, so permissions.settings must be true.');
  return out;
}

function parseSchedules(v: unknown, hooks: readonly string[]): PluginSchedule[] {
  const out: PluginSchedule[] = [];
  for (const raw of list(v, 'schedules', 5)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = String(s.id ?? '');
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) throw new ManifestError(`The schedule id "${id}" must be lower-case letters, digits and hyphens.`);
    const every = String(s.every ?? '');
    const mins = everyMinutes(every);
    if (!mins) throw new ManifestError(`The schedule "${id}" needs every: like "15m", "6h" or "1d".`);
    if (mins < 15) throw new ManifestError(`The schedule "${id}" runs more often than every 15 minutes.`);
    const at = s.at === undefined ? undefined : String(s.at);
    if (at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new ManifestError(`The schedule "${id}" has a bad time "${at}" (HH:MM).`);
    if (out.some((x) => x.id === id)) throw new ManifestError(`The schedule "${id}" is listed twice.`);
    out.push({ id, every, ...(at ? { at } : {}) });
  }
  if (out.length && !hooks.includes('schedule')) throw new ManifestError('It has schedules, so permissions.hooks must include "schedule".');
  return out;
}

function parseI18n(v: unknown): Record<string, Record<string, string>> {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ManifestError('i18n must be an object of languages.');
  const out: Record<string, Record<string, string>> = {};
  for (const [lang, map] of Object.entries(v as Record<string, unknown>)) {
    if (!(PLUGIN_LANGS as readonly string[]).includes(lang)) throw new ManifestError(`i18n: unknown language "${lang}" (${PLUGIN_LANGS.join(', ')}).`);
    if (!map || typeof map !== 'object') throw new ManifestError(`i18n.${lang} must be an object.`);
    const m: Record<string, string> = {};
    for (const [k, t] of Object.entries(map as Record<string, unknown>).slice(0, 200)) {
      if (typeof t !== 'string' || k.length > 300 || t.length > 300) throw new ManifestError(`i18n.${lang} has an entry that is too long or not text.`);
      m[k] = t;
    }
    out[lang] = m;
  }
  return out;
}

/**
 * Reads and checks a manifest. `saraVersion` is this server's version (the `sara` range must
 * match); `files` (when given) are the package's paths (the main file must be one of them).
 */
export function parseManifest(raw: unknown, opts: { saraVersion: string; files?: readonly string[] }): PluginManifest {
  let v = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      v = JSON.parse(String(raw));
    } catch (err) {
      throw new ManifestError(`${MANIFEST_FILE} isn't valid JSON (${(err as Error).message.slice(0, 120)}).`);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ManifestError(`${MANIFEST_FILE} must be a JSON object.`);
  const m = v as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!TOP_KEYS.has(k)) throw new ManifestError(`Unknown field "${k}" in ${MANIFEST_FILE}.`);
  if (m.manifest !== MANIFEST_VERSION) throw new ManifestError(`"manifest" must be ${MANIFEST_VERSION}.`);
  const id = String(m.id ?? '');
  if (!ID_RE.test(id)) throw new ManifestError(`The id "${id.slice(0, 60)}" must be lower-case letters, digits and hyphens (up to 48).`);
  const name = str(m.name, 'The name', 60);
  const version = String(m.version ?? '');
  if (!parseSemver(version)) throw new ManifestError(`The version "${version.slice(0, 40)}" isn't a semantic version like 1.2.0.`);
  const description = str(m.description, 'The description', 300);
  const opt = (k: string, max: number) => (m[k] === undefined ? undefined : str(m[k], k, max));
  const author = opt('author', 100);
  const license = opt('license', 60);
  const homepage = opt('homepage', 300);
  if (homepage && !/^https:\/\/[^\s]+$/.test(homepage)) throw new ManifestError('The homepage must be an https:// address.');
  const sara = opt('sara', 100);
  if (sara && !satisfies(opts.saraVersion, sara)) throw new ManifestError(`It needs Sara ${sara}; this server runs ${opts.saraVersion}.`);
  const main = str(m.main, 'main', 120).replace(/\\/g, '/');
  if (!/\.(mjs|js)$/.test(main) || main.startsWith('/') || main.split('/').some((s) => s === '..' || s === '') || /^[A-Za-z]:/.test(main)) throw new ManifestError('main must be a .mjs or .js file inside the plugin folder.');
  if (opts.files && !opts.files.includes(main)) throw new ManifestError(`main says ${main}, but there is no such file in the plugin.`);
  const permissions = parsePermissions(m.permissions);
  const settings = parseSettings(m.settings, permissions.settings);
  const schedules = parseSchedules(m.schedules, permissions.hooks);
  const i18n = parseI18n(m.i18n);
  return { manifest: 1, id, name, version, description, ...(author ? { author } : {}), ...(license ? { license } : {}), ...(homepage ? { homepage } : {}), ...(sara ? { sara } : {}), main, permissions, schedules, settings, i18n };
}

/** The namespaced name a plugin tool is registered under: weather-alerts + check → weather_alerts__check. */
export const pluginToolName = (pluginId: string, tool: string): string => `${pluginId.replace(/-/g, '_')}__${tool}`;

// ---------------------------------------------------------------------------------------------
// the review: every permission in plain words, riskiest first (§6.3), and what an update adds
// ---------------------------------------------------------------------------------------------

/** One line of the review card: an English template (the web translates it) and its values. */
export interface PermissionLine {
  /** Stable id for diffs ("network:api.weather.example", "hook:turn.before", …). */
  id: string;
  key: string;
  params?: Record<string, string | number>;
  risk: 'high' | 'medium' | 'low';
}

const HOOK_WORDS: Record<string, string> = {
  'turn.before': "Sees what you write before each reply (it can add a note for her, it can't change her rules)",
  'tool.before': 'Sees each step before it runs (it can stop it or make it ask you, never let it through)',
  'tool.after': "Sees each step's result (it can add a card under it)",
  'reply.after': "Sees each reply after it's sent (it can add a card or a note of its own)",
  'event:planner': 'Is told when your to-dos, reminders or notes change (what changed, not what they say)',
  'event:job': 'Is told when a background job starts or ends',
  'event:webhook': 'Gets the webhooks you send to it',
  'event:board': 'Is told when a card on a board moves',
};

function scheduleWords(s: PluginSchedule): PermissionLine {
  const mins = everyMinutes(s.every);
  if (mins % 1440 === 0 && s.at) return { id: `schedule:${s.id}`, key: mins === 1440 ? 'Runs every day at {at}' : 'Runs every {n} days at {at}', params: { at: s.at, n: mins / 1440 }, risk: 'medium' };
  if (mins % 60 === 0) return { id: `schedule:${s.id}`, key: mins === 60 ? 'Runs every hour' : 'Runs every {n} hours', params: { n: mins / 60 }, risk: 'medium' };
  return { id: `schedule:${s.id}`, key: 'Runs every {n} minutes', params: { n: mins }, risk: 'medium' };
}

/** Every permission of a manifest as plain-words lines, riskiest first. */
export function permissionLines(m: PluginManifest, toolLabel: (name: string) => string = (n) => n): PermissionLine[] {
  const p = m.permissions;
  const out: PermissionLine[] = [];
  for (const h of p.network) out.push({ id: `network:${h}`, key: 'Can reach {host}', params: { host: h }, risk: 'high' });
  for (const t of p.callTools) out.push({ id: `call:${t}`, key: 'Can ask her to use {tool} (asks you first)', params: { tool: toolLabel(t) }, risk: 'high' });
  if (p.model.callsPerDay > 0) out.push({ id: 'model', key: 'Can use her model up to {n} times a day (billed to you)', params: { n: p.model.callsPerDay, tokens: p.model.tokensPerDay }, risk: 'high' });
  if (p.files.read.includes('workspace')) out.push({ id: 'files:workspace', key: 'Can read your main workspace (read only)', risk: 'high' });
  if (p.memory === 'shared-notes') out.push({ id: 'memory', key: 'Can read the notes about you that other apps may see (read only)', risk: 'high' });
  for (const b of p.bridges) out.push({ id: `bridge:${b}`, key: 'Carries chats with her for {bridge}', params: { bridge: b }, risk: 'high' });
  for (const h of p.hooks) if (HOOK_WORDS[h]) out.push({ id: `hook:${h}`, key: HOOK_WORDS[h], risk: h === 'turn.before' || h === 'reply.after' || h === 'tool.after' ? 'medium' : 'low' });
  for (const s of m.schedules) out.push(scheduleWords(s));
  for (const t of p.tools) out.push({ id: `tool:${t}`, key: 'Adds a tool: {tool} (asks you first)', params: { tool: t }, risk: 'low' });
  if (p.cards) out.push({ id: 'cards', key: 'Can show cards (text, a picture and buttons, never its own code)', risk: 'low' });
  if (m.settings.length) out.push({ id: `settings:${m.settings.map((s) => s.key).join(',')}`, key: 'Has its own settings: {names}', params: { names: m.settings.map((s) => s.label).join(', ') }, risk: 'low' });
  if (p.files.write.includes('plugin-data')) out.push({ id: 'files:data', key: 'Keeps its own files in its own folder', risk: 'low' });
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.risk] - order[b.risk]);
}

/** The stable permission ids (what an update is compared by). */
export function permissionIds(m: PluginManifest): string[] {
  const p = m.permissions;
  const ids = [
    ...p.network.map((h) => `network:${h}`),
    ...p.callTools.map((t) => `call:${t}`),
    ...(p.model.callsPerDay > 0 ? [`model:${p.model.callsPerDay}:${p.model.tokensPerDay}`] : []),
    ...p.files.read.map((f) => `read:${f}`),
    ...p.files.write.map((f) => `write:${f}`),
    ...(p.memory !== 'none' ? [`memory:${p.memory}`] : []),
    ...p.bridges.map((b) => `bridge:${b}`),
    ...p.hooks.map((h) => `hook:${h}`),
    ...m.schedules.map((s) => `schedule:${s.id}:${s.every}:${s.at ?? ''}`),
    ...p.tools.map((t) => `tool:${t}`),
    ...(p.cards ? ['cards'] : []),
    ...m.settings.map((s) => `setting:${s.key}:${s.type}`),
  ];
  return [...new Set(ids)].sort();
}

/**
 * What an update adds. A higher model allowance counts as more; a schedule that runs more often
 * counts as more; settings that are only new labels don't.
 */
export function addedPermissions(before: PluginManifest | string[], after: PluginManifest): string[] {
  const old = new Set(Array.isArray(before) ? before : permissionIds(before));
  const added: string[] = [];
  for (const id of permissionIds(after)) {
    if (old.has(id)) continue;
    if (id.startsWith('model:')) {
      const prev = [...old].find((x) => x.startsWith('model:'));
      if (prev) {
        const [, c0, t0] = prev.split(':').map(Number);
        const [, c1, t1] = id.split(':').map(Number);
        if (c1 <= c0 && t1 <= t0) continue;
      }
    }
    if (id.startsWith('schedule:')) {
      const [, sid, every] = id.split(':');
      const prev = [...old].find((x) => x.startsWith(`schedule:${sid}:`));
      if (prev && everyMinutes(every) >= everyMinutes(prev.split(':')[2])) continue;
    }
    if (id.startsWith('setting:')) {
      // A new setting is a new thing it asks for only when it's a secret.
      if (!id.endsWith(':secret')) continue;
    }
    added.push(id);
  }
  return added;
}

/** The manifest's own text in a language (English fallback). */
export function localize(m: PluginManifest, lang: string, text: string): string {
  return m.i18n[lang]?.[text] ?? text;
}
