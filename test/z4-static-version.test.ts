// Z4: the page points at /v/<id>/… for its scripts and stylesheets, and those answers may be kept by
// the browser without asking again. A changed file gives a new id. (src/static-version.ts)
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { cacheFor, resetWebBuildIds, staticModules, VERSIONED_PATH, versionPage, webBuildId } from '../src/static-version.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-23T12:00:00Z') });
  const server = createSaraServer({ app, auth: new OwnerAuth(dir), webDir: join(ROOT, 'web') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('Z4 version: the id follows the files, and only scripts and stylesheets', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;');
  writeFileSync(join(dir, 'sub', 'b.css'), 'b{}');
  writeFileSync(join(dir, 'pic.jpg'), 'x');
  resetWebBuildIds();
  const one = webBuildId(dir, [], 0);
  assert.match(one, /^[a-f0-9]{12}$/);
  assert.equal(webBuildId(dir, [], 10_000), one, 'nothing changed');
  writeFileSync(join(dir, 'pic.jpg'), 'a different picture');
  assert.equal(webBuildId(dir, [], 20_000), one, 'a picture is not part of it');
  writeFileSync(join(dir, 'sub', 'b.css'), 'b{color:red}');
  const two = webBuildId(dir, [], 30_000);
  assert.notEqual(two, one, 'a stylesheet changed');
  assert.equal(webBuildId(dir, [], 31_000), two, 'trusted for a moment without looking again');
  // Same size, a new time: still a new id (an edit that keeps the length).
  utimesSync(join(dir, 'a.js'), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
  const three = webBuildId(dir, [], 40_000);
  assert.notEqual(three, two);
  // A file from outside the folder that the page also loads (identity.js comes from src/identity.ts).
  const outside = join(dir, 'pic.jpg');
  assert.notEqual(webBuildId(dir, [outside], 50_000), three);
});

test('Z4 version: the page is pointed at /v/<id>/ for its own scripts and stylesheets only', () => {
  const html = [
    '<link rel="stylesheet" href="/style.css" />',
    '<link rel="stylesheet" href="/vendor/x/y.css">',
    '<link rel="icon" href="/app-icon.png?s=64" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<script src="/theme-boot.js"></script>',
    '<script type="module" src="/app.js"></script>',
    '<script src="https://example.com/x.js"></script>',
    '<script src="//example.com/x.js"></script>',
    '<a href="/help">Help</a>',
  ].join('\n');
  const out = versionPage(html, 'abc123abc123');
  assert.ok(out.includes('href="/v/abc123abc123/style.css"'));
  assert.ok(out.includes('href="/v/abc123abc123/vendor/x/y.css"'));
  assert.ok(out.includes('src="/v/abc123abc123/theme-boot.js"'));
  assert.ok(out.includes('<script type="module" src="/v/abc123abc123/app.js">'));
  for (const same of ['href="/app-icon.png?s=64"', 'href="/manifest.webmanifest"', 'src="https://example.com/x.js"', 'src="//example.com/x.js"', '<a href="/help">']) assert.ok(out.includes(same), same);
  assert.equal(versionPage(out, 'abc123abc123'), out, 'doing it twice changes nothing');
  assert.ok(VERSIONED_PATH.test('/v/abc123abc123/vendor/three-vrm/sara-vrm.js'));
  for (const no of ['/v/abc123abc123/../secret.js', '/v/abc123abc123/sara/face.json', '/v/abc123abc123/sara-portrait.jpg', '/v/x/app.js', '/v/abc123abc123/a%2e%2e/b.js']) assert.ok(!VERSIONED_PATH.test(no), no);
  assert.match(cacheFor(true), /immutable/);
  assert.equal(cacheFor(false), 'no-cache');
});

test('Z4 version: what a module loads when it starts, named in the page so it is fetched at once', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'app.js'), `import { a } from './a.js';
import {
  b,
  c,
} from './lib/b.js';
import './side.js';
export { z } from './z.js';
import { id } from './identity.js';
import x from '../outside.js';
const later = () => import('./lazy.js');
import gone from './gone.js';
`);
  writeFileSync(join(dir, 'a.js'), `import { c } from './lib/c.js';
export const a = 1;`);
  writeFileSync(join(dir, 'lib', 'b.js'), `import { c } from './c.js';
import { a } from '../a.js';
export const b = 1;`);
  writeFileSync(join(dir, 'lib', 'c.js'), 'export const c = 1;');
  for (const f of ['side.js', 'z.js', 'lazy.js']) writeFileSync(join(dir, f), 'export const z = 1;');
  resetWebBuildIds();
  const mods = staticModules(dir, 'app.js', 'id1', ['identity.js']);
  assert.deepEqual([...mods].sort(), ['a.js', 'identity.js', 'lib/b.js', 'lib/c.js', 'side.js', 'z.js'], 'not the lazy one, not a missing one, nothing outside the folder');
  const html = `<head>
  <script type="module" src="/app.js"></script>
</head>`;
  const out = versionPage(html, 'abc123abc123', (entry) => staticModules(dir, entry, 'id1', ['identity.js']));
  assert.ok(out.includes('<link rel="modulepreload" href="/v/abc123abc123/lib/c.js" />'));
  assert.equal(out.match(/rel="modulepreload"/g)?.length, 6);
  assert.ok(!out.includes('modulepreload" href="/v/abc123abc123/app.js"'), 'the entry is the script tag itself');
  assert.ok(out.indexOf('modulepreload') < out.indexOf('</head>'));
  // Worked out once per id: a new file is seen with a new id.
  writeFileSync(join(dir, 'a.js'), `import './z.js';
import './lib/c.js';
import './new.js';`);
  writeFileSync(join(dir, 'new.js'), '');
  assert.ok(!staticModules(dir, 'app.js', 'id1').includes('new.js'));
  assert.ok(staticModules(dir, 'app.js', 'id2').includes('new.js'));
});

test('Z4 version: the real page, its files kept for good, the page itself still checked', async (t) => {
  const base = await rig(t);
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('cache-control'), 'no-cache', 'the page is asked for every time: it is what names the id');
  const html = await page.text();
  const id = /src="\/v\/([a-f0-9]{12})\/app\.js"/.exec(html)?.[1];
  assert.ok(id, 'the page points app.js at the id');
  assert.ok(!/<(?:script|link)\b[^>]*(?:src|href)="\/(?!v\/)[^"?]+\.(?:js|css)"/.test(html), 'no script or stylesheet of the page is left unversioned');
  // What app.js loads when it starts is named up front, and every one of those is there.
  const pre = [...html.matchAll(/<link rel="modulepreload" href="(\/v\/[a-f0-9]{12}\/[^"]+)" \/>/g)].map((m) => m[1]!);
  assert.ok(pre.length > 150, `${pre.length} modules named`);
  assert.equal(new Set(pre).size, pre.length);
  for (const p of [pre[0]!, pre[Math.floor(pre.length / 2)]!, pre.at(-1)!, pre.find((x) => x.endsWith('/identity.js'))!]) {
    const res: Response = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, p);
    await res.arrayBuffer();
  }
  // The page's ETag stands for the id too: a new id is a new page.
  assert.ok(page.headers.get('etag')?.includes(id));
  const again = await fetch(`${base}/`, { headers: { 'if-none-match': page.headers.get('etag')! } });
  assert.equal(again.status, 304);

  for (const file of ['app.js', 'style.css', 'vendor/three-vrm/sara-vrm.js', 'identity.js']) {
    const res: Response = await fetch(`${base}/v/${id}/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', file);
    const body = await res.text();
    if (file !== 'identity.js') assert.equal(body, readFileSync(join(ROOT, 'web', file), 'utf8'), file);
    else assert.match(body, /export /);
  }
  // The plain address still works and is still checked each time (other pages, old tabs, the service worker).
  const plain = await fetch(`${base}/app.js`);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  // An id that is not the current one (a tab left open across an update): today's file, not kept.
  const old = await fetch(`${base}/v/000000000000/app.js`);
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('cache-control'), 'no-cache');
  // Nothing but scripts and stylesheets lives there, and a missing one is missing (never the page).
  for (const no of [`/v/${id}/nope.js`, `/v/${id}/sara-portrait.jpg`, `/v/${id}/index.html`, `/v/${id}/..%2Fpackage.json`, `/v/${id}/i18n/es.json`]) {
    const res = await fetch(`${base}${no}`);
    assert.equal(res.status, 404, no);
    await res.arrayBuffer();
  }
  // The offline page keeps plain addresses: the service worker stores its files by those (web/sw.js).
  const offline = await (await fetch(`${base}/offline.html`)).text();
  assert.ok(!offline.includes('/v/'), 'offline.html is not rewritten');
});

test('Z4 version: nothing in the app loads a module by an absolute address', () => {
  // A module reached once as /v/<id>/x.js and once as /x.js is two copies with two states.
  const bad: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'vendor') walk(join(dir, e.name), `${rel}${e.name}/`);
      } else if (/\.(?:js|mjs)$/.test(e.name) && e.name !== 'sw.js') {
        const src = readFileSync(join(dir, e.name), 'utf8');
        for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"`])\/(?!\/)[^'"`]+\1/gm)) bad.push(`${rel}${e.name}: ${m[0]}`);
      }
    }
  };
  walk(join(ROOT, 'web'), '');
  assert.deepEqual(bad, []);
});
