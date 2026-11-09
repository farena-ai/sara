// Phase 125 (2.58.0, SARA_STORE.md §8, K5): installing from the Sara Store through the review cards
// that exist. A plugin is staged by PluginManager.stage with origin `store` (the normal card plus the
// store strip); a skill goes through the skills import review (origin `store:<id>@<version>`); a tool
// server gets its own card (new: adding one by hand starts it at once) showing the exact command, its
// Windows form, the fields, what goes to the vault and the fence, and nothing starts before *Add and
// start*. Updates show the permission diff; the old version (or recipe) is kept for *Go back*. A held
// id can't be installed or updated; a block switches an add-on off (never deletes it), and the owner
// may switch it back on after a confirm (logged). Nothing is switched on by installing.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../chat.ts';
import { mcpSecrets, mergeSecrets } from '../integrations.ts';
import type { PackageFile } from '../packages.ts';
import type { PluginManager, Review } from '../plugins/manager.ts';
import { parseManifest, permissionLines, type PermissionLine } from '../plugins/manifest.ts';
import { mcpToolName, mcpVaultKey, MCP_NAME_RE, validateMcpConfig, type McpServerConfig } from '../tools/mcp.ts';
import { badFolder, recipeCommand, recipeProblems } from './checks.ts';
import { pluginInstallation, type StoreClient } from './client.ts';
import { parseRecipe, type McpRecipe, type RecipeField, type StoreEntry, type StoreItem, type StoreVersion } from './format.ts';
import type { StoreInstallRow, StoreInstalls } from './installs.ts';
import { StoreRefused } from './verify.ts';
import { programFor, type ProgramId } from '../prereqs/catalog.ts';
import type { Detection } from '../prereqs/detect.ts';
import { PrereqService, prereqOverrides } from '../prereqs/service.ts';

export const MCP_REVIEW_MS = 3600_000;
export const TEST_MS = 30_000;
export const OVERRIDE_NOTE = 'switched back on by the owner after the Sara Store pulled it';

/** A plain refusal the page shows as is (the routes turn it into a 4xx). */
export class InstallError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Need {
  what: string;
  found: boolean | null;
  /** PRQ: the catalog program this need is (the card offers *Install it for me*). */
  program?: ProgramId;
  /** Found but older than add-ons need (e.g. Node < 22). */
  old?: boolean;
}
export interface McpReview {
  id: string;
  kind: 'mcp';
  mode: 'install' | 'update';
  item: string;
  version: string;
  name: string;
  trust: StoreItem['trust'];
  serverName: string;
  renamed: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  windowsForm?: { command: string; args: string[] };
  fields: RecipeField[];
  secrets: RecipeField[];
  needs: Need[];
  reaches: string[];
  tools: { readOnly: string[]; ask: string[] };
  fence: 'bwrap' | 'seatbelt' | 'user' | 'none';
  needsTrust: boolean;
  tested: { os: string; sara: string }[];
  guide: string[];
  registry?: string;
  /** An update: the marked lines (a changed command or version, new fields and secrets, tools now auto). */
  changes: string[];
  from?: string;
  /** Q-ADDONS: an update's saved field values (never secrets), so the card shows them instead of the defaults. */
  saved?: Record<string, string>;
  expires: number;
}
interface Staged {
  review: McpReview;
  recipe: McpRecipe;
  entrySha: string;
}

const staged = new Map<string, Staged>();

export interface InstallerDeps {
  app: AppContext;
  client: StoreClient;
  installs: StoreInstalls;
  plugins?: PluginManager;
  platform?: NodeJS.Platform;
  pathVar?: string;
  now?: () => Date;
  /** Tests: the 30-second Test (initialize + tools/list). */
  testMs?: number;
  /** Phase 127: companion packs (the card and the new companion). */
  packs?: import('../packs/install.ts').PackInstaller;
  /** PRQ: finds catalog programs (Chrome, uv, Docker, …) where Sara runs (src/prereqs/service.ts). */
  programs?: { detect(id: ProgramId): Detection };
}

const which = (cmd: string, pathVar: string | undefined, platform: NodeJS.Platform): boolean => {
  if (cmd === 'node') return true;
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (pathVar ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).some((d) => exts.some((e) => existsSync(join(d, cmd + e))));
};

/** The server's config from a recipe and the owner's values (templates filled, ${home} its own folder). */
export function recipeConfig(dataDir: string, recipe: McpRecipe, name: string, values: Record<string, string>): McpServerConfig {
  const home = join(dataDir, 'mcp', name);
  const fill = (s: string) => s.replace(/\$\{setting:([^}]+)\}/g, (_m, k: string) => values[k] ?? '').replace(/\$\{home\}/g, home);
  // An optional field left empty drops an argument that was only that field.
  const args = (recipe.args ?? []).flatMap((a) => (/^\$\{setting:[^}]+\}$/.test(a) && !fill(a) ? [] : [fill(a)]));
  // Q-ADDONS: the folders the owner picked are granted to the tool sandbox (src/tools/mcp.ts mcpBinds).
  const folders = recipe.fields.filter((f) => f.kind === 'folder').map((f) => values[f.key] ?? '').filter(Boolean);
  const raw = recipe.transport === 'stdio' ? { transport: 'stdio', command: recipe.command, args, ...(folders.length ? { folders } : {}) } : { transport: 'http', url: fill(recipe.url ?? '') };
  return validateMcpConfig(raw as Record<string, unknown>, name);
}

/**
 * B2: Settings → Other programs edits a Store-installed server through its recipe's fields. A field
 * left empty keeps what the vault has (or the default); secrets are only replaced, never shown.
 */
export function recipeEdit(dataDir: string, recipe: McpRecipe, name: string, cur: { env?: Record<string, string>; headers?: Record<string, string> }, fields: Record<string, unknown>): { cfg: McpServerConfig; env: Record<string, string>; headers: Record<string, string> } {
  const secretKeys = new Set([...recipe.secrets, ...recipe.fields.filter((x) => x.kind === 'secret')].map((f) => f.key));
  const given = (k: string) => String(fields[k] ?? '').trim();
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const f of recipe.fields) {
    if (secretKeys.has(f.key)) continue;
    const v = given(f.key) || cur.env?.[f.key] || f.default || '';
    if (!v) {
      if (!f.optional) throw new InstallError(400, 'field', `${f.label}: fill this in.`);
      continue;
    }
    if (f.kind === 'url') {
      try {
        const u = new URL(v);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('');
      } catch {
        throw new InstallError(400, 'field', `${f.label}: that isn't a web address.`);
      }
    }
    if (f.kind === 'number' && !Number.isFinite(Number(v))) throw new InstallError(400, 'field', `${f.label}: a number, please.`);
    if (f.kind === 'choice' && f.choices && !f.choices.includes(v)) throw new InstallError(400, 'field', `${f.label}: pick one of the choices.`);
    values[f.key] = v.slice(0, 2000);
    if (given(f.key) && recipe.transport === 'stdio') env[f.key] = values[f.key];
  }
  for (const f of [...recipe.secrets, ...recipe.fields.filter((x) => x.kind === 'secret')]) {
    const v = given(f.key).slice(0, 4000);
    if (!v) continue;
    if (recipe.transport === 'stdio') env[f.key] = v;
    else headers[f.header ?? f.key] = `${f.prefix ?? ''}${v}`;
    values[f.key] = v;
  }
  const cfg = recipeConfig(dataDir, recipe, name, { ...(cur.env ?? {}), ...values });
  return { cfg, env, headers };
}

export class StoreInstaller {
  readonly d: InstallerDeps;
  constructor(d: InstallerDeps) {
    this.d = d;
  }
  #now(): Date {
    return this.d.now?.() ?? this.d.app.now();
  }
  get #platform(): NodeJS.Platform {
    return this.d.platform ?? process.platform;
  }

  /** The verified version to install, or a plain refusal (held, blocked, yanked, expired, can't run here). */
  #pick(id: string, version?: string, o: { community?: boolean; understand?: boolean } = {}): { item: StoreItem; v: StoreVersion } {
    const c = this.d.client;
    if (c.blocked()) throw new InstallError(409, 'off', 'The Sara Store is off here, so nothing can be installed.');
    const cur = c.current();
    if (!cur) throw new InstallError(409, 'none', "Sara couldn't reach the store. Check your internet, then Check now.");
    if (!c.installAllowed()) throw new InstallError(409, 'expired', 'The list expired: installs wait until Sara can check again.');
    if (cur.index.blocked.some((b) => b.id === id)) throw new InstallError(403, 'blocked', 'The Sara store blocked this add-on.');
    if (c.held().some((h) => h.id === id)) throw new InstallError(409, 'held', 'Being checked by the Sara team: try again later.');
    const hit = c.version(id, version);
    if (!hit) throw new InstallError(404, 'missing', 'That add-on is not in the store.');
    if (hit.v.yanked) throw new InstallError(409, 'yanked', `This version was pulled from the store: ${hit.v.yanked}`);
    if (hit.item.trust === 'community' && (!o.community || !o.understand)) throw new InstallError(403, 'community', 'Tick “I understand nobody at Sara has read this” first.');
    return hit;
  }

  /** Get (or Update): download, verify and stage the right review. Nothing is installed by this. */
  async install(id: string, o: { version?: string; community?: boolean; understand?: boolean } = {}): Promise<{ kind: 'plugin'; review: Review } | { kind: 'skill'; review: Record<string, unknown> } | { kind: 'mcp'; review: McpReview } | { kind: 'companion'; token: string; card: import('../packs/install.ts').PackCard }> {
    const { item, v } = this.#pick(id, o.version, o);
    if (item.kind === 'plugin') this.#pluginAuthority(id);
    if (item.kind === 'mcp') return { kind: 'mcp', review: await this.mcpReview(item, v) };
    let files: PackageFile[];
    try {
      files = await this.d.client.packageFiles(id, v.version);
    } catch (err) {
      if (err instanceof StoreRefused && (err.code === 'hash' || err.code === 'content')) throw new InstallError(409, 'mismatch', "That download didn't match the store's list, so Sara threw it away. Try again later.");
      throw new InstallError(502, 'download', err instanceof StoreRefused ? err.message : "Sara couldn't download it. Try again later.");
    }
    if (item.kind === 'companion') {
      // Phase 127 (PACKS.md §8.1): the same card as a file, with the store's strip; Add her makes a new companion.
      const packs = this.d.packs;
      if (!packs) throw new InstallError(409, 'companions', 'More companions are not available on this server.');
      const { card } = packs.preview(files, { origin: 'store', trust: item.trust, store: { item: id, version: v.version, entrySha: v.entrySha, trust: item.trust } });
      if (card.id !== id) {
        packs.cancel(card.token);
        throw new InstallError(409, 'mismatch', "That download didn't match the store's list, so Sara threw it away. Try again later.");
      }
      return { kind: 'companion', token: card.token, card };
    }
    if (item.kind === 'plugin') {
      const pm = this.d.plugins;
      if (!pm) throw new InstallError(409, 'plugins', "Plugins aren't available on this server.");
      this.#pluginAuthority(id);
      const review = pm.stage(files, { kind: 'store', where: `${id}@${v.version}` });
      if (review.manifest.id !== id) {
        pm.cancel(review.id);
        throw new InstallError(409, 'mismatch', "That download didn't match the store's list, so Sara threw it away. Try again later.");
      }
      review.store ??= { item: id, version: v.version, name: item.name, trust: item.trust };
      return { kind: 'plugin', review };
    }
    const skills = this.d.app.skills;
    if (!skills) throw new InstallError(409, 'skills', "Skills aren't available here.");
    const p = skills.stage(files, `store:${id}@${v.version}`, 'zip');
    return { kind: 'skill', review: { id: p.id, origin: p.origin, kind: p.kind, skills: p.skills, scopes: skills.writableScopes(), store: { item: id, version: v.version, name: item.name, trust: item.trust } } };
  }

  // ---- tool servers ----

  #fence(): McpReview['fence'] {
    const m = this.d.app.sandbox?.mode;
    return m === 'bwrap' || m === 'seatbelt' || m === 'user' ? m : 'none';
  }
  #freeName(base: string, keep?: string): { name: string; renamed: boolean } {
    const taken = new Set((this.d.app.settings.get().mcpServers ?? []).map((s) => s.name).filter((n) => n !== keep));
    const clean = MCP_NAME_RE.test(base) ? base : base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 28) || 'server';
    if (!taken.has(clean)) return { name: clean, renamed: false };
    for (let i = 2; i < 100; i++) if (!taken.has(`${clean.slice(0, 28)}-${i}`)) return { name: `${clean.slice(0, 28)}-${i}`, renamed: true };
    throw new InstallError(409, 'name', 'Too many tool servers with this name.');
  }

  /** The tool-server card (§8.4). For an installed one, the update card with the marked changes. */
  async mcpReview(item: StoreItem, v: StoreVersion): Promise<McpReview> {
    const entry = await this.d.client.entry(item.id, v.version);
    if (!entry.mcp) throw new InstallError(409, 'recipe', 'This entry has no recipe.');
    const recipe = parseRecipe(entry.mcp);
    const problems = recipeProblems(entry.mcp, { dataDirs: [this.d.app.dataDir] });
    if (problems.length) throw new InstallError(409, 'recipe', problems[0]);
    const row = this.d.installs.get(item.id);
    const updating = row?.kind === 'mcp';
    // Already on this exact version: say so instead of offering an "update" to the same version.
    if (updating && row.version === v.version) throw new InstallError(409, 'installed', `${entry.name} ${v.version} is already installed.`);
    const { name, renamed } = updating ? { name: row.local_ref, renamed: false } : this.#freeName(recipe.name ?? item.id);
    const plat = this.#platform;
    const pathVar = this.d.pathVar ?? process.env.PATH;
    const win = plat === 'win32' ? recipeCommand(recipe, { platform: 'win32', pathVar }) : undefined;
    const needs = this.#needs(recipe);
    const fence = this.#fence();
    const changes = updating && row.recipe ? recipeDiff(JSON.parse(row.recipe) as McpRecipe, recipe) : [];
    const secretKeys = new Set([...recipe.secrets, ...recipe.fields.filter((x) => x.kind === 'secret')].map((f) => f.key));
    const env = updating && recipe.transport === 'stdio' ? (mcpSecrets(this.d.app.vault, name).env ?? {}) : {};
    const saved = Object.fromEntries(recipe.fields.filter((f) => !secretKeys.has(f.key) && typeof env[f.key] === 'string').map((f) => [f.key, env[f.key]]));
    const review: McpReview = {
      id: randomUUID(),
      kind: 'mcp',
      mode: updating ? 'update' : 'install',
      item: item.id,
      version: v.version,
      name: entry.name,
      trust: item.trust,
      serverName: name,
      renamed,
      transport: recipe.transport,
      ...(recipe.transport === 'stdio' ? { command: recipe.command!, args: [...(recipe.args ?? [])] } : { url: recipe.url! }),
      ...(win ? { windowsForm: win } : {}),
      fields: recipe.fields,
      secrets: recipe.secrets,
      needs,
      reaches: recipe.reaches,
      tools: recipe.tools,
      fence,
      needsTrust: fence === 'none',
      tested: entry.tested ?? [],
      guide: recipe.guide ?? [],
      ...(recipe.registry ? { registry: recipe.registry } : {}),
      changes,
      ...(updating ? { from: row.version, saved } : {}),
      expires: Date.now() + MCP_REVIEW_MS,
    };
    for (const [k, s] of staged) if (s.review.expires < Date.now()) staged.delete(k);
    staged.set(review.id, { review, recipe, entrySha: v.entrySha });
    return review;
  }
  /**
   * PRQ: an installer built without the server's service (a companion's suggested add-on, a plugin's
   * Store install, a block) still detects catalog programs the catalog's way (known folders such as
   * /opt/google/chrome on Linux, not only PATH), so no card says "not checked" for Chrome.
   */
  #ownPrograms(platform: NodeJS.Platform, pathVar: string | undefined): { detect(id: ProgramId): Detection } {
    return new PrereqService({ platform, env: { ...process.env, PATH: pathVar ?? '' }, tmpRoot: '', setting: () => 'off', ...prereqOverrides() });
  }
  /** What a recipe needs on this computer; catalog programs are detected (PRQ), the rest looked up on PATH. */
  #needs(recipe: McpRecipe): Need[] {
    const plat = this.#platform;
    const pathVar = this.d.pathVar ?? process.env.PATH;
    const needs: Need[] = [];
    const add = (what: string) => {
      const id = programFor(what);
      if (needs.some((x) => x.what === what || (id && x.program === id))) return;
      if (id) {
        const d = (this.d.programs ?? this.#ownPrograms(plat, pathVar)).detect(id);
        needs.push({ what, found: d.found && !d.old, program: id, ...(d.old ? { old: true } : {}) });
      } else needs.push({ what, found: what.startsWith('app:') ? null : which(what, pathVar, plat) });
    };
    if (recipe.transport === 'stdio' && recipe.command) add(recipe.command === 'npx' ? 'node' : recipe.command);
    for (const n of recipe.needs ?? []) add(n);
    return needs;
  }
  /** PRQ: after *Install it for me*, the card looks again (then *Continue install*). */
  mcpRecheck(id: string): McpReview | undefined {
    const s = staged.get(id);
    if (!s || s.review.expires < Date.now()) return undefined;
    s.review.needs = this.#needs(s.recipe);
    return s.review;
  }
  mcpPending(id: string): McpReview | undefined {
    const s = staged.get(id);
    return s && s.review.expires > Date.now() ? s.review : undefined;
  }
  mcpCancel(id: string): boolean {
    return staged.delete(id);
  }

  /** The server's config from a recipe and the owner's values (templates filled, ${home} its own folder). */
  configFrom(recipe: McpRecipe, name: string, values: Record<string, string>): McpServerConfig {
    return recipeConfig(this.d.app.dataDir, recipe, name, values);
  }

  #checkValues(recipe: McpRecipe, values: Record<string, unknown>, secrets: Record<string, unknown>, keepSecrets: string[], saved: Record<string, string> = {}): { values: Record<string, string>; secrets: Record<string, string> } {
    const out: Record<string, string> = {};
    for (const f of recipe.fields) {
      // An update keeps what was saved (e.g. the ComfyUI address) unless the owner typed something else.
      const v = String(values[f.key] ?? saved[f.key] ?? f.default ?? '').trim();
      if (!v) {
        if (!f.optional) throw new InstallError(400, 'field', `${f.label}: fill this in.`);
        continue;
      }
      if (f.kind === 'url') {
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('');
        } catch {
          throw new InstallError(400, 'field', `${f.label}: that isn't a web address.`);
        }
      }
      if (f.kind === 'number' && !Number.isFinite(Number(v))) throw new InstallError(400, 'field', `${f.label}: a number, please.`);
      if (f.kind === 'choice' && f.choices && !f.choices.includes(v)) throw new InstallError(400, 'field', `${f.label}: pick one of the choices.`);
      if (f.kind === 'folder' && badFolder(v, [this.d.app.dataDir])) throw new InstallError(400, 'field', `${f.label}: Pick a folder of its own, not all of this computer.`);
      out[f.key] = v.slice(0, 2000);
    }
    const sec: Record<string, string> = {};
    for (const f of [...recipe.secrets, ...recipe.fields.filter((x) => x.kind === 'secret')]) {
      const v = String(secrets[f.key] ?? '').trim();
      if (v) sec[f.key] = v.slice(0, 4000);
      else if (!f.optional && !keepSecrets.includes(f.key)) throw new InstallError(400, 'field', `${f.label}: fill this in.`);
      delete out[f.key];
    }
    return { values: out, secrets: sec };
  }

  /** *Add and start* (or *Update*): the same code as PUT /api/mcp/:name, then Test. */
  async mcpApprove(reviewId: string, body: { values?: Record<string, unknown>; secrets?: Record<string, unknown>; trust?: boolean }): Promise<{ server: string; status: string; tools: string[]; test: { ok: boolean; text: string } }> {
    const s = staged.get(reviewId);
    if (!s || s.review.expires < Date.now()) throw new InstallError(404, 'expired', 'That review has expired. Press Get again.');
    const { review, recipe } = s;
    if (review.needsTrust && body.trust !== true) throw new InstallError(400, 'trust', "Tick “I trust this tool server's author” to add it.");
    const app = this.d.app;
    const name = review.serverName;
    const cur = mcpSecrets(app.vault, name);
    const kept = [...Object.keys(cur.env ?? {}), ...Object.keys(cur.headers ?? {})];
    const { values, secrets } = this.#checkValues(recipe, body.values ?? {}, body.secrets ?? {}, review.mode === 'update' ? kept : [], review.mode === 'update' ? (review.saved ?? {}) : {});
    const cfg = this.configFrom(recipe, name, { ...Object.fromEntries(Object.entries(cur.env ?? {})), ...values, ...secrets });
    // Fields and secrets live where Sara keeps a server's environment today: the vault (mcp:<name>).
    const env = recipe.transport === 'stdio' ? { ...values, ...secrets } : {};
    const headers: Record<string, string> = {};
    if (recipe.transport === 'http') for (const f of [...recipe.secrets, ...recipe.fields.filter((x) => x.kind === 'secret')]) if (secrets[f.key]) headers[f.header ?? f.key] = `${f.prefix ?? ''}${secrets[f.key]}`;
    app.vault.set(mcpVaultKey(name), JSON.stringify({ env: mergeSecrets(cur.env, env), headers: mergeSecrets(cur.headers, headers) }));
    const servers = (app.settings.get().mcpServers ?? []).filter((x) => x.name !== name).concat(cfg);
    app.settings.update({ mcpServers: servers });
    staged.delete(reviewId);
    const at = this.#now().toISOString();
    const row = this.d.installs.get(review.item);
    this.d.installs.upsert({ item: review.item, kind: 'mcp', version: review.version, trust: review.trust, local_ref: name, content_sha: null, entry_sha: s.entrySha, recipe: JSON.stringify({ ...recipe, version: review.version }), prev_recipe: row?.kind === 'mcp' && row.version !== review.version ? row.recipe : (row?.prev_recipe ?? null), installed_at: row?.installed_at ?? at, updated_at: at });
    const test = await this.test(name);
    this.#toolAdvice(name, recipe);
    const conn = app.mcp?.get(name);
    return { server: name, status: conn?.status ?? 'stopped', tools: conn?.tools.map((t) => t.name) ?? [], test };
  }

  /** *Test*: start it and ask for its tools (initialize + tools/list), at most 30 s; said in words. */
  async test(name: string): Promise<{ ok: boolean; text: string }> {
    const app = this.d.app;
    const cfg = (app.settings.get().mcpServers ?? []).find((x) => x.name === name);
    if (!cfg || !app.mcp) return { ok: false, text: 'It is not set up on this server.' };
    const ms = this.d.testMs ?? TEST_MS;
    let timer: NodeJS.Timeout | undefined;
    const conn = await Promise.race([app.mcp.start(cfg).catch(() => app.mcp?.get(name)), new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
    clearTimeout(timer);
    const c = conn ?? app.mcp.get(name);
    if (c?.status === 'ready') return { ok: true, text: c.tools.length === 1 ? 'It answered with 1 tool.' : `It answered with ${c.tools.length} tools.` };
    return { ok: false, text: `It didn't answer${c?.error ? `: ${c.error.slice(0, 200).replace(/[.\s]+$/, '')}` : ' within 30 seconds'}. Check what it needs, then press Test again.` };
  }

  /** The recipe's tested advice, only where the server's own annotations agree or say nothing (§6.5). */
  #toolAdvice(name: string, recipe: McpRecipe): void {
    const app = this.d.app;
    const conn = app.mcp?.get(name);
    if (!conn?.tools.length) return;
    const perms = { ...(app.settings.get().toolPermissions ?? {}) };
    for (const t of conn.tools as { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]) {
      const key = mcpToolName(name, t.name);
      if (perms[key]) continue;
      const a = t.annotations;
      if (recipe.tools.readOnly.includes(t.name) && a?.readOnlyHint !== false && a?.destructiveHint !== true) perms[key] = 'auto';
      else if (recipe.tools.ask.includes(t.name) && a?.readOnlyHint !== true) perms[key] = 'ask';
    }
    app.settings.update({ toolPermissions: perms });
  }

  // ---- update, go back, remove, override ----

  #pluginAuthority(item: string): void {
    const association = this.d.installs.get(item);
    const source = pluginInstallation(this.d.plugins, item, association);
    if (source.installHeld) throw new InstallError(409, 'source', source.installHeld);
    try { this.d.plugins?.assertStoreAuthority(item, association?.content_sha ?? undefined); }
    catch (err) { throw new InstallError(409, 'source', (err as Error).message); }
  }

  /** *Update*: the same download and review as *Get*; never applied without the owner's yes. */
  async update(item: string, o: { community?: boolean; understand?: boolean } = {}): ReturnType<StoreInstaller['install']> {
    const row = this.d.installs.get(item);
    if (!row) throw new InstallError(404, 'missing', 'That add-on was not installed from the store.');
    if (row.kind === 'plugin') this.#pluginAuthority(item);
    if (row.state === 'blocked') throw new InstallError(403, 'blocked', 'The Sara store blocked this add-on.');
    return this.install(item, { ...o, understand: true, community: o.community ?? row.trust === 'community' });
  }

  async goBack(item: string): Promise<StoreInstallRow> {
    const row = this.d.installs.get(item);
    if (!row) throw new InstallError(404, 'missing', 'That add-on was not installed from the store.');
    const at = this.#now().toISOString();
    if (row.kind === 'plugin') {
      this.#pluginAuthority(item);
      const pm = this.d.plugins;
      if (!pm) throw new InstallError(409, 'plugins', "Plugins aren't available on this server.");
      if (this.d.installs.db !== pm.store.db) throw new InstallError(409, 'source', 'The plugin store association is unavailable. Try again later.');
      await pm.rollback(row.local_ref, { onCommitted: p => {
        const current = this.d.installs.get(item);
        if (!current || current.kind !== 'plugin' || current.local_ref !== row.local_ref || current.version !== row.version || current.content_sha !== row.content_sha) throw new InstallError(409, 'source', 'The saved store association changed. Review the installed plugin again.');
        const index = this.d.client.current()?.index;
        const block = index?.blocked.find(b => (b.id === item && (b.versions === '*' || b.versions.includes(p.version))) || b.contentShas?.includes(p.approved_sha));
        if (block) throw new InstallError(403, 'blocked', 'The Sara store blocked this add-on.');
        const restored = this.d.client.version(item, p.version);
        if (!restored || restored.item.kind !== 'plugin' || restored.v.contentSha !== p.approved_sha) throw new InstallError(409, 'source', 'The earlier plugin does not match a verified store release. Use its Plugins card to roll back.');
        this.d.installs.upsert({ ...current, version: p.version, trust: restored.item.trust, content_sha: p.approved_sha, entry_sha: restored.v.entrySha, updated_at: this.#now().toISOString(), state: restored.v.yanked ? 'yanked' : 'ok', state_note: restored.v.yanked ?? null });
      } });
    } else if (row.kind === 'mcp') {
      if (!row.prev_recipe) throw new InstallError(409, 'none', 'There is no earlier version to go back to.');
      // The kept recipe carries the version it came with (not a recipe field).
      const { version: _pv, ...prevRaw } = JSON.parse(row.prev_recipe) as Record<string, unknown>;
      void _pv;
      const prev = parseRecipe(prevRaw);
      const cfg = this.configFrom(prev, row.local_ref, mcpSecrets(this.d.app.vault, row.local_ref).env ?? {});
      this.d.app.settings.update({ mcpServers: (this.d.app.settings.get().mcpServers ?? []).filter((x) => x.name !== row.local_ref).concat(cfg) });
      await this.d.app.mcp?.start(cfg).catch(() => undefined);
      const v = (JSON.parse(row.prev_recipe) as { version?: string }).version;
      this.d.installs.upsert({ ...row, version: v ?? row.version, recipe: row.prev_recipe, prev_recipe: row.recipe, updated_at: at });
    } else if (row.kind === 'companion') throw new InstallError(409, 'companion', 'A companion goes back from her row in Settings → Her → Companions.');
    else throw new InstallError(409, 'skill', 'A skill goes back from its own page (Versions).');
    return this.d.installs.get(item)!;
  }

  async remove(item: string): Promise<void> {
    const row = this.d.installs.get(item);
    if (!row) throw new InstallError(404, 'missing', 'That add-on was not installed from the store.');
    const app = this.d.app;
    if (row.kind === 'plugin') {
      const plugins = this.d.plugins;
      const local = plugins?.store.get(row.local_ref);
      if (plugins && local && row.local_ref === row.item && local.approved_sha === row.content_sha && local.version === row.version) {
        await plugins.remove(row.local_ref);
        if (plugins.store.get(row.local_ref)) return;
        app.hooks?.removeForPlugin(row.local_ref);
      }
    } else if (row.kind === 'skill') {
      const [scope, name] = splitRef(row.local_ref);
      app.skills?.delete(scope, name);
    } else if (row.kind === 'companion') {
      throw new InstallError(409, 'companion', 'A companion goes with Retire her (Settings → Her → Companions).');
    } else {
      app.mcp?.stop(row.local_ref);
      app.settings.update({ mcpServers: (app.settings.get().mcpServers ?? []).filter((x) => x.name !== row.local_ref) });
      app.vault.delete(mcpVaultKey(row.local_ref));
    }
    this.d.installs.delete(item);
  }

  /** §10.3 for skills and tool servers (plugins: PluginManager.storeBlock). Nothing is deleted. */
  async blockOther(row: StoreInstallRow, reason: string): Promise<void> {
    const app = this.d.app;
    if (row.kind === 'skill') {
      const [scope, name] = splitRef(row.local_ref);
      if (app.skills?.get(scope, name)) {
        app.skills.setSwitches(scope, name, { enabled: false });
        (app.skills as unknown as { db?: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db?.prepare(`UPDATE skills SET status = 'needs-review' WHERE scope = ? AND name = ?`).run(scope, name);
      }
    } else if (row.kind === 'mcp') {
      app.mcp?.stop(row.local_ref);
      app.settings.update({ mcpServers: (app.settings.get().mcpServers ?? []).map((x) => (x.name === row.local_ref ? { ...x, enabled: false } : x)) });
    } else if (row.kind === 'companion') {
      // PACKS.md §11.2: she is paused with the reason (never deleted); a minors reason removes her pictures at once.
      this.d.packs?.block(row.local_ref, reason, /\b(minor|minors|underage|child|children)\b/i.test(reason));
    }
    void reason;
  }

  /** *Switch it on anyway* after the confirm: logged, and the block isn't applied again. */
  async override(item: string, confirm: boolean): Promise<StoreInstallRow> {
    const row = this.d.installs.get(item);
    if (!row) throw new InstallError(404, 'missing', 'That add-on was not installed from the store.');
    if (row.state !== 'blocked') throw new InstallError(409, 'state', 'It was not pulled from the store.');
    if (!confirm) throw new InstallError(400, 'confirm', 'The Sara team found a serious problem with this add-on. Switch it on anyway?');
    const app = this.d.app;
    if (row.kind === 'plugin') {
      const pm = this.d.plugins;
      const local = pm?.store.get(row.local_ref);
      if (!pm || !local || row.local_ref !== row.item || local.approved_sha !== row.content_sha || local.version !== row.version) throw new InstallError(409, 'source', 'The saved store association no longer matches the installed plugin.');
      if (local) {
        pm.overrideStoreBlock(row.local_ref);
        pm.store.log(row.local_ref, null, 'log', OVERRIDE_NOTE);
      }
    } else if (row.kind === 'skill') {
      const [scope, name] = splitRef(row.local_ref);
      if (app.skills?.get(scope, name)) {
        (app.skills as unknown as { db?: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db?.prepare(`UPDATE skills SET status = 'ready' WHERE scope = ? AND name = ? AND status = 'needs-review'`).run(scope, name);
        app.skills.setSwitches(scope, name, { enabled: true });
      }
    } else {
      const servers = (app.settings.get().mcpServers ?? []).map((x) => (x.name === row.local_ref ? { ...x, enabled: true } : x));
      app.settings.update({ mcpServers: servers });
      const cfg = servers.find((x) => x.name === row.local_ref);
      if (cfg) await app.mcp?.start(cfg).catch(() => undefined);
    }
    console.warn(`store: ${item} ${OVERRIDE_NOTE}`);
    this.d.installs.setState(item, 'blocked', `${row.state_note ?? ''}`.slice(0, 400), this.#now().toISOString());
    this.d.client.markApplied(`override:${item}`);
    return this.d.installs.get(item)!;
  }
}

export const splitRef = (ref: string): [string, string] => {
  const i = ref.lastIndexOf('/');
  return [ref.slice(0, i), ref.slice(i + 1)];
};

/** An MCP update in marked lines (§8.5): command or package version, new fields, new secrets, tools now running on their own. */
export function recipeDiff(a: McpRecipe, b: McpRecipe): string[] {
  const out: string[] = [];
  const pkg = (r: McpRecipe) => (r.transport === 'stdio' ? [r.command, ...(r.args ?? [])].join(' ') : (r.url ?? ''));
  if (pkg(a) !== pkg(b)) {
    const spec = (r: McpRecipe) => (r.args ?? []).find((x) => /@\d|==\d|@sha256:/.test(x));
    const sa = spec(a);
    const sb = spec(b);
    out.push(sa && sb && sa !== sb ? `Now runs ${sb} instead of ${sa}` : `Now runs: ${pkg(b)}`);
  }
  for (const f of b.fields) if (!a.fields.some((x) => x.key === f.key)) out.push(`Asks for something new: ${f.label}`);
  for (const f of b.secrets) if (!a.secrets.some((x) => x.key === f.key)) out.push(`A new secret for the vault: ${f.label}`);
  for (const t of b.tools.readOnly) if (a.tools.ask.includes(t)) out.push(`${t} now runs on its own (it asked you before)`);
  for (const r of b.reaches) if (!a.reaches.includes(r)) out.push(`Now reaches: ${r}`);
  return out;
}

/** The permission lines an item page shows, computed by Sara (never from the index's list). */
export function entryLines(entry: StoreEntry, saraVersion: string): { lines: PermissionLine[]; error?: string } {
  if (entry.kind === 'plugin' && entry.manifest) {
    try {
      return { lines: permissionLines(parseManifest(JSON.stringify(entry.manifest), { saraVersion })) };
    } catch (err) {
      return { lines: [], error: (err as Error).message };
    }
  }
  if (entry.kind === 'mcp' && entry.mcp) {
    const r = parseRecipe(entry.mcp);
    const lines: PermissionLine[] = [];
    if (r.transport === 'stdio') lines.push({ id: 'run', key: 'Runs a program on this computer: {command}', params: { command: [r.command, ...(r.args ?? [])].join(' ') }, risk: 'high' } as PermissionLine);
    else lines.push({ id: 'url', key: 'Talks to {url}', params: { url: r.url ?? '' }, risk: 'medium' } as PermissionLine);
    for (const x of r.reaches) lines.push({ id: 'reaches', key: 'Reaches: {what}', params: { what: x }, risk: 'medium' } as PermissionLine);
    for (const f of [...r.fields, ...r.secrets]) lines.push({ id: `field:${f.key}`, key: f.kind === 'secret' || r.secrets.includes(f) ? 'Asks you for: {label} (kept in the vault)' : 'Asks you for: {label}', params: { label: f.label }, risk: 'low' } as PermissionLine);
    return { lines };
  }
  if (entry.kind === 'skill') {
    const m = { ...((entry.manifest ?? {}) as { 'allowed-tools'?: string[] }), scripts: entry.scripts };
    const lines: PermissionLine[] = [{ id: 'skill', key: 'Steps she follows when they fit what you ask', params: {}, risk: 'low' } as PermissionLine];
    if (m['allowed-tools']?.length) lines.push({ id: 'tools', key: 'Uses: {tools}', params: { tools: m['allowed-tools'].join(', ') }, risk: 'medium' } as PermissionLine);
    if (m.scripts) lines.push({ id: 'scripts', key: 'Has scripts: each run asks you first', params: {}, risk: 'medium' } as PermissionLine);
    return { lines };
  }
  return { lines: [] };
}
