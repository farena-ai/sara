// Y1: a sign-in code works on the sign-in page itself. Owner report (2026-11-23): on a new computer
// the sign-in page offered only the owner token (the "Have a code?" link showed on phones only), so
// the code from Settings went into the token box and was refused. The audit trail showed exactly
// that: pair.do ok, then login.do refused, and no redeem. Written first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { PairRegistry } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function rig(t: TestContext, shared = false) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-23T12:00:00Z') });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(shared ? { pairs: new PairRegistry() } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  const newCode = async () => ((await (await post('/api/pair', {}, { authorization: `Bearer ${token}` })).json()) as { code: string }).code;
  return { base, post, newCode, token };
}

for (const shared of [false, true]) {
  test(`Y1 sign-in page: a code typed where the token goes signs the device in, once (${shared ? 'household registry' : 'one space'})`, async (t) => {
    const r = await rig(t, shared);
    const code = await r.newCode();
    // Typed the way people type it: lower case, spaces for dashes.
    const res = await r.post('/api/login', { token: ` ${code.toLowerCase().replaceAll('-', ' ')} ` });
    assert.equal(res.status, 200, await res.clone().text());
    const cookie = res.headers.get('set-cookie')!;
    assert.match(cookie, /^sara_session=/);
    const mine = await fetch(`${r.base}/api/conversations`, { headers: { cookie: cookie.split(';')[0]! } });
    assert.equal(mine.status, 200, 'the new device is signed in');
    // One use: the same code again is refused, like a wrong token.
    const again = await r.post('/api/login', { token: code });
    assert.equal(again.status, 401);
    assert.equal((await r.post('/api/pair/redeem', { code })).status, 401, 'and it is gone for /pair too');
  });
}

test('Y1 sign-in page: a wrong code is refused like a wrong token, the token still works, and a code used at /pair cannot be reused here', async (t) => {
  const r = await rig(t);
  assert.equal((await r.post('/api/login', { token: 'AAAA-BBBB-CCCC' })).status, 401);
  assert.equal((await r.post('/api/login', { token: '' })).status, 401);
  const code = await r.newCode();
  assert.equal((await r.post('/api/pair/redeem', { code })).status, 200);
  assert.equal((await r.post('/api/login', { token: code })).status, 401);
  assert.equal((await r.post('/api/login', { token: r.token })).status, 200, 'the owner token signs in as before');
});

test('Y1 sign-in page: the way to a code is offered on every device, not only phones', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<p id="login-paircode" class="small"><a href="\/pair">/, 'the link is not hidden in the page');
  assert.match(html, /id="login-token"[^>]*placeholder="Owner token or sign-in code"/);
  const js = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(js, /\$\('#login-paircode'\)\.hidden = Boolean\(session\.demo\);/, 'only the demo hides it');
});
