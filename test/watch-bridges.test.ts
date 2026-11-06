// E4 follow-ups (docs/ops/E4_DESIGN.md, owner Q3: bridges off by default, opt-in per watch). "Also
// send to" names only the owner's own linked Telegram or Discord chat (never a chat id, a group, a
// room or another person); it rides the same ping as web push, so the 10-minute gap, the 12-a-day cap,
// quiet hours and dedupe are shared, and the text is the same capped, scrubbed line. The owner can
// also pick which of his own chats gets the in-chat card (default: the most recent, as before).
import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramBridge } from '../src/bridges/telegram.ts';
import { TELEGRAM_VAULT } from '../src/bridges/telegram.ts';
import { WATCH, WatchError } from '../src/watch.ts';
import { listen, readBody } from './helpers.ts';
import { watchRig } from './watch-fixture.ts';

const SECRET = 'vault-only-value-3Kd8wQ1z';

const status = (f: () => unknown): number => {
  try {
    f();
    return 200;
  } catch (e) {
    if (e instanceof WatchError) return e.status;
    throw e;
  }
};

/** Stand-ins for the two bridges: linked to the owner's own chat unless told otherwise. */
function fakeBridges(r: ReturnType<typeof watchRig>, linked = { telegram: true, discord: true }) {
  const sent: { bridge: string; text: string }[] = [];
  const fake = (bridge: 'telegram' | 'discord') => ({
    ownerLinked: () => linked[bridge],
    toOwner: async (text: string) => {
      if (!linked[bridge]) return false;
      sent.push({ bridge, text });
      return true;
    },
  });
  r.app.bridges = { telegram: fake('telegram'), discord: fake('discord') } as never;
  return sent;
}

test('watch bridges: off by default; the picker offers only linked bridges', (t) => {
  const r = watchRig(t);
  const sent = fakeBridges(r, { telegram: true, discord: false });
  r.file('app.log');
  const w = r.add('app.log', ['ERROR'], { everyMin: 5 });
  assert.deepEqual(w.alsoTo, [], 'nothing beyond web push and the card unless turned on');
  assert.deepEqual(r.w.roots().bridges, { telegram: true, discord: false });
  r.append('app.log', 'ERROR one\n');
  r.later(5);
  assert.equal(r.pushes.length, 1);
  assert.equal(sent.length, 0, 'no bridge message by default');
});

test('watch bridges: opted in, one message per ping to the owner’s own chat, the same capped and scrubbed line', (t) => {
  const r = watchRig(t);
  r.app.vault.set('some-key', SECRET);
  const sent = fakeBridges(r);
  r.file('app.log');
  const w = r.add('app.log', ['ERROR'], { everyMin: 5, alsoTo: ['telegram'] });
  assert.deepEqual(w.alsoTo, ['telegram']);
  r.append('app.log', `ERROR payment failed key=${SECRET} ${'x'.repeat(600)}\n`);
  r.later(5);
  assert.equal(r.pushes.length, 1);
  assert.deepEqual(sent.map((s) => s.bridge), ['telegram'], 'once, only where it was turned on');
  const line = r.w.alerts(w.id)[0].line;
  assert.ok(line.length <= WATCH.keepChars);
  assert.ok(sent[0].text.includes(line), 'the kept line, as stored');
  assert.ok(sent[0].text.includes('app.log'));
  assert.ok(!sent[0].text.includes(SECRET), 'scrubbed');
  assert.ok(!sent[0].text.includes('x'.repeat(400)), 'capped');
  // Turned on later for Discord too (and off for Telegram) by the owner's edit.
  assert.deepEqual(r.w.patch(w.id, { alsoTo: ['discord'] }).alsoTo, ['discord']);
  r.append('app.log', 'ERROR again later\n');
  r.later(10);
  assert.deepEqual(sent.map((s) => s.bridge), ['telegram', 'discord']);
});

test('watch bridges: the 10-minute gap, quiet hours and the daily cap are the same for push and bridges', (t) => {
  const r = watchRig(t);
  const sent = fakeBridges(r);
  r.file('a.log');
  r.add('a.log', ['ERROR'], { everyMin: 5, alsoTo: ['telegram', 'discord'] });
  r.append('a.log', 'ERROR one\n');
  r.later(5);
  r.append('a.log', 'ERROR two\n');
  r.later(5);
  assert.equal(r.pushes.length, 1, 'held inside 10 minutes');
  assert.equal(sent.length, 2, 'held on the bridges too');
  r.later(5);
  assert.equal(r.pushes.length, 2);
  assert.equal(sent.length, 4, 'the folded ping goes out once per bridge');
  assert.match(sent.at(-1)!.text, /ERROR two/);
  // Quiet hours hold both.
  r.app.settings.update({ proactive: { quietStart: 0, quietEnd: 23 } } as never);
  r.append('a.log', 'ERROR at night\n');
  r.later(15);
  assert.equal(r.pushes.length, 2);
  assert.equal(sent.length, 4);
  r.app.settings.update({ proactive: { quietStart: 0, quietEnd: 0 } } as never);
  r.later(1);
  assert.equal(r.pushes.length, 3);
  assert.equal(sent.length, 6);
  // The daily cap counts pings, not channels.
  for (let i = 0; i < 20; i++) {
    r.append('a.log', `ERROR kind ${'abcdefghijklmnopqrstuvwxyz'[i]}\n`);
    r.later(10);
  }
  assert.ok(r.pushes.length <= WATCH.pingsPerDay * 2);
  assert.equal(sent.length, r.pushes.length * 2, 'every ping once per bridge, never more');
});

test('watch bridges: only the names of linked bridges; chat ids, groups, rooms and other people are refused', (t) => {
  const r = watchRig(t);
  fakeBridges(r, { telegram: true, discord: false });
  r.file('a.log');
  for (const bad of [['discord'], ['telegram:-1001234567'], ['-1001234567'], ['matrix'], ['imessage'], [{ chatId: 555 }], 'telegram', ['telegram', 'telegram', 'telegram']]) {
    const s = status(() => r.add('a.log', ['ERROR'], { alsoTo: bad }));
    if (Array.isArray(bad) && bad.length === 3) {
      assert.equal(s, 200, 'repeats collapse');
      continue;
    }
    assert.equal(s, 400, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(r.w.list().map((w) => w.alsoTo), [['telegram']]);
  // The card's chat: only the owner's own conversations.
  const guest = r.app.store.createConversation({ title: 'Guest', partner: 'Sam' } as never);
  const room = r.app.store.createConversation({ title: 'Room', channel: 'telegram-group', channelKey: '-1001234567' } as never);
  for (const c of [guest.id, room.id, 'no-such-chat']) assert.equal(status(() => r.add('a.log', ['ERROR'], { conversationId: c })), 400, `card chat ${c}`);
});

test('watch bridges: the chosen chat gets the card (default: the most recent chat)', (t) => {
  const r = watchRig(t);
  fakeBridges(r);
  const ops = r.app.store.createConversation({ title: 'Ops' });
  r.clock.now = new Date(r.clock.now.getTime() + 60_000);
  const newer = r.app.store.createConversation({ title: 'Newer chat' });
  r.file('a.log');
  r.file('b.log');
  // The default one is checked first, so "most recent" is still the newer chat when its card goes out.
  const dflt = r.add('b.log', ['ERROR'], { everyMin: 5 });
  const chosen = r.add('a.log', ['ERROR'], { everyMin: 5, conversationId: ops.id });
  assert.equal(chosen.conversationId, ops.id);
  assert.equal(dflt.conversationId, null);
  r.append('a.log', 'ERROR in a\n');
  r.append('b.log', 'ERROR in b\n');
  assert.equal(r.app.store.listConversations()[0].id, newer.id, 'the most recent chat before the alerts');
  r.later(5);
  const cards = (id: string) => r.app.store.messages(id).filter((m) => m.role === 'notice' && m.content.startsWith('watch:')).map((m) => m.content);
  const newest = newer.id;
  assert.deepEqual(cards(ops.id), ['watch:ERROR in a']);
  assert.deepEqual(cards(newest), ['watch:ERROR in b']);
  // Moved to another of his chats; null goes back to the most recent.
  assert.equal(r.w.patch(chosen.id, { conversationId: newest }).conversationId, newest);
  assert.equal(r.w.patch(chosen.id, { conversationId: null }).conversationId, null);
});

test('watch bridges: the real Telegram bridge sends only to the owner’s private chat, never to a group', async (t) => {
  const r = watchRig(t);
  const TOKEN = '123456789:test';
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const srv = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    if (method !== 'getUpdates') sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((ok) => setTimeout(() => ok([]), 50)) : method === 'sendMessage' ? { message_id: sent.length } : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  t.after(() => srv.server.close());
  r.app.vault.set(TELEGRAM_VAULT, TOKEN);
  r.app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: false, ownerChatId: 1001 } } as never);
  const bridge = new TelegramBridge(r.app, { apiBase: srv.url });
  await bridge.restart();
  t.after(() => bridge.stop());
  assert.equal(bridge.ownerLinked(), true);
  assert.equal(await bridge.toOwner('Watch: app.log ERROR one'), true);
  assert.deepEqual(sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.chat_id), [1001]);
  // A group id (negative) is never the owner's own chat.
  r.app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: false, ownerChatId: -1001234567 } } as never);
  assert.equal(bridge.ownerLinked(), false);
  assert.equal(await bridge.toOwner('Watch: app.log ERROR two'), false);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 1);
});
