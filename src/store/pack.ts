// Phase 125 (2.58.0, SARA_STORE.md §9.1–§9.3, K4): `sara pack`, *Check it* in *Submit yours*, and the
// hub's checker all run this: find what the folder is (a plugin, a skill or a tool-server recipe),
// run every check of checks.ts plus the fenced smoke test, and build the package that is sent (the
// whole folder, screenshots and CHANGES.md included, as a stored zip). The report says *ready* only
// with no failures. Nothing here touches the network.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fromFolder, fromZip, hashFiles, PackageError, stripTop, type PackageFile } from '../packages.ts';
import { MANIFEST_FILE } from '../plugins/manifest.ts';
import type { Fence } from '../plugins/runtime.ts';
import { parseSkill } from '../skills.ts';
import { zipStored } from '../zip-write.ts';
import { checkPlugin, checkRecipe, checkSkill, RECIPE_MAX_BYTES, splitListing, STORE_PLUGIN_LIMITS, type CheckResult, type PackReport } from './checks.ts';
import type { StoreIndex, StoreKind } from './format.ts';
import { smokeTest } from './smoke.ts';
import { sha256 } from './verify.ts';

export const RECIPE_FILE = 'sara-mcp.json';
export interface PackOptions {
  saraVersion: string;
  index?: StoreIndex;
  authorKey?: string;
  /** The fence for the smoke test (false: skip it, and the report says so). */
  smoke?: Fence | false;
  scratch?: string;
  dataDirs?: readonly string[];
  /** A skill's store id when the folder name isn't it. */
  id?: string;
  readyMs?: number;
  watchMs?: number;
}
export interface Pack {
  report: PackReport & { contentSha?: string; fence?: string; smoke?: 'ran' | 'skipped' };
  zip: Buffer;
  sha256: string;
  size: number;
}

/** What a folder (or an unpacked zip) is, by the file at its top. */
export function kindOf(files: readonly PackageFile[]): StoreKind | undefined {
  const { files: inner } = stripTop([...files]);
  if (inner.some((f) => f.path === MANIFEST_FILE)) return 'plugin';
  if (inner.some((f) => f.path === 'SKILL.md')) return 'skill';
  if (inner.some((f) => f.path === RECIPE_FILE)) return 'mcp';
  return undefined;
}

const failed = (kind: StoreKind | 'unknown', why: string): Pack['report'] => ({ kind: kind === 'unknown' ? 'plugin' : kind, id: 'unknown', version: '', name: '', ready: false, results: [{ id: 'limits', ok: false, warnings: [], problems: [why] }] });

/** The checks of files already read (a folder, a zip, or the checker's package). */
export async function packFiles(files: PackageFile[], o: PackOptions, folderName = ''): Promise<Pack> {
  const { files: inner } = stripTop(files);
  const kind = kindOf(inner);
  const zip = zipStored(inner.map((f) => ({ path: f.path, data: f.data })));
  const out = (report: Pack['report']): Pack => ({ report, zip, sha256: sha256(zip), size: zip.length });
  if (!kind) return out(failed('unknown', `There is no ${MANIFEST_FILE}, SKILL.md or ${RECIPE_FILE} at the top of it, so Sara can't tell what it is.`));
  if (kind === 'plugin') {
    const report: Pack['report'] = checkPlugin(inner, { saraVersion: o.saraVersion, ...(o.index ? { index: o.index } : {}), ...(o.authorKey ? { authorKey: o.authorKey } : {}) });
    const { pkg } = splitListing(inner);
    const packaged = pkg.filter((f) => f.path !== 'CHANGES.md' && f.path !== 'icon.png');
    report.contentSha = hashFiles(packaged);
    if (report.manifest && o.smoke !== false) {
      const s = await smokeTest(packaged, report.manifest, { fence: o.smoke ?? 'node-only', ...(o.scratch ? { scratch: o.scratch } : {}), ...(o.readyMs ? { readyMs: o.readyMs } : {}), ...(o.watchMs !== undefined ? { watchMs: o.watchMs } : {}) });
      const r: CheckResult = { id: 'smoke', ok: s.ok, warnings: s.warnings, problems: s.problems };
      report.results.splice(report.results.findIndex((x) => x.id === 'shots'), 0, r);
      report.fence = s.fence;
      report.smoke = 'ran';
    } else if (report.manifest) {
      report.results.push({ id: 'smoke', ok: true, warnings: ['The smoke test was skipped here.'], problems: [] });
      report.smoke = 'skipped';
    }
    report.ready = report.results.every((r) => r.ok);
    return out(report);
  }
  if (kind === 'skill') {
    const md = inner.find((f) => f.path === 'SKILL.md')!;
    const guess = o.id ?? parseSkill(folderName || 'skill', md.data.toString('utf8')).meta?.name ?? folderName;
    const meta = parseSkill(guess, md.data.toString('utf8')).meta as { metadata?: Record<string, unknown> } | undefined;
    const version = typeof meta?.metadata?.version === 'string' ? meta.metadata.version : '1.0.0';
    const report: Pack['report'] = checkSkill(inner, { id: guess, version, ...(o.index ? { index: o.index } : {}), ...(o.authorKey ? { authorKey: o.authorKey } : {}) });
    const { pkg } = splitListing(inner);
    report.contentSha = hashFiles(pkg.filter((f) => f.path !== 'CHANGES.md' && f.path !== 'icon.png'));
    return out(report);
  }
  const file = inner.find((f) => f.path === RECIPE_FILE)!;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(file.data.toString('utf8')) as Record<string, unknown>;
  } catch {
    return out(failed('mcp', `${RECIPE_FILE} isn't valid JSON.`));
  }
  const shots = inner.filter((f) => f.path.startsWith('shots/'));
  const report: Pack['report'] = checkRecipe({ id: String(rec.id ?? ''), version: String(rec.version ?? ''), name: String(rec.name ?? ''), description: String(rec.description ?? ''), ...(Array.isArray(rec.changes) ? { changes: rec.changes.map(String) } : {}), mcp: rec.mcp, bytes: file.data.length }, shots, { ...(o.dataDirs ? { dataDirs: o.dataDirs } : {}), ...(o.index ? { index: o.index } : {}), ...(o.authorKey ? { authorKey: o.authorKey } : {}) });
  if (file.data.length > RECIPE_MAX_BYTES) report.ready = false;
  // A tool server is started on the author's computer by pressing Test after installing it; our checker has no network.
  report.results.push({ id: 'smoke', ok: true, warnings: ['Tool servers are not started by the checks: press Test after installing it.'], problems: [] });
  report.smoke = 'skipped';
  return out(report);
}

/** `sara pack <folder>` (or a .zip): read it with the store's limits; links and oversize files fail plainly. */
export async function packPath(path: string, o: PackOptions): Promise<Pack> {
  let files: PackageFile[];
  try {
    files = /\.zip$/i.test(path) ? fromZip(readFileSync(path), STORE_PLUGIN_LIMITS) : fromFolder(path, STORE_PLUGIN_LIMITS);
  } catch (err) {
    const why = err instanceof PackageError ? err.message : (err as Error).message;
    const zip = Buffer.alloc(0);
    return { report: failed('unknown', why), zip, sha256: sha256(zip), size: 0 };
  }
  return packFiles(files, o, basename(path).replace(/\.zip$/i, ''));
}

/** The report in words, for the terminal (✓ / ⚠ / ✗ and the reason under each ✗). */
export function reportText(r: Pack['report']): string {
  const out = [`${r.name || r.id} ${r.version} (${r.kind})`];
  for (const x of r.results) {
    out.push(`${x.ok ? (x.warnings.length ? '⚠' : '✓') : '✗'} ${x.id}`);
    for (const p of x.problems) out.push(`    ${p}`);
    for (const w of x.warnings) out.push(`    ⚠ ${w}`);
  }
  if (r.lines?.length) out.push('What it can do:', ...r.lines.map((l) => `  · ${l.key.replace(/\{(\w+)\}/g, (_m, k: string) => String(l.params?.[k] ?? ''))}`));
  out.push(r.ready ? 'Ready to submit.' : 'Not ready: fix the ✗ lines, then check again.');
  return out.join('\n');
}
