// EC21 (docs/ops/EC2122_DESIGN.md): code mode in a real chat turn. Every call a script makes goes
// through the turn's own call path: the permission resolver, the approval card, the policy ceiling,
// the audit row and the receipts. The runner itself is tested in test/ec21-runner.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { RUN_CODE } from '../src/code-mode.ts';
import { codeModeOffer, mergeLean, normLean } from '../src/lean.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };

function tool(name: string, perm: 'auto' | 'ask', ran: string[], out = `${name} result`): Tool {
  return {
    spec: { name, description: `The ${name} tool. Reads things.`, parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    defaultPermission: perm,
    source: 'built-in',
    summarize: (a) => `${name} ${String(a.q ?? '')}`.trim(),
    run: async (a) => {
      ran.push(`${name}:${String(a.q ?? '')}`);
      return out;
    },
  };
}

function setup(t: { after: (fn: () => void) => void }, o: { codeMode?: boolean; pins?: Record<string, unknown> } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T10:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  const ran: string[] = [];
  for (const n of ['read_a', 'read_b', 'read_c']) app.tools.add(tool(n, 'auto', ran));
  app.tools.add(tool('ask_tool', 'ask', ran));
  app.tools.add(tool('off_tool', 'auto', ran));
  app.settings.update({ providers: [CLOUD], defaultProviderId: CLOUD.id, defaultModel: CLOUD.defaultModel, ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { off_tool: 'never' }, lean: normLean({ tools: { mode: 'off', codeMode: o.codeMode ?? true } }) } as never);
  const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  const pol = new PolicyStore(dir);
  if (o.pins) pol.set({ name: 'Family rules', pins: o.pins });
  setPolicy(pol);
  t.after(() => {
    setPolicy(new PolicyStore());
    setAuditTrail(undefined);
    app.store.close();
    cleanup();
  });
  return { app, ran, trail };
}

async function drain(gen: AsyncGenerator<ChatEvent>, app: TestApp, answer = true): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') setTimeout(() => app.approvals.decide(ev.approvalId, answer), 50);
  }
  return out;
}
const results = (evs: ChatEvent[]) => evs.filter((e): e is Extract<ChatEvent, { type: 'tool_result' }> => e.type === 'tool_result');
const offeredNames = (app: TestApp, i: number) => (app.requests[i].tools ?? []).map((s) => s.name);

test('offer rule: on, not partner/group, and many calls (coding, or 2+ calls this turn)', () => {
  assert.equal(codeModeOffer({ on: false, mode: 'coding', callsThisTurn: 9 }), false);
  assert.equal(codeModeOffer({ on: true, mode: 'coding', callsThisTurn: 0 }), true);
  assert.equal(codeModeOffer({ on: true, mode: 'chat', callsThisTurn: 1 }), false);
  assert.equal(codeModeOffer({ on: true, mode: 'chat', callsThisTurn: 2 }), true);
  assert.equal(codeModeOffer({ on: true, mode: 'coding', callsThisTurn: 3, partner: true }), false);
  assert.equal(codeModeOffer({ on: true, mode: 'coding', callsThisTurn: 3, group: true }), false);
});

test('a script calling 3 read-only tools returns the combined result; each inner call is a receipt and a step', async (t) => {
  const { app, ran, trail } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  const code = "const a = await tools.read_a({ q: '1' }); const b = await tools.read_b({ q: '2' }); const c = await tools.read_c({ q: '3' }); return [a, b, c].join(' + ');";
  app.script.push([call('c1', RUN_CODE, { code, purpose: 'read three things' })], text('All three read.'));
  const evs = await drain(runTurn(app, conv.id, 'read a, b and c'), app);
  assert.ok(offeredNames(app, 0).includes(RUN_CODE), 'offered in a coding chat');
  const spec = app.requests[0].tools!.find((s) => s.name === RUN_CODE)!;
  assert.match(spec.description, /read_a\(args\?: \{ q\?: string \}\): Promise<string>;/);
  assert.doesNotMatch(spec.description, /off_tool|run_code\(/);
  assert.deepEqual(ran, ['read_a:1', 'read_b:2', 'read_c:3']);
  const rs = results(evs);
  assert.deepEqual(rs.map((r) => `${r.id} ${r.name} ${r.status}`), ['c1~1 read_a ok', 'c1~2 read_b ok', 'c1~3 read_c ok', `c1 ${RUN_CODE} ok`]);
  assert.match(rs[3].output, /^read_a result \+ read_b result \+ read_c result/);
  assert.match(rs[3].output, /Calls \(3\): read_a ok, read_b ok, read_c ok/);
  const msg = app.store.messages(conv.id).find((m) => m.role === 'tool' && m.meta?.name === RUN_CODE)!;
  assert.deepEqual((msg.meta!.inner as { name: string; status: string }[]).map((c) => `${c.name} ${c.status}`), ['read_a ok', 'read_b ok', 'read_c ok']);
  // The model's next step sees only run_code's result (inner calls are not in its history).
  const toolMsgs = app.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => (m as { toolCallId?: string }).toolCallId), ['c1']);
  // One audit row for the run (never the code).
  const row = trail.list({}).find((r) => r.action === 'code.run');
  assert.ok(row, 'a code.run audit row');
  assert.equal(row!.outcome, 'ok');
  assert.ok(!JSON.stringify(row).includes('tools.read_a'));
});

test('an ask tool inside a script shows the normal approval card and the script waits for the answer', async (t) => {
  const { app, ran, trail } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  const code = "const a = await tools.read_a({}); const x = await tools.ask_tool({ q: 'go' }); return `${a} / ${x}`;";
  app.script.push([call('c1', RUN_CODE, { code })], text('Done.'));
  const evs = await drain(runTurn(app, conv.id, 'do it'), app, true);
  const card = evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.ok(card, 'the approval card');
  assert.equal(card.id, 'c1~2');
  assert.equal(card.name, 'ask_tool');
  assert.deepEqual(ran, ['read_a:', 'ask_tool:go']);
  assert.match(results(evs).at(-1)!.output, /read_a result \/ ask_tool result/);
  assert.ok(trail.list({}).some((r) => r.action === 'approval.decided' && r.target === 'ask_tool' && r.outcome === 'ok'));
});

test('a declined card makes the call throw ToolDenied inside the script (nothing ran)', async (t) => {
  const { app, ran } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('c1', RUN_CODE, { code: "try { await tools.ask_tool({}); return 'ran'; } catch (e) { return `${e.name}: ${e.message}`; }" })], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'try'), app, false);
  assert.deepEqual(ran, []);
  assert.match(results(evs).at(-1)!.output, /^ToolDenied: The owner declined this action\./);
});

test('a tool the owner turned off fails the script cleanly', async (t) => {
  const { app, ran } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('c1', RUN_CODE, { code: "await tools.read_a({}); await tools.off_tool({}); return 'never';" })], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'try'), app);
  assert.deepEqual(ran, ['read_a:']);
  const last = results(evs).at(-1)!;
  assert.equal(last.name, RUN_CODE);
  assert.equal(last.status, 'error');
  assert.match(last.output, /^Error: ToolDenied: The (owner has disabled the off_tool tool|off_tool tool isn't available (to scripts )?here)./);
});

test('a script can not call run_code or find_tools, and a policy ceiling applies inside', async (t) => {
  const { app, ran } = setup(t, { pins: { tools: { read_b: 'ask' } } });
  const conv = app.store.createConversation({ mode: 'coding' });
  const code = "const out = []; for (const n of ['run_code', 'find_tools']) { try { await tools[n]({}); out.push('ran'); } catch (e) { out.push(e.name); } } try { await tools.read_b({}); out.push('ran'); } catch (e) { out.push(e.name); } return out.join(',');";
  app.script.push([call('c1', RUN_CODE, { code })], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'try'), app, false);
  assert.deepEqual(ran, []);
  const card = evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.equal(card?.name, 'read_b', 'the ceiling (ask) beats the tool’s own auto inside a script');
  assert.match(results(evs).at(-1)!.output, /^ToolDenied,ToolDenied,ToolDenied/);
});

test('in a chat it is offered only after a step with 2+ calls; off by default; the policy pin hides it and refuses the setting', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('a', 'read_a', {}), call('b', 'read_b', {})], text('ok'));
  await drain(runTurn(app, conv.id, 'look'), app);
  assert.ok(!offeredNames(app, 0).includes(RUN_CODE));
  assert.ok(offeredNames(app, 1).includes(RUN_CODE));

  const off = setup(t, { codeMode: false });
  const c2 = off.app.store.createConversation({ mode: 'coding' });
  off.app.script.push([call('c1', RUN_CODE, { code: 'return 1' })], text('ok'));
  const evs = await drain(runTurn(off.app, c2.id, 'x'), off.app);
  assert.ok(!offeredNames(off.app, 0).includes(RUN_CODE));
  assert.equal(results(evs)[0].status, 'denied');
  assert.equal(normLean(undefined).tools.codeMode, false, 'off by default');

  const pinned = setup(t, { pins: { codeMode: false } });
  const c3 = pinned.app.store.createConversation({ mode: 'coding' });
  pinned.app.script.push(text('ok'));
  await drain(runTurn(pinned.app, c3.id, 'x'), pinned.app);
  assert.ok(!offeredNames(pinned.app, 0).includes(RUN_CODE));
  assert.throws(() => mergeLean(pinned.app, { tools: { codeMode: true } }), (e: Error & { status?: number }) => e.status === 409);
  assert.doesNotThrow(() => mergeLean(pinned.app, { tools: { codeMode: false } }));
});
