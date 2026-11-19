// U4.25 + V0.7 (docs/EXTENSION.md, docs/STORE_LISTINGS.md): packs extension/ into one zip per store,
// a source zip for Firefox Add-ons review and the copy-paste listing texts. It is NOT published
// anywhere: uploading is the owner's step (docs/STORE_LISTINGS.md).
//   node scripts/pack-extension.ts [--out <dir>]
// Output (gitignored), version = package.json's:
//   outputs/extension/sara-chrome-<v>.zip   Chrome Web Store (service worker)
//   outputs/extension/sara-edge-<v>.zip     Edge Add-ons (the Chrome build, the same files)
//   outputs/extension/sara-firefox-<v>.zip  Firefox Add-ons (background scripts, gecko id, data consent)
//   outputs/extension/sara-extension-source-<v>.zip  what AMO reviewers may ask for (+ BUILD.md)
//   outputs/extension/listing/<locale>.txt  name, summary and long description per language
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipStored, type ZipFileIn } from '../src/zip-write.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXT_DIR = join(ROOT, 'extension');
export const GECKO_ID = 'sara-extension@backstagecoding.com';
export type Target = 'chrome' | 'edge' | 'firefox';
export const TARGETS: readonly Target[] = ['chrome', 'edge', 'firefox'];
export const LOCALES = ['en', 'es', 'fr', 'de', 'pt_BR', 'it'] as const;

type Manifest = Record<string, unknown> & { background?: Record<string, unknown> };

export const appVersion = (): string => (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/**
 * The manifest for one store. Chrome and Edge run the background as a service worker; Firefox runs
 * it as a background script (Firefox has no MV3 service workers) and needs its add-on id and the
 * built-in data consent list (required for new AMO add-ons; shown at install). What is sent: the
 * page's text and address (websiteContent, browsingActivity) and, for Watch me do this, the steps you
 * showed it (websiteActivity), only to the person's own Sara.
 */
export function buildManifest(base: Manifest, target: Target, version?: string): Manifest {
  const m: Manifest = JSON.parse(JSON.stringify(base));
  if (version) m.version = version;
  if (target === 'firefox') {
    m.background = { scripts: ['background.js'], type: 'module' };
    m.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['websiteContent', 'browsingActivity', 'websiteActivity'] } },
      // Listed for desktop Firefox only (no right-click menus on Android); 142 is where Android
      // gained the data consent key, so web-ext lint stays clean.
      gecko_android: { strict_min_version: '142.0' },
    };
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

const skip = (rel: string) => /(^|\/)\.|\.test\.|README|\.md$/i.test(rel);

/** The files of one store zip (manifest rewritten per store; no tests, notes or dot files). */
export function packFiles(target: Target, version = appVersion()): ZipFileIn[] {
  const base = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')) as Manifest;
  const files: ZipFileIn[] = [];
  for (const p of listFiles(EXT_DIR)) {
    const rel = relative(EXT_DIR, p).split(sep).join('/');
    if (skip(rel)) continue;
    files.push({ path: rel, data: rel === 'manifest.json' ? Buffer.from(`${JSON.stringify(buildManifest(base, target, version), null, 2)}\n`) : readFileSync(p) });
  }
  return files;
}

const BUILD_MD = (v: string) => `# Sara browser extension ${v}: source for review

The extension has no build step: the files in \`extension/\` are the shipped files, not minified,
not transpiled and not bundled; there is no remote code. The store zips are made by one script that
copies those files and writes a per-browser \`manifest.json\` (Firefox: \`background.scripts\`, the
gecko id and \`data_collection_permissions\`; Chrome and Edge: the background service worker) with
the version from \`package.json\`.

To rebuild the exact zips (Node.js 24 or newer, nothing to install):

    node scripts/pack-extension.ts --out out

\`scripts/pack-extension.ts\` uses \`src/zip-write.ts\` (a small zip writer on Node's built-in zlib).
The result is \`out/sara-firefox-${v}.zip\` (plus the Chrome and Edge zips) with the same files as
the uploaded one.

What it does: docs/EXTENSION.md. Privacy: docs/EXTENSION_PRIVACY.md.
`;

/** The source zip for a Firefox Add-ons review: the extension folder, the packer and how to run it. */
export function sourceFiles(version = appVersion()): ZipFileIn[] {
  const files: ZipFileIn[] = [{ path: 'BUILD.md', data: Buffer.from(BUILD_MD(version)) }];
  for (const p of listFiles(EXT_DIR)) files.push({ path: `extension/${relative(EXT_DIR, p).split(sep).join('/')}`, data: readFileSync(p) });
  for (const f of ['scripts/pack-extension.ts', 'src/zip-write.ts', 'package.json', 'LICENSE', 'docs/EXTENSION.md', 'docs/EXTENSION_PRIVACY.md']) {
    try {
      files.push({ path: f, data: readFileSync(join(ROOT, f)) });
    } catch {
      /* optional file missing in a partial checkout */
    }
  }
  return files;
}

/** Name, summary and long description of one language, ready to paste into a store form. */
export function listingText(locale: (typeof LOCALES)[number]): string {
  const m = JSON.parse(readFileSync(join(EXT_DIR, '_locales', locale, 'messages.json'), 'utf8')) as Record<string, { message: string }>;
  return [`Name:\n${m.extName!.message}`, `Summary / short description:\n${m.appDesc!.message}`, `Description:\n${m.storeDescription!.message}`, ''].join('\n\n');
}

/** Writes every zip and the listing texts into `out`; returns the zip paths. */
export function packAll(out: string, version = appVersion()): string[] {
  mkdirSync(join(out, 'listing'), { recursive: true });
  const made: string[] = [];
  for (const target of TARGETS) {
    const file = join(out, `sara-${target}-${version}.zip`);
    writeFileSync(file, zipStored(packFiles(target, version), { deflate: true }));
    made.push(file);
  }
  const src = join(out, `sara-extension-source-${version}.zip`);
  writeFileSync(src, zipStored(sourceFiles(version), { deflate: true }));
  made.push(src);
  for (const loc of LOCALES) writeFileSync(join(out, 'listing', `${loc}.txt`), listingText(loc));
  return made;
}

function main(): void {
  const i = process.argv.indexOf('--out');
  const out = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]!) : join(ROOT, 'outputs', 'extension');
  for (const f of packAll(out)) console.log(f);
  console.log(join(out, 'listing'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
