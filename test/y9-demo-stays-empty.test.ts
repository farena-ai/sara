// Y9: the demo never stores a chat of her own. The demo refuses to start on a data folder that holds
// a conversation (it lets visitors in without signing in), and on 2026-11-22 the weekly check-in wrote
// one there: the demo went down at its next restart (2026-11-23, found while deploying).
import assert from 'node:assert/strict';
import test from 'node:test';
import { postAlert } from '../src/destinations.ts';
import { herWeekTick, saveHerWeekPrefs } from '../src/her-week.ts';
import { homeChat } from '../src/home-chat.ts';
import { makeApp, tempDir } from './helpers.ts';

function world(demo: boolean) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-15T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' } as never);
  if (demo) (app as { demo?: boolean }).demo = true;
  return { app, clock, close: () => { app.store.close(); cleanup(); } };
}
const conversations = (app: { store: { listConversations(): unknown[] } }) => app.store.listConversations().length;

test('Y9 demo: the weekly check-in, feed posts and her home chat write nothing on the demo', () => {
  const w = world(true);
  try {
    saveHerWeekPrefs(w.app, { on: true, day: 0, time: '12:00' } as never);
    herWeekTick(w.app, w.clock.now); // the first look only notes the slot
    w.clock.now = new Date('2026-11-22T12:00:05Z');
    assert.equal(herWeekTick(w.app, w.clock.now), undefined);
    assert.equal(postAlert(w.app, 'briefing', { role: 'assistant', content: 'Good morning.' }), undefined);
    assert.equal(homeChat(w.app), undefined);
    assert.equal(conversations(w.app), 0, 'the demo holds no conversation');
  } finally {
    w.close();
  }
});

test('Y9 demo: on a real server the same weekly check-in is sent (the guard is the demo only)', () => {
  const w = world(false);
  try {
    const c = w.app.store.createConversation();
    w.app.store.addMessage(c.id, 'user', 'hello');
    saveHerWeekPrefs(w.app, { on: true, day: 0, time: '12:00' } as never);
    herWeekTick(w.app, w.clock.now);
    w.clock.now = new Date('2026-11-22T12:00:05Z');
    const sent = herWeekTick(w.app, w.clock.now);
    assert.ok(sent, 'a chat id came back');
    assert.ok(conversations(w.app) >= 2, 'it went to a chat of hers, not into his');
    assert.equal(w.app.store.messages(c.id).length, 1, 'his own chat is untouched');
  } finally {
    w.close();
  }
});
