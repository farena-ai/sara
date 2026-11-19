// W3.1: the add-on's own runtime, `sara-addon.mjs`, written into every add-on folder by `create`
// (an add-on may only read its own folder and has no npm install). It is kit.ts itself: each
// function is serialized with Function#toString, so the typed helpers you test against and the code
// Sara runs are the same code. `sara-addon.d.ts` gives editors the types without installing anything.
import * as kit from './kit.ts';

const LISTS = { HOOKS: kit.HOOKS, TURN_HOOKS: kit.TURN_HOOKS, EVENTS: kit.EVENTS, SETTING_TYPES: kit.SETTING_TYPES, LANGS: kit.LANGS, TOP_KEYS: kit.TOP_KEYS, PERMISSION_KEYS: kit.PERMISSION_KEYS, DEFAULT_SARA: kit.DEFAULT_SARA };
const REGEXES = { ID_RE: kit.ID_RE, TOOL_RE: kit.TOOL_RE, SETTING_KEY_RE: kit.SETTING_KEY_RE, SEMVER_RE: kit.SEMVER_RE, PRIVATE_NAMES: kit.PRIVATE_NAMES };
// Order matters only for the class (functions are hoisted).
const CODE: { toString(): string }[] = [kit.KitError, kit.kitFail, kit.clip, kit.hostProblem, kit.everyMinutes, kit.settingProblems, kit.defineSetting, kit.defineTool, kit.renderPage, kit.definePage, kit.semverOk, kit.buildManifest, kit.checkManifest, kit.defineAddon, kit.toPluginDef, kit.permissionLines];

/** The text of `sara-addon.mjs`. */
export function runtimeSource(sdkVersion = ''): string {
  const out = [
    `// sara-addon.mjs: the Sara add-on kit runtime${sdkVersion ? ` (from @farena-ai/sara-sdk ${sdkVersion})` : ''}. Written by`,
    '// `sara-addon create`; refresh it with `sara-addon update`. Do not edit: docs/ADDON_KIT.md.',
    '// It uses the channel helper beside it (sara-plugin.mjs) and nothing else.',
    "import { plugin } from './sara-plugin.mjs';",
    '',
  ];
  for (const [k, v] of Object.entries(LISTS)) out.push(`export const ${k} = ${JSON.stringify(v)};`);
  for (const [k, v] of Object.entries(REGEXES)) out.push(`export const ${k} = ${String(v)};`);
  out.push('');
  for (const f of CODE) out.push(`export ${f.toString().replace(/[ \t]+$/gm, '')}`, '');
  out.push(
    '// defineAddon() calls this: `sara-addon build` reads the manifest; inside Sara it starts the add-on.',
    'globalThis.__saraAddonStart = (addon) => {',
    '  if (globalThis.__SARA_ADDON_BUILD__) {',
    '    globalThis.__SARA_ADDON__ = buildManifest(addon);',
    '    return;',
    '  }',
    '  plugin(toPluginDef(addon));',
    '};',
    '',
  );
  return out.join('\n');
}

/** `sara-addon.d.ts`: the kit's types for editors and `checkJs` (they match kit.ts). */
export const RUNTIME_DTS = `// sara-addon.d.ts: types for sara-addon.mjs (the Sara add-on kit). Do not edit: docs/ADDON_KIT.md.
export type HookName = 'turn.before' | 'tool.before' | 'tool.after' | 'reply.after' | 'schedule' | 'event:planner' | 'event:job' | 'event:webhook' | 'event:board';
export type TurnHookName = 'turn.before' | 'tool.before' | 'tool.after' | 'reply.after';
export type EventName = 'planner' | 'job' | 'webhook' | 'board';
export type SettingType = 'text' | 'number' | 'switch' | 'choice' | 'secret';
export type Lang = 'es' | 'fr' | 'de' | 'pt-BR' | 'it';
export interface Card {
  title: string;
  lines: string[];
  image?: string;
  link?: string;
  buttons?: { label: string; tool: string; args?: Record<string, unknown> }[];
}
export interface ToolResult { content: string; card?: Card }
export interface FetchResult { status: number; contentType: string; body: string; truncated: boolean }
export interface AddonContext {
  settings: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
  lang: string;
  plugin: string;
  companion: string;
  fetch(url: string): Promise<FetchResult>;
  tool(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
  notify(text: string): Promise<unknown>;
  card(card: Card): Promise<unknown>;
  model(prompt: string, o?: { maxTokens?: number }): Promise<string>;
  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
  notes(): Promise<string[]>;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
}
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export interface JsonProperty { type: JsonType; description?: string; enum?: (string | number)[]; items?: JsonProperty; properties?: Record<string, JsonProperty> }
export interface ToolParameters { type: 'object'; properties: Record<string, JsonProperty>; required?: string[] }
export interface ToolDef<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters?: ToolParameters;
  permission?: 'ask' | 'auto';
  cost?: number | null;
  run(args: A, sara: AddonContext): Promise<string | ToolResult> | string | ToolResult;
}
export interface SettingDef {
  key: string;
  type: SettingType;
  label: string;
  tip: string;
  default?: string | number | boolean;
  choices?: string[];
  min?: number;
  max?: number;
  advanced?: boolean;
}
export interface PageView { title?: string; lines: string[]; image?: string; link?: string; buttons?: { label: string; tool: string; args?: Record<string, unknown> }[] }
export interface PageDef<D> { id: string; title: string; render(data: D): PageView }
export interface Page<D> { readonly id: string; readonly title: string; card(data: D): Card; tools?: string[] }
export type HookHandler = (data: Record<string, unknown>, sara: AddonContext) => Promise<unknown> | unknown;
export interface ScheduleDef { id: string; every: string; at?: string; run(sara: AddonContext): Promise<unknown> | unknown }
export interface AddonDef {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  sara?: string;
  main?: string;
  tools?: ToolDef<any>[];
  settings?: SettingDef[];
  pages?: Page<any>[];
  hooks?: Partial<Record<TurnHookName, HookHandler>>;
  schedules?: ScheduleDef[];
  events?: Partial<Record<EventName, HookHandler>>;
  network?: string[];
  callTools?: string[];
  files?: 'none' | { read?: ('plugin-data' | 'workspace')[]; write?: 'plugin-data'[] };
  model?: { callsPerDay: number; tokensPerDay: number };
  memory?: 'none' | 'shared-notes';
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
export declare class KitError extends Error {}
export declare function defineSetting<S extends SettingDef>(setting: S): S;
export declare function defineTool<A = Record<string, unknown>>(tool: ToolDef<A>): ToolDef<A>;
export declare function definePage<D = Record<string, unknown>>(page: PageDef<D>): Page<D>;
export declare function defineAddon<T extends AddonDef>(addon: T): T;
export declare function buildManifest(addon: AddonDef): Manifest;
export declare function checkManifest(raw: unknown, o?: { files?: readonly string[] }): string[];
export declare function permissionLines(m: Manifest): string[];
`;
