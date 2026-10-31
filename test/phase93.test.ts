// Phase 93 (CU6): supervised desktop actions. The reference desktop is the safety oracle for
// secure fields, blocked/elevated/locked windows, takeover, Stop, approvals, and act-then-look.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopConsent } from '../src/hands-desktop-consent.ts';
import { OwnerAuth } from '../src/auth.ts';
import { HandsHub } from '../src/hands.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { createSaraServer } from '../src/server.ts';
import type { AddressInfo } from 'node:net';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { call, text } from './helpers.ts';
import { desktopActionVerdict } from '../src/computer-policy.ts';
import { CU5_OPS, HANDS_OPS } from '../src/hands.ts';
import { fixtureWindows, TestDesktop } from '../src/hands-desktop.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

test('CU6 advertises the six typed desktop operations and keeps CU5 look operations', () => {
  assert.deepEqual(CU5_OPS, ['d.screens', 'd.windows', 'd.shot', 'd.elements']);
  for (const op of ['d.click', 'd.type', 'd.keys', 'd.scroll', 'd.drag', 'd.launch']) assert.ok((HANDS_OPS as readonly string[]).includes(op), op);
});

test('the fixture acts only on a fresh look and refuses secure and blocked targets', () => {
  const d = new TestDesktop();
  const shot = d.shot({ window: 'w101', marks: true });
  const typed = d.act('d.type', { viewId: shot.viewId, ref: 'e2', text: 'Taylor' });
  assert.equal(typed.changed, true);
  assert.equal((d.elements({ window: 'w101', viewId: shot.viewId }).items as { ref: string; value?: string }[]).find((x) => x.ref === 'e2')?.value, 'Taylor');
  assert.throws(() => d.act('d.type', { viewId: shot.viewId, ref: 'e3', text: 'not-a-password' }), (e: Error & { code?: string }) => e.code === 'denied_local' && /password field/i.test(e.message));
  assert.throws(() => d.act('d.click', { viewId: shot.viewId, window: 'w102', ref: 'e1' }), (e: Error & { code?: string }) => e.code === 'blocked_window');
  d.now = () => Date.now() + 25_000;
  assert.throws(() => d.act('d.click', { viewId: shot.viewId, ref: 'e5' }), (e: Error & { code?: string }) => e.code === 'stale_view');
});

test('fixture takeover pauses desktop input, keep-control continues, and stop cancels it', () => {
  const paused = new TestDesktop({ takeover: 'pause' });
  paused.ownerInput();
  assert.throws(() => paused.act('d.click', { viewId: 'v1', ref: 'e5' }), (e: Error & { code?: string }) => e.code === 'takeover');
  paused.resume();
  const keep = new TestDesktop({ takeover: 'keep' });
  keep.ownerInput();
  assert.doesNotThrow(() => keep.act('d.click', { viewId: keep.shot({ window: 'w101', marks: true }).viewId, ref: 'e5' }));
  keep.stop();
  assert.throws(() => keep.act('d.click', { viewId: 'v1', ref: 'e5' }), (e: Error & { code?: string }) => e.code === 'stopped');
});

test('desktop policy has three approval levels and the never-list cannot be bypassed', () => {
  const base = { site: 'fixture-notes', target: { role: 'button', name: 'Save' }, text: undefined } as const;
  assert.equal(desktopActionVerdict({ ...base, level: 'ask' }).act, 'ask');
  assert.equal(desktopActionVerdict({ ...base, level: 'task', taskGranted: true }).act, 'allow');
  assert.equal(desktopActionVerdict({ ...base, level: 'always' }).act, 'allow');
  assert.equal(desktopActionVerdict({ site: 'fixture-notes', target: { role: 'edit', name: 'Password', secret: true }, level: 'always' }).act, 'block');
  assert.equal(desktopActionVerdict({ site: 'fixture-notes', target: { role: 'button', name: 'Delete account' }, level: 'always' }).act, 'ask');
});

test('CU6 refs cannot be redirected to a different window or a changed control', () => {
  const d = new TestDesktop();
  const v = d.shot({ window: 'w101', marks: true }).viewId;
  assert.throws(() => d.act('d.type', { viewId: v, window: 'w104', ref: 'e2', text: 'wrong' }));
  d.windows[0].elements[1].name = 'Different field';
  assert.throws(() => d.act('d.type', { viewId: v, ref: 'e2', text: 'wrong' }), /changed|stale|look again/i);
});

test('CU6 coordinate input stays inside its picture and refuses secure fields for keys too', () => {
  const d = new TestDesktop();
  const v = d.shot({ window: 'w101', marks: true }).viewId;
  for (const a of [{ x: -1, y: 10 }, { x: 1e8, y: 10 }, { x: NaN, y: 10 }]) assert.throws(() => d.act('d.click', { viewId: v, ...a }));
  assert.throws(() => d.act('d.keys', { viewId: v, ref: 'e3', combo: 'Enter' }), /password|secure/i);
  assert.throws(() => d.act('d.keys', { viewId: v, ref: 'e2', combo: 'ImaginaryKey' }), /key|unsupported/i);
});

test('CU6 actions have observable effects and element-only looks also bind refs', () => {
  const d = new TestDesktop();
  const v = d.elements({ window: 'w101' }).viewId;
  assert.equal(typeof v, 'string');
  d.act('d.type', { viewId: v, ref: 'e2', text: 'Hello' });
  d.act('d.keys', { viewId: v, ref: 'e2', combo: 'Backspace' });
  assert.equal(d.windows[0].elements[1].value, 'Hell');
  const clicked = d.act('d.click', { viewId: v, ref: 'e5' });
  assert.ok(JSON.stringify(clicked).includes('Save'));
});

test('local approval: every action, task grants, Always, once-only risks and cancellation', async () => {
  const c = new DesktopConsent();
  const p = { op: 'd.click', task: 'task-one', target: { role: 'button', name: 'Save' } };
  let prompts = 0;
  const task = async () => { prompts++; return 'task' as const; };
  assert.equal(await c.allow(p, task), true);
  assert.equal(await c.allow(p, task), true);
  assert.equal(prompts, 1);
  assert.equal(await c.allow({ ...p, task: 'task-two' }, task), true);
  assert.equal(prompts, 2);
  c.level = 'ask';
  assert.equal(await c.allow(p, async req => { assert.deepEqual(req.choices, ['once']); prompts++; return 'once'; }), true);
  assert.equal(await c.allow(p, async () => { prompts++; return 'once'; }), true);
  assert.equal(prompts, 4, 'a previous task grant never bypasses every-action mode');
  c.level = 'always';
  assert.equal(await c.allow(p), true);
  for (const name of ['Pay', 'Delete account', 'Recovery settings']) {
    assert.equal(await c.allow({ ...p, target: { name } }, async req => { assert.deepEqual(req.choices, ['once']); return 'task'; }), false);
    assert.equal(await c.allow({ ...p, target: { name } }, async () => 'once'), true);
  }
  for (const name of ['Run as administrator', 'Delete file', "Sara's own sign-in"]) await assert.rejects(c.allow({ ...p, target: { name } }, task), /refuse|protect/i);
  await assert.rejects(c.allow({ ...p, target: { secret: true } }, task), /password/i);
  c.level = 'task'; c.clear();
  assert.equal(await c.allow(p), false, 'no local surface means no approval');
  const abort = new AbortController();
  assert.equal(await c.allow(p, async () => { abort.abort(); return 'task'; }, abort.signal), false);
  assert.equal(await c.allow(p), false, 'a cancelled card never creates a grant');
  c.now = () => 1;
  await c.allow(p, task);
  c.now = () => 16 * 60_000;
  assert.equal(await c.allow(p), false, 'a local grant expires');
});

test('locked, elevated, insecure, own, blocked and background windows refuse even direct device commands', () => {
  const d = new TestDesktop();
  const viewId = d.shot({ window: 'w101', marks: true }).viewId;
  const a = { viewId, ref: 'e2', text: 'visible text', loopback: true };
  d.transportSecure = false;
  assert.throws(() => d.act('d.type', a), /unencrypted/);
  d.transportSecure = true; d.locked = true;
  assert.throws(() => d.act('d.type', a), /locked|secure desktop/);
  d.locked = false; d.windows[0].elevated = true;
  assert.throws(() => d.act('d.type', a), /I can't control windows running as administrator/);
  d.windows[0].elevated = false; d.foreground = 'w102';
  assert.throws(() => d.act('d.type', a), /not in front/);
  d.foreground = 'w101';
  for (const window of ['w102', 'w103']) assert.throws(() => d.act('d.type', { ...a, window }));
  assert.throws(() => d.act('d.launch', { app: 'cmd.exe /c something' }), /installed|commands/);
});

test('through the real protocol and tool loop: local cards only, fresh verification, task end and password refusal', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter(d => d.kind === 'hands') });
  app.hands = hub;
  app.settings.update({ disclosureAcceptedAt: new Date().toISOString(), providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'https://example.test/v1' }], defaultProviderId: 'fixture', defaultModel: 'fake-large' });
  for (const t of createComputerTools(app)) app.tools.add(t);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fixture desktop', token: auth.newToken }) });
  assert.equal(response.status, 200);
  const pair = await response.json() as { token: string; id: string };
  const desktop = new TestDesktop();
  let cards = 0;
  const ref = new HandsRef({ server: base, token: pair.token, desktop, desktopConsent: async () => { cards++; return 'task'; }, reconnect: false, optIn: { browser: true, desktop: true } });
  try {
    await ref.start();
    for (let i = 0; !hub.hello(pair.id) && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(hub.hello(pair.id)?.approvalsHere, true);
    const conv = app.store.createConversation({ title: 'Desktop task', mode: 'chat' });
    app.script.push([call('look', 'pc_look', { window: 'w101', picture: false })], [call('type', 'pc_type', { ref: 'e2', text: 'Jordan' })], [call('click', 'pc_click', { ref: 'e5' })], text('Saved the fixture.'));
    const events: ChatEvent[] = [];
    for await (const event of runTurn(app, conv.id, 'Put Jordan in my fixture name field, then click Save.')) {
      events.push(event);
      if (event.type === 'approval') app.approvals.decide(event.approvalId, false);
    }
    assert.ok(!events.some(e => e.type === 'approval'), 'no web/phone broker card exists for desktop approval');
    const results = events.filter(e => e.type === 'tool_result');
    assert.deepEqual(results.map(r => r.status), ['ok', 'ok', 'ok'], JSON.stringify(results));
    assert.equal(cards, 1);
    assert.equal(desktop.windows[0].elements[1].value, 'Jordan');
    assert.equal(desktop.clicked, 'Save');
    assert.ok(ref.seen.filter(op => op === 'd.elements').length >= 3, 'every action gets a fresh look');
    for (let i = 0; !ref.seen.includes('c.endTask') && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(ref.seen.includes('c.endTask'), 'task end clears local grants and power lease');
    const view = await hub.request(pair.id, 'd.elements', { window: 'w101' });
    await assert.rejects(hub.request(pair.id, 'd.type', { viewId: view.result.viewId, window: 'w101', ref: 'e3', text: 'should not enter', task: 'raw' }), (e: Error & { code?: string }) => e.code === 'denied_local' && /password/.test(e.message));
    assert.equal(cards, 1, 'password fields are refused before a card');
    await new Promise(r => setTimeout(r, 1050));
    ref.desktopConsent.level = 'ask';
    let resolveCard!: (answer: 'once') => void;
    let queueCards = 0;
    ref.opts.desktopConsent = async () => { queueCards++; return queueCards === 1 ? await new Promise<'once'>(resolve => { resolveCard = resolve; }) : 'once'; };
    const first = new AbortController(), second = new AbortController();
    const look = await hub.request(pair.id, 'd.elements', { window: 'w101' });
    const pending = hub.request(pair.id, 'd.type', { window: 'w101', viewId: look.result.viewId, ref: 'e2', text: 'cancelled first' }, { signal: first.signal });
    const settledFirst = pending.catch(e => e);
    for (let i = 0; queueCards < 1 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    const queued = hub.request(pair.id, 'd.type', { window: 'w101', viewId: look.result.viewId, ref: 'e2', text: 'cancelled second' }, { signal: second.signal });
    const settledSecond = queued.catch(e => e);
    await new Promise(r => setTimeout(r, 25));
    first.abort(); second.abort();
    await Promise.all([settledFirst, settledSecond]);
    await new Promise(r => setTimeout(r, 50)); // Let the cancel frames reach the device before releasing its local card.
    resolveCard('once');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(queueCards, 1, 'a cancelled queued command never opens a late card');
    assert.equal(desktop.windows[0].elements[1].value, 'Jordan', 'neither cancelled command can act later');
  } finally {
    await ref.stop(); hub.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections(); app.store.close(); cleanup();
  }
});

test('an ordinary browser showing Sara sign-in is refused locally', () => {
  const d = new TestDesktop();
  Object.assign(d.windows[0], { app: 'msedge', origin: 'http://127.0.0.1:7885' });
  Object.assign(d, { ownOrigin: 'http://127.0.0.1:7885' });
  const view = d.elements({ window: 'w101' });
  assert.throws(() => d.act('d.type', { viewId: view.viewId, ref: 'e2', text: 'must not enter' }), /Sara|own.*sign|server/i);
});

test('fixture keys change selection and launch produces a real fixture window', () => {
  const d = new TestDesktop();
  const viewId = d.elements({ window: 'w101' }).viewId;
  d.act('d.type', { viewId, ref: 'e2', text: 'Hello' });
  d.act('d.keys', { viewId, ref: 'e2', combo: 'Ctrl+A' });
  d.act('d.keys', { viewId, ref: 'e2', combo: 'Backspace' });
  assert.equal(d.windows[0].elements[1].value, '');
  d.act('d.launch', { app: 'fixture-calculator' });
  assert.ok(d.windows.some(w => w.app === 'fixture-calculator'));
  assert.equal(d.front()?.app, 'fixture-calculator');
});

test('walk-away keeps only an active unlocked fixture task awake', () => {
  const d = new TestDesktop();
  assert.equal(d.awake, false);
  d.beginTask(true);
  assert.equal(d.awake, true);
  d.locked = true;
  assert.equal(d.awake, false);
  assert.equal(d.locked, true);
  d.locked = false;
  d.ownerInput();
  assert.equal(d.awake, false);
  d.resume();
  assert.equal(d.awake, true);
  d.endTask();
  assert.equal(d.awake, false);
});

test('container refs cannot synthesize a click onto an unapproved child', () => {
  const windows = fixtureWindows();
  windows[0].elements = [
    { role: 'group', name: 'Main', box: [10, 10, 200, 200] },
    { role: 'button', name: 'Pay', box: [90, 90, 40, 40] },
  ];
  const d = new TestDesktop({ windows });
  const viewId = d.elements({ window: 'w101' }).viewId;
  assert.throws(() => d.act('d.click', { viewId, ref: 'e1' }), /different control|container|look again/);
  assert.equal(d.clicked, '');
});

test('desktop tools are unavailable on the demo and use the pc_ exclusion boundary', () => {
  const { dir, cleanup } = tempDir(); const app = makeApp(dir, { now: new Date() });
  try { for (const tool of createComputerTools(app).filter(t => /^pc_(click|type|keys|scroll|drag|open_app)$/.test(t.spec.name))) assert.equal(tool.isAvailable?.(), false); }
  finally { app.store.close(); cleanup(); }
});

test('desktop tools and native adapters name the CU6 safety surface', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  try {
    const names = createComputerTools(app).map((t) => t.spec.name);
    for (const name of ['pc_click', 'pc_type', 'pc_keys', 'pc_scroll', 'pc_drag', 'pc_open_app']) assert.ok(names.includes(name), name);
    const win = readFileSync(join(ROOT, 'desktop/windows/src/hands.cpp'), 'utf8') + readFileSync(join(ROOT, 'desktop/windows/src/hands-screen.cpp'), 'utf8') + readFileSync(join(ROOT, 'desktop/windows/src/hands-screen.h'), 'utf8');
    const mac = readFileSync(join(ROOT, 'desktop/mac/Sources/Hands.swift'), 'utf8') + readFileSync(join(ROOT, 'desktop/mac/Sources/HandsScreen.swift'), 'utf8') + readFileSync(join(ROOT, 'desktop/mac/Sources/HandsDesktop.swift'), 'utf8');
    for (const marker of ['SendInput', 'LLMHF_INJECTED', 'Ctrl+Alt+Esc', 'SetThreadExecutionState']) assert.ok(win.includes(marker), marker);
    for (const marker of ['AXUIElement', 'CGEvent', 'eventSourceUserData', '⌃⌥Esc', 'IOPMAssertion']) assert.ok(mac.includes(marker), marker);
  } finally {
    app.store.close();
    cleanup();
  }
});
