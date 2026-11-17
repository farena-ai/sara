// MSGPOP (docs/MESSAGES.md "New message notice"): a new one-to-one message (or a community mention) shows
// one clean card at the top centre of the window that stays until Open / Later / the chat is opened;
// it also shows for unread messages found on load, when the window comes back and after the event
// stream reconnects (remembered per message, so Later never nags); the sidebar shows a count and the
// tab title an "(n) " prefix. Communities stay quiet unless mentioned (T4 rules unchanged).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { OwnerAuth } from '../src/auth.ts';
import { Messenger } from '../src/messages.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const N = await import(pathToFileURL(join(ROOT, 'web/msg-notice.js')).href);
// A tiny t(): fills {params} like the page's.
const tr = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k]));
const id = (n: number) => `m${String(n).padStart(4, '0')}`;
const direct = (o: Record<string, unknown>) => ({ kind: 'direct', muted: false, blocked: false, notify: null, unread: 1, mentions: 0, last: 'hi', ...o });

test('MSGPOP: unread one-to-one messages found on load get the card; communities stay quiet unless mentioned', () => {
  const chats = [
    direct({ id: 'c1', title: 'Hank', lastIn: id(1), lastInAt: '2026-11-16T10:00:00Z' }),
    direct({ id: 'c2', title: 'Ivy', unread: 0, lastIn: id(2) }),
    direct({ id: 'c3', title: 'Jo', muted: true, lastIn: id(3) }),
    { id: 'g1', kind: 'community', title: 'Book club', muted: false, notify: null, unread: 4, mentions: 0, last: 'chapter 3', lastIn: id(4) },
    { id: 'g2', kind: 'community', title: 'Hikes', muted: false, notify: null, unread: 2, mentions: 1, last: '@Alex?', lastIn: id(5) },
  ];
  const got = N.pendingNotices(chats, [], { communityNotify: 'mentions' });
  assert.deepEqual(got.map((x: any) => x.chatId), ['c1', 'g2'], 'the DM and the mention only');
  assert.equal(got[0].name, 'Hank');
  assert.equal(got[0].initial, 'H');
  assert.equal(got[0].body, 'hi');
  assert.equal(got[1].mention, true);
  // The chat already on screen gets no card.
  assert.deepEqual(N.pendingNotices(chats, [], { communityNotify: 'mentions', openChat: 'c1' }).map((x: any) => x.chatId), ['g2']);
  // "Everything" for a community: a plain post counts like a DM.
  assert.equal(N.pendingNotices([{ ...chats[3], notify: 'all' }], [], { communityNotify: 'mentions' }).length, 1);
  assert.equal(N.pendingNotices([chats[3]], [], { communityNotify: 'all' }).length, 1, 'server-wide default everything');
  // Popup off: nothing.
  assert.equal(N.pendingNotices(chats, [], { communityNotify: 'mentions', popup: false }).length, 0);
});

test('MSGPOP: Later is remembered per message; a new message from the same person shows again', () => {
  const one = [direct({ id: 'c1', title: 'Hank', lastIn: id(1) })];
  const [n] = N.pendingNotices(one, [], {});
  let shown = N.remember([], [n.key]);
  assert.deepEqual(N.pendingNotices(one, shown, {}), [], 'Later: no card again for the same message');
  const two = [direct({ id: 'c1', title: 'Hank', unread: 2, lastIn: id(2) })];
  assert.equal(N.pendingNotices(two, shown, {}).length, 1, 'a newer message brings it back');
  // The memory is bounded and keeps the newest keys.
  for (let i = 0; i < 400; i++) shown = N.remember(shown, [`c${i}:${id(i)}`]);
  assert.equal(shown.length, N.SHOWN_MAX);
  assert.ok(shown.includes(`c399:${id(399)}`));
  // Bad storage never throws.
  assert.deepEqual(N.parseShown('not json'), []);
  assert.deepEqual(N.parseShown('{"a":1}'), []);
});

test('MSGPOP: several senders stack as one card with a count', () => {
  const e = (name: string, unread = 1) => ({ chatId: name, name, initial: name[0], body: 'x', unread, key: name });
  assert.equal(N.noticeTitle([e('Hank')], tr), 'New message from Hank');
  assert.equal(N.noticeTitle([e('Hank', 3)], tr), 'New message from Hank');
  assert.equal(N.noticeTitle([e('Hank'), e('Ivy')], tr), 'New messages from Hank and 1 other');
  assert.equal(N.noticeTitle([e('Hank'), e('Ivy'), e('Jo')], tr), 'New messages from Hank and 2 others');
  assert.equal(N.noticeTitle([{ ...e('Hikes'), mention: true }], tr), 'You were mentioned in Hikes');
  assert.equal(N.noticeCount([e('Hank', 2), e('Ivy'), e('Jo', 4)]), 7);
  // Adding a notice for a chat already on the card replaces it and moves it to the front.
  const list = N.addNotice([e('Hank'), e('Ivy')], { ...e('Hank', 2), body: 'new' });
  assert.deepEqual(list.map((x: any) => x.name), ['Hank', 'Ivy']);
  assert.equal(list[0].body, 'new');
  assert.equal(N.addNotice(list, e('Jo'))[0].name, 'Jo');
});

test('MSGPOP: the tab title gets an "(n) " prefix while unread', () => {
  assert.equal(N.withCount('Sara', 3), '(3) Sara');
  assert.equal(N.withCount('(3) Sara', 5), '(5) Sara');
  assert.equal(N.withCount('(5) Sara is working…', 0), 'Sara is working…');
  assert.equal(N.withCount('Sara', 0), 'Sara');
  assert.equal(N.withCount('Sara', 250), '(99+) Sara');
  assert.equal(N.countText(7), '7');
  assert.equal(N.countText(100), '99+');
});

async function node(t: TestContext, name: string) {
  const tmp = tempDir();
  const clock = { now: new Date('2026-11-16T12:00:00Z') };
  const app = makeApp(tmp.dir, clock);
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  app.messages = m;
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()));
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { m, base, req, clock };
}

test('MSGPOP: the chat list carries the newest incoming message id; the app badge counts unread messages', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const inv = await a.req('POST', '/api/messages/invite', { url: a.base });
  await b.req('POST', '/api/messages/join', { code: inv.code, url: b.base });
  await a.m.flush();
  const aChat = (await a.req('GET', '/api/messages')).chats.find((c: any) => c.kind === 'direct').id;
  const before = (await b.req('GET', '/api/phone/badge')).count;
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'hi Bo' });
  await a.m.flush();
  let list = await b.req('GET', '/api/messages');
  const c1 = list.chats.find((c: any) => c.kind === 'direct');
  assert.equal(c1.unread, 1);
  assert.ok(typeof c1.lastIn === 'string' && c1.lastIn.length > 0, 'lastIn id');
  assert.ok(c1.lastInAt);
  assert.equal((await b.req('GET', '/api/phone/badge')).count, before + 1, 'app badge includes the message');
  // Bo's own reply does not change lastIn (only incoming messages count).
  await b.req('POST', `/api/messages/chats/${c1.id}/send`, { text: 'hey' });
  await b.m.flush();
  list = await b.req('GET', '/api/messages');
  assert.equal(list.chats.find((c: any) => c.id === c1.id).lastIn, c1.lastIn);
  // A second message from Alex: a new id, so the card would show again.
  a.clock.now = new Date('2026-11-16T12:01:00Z');
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'are you there?' });
  await a.m.flush();
  list = await b.req('GET', '/api/messages');
  const c2 = list.chats.find((c: any) => c.id === c1.id);
  assert.notEqual(c2.lastIn, c1.lastIn);
  assert.equal(N.pendingNotices(list.chats, N.remember([], [`${c1.id}:${c1.lastIn}`]), list.settings).length, 1);
  // Reading the chat clears the badge part again.
  await b.req('POST', `/api/messages/chats/${c1.id}/read`, {});
  assert.equal((await b.req('GET', '/api/phone/badge')).count, before);
});

test('MSGPOP: page wiring: top-centre card, no auto-hide, never takes focus, catch-up on load/visible/reconnect', () => {
  const js = read('web/messages.js');
  const app = read('web/app.js');
  const html = read('web/index.html');
  const css = read('web/style.css');
  assert.match(js, /from '\.\/msg-notice\.js'/);
  const card = js.slice(js.indexOf('// ---- MSGPOP card'), js.indexOf('// end popup'));
  assert.ok(card.length > 200, 'card code exists');
  assert.ok(!/\.focus\(/.test(card), 'the card never takes focus');
  assert.ok(!/setTimeout\([^)]*POP_MS/.test(card) && !/POP_MS/.test(js), 'no auto-hide timer');
  assert.match(card, /'role', 'status'/);
  assert.match(card, /aria-live', 'polite'/);
  assert.match(card, /popover = 'manual'/);
  for (const k of ["t('Open')", "t('Later')"]) assert.ok(card.includes(k), k);
  assert.match(js, /localStorage/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /export function messagesReconnected/);
  assert.match(app, /addEventListener\('open', \(\) => messagesReconnected\(\)\)/);
  // Opening the chat clears its notice.
  assert.match(js.slice(js.indexOf('async function loadChat')), /dropNotice\(id\)/);
  // Sidebar count pill, title prefix.
  assert.match(html, /id="msgs-dot" class="side-dot side-count"/);
  assert.match(js, /withCount\(/);
  // Messages sits in More unless pinned: More (and the phone bar's More) light up too.
  assert.match(read('web/nav.js'), /\['#team-dot', '#msgs-dot'\]/);
  assert.match(css, /#msgs-pops:not\(#_\) \{[^}]*left: 50%/);
  assert.ok(!/#msgs-pops[^{]*\{[^}]*#[0-9a-f]{3,6}\b/i.test(css), 'theme variables only');
});

test('MSGPOP: every new string is translated', () => {
  const keys = ['New message from {name}', 'New messages from {name} and 1 other', 'New messages from {name} and {n} others', 'You were mentioned in {name}', 'Later'];
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr2 = read(`web/i18n/${lang}.json`);
    for (const k of keys) assert.ok(tr2.includes(JSON.stringify(k) + ':'), `${lang}: ${k}`);
  }
});
