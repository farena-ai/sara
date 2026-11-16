// S9a (docs/MESSAGES.md): private messages between the owners of linked Sara servers. Two (or three)
// in-process servers link with a one-time code and talk over signed HTTP; the agents are never
// involved (no model, memory, tools, search or logs see a message).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { decodeCode, Messenger, signEnvelope } from '../src/messages.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

type Node = { app: TestApp; m: Messenger; base: string; req: (method: string, path: string, body?: unknown) => Promise<any>; raw: (method: string, path: string, body?: unknown) => Promise<Response>; dir: string; stop: () => Promise<void> };
const clock = { now: new Date('2026-11-16T12:00:00Z') };
const tick = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

async function node(t: TestContext, name: string, opts: { member?: boolean } = {}): Promise<Node> {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  // Every peer request goes through this seam (the real one is netFetch, which allows loopback too).
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  app.messages = m;
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(opts.member ? { spaceId: 'mem0000001', member: { record: () => ({ id: 'mem0000001', name: 'Mo', status: 'active', limits: { voice: false, pictures: false } }) as never, apps: () => [app], deleteSelf: async () => {} } } : {}) });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const raw = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((ok) => srv.close(() => ok()));
  };
  t.after(async () => {
    await stop();
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { app, m, base, req, raw, dir: tmp.dir, stop };
}

/** A links to B: A makes the code, B pastes it. Returns each side's chat id. */
async function link(a: Node, b: Node): Promise<{ aChat: string; bChat: string }> {
  const { code } = await a.req('POST', '/api/messages/invite', { url: a.base });
  const joined = await b.req('POST', '/api/messages/join', { code, url: b.base });
  const aList = await a.req('GET', '/api/messages');
  const aChat = aList.chats.find((c: any) => c.kind === 'direct' && c.title === b.m.name()).id;
  return { aChat, bChat: joined.chat.id };
}

const SECRET = () => ['zebra', 'violet', String(4000 + Math.floor(Math.random() * 999))].join('-');

test('S9a: two servers link with a one-time code and message each other (edit, delete, read receipts, typing)', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { code, expiresAt } = await a.req('POST', '/api/messages/invite', { url: a.base });
  assert.match(code, /^sara-msg:/);
  assert.equal(decodeCode(code).u, a.base);
  assert.ok(Date.parse(expiresAt) - clock.now.getTime() <= 60 * 60_000, 'short-lived');
  const joined = await b.req('POST', '/api/messages/join', { code, url: b.base });
  assert.equal(joined.chat.title, 'Alex');
  // Single use: the same code is refused the second time.
  const again = await b.raw('POST', '/api/messages/join', { code, url: b.base });
  assert.equal(again.status, 400);
  const aChat = (await a.req('GET', '/api/messages')).chats.find((c: any) => c.title === 'Bo').id;

  const words = SECRET();
  const sent = await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: `hello ${words}` });
  await a.m.flush();
  const bView = await b.req('GET', `/api/messages/chats/${joined.chat.id}`);
  assert.equal(bView.messages.length, 1);
  assert.equal(bView.messages[0].text, `hello ${words}`);
  assert.equal(bView.messages[0].mine, false);
  assert.equal((await b.req('GET', '/api/messages')).unread, 1);
  // Stored encrypted at rest: the words are not in the database file.
  b.m.checkpoint();
  for (const f of readdirSync(b.dir).filter((f) => f.startsWith('messages.db'))) assert.ok(!readFileSync(join(b.dir, f)).includes(words), `${f} holds no plain text`);

  // Read receipt back to A (on by default).
  await b.req('POST', `/api/messages/chats/${joined.chat.id}/read`, {});
  await b.m.flush();
  const aView = await a.req('GET', `/api/messages/chats/${aChat}`);
  assert.equal(aView.messages[0].id, sent.message.id);
  assert.ok(aView.messages[0].readAt, 'read receipt arrived');
  assert.equal((await b.req('GET', '/api/messages')).unread, 0);

  // Typing shows for a few seconds.
  await a.req('POST', `/api/messages/chats/${aChat}/typing`, {});
  await a.m.flush();
  assert.deepEqual((await b.req('GET', `/api/messages/chats/${joined.chat.id}`)).typing, ['Alex']);

  // Edit and delete propagate; only your own messages.
  await a.req('PATCH', `/api/messages/chats/${aChat}/m/${sent.message.id}`, { text: 'hello again' });
  await a.m.flush();
  assert.equal((await b.req('GET', `/api/messages/chats/${joined.chat.id}`)).messages[0].text, 'hello again');
  assert.ok((await b.req('GET', `/api/messages/chats/${joined.chat.id}`)).messages[0].editedAt);
  const notMine = await b.raw('PATCH', `/api/messages/chats/${joined.chat.id}/m/${sent.message.id}`, { text: 'forged' });
  assert.equal(notMine.status, 403);
  await a.req('DELETE', `/api/messages/chats/${aChat}/m/${sent.message.id}`);
  await a.m.flush();
  const gone = (await b.req('GET', `/api/messages/chats/${joined.chat.id}`)).messages[0];
  assert.equal(gone.deleted, true);
  assert.equal(gone.text, '');

  // Receipts and typing can be turned off: nothing goes out.
  await b.req('PUT', '/api/messages/settings', { receipts: false, typing: false });
  const m2 = await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'second' });
  await a.m.flush();
  await b.req('POST', `/api/messages/chats/${joined.chat.id}/read`, {});
  await b.req('POST', `/api/messages/chats/${joined.chat.id}/typing`, {});
  await b.m.flush();
  const aAfter = await a.req('GET', `/api/messages/chats/${aChat}`);
  assert.equal(aAfter.messages.find((x: any) => x.id === m2.message.id).readAt, null);
  assert.deepEqual(aAfter.typing, []);
});

test('S9a: a picture within limits travels; other files and oversize ones are refused', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { aChat, bChat } = await link(a, b);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  const sent = await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: '', file: { name: 'dot.png', data: png.toString('base64') } });
  assert.equal(sent.message.file.type, 'image/png');
  await a.m.flush();
  const got = (await b.req('GET', `/api/messages/chats/${bChat}`)).messages[0];
  assert.equal(got.file.name, 'dot.png');
  const file = await b.raw('GET', `/api/messages/chats/${bChat}/m/${got.id}/file`);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  const exe = await a.raw('POST', `/api/messages/chats/${aChat}/send`, { file: { name: 'x.exe', data: Buffer.from('MZ\x90\x00 not a picture').toString('base64') } });
  assert.equal(exe.status, 400);
  const big = await a.raw('POST', `/api/messages/chats/${aChat}/send`, { file: { name: 'big.txt', data: Buffer.alloc(6 * 1024 * 1024, 97).toString('base64') } });
  assert.ok([400, 413].includes(big.status));
});

test('S9a: offline queue: a message to a server that is down waits and is delivered when it is back', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { aChat, bChat } = await link(a, b);
  // B goes down: a copy of its messenger keeps the same data so it can come back on another port.
  const port = Number(new URL(b.base).port);
  await b.stop();
  const sent = await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'are you there?' });
  await a.m.flush();
  assert.equal((await a.req('GET', `/api/messages/chats/${aChat}`)).messages[0].state, 'queued');
  // Retry waits (back-off): a tick right away sends nothing.
  await a.m.due(clock.now);
  assert.equal(a.m.outboxSize(), 1);
  // B is back on the same address.
  const srv = createSaraServer({ app: b.app, auth: new OwnerAuth(b.dir, () => clock.now), webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(port, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => srv.close(() => ok())));
  tick(2 * 60_000);
  await a.m.due(clock.now);
  assert.equal(a.m.outboxSize(), 0);
  assert.equal((await a.req('GET', `/api/messages/chats/${aChat}`)).messages[0].state, 'sent');
  const got = b.m.messages(bChat);
  assert.equal(got[0].id, sent.message.id);
  assert.equal(got[0].text, 'are you there?');
});

test('S9a: retention: 30 days by default, per person and per chat; old messages are purged on the tick', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { aChat, bChat } = await link(a, b);
  assert.equal((await a.req('GET', '/api/messages')).settings.retentionDays, 30);
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'old one' });
  await a.m.flush();
  // Bo keeps this chat for 7 days only; Alex keeps the default.
  await b.req('PATCH', `/api/messages/chats/${bChat}`, { retentionDays: 7 });
  tick(8 * 86_400_000);
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'new one' });
  await a.m.flush();
  await a.m.due(clock.now);
  await b.m.due(clock.now);
  assert.deepEqual(b.m.messages(bChat).map((x) => x.text), ['new one']);
  assert.deepEqual(a.m.messages(aChat).map((x) => x.text), ['old one', 'new one']);
  tick(23 * 86_400_000);
  await a.m.due(clock.now);
  assert.deepEqual(a.m.messages(aChat).map((x) => x.text), ['new one'], 'the default 30 days');
  // Keep forever (0) is a choice too.
  await a.req('PUT', '/api/messages/settings', { retentionDays: 0 });
  tick(400 * 86_400_000);
  await a.m.due(clock.now);
  assert.equal(a.m.messages(aChat).length, 1);
});

test('S9a: signatures: a forged, replayed, stale or unknown-link envelope is refused', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { aChat, bChat } = await link(a, b);
  const linkId = b.m.chat(bChat)!.linkId!;
  const body = JSON.stringify({ v: 1, id: 'ev-' + Date.now(), type: 'dm', mid: 'm-forged', text: 'forged', at: clock.now.toISOString() });
  // Signed with a key that is not the link's.
  const { generateKeyPairSync } = await import('node:crypto');
  const wrong = generateKeyPairSync('ed25519').privateKey;
  const post = (headers: Record<string, string>, b2 = body) => fetch(a.base + '/msg/v1/inbox', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b2 });
  assert.equal((await post(signEnvelope(linkId, body, wrong, clock.now))).status, 401);
  assert.equal((await post({ 'sara-msg-link': linkId, 'sara-msg-time': clock.now.toISOString(), 'sara-msg-sig': 'AAAA' })).status, 401);
  assert.equal((await post(signEnvelope('nolink', body, wrong, clock.now))).status, 401);
  // A properly signed one goes through once; the same envelope again is a replay.
  const key = b.m.privateKeyFor(linkId)!;
  assert.equal((await post(signEnvelope(linkId, body, key, clock.now))).status, 200);
  assert.equal((await post(signEnvelope(linkId, body, key, clock.now))).status, 409);
  // A changed body under an old signature fails; so does an old timestamp.
  const h = signEnvelope(linkId, body, key, clock.now);
  assert.equal((await post(h, body.replace('forged', 'tampered'))).status, 401);
  const body2 = body.replace('ev-', 'ev2-');
  assert.equal((await post(signEnvelope(linkId, body2, key, new Date(clock.now.getTime() - 10 * 60_000)), body2)).status, 401);
  assert.equal(a.m.messages(aChat).length, 1);
});

test('S9a: communities: anyone with the code joins; the host fans out; mods; kick, ban (enforced by the host) and a new code', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const c = await node(t, 'Cy');
  const made = await a.req('POST', '/api/messages/communities', { name: 'Book club' });
  const cid = made.chat.id;
  const { code } = await a.req('POST', `/api/messages/communities/${cid}/code`, { url: a.base });
  const bj = await b.req('POST', '/api/messages/join', { code, url: b.base });
  const cj = await c.req('POST', '/api/messages/join', { code, url: c.base }); // the same code works for many
  assert.equal(bj.chat.kind, 'community');
  await a.m.flush();
  await b.req('POST', `/api/messages/chats/${bj.chat.id}/send`, { text: 'hi club' });
  await b.m.flush();
  await a.m.flush();
  assert.deepEqual(a.m.messages(cid).map((x) => x.text), ['hi club']);
  assert.deepEqual(c.m.messages(cj.chat.id).map((x) => [x.text, x.author]), [['hi club', 'Bo']]);
  const roster = (await c.req('GET', `/api/messages/chats/${cj.chat.id}`)).members;
  assert.deepEqual(roster.map((x: any) => x.name).sort(), ['Alex', 'Bo', 'Cy']);
  // Report to the creator.
  const msgId = c.m.messages(cj.chat.id)[0].id;
  await c.req('POST', `/api/messages/chats/${cj.chat.id}/m/${msgId}/report`, { why: 'spam' });
  await c.m.flush();
  assert.equal((await a.req('GET', `/api/messages/chats/${cid}`)).reports.length, 1);
  // Alex makes Cy a moderator; Cy bans Bo; the host enforces it.
  const host = await a.req('GET', `/api/messages/chats/${cid}`);
  const bo = host.members.find((x: any) => x.name === 'Bo');
  const cy = host.members.find((x: any) => x.name === 'Cy');
  await a.req('POST', `/api/messages/communities/${cid}/members/${cy.id}`, { action: 'mod' });
  await a.m.flush();
  const cyView = await c.req('GET', `/api/messages/chats/${cj.chat.id}`);
  assert.equal(cyView.chat.role, 'mod');
  await c.req('POST', `/api/messages/communities/${cj.chat.id}/members/${cyView.members.find((x: any) => x.name === 'Bo').id}`, { action: 'ban' });
  await c.m.flush();
  await a.m.flush();
  assert.equal((await a.req('GET', `/api/messages/chats/${cid}`)).members.some((x: any) => x.name === 'Bo'), false);
  assert.equal(b.m.chat(bj.chat.id)!.status, 'ended', 'Bo is told');
  // Bo's server can no longer post (its link is gone at the host) nor join again with the code.
  const retry = await b.raw('POST', '/api/messages/join', { code, url: b.base });
  assert.equal(retry.status, 400);
  // A new code: the old one stops working for newcomers.
  const d = await node(t, 'Di');
  const fresh = await a.req('POST', `/api/messages/communities/${cid}/code`, { url: a.base });
  assert.notEqual(fresh.code, code);
  assert.equal((await d.raw('POST', '/api/messages/join', { code, url: d.base })).status, 400);
  assert.equal((await d.req('POST', '/api/messages/join', { code: fresh.code, url: d.base })).chat.kind, 'community');
  void bo;
});

test('S9a: block, mute, unlink (keys gone on both sides; history kept or removed by choice)', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { aChat, bChat } = await link(a, b);
  const notified: string[] = [];
  b.m.onNotify = (title) => void notified.push(title);
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'one' });
  await a.m.flush();
  assert.equal(notified.length, 1);
  await b.req('PATCH', `/api/messages/chats/${bChat}`, { muted: true });
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'two' });
  await a.m.flush();
  assert.equal(notified.length, 1, 'muted: no notification');
  assert.equal(b.m.messages(bChat).length, 2);
  await b.req('PATCH', `/api/messages/chats/${bChat}`, { blocked: true });
  await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: 'three' });
  await a.m.flush();
  assert.equal(b.m.messages(bChat).length, 2, 'blocked: dropped');
  // Unlink from A, keeping history; B's side ends and its key is deleted too.
  const linkA = a.m.chat(aChat)!.linkId!;
  const linkB = b.m.chat(bChat)!.linkId!;
  await a.req('DELETE', `/api/messages/links/${linkA}?history=keep`);
  assert.equal(a.m.privateKeyFor(linkA), undefined);
  assert.equal(b.m.privateKeyFor(linkB), undefined);
  assert.equal(a.m.chat(aChat)!.status, 'ended');
  assert.equal(a.m.messages(aChat).length, 3);
  assert.equal(b.m.chat(bChat)!.status, 'ended');
  // B removes the history it kept.
  await b.req('DELETE', `/api/messages/chats/${bChat}`);
  assert.equal(b.m.chat(bChat), undefined);
});

test('S9a: owner only: household members and the peer endpoint on a member space get nothing', async (t) => {
  const mem = await node(t, 'Mo', { member: true });
  for (const [m, p] of [['GET', '/api/messages'], ['POST', '/api/messages/invite'], ['POST', '/api/messages/join']] as const) {
    const r = await mem.raw(m, p, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const peer = await fetch(mem.base + '/msg/v1/inbox', { method: 'POST', body: '{}' });
  assert.equal(peer.status, 404);
});

test('S9a: the agents are not involved: messages never reach the model, memory, tools, search or logs', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const { aChat, bChat } = await link(a, b);
  const words = SECRET();
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...x: unknown[]) => void logged.push(x.map(String).join(' '));
  try {
    await a.req('POST', `/api/messages/chats/${aChat}/send`, { text: `the code is ${words}` });
    await a.m.flush();
    await b.req('POST', `/api/messages/chats/${bChat}/send`, { text: `got ${words}` });
    await b.m.flush();
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!logged.some((l) => l.includes(words)), 'never logged');
  // A chat turn with her afterwards: nothing of the message is in what the model gets.
  for (const app of [a.app, b.app]) {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() } as never);
    app.script.push(text('Hi!'));
    const conv = app.store.createConversation({ title: 'x' });
    for await (const _ of runTurn(app, conv.id, 'What did my friend message me?')) void _;
    assert.ok(app.requests.length >= 1, 'the model was asked');
    assert.match(JSON.stringify(app.requests), /What did my friend message me/);
    const seen = JSON.stringify(app.requests);
    assert.ok(!seen.includes(words), 'not in the model request');
    assert.ok(!seen.includes('/msg/v1') && !/messages\.db/.test(seen));
    // No tool can read them.
    assert.ok(!app.tools.list().some((tl) => /^(pm_|msg_|message)/.test(tl.spec.name)), 'no message tool');
    // Not in her memory or the conversation store (the search index reads these).
    assert.ok(!JSON.stringify(app.memory!.listAll()).includes(words));
    assert.equal(app.memory!.search(words).length, 0);
    app.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of readdirSync(app.dataDir).filter((f) => f.startsWith('sara.db'))) assert.ok(!readFileSync(join(app.dataDir, f)).includes(words), `${f} holds nothing`);
  }
  // Only the messenger, its routes, the server mount and main.ts know about the module.
  const users: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && /from '\.\.?\/(\.\.\/)?messages\.ts'/.test(readFileSync(p, 'utf8'))) users.push(p.slice(join(ROOT, 'src').length + 1).replaceAll('\\', '/'));
    }
  };
  walk(join(ROOT, 'src'));
  // S9b's support link and T5's remote repair import only the Messenger type (link keys and notices, never a message).
  assert.deepEqual(users.sort(), ['main.ts', 'remote-repair.ts', 'routes/messages.ts', 'support.ts']);
  for (const f of ['support.ts', 'remote-repair.ts']) assert.match(readFileSync(join(ROOT, 'src', f), 'utf8'), /import type \{ Messenger \} from '\.\/messages\.ts'/);
  assert.ok(existsSync(join(a.dir, 'messages.db')), 'its own database file, never sara.db');
});
