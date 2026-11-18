// U4.25 (docs/EXTENSION.md): packs extension/ into two zips for loading or for a store upload later.
// It is NOT published anywhere: publishing is the owner's decision (Chrome Web Store has a fee; the
// Edge and Firefox stores are free but need an account).
//   node scripts/pack-extension.ts [--out <dir>]
// Output (gitignored): outputs/extension/sara-extension-chrome-edge-<version>.zip and
// outputs/extension/sara-extension-firefox-<version>.zip. Chrome/Edge use extension/manifest.json
// as is; Firefox gets background.scripts and its add-on id instead of the service worker.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipStored, type ZipFileIn } from '../src/zip-write.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_DIR = join(ROOT, 'extension');
export const GECKO_ID = 'sara-extension@backstagecoding.com';
export type Target = 'chrome' | 'firefox';

type Manifest = Record<string, unknown> & { background?: Record<string, unknown> };

/** The manifest for one browser family. */
export function buildManifest(base: Manifest, target: Target): Manifest {
  const m: Manifest = JSON.parse(JSON.stringify(base));
  if (target === 'firefox') {
    m.background = { scripts: ['background.js'], type: 'module' };
    m.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: '128.0' } };
  }
  return m;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** The files of one zip (manifest rewritten per browser; no tests, notes or dot files). */
export function packFiles(target: Target): ZipFileIn[] {
  const base = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')) as Manifest;
  const files: ZipFileIn[] = [];
  for (const p of listFiles(EXT_DIR)) {
    const rel = relative(EXT_DIR, p).split(sep).join('/');
    if (/(^|\/)\.|\.test\.|README|\.md$/i.test(rel)) continue;
    files.push({ path: rel, data: rel === 'manifest.json' ? Buffer.from(`${JSON.stringify(buildManifest(base, target), null, 2)}\n`) : readFileSync(p) });
  }
  return files;
}

function main(): void {
  const i = process.argv.indexOf('--out');
  const out = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]!) : join(ROOT, 'outputs', 'extension');
  const version = (JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')) as { version: string }).version;
  mkdirSync(out, { recursive: true });
  for (const [target, label] of [['chrome', 'chrome-edge'], ['firefox', 'firefox']] as const) {
    const file = join(out, `sara-extension-${label}-${version}.zip`);
    writeFileSync(file, zipStored(packFiles(target), { deflate: true }));
    console.log(file);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
