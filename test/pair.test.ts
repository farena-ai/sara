// Phase 16: sign in a new device with a one-time code / QR code.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deviceLabel, OwnerAuth } from '../src/auth.ts';
import { makeQr, qrSvg } from '../src/qr.ts';
import { setReachDeps } from '../src/reach.ts';
const qrDataUrl = (s: string) => `data:image/svg+xml;base64,${Buffer.from(qrSvg(s)).toString('base64')}`;
import { createSaraServer, newPairCode, normalizePairCode } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-24T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  setReachDeps({ cli: () => null, interfaces: () => ({}), env: { SARA_PORT: '7860' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  setReachDeps({});
  server.close();
  app.store.close();
  cleanup();
});
const owner = (path: string, method = 'GET') => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, origin: base, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, ...(method !== 'GET' ? { body: '{}' } : {}) });
const redeem = (code: string, ua = 'Mozilla/5.0 (Linux; Android 15) SaraPhone/1') => fetch(`${base}/api/pair/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ code }) });

test('pair: owner makes a code (QR + text); it signs one device in, once; typing is forgiving', async () => {
  assert.equal((await fetch(`${base}/api/pair`, { method: 'POST' })).status, 401, 'owner only');
  const p = await (await owner('/api/pair', 'POST')).json();
  assert.match(p.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(p.url, `${base}/pair#${p.code}`);
  // 3.3.0: opened as 127.0.0.1 with Sara on this computer only, no QR (a phone can't open
  // 127.0.0.1); the phone QR with a reachable address is in test/reach.test.ts.
  assert.equal(p.reachable, false);
  assert.equal(p.qr, undefined);
  assert.match(qrDataUrl(p.url), /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(qrDataUrl(p.url).split(',')[1], 'base64').toString(), /^<svg .*<path d="M/);
  assert.equal((await redeem('AAAA-BBBB-CCCC')).status, 401);
  // Lower case and without dashes still works; a session cookie comes back.
  const r = await redeem(` ${p.code.toLowerCase().replaceAll('-', ' ')} `);
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  const session = await (await fetch(`${base}/api/session`, { headers: { cookie: cookie.split(';')[0] } })).json();
  assert.equal(session.authenticated, true);
  // Used up.
  assert.equal((await redeem(p.code)).status, 401);
  const devs = (await (await owner('/api/devices')).json()).devices;
  assert.ok(devs.some((d: { label: string }) => /Android/.test(d.label)));
  // The desktop apps (Phase 33) are named too, with Mac/Windows (Edge's own "Edg/" mustn't win).
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0 Safari/537.36 Edg/155.0.0.0 SaraDesktop/1 (Windows)'), 'Sara app on Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) SaraDesktop/1 (Mac)'), 'Sara app on Mac');
  // A cancelled code doesn't work.
  const p2 = await (await owner('/api/pair', 'POST')).json();
  await owner('/api/pair', 'DELETE');
  assert.equal((await redeem(p2.code)).status, 401);
  // The landing page is served.
  assert.match(await (await fetch(`${base}/pair`)).text(), /Sign in this device/);
});

test('pair: code alphabet has no look-alikes; QR sizes grow with the text', () => {
  for (let i = 0; i < 50; i++) assert.doesNotMatch(newPairCode(), /[01OIL]/);
  assert.equal(normalizePairCode('ab-cd ef'), 'ABCDEF');
  assert.equal(makeQr('hi').size, 21);
  assert.equal(makeQr('https://sara.example.com/pair#K7QM-2XPA-9TRB').size, 33);
  assert.throws(() => makeQr('x'.repeat(300)), /Too long/);
});

test('desktop apps (Phase 33): offered for download only when the owner put them in <data>/downloads', async () => {
  assert.deepEqual(await (await owner('/api/desktop-apps')).json(), { windows: null, mac: null });
  assert.equal((await owner('/api/desktop-apps/windows')).status, 404);
  mkdirSync(join(dir, 'downloads'), { recursive: true });
  writeFileSync(join(dir, 'downloads', 'Sara.exe'), Buffer.from('MZ fake app'));
  const list = await (await owner('/api/desktop-apps')).json();
  assert.equal(list.windows.size, 11);
  assert.equal(list.mac, null);
  const r = await owner('/api/desktop-apps/windows');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="Sara.exe"/);
  assert.equal(await r.text(), 'MZ fake app');
  // Signed-in owner only; nothing else in the data folder can be reached this way.
  assert.equal((await fetch(`${base}/api/desktop-apps/windows`)).status, 401);
  assert.equal((await owner('/api/desktop-apps/..%2Fsara.db')).status, 404);
  assert.equal((await owner('/api/desktop-apps/linux')).status, 404);
});
