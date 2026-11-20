// LINKAWARE: Sara knows which Saras are linked and who wrote (never what). docs/MESSAGES.md (Isolation).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runTurn } from '../src/chat.ts';
import { friendTimeOf } from '../src/friend-time.ts';
import { linkAwareOn, linkedFriends, linkedFriendsNote, linkedFriendsReport, matchFriend } from '../src/link-aware.ts';
import { MSG, signEnvelope } from '../src/messages.ts';
import { supportOf } from '../src/support.ts';
import { createLinkAwareTools } from '../src/tools/link-aware.ts';
import { ROOT, text } from './helpers.ts';
import { clock, fixPass, linkPair, pairNode, until, type PairNode } from './helpers-repair-pair.ts';

// A marker built at run time: it must never reach the model, memory, sara.db or logs.
const MARK = () => ['zq', Math.random().toString(36).slice(2, 10), 'harbor'].join('');

async function say(from: PairNode, to: PairNode, text: string): Promise<void> {
  const chat = from.m.chats().find((c) => c.kind === 'direct' && c.title === to.m.name())!;
  await from.req('POST', `/api/messages/chats/${chat.id}/send`, { text });
  await from.m.flush();
}
async function turn(n: PairNode, q: string, opts: Record<string, unknown> = {}): Promise<string> {
  n.app.script.push(text('ok'));
  const before = n.app.requests.length;
  const conv = n.app.store.createConversation({ title: 'x' });
  for await (const _ of runTurn(n.app, conv.id, q, undefined, opts as never)) void _;
  return JSON.stringify(n.app.requests.slice(before));
}

test('LINKAWARE: matchFriend takes the whole name, the first name or its start, any case', () => {
  const list = [{ name: 'Hank Moody' }, { name: 'Sam' }, { name: 'Samira Ö' }];
  assert.equal(matchFriend(list, 'hank')?.hit?.name, 'Hank Moody');
  assert.equal(matchFriend(list, 'HANK MOODY')?.hit?.name, 'Hank Moody');
  assert.equal(matchFriend(list, "Hank's")?.hit?.name, 'Hank Moody');
  assert.equal(matchFriend(list, 'sam')?.hit?.name, 'Sam', 'an exact name wins over a longer one');
  assert.equal(matchFriend(list, 'samira o')?.hit?.name, 'Samira Ö');
  assert.deepEqual(matchFriend(list, 'sa').many?.map((x) => x.name), ['Sam', 'Samira Ö']);
  assert.equal(matchFriend(list, 'ank').hit, undefined, 'never inside a word');
});

test('LINKAWARE: awareness is names, counts and times only; the turn says Hank wrote, never what', async (t) => {
  const a = await pairNode(t, 'Alex');
  const h = await pairNode(t, 'Hank');
  await linkPair(a, h);
  const words = MARK();
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...x: unknown[]) => void logged.push(x.map(String).join(' '));
  try {
    await say(h, a, `the boat is ${words}`);
    await say(h, a, `again ${words}`);
  } finally {
    Object.assign(console, orig);
  }
  const aw = a.m.awareness();
  assert.equal(aw.length, 1);
  assert.deepEqual(Object.keys(aw[0]!).sort(), ['chat', 'companion', 'formerly', 'lastInAt', 'link', 'name', 'since', 'unread']);
  assert.equal(aw[0]!.name, 'Hank');
  assert.equal(aw[0]!.unread, 2);
  assert.ok(!JSON.stringify(aw).includes(words));
  assert.ok(linkAwareOn(a.app));
  assert.equal(linkedFriends(a.app)![0]!.unread, 2);

  const seen = await turn(a, 'Did Hank reach out?');
  assert.match(seen, /Linked Saras/);
  assert.match(seen, /Hank \(linked/);
  assert.match(seen, /2 unread from them/);
  assert.ok(!seen.includes(words), 'no message text in the model request');
  assert.ok(!logged.some((l) => l.includes(words)), 'never logged');
  // The read-only tool says the same and points at Messages.
  const tool = createLinkAwareTools(() => a.app)[0]!;
  assert.equal(tool.spec.name, 'linked_friends');
  assert.equal(tool.defaultPermission, 'auto');
  assert.ok(tool.isAvailable!());
  const out = String(await tool.run({ friend: 'hank' }, {} as never));
  assert.match(out, /Hank .*2 unread/);
  assert.match(out, /#view=msgs/);
  assert.ok(!out.includes(words));
  // Not in memory or sara.db.
  assert.ok(!JSON.stringify(a.app.memory!.listAll()).includes(words));
  a.app.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const f of readdirSync(a.dir).filter((f) => f.startsWith('sara.db'))) assert.ok(!readFileSync(join(a.dir, f)).includes(words), `${f} holds nothing`);
  // Reading the chat in Messages makes it 0 unread.
  const chat = a.m.chats().find((c) => c.kind === 'direct')!;
  await a.req('POST', `/api/messages/chats/${chat.id}/read`);
  assert.match(await turn(a, 'anything new?'), /nothing unread/);
});

test('LINKAWARE: never in group chats, other apps or outside requests; off removes line and tool', async (t) => {
  const a = await pairNode(t, 'Alex');
  const h = await pairNode(t, 'Hank');
  await linkPair(a, h);
  await say(h, a, 'hello');
  // Group chats are gated by the same owner-input check (src/owner-evidence.ts DENIED includes group).
  for (const o of [{ externalApp: true }, { outside: { source: 'a2a:x', label: 'Peer', operator: 'the owner', tools: [] } }]) {
    assert.doesNotMatch(await turn(a, 'did Hank write?', o), /Linked Saras/, JSON.stringify(o));
  }
  const tool = createLinkAwareTools(() => a.app)[0]!;
  await a.req('PUT', '/api/messages/settings', { aware: false });
  assert.equal(a.m.settings().aware, false);
  assert.equal(linkAwareOn(a.app), false);
  assert.equal(linkedFriendsNote(a.app), undefined);
  assert.equal(tool.isAvailable!(), false);
  assert.doesNotMatch(await turn(a, 'did Hank write?'), /Linked Saras/);
  await a.req('PUT', '/api/messages/settings', { aware: true });
  assert.match(await turn(a, 'did Hank write?'), /Linked Saras/);
  // A household member (no Messenger) and an off-the-record app see nothing.
  assert.equal(linkAwareOn({ ...a.app, member: {} } as never), false);
  assert.equal(linkAwareOn({ ...a.app, offRecord: true } as never), false);
  assert.equal(linkAwareOn({ ...a.app, messages: undefined } as never), false);
});

test('LINKAWARE: no links, no line', async (t) => {
  const a = await pairNode(t, 'Alex');
  assert.equal(linkedFriendsNote(a.app), undefined);
  assert.doesNotMatch(await turn(a, 'did Hank write?'), /Linked Saras/);
});

test('LINKAWARE: waiting requests by kind (fix request, find a time), never their words', async (t) => {
  const a = await pairNode(t, 'Alex');
  const h = await pairNode(t, 'Hank');
  const { aLink } = await linkPair(a, h);
  // Alex asks Hank to fix something (Hank holds an asked pass), then to find a time.
  await a.req('POST', '/api/remote-repair/requests', { link: aLink, problem: 'the weather add-on', hours: 24, scope: 'each' });
  await friendTimeOf(a.app)!.ask(aLink, 'Secret picnic', 30, 'any', 7);
  const fr = await until(async () => linkedFriends(h.app)?.[0]?.pending.length === 2 && linkedFriends(h.app)![0]!, 'pending on Hank');
  assert.deepEqual(fr.pending.map((p) => p.kind).sort(), ['fix', 'time']);
  const note = linkedFriendsNote(h.app)!;
  assert.match(note, /Alex \(.*a fix request.*a find-a-time request/);
  assert.ok(!note.includes('weather') && !note.includes('picnic'), 'kinds only, never the words');
  void fixPass;
  void clock;
});

test('LINKAWARE: friend tools resolve the friend by the same first-name match', () => {
  for (const f of ['tools/friend-time.ts', 'tools/remote-repair.ts', 'tools/support.ts']) assert.match(readFileSync(join(ROOT, 'src', f), 'utf8'), /matchFriend/, f);
  // link-aware.ts reads the Messenger only through awareness() and settings().
  const src = readFileSync(join(ROOT, 'src', 'link-aware.ts'), 'utf8');
  const calls = [...src.matchAll(/messages!?\??\.(\w+)\(/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['awareness', 'settings']);
});

test('LINKAWARE rename: a companion rename reaches the friend; "formerly Hank" for 30 days; lookup by any name', async (t) => {
  const start = clock.now;
  t.after(() => void (clock.now = start));
  const a = await pairNode(t, 'Alex');
  const h = await pairNode(t, 'Hank');
  await linkPair(a, h);
  // Hank's owner names the companion Jarvis (person name stays Sam once they set it).
  await h.req('PUT', '/api/messages/settings', { name: 'Sam' });
  h.m.companion = () => 'Jarvis';
  await h.m.flush();
  await until(async () => a.m.awareness()[0]?.companion === 'Jarvis' && a.m.awareness()[0]?.name === 'Sam', 'rename arrived');
  const aw = a.m.awareness()[0]!;
  assert.equal(aw.formerly, 'Hank');
  assert.equal(a.m.chats().find((c) => c.kind === 'direct')!.title, 'Jarvis (Sam’s Sara)');
  const note = linkedFriendsNote(a.app)!;
  assert.match(note, /Jarvis \(Sam’s Sara; formerly Hank; linked/);
  assert.match(linkedFriendsReport(a.app, 'hank'), /Jarvis/, 'the old name still finds them');
  assert.match(linkedFriendsReport(a.app, 'sam'), /Jarvis/);
  assert.match(linkedFriendsReport(a.app, 'JARVIS'), /Jarvis/);
  // The friend tools find them by any of the names (support peers carry the aliases).
  const peers = supportOf(a.app)!.peers();
  assert.equal(matchFriend(peers, 'hank').hit?.name, 'Sam');
  assert.equal(matchFriend(peers, 'jarvis').hit?.name, 'Sam');
  // Nothing new to say: no second event.
  const before = h.m.outboxSize();
  await h.m.flush();
  assert.equal(h.m.outboxSize(), before);
  // After 30 days the old name is dropped.
  clock.now = new Date(clock.now.getTime() + 31 * 86_400_000);
  assert.equal(a.m.awareness()[0]!.formerly, null);
  assert.doesNotMatch(linkedFriendsNote(a.app)!, /formerly/);
});

test('LINKAWARE rename: name events are clipped, carry no text, and replays are refused', async (t) => {
  const a = await pairNode(t, 'Alex');
  const h = await pairNode(t, 'Hank');
  const { aLink, bLink } = await linkPair(a, h);
  const key = h.m.privateKeyFor(bLink)!;
  const body = JSON.stringify({ v: 1, id: 'nm' + Date.now(), at: clock.now.toISOString(), type: 'name', name: 'J'.repeat(500), companion: 'Jarvis', text: 'secret words here' });
  const post = () => fetch(a.base + '/msg/v1/inbox', { method: 'POST', headers: { 'content-type': 'application/json', ...signEnvelope(bLink, body, key, clock.now) }, body });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 409, 'replay refused');
  const aw = a.m.awareness().find((x) => x.link === aLink)!;
  assert.equal(aw.name.length, MSG.nameChars);
  assert.ok(!JSON.stringify(a.m.links()).includes('secret'));
  // Unsigned: refused.
  assert.equal((await fetch(a.base + '/msg/v1/inbox', { method: 'POST', body })).status, 401);
});

test('LINKAWARE rename: community host learns a member\'s new name; manual Rename in Options', async (t) => {
  const a = await pairNode(t, 'Alex');
  const h = await pairNode(t, 'Hank');
  await a.req('PUT', '/api/messages/settings', { url: a.base });
  const club = (await a.req('POST', '/api/messages/communities', { name: 'Trail' })).chat;
  const code = (await a.req('GET', `/api/messages/chats/${club.id}`)).code;
  await h.req('POST', '/api/messages/join', { code, url: h.base });
  await until(async () => a.m.members(club.id).some((m) => m.name === 'Hank'), 'member in');
  await h.req('PUT', '/api/messages/settings', { name: 'Jarvis' });
  await h.m.flush();
  await until(async () => a.m.members(club.id).some((m) => m.name === 'Jarvis'), 'member renamed');
  // A direct link renamed by hand (the fallback when the other side is old).
  const b = await pairNode(t, 'Bo');
  await linkPair(a, b);
  const chat = a.m.chats().find((c) => c.kind === 'direct')!;
  await a.req('PATCH', `/api/messages/chats/${chat.id}`, { name: 'Bobby' });
  assert.equal(a.m.chat(chat.id)!.title, 'Bobby');
  const aw = a.m.awareness().find((x) => x.chat === chat.id)!;
  assert.equal(aw.name, 'Bobby');
  assert.equal(aw.formerly, 'Bo');
});
