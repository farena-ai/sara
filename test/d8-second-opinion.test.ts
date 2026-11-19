// D8 (docs/design/D8SECOND.md): "Get a second opinion" on any reply. Two other connected models
// answer the same question, the differences are highlighted, the spend is shown before anything
// is sent, and private chats only ever use models on this computer.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import type { ChatRequest, Provider, ProviderConfig } from '../src/providers/types.ts';
import { askSecondOpinion, diffAnswers, SECOND_OPINION_CAP, secondOpinionPlan } from '../src/second-opinion.ts';
import { createSaraServer } from '../src/server.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { priceTable, UsageStore } from '../src/usage.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-18T15:00:00Z');
const QUESTION = 'How long should I boil an egg for a soft yolk?';
const ANSWERS: Record<string, string> = {
  'gpt-5-mini': 'Boil it for about 6 minutes. Then cool it in cold water.',
  'claude-sonnet-5': 'Boil it for about 6 minutes. Then cool it in cold water. Use eggs at room temperature so the shell does not crack.',
  'qwen3:30b': 'Boil it for about 7 minutes. Then cool it in cold water.',
  'gemma4:12b': 'Six minutes is right for most eggs. Then cool it in cold water.',
};

interface World {
  app: TestApp;
  calls: { model: string; req: ChatRequest }[];
}

/** Sara answered with gpt-5-mini (paid); two more cloud models and two local ones are connected. */
function world(t: { after: (fn: () => void) => void }): World {
  const { dir, cleanup } = tempDir();
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.usage.prices = () => priceTable(app.settings.get().prices);
  const calls: World['calls'] = [];
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    async listModels() {
      return [config.defaultModel ?? 'x'];
    },
    async *stream(req: ChatRequest) {
      calls.push({ model: req.model, req });
      yield { type: 'text', text: ANSWERS[req.model] ?? 'ok' };
      yield { type: 'usage', input: 400, output: 60 };
    },
  });
  const providers: ProviderConfig[] = [
    { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-5-mini' },
    { id: 'claude', label: 'Other cloud', kind: 'openai-compatible', baseUrl: 'https://other.example.com/v1', defaultModel: 'claude-sonnet-5' },
    { id: 'loc', label: 'This PC', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'qwen3:30b' },
    { id: 'loc2', label: 'This PC too', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11435/v1', local: true, defaultModel: 'gemma4:12b' },
  ];
  app.settings.update({
    providers,
    defaultProviderId: 'cloud',
    defaultModel: 'gpt-5-mini',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    prices: [
      { providerId: 'cloud', model: 'gpt-5-mini', inPerM: 1, outPerM: 4 },
      { providerId: 'claude', model: 'claude-sonnet-5', inPerM: 3, outPerM: 15 },
    ],
  } as never);
  t.after(() => {
    setPrivateLocal(false);
    app.store.close();
    cleanup();
  });
  return { app, calls };
}

/** A chat with one question and Sara's reply (made by gpt-5-mini on Cloud). */
function chat(app: TestApp, o: { private?: boolean } = {}) {
  const conv = app.store.createConversation({ title: 'Eggs', ...(o.private ? { private: true } : {}) } as never);
  app.store.addMessage(conv.id, 'user', QUESTION);
  const reply = app.store.addMessage(conv.id, 'assistant', ANSWERS['gpt-5-mini'], { model: 'gpt-5-mini', provider: 'Cloud' });
  return { conv: app.store.getConversation(conv.id)!, reply };
}

test('D8.1 the plan picks two OTHER models and shows the spend before anything is sent', (t) => {
  const { app, calls } = world(t);
  const { conv, reply } = chat(app);
  const plan = secondOpinionPlan(app, conv, reply);
  assert.equal(plan.models.length, 2);
  assert.ok(!plan.models.some((m) => m.model === 'gpt-5-mini'), 'never the model that already answered');
  assert.equal(new Set(plan.models.map((m) => `${m.providerId}/${m.model}`)).size, 2);
  // Every connected model except the one that answered is on offer to swap in.
  assert.deepEqual(plan.choices.map((m) => m.model).sort(), ['claude-sonnet-5', 'gemma4:12b', 'qwen3:30b']);
  const paid = plan.choices.find((m) => m.model === 'claude-sonnet-5')!;
  assert.equal(paid.billing, 'api');
  assert.ok(typeof paid.estUsd === 'number' && paid.estUsd > 0, 'a paid model shows its estimate');
  for (const m of plan.choices.filter((c) => c.local)) assert.equal(m.estUsd, 0, 'local models are free');
  assert.equal(plan.estUsd, plan.models.reduce((n, m) => n + (m.estUsd ?? 0), 0));
  assert.equal(calls.length, 0, 'planning calls no model');
});

test('D8.2 two fake models answer; the differences are marked against her reply', async (t) => {
  const { app, calls } = world(t);
  const { conv, reply } = chat(app);
  const r = await askSecondOpinion(app, conv, reply, [
    { providerId: 'claude', model: 'claude-sonnet-5' },
    { providerId: 'loc', model: 'qwen3:30b' },
  ]);
  assert.equal(calls.length, 2);
  // Each model got the question, not her answer (an independent opinion), and no tools.
  for (const c of calls) {
    assert.ok(c.req.messages.some((m) => m.role === 'user' && m.content.includes(QUESTION)));
    assert.ok(!c.req.messages.some((m) => m.content.includes(ANSWERS['gpt-5-mini'])), 'her reply is not shown to them');
    assert.ok(!c.req.tools?.length);
  }
  assert.equal(r.answers.length, 3, 'her reply + two opinions');
  assert.equal(r.answers[0].mine, true);
  const claude = r.answers.find((a) => a.model === 'claude-sonnet-5')!;
  const qwen = r.answers.find((a) => a.model === 'qwen3:30b')!;
  assert.equal(claude.text, ANSWERS['claude-sonnet-5']);
  // Claude says one thing nobody else does: marked "only".
  const only = claude.parts.filter((p) => p.kind === 'only').map((p) => p.text);
  assert.equal(only.length, 1);
  assert.match(only[0], /room temperature/);
  // Qwen says 7 minutes where the others say 6: the sentence is marked as a different number.
  assert.deepEqual(qwen.parts.map((p) => p.kind), ['number', 'same']);
  assert.ok(r.differ >= 2);
  // Kept on the reply, so the panel comes back after a reload.
  const kept = app.store.messageById(reply.id)!.meta?.secondOpinion as { answers: unknown[] };
  assert.equal(kept.answers.length, 3);
});

test('D8.3 private chats use models on this computer only, even when cloud ones are asked for', async (t) => {
  const { app, calls } = world(t);
  const { conv, reply } = chat(app, { private: true });
  const plan = secondOpinionPlan(app, conv, reply);
  assert.equal(plan.private, true);
  assert.ok(plan.choices.length >= 2 && plan.choices.every((m) => m.local), 'only local models are offered');
  assert.equal(plan.estUsd, 0);
  await assert.rejects(askSecondOpinion(app, conv, reply, [{ providerId: 'claude', model: 'claude-sonnet-5' }, { providerId: 'loc', model: 'qwen3:30b' }]), /computer/);
  assert.equal(calls.length, 0, 'nothing was sent anywhere');
  const r = await askSecondOpinion(app, conv, reply);
  assert.deepEqual(r.answers.filter((a) => !a.mine).map((a) => a.model).sort(), ['gemma4:12b', 'qwen3:30b']);
  assert.ok(calls.every((c) => c.model === 'qwen3:30b' || c.model === 'gemma4:12b'));
});

test('D8.4 private local mode and the spend limit keep paid models out', (t) => {
  const { app } = world(t);
  const { conv, reply } = chat(app);
  setPrivateLocal(true);
  assert.ok(secondOpinionPlan(app, conv, reply).choices.every((m) => m.local));
  setPrivateLocal(false);
  app.settings.update({ spend: { dayUsd: 0.01 } } as never);
  app.usage!.record(app.settings.get().providers[0], 'gpt-5-mini', { input: 100000, output: 100000 }, { purpose: 'chat' });
  const plan = secondOpinionPlan(app, conv, reply);
  assert.ok(plan.choices.every((m) => m.billing !== 'api'), 'no pay-per-use model past the limit');
});

test('D8.5 diffAnswers marks shared, only-here and different-number sentences', () => {
  const d = diffAnswers(['The train leaves at 9. Bring a coat.', 'The train leaves at 10. Bring a coat.', 'Bring a warm coat. Buy tickets online.']);
  assert.deepEqual(d[0].map((p) => p.kind), ['number', 'same']);
  assert.deepEqual(d[1].map((p) => p.kind), ['number', 'same']);
  assert.deepEqual(d[2].map((p) => p.kind), ['same', 'only']);
  assert.equal(d[2][1].text, 'Buy tickets online.');
  // Text is kept exactly (joining the parts gives the answer back).
  assert.equal(d[0].map((p) => p.text).join(''), 'The train leaves at 9. Bring a coat.');
});

test('D8.6 routes: GET plans, POST asks; nothing to ask gives a clear 409; demo gets 404', async (t) => {
  const { app, calls } = world(t);
  const { conv, reply } = chat(app);
  const auth = new OwnerAuth(app.dataDir);
  const token = String(auth.newToken);
  const server = createSaraServer({ app, auth, webDir: `${ROOT}/web` });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations/${conv.id}/second-opinion`;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const plan = await (await fetch(`${base}?message=${reply.id}`, { headers: h })).json();
  assert.equal(plan.models.length, 2);
  assert.equal(calls.length, 0);
  const res = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ message: reply.id, models: plan.models.map((m: { providerId: string; model: string }) => ({ providerId: m.providerId, model: m.model })) }) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.answers.length, 3);
  assert.equal(calls.length, 2);
  // A user message is not a reply.
  const user = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.equal((await fetch(`${base}?message=${user.id}`, { headers: h })).status, 404);
  // Only the model that answered is connected: 409 with a plain reason.
  app.settings.update({ providers: app.settings.get().providers.slice(0, 1) } as never);
  const none = await fetch(`${base}?message=${reply.id}`, { headers: h });
  assert.equal(none.status, 409);
  assert.match((await none.json()).error, /other model/i);
  assert.ok(SECOND_OPINION_CAP > 0);
});
