// W5.2 (docs/design/W5LOCAL.md): Local-only mode with explicit allowances. The switch is the
// Phase 67 private local mode; the person may allow a short, fixed list of things while it is on
// (update checks, model downloads), each one by itself. Everything else stays blocked, allowed
// traffic is counted by the privacy ledger, and the page/session say what is allowed.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { assertOnline, isPrivateLocalError, LOCAL_ALLOWS, localAllowed, netFetch, outboundAllowed, setLocalAllow, setNetTransport, setPrivateLocal } from '../src/net-guard.ts';
import { PrivateLocalStore } from '../src/private-local.ts';
import { PrivacyLedger, setPrivacyLedger } from '../src/privacy-ledger.ts';
import { createSaraServer } from '../src/server.ts';
import { join } from 'node:path';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const realFetch = globalThis.fetch.bind(globalThis);
afterEach(() => {
  setPrivateLocal(false);
  setLocalAllow([]);
  setNetTransport();
  setPrivacyLedger(undefined);
});

const RELEASES = 'https://github.com/farena-ai/sara/releases/latest/download/update-notice.json';

test('allowances: off by default; each one opens only its own addresses, and only while it is allowed', async () => {
  assert.deepEqual([...LOCAL_ALLOWS], ['updates', 'model-downloads']);
  const seen: string[] = [];
  setNetTransport((async (u: string | URL | Request) => {
    seen.push(String(u));
    return Response.json({});
  }) as typeof fetch);
  setPrivateLocal(true);
  assert.equal(outboundAllowed(RELEASES), false);
  assert.throws(() => assertOnline('Checking for updates', 'updates'), isPrivateLocalError);
  setLocalAllow(['updates']);
  assert.equal(localAllowed('updates'), true);
  assert.equal(localAllowed('model-downloads'), false);
  assert.equal(outboundAllowed(RELEASES), true);
  assert.equal(outboundAllowed('https://api.github.com/repos/farena-ai/sara/releases/latest'), true);
  assertOnline('Checking for updates', 'updates');
  // The same host for anything else stays blocked (no GitHub tools, no other repo, no tricks).
  for (const bad of ['https://github.com/someone/else', 'https://api.github.com/user/repos', 'https://github.com/farena-ai/sara-evil/releases/', 'https://github.com.evil.example/farena-ai/sara/releases/', 'http://github.com/farena-ai/sara/releases/x', 'https://x@github.com/farena-ai/sara/releases/x']) {
    assert.equal(outboundAllowed(bad), false, bad);
  }
  assert.throws(() => assertOnline('Installing Ollama'), isPrivateLocalError);
  await netFetch(RELEASES);
  await assert.rejects(netFetch('https://api.openai.com/v1/models'), isPrivateLocalError);
  assert.deepEqual(seen, [RELEASES]);
  // Model downloads: Ollama's pull on this computer passes, its web search and cloud models don't.
  await assert.rejects(netFetch('http://127.0.0.1:11434/api/pull', { method: 'POST', body: '{"model":"gemma3:4b"}' }), isPrivateLocalError);
  setLocalAllow(['model-downloads']);
  assert.equal(outboundAllowed(RELEASES), false, 'updates no longer allowed');
  await netFetch('http://127.0.0.1:11434/api/pull', { method: 'POST', body: '{"model":"gemma3:4b"}' });
  await assert.rejects(netFetch('http://127.0.0.1:11434/api/web_search', { method: 'POST', body: '{}' }), isPrivateLocalError);
  await assert.rejects(netFetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: '{"model":"gpt-oss:120b-cloud"}' }), isPrivateLocalError);
  // Unknown ids are ignored.
  setLocalAllow(['web' as never, 'updates']);
  assert.equal(localAllowed('updates'), true);
  // Mode off: allowances don't matter, everything is allowed as before.
  setPrivateLocal(false);
  assert.equal(outboundAllowed('https://api.openai.com/'), true);
});

test('the ledger counts allowed traffic, including the download Ollama makes for us', async () => {
  const ledger = new PrivacyLedger();
  setPrivacyLedger(ledger);
  setNetTransport((async () => Response.json({})) as typeof fetch);
  setPrivateLocal(true);
  setLocalAllow(['updates', 'model-downloads']);
  await netFetch(RELEASES);
  await netFetch('http://127.0.0.1:11434/api/pull', { method: 'POST', body: '{"model":"gemma3:4b"}' });
  await assert.rejects(netFetch('https://api.openai.com/v1/models'), isPrivateLocalError);
  const d = ledger.day();
  assert.equal(d.total.count, 2);
  assert.deepEqual(d.groups.map((g) => [g.purpose, g.hosts.map((h) => h.host)]).sort(), [['github', ['github.com']], ['model', ['registry.ollama.ai']]]);
  assert.deepEqual(d.stopped, [{ host: 'api.openai.com', count: 1 }]);
});

test('the store keeps the allowances (known ids only) and applies them; off by default', () => {
  const { dir } = tempDir();
  const pl = new PrivateLocalStore(dir, '');
  assert.deepEqual(pl.get().allow, []);
  pl.setAllow(['updates', 'nope' as never, 'updates']);
  assert.deepEqual(pl.get().allow, ['updates']);
  assert.equal(localAllowed('updates'), true);
  const again = new PrivateLocalStore(dir, '');
  assert.deepEqual(again.get().allow, ['updates']);
  again.setAllow([]);
  assert.equal(localAllowed('updates'), false);
});

test('server: PUT allow changes only the allowances; GET lists them with what each one is; session and ledger say so', async () => {
  const { dir } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T15:00:00Z') });
  app.settings.update({ providers: [{ id: 'here', kind: 'openai-compatible', label: 'Here', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'local-1', needsKey: false }], defaultProviderId: 'here', defaultModel: 'local-1', disclosureAcceptedAt: '2026-11-01T00:00:00Z' } as never);
  app.privateLocal = new PrivateLocalStore(dir, '');
  app.privateLocal.set(true);
  setPrivacyLedger(new PrivacyLedger());
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await realFetch(base + path, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    let v = await call('/api/private-local');
    assert.equal(v.body.on, true);
    assert.deepEqual(v.body.allow, []);
    assert.deepEqual((v.body.allowable as { id: string }[]).map((x) => x.id), ['updates', 'model-downloads']);
    assert.equal((await call('/api/update', { method: 'POST', body: { action: 'check' } })).status, 409);
    v = await call('/api/private-local', { method: 'PUT', body: { allow: ['updates', 'web'] } });
    assert.equal(v.status, 200);
    assert.equal(v.body.on, true, 'the mode stays on');
    assert.deepEqual(v.body.allow, ['updates']);
    assert.equal(localAllowed('updates'), true);
    const leave = (v.body.leave as { id: string; allowed?: boolean }[]).find((x) => x.id === 'updates');
    assert.equal(leave?.allowed, true);
    const s = await call('/api/session');
    assert.equal(s.body.privateLocal, true);
    assert.deepEqual(s.body.localAllow, ['updates']);
    const l = await call('/api/private-local/ledger');
    assert.deepEqual(l.body.localAllow, ['updates']);
    assert.equal((await call('/api/private-local', { method: 'PUT', body: { allow: 'updates' } })).status, 400);
    // Model downloads: the download route answers 409 until allowed.
    setNetTransport((async (u: string | URL | Request, init?: RequestInit) => (String(u).startsWith(base) ? realFetch(u, init) : String(u).includes('/api/pull') ? new Response('{"status":"success"}\n') : Response.json({ version: '0.40.10', models: [] }))) as typeof fetch);
    assert.equal((await call('/api/local-models/pull', { method: 'POST', body: { model: 'gemma3:4b', use: false } })).status, 409);
    await call('/api/private-local', { method: 'PUT', body: { allow: ['updates', 'model-downloads'] } });
    assert.notEqual((await call('/api/local-models/pull', { method: 'POST', body: { model: 'gemma3:4b', use: false } })).status, 409);
    v = await call('/api/private-local', { method: 'PUT', body: { allow: [] } });
    assert.deepEqual(v.body.allow, []);
    assert.equal(localAllowed('updates'), false);
  } finally {
    server.close();
    app.store.close();
  }
});
