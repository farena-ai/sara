// EC10: several keys per provider rotate when the provider refuses one (docs/ops/EC10_DESIGN.md),
// and the `externalSecrets` policy pin (EC5) keeps server keys out of Sara's own vault.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { resolveProvider } from '../src/chat.ts';
import { withKeyRotation } from '../src/key-rotation.ts';
import { PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { ProviderError, type ChatRequest, type Provider, type ProviderConfig, type StreamEvent } from '../src/providers/types.ts';
import { SecretSources, setSecretSources } from '../src/secret-sources.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, tempDir } from './helpers.ts';

const CONFIG: ProviderConfig = { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm', needsKey: true } as ProviderConfig;
function keyed(key: string | undefined, behave: Record<string, 'ok' | number | 'late'>, used: string[]): Provider {
  return {
    config: CONFIG,
    listModels: async () => ['m'],
    async *stream(): AsyncIterable<StreamEvent> {
      used.push(key ?? '');
      const b = behave[key ?? ''] ?? 'ok';
      if (b === 'late') {
        yield { type: 'text', text: 'partial' };
        throw new ProviderError('late', 401);
      }
      if (typeof b === 'number') throw new ProviderError(`status ${b}`, b);
      yield { type: 'text', text: `answer with ${key}` };
    },
  };
}
async function drain(p: Provider): Promise<string> {
  let out = '';
  for await (const ev of p.stream({ model: 'm', messages: [] } as unknown as ChatRequest)) if (ev.type === 'text') out += ev.text;
  return out;
}

test('EC10 rotation: a refused key (401/403/429) moves to the next one and retries; other errors do not', async () => {
  const { dir, cleanup } = tempDir();
  const env = { KEY_A: 'sk-aaaa-1', KEY_B: 'sk-bbbb-2', KEY_C: 'sk-cccc-3' };
  setSecretSources(new SecretSources({ env }));
  const trail = new AuditTrail(dir, { key: () => 'k' });
  setAuditTrail(trail);
  try {
    const vault = new Vault(dir);
    vault.set('provider:p', 'env:KEY_A | env:KEY_B | env:KEY_C');
    const used: string[] = [];
    const behave: Record<string, 'ok' | number | 'late'> = { 'sk-aaaa-1': 401, 'sk-bbbb-2': 429 };
    const p = withKeyRotation(vault, 'provider:p', (k) => keyed(k, behave, used));
    assert.equal(await drain(p), 'answer with sk-cccc-3');
    assert.deepEqual(used, ['sk-aaaa-1', 'sk-bbbb-2', 'sk-cccc-3']);
    assert.equal(vault.get('provider:p'), 'sk-cccc-3', 'the working key stays in use');
    assert.equal(trail.list({ action: 'secret.rotate' }).length, 2);
    // Every key refused: the last refusal is the error, nothing loops.
    behave['sk-cccc-3'] = 403;
    used.length = 0;
    await assert.rejects(drain(p), /status 403|status 401|status 429/);
    assert.equal(used.length, 3, 'each key tried once');
    // A server error or a failure after the answer started is not the key's fault.
    behave['sk-aaaa-1'] = 500;
    behave['sk-bbbb-2'] = 500;
    behave['sk-cccc-3'] = 500;
    used.length = 0;
    await assert.rejects(drain(p), /status 500/);
    assert.equal(used.length, 1);
    for (const k of Object.keys(behave)) behave[k] = 'late';
    used.length = 0;
    await assert.rejects(drain(p), /late/);
    assert.equal(used.length, 1);
    // One key: the provider itself, unwrapped.
    vault.set('provider:one', 'env:KEY_A');
    const one = keyed('x', {}, []);
    assert.equal(withKeyRotation(vault, 'provider:one', () => one), one);
  } finally {
    setAuditTrail(undefined);
    setSecretSources(new SecretSources());
    cleanup();
  }
});

test('EC10 rotation: resolveProvider (chat, jobs, bridges) uses it', async () => {
  const { dir, cleanup } = tempDir();
  setSecretSources(new SecretSources({ env: { KEY_A: 'sk-aaaa-1', KEY_B: 'sk-bbbb-2' } }));
  try {
    const app = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
    app.settings.update({ providers: [CONFIG], defaultProviderId: 'p' });
    app.vault.set('provider:p', 'env:KEY_A | env:KEY_B');
    const used: string[] = [];
    app.providerFactory = (_c, key) => keyed(key, { 'sk-aaaa-1': 401 }, used);
    assert.equal(await drain(resolveProvider(app, 'p', null).provider), 'answer with sk-bbbb-2');
    assert.deepEqual(used, ['sk-aaaa-1', 'sk-bbbb-2']);
    app.store.close();
  } finally {
    setSecretSources(new SecretSources());
    cleanup();
  }
});

test('EC10 policy pin externalSecrets: server keys only as references, enforced in the vault', () => {
  const { dir, cleanup } = tempDir();
  setSecretSources(new SecretSources({ env: { KEY_A: 'sk-aaaa-1' } }));
  const store = new PolicyStore(dir);
  setPolicy(store);
  try {
    assert.throws(() => validatePolicy({ name: 'x', pins: { externalSecrets: false } }), /can only be pinned on/);
    store.set({ name: 'Ops rules', pins: { externalSecrets: true } });
    const vault = new Vault(dir);
    for (const name of ['provider:openai', 'bridge:telegram', 'business-oidc:client-secret', 'voice:openai'])
      assert.throws(() => vault.set(name, 'sk-pasted-123456'), (e: Error & { status?: number }) => e.status === 409 && /Set by your admin \(Ops rules\)/.test(e.message), name);
    vault.set('provider:openai', 'env:KEY_A');
    assert.equal(vault.get('provider:openai'), 'sk-aaaa-1');
    vault.set('audit:key', 'generated-by-sara');
    assert.equal(vault.get('audit:key'), 'generated-by-sara', 'Sara’s own secrets are not affected');
    vault.delete('provider:openai');
    assert.equal(vault.has('provider:openai'), false, 'removing a key is always allowed');
  } finally {
    setPolicy(new PolicyStore());
    setSecretSources(new SecretSources());
    cleanup();
  }
});
