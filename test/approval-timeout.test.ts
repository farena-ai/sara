// 3.0.3 (owner): an approval nobody answers in time is refused by the broker; the chat says so.
// The step reads "Not approved in time", the run card opens for it like a failure, and the approval
// card stays as a quiet resolved card (no buttons) instead of vanishing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { NOT_IN_TIME, runTurn, type ChatEvent } from '../src/chat.ts';
import { ApprovalBroker } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('broker: only a wait that ran out counts as timed out (not an answer, not the caller ending)', async () => {
  const b = new ApprovalBroker(40);
  const late = b.request('c', new AbortController().signal);
  assert.equal(await late.decision, false);
  assert.equal(b.timedOut(late.id), true);
  assert.equal(b.state(late.id), 'expired');
  const no = b.request('c', new AbortController().signal);
  b.decide(no.id, false);
  assert.equal(await no.decision, false);
  assert.equal(b.timedOut(no.id), false, 'a no is a no');
  const ac = new AbortController();
  const gone = b.request('c', ac.signal);
  ac.abort();
  assert.equal(await gone.decision, false);
  assert.equal(b.timedOut(gone.id), false, 'the turn ended: cancelled, not late');
});

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-09T15:00:00Z') };
  const app = makeApp(dir, clock);
  (app as { approvals: ApprovalBroker }).approvals = new ApprovalBroker(60);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
  const ran: string[] = [];
  const ask: Tool = { spec: { name: 'send_note', description: 'Send a note', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => 'Send a note', run: async () => (ran.push('sent'), 'sent') };
  app.tools.add(ask);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, ran };
}

test('chat: a timed-out approval ends as "Not approved in time", saved on the step, nothing ran', async (t) => {
  const { app, ran } = rig(t);
  const conv = app.store.createConversation({});
  app.script.push([call('n1', 'send_note', {})], text('Okay, I did not send it.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'send the note')) evs.push(ev); // nobody answers the card
  assert.ok(evs.some((e) => e.type === 'approval'));
  const res = evs.find((e): e is Extract<ChatEvent, { type: 'tool_result' }> => e.type === 'tool_result')!;
  assert.equal(res.status, 'denied');
  assert.equal(res.timedOut, true);
  assert.equal(res.output, NOT_IN_TIME);
  assert.deepEqual(ran, []);
  const tool = app.store.messages(conv.id).find((m) => m.role === 'tool')!;
  assert.equal(tool.meta?.timedOut, true, 'kept for the redraw');
  assert.equal(tool.meta?.status, 'denied');
});

test('chat: a plain "no" is still "Not allowed" (no timedOut flag)', async (t) => {
  const { app } = rig(t);
  const conv = app.store.createConversation({});
  app.script.push([call('n1', 'send_note', {})], text('Fine.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'send the note')) {
    evs.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, false);
  }
  const res = evs.find((e): e is Extract<ChatEvent, { type: 'tool_result' }> => e.type === 'tool_result')!;
  assert.equal(res.status, 'denied');
  assert.equal(res.timedOut, undefined);
  assert.equal(res.output, 'The owner declined this action.');
});

test('web: the step, the run card and the approval card show the timeout', () => {
  const steps = read('web', 'steps.js');
  assert.match(steps, /step\.status === 'denied' && step\.timedOut \? t\('Not approved in time: \{what\}'/);
  assert.match(steps, /export function finishStep\(box, \{ id, status, output, ms, snapshotId, timedOut \}\)/);
  assert.match(steps, /\.\.\.\(timedOut \? \{ timedOut: true \} : \{\}\)/);
  assert.match(read('web', 'run-model.js'), /timedOut: list\.filter\(\(s\) => s\.status === 'denied' && s\.timedOut\)\.length/);
  assert.equal((read('web', 'run-timeline.js').match(/errors: m\.errors \+ m\.timedOut/g) ?? []).length, 2, 'opens like a failed step');
  const app = read('web', 'app.js');
  assert.match(app, /if \(ev\.timedOut && asked\) approvalTimedOut\(asked\);\s*else asked\?\.remove\(\);/);
  assert.match(app, /timedOut: m\.meta\?\.timedOut \}\);/, 'the redraw keeps it');
  assert.match(app, /if \(m\.meta\?\.timedOut && m\.meta\?\.status === 'denied'\) els\.push\(lateApprovalCard\(m\.meta\)\);/, 'and its resolved card');
  const fn = app.slice(app.indexOf('function approvalTimedOut(card)'), app.indexOf('function approvalCard('));
  assert.match(fn, /card\.classList\.add\('approval-resolved'\);\s*card\.dataset\.late = '';/);
  assert.match(fn, /for \(const b of card\.querySelectorAll\('button'\)\) b\.remove\(\);/);
  assert.ok(read('web', 'style.css').includes('.approval.approval-resolved { border-style: dashed; box-shadow: none; animation: none; opacity: .8; }'));
  // A resolved card is not a waiting approval for her panel.
  assert.doesNotMatch(read('web', 'her-panel.js'), /'#messages \.approval'/);
  assert.match(read('web', 'run-view.js'), /timeout: \(\) => t\('not answered in time'\)/);
});
