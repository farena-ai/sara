// EC10: Settings → Data & health → Secret sources: each server secret's source and status, never a value.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { SecretSources, setSecretSources } from '../src/secret-sources.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const env: Record<string, string | undefined> = { OPENAI_KEY: 'sk-route-secret-1234' };
setSecretSources(new SecretSources({ env }));
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
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
  setSecretSources(new SecretSources());
  cleanup();
});
const req = (path: string, method = 'GET') => fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });

test('EC10 routes: the list shows sources and status, never a value; Check now re-reads', async () => {
  app.vault.set('provider:openai', 'env:OPENAI_KEY | env:OPENAI_KEY_2');
  app.vault.set('bridge:telegram', '123:tg-plain-token-99');
  app.vault.set('audit:key', 'internal-not-listed');
  const r = await req('/api/secrets');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.doesNotMatch(text, /sk-route|tg-plain|internal-not-listed/);
  const d = JSON.parse(text);
  assert.equal(d.pinned, false);
  assert.equal(d.commands, false);
  assert.deepEqual(d.configured, { vault: false, onepassword: false });
  const names = d.sources.map((s: { name: string }) => s.name);
  assert.deepEqual(names, ['bridge:telegram', 'provider:openai']);
  const p = d.sources.find((s: { name: string }) => s.name === 'provider:openai');
  assert.deepEqual(p.refs.map((x: { ref: string; ok: boolean }) => [x.ref, x.ok]), [['env:OPENAI_KEY', true], ['env:OPENAI_KEY_2', false]]);
  assert.equal(p.refs[1].error, 'The environment variable OPENAI_KEY_2 is not set.');
  env.OPENAI_KEY_2 = 'sk-route-secret-5678';
  const c = await req('/api/secrets/check', 'POST');
  assert.equal(c.status, 200);
  const cd = await c.json();
  assert.equal(cd.sources.find((s: { name: string }) => s.name === 'provider:openai').refs[1].ok, true);
  assert.equal((await fetch(base + '/api/secrets')).status, 401, 'signed in only');
});

test('EC10 routes: a Vault reference saved as a provider key is resolved before the save answers (C1, real OpenBao)', async () => {
  // A real OpenBao answers in a few milliseconds; the first chat right after Save used to say
  // "needs an API key" because the reference was still resolving in the background.
  const { createServer } = await import('node:http');
  const bao = createServer((req, res) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { openai: 'sk-from-bao-42' } } }));
  }, 150));
  await new Promise<void>((r) => bao.listen(0, '127.0.0.1', r));
  setSecretSources(new SecretSources({ env: { VAULT_ADDR: `http://127.0.0.1:${(bao.address() as AddressInfo).port}`, VAULT_TOKEN: 'root' } }));
  try {
    const r = await fetch(base + '/api/providers/baoed', { method: 'PUT', headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Bao', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'm', needsKey: true, apiKey: 'vault:secret/sara#openai' }) });
    assert.equal(r.status, 200);
    assert.equal(app.vault.get('provider:baoed'), 'sk-from-bao-42', 'usable at once, not after a background refresh');
  } finally {
    setSecretSources(new SecretSources({ env }));
    await new Promise<void>((r) => bao.close(() => r()));
  }
});
