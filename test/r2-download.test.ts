// R2 (/download, web/download-os.js, src/download.ts): OS detection, release asset mapping from a
// fixture of GitHub's answer, the cache, and the public page (no sign-in).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createReleaseCache, RELEASE_CACHE_MS } from '../src/download.ts';
import { createSaraServer } from '../src/server.ts';
import { detectOs, PLAY_STORE, primaryLink, releaseAssets, RELEASES_PAGE } from '../web/download-os.js';
import { makeApp, ROOT, tempDir } from './helpers.ts';

export const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};

// The shape of https://api.github.com/repos/farena-ai/sara/releases/latest (trimmed, invented sizes).
const FIXTURE = {
  tag_name: 'v3.10.0',
  html_url: 'https://github.com/farena-ai/sara/releases/tag/v3.10.0',
  assets: [
    { name: 'SHA256SUMS', browser_download_url: 'https://github.com/farena-ai/sara/releases/download/v3.10.0/SHA256SUMS', size: 512 },
    { name: 'Sara-Setup-3.10.0.exe', browser_download_url: 'https://github.com/farena-ai/sara/releases/download/v3.10.0/Sara-Setup-3.10.0.exe', size: 98_000_000 },
    { name: 'Sara-3.10.0.dmg', browser_download_url: 'https://github.com/farena-ai/sara/releases/download/v3.10.0/Sara-3.10.0.dmg', size: 110_000_000 },
    { name: 'get-sara.sh', browser_download_url: 'https://github.com/farena-ai/sara/releases/download/v3.10.0/get-sara.sh', size: 40_000 },
    { name: 'sara-3.10.0.tar.gz', browser_download_url: 'https://github.com/farena-ai/sara/releases/download/v3.10.0/sara-3.10.0.tar.gz', size: 30_000_000 },
    { name: 'sara-vscode-1.4.0.vsix', browser_download_url: 'https://github.com/farena-ai/sara/releases/download/v3.10.0/sara-vscode-1.4.0.vsix', size: 90_000 },
  ],
};

test('R2 download: the right system from the user agent (iPads that say Macintosh are iPhones here)', () => {
  for (const [os, ua] of Object.entries(UA)) assert.equal(detectOs(ua), os, os);
  assert.equal(detectOs(UA.mac, 5), 'iphone', 'an iPad asking for the desktop site');
  assert.equal(detectOs(''), 'windows');
  assert.equal(detectOs('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)'), 'linux');
});

test('R2 download: release assets map to one installer per system', () => {
  const a = releaseAssets(FIXTURE);
  assert.equal(a.version, '3.10.0');
  assert.equal(a.windows?.name, 'Sara-Setup-3.10.0.exe');
  assert.equal(a.mac?.name, 'Sara-3.10.0.dmg');
  assert.equal(a.linux?.name, 'get-sara.sh');
  assert.equal(a.source?.name, 'sara-3.10.0.tar.gz');
  assert.equal(a.android, null);
  assert.equal(primaryLink('windows', a), FIXTURE.assets[1].browser_download_url);
  assert.equal(primaryLink('mac', a), FIXTURE.assets[2].browser_download_url);
  assert.equal(primaryLink('android', a), PLAY_STORE);
  assert.equal(primaryLink('iphone', a), '');
  // A release without a Mac build links the release page, never a wrong file.
  const noMac = releaseAssets({ ...FIXTURE, assets: FIXTURE.assets.filter((x) => !x.name.endsWith('.dmg')) });
  assert.equal(noMac.mac, null);
  assert.equal(primaryLink('mac', noMac), FIXTURE.html_url);
  assert.equal(primaryLink('windows', releaseAssets(null)), RELEASES_PAGE);
});

test('R2 download: GitHub is asked at most once an hour; a failure keeps the last good answer', async () => {
  let now = 1_000_000;
  let calls = 0;
  let fail = false;
  const cache = createReleaseCache({
    now: () => now,
    fetch: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    },
  });
  const [x, y] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(calls, 1);
  assert.equal(x.ok, true);
  assert.equal(y.assets.windows?.name, 'Sara-Setup-3.10.0.exe');
  now += RELEASE_CACHE_MS - 1;
  await cache.get();
  assert.equal(calls, 1);
  now += 2;
  fail = true;
  const z = await cache.get();
  assert.equal(calls, 2);
  assert.equal(z.ok, true, 'the last good answer');
  const cold = createReleaseCache({ fetch: async () => new Response('{}', { status: 403 }) });
  const c = await cold.get();
  assert.equal(c.ok, false);
  assert.equal(c.assets.page, RELEASES_PAGE);
});

test('R2 download: /download and /api/public/release need no sign-in', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const releases = createReleaseCache({ fetch: async () => new Response(JSON.stringify(FIXTURE), { status: 200 }) });
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), releases } as never);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  const page = await fetch(`${base}/download`, { headers: { 'user-agent': UA.windows } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script type="module" src="\/download\.js"><\/script>/);
  assert.doesNotMatch(html, /style="/, 'no inline styles');
  const r = await fetch(`${base}/api/public/release`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; assets: { windows: { name: string } } };
  assert.equal(body.ok, true);
  assert.equal(body.assets.windows.name, 'Sara-Setup-3.10.0.exe');
  // The page's script says SmartScreen for Windows and Add to Home Screen for iPhone.
  const js = readFileSync(join(ROOT, 'web', 'download.js'), 'utf8');
  assert.match(js, /SmartScreen/);
  assert.match(js, /Add to Home Screen/);
});
