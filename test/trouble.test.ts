// 3.3.0 easy mode (ezfirst): she fixes or explains her own problems. A failed model call, a rejected
// key, no credit, a mailbox that signed her out or an add-on that stopped becomes one plain notice
// with one Fix it button (src/trouble.ts); Health's Model line follows the real calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { troubleOf, noteCall, callTrouble, gatherTrouble, modelHealth } from '../src/trouble.ts';
import { FakeProvider, makeApp, tempDir, text } from './helpers.ts';
import { healthReport } from '../src/health.ts';
import { runTurn } from '../src/chat.ts';
import { friendlyHttpError, ProviderError } from '../src/providers/types.ts';

function rig() {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  return { app, script: app.script, cleanup };
}

test('trouble: each provider failure becomes a plain notice that names the service and one fix', () => {
  const down = troubleOf("Couldn't reach Ollama Cloud (API key) at ollama.com. Is that computer on and its model server running?", 'Ollama Cloud (API key)');
  assert.equal(down?.kind, 'unreachable');
  assert.match(down!.text, /can’t reach my AI service \(Ollama Cloud\) right now/);
  assert.equal(down!.fix.page, 'models-providers');
  assert.equal(down!.retry, true);
  const key = troubleOf(friendlyHttpError('OpenAI', 401, 'Invalid API key provided'), 'OpenAI');
  assert.equal(key?.kind, 'key');
  assert.match(key!.text, /OpenAI didn’t accept my key/);
  assert.equal(troubleOf(friendlyHttpError('OpenAI', 402, 'insufficient_quota'), 'OpenAI')?.kind, 'credit');
  assert.equal(troubleOf(friendlyHttpError('OpenAI', 429, 'rate limit'), 'OpenAI')?.kind, 'busy');
  assert.equal(troubleOf(friendlyHttpError('Ollama', 404, 'model "x" not found'), 'Ollama')?.kind, 'model');
  assert.equal(troubleOf('fetch failed', 'Ollama')?.kind, 'unreachable');
  assert.equal(troubleOf('connect ECONNREFUSED 127.0.0.1:11434', 'Ollama')?.kind, 'unreachable');
  // Not a service problem: no notice (the plain error stays as it was).
  assert.equal(troubleOf('Stopped.', 'Ollama'), null);
  assert.equal(troubleOf('Message is empty.', 'Ollama'), null);
  // The template and its values travel too, so the app shows it in the owner's language.
  assert.equal(key!.key.includes('{service}'), true);
  assert.deepEqual(key!.params, { service: 'OpenAI' });
});

test('trouble: Health follows the real calls: a failing default provider is not ✓', () => {
  const { app, cleanup } = rig();
  try {
    const s = app.settings.get();
    const id = s.defaultProviderId ?? s.providers[0].id;
    const label = s.providers.find((p) => p.id === id)?.label ?? id;
    const info = { version: 't', revision: null, startedAt: new Date().toISOString() };
    const model = () => healthReport(app, info).checks.find((c) => c.name === 'Model')!;
    assert.equal(model().ok, true);
    noteCall(app, { id, label }, new ProviderError(`Couldn't reach ${label} at x. Is that computer on and its model server running?`));
    assert.equal(model().ok, false, 'a failed real call turns the Model line red');
    assert.match(model().detail, /can’t reach my AI service/);
    assert.equal(modelHealth(app)?.kind, 'unreachable');
    assert.equal(callTrouble(app).length, 1);
    noteCall(app, { id, label });
    assert.equal(model().ok, true, 'the next good call clears it');
    assert.equal(callTrouble(app).length, 0);
  } finally {
    cleanup();
  }
});

test('trouble: a turn that fails says so with a Fix it notice and records it for Today', async () => {
  const { app, script, cleanup } = rig();
    let down = true;
    const real = app.providerFactory!;
    app.providerFactory = (config) => {
      const p = real(config) as FakeProvider;
      return {
        config: p.config,
        listModels: () => p.listModels(),
        async *stream(req) {
          if (down) throw new ProviderError(`Couldn't reach ${config.label} at 127.0.0.1:9. Is that computer on and its model server running?`);
          yield* p.stream(req);
        },
      };
    };
  try {
    const conv = app.store.createConversation();
    const evs: { type: string; message?: string; trouble?: { kind: string; fix: { page: string } } }[] = [];
    for await (const ev of runTurn(app, conv.id, 'hi')) evs.push(ev as never);
    const err = evs.find((e) => e.type === 'error');
    assert.ok(err, 'an error event');
    assert.equal(err!.trouble?.kind, 'unreachable');
    assert.equal(err!.trouble?.fix.page, 'models-providers');
    const list = gatherTrouble(app);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'unreachable');
    // She answers again: the notice goes away by itself.
    down = false;
    script.push(text('Hello!'));
    for await (const _ of runTurn(app, conv.id, 'hi again')) void _;
    assert.equal(gatherTrouble(app).length, 0);
  } finally {
    cleanup();
  }
});

test('trouble: a mailbox that signed her out and a crashed add-on become notices too', () => {
  const { app, cleanup } = rig();
  try {
    (app as unknown as { mailAccounts: unknown }).mailAccounts = { list: () => [{ id: 'm1', kind: 'microsoft', address: 'pat@outlook.com', problem: 'Signed out: sign in again.' }] };
    (app as unknown as { pluginManager: unknown }).pluginManager = { list: () => [{ id: 'p1', name: 'Weather', status: 'crashed' }, { id: 'p2', name: 'Fine', status: 'installed' }] };
    const list = gatherTrouble(app);
    const mail = list.find((x) => x.kind === 'mail');
    assert.ok(mail);
    assert.equal(mail!.fix.page, 'ab-mail');
    assert.match(mail!.text, /pat@outlook\.com signed me out/);
    const addon = list.find((x) => x.kind === 'addon');
    assert.ok(addon);
    assert.match(addon!.text, /Weather/);
    assert.equal(addon!.fix.page, 'ab-plugins');
    assert.equal(list.filter((x) => x.kind === 'addon').length, 1);
  } finally {
    cleanup();
  }
});

test('trouble: Health marks the technical checks so Company mode can fold them away', () => {
  const { app, cleanup } = rig();
  try {
    const checks = healthReport(app, { version: 't', revision: null, startedAt: new Date().toISOString() }).checks;
    const tech = checks.filter((c) => (c as { tech?: boolean }).tech).map((c) => c.name);
    assert.ok(tech.includes('Tool sandbox') && tech.includes('Command approvals') && tech.includes('Memory'));
    assert.ok(!tech.includes('Model') && !tech.includes('Backups'));
    const web = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(web, /state\.usePath === 'company' && !healthTech/);
  } finally {
    cleanup();
  }
});
