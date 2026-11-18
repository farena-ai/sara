// V0.7 + V0.9 (docs/STORE_LISTINGS.md, docs/NPM_PUBLISH.md): the browser extension made ready for the
// Chrome Web Store, Edge Add-ons and Firefox Add-ons (per-store zips + a source zip, the Firefox
// manifest, store texts in six languages, permission justifications, the privacy page, store pictures)
// and the SDK made ready for npm as @farena-ai/sara-sdk. Nothing here publishes anything.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const EXT = join(ROOT, 'extension');
const readJson = (...p: string[]) => JSON.parse(readFileSync(join(...p), 'utf8'));
const LOCALES = ['en', 'es', 'fr', 'de', 'pt_BR', 'it'];
const pack = () => import(pathToFileURL(join(ROOT, 'scripts', 'pack-extension.ts')).href);

/** Names + contents of a zip (central directory walk; stored or deflated entries). */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'zip end record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nl + xl + cl;
  }
  return out;
}

test('per-store manifests: Edge = Chrome (service worker), Firefox gets gecko id, data consent and scripts', async () => {
  const { buildManifest, GECKO_ID } = await pack();
  const base = readJson(EXT, 'manifest.json');
  const version = readJson(ROOT, 'package.json').version;
  const chrome = buildManifest(base, 'chrome', version);
  const edge = buildManifest(base, 'edge', version);
  const ff = buildManifest(base, 'firefox', version);
  assert.deepEqual(edge, chrome, 'Edge uses the Chrome build as is');
  for (const m of [chrome, ff]) assert.equal(m.version, version, 'version from package.json');
  assert.equal(chrome.background.service_worker, 'background.js');
  assert.equal(chrome.background.scripts, undefined);
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.deepEqual(ff.background, { scripts: ['background.js'], type: 'module' });
  const g = ff.browser_specific_settings.gecko;
  assert.equal(g.id, GECKO_ID);
  assert.match(g.id, /^[\w.-]+@[\w.-]+$/);
  assert.equal(g.strict_min_version, '140.0', 'built-in data consent needs Firefox 140');
  assert.deepEqual([...g.data_collection_permissions.required].sort(), ['browsingActivity', 'websiteContent']);
  assert.equal(ff.browser_specific_settings.gecko_android.strict_min_version, '142.0', 'web-ext lint: Android got the key in 142');
  // Same least-privilege permissions in every build.
  for (const m of [chrome, ff]) {
    assert.deepEqual([...m.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'storage']);
    assert.equal(m.host_permissions, undefined);
    assert.deepEqual(m.optional_host_permissions, ['http://*/*', 'https://*/*']);
  }
  // The source manifest stays browser-neutral; the store name is the long one, the button the short one.
  assert.equal(base.name, '__MSG_extName__');
  assert.equal(base.action.default_title, '__MSG_appName__');
});

test('store texts in six languages fit each store (name, summary, long description)', () => {
  const en = readJson(EXT, '_locales', 'en', 'messages.json');
  for (const loc of LOCALES) {
    const m = readJson(EXT, '_locales', loc, 'messages.json');
    const name = m.extName.message as string, desc = m.appDesc.message as string, long = m.storeDescription.message as string;
    assert.ok(name.length <= 45, `${loc} name fits Chrome (75) and AMO (50): ${name.length}`);
    assert.ok(desc.length <= 132, `${loc} summary fits Chrome's 132: ${desc.length}`);
    assert.ok(long.length >= 250 && long.length <= 10000, `${loc} long text fits Edge (250-10000): ${long.length}`);
    assert.match(long, /Sara/);
    assert.doesNotMatch(long, /\$\d/, `${loc}: no placeholders in store text`);
    if (loc !== 'en') {
      assert.notEqual(long, en.storeDescription.message, `${loc} long text translated`);
      assert.notEqual(desc, en.appDesc.message, `${loc} summary translated`);
    }
  }
});

test('pack-extension writes sara-chrome/edge/firefox zips, a source zip for AMO and the listing texts', async () => {
  const { packAll } = await pack();
  const out = mkdtempSync(join(tmpdir(), 'v0stores-'));
  try {
    const version = readJson(ROOT, 'package.json').version;
    const files: string[] = packAll(out);
    const names = files.map((f) => f.split(/[\\/]/).pop()).sort();
    for (const n of [`sara-chrome-${version}.zip`, `sara-edge-${version}.zip`, `sara-firefox-${version}.zip`, `sara-extension-source-${version}.zip`]) assert.ok(names.includes(n), n);
    const chrome = unzip(readFileSync(join(out, `sara-chrome-${version}.zip`)));
    const edge = unzip(readFileSync(join(out, `sara-edge-${version}.zip`)));
    const ff = unzip(readFileSync(join(out, `sara-firefox-${version}.zip`)));
    assert.deepEqual([...edge.keys()].sort(), [...chrome.keys()].sort());
    assert.equal(edge.get('manifest.json')!.toString(), chrome.get('manifest.json')!.toString());
    assert.ok(chrome.has('manifest.json') && chrome.has('_locales/pt_BR/messages.json') && chrome.has('icons/icon128.png'));
    assert.ok(![...chrome.keys()].some((k) => /\.md$|\.test\.|^\./.test(k)), 'no notes or tests in a store zip');
    assert.equal(JSON.parse(ff.get('manifest.json')!.toString()).browser_specific_settings.gecko.data_collection_permissions.required.length, 2);
    assert.equal(JSON.parse(chrome.get('manifest.json')!.toString()).version, version);
    const src = unzip(readFileSync(join(out, `sara-extension-source-${version}.zip`)));
    for (const k of ['extension/manifest.json', 'extension/popup.js', 'scripts/pack-extension.ts', 'src/zip-write.ts', 'BUILD.md']) assert.ok(src.has(k), `source zip has ${k}`);
    const build = src.get('BUILD.md')!.toString();
    assert.match(build, /node scripts\/pack-extension\.ts/);
    assert.match(build, /no build step|not minified|not transpiled/i);
    // Copy-paste listing texts per language.
    for (const loc of LOCALES) {
      const txt = readFileSync(join(out, 'listing', `${loc}.txt`), 'utf8');
      assert.ok(txt.includes(readJson(EXT, '_locales', loc, 'messages.json').storeDescription.message), loc);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('docs/STORE_LISTINGS.md: every permission justified, each store step by step, the privacy page is public', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'STORE_LISTINGS.md'), 'utf8');
  const m = readJson(EXT, 'manifest.json');
  for (const p of [...m.permissions, ...m.optional_host_permissions]) assert.ok(doc.includes(`\`${p}\``), `justification for ${p}`);
  for (const w of ['Chrome Web Store', 'Edge Add-ons', 'Firefox Add-ons', '$5', 'Single purpose', 'Remote code', 'sara-chrome-', 'sara-edge-', 'sara-firefox-', 'sara-extension-source-', '1280x800', '440x280', 'docs/store/extension/', 'EXTENSION_PRIVACY.md', 'never publish', 'data_collection_permissions', 'Productivity']) assert.ok(doc.includes(w), w);
  const priv = readFileSync(join(ROOT, 'docs', 'EXTENSION_PRIVACY.md'), 'utf8');
  for (const w of ['your own Sara', 'No analytics', 'password', 'Disconnect', 'children', 'Contact']) assert.ok(priv.toLowerCase().includes(w.toLowerCase()), w);
  assert.doesNotMatch(priv, /backstagecoding\.com\/sara\b|\bfaren\b|FrankWeather|[A-Z]:\\Users/i, 'public-safe');
  assert.match(doc, /https:\/\/github\.com\/farena-ai\/sara\/blob\/main\/docs\/EXTENSION_PRIVACY\.md/);
});

test('store pictures exist at the sizes the stores ask for', () => {
  const dir = join(ROOT, 'docs', 'store', 'extension');
  const size = (f: string) => { const b = readFileSync(join(dir, f)); assert.equal(b.readUInt32BE(0), 0x89504e47, f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const f of ['screenshot-1-ask.png', 'screenshot-2-fill.png', 'screenshot-3-pair.png']) assert.deepEqual(size(f), [1280, 800], f);
  assert.deepEqual(size('promo-640x400.png'), [640, 400]);
  assert.deepEqual(size('promo-440x280.png'), [440, 280]);
  assert.deepEqual(size('logo-300.png'), [300, 300]);
});

// ------------------------------------------------------------------ the npm SDK
const PKG = join(ROOT, 'packages', 'sara-sdk');

test('SDK package.json is ready for npm as @farena-ai/sara-sdk', () => {
  const pkg = readJson(PKG, 'package.json');
  assert.equal(pkg.name, '@farena-ai/sara-sdk');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.license, 'MIT');
  assert.ok(existsSync(join(PKG, 'LICENSE')));
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.deepEqual(pkg.files, ['dist/', 'examples/']);
  assert.equal(pkg.repository.url, 'git+https://github.com/farena-ai/sara.git');
  assert.equal(pkg.repository.directory, 'packages/sara-sdk');
  assert.match(pkg.homepage, /^https:\/\/github\.com\/farena-ai\/sara\//);
  assert.match(pkg.bugs.url, /^https:\/\/github\.com\/farena-ai\/sara\/issues/);
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.private, undefined, 'not private');
  assert.match(pkg.scripts.prepublishOnly, /tsc/);
  const readme = readFileSync(join(PKG, 'README.md'), 'utf8');
  assert.match(readme, /npm install @farena-ai\/sara-sdk/);
  assert.match(readme, /from '@farena-ai\/sara-sdk'/);
  assert.doesNotMatch(readme, /from 'sara-sdk'|FrankWeather/);
  for (const f of ['responses.mjs', 'stream-and-approve.mjs']) assert.match(readFileSync(join(PKG, 'examples', f), 'utf8'), /from '@farena-ai\/sara-sdk'/, f);
});

test('docs/NPM_PUBLISH.md walks the owner through account, 2FA, org, login and publish (never run by agents)', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'NPM_PUBLISH.md'), 'utf8');
  for (const w of ['https://www.npmjs.com/signup', '2FA', 'farena-ai', 'npm login', 'npm publish --access public', 'packages/sara-sdk', 'npm pack --dry-run', 'send back', 'free']) assert.ok(doc.includes(w), w);
});

test('npm pack --dry-run is clean: dist, examples, README, LICENSE and package.json only', (t) => {
  const NODE = process.execPath;
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  // Release servers install without dev tools (no TypeScript): the pack check runs where they exist.
  if (!existsSync(tsc)) { t.skip('typescript is not installed here'); return; }
  rmSync(join(PKG, 'dist'), { recursive: true, force: true });
  execFileSync(NODE, [tsc, '-p', join(PKG, 'tsconfig.json')], { stdio: 'pipe' });
  const npmCli = join(NODE, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packed = JSON.parse(execFileSync(NODE, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PKG, encoding: 'utf8' }))[0];
  assert.equal(packed.name, '@farena-ai/sara-sdk');
  const files = packed.files.map((f: { path: string }) => f.path).sort();
  assert.ok(files.every((f: string) => /^(dist|examples)\//.test(f) || ['LICENSE', 'README.md', 'package.json'].includes(f)), files.join(', '));
  assert.ok(files.includes('dist/index.d.ts') && files.includes('examples/responses.mjs'));
  assert.ok(!files.some((f: string) => /\.tsbuildinfo$|^src\//.test(f)));
});
