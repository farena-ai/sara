// W3.1: `sara-addon build` and `sara-addon pack`. Build runs main.mjs once in a child process in
// build mode (defineAddon hands over the manifest instead of starting) and writes sara-plugin.json.
// Pack checks the folder with the store's rules, then writes the store bundle and a listing file:
//   out/<id>-<version>.sarapack.zip    the add-on as Sara's store reads it (sara pack / sara submit)
//   out/<id>-<version>.listing.json    what the listing shows: name, text, tools, settings, plain
//                                      permission lines, changes, screenshots, hashes, the checks
// Nothing is sent anywhere. Submitting to the Sara Store is the owner's own step on his Sara.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkManifest, permissionLines, type Manifest } from './kit.ts';
import { hashFiles, imageType, readAddonFiles, sha256, STORE_LIMITS, zipStored, type AddonFile } from './files.ts';
import { runtimeSource } from './runtime-source.ts';

export const MANIFEST_FILE = 'sara-plugin.json';

/** The main file: the one sara-plugin.json names, else main.mjs. */
export function mainOf(dir: string): string {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as { main?: unknown };
    if (typeof m.main === 'string' && /\.(mjs|js)$/.test(m.main)) return m.main;
  } catch {
    // none yet
  }
  return 'main.mjs';
}

/** Runs the add-on's code in build mode and returns its manifest (or the error it threw). */
export function manifestFromCode(dir: string, o: { node?: string } = {}): { manifest?: Manifest; error?: string } {
  const main = join(resolve(dir), mainOf(dir));
  if (!existsSync(main)) return { error: `There is no ${mainOf(dir)} in ${dir}.` };
  const code = `globalThis.__SARA_ADDON_BUILD__ = true;
try { await import(${JSON.stringify(pathToFileURL(main).href)}); }
catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(3); }
const m = globalThis.__SARA_ADDON__;
if (!m) { process.stderr.write('main never called defineAddon(...) from ./sara-addon.mjs.'); process.exit(3); }
process.stdout.write(JSON.stringify(m));`;
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(o.node ?? process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 2000) };
  try {
    return { manifest: JSON.parse(r.stdout) as Manifest };
  } catch {
    return { error: 'The build printed something that is not a manifest (does main.mjs write to stdout?).' };
  }
}

export const manifestText = (m: Manifest): string => `${JSON.stringify(m, null, 2)}\n`;

/** `sara-addon build`: writes sara-plugin.json from the code (`check`: only says whether it's current). */
export function buildAddon(dir: string, o: { check?: boolean } = {}): { code: number; lines: string[]; manifest?: Manifest } {
  const r = manifestFromCode(dir);
  if (!r.manifest) return { code: 1, lines: [`✗ ${r.error}`] };
  const want = manifestText(r.manifest);
  const path = join(dir, MANIFEST_FILE);
  const have = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (have === want) return { code: 0, lines: [`✓ ${MANIFEST_FILE} is current (${r.manifest.id} ${r.manifest.version}).`], manifest: r.manifest };
  if (o.check) return { code: 1, lines: [`✗ ${MANIFEST_FILE} is out of date: run sara-addon build.`], manifest: r.manifest };
  writeFileSync(path, want);
  return { code: 0, lines: [`✓ Wrote ${MANIFEST_FILE} (${r.manifest.id} ${r.manifest.version}).`], manifest: r.manifest };
}

/** Key-shaped strings the store refuses (a light copy of the host's scan; the host's own check runs with --sara). */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an OpenAI-style key', /\bsk-[A-Za-z0-9_-]{32,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

export interface Check {
  id: string;
  ok: boolean;
  problems: string[];
  warnings: string[];
}
const check = (id: string, problems: string[], warnings: string[] = []): Check => ({ id, ok: problems.length === 0, problems, warnings });

/** The store's rules for a plugin folder (src/store/checks.ts checkPlugin), without Sara. */
export function storeChecks(files: readonly AddonFile[], m: Manifest | undefined, buildError?: string, sdkVersion = ''): Check[] {
  const shots = files.filter((f) => f.path.startsWith('shots/'));
  const pkg = files.filter((f) => !f.path.startsWith('shots/'));
  const out: Check[] = [];
  const total = pkg.reduce((n, f) => n + f.data.length, 0);
  out.push(check('limits', [...(pkg.length > STORE_LIMITS.maxFiles ? [`More than ${STORE_LIMITS.maxFiles} files.`] : []), ...(total > STORE_LIMITS.maxTotalBytes ? ['More than 10 MB in all.'] : []), ...pkg.filter((f) => f.data.length > STORE_LIMITS.maxFileBytes).map((f) => `${f.path} is bigger than 5 MB.`)]));
  out.push(check('manifest', buildError ? [buildError] : m ? checkManifest(m, { files: pkg.map((f) => f.path) }) : ['There is no manifest.']));
  const secrets: string[] = [];
  for (const f of pkg) {
    if (f.path === 'sara-plugin.mjs' || f.path === 'sara-addon.mjs') continue;
    const text = f.data.toString('utf8');
    for (const [what, re] of SECRET_PATTERNS) if (re.test(text)) secrets.push(`${f.path} has what looks like ${what}: remove it (settings of type secret are for keys).`);
  }
  out.push(check('secrets', secrets));
  const sp: string[] = [];
  if (!shots.length) sp.push('Add at least one screenshot (shots/, PNG, JPEG or WebP).');
  if (shots.length > 5) sp.push('At most 5 screenshots.');
  for (const s of shots) {
    if (!imageType(s.data)) sp.push(`${s.path} is not a PNG, JPEG or WebP picture.`);
    if (s.data.length > 1024 * 1024) sp.push(`${s.path} is bigger than 1 MB.`);
  }
  out.push(check('shots', sp));
  const lp: string[] = [];
  const d = (m?.description ?? '').trim();
  if (d.length < 20 || d.length > 300) lp.push('The description should be 20 to 300 characters.');
  const changes = files.find((f) => f.path === 'CHANGES.md')?.data.toString('utf8');
  const esc = (m?.version ?? '').replace(/\./g, '\\.');
  if (!changes || !new RegExp(`(^|\\n)#*\\s*\\[?v?${esc}\\]?(\\s|$)`).test(changes)) lp.push(`CHANGES.md doesn't say what's new in ${m?.version ?? 'this version'}.`);
  out.push(check('listing', lp));
  const rt = files.find((f) => f.path === 'sara-addon.mjs');
  const kitWarn = rt && sdkVersion && rt.data.toString('utf8') !== runtimeSource(sdkVersion) ? ['sara-addon.mjs is from another kit version: run sara-addon update.'] : [];
  out.push(check('kit', [], kitWarn));
  return out;
}

/** The part of CHANGES.md about one version (up to the next heading of the same level). */
export function changesFor(text: string | undefined, version: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const esc = version.replace(/\./g, '\\.');
  const start = lines.findIndex((l) => new RegExp(`^#+\\s*\\[?v?${esc}\\]?(\\s|$)`).test(l));
  if (start < 0) return '';
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim().slice(0, 4000);
}

export interface PackOutcome {
  code: number;
  ready: boolean;
  lines: string[];
  zipPath?: string;
  listingPath?: string;
  listing?: Record<string, unknown>;
}

/** `sara-addon pack [--sara <checkout>]`. */
export async function packAddon(dir: string, o: { sdkVersion: string; sara?: string; out?: string } = { sdkVersion: '' }): Promise<PackOutcome> {
  dir = resolve(dir);
  const lines: string[] = [];
  const built = buildAddon(dir);
  lines.push(...built.lines);
  const m = built.manifest;
  let files: AddonFile[];
  try {
    files = readAddonFiles(dir);
  } catch (err) {
    return { code: 1, ready: false, lines: [...lines, `✗ ${(err as Error).message}`] };
  }
  const checks = storeChecks(files, m, built.code ? built.lines.join(' ').replace(/^✗ /, '') : undefined, o.sdkVersion);
  let ready = checks.every((c) => c.ok);
  for (const c of checks) {
    lines.push(`${c.ok ? (c.warnings.length ? '⚠' : '✓') : '✗'} ${c.id}`);
    for (const p of c.problems) lines.push(`    ${p}`);
    for (const w of c.warnings) lines.push(`    ⚠ ${w}`);
  }
  if (!m) return { code: 1, ready: false, lines: [...lines, 'Not ready: fix the ✗ lines, then pack again.'] };
  const out = resolve(o.out ?? join(dir, 'out'));
  mkdirSync(out, { recursive: true });
  const base = `${m.id}-${m.version}`;
  const zip = zipStored(files);
  const zipPath = join(out, `${base}.sarapack.zip`);
  writeFileSync(zipPath, zip);
  const runtime = files.filter((f) => !f.path.startsWith('shots/') && f.path !== 'CHANGES.md' && f.path !== 'icon.png');
  const listing: Record<string, unknown> = {
    format: 'sara-addon-listing/1',
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    ...(m.author ? { author: m.author } : {}),
    ...(m.license ? { license: m.license } : {}),
    ...(m.homepage ? { homepage: m.homepage } : {}),
    sara: m.sara ?? '',
    tools: ((m.permissions.tools as string[] | undefined) ?? []).map((name) => ({ name, registeredAs: `${m.id.replace(/-/g, '_')}__${name}` })),
    settings: (m.settings ?? []).map((s) => ({ key: s.key, type: s.type, label: s.label, tip: s.tip })),
    permissions: permissionLines(m),
    changes: changesFor(files.find((f) => f.path === 'CHANGES.md')?.data.toString('utf8'), m.version),
    screenshots: files.filter((f) => f.path.startsWith('shots/')).map((f) => ({ path: f.path, bytes: f.data.length, sha256: sha256(f.data) })),
    bundle: { file: `${base}.sarapack.zip`, bytes: zip.length, sha256: sha256(zip) },
    contentSha: hashFiles(runtime),
    checks,
    ready,
    madeWith: `@farena-ai/sara-sdk ${o.sdkVersion}`.trim(),
    submit: "Nothing was sent. Submitting to the Sara Store is the owner's own step on his Sara: sara submit <folder> --name \"Your name\" (or Get more → Submit yours). The Sara team reviews it before anything is listed.",
  };
  if (o.sara) {
    const host = await hostReport(o.sara, zipPath);
    listing.host = host;
    lines.push(`${host.ready ? '✓' : '✗'} Sara ${host.sara}'s own store checks (sara pack, fenced smoke test${host.smoke === 'ran' ? '' : ' skipped'})`);
    for (const r of host.results) if (!r.ok) lines.push(...r.problems.map((p) => `    ${r.id}: ${p}`));
    if (!host.ready) ready = false;
    listing.ready = ready;
  }
  const listingPath = join(out, `${base}.listing.json`);
  writeFileSync(listingPath, `${JSON.stringify(listing, null, 2)}\n`);
  lines.push(`Wrote ${zipPath} (${zip.length} bytes, sha256 ${sha256(zip)})`, `  and ${listingPath}.`);
  lines.push(ready ? 'Ready for the store. Nothing was sent: to offer it, run `sara submit <folder> --name "Your name"` on your Sara (the owner\'s step).' : 'Not ready: fix the ✗ lines, then pack again.');
  return { code: ready ? 0 : 1, ready, lines, zipPath, listingPath, listing };
}

/** Sara's own `sara pack` checks on the bundle, from a checkout (src/store/pack.ts). */
async function hostReport(sara: string, zipPath: string): Promise<{ sara: string; ready: boolean; smoke?: string; contentSha?: string; results: Check[] }> {
  const root = resolve(sara);
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const mod = (await import(pathToFileURL(join(root, 'src', 'store', 'pack.ts')).href)) as { packPath: (p: string, o: Record<string, unknown>) => Promise<{ report: { ready: boolean; smoke?: string; contentSha?: string; results: Check[] } }> };
  const { report } = await mod.packPath(zipPath, { saraVersion: version, smoke: 'node-only' });
  return { sara: version, ready: report.ready, ...(report.smoke ? { smoke: report.smoke } : {}), ...(report.contentSha ? { contentSha: report.contentSha } : {}), results: report.results.map((r) => ({ id: r.id, ok: r.ok, problems: r.problems, warnings: r.warnings })) };
}
