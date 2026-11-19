// W3.1 (docs/ADDON_KIT.md): the typed add-on kit. defineTool / defineSetting / definePage /
// defineAddon describe a Sara add-on (a plugin: docs/PLUGINS.md) in code; buildManifest turns that
// into the `sara-plugin.json` Sara's own reader accepts, and checkManifest mirrors that reader's
// rules so mistakes show up while you write, not at install.
//
// One source: every function below is also the add-on's runtime. `create` writes them into the
// add-on folder as `sara-addon.mjs` (runtime-source.ts serializes them with Function#toString), so
// they must stay plain top-level functions that only use each other and the constants here.
// No Node or DOM imports: this file runs in an add-on process, in Node, Deno, Bun or a browser.

export const HOOKS = ['turn.before', 'tool.before', 'tool.after', 'reply.after', 'schedule', 'event:planner', 'event:job', 'event:webhook', 'event:board'] as const;
export const TURN_HOOKS = ['turn.before', 'tool.before', 'tool.after', 'reply.after'] as const;
export const EVENTS = ['planner', 'job', 'webhook', 'board'] as const;
export const SETTING_TYPES = ['text', 'number', 'switch', 'choice', 'secret'] as const;
export const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;
export const TOP_KEYS = ['manifest', 'id', 'name', 'version', 'description', 'author', 'license', 'homepage', 'sara', 'main', 'permissions', 'schedules', 'settings', 'i18n', 'costs', '$schema'] as const;
export const PERMISSION_KEYS = ['hooks', 'tools', 'callTools', 'network', 'files', 'settings', 'cards', 'bridges', 'bridgeFiles', 'bridgeApprovals', 'model', 'memory', 'connect', 'webhooks', 'webhookKinds', 'doorbell', 'run'] as const;
export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
export const TOOL_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const PRIVATE_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa|test|invalid|onion)$/i;
/** The floor new add-ons ask for: the plugin contract the kit uses (tools, cards, settings, hooks) is older. */
export const DEFAULT_SARA = '>=2.68.0';

export type HookName = (typeof HOOKS)[number];
export type TurnHookName = (typeof TURN_HOOKS)[number];
export type EventName = (typeof EVENTS)[number];
export type SettingType = (typeof SETTING_TYPES)[number];
export type Lang = (typeof LANGS)[number];

/** What Sara's card schema allows (docs/PLUGINS.md §7). Shown as text: no HTML or script ever runs. */
export interface Card {
  title: string;
  /** Up to 8, each up to 200 characters. */
  lines: string[];
  /** A picture inside the add-on's folder (png, jpg, gif, webp). */
  image?: string;
  /** One https link. */
  link?: string;
  /** Up to 3; each calls one of the add-on's own tools when the owner clicks. */
  buttons?: { label: string; tool: string; args?: Record<string, unknown> }[];
}
export interface ToolResult {
  content: string;
  card?: Card;
}
export interface FetchResult {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}
/** The `sara` object every tool, hook and schedule gets (the JSON channel, docs/PLUGINS.md §6). */
export interface AddonContext {
  settings: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
  lang: string;
  plugin: string;
  companion: string;
  /** GET through Sara: only hosts in `network`, https, public addresses, 1 MB. */
  fetch(url: string): Promise<FetchResult>;
  /** Call one of her tools named in `callTools`; every call asks the owner. */
  tool(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
  notify(text: string): Promise<unknown>;
  card(card: Card): Promise<unknown>;
  /** Her background model, within `model` caps (billed to the owner). */
  model(prompt: string, o?: { maxTokens?: number }): Promise<string>;
  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
  notes(): Promise<string[]>;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
}
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export interface JsonProperty {
  type: JsonType;
  description?: string;
  enum?: (string | number)[];
  items?: JsonProperty;
  properties?: Record<string, JsonProperty>;
}
export interface ToolParameters {
  type: 'object';
  properties: Record<string, JsonProperty>;
  required?: string[];
}
export interface ToolDef<A = Record<string, unknown>> {
  /** Lower-case letters, digits and _ (up to 40). Sara registers it as `<id>__<name>`. */
  name: string;
  /** What it does, for her and for the owner's Tools list. */
  description: string;
  parameters?: ToolParameters;
  /** `ask` (default): the owner approves each call. `auto` is capped at ask until the owner changes it. */
  permission?: 'ask' | 'auto';
  /** US dollars per call, or null when it costs money but the amount is unknown. */
  cost?: number | null;
  run(args: A, sara: AddonContext): Promise<string | ToolResult> | string | ToolResult;
}
export interface SettingDef {
  key: string;
  type: SettingType;
  label: string;
  /** The ? tip: 10 to 260 characters, says what it does. Required for every setting. */
  tip: string;
  default?: string | number | boolean;
  choices?: string[];
  min?: number;
  max?: number;
  advanced?: boolean;
}
export interface PageView {
  title?: string;
  lines: string[];
  image?: string;
  link?: string;
  buttons?: { label: string; tool: string; args?: Record<string, unknown> }[];
}
export interface PageDef<D> {
  id: string;
  title: string;
  render(data: D): PageView;
}
/** A page is a card the add-on shows (under a tool step, or posted with `sara.card`). */
export interface Page<D> {
  readonly id: string;
  readonly title: string;
  card(data: D): Card;
  /** Set by defineAddon: the add-on's own tool names (a button may only call those). */
  tools?: string[];
}
export type HookHandler = (data: Record<string, unknown>, sara: AddonContext) => Promise<unknown> | unknown;
export interface ScheduleDef {
  id: string;
  /** "15m", "6h", "1d" (never under 15 minutes). */
  every: string;
  /** "HH:MM" local time for day schedules. */
  at?: string;
  run(sara: AddonContext): Promise<unknown> | unknown;
}
export interface AddonDef {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** The Sara versions it works with, e.g. ">=2.68.0". */
  sara?: string;
  /** The file Sara starts (default main.mjs). */
  main?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: ToolDef<any>[];
  settings?: SettingDef[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pages?: Page<any>[];
  hooks?: Partial<Record<TurnHookName, HookHandler>>;
  schedules?: ScheduleDef[];
  events?: Partial<Record<EventName, HookHandler>>;
  /** Exact public host names (or *.example.com) it may fetch. */
  network?: string[];
  /** Her tools it may call (each call asks the owner). */
  callTools?: string[];
  files?: 'none' | { read?: ('plugin-data' | 'workspace')[]; write?: 'plugin-data'[] };
  model?: { callsPerDay: number; tokensPerDay: number };
  memory?: 'none' | 'shared-notes';
  /** English text → translation for labels, tips and the description. */
  i18n?: Partial<Record<Lang, Record<string, string>>>;
  init?(sara: AddonContext): Promise<unknown> | unknown;
}
export interface Manifest {
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
  permissions: Record<string, unknown>;
  schedules?: { id: string; every: string; at?: string }[];
  settings?: SettingDef[];
  i18n?: Record<string, Record<string, string>>;
  costs?: Record<string, number | null>;
}

export class KitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitError';
  }
}

export function kitFail(message: string): never {
  throw new KitError(message);
}

export function clip(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The problem with a network entry, or '' (the host's checkHost rules). */
export function hostProblem(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'A network entry must be a host name.';
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (h === '*' || h.includes('**')) return 'A network entry can\'t be "*": list each host.';
  if (/[:/@?#\s]/.test(h)) return `The network entry "${h}" must be a host name only (no scheme, port or path).`;
  const bare = h.startsWith('*.') ? h.slice(2) : h;
  if (bare.includes('*')) return `The network entry "${h}" may only start with "*." (one level).`;
  if (/^\d+(\.\d+){0,3}$/.test(bare) || /^0x[0-9a-f]+$/i.test(bare) || bare.startsWith('[') || bare.includes(':')) return `The network entry "${h}" is an IP address; add-ons may only name public hosts.`;
  const labels = bare.split('.');
  if (labels.length < 2 || !labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l)) || /^\d+$/.test(labels[labels.length - 1])) return `"${h}" isn't a host name.`;
  if (PRIVATE_NAMES.test(bare)) return `The network entry "${h}" is a private or local name.`;
  return '';
}

export function everyMinutes(every: string): number {
  const m = /^(\d{1,4})(m|h|d)$/.exec(String(every));
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 1440);
}

/** The problems with one setting (the host's parseSettings rules), [] when it's fine. */
export function settingProblems(s: Record<string, unknown>): string[] {
  const p: string[] = [];
  const key = String(s?.key ?? '');
  if (!SETTING_KEY_RE.test(key)) p.push(`The setting key "${key}" must be letters and digits (up to 32).`);
  if (!(SETTING_TYPES as readonly string[]).includes(String(s?.type))) p.push(`The setting "${key}" has an unknown type "${String(s?.type)}" (${SETTING_TYPES.join(', ')}).`);
  if (typeof s?.label !== 'string' || !s.label.trim() || s.label.trim().length > 60) p.push(`The setting "${key}" needs a label (up to 60 characters).`);
  if (typeof s?.tip !== 'string' || s.tip.trim().length < 10 || s.tip.trim().length > 260) p.push(`The setting "${key}" needs a ? tip (10 to 260 characters) that says what it does.`);
  if (s?.advanced !== undefined && typeof s.advanced !== 'boolean') p.push(`The setting "${key}" has advanced that isn't true or false.`);
  const choices = Array.isArray(s?.choices) ? (s.choices as unknown[]) : undefined;
  if (s?.type === 'choice') {
    if (!choices || !choices.length || choices.length > 20 || choices.some((c) => typeof c !== 'string' || !c.trim() || c.length > 60)) p.push(`The choice setting "${key}" needs 1 to 20 choices.`);
  }
  if (s?.type === 'number' && ((s.min !== undefined && !Number.isFinite(Number(s.min))) || (s.max !== undefined && !Number.isFinite(Number(s.max))))) p.push(`The number setting "${key}" has a bad min or max.`);
  if (s?.default !== undefined) {
    const d = s.default;
    if (s.type === 'secret') p.push(`The secret setting "${key}" can't have a default.`);
    else if (s.type === 'switch' ? typeof d !== 'boolean' : s.type === 'number' ? typeof d !== 'number' : typeof d !== 'string') p.push(`The default of "${key}" doesn't fit its type.`);
    else if (s.type === 'choice' && choices && !choices.includes(d)) p.push(`The default of "${key}" isn't one of its choices.`);
    else if (typeof d === 'string' && d.length > 500) p.push(`The default of "${key}" is too long.`);
  }
  return p;
}

/** A setting the owner fills in on the add-on's settings window (each with its ? tip). */
export function defineSetting<S extends SettingDef>(setting: S): S {
  const p = settingProblems(setting as unknown as Record<string, unknown>);
  if (p.length) kitFail(p[0]);
  return Object.freeze({ ...setting });
}

/** A tool she can use (the owner approves each call unless he changes it in Settings → Tools). */
export function defineTool<A = Record<string, unknown>>(tool: ToolDef<A>): ToolDef<A> {
  if (!tool || typeof tool !== 'object') kitFail('defineTool needs { name, description, run }.');
  if (typeof tool.name !== 'string' || !TOOL_RE.test(tool.name)) kitFail(`The tool name "${String(tool.name)}" must be lower-case letters, digits and _ (up to 40), starting with a letter.`);
  if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1000) kitFail(`The tool "${tool.name}" needs a description (up to 1000 characters).`);
  if (typeof tool.run !== 'function') kitFail(`The tool "${tool.name}" needs run(args, sara).`);
  if (tool.permission !== undefined && tool.permission !== 'ask' && tool.permission !== 'auto') kitFail(`The tool "${tool.name}" has permission "${String(tool.permission)}" (ask or auto).`);
  const params = tool.parameters;
  if (params !== undefined && (!params || params.type !== 'object' || !params.properties || typeof params.properties !== 'object')) kitFail(`The tool "${tool.name}" parameters must be { type: 'object', properties: {…} }.`);
  for (const r of params?.required ?? []) if (!(r in (params?.properties ?? {}))) kitFail(`The tool "${tool.name}" requires "${r}", which isn't one of its properties.`);
  if (tool.cost !== undefined && tool.cost !== null && (typeof tool.cost !== 'number' || !Number.isFinite(tool.cost) || tool.cost < 0 || tool.cost > 1000)) kitFail(`The tool "${tool.name}" cost must be dollars per call (0 to 1000) or null.`);
  return Object.freeze({ ...tool });
}

/** Renders a page's view as a card Sara shows (clipped to the card limits, buttons checked). */
export function renderPage(page: { id: string; title: string; tools?: string[] }, view: PageView): Card {
  if (!view || !Array.isArray(view.lines)) kitFail(`The page "${page.id}" must render { lines: [...] }.`);
  if (view.lines.length > 8) kitFail(`The page "${page.id}" shows at most 8 lines (it rendered ${view.lines.length}).`);
  const card: Card = { title: clip(view.title ?? page.title, 120), lines: view.lines.map((l) => clip(l, 200)) };
  if (view.image !== undefined) {
    if (typeof view.image !== 'string' || !/\.(png|jpe?g|gif|webp)$/i.test(view.image) || view.image.startsWith('/') || view.image.includes('..')) kitFail(`The page "${page.id}" image must be a png, jpg, gif or webp inside the add-on's folder.`);
    card.image = view.image;
  }
  if (view.link !== undefined) {
    if (typeof view.link !== 'string' || !/^https:\/\/\S+$/.test(view.link)) kitFail(`The page "${page.id}" link must be one https:// address.`);
    card.link = view.link;
  }
  if (view.buttons !== undefined) {
    if (!Array.isArray(view.buttons) || view.buttons.length > 3) kitFail(`The page "${page.id}" has at most 3 buttons.`);
    card.buttons = view.buttons.map((b) => {
      if (!b || typeof b.tool !== 'string' || !TOOL_RE.test(b.tool)) kitFail(`A button on the page "${page.id}" must name one of the add-on's tools.`);
      if (page.tools && !page.tools.includes(b.tool)) kitFail(`The button "${clip(b.label, 40)}" on the page "${page.id}" calls "${b.tool}", which isn't one of this add-on's tools.`);
      return { label: clip(b.label, 40), tool: b.tool, ...(b.args && typeof b.args === 'object' ? { args: b.args } : {}) };
    });
  }
  return card;
}

/** A page: a named card the add-on renders from data (Sara shows it as text; no HTML or script runs). */
export function definePage<D = Record<string, unknown>>(page: PageDef<D>): Page<D> {
  if (!page || typeof page.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(page.id)) kitFail(`The page id "${String(page?.id)}" must be lower-case letters, digits and hyphens.`);
  if (typeof page.title !== 'string' || !page.title.trim()) kitFail(`The page "${page.id}" needs a title.`);
  if (typeof page.render !== 'function') kitFail(`The page "${page.id}" needs render(data).`);
  const out: Page<D> = { id: page.id, title: page.title, card: (data: D) => renderPage(out, page.render(data)) };
  return out;
}

export function semverOk(v: unknown): boolean {
  return typeof v === 'string' && SEMVER_RE.test(v);
}

/** The manifest (`sara-plugin.json`) of an add-on definition. */
export function buildManifest(addon: AddonDef): Manifest {
  const tools = addon.tools ?? [];
  const settings = addon.settings ?? [];
  const schedules = addon.schedules ?? [];
  const hooks: string[] = [...Object.keys(addon.hooks ?? {})];
  if (schedules.length) hooks.push('schedule');
  for (const e of Object.keys(addon.events ?? {})) hooks.push(`event:${e}`);
  const permissions: Record<string, unknown> = {};
  if (hooks.length) permissions.hooks = hooks;
  if (tools.length) permissions.tools = tools.map((t) => t.name);
  if (addon.callTools?.length) permissions.callTools = [...addon.callTools];
  if (addon.network?.length) permissions.network = [...addon.network];
  if (addon.files !== undefined) permissions.files = addon.files === 'none' ? 'none' : { read: [...(addon.files.read ?? [])], write: [...(addon.files.write ?? [])] };
  if (settings.length) permissions.settings = true;
  if (addon.pages?.length) permissions.cards = true;
  if (addon.model) permissions.model = { callsPerDay: addon.model.callsPerDay, tokensPerDay: addon.model.tokensPerDay };
  if (addon.memory && addon.memory !== 'none') permissions.memory = addon.memory;
  const costs: Record<string, number | null> = {};
  for (const t of tools) if (t.cost !== undefined) costs[t.name] = t.cost;
  const m: Manifest = { manifest: 1, id: addon.id, name: addon.name, version: addon.version, description: addon.description, main: addon.main ?? 'main.mjs', permissions };
  if (addon.author) m.author = addon.author;
  if (addon.license) m.license = addon.license;
  if (addon.homepage) m.homepage = addon.homepage;
  m.sara = addon.sara ?? DEFAULT_SARA;
  if (schedules.length) m.schedules = schedules.map((s) => ({ id: s.id, every: s.every, ...(s.at ? { at: s.at } : {}) }));
  if (settings.length) m.settings = settings.map((s) => ({ ...s }));
  if (addon.i18n && Object.keys(addon.i18n).length) m.i18n = JSON.parse(JSON.stringify(addon.i18n));
  if (Object.keys(costs).length) m.costs = costs;
  return m;
}

/** The problems Sara's manifest reader would refuse (src/plugins/manifest.ts parseManifest), [] when none. */
export function checkManifest(raw: unknown, o: { files?: readonly string[] } = {}): string[] {
  const p: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['sara-plugin.json must be a JSON object.'];
  const m = raw as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!(TOP_KEYS as readonly string[]).includes(k)) p.push(`Unknown field "${k}" in sara-plugin.json.`);
  if (m.manifest !== 1) p.push('"manifest" must be 1.');
  if (!ID_RE.test(String(m.id ?? ''))) p.push(`The id "${String(m.id ?? '').slice(0, 60)}" must be lower-case letters, digits and hyphens (up to 48).`);
  const text = (k: string, max: number, need: boolean) => {
    const v = m[k];
    if (v === undefined) {
      if (need) p.push(`The ${k} is missing.`);
      return '';
    }
    if (typeof v !== 'string' || !v.trim()) p.push(`The ${k} must be text.`);
    else if (v.trim().length > max) p.push(`The ${k} is longer than ${max} characters.`);
    return typeof v === 'string' ? v.trim() : '';
  };
  text('name', 60, true);
  text('description', 300, true);
  text('author', 100, false);
  text('license', 60, false);
  text('sara', 100, false);
  const homepage = text('homepage', 300, false);
  if (homepage && !/^https:\/\/[^\s]+$/.test(homepage)) p.push('The homepage must be an https:// address.');
  if (!semverOk(m.version)) p.push(`The version "${String(m.version ?? '').slice(0, 40)}" isn't a semantic version like 1.2.0.`);
  const main = typeof m.main === 'string' ? m.main.trim().replace(/\\/g, '/') : '';
  if (!/\.(mjs|js)$/.test(main) || main.startsWith('/') || main.split('/').some((s) => s === '..' || s === '') || /^[A-Za-z]:/.test(main)) p.push('main must be a .mjs or .js file inside the add-on folder.');
  else if (o.files && !o.files.includes(main)) p.push(`main says ${main}, but there is no such file in the add-on.`);
  const perms = (m.permissions ?? {}) as Record<string, unknown>;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) p.push('permissions must be an object.');
  for (const k of Object.keys(perms)) if (!(PERMISSION_KEYS as readonly string[]).includes(k)) p.push(`Unknown permission "${k}".`);
  const list = (v: unknown, what: string, max: number): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      p.push(`${what} must be a list.`);
      return [];
    }
    if (v.length > max) p.push(`${what} has more than ${max} entries.`);
    return v;
  };
  const hooks = list(perms.hooks, 'permissions.hooks', HOOKS.length).map(String);
  for (const h of hooks) if (!(HOOKS as readonly string[]).includes(h)) p.push(`Unknown hook "${h}". Hooks: ${HOOKS.join(', ')}.`);
  for (const t of list(perms.tools, 'permissions.tools', 20)) if (typeof t !== 'string' || !TOOL_RE.test(t)) p.push(`The tool name "${String(t)}" must be lower-case letters, digits and _ (up to 40).`);
  for (const t of list(perms.callTools, 'permissions.callTools', 20)) if (typeof t !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(t)) p.push(`"${String(t)}" in callTools isn't a tool name.`);
  for (const h of list(perms.network, 'permissions.network', 20)) {
    const why = hostProblem(h);
    if (why) p.push(why);
  }
  if (perms.files !== undefined && perms.files !== 'none') {
    const f = perms.files as Record<string, unknown>;
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some((k) => k !== 'read' && k !== 'write')) p.push('permissions.files must be { read, write }.');
    else {
      for (const r of list(f.read, 'files.read', 2).map(String)) if (!['plugin-data', 'workspace', 'none'].includes(r)) p.push(`files.read may be plugin-data, workspace or none (not "${r}").`);
      for (const w of list(f.write, 'files.write', 1).map(String)) if (!['plugin-data', 'none'].includes(w)) p.push(`files.write may only be plugin-data or none (not "${w}").`);
    }
  }
  for (const k of ['settings', 'cards', 'bridgeFiles', 'bridgeApprovals']) if (perms[k] !== undefined && typeof perms[k] !== 'boolean') p.push(`permissions.${k} must be true or false.`);
  if (perms.memory !== undefined && perms.memory !== 'none' && perms.memory !== 'shared-notes') p.push('permissions.memory may be none or shared-notes.');
  if (perms.model !== undefined) {
    const md = perms.model as Record<string, unknown>;
    const ok = (x: unknown, max: number) => Number.isInteger(Number(x ?? 0)) && Number(x ?? 0) >= 0 && Number(x ?? 0) <= max;
    if (!md || typeof md !== 'object' || Object.keys(md).some((k) => k !== 'callsPerDay' && k !== 'tokensPerDay') || !ok(md.callsPerDay, 1000) || !ok(md.tokensPerDay, 2_000_000)) p.push('permissions.model must be { callsPerDay (0-1000), tokensPerDay (0-2000000) }.');
  }
  const settings = list(m.settings, 'settings', 20);
  const seen: string[] = [];
  for (const s of settings) {
    if (!s || typeof s !== 'object') {
      p.push('Each setting must be an object.');
      continue;
    }
    p.push(...settingProblems(s as Record<string, unknown>));
    const key = String((s as Record<string, unknown>).key ?? '');
    if (seen.includes(key)) p.push(`The setting "${key}" is listed twice.`);
    seen.push(key);
  }
  if (settings.length && perms.settings !== true) p.push('It declares settings, so permissions.settings must be true.');
  const schedules = list(m.schedules, 'schedules', 5);
  const ids: string[] = [];
  for (const raw2 of schedules) {
    const s = (raw2 ?? {}) as Record<string, unknown>;
    const id = String(s.id ?? '');
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) p.push(`The schedule id "${id}" must be lower-case letters, digits and hyphens.`);
    const mins = everyMinutes(String(s.every ?? ''));
    if (!mins) p.push(`The schedule "${id}" needs every: like "15m", "6h" or "1d".`);
    else if (mins < 15) p.push(`The schedule "${id}" runs more often than every 15 minutes.`);
    if (s.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.at))) p.push(`The schedule "${id}" has a bad time "${String(s.at)}" (HH:MM).`);
    if (ids.includes(id)) p.push(`The schedule "${id}" is listed twice.`);
    ids.push(id);
  }
  if (schedules.length && !hooks.includes('schedule')) p.push('It has schedules, so permissions.hooks must include "schedule".');
  if (m.i18n !== undefined) {
    if (!m.i18n || typeof m.i18n !== 'object' || Array.isArray(m.i18n)) p.push('i18n must be an object of languages.');
    else for (const lang of Object.keys(m.i18n)) if (!(LANGS as readonly string[]).includes(lang)) p.push(`i18n: unknown language "${lang}" (${LANGS.join(', ')}).`);
  }
  if (m.costs !== undefined) {
    const tools = Array.isArray(perms.tools) ? perms.tools : [];
    if (!m.costs || typeof m.costs !== 'object' || Array.isArray(m.costs)) p.push('costs must map tool names to dollars per call (or null when unknown).');
    else for (const [k, c] of Object.entries(m.costs)) if (!tools.includes(k) || (c !== null && (typeof c !== 'number' || c < 0 || c > 1000))) p.push(`costs.${k} must name one of its tools with dollars per call (0 to 1000) or null.`);
  }
  return p;
}

/** The whole add-on, checked: everything Sara would refuse is refused here first, in the same words. */
export function defineAddon<T extends AddonDef>(addon: T): T {
  if (!addon || typeof addon !== 'object') kitFail('defineAddon needs { id, name, version, description, … }.');
  if (!ID_RE.test(String(addon.id ?? ''))) kitFail(`The id "${String(addon.id ?? '').slice(0, 60)}" must be lower-case letters, digits and hyphens (up to 48).`);
  if (!semverOk(addon.version)) kitFail(`The version "${String(addon.version ?? '')}" isn't a semantic version like 1.2.0.`);
  const names: string[] = [];
  for (const t of addon.tools ?? []) {
    if (names.includes(t.name)) kitFail(`The tool "${t.name}" is listed twice.`);
    names.push(t.name);
  }
  const pageIds: string[] = [];
  for (const pg of addon.pages ?? []) {
    if (pageIds.includes(pg.id)) kitFail(`The page "${pg.id}" is listed twice.`);
    pageIds.push(pg.id);
    pg.tools = names;
  }
  for (const h of Object.keys(addon.hooks ?? {})) if (!(TURN_HOOKS as readonly string[]).includes(h)) kitFail(`Unknown hook "${h}" (${TURN_HOOKS.join(', ')}; schedules and events have their own fields).`);
  for (const e of Object.keys(addon.events ?? {})) if (!(EVENTS as readonly string[]).includes(e)) kitFail(`Unknown event "${e}" (${EVENTS.join(', ')}).`);
  for (const s of addon.schedules ?? []) if (typeof s.run !== 'function') kitFail(`The schedule "${s.id}" needs run(sara).`);
  const problems = checkManifest(buildManifest(addon));
  if (problems.length) kitFail(problems[0]);
  const start = (globalThis as { __saraAddonStart?: (a: AddonDef) => void }).__saraAddonStart;
  if (typeof start === 'function') start(addon);
  return addon;
}

/** The definition in the shape of the channel helper (examples/plugins/sara-plugin.mjs `plugin(def)`). */
export function toPluginDef(addon: AddonDef): Record<string, unknown> {
  const schedules: Record<string, (sara: AddonContext) => unknown> = {};
  for (const s of addon.schedules ?? []) schedules[s.id] = s.run;
  return {
    tools: (addon.tools ?? []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} }, permission: t.permission ?? 'ask', run: t.run })),
    hooks: { ...(addon.hooks ?? {}) },
    schedules,
    events: { ...(addon.events ?? {}) },
    ...(addon.init ? { init: addon.init } : {}),
  };
}

/** What it can do, in plain words (the listing and the terminal; the review card in Sara says it its own way). */
export function permissionLines(m: Manifest): string[] {
  const p = m.permissions as Record<string, unknown>;
  const out: string[] = [];
  for (const h of (p.network as string[] | undefined) ?? []) out.push(`Can reach ${h}`);
  for (const t of (p.callTools as string[] | undefined) ?? []) out.push(`Asks to use her tool: ${t} (each call asks you)`);
  if (p.model) out.push('Can ask her model questions (billed to you, capped per day)');
  if (p.memory === 'shared-notes') out.push('Reads notes that other apps may see');
  const files = p.files as { read?: string[] } | string | undefined;
  if (files && typeof files === 'object' && files.read?.includes('workspace')) out.push('Reads the workspace');
  const hooks = (p.hooks as string[] | undefined) ?? [];
  if (hooks.includes('turn.before')) out.push('Sees what you write before each reply (it can add a note, never change her rules)');
  if (hooks.includes('tool.before')) out.push('Can make a step ask you first');
  if (hooks.includes('tool.after')) out.push('Sees each step and can add a card under it');
  if (hooks.includes('reply.after')) out.push('Sees her replies and can add a card or a note');
  for (const s of m.schedules ?? []) out.push(`Runs every ${s.every}${s.at ? ` at ${s.at}` : ''}`);
  for (const h of hooks.filter((x) => x.startsWith('event:'))) out.push(`Hears ${h.slice(6)} events`);
  for (const t of (p.tools as string[] | undefined) ?? []) out.push(`Adds a tool: ${t} (asks you first)`);
  if (p.cards) out.push('Shows cards');
  if (p.settings) out.push('Has settings');
  return out;
}
