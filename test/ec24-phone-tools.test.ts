// EC24 (docs/ops/EC24_DESIGN.md): phone_camera, phone_location and phone_screen in a real chat turn,
// with a fake paired device answering through the broker: the picture reaches her model and her
// reply, a Deny and a timeout come back as plain words, location is coarse, and the tools are only
// offered to the owner with a helper device, never under the pin, never in partner/group chats, and
// in private local mode only to a model on this computer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { PhoneHelper } from '../src/phone-helper.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { createPhoneTools, PHONE_TOOLS } from '../src/tools/phone.ts';
import { call, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);

type Answer = Record<string, unknown> | 'silent';
function setup(t: { after: (fn: () => void) => void }, o: { pins?: Record<string, unknown>; answer?: Answer; timeoutMs?: number; device?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T10:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [CLOUD], defaultProviderId: CLOUD.id, defaultModel: CLOUD.defaultModel, ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() } as never);
  const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  const pol = new PolicyStore(dir);
  setPolicy(pol);
  const helper = new PhoneHelper({ dir, events: app.events, timeoutMs: o.timeoutMs ?? 2000, alive: () => true, label: () => 'Pixel 9' });
  if (o.device !== false) helper.setDevice('s-phone', true);
  // A device switched on before the admin pinned it off stays listed but is never asked.
  if (o.pins) pol.set({ name: 'Family rules', pins: o.pins });
  app.phoneHelper = helper;
  for (const tl of createPhoneTools(app)) app.tools.add(tl);
  const asked: string[] = [];
  // The fake paired device: answers every prompt it is shown.
  app.events!.subscribe((ev) => {
    if (ev.type !== 'helper' || ev.state !== 'asking') return;
    asked.push(ev.kind);
    if (o.answer === 'silent') return;
    setTimeout(() => helper.answer(ev.id, 's-phone', o.answer as Record<string, unknown> ?? { allow: true, image: `data:image/jpeg;base64,${JPEG.toString('base64')}` }), 20);
  });
  t.after(() => {
    helper.cancelAll();
    setPolicy(new PolicyStore());
    setAuditTrail(undefined);
    app.store.close();
    cleanup();
  });
  return { app, helper, asked, trail };
}
async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const results = (evs: ChatEvent[]) => evs.filter((e): e is Extract<ChatEvent, { type: 'tool_result' }> => e.type === 'tool_result');
const offered = (app: TestApp, i = 0) => (app.requests[i]?.tools ?? []).map((s) => s.name);

test('phone_camera: the phone is asked, the picture reaches her model and her reply', async (t) => {
  const { app, asked } = setup(t);
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'phone_camera', { reason: 'See the plant' })], text('It looks thirsty.'));
  const evs = await drain(runTurn(app, conv.id, 'look at my plant'));
  for (const n of PHONE_TOOLS) assert.ok(offered(app).includes(n), `${n} offered`);
  assert.deepEqual(asked, ['camera']);
  const r = results(evs)[0];
  assert.equal(r.status, 'ok', r.output);
  assert.match(r.output, /picture/i);
  assert.equal(evs.some((e) => e.type === 'approval'), false, 'the approval is on the phone, not a second card');
  const reply = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal((reply.meta?.images as string[] | undefined)?.length, 1, 'the picture is on her reply for him');
  assert.ok(JSON.stringify(app.requests[1].messages).includes('image'), 'her model sees it');
});

test('phone_location: coarse by default; Deny and timeout come back as plain words', async (t) => {
  const { app } = setup(t, { answer: { allow: true, lat: 48.858372, lon: 2.294481, accuracy: 15 } });
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'phone_location', { reason: 'Weather where you are' })], text('Sunny.'));
  const r = results(await drain(runTurn(app, conv.id, 'weather here?')))[0];
  assert.match(r.output, /48\.86, 2\.29/);
  assert.ok(!r.output.includes('48.858'), 'never the exact spot unless asked');
});

test('Deny: she is told he said no', async (t) => {
  const { app } = setup(t, { answer: { allow: false } });
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'phone_screen', { reason: 'See the error' })], text('OK.'));
  const r = results(await drain(runTurn(app, conv.id, 'look at my screen')))[0];
  assert.match(r.output, /Deny/);
});

test('timeout: the phone did not answer', async (t) => {
  const { app } = setup(t, { answer: 'silent', timeoutMs: 80 });
  const conv = app.store.createConversation({});
  app.script.push([call('c1', 'phone_camera', { reason: 'x' })], text('OK.'));
  const r = results(await drain(runTurn(app, conv.id, 'photo')))[0];
  assert.match(r.output, /didn't answer/);
});

test('not offered: no helper device, under the pin, or in a household member space', async (t) => {
  const a = setup(t, { device: false });
  const conv = a.app.store.createConversation({});
  a.app.script.push(text('Hi.'));
  await drain(runTurn(a.app, conv.id, 'hi'));
  for (const n of PHONE_TOOLS) assert.ok(!offered(a.app).includes(n), `${n} hidden without a device`);
});

test('pin phoneHelper:false hides the tools and never asks the phone', async (t) => {
  const { app, asked } = setup(t, { pins: { phoneHelper: false } });
  const conv = app.store.createConversation({});
  app.script.push(text('Hi.'));
  await drain(runTurn(app, conv.id, 'hi'));
  for (const n of PHONE_TOOLS) assert.ok(!offered(app).includes(n));
  assert.deepEqual(asked, []);
});

test('owner only: partner conversations and private local mode with a cloud model refuse before asking', async (t) => {
  const { app, asked } = setup(t);
  const tool = app.tools.get('phone_camera')!;
  const partner = app.store.createConversation({ partner: 'sam' });
  const base = { workspaceDir: '', signal: new AbortController().signal, sandbox: app.sandbox, canSee: true, modelLocal: false };
  assert.match(await tool.run({ reason: 'x' }, { ...base, conversationId: partner.id }), /only in your own chats/i);
  const priv = app.store.createConversation({ private: true });
  assert.match(await tool.run({ reason: 'x' }, { ...base, conversationId: priv.id }), /model on this computer/i);
  assert.deepEqual(asked, [], 'the phone was never asked');
  const member = makeApp(tempDir().dir, { now: new Date() });
  member.member = {} as never;
  member.phoneHelper = app.phoneHelper;
  assert.deepEqual(createPhoneTools(member).map((x: { isAvailable?: () => boolean }) => x.isAvailable?.()), [false, false, false], 'never in a member space');
});
