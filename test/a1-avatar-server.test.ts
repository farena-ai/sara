// A1: the server side of her living picture: the built-in look's face landmarks, hidden for a custom
// look (its own frames are measured instead), and the CSP that lets a 3D model's embedded textures load.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { SECURITY_HEADERS } from '../src/http.ts';
import { LookBuilder } from '../src/look.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
app.look = new LookBuilder({ dataDir: dir, key: async () => undefined }) as never;
const auth = new OwnerAuth(dir);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const get = (p: string) => fetch(base + p, { headers: { authorization: `Bearer ${token}` } });

test('face landmarks: served for the built-in look, not for a custom one', async () => {
  const res = await get('/sara/face.json');
  assert.equal(res.status, 200);
  const j = (await res.json()) as Record<string, { le: { x: number }; re: { x: number }; mouth: { y: number } }>;
  for (const m of ['default', 'happy', 'caring', 'playful', 'sleepy', 'hurt']) {
    assert.ok(j[m], m);
    assert.ok(j[m].le.x < j[m].re.x, `${m}: left eye left of the right eye`);
  }
  mkdirSync(join(dir, 'look'), { recursive: true });
  writeFileSync(join(dir, 'look', 'sara-portrait.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await get('/sara/face.json')).status, 404, 'a custom look: measured from its own frames');
});

test('CSP: blob: only for images and connections (a 3D model’s textures), scripts stay self-only', () => {
  const csp = SECURITY_HEADERS['content-security-policy'];
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /connect-src 'self' blob:/);
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline/);
});
