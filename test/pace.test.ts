// Phase 11: replying at a person's typing pace on Telegram/Discord.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paceLikeTyping, typingMs } from '../src/bridges/pace.ts';
import { makeApp, tempDir } from './helpers.ts';

test('typing pace: longer messages take longer (capped); off by default; counts time already spent', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  assert.ok(typingMs('ok') < typingMs('a much longer message with several words in it'));
  assert.equal(typingMs('x'.repeat(5000)), 4000, 'C6: a few seconds at most');
  let typed = 0;
  let t0 = Date.now();
  await paceLikeTyping(app, 'hello there', Date.now(), () => typed++);
  assert.ok(Date.now() - t0 < 50, 'instant by default');
  app.settings.update({ persona: { typing: 'human' } });
  t0 = Date.now();
  await paceLikeTyping(app, 'hi', Date.now() - 600, () => typed++);
  const took = Date.now() - t0;
  assert.ok(took >= typingMs('hi') - 600 - 20 && took < typingMs('hi'), `waited the rest (${took} ms)`);
  assert.ok(typed >= 1, 'typing indicator kept up');
  t0 = Date.now();
  await paceLikeTyping(app, 'hi', Date.now() - 60_000, () => typed++);
  assert.ok(Date.now() - t0 < 50, 'no wait when she already took longer than typing would');
});
