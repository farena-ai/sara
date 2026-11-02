// Phase 124 (2.57.0, SARA_STORE.md §6.5, §9.2, K4): the store's checks, one piece of code for the
// author's computer (`sara pack`, Phase 125), the hub's checker and Sara's own install. This phase
// has every check except the fenced smoke test: limits, manifest (or SKILL.md, or the MCP recipe
// rules), id, permissions in words, secrets, scan findings, screenshots and the listing. The report
// says *ready* only with no failures; warnings stay on it for the reviewer.
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { scanPackage, stripTop, type PackageFile, type PackageLimits } from '../packages.ts';
import { MANIFEST_FILE, parseManifest, permissionLines, type PermissionLine, type PluginManifest } from '../plugins/manifest.ts';
import { KEY_SHAPED } from '../redact.ts';
import { BODY_TOKENS_ADVISED, estimateTokens, parseSkill, SKILL_NAME_RE } from '../skills.ts';
import { windowsCommand } from '../tools/mcp.ts';
import { parseRecipe, type McpRecipe, type StoreIndex, type StoreKind } from './format.ts';

export type CheckId = 'limits' | 'manifest' | 'id' | 'permissions' | 'secrets' | 'scan' | 'shots' | 'listing';
export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** Shown to the author and the reviewer, never a failure. */
  warnings: string[];
  /** Why it failed, in the same plain words the install would use. */
  problems: string[];
}
export interface PackReport {
  kind: StoreKind;
  id: string;
  version: string;
  name: string;
  ready: boolean;
  results: CheckResult[];
  /** Plugins: the permission lines (riskiest first), as the review card shows them. */
  lines?: PermissionLine[];
  manifest?: PluginManifest;
}

export const STORE_PLUGIN_LIMITS: PackageLimits = { maxZipBytes: 10 * 1024 * 1024, maxFiles: 500, maxTotalBytes: 10 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxDepth: 10 };
export const STORE_SKILL_LIMITS: PackageLimits = { maxZipBytes: 5 * 1024 * 1024, maxFiles: 300, maxTotalBytes: 5 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxDepth: 8 };
export const RECIPE_MAX_BYTES = 64 * 1024;
export const SHOT_MAX_BYTES = 1024 * 1024;
/** Commands a tool-server recipe may start (no shell is ever involved). */
export const RECIPE_COMMANDS = ['npx', 'uvx', 'docker', 'node'] as const;

const result = (id: CheckId, problems: string[] = [], warnings: string[] = []): CheckResult => ({ id, ok: problems.length === 0, warnings, problems });
const isText = (f: PackageFile) => !f.data.subarray(0, 8000).includes(0);

/** PNG, JPEG or WebP, by their first bytes (the name is not trusted). */
export function imageType(b: Uint8Array): 'png' | 'jpeg' | 'webp' | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp';
  return undefined;
}

/** The screenshots under shots/ (1–5 for plugins and tool servers, 0–5 for skills). */
export function checkShots(shots: readonly PackageFile[], min: number): CheckResult {
  const p: string[] = [];
  if (shots.length < min) p.push(min === 1 ? 'Add at least one screenshot (shots/, PNG, JPEG or WebP).' : `Add at least ${min} screenshots.`);
  if (shots.length > 5) p.push('At most 5 screenshots.');
  for (const s of shots) {
    if (!imageType(s.data)) p.push(`${s.path} is not a PNG, JPEG or WebP picture.`);
    if (s.data.length > SHOT_MAX_BYTES) p.push(`${s.path} is bigger than 1 MB.`);
  }
  return result('shots', p, shots.length ? [] : ['No screenshots: the page will show only words.']);
}

function checkLimits(files: readonly PackageFile[], lim: PackageLimits): CheckResult {
  const p: string[] = [];
  if (files.length > lim.maxFiles) p.push(`More than ${lim.maxFiles} files.`);
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > lim.maxTotalBytes) p.push(`More than ${Math.round(lim.maxTotalBytes / 1048576)} MB in all.`);
  for (const f of files) {
    if (f.data.length > lim.maxFileBytes) p.push(`${f.path} is bigger than ${Math.round(lim.maxFileBytes / 1048576)} MB.`);
    if (f.path.split('/').includes('..') || f.path.startsWith('/')) p.push(`${f.path} points outside its folder.`);
  }
  return result('limits', p);
}

/** Key-shaped strings, private-key blocks and .env files anywhere in the package. */
function checkSecrets(files: readonly PackageFile[]): CheckResult {
  const p: string[] = [];
  for (const f of scanPackage(files)) if (f.kind === 'secret') p.push(`${f.file} line ${f.line ?? '?'} looks like a key or password. Keys belong in a secret setting, never in the files.`);
  for (const f of files) {
    if (/(^|\/)\.env(\.|$)/.test(f.path)) p.push(`${f.path}: .env files can't be shared (they hold keys).`);
    if (isText(f) && KEY_SHAPED.some((re) => re.test(f.data.toString('utf8'))) && !p.some((x) => x.startsWith(f.path))) p.push(`${f.path} has something that looks like a key.`);
  }
  return result('secrets', [...new Set(p)]);
}

/** Injection tells and hosts the code talks to that the manifest doesn't declare fail; scripts and binaries are shown. */
function checkScan(files: readonly PackageFile[], hosts: readonly string[], allowInjection = false): CheckResult {
  const p: string[] = [];
  const w: string[] = [];
  const declared = (h: string) => hosts.some((x) => x === h || (x.startsWith('*.') && h.endsWith(x.slice(1))));
  for (const f of scanPackage(files)) {
    if (f.kind === 'injection') (allowInjection ? w : p).push(`${f.file} line ${f.line}: “${f.text}” reads like an order to her.`);
    else if (f.kind === 'egress' && f.host && !declared(f.host)) p.push(`${f.file} line ${f.line} talks to ${f.host}, which isn't in its permissions.`);
    else if (f.kind === 'script') w.push(`${f.file} is a script.`);
    else if (f.kind === 'binary') w.push(`${f.file} is not a text file.`);
  }
  return result('scan', [...new Set(p)], [...new Set(w)]);
}

function checkListing(description: string, o: { version: string; changes?: string; homepage?: string; needChanges: boolean }): CheckResult {
  const p: string[] = [];
  const d = description.trim();
  if (d.length < 20 || d.length > 300) p.push('The description should be 20 to 300 characters.');
  if (o.needChanges) {
    const esc = o.version.replace(/\./g, '\\.');
    if (!o.changes || !new RegExp(`(^|\\n)#*\\s*\\[?v?${esc}\\]?(\\s|$)`).test(o.changes)) p.push(`CHANGES.md doesn't say what's new in ${o.version}.`);
  }
  if (o.homepage !== undefined && !/^https:\/\//.test(o.homepage)) p.push('The homepage must be an https:// address.');
  return result('listing', p);
}

function checkId(id: string, kind: StoreKind, o: { index?: StoreIndex; authorKey?: string; firstParty?: boolean }): CheckResult {
  const p: string[] = [];
  const idx = o.index;
  if (idx) {
    if (idx.reservedIds.includes(id) && !o.firstParty) p.push(`“${id}” is a reserved name.`);
    const it = idx.items.find((x) => x.id === id);
    if (it && (it.kind !== kind || (o.authorKey && it.author.key !== o.authorKey))) p.push(`“${id}” is taken in the store by another add-on.`);
    if (idx.blocked.some((b) => b.id === id)) p.push(`“${id}” was blocked in the store.`);
  }
  return result('id', p);
}

/** The pieces of a plugin or skill folder a check reads (shots/ and CHANGES.md are not packaged). */
export function splitListing(files: readonly PackageFile[]): { pkg: PackageFile[]; shots: PackageFile[]; changes?: string; icon?: PackageFile } {
  const { files: inner } = stripTop([...files]);
  const shots = inner.filter((f) => f.path.startsWith('shots/'));
  const changesFile = inner.find((f) => f.path === 'CHANGES.md');
  const icon = inner.find((f) => f.path === 'icon.png');
  return { pkg: inner.filter((f) => !f.path.startsWith('shots/')), shots, ...(changesFile ? { changes: changesFile.data.toString('utf8') } : {}), ...(icon ? { icon } : {}) };
}

/** Every check of a plugin folder (§9.2) except the smoke test (Phase 125). */
export function checkPlugin(files: readonly PackageFile[], o: { saraVersion: string; index?: StoreIndex; authorKey?: string; firstParty?: boolean }): PackReport {
  const { pkg, shots, changes } = splitListing(files);
  const results: CheckResult[] = [checkLimits(pkg, STORE_PLUGIN_LIMITS)];
  const mf = pkg.find((f) => f.path === MANIFEST_FILE);
  let m: PluginManifest | undefined;
  try {
    if (!mf) throw new Error(`There is no ${MANIFEST_FILE} at the top of it, so it isn't a Sara plugin.`);
    m = parseManifest(mf.data.toString('utf8'), { saraVersion: o.saraVersion, files: pkg.map((f) => f.path) });
    const untipped = m.settings.filter((s) => !s.tip || s.tip.trim().length < 10);
    results.push(result('manifest', untipped.map((s) => `The setting “${s.label}” needs a ? tip (10 to 260 characters).`)));
  } catch (err) {
    results.push(result('manifest', [(err as Error).message]));
  }
  const id = m?.id ?? 'unknown';
  results.push(checkId(id, 'plugin', o));
  const lines = m ? permissionLines(m) : [];
  const risky = m ? [...(m.permissions.callTools.length ? ['It asks to use her tools (each call asks you).'] : []), ...(m.permissions.bridges.length ? ['It carries a chat app.'] : []), ...(m.permissions.model.callsPerDay ? ['It can ask her model questions.'] : []), ...(m.permissions.connect.length ? ['It opens network connections through Sara.'] : []), ...(m.permissions.network.some((h) => h.startsWith('*.')) ? ['It can reach every name under a domain.'] : []), ...(m.permissions.files.read.includes('workspace') ? ['It can read the workspace.'] : [])] : [];
  results.push(result('permissions', [], risky));
  results.push(checkSecrets(pkg));
  results.push(checkScan(pkg, m?.permissions.network ?? []));
  results.push(checkShots(shots, 1));
  results.push(checkListing(m?.description ?? '', { version: m?.version ?? '', changes, ...(m?.homepage !== undefined ? { homepage: m.homepage } : {}), needChanges: true }));
  return { kind: 'plugin', id, version: m?.version ?? '', name: m?.name ?? '', ready: results.every((r) => r.ok), results, lines, ...(m ? { manifest: m } : {}) };
}

/** Every check of a skill folder (§6.6). `id` is the store id (it must equal the skill's name). */
export function checkSkill(files: readonly PackageFile[], o: { id: string; version: string; index?: StoreIndex; authorKey?: string; firstParty?: boolean; reviewNotes?: string }): PackReport & { scripts: boolean; front?: Record<string, unknown> } {
  const { pkg, shots, changes } = splitListing(files);
  const results: CheckResult[] = [checkLimits(pkg, STORE_SKILL_LIMITS)];
  const md = pkg.find((f) => f.path === 'SKILL.md');
  const problems: string[] = [];
  const warnings: string[] = [];
  let name = o.id;
  let description = '';
  let front: Record<string, unknown> | undefined;
  if (!md) problems.push('There is no SKILL.md at the top of it, so it isn\'t a skill.');
  else {
    const parsed = parseSkill(o.id, md.data.toString('utf8'));
    for (const d of parsed.diagnostics) (d.level === 'error' ? problems : warnings).push(d.message);
    if (parsed.meta) {
      name = parsed.meta.name;
      description = parsed.meta.description;
      front = { name: parsed.meta.name, description: parsed.meta.description, ...(parsed.meta.compatibility ? { compatibility: parsed.meta.compatibility } : {}), ...(parsed.meta.allowedTools?.length ? { 'allowed-tools': parsed.meta.allowedTools } : {}) };
      if (!SKILL_NAME_RE.test(name) || name !== o.id) problems.push(`The skill's name must be “${o.id}” (its store id).`);
      if (estimateTokens(parsed.body) > BODY_TOKENS_ADVISED) warnings.push(`Its steps are longer than the advised ${BODY_TOKENS_ADVISED} tokens.`);
    }
  }
  results.push(result('manifest', problems, warnings));
  results.push(checkId(o.id, 'skill', o));
  const scripts = pkg.some((f) => f.path.startsWith('scripts/') || /\.(sh|ps1|py|js|mjs|ts|bat|cmd)$/i.test(f.path));
  results.push(result('permissions', [], scripts ? ['Has scripts: each run asks you first.'] : []));
  results.push(checkSecrets(pkg));
  // An injection tell blocks listing unless a reviewer explains it in review.notes.
  results.push(checkScan(pkg, [], Boolean(o.reviewNotes?.trim())));
  results.push(checkShots(shots, 0));
  results.push(checkListing(description, { version: o.version, changes, needChanges: false }));
  return { kind: 'skill', id: o.id, version: o.version, name, ready: results.every((r) => r.ok), results, scripts, ...(front ? { front } : {}) };
}

// ---------------------------------------------------------------------------------------------
// MCP recipes (§6.5)
// ---------------------------------------------------------------------------------------------

const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PY_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*==\d+(?:\.\d+){1,3}(?:[a-z]+\d+)?$/;
const GIT_FROM = /^git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const TEMPLATE = /\$\{([^}]*)\}/g;
/** docker run flags that take a value (so the image is the first word after them). */
const DOCKER_VALUE_FLAGS = new Set(['-e', '--env', '-v', '--volume', '--name', '-w', '--workdir', '--user', '-u', '--entrypoint', '--network', '--net', '--mount', '-p', '--publish', '--memory', '-m', '--cpus', '--env-file', '--label', '-l']);
const firstPlain = (args: readonly string[], valueFlags: ReadonlySet<string> = new Set()): number => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return i;
  }
  return -1;
};

/** True when a folder is the data folder, inside it, or the whole disk. */
export function badFolder(path: string, dataDirs: readonly string[]): boolean {
  const p = path.trim();
  if (!p) return false;
  if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/' || p === '\\') return true;
  if (!isAbsolute(p) && !win32.isAbsolute(p)) return false;
  const norm = (x: string) => resolve(x).replace(/\\/g, '/').toLowerCase();
  return dataDirs.some((d) => {
    const rel = relative(norm(d), norm(p));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * The §6.5 rules for one recipe, as plain reasons (empty = it passes). `dataDirs`: Sara's data and
 * vault folders on this computer (a folder field may not point into them).
 */
export function recipeProblems(raw: unknown, o: { dataDirs?: readonly string[] } = {}): string[] {
  let r: McpRecipe;
  try {
    r = parseRecipe(raw);
  } catch (err) {
    return [(err as Error).message];
  }
  const p: string[] = [];
  const keys = new Set([...r.fields, ...r.secrets].map((f) => f.key));
  const folderKeys = new Set(r.fields.filter((f) => f.kind === 'folder').map((f) => f.key));
  const templates = (s: string, what: string) => {
    for (const m of s.matchAll(TEMPLATE)) {
      const t = m[1];
      if (t === 'home') continue;
      if (t.startsWith('setting:') && keys.has(t.slice(8))) continue;
      p.push(`${what}: “\${${t}}” isn't allowed (only \${setting:<field>} and \${home}).`);
    }
    if (/\$(?!\{)/.test(s.replace(TEMPLATE, ''))) p.push(`${what}: a lone $ isn't allowed.`);
  };
  if (r.transport === 'http') {
    let u: URL | undefined;
    try {
      u = new URL(r.url!.replace(TEMPLATE, 'x'));
    } catch {
      p.push("The server's address isn't a URL.");
    }
    if (u) {
      const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port !== '';
      if (u.protocol !== 'https:' && !local) p.push('An http server must use https:// (or http://127.0.0.1 with a port for an app on this computer).');
      if (u.username || u.password) p.push('No user name or password in the address: use a secret field.');
    }
    templates(r.url!, 'url');
  } else {
    const cmd = r.command!;
    const args = r.args ?? [];
    if (isAbsolute(cmd) || win32.isAbsolute(cmd) || /[\\/]/.test(cmd)) p.push('The command must be a name (npx, uvx, docker or node), not a path.');
    else if (/\.(cmd|bat)$/i.test(cmd)) p.push(`On Windows, “${cmd}” is a .cmd script, which Sara starts without a shell. Use npx, uvx, docker or node.`);
    else if (!(RECIPE_COMMANDS as readonly string[]).includes(cmd)) p.push(`“${cmd}” can't start a store tool server (only npx, uvx, docker or node; never a shell).`);
    args.forEach((a, i) => templates(a, `args[${i}]`));
    if (cmd === 'npx') {
      if (!args.includes('-y') && !args.includes('--yes')) p.push('npx needs -y (so it never stops to ask).');
      if (args.some((a) => ['-p', '--package', '-c', '--call'].includes(a))) p.push('npx may name one package only (no -p or -c).');
      const i = firstPlain(args);
      const specs = args.filter((a) => !a.startsWith('-') && /@/.test(a) && !a.startsWith('${'));
      if (i < 0 || !NPM_SPEC.test(args[i])) p.push('npx must name one package with an exact version, like name@1.4.2 (no ranges, no latest).');
      else if (specs.filter((s) => NPM_SPEC.test(s) || /@(latest|next|\^|~|\*|>|x)/i.test(s)).length > 1) p.push('npx must name exactly one package.');
    } else if (cmd === 'uvx') {
      const from = args.indexOf('--from');
      if (from >= 0) {
        if (!GIT_FROM.test(args[from + 1] ?? '')) p.push('uvx --from must be git+https://github.com/<owner>/<repo>@<40-character commit>.');
      } else {
        const i = firstPlain(args);
        if (i < 0 || !PY_SPEC.test(args[i])) p.push('uvx must name the package with an exact version, like name==1.4.2.');
      }
    } else if (cmd === 'docker') {
      if (args[0] !== 'run') p.push('docker must be “docker run”.');
      if (!args.includes('--rm') || !args.includes('-i')) p.push('docker run needs --rm and -i.');
      if (args.includes('--privileged') || args.some((a) => a.startsWith('--cap-add') || a.startsWith('--device'))) p.push('docker may not use --privileged, --cap-add or --device.');
      args.forEach((a, i) => {
        const next = args[i + 1] ?? '';
        if (((a === '--network' || a === '--net') && next === 'host') || /^--(network|net)=host$/.test(a)) p.push('docker may not use --network host.');
        if ((a === '--pid' || a === '--ipc') && next === 'host') p.push(`docker may not use ${a} host.`);
        if (a === '-v' || a === '--volume' || a.startsWith('--volume=') || a === '--mount') {
          const v = a.startsWith('--volume=') ? a.slice(9) : next;
          const src = v.split(':')[0];
          const ok = src.startsWith('${home}') || [...folderKeys].some((k) => src === `\${setting:${k}}`);
          if (a === '--mount' || !ok) p.push("docker may only share the server's own folder (${home}) or a folder field.");
        }
      });
      const rest = args.slice(1);
      const i = firstPlain(rest, DOCKER_VALUE_FLAGS);
      if (i < 0 || !DIGEST.test(rest[i])) p.push('docker must name its image by digest (image@sha256:…).');
    } else if (cmd === 'node') {
      if (!args.length || !/^\$\{home\}[\\/]/.test(args[0])) p.push('node may only run a script inside the server\'s own folder (${home}/…).');
      if (args.some((a) => /^(-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader)(=|$)/.test(a))) p.push('node may not run code from its arguments (-e, --eval, -p, --require, --import).');
    }
  }
  const dataDirs = o.dataDirs ?? [];
  for (const f of r.fields) if (f.kind === 'folder' && f.default && badFolder(f.default.replace(TEMPLATE, ''), dataDirs)) p.push(`${f.label}: Pick a folder of its own, not all of this computer.`);
  for (const f of [...r.fields, ...r.secrets]) if (f.default) templates(f.default, f.key);
  const tool = /^[A-Za-z0-9_.-]{1,64}$/;
  for (const t of [...r.tools.readOnly, ...r.tools.ask]) if (!tool.test(t)) p.push(`“${t}” is not a tool name.`);
  if (r.tools.readOnly.some((t) => r.tools.ask.includes(t))) p.push('A tool is listed as both read-only and ask.');
  return [...new Set(p)];
}

/**
 * The exact program and arguments as the card shows them; on Windows `npx` runs as
 * `node <npm>/bin/npx-cli.js …` (windowsCommand, 2.55.2) and `uvx`/`docker` resolve to their .exe.
 */
export function recipeCommand(r: McpRecipe, o: { platform?: NodeJS.Platform; pathVar?: string; nodeExe?: string } = {}): { command: string; args: string[] } | undefined {
  if (r.transport !== 'stdio' || !r.command) return undefined;
  const [command, args] = windowsCommand(r.command, r.args ?? [], o.pathVar ?? process.env.PATH, o.platform ?? process.platform, o.nodeExe ?? process.execPath);
  return { command, args };
}

/** Every check of a tool-server recipe file (`store/mcp/<id>.json`, or a `sara-mcp.json`). */
export function checkRecipe(file: { id: string; version: string; name: string; description: string; changes?: string[]; mcp: unknown; bytes?: number }, shots: readonly PackageFile[], o: { dataDirs?: readonly string[]; index?: StoreIndex; authorKey?: string; firstParty?: boolean } = {}): PackReport {
  const results: CheckResult[] = [result('limits', (file.bytes ?? 0) > RECIPE_MAX_BYTES ? ['The recipe is bigger than 64 KB.'] : [])];
  const problems = recipeProblems(file.mcp, o);
  results.push(result('manifest', problems));
  results.push(checkId(file.id, 'mcp', o));
  let reaches: string[] = [];
  try {
    const r = parseRecipe(file.mcp);
    reaches = [...r.reaches.map((x) => `Reaches: ${x}`), ...r.needs.map((x) => `Needs: ${x}`)];
    const secretDefaults = [...r.fields, ...r.secrets].filter((f) => f.default && KEY_SHAPED.some((re) => re.test(f.default!)));
    results.push(result('secrets', secretDefaults.map((f) => `${f.label}: its default looks like a key.`)));
  } catch {
    results.push(result('secrets'));
  }
  results.push(result('permissions', [], reaches));
  results.push(result('scan'));
  results.push(checkShots(shots, 1));
  results.push(checkListing(file.description, { version: file.version, needChanges: false }));
  if (!file.changes?.length) results[results.length - 1].problems.push(`Say what's new in ${file.version} (changes).`), (results[results.length - 1].ok = false);
  return { kind: 'mcp', id: file.id, version: file.version, name: file.name, ready: results.every((r) => r.ok), results };
}

/** The checks of a report as the entry's `checks.results` (ok + the first reason). */
export const reportResults = (r: PackReport): { id: string; ok: boolean; note?: string }[] => r.results.map((x) => ({ id: x.id, ok: x.ok, ...(x.problems[0] ? { note: x.problems[0].slice(0, 300) } : x.warnings[0] ? { note: x.warnings[0].slice(0, 300) } : {}) }));
