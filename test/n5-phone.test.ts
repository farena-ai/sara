// N5b (docs/PHONE.md): share to Sara, quick actions on notifications, the widget's data, car mode.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { LibraryStore } from '../src/library/store.ts';
import { actTokenSpace, CAR_BLOCKED_TOOL, CAR_OFF_RE, CAR_ON_RE, parseMultipart, phoneMayApprove, PhoneActions, sharePrefill } from '../src/phone-actions.ts';
import { PushService, type PushPayload } from '../src/push.ts';
import { createSaraServer } from '../src/server.ts';
import { ApprovalBroker } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { Vault } from '../src/vault.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// ------------------------------------------------------------------ tokens (unit)

test('action tokens: bound to item, actions, space and companion; expire; one use', () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date() });
    let now = 1_000_000;
    const acts = new PhoneActions(app.store.db, new Vault(dir), { space: 'owner', now: () => now });
    const tok = acts.mint({ kind: 'reminder', id: '5', conv: 'c1', acts: ['snooze'] });
    assert.equal(actTokenSpace(tok), 'owner');
    const c = acts.check(tok, { action: 'snooze' });
    assert.equal(c.id, '5');
    assert.equal(c.kind, 'reminder');
    assert.throws(() => acts.check(tok, { action: 'approve' }), /not offered/, 'only the actions it was made for');
    assert.throws(() => acts.check(tok, { action: 'snooze', companion: 'other' }), /someone else/, 'companion bound');
    // Tampered: another item id with the old signature.
    const [pre, space, body, sig] = [tok.slice(0, 9), ...tok.slice(9).split('.')];
    const forged = JSON.parse(Buffer.from(body!, 'base64url').toString());
    forged.id = '6';
    assert.throws(() => acts.check(`${pre}${space}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, { action: 'snooze' }), /not valid/);
    // Another space (a household member's key) can't use it, nor make one for here.
    mkdirSync(join(dir, 'm'), { recursive: true });
    const member = new PhoneActions(app.store.db, new Vault(join(dir, 'm')), { space: 'm1', now: () => now });
    assert.throws(() => member.check(tok, { action: 'snooze' }), /someone else/);
    const theirs = member.mint({ kind: 'reminder', id: '5', acts: ['snooze'] });
    assert.throws(() => acts.check(theirs, { action: 'snooze' }), /someone else/);
    assert.throws(() => acts.check(theirs.replace('sara_act.m1.', 'sara_act.owner.'), { action: 'snooze' }), /not valid/);
    // One use.
    acts.spend(c);
    assert.throws(() => acts.check(tok, { action: 'snooze' }), /already done/);
    assert.throws(() => acts.spend(c), /already done/);
    // Expiry: approvals 15 minutes, reminders 2 hours.
    const ap = acts.mint({ kind: 'approval', id: 'a', conv: 'c', acts: ['approve'] });
    const rem = acts.mint({ kind: 'reminder', id: '9', acts: ['snooze'] });
    now += 16 * 60_000;
    assert.throws(() => acts.check(ap, { action: 'approve' }), /too old/);
    assert.ok(acts.check(rem, { action: 'snooze' }));
    now += 2 * 3600_000;
    assert.throws(() => acts.check(rem, { action: 'snooze' }), /too old/);
    assert.throws(() => acts.check('sara_act.owner.x', { action: 'snooze' }), /not valid/);
    app.store.close();
  } finally {
    cleanup();
  }
});

test('policy: computer use and choice cards are never approved from the phone', () => {
  assert.equal(phoneMayApprove({ name: 'send_note' }), true);
  for (const name of ['pc_click', 'pc_browser_click', 'browser_click', 'pc_fill_form']) assert.equal(phoneMayApprove({ name }), false, name);
  assert.equal(phoneMayApprove({ name: 'run_command', computer: {} }), false);
  assert.equal(phoneMayApprove({ name: 'write_file', contradiction: {} }), false);
  assert.equal(phoneMayApprove({ name: 'run_command', sandbox: {} }), false);
  assert.equal(phoneMayApprove({ name: 'buy', spend: {} }), false);
  assert.equal(phoneMayApprove({ name: 'mail_send', untrusted: true }), false);
});

test('share: multipart reader and the ready message (a receipt photo suggests an expense)', () => {
  const b = '----x1';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nLunch\r\n--${b}\r\nContent-Disposition: form-data; name="files"; filename="receipt.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a]),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const parts = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.data.toString(), 'Lunch');
  assert.equal(parts[1]!.filename, 'receipt.jpg');
  assert.deepEqual([...parts[1]!.data], [0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a], 'binary kept exactly');
  assert.match(sharePrefill({ files: [{ name: 'receipt.jpg', type: 'image/jpeg' }] }).key, /receipt.*expense/);
  assert.match(sharePrefill({ files: [{ name: 'IMG_1.jpg', type: 'image/jpeg' }] }).key, /photo/);
  assert.match(sharePrefill({ text: 'look', url: 'https://example.com/a', files: [] }).key, /link/);
  assert.equal(sharePrefill({ text: 'just words', files: [] }).params.what, 'just words');
});

test('car mode: spoken switches, blocked tools', () => {
  for (const s of ['car mode', 'Car mode on', 'turn on car mode', 'modo coche', 'mode voiture', 'Automodus', 'modalità auto', 'modo carro']) assert.match(s, CAR_ON_RE, s);
  for (const s of ['car mode off', 'exit car mode', 'turn off car mode']) assert.match(s, CAR_OFF_RE, s);
  assert.doesNotMatch('tell me about car mode in teslas', CAR_ON_RE);
  for (const n of ['pc_click', 'browser_open', 'goal_start', 'research_start', 'team_run', 'write_file', 'make_document']) assert.equal(CAR_BLOCKED_TOOL(n), true, n);
  for (const n of ['reminder_add', 'expense_add', 'weather', 'calendar_add']) assert.equal(CAR_BLOCKED_TOOL(n), false, n);
});

test('car mode: the turn gets the short spoken note and no computer-use tools', async () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-14T15:00:00Z') };
  const app = makeApp(dir, clock);
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
    const pc: Tool = { spec: { name: 'pc_click', description: 'Click on the PC', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => 'click', run: async () => 'ok' };
    app.tools.add(pc);
    const conv = app.store.createConversation({});
    const other = app.store.createConversation({});
    app.store.addMessage(other.id, 'assistant', 'Reminder: pick up the dry cleaning', { reminder: { id: 1 } });
    for await (const _ of runTurn(app, conv.id, 'click the button on my pc', undefined, { car: true }));
    const carReq = app.requests.at(-1)!;
    const sys = JSON.stringify(carReq.messages);
    assert.match(sys, /driving and using car mode/);
    assert.match(sys, /at most two short spoken sentences/);
    assert.match(sys, /pick up the dry cleaning/, 'her newest message is ready to read aloud');
    assert.ok(!(carReq.tools ?? []).some((t) => t.name === 'pc_click'));
    for await (const _ of runTurn(app, conv.id, 'click the button on my pc'));
    assert.doesNotMatch(JSON.stringify(app.requests.at(-1)!.messages), /car mode/);
  } finally {
    app.store.close();
    cleanup();
  }
});

// ------------------------------------------------------------------ routes

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-14T15:00:00Z') };
const app = makeApp(dir, clock);
(app as { approvals: ApprovalBroker }).approvals = new ApprovalBroker(5000);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
app.library = new LibraryStore(app.store.db, dir, () => clock.now);
const pushed: PushPayload[] = [];
const push = new PushService(app.store.db, app.vault, app.settings, { now: () => clock.now });
push.sendAll = async (p) => (pushed.push(p), { sent: 1, failed: 0, removed: 0 });
app.push = push;
const ran: string[] = [];
const tool = (name: string): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => `Do ${name}`, run: async () => (ran.push(name), 'done') });
app.tools.add(tool('send_note'));
app.tools.add(tool('pc_click'));
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
  cleanup();
});
const owner = { authorization: `Bearer ${token}` };
const act = (tok: string, action: string, extra: Record<string, unknown> = {}) => fetch(`${base}/api/phone/act`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
const until = async (ok: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !ok(); t += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), 'timed out');
};

/** Starts a turn whose tool asks; resolves with the stream's text promise once the push went out. */
async function askingTurn(toolName: string, words: string) {
  const conv = app.store.createConversation({});
  app.script.push([call('t1', toolName, {})], text('Finished.'));
  const n = pushed.length;
  const res = fetch(`${base}/api/conversations/${conv.id}/messages`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: JSON.stringify({ content: words }) }).then((r) => r.text());
  await until(() => pushed.length > n);
  return { conv, res, note: pushed.at(-1)! };
}

test('approve from the notification: a plain card has Approve/Decline; the token works once', async () => {
  const { conv, res, note } = await askingTurn('send_note', 'please send the note now');
  assert.deepEqual(note.actions?.map((a) => a.action), ['approve', 'decline']);
  assert.ok(note.act?.startsWith('sara_act.owner.'));
  assert.equal(note.url, `/#c=${conv.id}`);
  const r = await act(note.act!, 'approve');
  assert.equal(r.status, 200, await r.clone().text());
  await res;
  assert.deepEqual(ran, ['send_note']);
  assert.equal((await act(note.act!, 'approve')).status, 409, 'single use');
});

test('decline from the notification runs nothing', async () => {
  ran.length = 0;
  const { res, note } = await askingTurn('send_note', 'please send the note now');
  assert.equal((await act(note.act!, 'decline')).status, 200);
  await res;
  assert.deepEqual(ran, []);
});

test('computer-use approvals stay on the PC: no buttons, and a forged token is refused', async () => {
  ran.length = 0;
  const { conv, res, note } = await askingTurn('pc_click', 'click it on my pc please');
  assert.equal(note.actions, undefined, 'no Approve on a computer-use card');
  assert.equal(note.act, undefined);
  const waiting = app.approvals.pendingFor(conv.id)[0]!;
  const forged = push.actions.mint({ kind: 'approval', id: waiting, conv: conv.id, acts: ['approve'] });
  const r = await act(forged, 'approve');
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /computer itself/);
  assert.deepEqual(ran, []);
  app.approvals.decide(waiting, false);
  await res;
  // A token bound to another conversation's card doesn't reach this one.
  const other = push.actions.mint({ kind: 'approval', id: waiting, conv: 'nope', acts: ['approve'] });
  assert.equal((await act(other, 'approve')).status, 404);
});

test('reminders: Snooze 1 h makes a new reminder an hour later; Reply posts to the chat', async () => {
  const conv = app.store.createConversation({});
  const r = app.planner!.addReminder({ text: 'Call the dentist', dueAt: clock.now.toISOString(), conversationId: conv.id });
  const msg = app.store.addMessage(conv.id, 'assistant', 'Call the dentist', { reminder: { id: r.id } });
  await push.onEvent({ type: 'message', conversationId: conv.id, message: msg, reason: 'reminder' }, 'Sara', () => false);
  const note = pushed.at(-1)!;
  assert.deepEqual(note.actions?.map((a) => a.action), ['snooze', 'reply']);
  assert.equal(note.actions?.[1]?.type, 'text', 'inline reply where the phone supports it');
  const s = await act(note.act!, 'snooze');
  assert.equal(s.status, 200);
  const again = app.planner!.reminders({ status: 'pending' }).filter((x) => x.text === 'Call the dentist').map((x) => x.dueAt).sort();
  assert.ok(again.includes(new Date(clock.now.getTime() + 3600_000).toISOString()));
  // A message from her: Reply only.
  const m2 = app.store.addMessage(conv.id, 'assistant', 'Thinking of you', { proactive: true });
  await push.onEvent({ type: 'message', conversationId: conv.id, message: m2, reason: 'proactive' }, 'Sara', () => false);
  const n2 = pushed.at(-1)!;
  assert.deepEqual(n2.actions?.map((a) => a.action), ['reply']);
  assert.equal((await act(n2.act!, 'reply', { reply: '' })).status, 400);
  assert.equal((await act(n2.act!, 'snooze')).status, 400, 'not offered here');
  assert.equal((await act(n2.act!, 'reply', { reply: 'On my way home' })).status, 200);
  await until(() => app.store.messages(conv.id).some((m) => m.role === 'user' && m.content === 'On my way home'));
});

test('inbox Accept and a waiting automation answer through their own stores', async () => {
  const accepted: number[] = [];
  (app as { inbox?: unknown }).inbox = { list: () => [{ id: 7 }], accept: async (id: number) => (accepted.push(id), {}) };
  const tok = push.actions.mint({ kind: 'inbox', id: '7', acts: ['accept'] });
  assert.equal((await act(tok, 'accept')).status, 200);
  assert.deepEqual(accepted, [7]);
  const gone = push.actions.mint({ kind: 'inbox', id: '8', acts: ['accept'] });
  assert.equal((await act(gone, 'accept')).status, 404);
  const answers: [number, boolean][] = [];
  (app as { automations?: unknown }).automations = { answer: async (id: number, ok: boolean) => (answers.push([id, ok]), {}) };
  assert.equal((await act(push.actions.mint({ kind: 'automation', id: '3', acts: ['approve', 'decline'] }), 'decline')).status, 200);
  assert.deepEqual(answers, [[3, false]]);
  delete (app as { inbox?: unknown }).inbox;
  delete (app as { automations?: unknown }).automations;
});

test('the act route needs its token (not a cookie or the owner token)', async () => {
  assert.equal((await fetch(`${base}/api/phone/act`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: '{"action":"approve"}' })).status, 401);
  assert.equal((await act('sara_act.owner.zz.yy', 'approve')).status, 401);
});

test('share: files go to the Library and a new chat opens with the ready message', async () => {
  const fd = new FormData();
  fd.append('title', 'Lunch');
  fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }), 'receipt.png');
  fd.append('files', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'setup.exe');
  const r = await fetch(`${base}/api/phone/share`, { method: 'POST', headers: { ...owner, accept: 'application/json' }, body: fd });
  assert.equal(r.status, 201, await r.clone().text());
  const j = await r.json();
  assert.match(j.prefill, /receipt.*expense/i);
  assert.deepEqual(j.skipped, ['setup.exe'], 'only files she can read');
  assert.equal(j.docs.length, 1);
  assert.equal(app.library!.get(j.docs[0].id)?.keep, true, 'kept in the Library');
  assert.ok(app.store.getConversation(j.conversationId));
  assert.match(j.url, new RegExp(`^/#c=${j.conversationId}&draft=.+&docs=${j.docs[0].id}$`));
  // A share-target navigation (no JSON): a 303 to the chat; without a session: to sign-in.
  const fd2 = new FormData();
  fd2.append('url', 'https://example.com/recipe');
  const nav = await fetch(`${base}/api/phone/share`, { method: 'POST', headers: { ...owner, origin: 'null' }, body: fd2, redirect: 'manual' });
  assert.equal(nav.status, 303);
  assert.match(nav.headers.get('location')!, /^\/#c=[\w-]+&draft=Here's%20a%20link/);
  const anon = await fetch(`${base}/api/phone/share`, { method: 'POST', body: fd2, redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get('location'), '/#share=signin');
  assert.equal((await fetch(`${base}/api/phone/share`, { method: 'POST', headers: { accept: 'application/json' }, body: fd2 })).status, 401);
  assert.equal((await fetch(`${base}/api/phone/share`, { method: 'POST', headers: { ...owner, accept: 'application/json' }, body: new FormData() })).status, 400);
});

test('widget: signed in only; next reminder, active watches and Talk to Sara', async () => {
  assert.equal((await fetch(`${base}/api/phone/widget`)).status, 401);
  app.store.db.exec('DELETE FROM reminders');
  app.planner!.addReminder({ text: 'Later one', dueAt: new Date(clock.now.getTime() + 7200_000).toISOString() });
  app.planner!.addReminder({ text: 'Water the plants', dueAt: new Date(clock.now.getTime() + 1800_000).toISOString() });
  (app as { liveWatches?: unknown }).liveWatches = { list: () => [{ state: 'active' }, { state: 'paused' }] };
  (app as { productWatches?: unknown }).productWatches = { list: () => [{ state: 'active' }] };
  const j = await (await fetch(`${base}/api/phone/widget`, { headers: owner })).json();
  assert.equal(j.next.text, 'Water the plants');
  assert.equal(j.watches, 2);
  assert.equal(j.talk, '/#talk');
  delete (app as { liveWatches?: unknown }).liveWatches;
  delete (app as { productWatches?: unknown }).productWatches;
});

// ------------------------------------------------------------------ static wiring

test('PWA: share target in the manifest; the service worker shows buttons and calls the act route with the token', () => {
  const m = JSON.parse(read('web', 'manifest.webmanifest'));
  assert.equal(m.share_target.action, '/api/phone/share');
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.deepEqual(Object.keys(m.share_target.params).sort(), ['files', 'text', 'title', 'url']);
  const sw = read('web', 'sw.js');
  assert.match(sw, /actions: data\.actions/);
  assert.match(sw, /event\.action/);
  assert.match(sw, /\/api\/phone\/act/);
  assert.match(sw, /authorization: `Bearer \$\{act\}`/);
  assert.match(sw, /credentials: 'omit'/, 'no cookie needed');
  assert.match(sw, /x-sara-companion/);
});

test('Android: share sheet takes files (SEND_MULTIPLE) and the widget shows next, watches and Talk', () => {
  const man = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assert.match(man, /android:mimeType="application\/pdf"/);
  const main = read('android', 'app', 'src', 'main', 'java', 'com', 'backstagecoding', 'sara', 'MainActivity.java');
  assert.match(main, /\/api\/phone\/share/);
  const w = read('android', 'app', 'src', 'main', 'java', 'com', 'backstagecoding', 'sara', 'WidgetProvider.java');
  assert.match(w, /optInt\("watches"/);
  assert.match(w, /optJSONObject\("next"\)/);
  assert.match(w, /R\.id\.talk/);
  assert.match(read('android', 'app', 'src', 'main', 'res', 'xml', 'widget_info.xml'), /updatePeriodMillis="1800000"/);
  assert.match(read('android', 'app', 'src', 'main', 'res', 'layout', 'widget.xml'), /android:id="@\+id\/talk"/);
});

test('household: an action token is routed to its own space and checked there', () => {
  const main = read('src', 'main.ts');
  assert.match(main, /const actSpace = actTokenSpace\(tok\);/);
  assert.match(main, /space\.push\.actions\.space = space\.id;/);
});

test('car mode page module: words switch it, it turns itself off after 2 idle hours, her voice comes back as it was', async () => {
  const { registerHooks } = await import('node:module');
  registerHooks({ resolve: (spec, ctx, next) => (spec === './identity.js' ? next(new URL('../src/identity.ts', import.meta.url).href, ctx) : next(spec, ctx)) });
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
  // @ts-ignore: a plain browser module without types
  const car = (await import('../web/car-mode.js')) as Record<string, any>;
  assert.equal(car.carCommand('Car mode'), 'on');
  assert.equal(car.carCommand('car mode off'), 'off');
  assert.equal(car.carCommand('what is car mode?'), null);
  mem.set('sara.speak', '0');
  car.setCar(true, 1000);
  assert.equal(car.carOn(1000 + 3600_000), true);
  assert.equal(mem.get('sara.speak'), '1', 'voice replies while driving');
  car.touchCar(1000 + 3600_000);
  assert.equal(car.carOn(1000 + 3600_000 + 2 * 3600_000 - 1), true, 'use keeps it on');
  assert.equal(car.carOn(1000 + 3600_000 + 2 * 3600_000 + 1), false, 'auto-off after 2 idle hours');
  assert.equal(mem.get('sara.speak'), '0', 'her voice setting is back');
  const html = read('web', 'index.html');
  assert.match(html, /<dialog id="car-mode" class="car-mode"/);
  assert.match(html, /id="car-mode-open"/);
  const app = read('web', 'app.js');
  assert.match(app, /const carCmd = state\.editing \? null : carCommand\(text\);/);
  assert.match(app, /\.\.\.frame, \.\.\.car \}/);
});
