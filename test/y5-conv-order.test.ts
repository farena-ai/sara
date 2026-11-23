// Y5: the order of the chat list (web/conv-order.js) and her home chat (src/home-chat.ts).
// Owner report (2026-11-23): the chat used last was not always at the top, and what she sent on her
// own landed in whichever chat happened to be the most recent.
import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error a browser module without types
import { byActivity, homeOf, recentOf, showRecent, RECENT_N } from '../web/conv-order.js';
import { findHomeChat, homeChat, isHomeChat, ownChat } from '../src/home-chat.ts';
import { targetConversation } from '../src/life.ts';
import { makeApp, tempDir } from './helpers.ts';

const c = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ id, updatedAt, archivedAt: null, ...extra });

test('Y5 list: Recent is the newest chats from every folder, newest first; never her home chat or an archived one', () => {
  const convs = [c('a', '2026-11-20T10:00:00Z'), c('b', '2026-11-23T09:00:00Z'), c('home', '2026-11-23T12:00:00Z', { home: true }), c('old', '2026-11-23T11:00:00Z', { archivedAt: '2026-11-23T11:30:00Z' }), c('d', '2026-11-22T08:00:00Z'), c('e', '2026-11-21T08:00:00Z'), c('f', '2026-11-19T08:00:00Z'), c('g', '2026-11-18T08:00:00Z')];
  assert.deepEqual(recentOf(convs).map((x: { id: string }) => x.id), ['b', 'd', 'e', 'a', 'f']);
  assert.equal(RECENT_N, 5);
  assert.equal(homeOf(convs).id, 'home');
  assert.equal(homeOf([c('h', '2026-11-23T12:00:00Z', { home: true, archivedAt: 'x' })]), undefined);
  // Worth showing only when chats are spread over folders and there are more than it would list.
  assert.equal(showRecent(convs, 2), true);
  assert.equal(showRecent(convs, 1), false, 'one folder: its own list is already newest first');
  assert.equal(showRecent(convs.slice(0, 4), 3), false, 'a handful of chats needs no second list');
});

test('Y5 list: folders are ordered by their newest chat; empty ones keep their place after the used ones', () => {
  const groups = [
    { key: 'telegram', convs: [c('t', '2026-11-10T00:00:00Z')] },
    { key: 'empty-1', convs: [] },
    { key: 'work', convs: [c('w1', '2026-11-22T00:00:00Z'), c('w2', '2026-11-23T10:00:00Z')] },
    { key: 'none', convs: [c('n', '2026-11-23T09:00:00Z')] },
    { key: 'empty-2', convs: [] },
  ];
  assert.deepEqual(byActivity(groups).map((g: { key: string }) => g.key), ['work', 'none', 'telegram', 'empty-1', 'empty-2']);
});

test('Y5 home chat: what she sends on her own has one home, made on first use once the person has written', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-23T12:00:00Z') };
  const app = makeApp(dir, clock);
  try {
    app.settings.update({ ownerName: 'Alex' } as never);
    const first = app.store.createConversation({ title: 'Trip ideas' });
    assert.equal(homeChat(app), undefined, 'nobody has written yet: no chat is made for her');
    assert.equal(targetConversation(app)?.id, first.id, 'so the most recent chat is used, as before');
    app.store.addMessage(first.id, 'user', 'hello');
    clock.now = new Date('2026-11-23T12:05:00Z');
    const coding = app.store.createConversation({ title: 'Fix the build', mode: 'coding' });
    app.store.addMessage(coding.id, 'user', 'npm test fails');
    // The newest chat is a coding session: she does not text him there.
    const home = targetConversation(app)!;
    assert.ok(isHomeChat(home));
    assert.notEqual(home.id, coding.id);
    assert.notEqual(home.id, first.id);
    assert.equal(home.title, `From ${app.persona.name}`);
    assert.equal(home.mode, 'chat');
    assert.equal(targetConversation(app)!.id, home.id, 'the same chat every time');
    assert.equal(ownChat(app)!.id, home.id);
    assert.equal(findHomeChat(app)!.id, home.id);
    // Archived by the person: it comes back when she next writes.
    app.store.updateConversation(home.id, { archived: true });
    assert.equal(homeChat(app)!.archivedAt, null);
    // A chat that merely has that name is not it.
    assert.equal(isHomeChat(app.store.createConversation({ title: home.title })), false);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('Y5 list order: only messages move a chat up; renaming it or changing its model does not', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-23T12:00:00Z') };
  const app = makeApp(dir, clock);
  try {
    const a = app.store.createConversation({ title: 'A' });
    clock.now = new Date('2026-11-23T12:01:00Z');
    const b = app.store.createConversation({ title: 'B' });
    app.store.addMessage(b.id, 'user', 'newest');
    clock.now = new Date('2026-11-23T12:02:00Z');
    app.store.updateConversation(a.id, { title: 'A renamed', model: 'other-model', providerId: 'p' });
    assert.deepEqual(app.store.listConversations().map((x) => x.title), ['B', 'A renamed'], 'a rename or a model change is not activity');
    clock.now = new Date('2026-11-23T12:03:00Z');
    app.store.addMessage(a.id, 'user', 'now this one');
    assert.deepEqual(app.store.listConversations().map((x) => x.title), ['A renamed', 'B']);
  } finally {
    app.store.close();
    cleanup();
  }
});
