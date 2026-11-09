// E4 slices 2-3: matched lines stay on the host. The in-chat card is an app notice the model never
// reads, so a cloud model sees a line only when the owner asks about that alert (and then only
// that line); secrets are scrubbed before anything is kept; a check runs no tool and no command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runTurn } from '../src/chat.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { ROOT, text } from './helpers.ts';
import { watchRig } from './watch-fixture.ts';

const SECRET = 'vault-only-value-7Qm2xL9p';

test('watch privacy: the alert line is never in a model request unless the owner asks about it', async (t) => {
  const r = watchRig(t);
  r.app.vault.set('some-key', SECRET);
  r.app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: r.clock.now.toISOString() } as never);
  const conv = r.app.store.createConversation({ title: 'Ops' });
  r.file('app.log');
  const w = r.add('app.log', ['ERROR'], { conversationId: conv.id, everyMin: 5 });
  r.append('app.log', `ERROR payment failed for card-holder-zz91 key=${SECRET}\nERROR other-line-qq42 happened\n`);
  r.later(5);
  const card = r.app.store.messages(conv.id).find((m) => m.role === 'notice' && m.content.startsWith('watch:'));
  assert.ok(card, 'an in-chat card');
  assert.equal(r.pushes.length, 1);
  for (const s of [card.content, r.pushes[0].text, JSON.stringify(r.w.alerts(w.id))]) assert.ok(!s.includes(SECRET), `scrubbed: ${s}`);
  r.app.script.push(text('ok'));
  for await (const _ of runTurn(r.app, conv.id, 'how was your day?')) void _;
  const sent = JSON.stringify(r.app.requests);
  assert.ok(r.app.requests.length >= 1);
  assert.doesNotMatch(sent, /card-holder-zz91|other-line-qq42/);
  // He asks about one alert: only that line goes into his message.
  const a = r.w.alerts(w.id).find((x) => x.line.includes('card-holder-zz91'))!;
  const ask = r.w.ask(a.id);
  assert.equal(ask.conversationId, conv.id);
  assert.match(ask.text, /card-holder-zz91/);
  assert.doesNotMatch(ask.text, /other-line-qq42/);
  assert.ok(!ask.text.includes(SECRET));
  assert.equal(ask.cloud, true, 'the app warns that a cloud model would read it');
});

test('watch privacy: with private-local on the hand-off says only local models read it', (t) => {
  const r = watchRig(t);
  t.after(() => setPrivateLocal(false));
  r.file('app.log');
  const w = r.add('app.log', ['ERROR'], { everyMin: 5 });
  r.append('app.log', 'ERROR here\n');
  r.later(5);
  setPrivateLocal(true);
  assert.equal(r.w.ask(r.w.alerts(w.id)[0].id).cloud, false);
});

test('watch privacy: a check never runs a tool, a command or a model', (t) => {
  const r = watchRig(t);
  let ran = 0;
  for (const tool of r.app.tools.list()) (tool as { run: unknown }).run = async () => void ran++;
  r.file('app.log');
  const w = r.add('app.log', ['ERROR'], { everyMin: 5 });
  r.append('app.log', 'ERROR restart the service\nrm -rf /\n');
  r.later(5);
  r.w.checkNow(w.id);
  assert.equal(ran, 0);
  assert.equal(r.app.providerCalls, 0);
  const src = readFileSync(join(ROOT, 'src', 'watch.ts'), 'utf8');
  assert.doesNotMatch(src, /child_process|\bspawn\b|execFile|execSync|runTurn|providerFactory|\.tools\./);
});
