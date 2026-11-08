// Phase 124 (2.57.0, docs/store/SARA_STORE.md §4, K1): the Sara Store's files, as types and strict
// validators. The index (`v1/index.json`) is what Sara reads to show the shelf; it pins one entry per
// version (`v1/entries/<id>/<version>.json`) and, for plugins and skills, the package (`.zip`) by
// sha256 and by its content hash (`hashFiles` of the unpacked files, the review card's fingerprint).
// Unknown fields anywhere refuse the whole file (new fields come with `v: 2`); an item of a kind this
// Sara doesn't know (routine, starter, bundle: reserved for later phases) is skipped. Phase 127
// (2.60.0, docs/design/PACKS.md §11.2) adds the fourth kind, `companion`: a pack zip like a plugin's,
// with `rating` and `romance` on the item and a `companion` block (the pack manifest) on the entry.
// 2.57–2.59 Saras skip companion items before reading their fields, so the new fields don't reach them.
// Pure: no I/O here. The signature, sequence and expiry rules are in verify.ts.
import { ID_RE, parseSemver } from '../plugins/manifest.ts';

export const INDEX_FORMAT = 'sara-store-index';
export const ENTRY_FORMAT = 'sara-store-entry';
export const INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const ENTRY_MAX_BYTES = 256 * 1024;
export const ITEMS_MAX = 2000;
export const VERSIONS_MAX = 10;
/** `expires` may be at most this long after `generated` (a month's list plus room). */
export const EXPIRY_MAX_MS = 45 * 24 * 3600_000;
export const KINDS = ['plugin', 'skill', 'mcp', 'companion'] as const;
/** The kinds 2.57–2.59 knew (a 2.59 reader is emulated with these in the tests). */
export const KINDS_259 = ['plugin', 'skill', 'mcp'] as const;
export type StoreKind = (typeof KINDS)[number];
/** Kinds later phases add to the same index (skipped here, never an error). */
export const RESERVED_KINDS = ['routine', 'starter', 'bundle'] as const;
export const COMPANION_RATINGS = ['general', 'mature', 'explicit'] as const;
/** A companion pack's zip may be bigger than a plugin's (pictures): §4.10. */
export const COMPANION_PACKAGE_MAX = 25 * 1024 * 1024;
export const TRUST = ['first-party', 'reviewed', 'community'] as const;
export type StoreTrust = (typeof TRUST)[number];
export const CATEGORIES = ['everyday', 'coding', 'chat-apps', 'home', 'creative', 'knowledge', 'search', 'tool-servers', 'skills', 'companions'] as const;
export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export type StorePlatform = (typeof PLATFORMS)[number];
export const FIELD_KINDS = ['text', 'url', 'folder', 'number', 'choice', 'secret'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export class StoreFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreFormatError';
  }
}

export interface StoreAuthor {
  name: string;
  /** `ed25519:` + the hex sha256 of the raw 32-byte public key. */
  key: string;
  since?: string;
  contact?: string;
}
export interface StoreVersion {
  version: string;
  sara: string;
  published: string;
  entry: string;
  entrySha: string;
  package?: string;
  sha256?: string;
  size?: number;
  contentSha?: string;
  permissions: string[];
  yanked?: string;
}
export interface StoreItem {
  id: string;
  kind: StoreKind;
  name: string;
  summary: string;
  trust: StoreTrust;
  category?: string;
  tags?: string[];
  author: StoreAuthor;
  icon?: string;
  iconSha?: string;
  /** Platforms it works on (from the entry), so the shelf can say "Not for this computer" without it. */
  works?: StorePlatform[];
  latest: string;
  versions: StoreVersion[];
  /** Companions (2.60): the author's rating and whether she's romantic. */
  rating?: (typeof COMPANION_RATINGS)[number];
  romance?: boolean;
}
export interface StoreBlock {
  id: string;
  versions: '*' | string[];
  action: 'disable' | 'warn';
  reason: string;
  at: string;
  /** The content hashes of the blocked versions, so copies installed from a file are found too. */
  contentShas?: string[];
}
export interface StoreIndex {
  format: typeof INDEX_FORMAT;
  v: 1;
  seq: number;
  generated: string;
  expires: string;
  key: string;
  minSara: string;
  items: StoreItem[];
  blocked: StoreBlock[];
  reservedIds: string[];
  revokedKeys?: string[];
}

export interface RecipeField {
  key: string;
  kind: FieldKind;
  label: string;
  tip: string;
  default?: string;
  optional?: boolean;
  secret?: boolean;
  where?: 'local' | 'public';
  choices?: string[];
  /** http recipes: a secret field goes to this header (with the prefix, e.g. "Bearer "). */
  header?: string;
  prefix?: string;
}
export interface McpRecipe {
  registry?: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  name: string;
  fields: RecipeField[];
  secrets: RecipeField[];
  reaches: string[];
  tools: { readOnly: string[]; ask: string[] };
  needs: string[];
  guide: string[];
}
export interface StoreShot {
  file: string;
  sha256: string;
  alt: string;
  width?: number;
}
export interface StoreEntry {
  format: typeof ENTRY_FORMAT;
  v: 1;
  id: string;
  kind: StoreKind;
  version: string;
  name: string;
  description: string;
  about: string[];
  author: StoreAuthor;
  license: string;
  source?: string;
  shots: StoreShot[];
  changes: string[];
  checks: { ran: string; by: string; results: { id: string; ok: boolean; note?: string }[] };
  review?: { by: 'team'; at: string; notes?: string };
  tested: { os: StorePlatform; sara: string }[];
  needs: string[];
  works: StorePlatform[];
  scripts?: boolean;
  mcp?: McpRecipe;
  manifest?: Record<string, unknown>;
  /** Companions (2.60): the pack's manifest, so the item page shows her before download. */
  companion?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// small strict readers
// ---------------------------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^ed25519:[0-9a-f]{64}$/;
/** A path inside v1/ (no `..`, no leading slash, no backslash, no query). */
const REL = /^(?:entries|packages|shots)\/[A-Za-z0-9._@/-]{1,200}$/;

const bad = (m: string): never => {
  throw new StoreFormatError(m);
};
function obj(v: unknown, what: string, keys: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${what} must be an object.`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${what} has an unknown field "${k}".`);
  for (const k of required) if (o[k] === undefined) bad(`${what} is missing "${k}".`);
  return o;
}
function text(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== 'string') return bad(`${what} must be text.`);
  if (v.length < min || v.trim().length < min) bad(`${what} is empty.`);
  if (v.length > max) bad(`${what} is longer than ${max} characters.`);
  // Plain text only: no control characters (newlines are fine in paragraphs).
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) bad(`${what} has control characters.`);
  return v;
}
function strings(v: unknown, what: string, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return bad(`${what} must be a list.`);
  if (v.length > maxItems) bad(`${what} has more than ${maxItems} entries.`);
  return v.map((x, i) => text(x, `${what}[${i}]`, maxLen));
}
const hex = (v: unknown, what: string): string => (typeof v === 'string' && HEX64.test(v) ? v : bad(`${what} must be a sha256 (64 hex digits).`));
const iso = (v: unknown, what: string): string => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : bad(`${what} must be an ISO time (UTC).`));
const day = (v: unknown, what: string): string => (typeof v === 'string' && (DAY.test(v) || ISO.test(v)) ? v : bad(`${what} must be a date.`));
const semver = (v: unknown, what: string): string => (typeof v === 'string' && v.length <= 40 && parseSemver(v) ? v : bad(`${what} must be a version like 1.2.0.`));
const rel = (v: unknown, what: string): string => (typeof v === 'string' && REL.test(v) && !v.split('/').includes('..') ? v : bad(`${what} must be a path inside the store.`));
const https = (v: unknown, what: string): string => (typeof v === 'string' && v.length <= 300 && /^https:\/\/[^\s<>"']+$/.test(v) ? v : bad(`${what} must be an https:// address.`));
const range = (v: unknown, what: string): string => (typeof v === 'string' && v.length <= 60 && /^[\d.<>=^~| xX*-]+$/.test(v) ? v : bad(`${what} must be a version range.`));
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => ((list as readonly unknown[]).includes(v) ? (v as T) : bad(`${what} must be one of ${list.join(', ')}.`));

export const isStoreId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);
/** "ed25519:9b1f…c2": how a key fingerprint is shown. */
export const shortKey = (fp: string): string => (FINGERPRINT.test(fp) ? `ed25519:${fp.slice(8, 12)}…${fp.slice(-2)}` : fp);

function parseAuthor(v: unknown, what: string): StoreAuthor {
  const o = obj(v, what, ['name', 'key', 'since', 'contact'], ['name', 'key']);
  return {
    name: text(o.name, `${what}.name`, 60),
    key: typeof o.key === 'string' && FINGERPRINT.test(o.key) ? o.key : bad(`${what}.key must be ed25519:<64 hex>.`),
    ...(o.since !== undefined ? { since: day(o.since, `${what}.since`) } : {}),
    ...(o.contact !== undefined ? { contact: https(o.contact, `${what}.contact`) } : {}),
  };
}

function parseVersion(v: unknown, what: string, kind: StoreKind): StoreVersion {
  const o = obj(v, what, ['version', 'sara', 'published', 'entry', 'entrySha', 'package', 'sha256', 'size', 'contentSha', 'permissions', 'yanked'], ['version', 'sara', 'published', 'entry', 'entrySha', 'permissions']);
  const out: StoreVersion = {
    version: semver(o.version, `${what}.version`),
    sara: range(o.sara, `${what}.sara`),
    published: day(o.published, `${what}.published`),
    entry: rel(o.entry, `${what}.entry`),
    entrySha: hex(o.entrySha, `${what}.entrySha`),
    permissions: strings(o.permissions, `${what}.permissions`, 80, 200),
  };
  if (kind === 'mcp') {
    if (o.package !== undefined || o.sha256 !== undefined || o.contentSha !== undefined) bad(`${what}: a tool server has no package, only its entry.`);
  } else {
    out.package = rel(o.package, `${what}.package`);
    out.sha256 = hex(o.sha256, `${what}.sha256`);
    out.contentSha = hex(o.contentSha, `${what}.contentSha`);
    const cap = kind === 'companion' ? COMPANION_PACKAGE_MAX : 10 * 1024 * 1024;
    if (!Number.isInteger(o.size) || (o.size as number) < 1 || (o.size as number) > cap) bad(`${what}.size must be a number of bytes (at most ${cap / 1048576} MB).`);
    out.size = o.size as number;
  }
  if (o.yanked !== undefined) out.yanked = text(o.yanked, `${what}.yanked`, 300);
  return out;
}

function parseItem(v: Record<string, unknown>, what: string, reserved: readonly string[]): StoreItem {
  const companion = v.kind === 'companion';
  const o = obj(v, what, ['id', 'kind', 'name', 'summary', 'trust', 'category', 'tags', 'author', 'icon', 'iconSha', 'works', 'latest', 'versions', ...(companion ? ['rating', 'romance'] : [])], ['id', 'kind', 'name', 'summary', 'trust', 'author', 'latest', 'versions', ...(companion ? ['rating', 'romance'] : [])]);
  const id = isStoreId(o.id) ? o.id : bad(`${what}.id must be lowercase letters, digits and dashes (at most 48).`);
  const kind = oneOf(o.kind, KINDS, `${what}.kind`);
  const trust = oneOf(o.trust, TRUST, `${what}.trust`);
  if (reserved.includes(id) && trust !== 'first-party') bad(`${what}: "${id}" is a reserved name.`);
  if (!Array.isArray(o.versions) || !o.versions.length) bad(`${what}.versions must list at least one version.`);
  if ((o.versions as unknown[]).length > VERSIONS_MAX) bad(`${what}.versions has more than ${VERSIONS_MAX} entries.`);
  const versions = (o.versions as unknown[]).map((x, i) => parseVersion(x, `${what}.versions[${i}]`, kind));
  if (new Set(versions.map((x) => x.version)).size !== versions.length) bad(`${what} lists a version twice.`);
  const latest = semver(o.latest, `${what}.latest`);
  if (!versions.some((x) => x.version === latest)) bad(`${what}.latest is not in its versions.`);
  const item: StoreItem = {
    id,
    kind,
    name: text(o.name, `${what}.name`, 60),
    summary: text(o.summary, `${what}.summary`, 160),
    trust,
    author: parseAuthor(o.author, `${what}.author`),
    latest,
    versions,
  };
  if (companion) {
    item.rating = oneOf(o.rating, COMPANION_RATINGS, `${what}.rating`);
    item.romance = typeof o.romance === 'boolean' ? o.romance : bad(`${what}.romance must be true or false.`);
    if (item.rating === 'explicit' && !item.romance) bad(`${what}: an explicit companion is romantic too.`);
  }
  if (o.category !== undefined) item.category = text(o.category, `${what}.category`, 24);
  if (o.tags !== undefined) item.tags = strings(o.tags, `${what}.tags`, 8, 24);
  if (o.works !== undefined) item.works = strings(o.works, `${what}.works`, 3, 10).map((w, i) => oneOf(w, PLATFORMS, `${what}.works[${i}]`));
  if (o.icon !== undefined) {
    item.icon = rel(o.icon, `${what}.icon`);
    item.iconSha = hex(o.iconSha, `${what}.iconSha`);
  } else if (o.iconSha !== undefined) bad(`${what}.iconSha needs an icon.`);
  return item;
}

function parseBlock(v: unknown, what: string): StoreBlock {
  const o = obj(v, what, ['id', 'versions', 'action', 'reason', 'at', 'contentShas'], ['id', 'versions', 'action', 'reason', 'at']);
  const b: StoreBlock = {
    id: isStoreId(o.id) ? o.id : bad(`${what}.id is not a store id.`),
    versions: o.versions === '*' ? '*' : strings(o.versions, `${what}.versions`, 50, 40).map((x, i) => semver(x, `${what}.versions[${i}]`)),
    action: oneOf(o.action, ['disable', 'warn'] as const, `${what}.action`),
    reason: text(o.reason, `${what}.reason`, 300),
    at: day(o.at, `${what}.at`),
  };
  if (o.contentShas !== undefined) {
    if (!Array.isArray(o.contentShas) || o.contentShas.length > 50) bad(`${what}.contentShas must be a list (at most 50).`);
    b.contentShas = (o.contentShas as unknown[]).map((x, i) => hex(x, `${what}.contentShas[${i}]`));
  }
  return b;
}

/**
 * The index, from its JSON text (already signature-checked by verify.ts). `skipped` lists the ids of
 * items of a kind this Sara doesn't know (reserved for later phases), which are left out.
 */
export function parseIndex(json: string | unknown, kinds: readonly string[] = KINDS): { index: StoreIndex; skipped: string[] } {
  if (typeof json === 'string' && Buffer.byteLength(json) > INDEX_MAX_BYTES) bad('The store list is bigger than 2 MB.');
  let raw: unknown = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch {
      bad('The store list is not JSON.');
    }
  }
  const o = obj(raw, 'The store list', ['format', 'v', 'seq', 'generated', 'expires', 'key', 'minSara', 'items', 'blocked', 'reservedIds', 'revokedKeys'], ['format', 'v', 'seq', 'generated', 'expires', 'key', 'minSara', 'items', 'blocked', 'reservedIds']);
  if (o.format !== INDEX_FORMAT) bad('This is not a Sara Store list.');
  if (o.v !== 1) bad("This Sara is too old for the store's list. Update Sara.");
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1) bad('seq must be a positive whole number.');
  const generated = iso(o.generated, 'generated');
  const expires = iso(o.expires, 'expires');
  const span = Date.parse(expires) - Date.parse(generated);
  if (span <= 0) bad('expires must be after generated.');
  if (span > EXPIRY_MAX_MS) bad('expires may be at most 45 days after generated.');
  const key = typeof o.key === 'string' && KEY_NAME.test(o.key) ? o.key : bad('key must name a store key.');
  const minSara = semver(o.minSara, 'minSara');
  const reservedIds = strings(o.reservedIds, 'reservedIds', 200, 48);
  if (!Array.isArray(o.items)) bad('items must be a list.');
  if ((o.items as unknown[]).length > ITEMS_MAX) bad(`The store list has more than ${ITEMS_MAX} items.`);
  const items: StoreItem[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  (o.items as unknown[]).forEach((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) bad(`items[${i}] must be an object.`);
    const it = x as Record<string, unknown>;
    const id = isStoreId(it.id) ? it.id : bad(`items[${i}].id must be lowercase letters, digits and dashes (at most 48).`);
    if (seen.has(id)) bad(`"${id}" is in the list twice.`);
    seen.add(id);
    if (!(kinds as readonly unknown[]).includes(it.kind)) {
      // A kind of a later phase (or one we never heard of): skipped, not an error.
      if (typeof it.kind !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(it.kind)) bad(`items[${i}].kind is not a kind name.`);
      skipped.push(id);
      return;
    }
    // §11.1: an explicit companion is never community (it needs a person's review first): left out.
    if (it.kind === 'companion' && it.rating === 'explicit' && it.trust === 'community') {
      skipped.push(id);
      return;
    }
    items.push(parseItem(it, `items[${i}]`, reservedIds));
  });
  if (!Array.isArray(o.blocked)) bad('blocked must be a list.');
  if ((o.blocked as unknown[]).length > 500) bad('blocked has more than 500 entries.');
  const blocked = (o.blocked as unknown[]).map((x, i) => parseBlock(x, `blocked[${i}]`));
  const index: StoreIndex = { format: INDEX_FORMAT, v: 1, seq: o.seq as number, generated, expires, key, minSara, items, blocked, reservedIds };
  if (o.revokedKeys !== undefined) index.revokedKeys = strings(o.revokedKeys, 'revokedKeys', 20, 32).map((k) => (KEY_NAME.test(k) ? k : bad('revokedKeys must name store keys.')));
  return { index, skipped };
}

// ---------------------------------------------------------------------------------------------
// entries and MCP recipes
// ---------------------------------------------------------------------------------------------

const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

function parseField(v: unknown, what: string, http: boolean, secretList: boolean): RecipeField {
  const o = obj(v, what, ['key', 'kind', 'label', 'tip', 'default', 'optional', 'secret', 'where', 'choices', 'header', 'prefix'], ['key', 'kind', 'label', 'tip']);
  const f: RecipeField = {
    key: typeof o.key === 'string' && ENV_KEY.test(o.key) ? o.key : bad(`${what}.key must be an environment name like COMFYUI_URL.`),
    kind: oneOf(o.kind, FIELD_KINDS, `${what}.kind`),
    label: text(o.label, `${what}.label`, 60),
    // The plugin rule for ? tips: 10 to 260 characters.
    tip: typeof o.tip === 'string' && o.tip.trim().length >= 10 && o.tip.length <= 260 ? text(o.tip, `${what}.tip`, 260) : bad(`${what} needs a tip of 10 to 260 characters.`),
  };
  if (o.default !== undefined) f.default = text(o.default, `${what}.default`, 300, 0);
  if (o.optional !== undefined) f.optional = o.optional === true ? true : bad(`${what}.optional must be true when given.`);
  if (o.secret !== undefined) f.secret = o.secret === true ? true : bad(`${what}.secret must be true when given.`);
  if (o.where !== undefined) f.where = oneOf(o.where, ['local', 'public'] as const, `${what}.where`);
  if (o.choices !== undefined) f.choices = strings(o.choices, `${what}.choices`, 20, 60);
  if (f.kind === 'choice' && !f.choices?.length) bad(`${what}: a choice field lists its choices.`);
  if (o.header !== undefined) f.header = typeof o.header === 'string' && HEADER_KEY.test(o.header) ? o.header : bad(`${what}.header must be a header name.`);
  if (o.prefix !== undefined) f.prefix = text(o.prefix, `${what}.prefix`, 20);
  if (secretList && f.kind !== 'secret') bad(`${what}: the secrets list holds secret fields only.`);
  if ((f.kind === 'secret' || f.secret) && f.default) bad(`${what}: a secret has no default value.`);
  if (http && (f.kind === 'secret' || f.secret) && !f.header) bad(`${what}: an http server's secret names the header it goes in.`);
  return f;
}

/** The shape of an MCP recipe (the rules about commands, versions and templates are in checks.ts). */
export function parseRecipe(v: unknown, what = 'mcp'): McpRecipe {
  const o = obj(v, what, ['registry', 'transport', 'command', 'args', 'url', 'name', 'fields', 'secrets', 'reaches', 'tools', 'needs', 'guide'], ['transport', 'name', 'fields', 'secrets', 'reaches', 'tools', 'needs', 'guide']);
  const transport = oneOf(o.transport, ['stdio', 'http'] as const, `${what}.transport`);
  const http = transport === 'http';
  const tools = obj(o.tools, `${what}.tools`, ['readOnly', 'ask'], ['readOnly', 'ask']);
  const r: McpRecipe = {
    transport,
    name: typeof o.name === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(o.name) ? o.name : bad(`${what}.name: lowercase letters, digits and dashes (max 31).`),
    fields: (Array.isArray(o.fields) && o.fields.length <= 12 ? o.fields : bad(`${what}.fields must be a list (at most 12).`)).map((x: unknown, i: number) => parseField(x, `${what}.fields[${i}]`, http, false)),
    secrets: (Array.isArray(o.secrets) && o.secrets.length <= 6 ? o.secrets : bad(`${what}.secrets must be a list (at most 6).`)).map((x: unknown, i: number) => parseField(x, `${what}.secrets[${i}]`, http, true)),
    reaches: strings(o.reaches, `${what}.reaches`, 8, 160),
    tools: { readOnly: strings(tools.readOnly, `${what}.tools.readOnly`, 100, 64), ask: strings(tools.ask, `${what}.tools.ask`, 100, 64) },
    needs: strings(o.needs, `${what}.needs`, 8, 80),
    guide: strings(o.guide, `${what}.guide`, 12, 300),
  };
  if (o.registry !== undefined) r.registry = text(o.registry, `${what}.registry`, 120);
  if (http) {
    if (o.command !== undefined || o.args !== undefined) bad(`${what}: an http server has a url, not a command.`);
    r.url = text(o.url, `${what}.url`, 300);
  } else {
    if (o.url !== undefined) bad(`${what}: a stdio server has a command, not a url.`);
    r.command = text(o.command, `${what}.command`, 200);
    r.args = strings(o.args ?? [], `${what}.args`, 40, 300);
  }
  const keys = [...r.fields, ...r.secrets].map((f) => f.key);
  if (new Set(keys).size !== keys.length) bad(`${what}: two fields have the same key.`);
  return r;
}

/** One entry file (`entries/<id>/<version>.json`), checked against what the index says it is. */
export function parseEntry(json: string | unknown, expect?: { id: string; version: string; kind: StoreKind }): StoreEntry {
  if (typeof json === 'string' && Buffer.byteLength(json) > ENTRY_MAX_BYTES) bad('The entry is bigger than 256 KB.');
  let raw: unknown = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch {
      bad('The entry is not JSON.');
    }
  }
  const o = obj(raw, 'The entry', ['format', 'v', 'id', 'kind', 'version', 'name', 'description', 'about', 'author', 'license', 'source', 'shots', 'changes', 'checks', 'review', 'tested', 'needs', 'works', 'scripts', 'mcp', 'manifest', 'companion'], ['format', 'v', 'id', 'kind', 'version', 'name', 'description', 'about', 'author', 'license', 'shots', 'changes', 'checks', 'tested', 'needs', 'works']);
  if (o.format !== ENTRY_FORMAT) bad('This is not a Sara Store entry.');
  if (o.v !== 1) bad("This Sara is too old for the store's list. Update Sara.");
  const kind = oneOf(o.kind, KINDS, 'kind');
  const checks = obj(o.checks, 'checks', ['ran', 'by', 'results'], ['ran', 'by', 'results']);
  if (!Array.isArray(checks.results) || checks.results.length > 20) bad('checks.results must be a list.');
  const e: StoreEntry = {
    format: ENTRY_FORMAT,
    v: 1,
    id: isStoreId(o.id) ? o.id : bad('id is not a store id.'),
    kind,
    version: semver(o.version, 'version'),
    name: text(o.name, 'name', 60),
    description: text(o.description, 'description', 300, 20),
    about: strings(o.about, 'about', 12, 1200),
    author: parseAuthor(o.author, 'author'),
    license: text(o.license, 'license', 40),
    shots: (Array.isArray(o.shots) && o.shots.length <= 5 ? o.shots : bad('shots must be a list (at most 5).')).map((x: unknown, i: number) => {
      const s = obj(x, `shots[${i}]`, ['file', 'sha256', 'alt', 'width'], ['file', 'sha256', 'alt']);
      return { file: rel(s.file, `shots[${i}].file`), sha256: hex(s.sha256, `shots[${i}].sha256`), alt: text(s.alt, `shots[${i}].alt`, 160), ...(s.width !== undefined ? { width: Number.isInteger(s.width) && (s.width as number) > 0 && (s.width as number) <= 4000 ? (s.width as number) : bad(`shots[${i}].width must be pixels.`) } : {}) };
    }),
    changes: strings(o.changes, 'changes', 20, 300),
    checks: {
      ran: iso(checks.ran, 'checks.ran'),
      by: text(checks.by, 'checks.by', 60),
      results: (checks.results as unknown[]).map((x, i) => {
        const r = obj(x, `checks.results[${i}]`, ['id', 'ok', 'note'], ['id', 'ok']);
        return { id: text(r.id, `checks.results[${i}].id`, 24), ok: typeof r.ok === 'boolean' ? r.ok : bad(`checks.results[${i}].ok must be true or false.`), ...(r.note !== undefined ? { note: text(r.note, `checks.results[${i}].note`, 300) } : {}) };
      }),
    },
    tested: (Array.isArray(o.tested) && o.tested.length <= 6 ? o.tested : bad('tested must be a list.')).map((x: unknown, i: number) => {
      const t = obj(x, `tested[${i}]`, ['os', 'sara'], ['os', 'sara']);
      return { os: oneOf(t.os, PLATFORMS, `tested[${i}].os`), sara: semver(t.sara, `tested[${i}].sara`) };
    }),
    needs: strings(o.needs, 'needs', 8, 80),
    works: strings(o.works, 'works', 3, 10).map((w, i) => oneOf(w, PLATFORMS, `works[${i}]`)),
  };
  if (o.source !== undefined) e.source = https(o.source, 'source');
  if (o.review !== undefined) {
    const r = obj(o.review, 'review', ['by', 'at', 'notes'], ['by', 'at']);
    // Reviewers' names never appear: always "team".
    if (r.by !== 'team') bad('review.by must be "team".');
    e.review = { by: 'team', at: day(r.at, 'review.at'), ...(r.notes !== undefined ? { notes: text(r.notes, 'review.notes', 1200) } : {}) };
  }
  if (o.scripts !== undefined) e.scripts = typeof o.scripts === 'boolean' ? o.scripts : bad('scripts must be true or false.');
  if (kind === 'companion') {
    if (o.manifest !== undefined || o.mcp !== undefined) bad('A companion entry carries her pack manifest (companion), not a manifest or a recipe.');
    const c = o.companion;
    if (!c || typeof c !== 'object' || Array.isArray(c) || (c as Record<string, unknown>).format !== 'sara-companion') bad('A companion entry carries her pack manifest.');
    if ((c as Record<string, unknown>).id !== e.id || (c as Record<string, unknown>).version !== e.version) bad("The companion entry's manifest doesn't match the entry.");
    e.companion = c as Record<string, unknown>;
  } else if (o.companion !== undefined) bad('Only companions carry a pack manifest.');
  else if (kind === 'mcp') {
    if (o.manifest !== undefined) bad('A tool server entry has a recipe (mcp), not a manifest.');
    e.mcp = parseRecipe(o.mcp);
  } else {
    if (o.mcp !== undefined) bad('Only tool servers have a recipe.');
    if (!o.manifest || typeof o.manifest !== 'object' || Array.isArray(o.manifest)) bad('A plugin or skill entry carries its manifest.');
    e.manifest = o.manifest as Record<string, unknown>;
  }
  if (expect && (e.id !== expect.id || e.version !== expect.version || e.kind !== expect.kind)) bad("The entry doesn't match the store's list.");
  return e;
}

/**
 * MNT2: a companion's sheet speaks of {{user}}; a Store page speaks to the reader (the same words the
 * store website uses): "{{user}}'s" → "your", "{{user}} is/has" → "you are/have", "{{user}} feels" →
 * "you feel", any other {{user}} → "you". In another language the owner's name is used instead
 * (those pronouns do not translate word for word); with no name yet, the same English rule.
 */
export function speakToReader(text: string, o: { lang?: string; name?: string } = {}): string {
  if (!text.includes('{{')) return text;
  const name = o.name?.trim();
  if (o.lang && !/^en\b/i.test(o.lang) && name) return text.replace(/\{\{user\}\}/gi, name);
  return text.replace(/\{\{user\}\}'s\b/gi, 'your').replace(/\{\{user\}\} is\b/gi, 'you are').replace(/\{\{user\}\} has\b/gi, 'you have').replace(/\{\{user\}\} (\w+?[^s])s\b/gi, 'you $1').replace(/\{\{user\}\}/gi, 'you');
}
