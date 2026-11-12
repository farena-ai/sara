// 3.6.x: Sara's desktop actions on busy web apps (Outlook on the web, Gmail, Teams): a ref follows its own control
// while the rest of the page changes; drags and picture points keep the whole-window rule; a changed target is refused
// with words that say it is Sara's own check; the tool looks again once by itself. The native mirror of the rule is
// matchTarget in desktop/windows/src/hands-screen.cpp (CU6NativeChecks).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { HandsHub } from '../src/hands.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { changedWhy, fixtureWindows, TestDesktop } from '../src/hands-desktop.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const stale = (e: Error & { code?: string }) => e.code === 'stale_view' && /Sara's own safety check/.test(e.message) && !/security/i.test(e.message.replace("Sara's own safety check", ''));

test('a ref survives unrelated changes on the page and acts on its own control at its new place', () => {
  const d = new TestDesktop();
  const v = d.elements({ window: 'w101' }).viewId;
  const w = d.windows[0];
  // A clock ticks, a counter changes, a panel adds a line above, and the field moves down with it.
  w.elements[0].name = 'Shopping list: apples, oat milk, 13 eggs';
  w.elements.splice(1, 0, { role: 'text', name: 'Draft autosaved 10:00:02', box: [20, 46, 200, 20] });
  w.elements[2].box = [20, 76, 240, 28];
  d.act('d.type', { viewId: v, ref: 'e2', text: 'Taylor' });
  assert.equal(w.elements[2].value, 'Taylor');
  d.act('d.click', { viewId: v, ref: 'e5' });
  assert.equal(d.clicked, 'Save');
});

test('a renamed, re-roled or removed target is refused, plainly as Sara\u2019s own check', () => {
  for (const change of [(w: TestDesktop['windows'][number]) => (w.elements[1].name = 'Delete everything'), (w: TestDesktop['windows'][number]) => (w.elements[1].role = 'button'), (w: TestDesktop['windows'][number]) => w.elements.splice(1, 1)]) {
    const d = new TestDesktop();
    const v = d.elements({ window: 'w101' }).viewId;
    change(d.windows[0]);
    assert.throws(() => d.act('d.type', { viewId: v, ref: 'e2', text: 'x' }), stale);
  }
  // A re-created node with the same role and name is another control: the fixture (like the apps after Allow) refuses it.
  const d = new TestDesktop();
  const v = d.elements({ window: 'w101' }).viewId;
  d.windows[0].elements[1] = { ...d.windows[0].elements[1] };
  assert.throws(() => d.act('d.type', { viewId: v, ref: 'e2', text: 'x' }), stale);
  assert.match(changedWhy('A control changed'), /^The page changed while I was about to act/);
});

test('drags and picture points keep the whole-window rule', () => {
  const d = new TestDesktop();
  const shot = d.shot({ window: 'w101', marks: true });
  d.windows[0].elements[0].name = 'Shopping list: changed';
  assert.throws(() => d.act('d.drag', { viewId: shot.viewId, ref: 'e5', toX: 10, toY: 10 }), stale);
  assert.throws(() => d.act('d.click', { viewId: shot.viewId, x: 60, y: 260 }), stale);
});

test('the tool looks again once by itself when the target was re-created, and the computer asks again', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.settings.update({ disclosureAcceptedAt: new Date().toISOString(), providers: [{ id: 'fixture', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'https://example.test/v1' }], defaultProviderId: 'fixture', defaultModel: 'fake-large' });
  for (const t of createComputerTools(app)) app.tools.add(t);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pair = (await (await fetch(`${base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fixture desktop', token: auth.newToken }) })).json()) as { token: string; id: string };
  const desktop = new TestDesktop();
  let cards = 0;
  // The page re-creates the field while the first card is up (a web app replacing its nodes).
  const ref = new HandsRef({ server: base, token: pair.token, desktop, desktopConsent: async () => { if (++cards === 1) desktop.windows[0].elements[1] = { ...desktop.windows[0].elements[1] }; return 'once'; }, reconnect: false, optIn: { browser: true, desktop: true } });
  try {
    await ref.start();
    for (let i = 0; !hub.hello(pair.id) && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
    const conv = app.store.createConversation({ title: 'Busy page', mode: 'chat' });
    app.script.push([call('look', 'pc_look', { window: 'w101', picture: false })], [call('type', 'pc_type', { ref: 'e2', text: 'Jordan' })], text('Done.'));
    const events: ChatEvent[] = [];
    for await (const event of runTurn(app, conv.id, 'Put Jordan in the name field.')) events.push(event);
    const results = events.filter((e) => e.type === 'tool_result');
    assert.deepEqual(results.map((r) => r.status), ['ok', 'ok'], JSON.stringify(results));
    assert.match(String((results[1] as { output?: string }).output ?? JSON.stringify(results[1])), /looked again once/);
    assert.equal(cards, 2, 'the retried action is asked again on the computer');
    assert.equal(desktop.windows[0].elements[1].value, 'Jordan');
  } finally {
    ref.stop();
    server.close();
    cleanup();
  }
});

test('a tab whose title changed only in its numbers can still be switched to', () => {
  const windows = fixtureWindows();
  windows.push({ id: 'w130', title: 'Inbox (12) - Microsoft Edge', app: 'msedge', bounds: [100, 100, 800, 600], color: [250, 250, 250], origin: 'https://mail.example', elements: [{ role: 'text', name: 'Inbox', box: [10, 10, 200, 20] }], tabs: [{ title: 'Start', url: 'https://start.example/' }, { title: 'Inbox (12) - Mail', url: 'https://mail.example/inbox', active: true }] });
  const d = new TestDesktop({ windows });
  d.windows.at(-1)!.tabs![1].title = 'Inbox (13) - Mail';
  assert.doesNotThrow(() => d.act('d.tabswitch', { window: 'w130', tab: 2, title: 'Inbox (12) - Mail' }));
  assert.throws(() => d.act('d.tabswitch', { window: 'w130', tab: 2, title: 'Bank (12) - Mail' }), /tabs changed/);
});

test('the persona and the tool never blame the website for Sara\u2019s own refusals', () => {
  const persona = readFileSync(join(ROOT, 'src', 'persona.ts'), 'utf8');
  assert.match(persona, /your own safety check on the computer, never the website or its security/);
  const tools = readFileSync(join(ROOT, 'src', 'tools', 'computer.ts'), 'utf8');
  assert.match(tools, /own safety check on the computer, never the website or its security: look again \(pc_look\)/);
});
