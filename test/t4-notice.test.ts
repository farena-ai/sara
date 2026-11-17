// T4 (docs/MESSAGES.md, ROADMAP_T T4): Messages notices. The link code expires, the link does not
// (say so); one-to-one messages get a popup + push; communities stay quiet (their own small count)
// unless the owner is @mentioned or picked "everything"; the sidebar badge counts one-to-one unread
// plus mentions only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { isMention, Messenger, notifyRoute } from '../src/messages.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
type Notice = { title: string; body: string; chat: string; info?: { kind: string; mention: boolean } };
type Node = { m: Messenger; base: string; notices: Notice[]; req: (method: string, path: string, body?: unknown) => Promise<any> };
const clock = { now: new Date('2026-11-16T12:00:00Z') };

async function node(t: TestContext, name: string): Promise<Node> {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  app.messages = m;
  const notices: Notice[] = [];
  m.onNotify = (title, body, chat, info) => void notices.push({ title, body, chat, ...(info ? { info } : {}) });
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()));
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { m, base, notices, req };
}

test('T4: mentions match @name (full or first name), not plain words or e-mail addresses', () => {
  assert.equal(isMention('hey @Bo, look', 'Bo'), true);
  assert.equal(isMention('@bo look', 'Bo'), true, 'any case');
  assert.equal(isMention('thanks @Alex!', 'Alex Morgan'), true, 'first name');
  assert.equal(isMention('cc @Alex Morgan', 'Alex Morgan'), true, 'full name');
  assert.equal(isMention('Bo said hi', 'Bo'), false, 'no @');
  assert.equal(isMention('mail bob@Bo.net', 'Bo'), false, 'inside a word');
  assert.equal(isMention('@Bobby hi', 'Bo'), false, 'a longer name');
  assert.equal(isMention('@ hi', ''), false);
});

test('T4: notice routing per chat kind, setting and mention', () => {
  // One-to-one: always a full notice (popup + push) unless muted or blocked.
  assert.equal(notifyRoute({ kind: 'direct', muted: false, blocked: false, level: 'mentions', mention: false }), 'full');
  assert.equal(notifyRoute({ kind: 'direct', muted: true, blocked: false, level: 'all', mention: false }), 'none');
  assert.equal(notifyRoute({ kind: 'direct', muted: false, blocked: true, level: 'all', mention: false }), 'none');
  // Communities: quiet by default, full for a mention or "everything", nothing for "nothing" or muted.
  assert.equal(notifyRoute({ kind: 'community', muted: false, blocked: false, level: 'mentions', mention: false }), 'quiet');
  assert.equal(notifyRoute({ kind: 'community', muted: false, blocked: false, level: 'mentions', mention: true }), 'full');
  assert.equal(notifyRoute({ kind: 'community', muted: false, blocked: false, level: 'all', mention: false }), 'full');
  assert.equal(notifyRoute({ kind: 'community', muted: false, blocked: false, level: 'none', mention: true }), 'none');
  assert.equal(notifyRoute({ kind: 'community', muted: true, blocked: false, level: 'all', mention: true }), 'none');
});

test('T4: settings defaults and validation (popup on, sound off, communities: mentions)', async (t) => {
  const a = await node(t, 'Alex');
  const s = a.m.settings();
  assert.equal(s.popup, true);
  assert.equal(s.sound, false);
  assert.equal(s.communityNotify, 'mentions');
  const r = await a.req('PUT', '/api/messages/settings', { popup: false, sound: true, communityNotify: 'all' });
  assert.deepEqual([r.settings.popup, r.settings.sound, r.settings.communityNotify], [false, true, 'all']);
  await assert.rejects(a.req('PUT', '/api/messages/settings', { communityNotify: 'loud' }), /400/);
});

test('T4: community posts are quiet, mentions and one-to-one messages notify; badge = one-to-one + mentions', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const made = await a.req('POST', '/api/messages/communities', { name: 'Book club' });
  const cid = made.chat.id;
  const { code } = await a.req('POST', `/api/messages/communities/${cid}/code`, { url: a.base });
  const bj = await b.req('POST', '/api/messages/join', { code, url: b.base });
  await a.m.flush();
  const bc = bj.chat.id;
  // A plain community post: no push, no popup on Bo's side; a quiet count only.
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: 'chapter 3 tonight' });
  await a.m.flush();
  assert.equal(b.notices.length, 0, 'no notice for a plain community post');
  let list = await b.req('GET', '/api/messages');
  assert.equal(list.unread, 0, 'the sidebar badge ignores community posts');
  assert.equal(list.community, 1, 'the quiet community count');
  assert.equal(list.chats.find((c: any) => c.id === bc).notify, null, 'uses the default');
  // An @mention of Bo: a full notice, and it counts in the badge.
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: '@Bo can you bring the book?' });
  await a.m.flush();
  assert.equal(b.notices.length, 1);
  assert.deepEqual(b.notices[0].info, { kind: 'community', mention: true });
  list = await b.req('GET', '/api/messages');
  assert.equal(list.unread, 1, 'a mention counts');
  assert.equal(list.community, 2);
  assert.equal(list.chats.find((c: any) => c.id === bc).mentions, 1);
  // A one-to-one link and message: full notice; badge = 1 one-to-one + 1 mention.
  const inv = await a.req('POST', '/api/messages/invite', { url: a.base });
  await b.req('POST', '/api/messages/join', { code: inv.code, url: b.base });
  const aDirect = (await a.req('GET', '/api/messages')).chats.find((c: any) => c.kind === 'direct').id;
  await a.req('POST', `/api/messages/chats/${aDirect}/send`, { text: 'hi Bo' });
  await a.m.flush();
  assert.equal(b.notices.length, 2);
  assert.deepEqual(b.notices[1].info, { kind: 'direct', mention: false });
  list = await b.req('GET', '/api/messages');
  assert.equal(list.unread, 2, 'one-to-one 1 + mention 1');
  assert.equal(list.community, 2, 'community unread stays inside Messages');
  // Notify me: everything → a plain post notifies; nothing → silent and out of every count.
  await b.req('PATCH', `/api/messages/chats/${bc}`, { notify: 'all' });
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: 'see you all' });
  await a.m.flush();
  assert.equal(b.notices.length, 3);
  await b.req('PATCH', `/api/messages/chats/${bc}`, { notify: 'none' });
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: '@Bo last call' });
  await a.m.flush();
  assert.equal(b.notices.length, 3, 'nothing means nothing, mentions too');
  list = await b.req('GET', '/api/messages');
  assert.equal(list.unread, 1, 'only the one-to-one message');
  assert.equal(list.community, 0);
  assert.equal(list.chats.find((c: any) => c.id === bc).unread, 4, 'still listed as unread inside the chat row');
  // Back to the default; reading the chat clears everything.
  await b.req('PATCH', `/api/messages/chats/${bc}`, { notify: null });
  await b.req('POST', `/api/messages/chats/${bc}/read`, {});
  list = await b.req('GET', '/api/messages');
  assert.equal(list.community, 0);
  assert.equal(list.unread, 1);
  // The server-wide default "everything" makes communities notify like one-to-one chats.
  await b.req('PUT', '/api/messages/settings', { communityNotify: 'all' });
  await a.req('POST', `/api/messages/chats/${cid}/send`, { text: 'new book picked' });
  await a.m.flush();
  assert.equal(b.notices.length, 4);
  await assert.rejects(b.req('PATCH', `/api/messages/chats/${bc}`, { notify: 'loud' }), /400/);
});

test('T4: the host side follows the same rules for members’ posts', async (t) => {
  const a = await node(t, 'Alex');
  const b = await node(t, 'Bo');
  const made = await a.req('POST', '/api/messages/communities', { name: 'Hikes' });
  const { code } = await a.req('POST', `/api/messages/communities/${made.chat.id}/code`, { url: a.base });
  const bj = await b.req('POST', '/api/messages/join', { code, url: b.base });
  await a.m.flush();
  await b.req('POST', `/api/messages/chats/${bj.chat.id}/send`, { text: 'trail is muddy' });
  await b.m.flush();
  assert.equal(a.notices.length, 0);
  await b.req('POST', `/api/messages/chats/${bj.chat.id}/send`, { text: 'right @alex?' });
  await b.m.flush();
  assert.equal(a.notices.length, 1);
  const list = await a.req('GET', '/api/messages');
  assert.deepEqual([list.unread, list.community], [1, 2]);
});

test('T4: wording, popup card, quiet indicator and settings rows in the page', () => {
  const js = read('web/messages.js');
  const html = read('web/index.html');
  // The code expires; the link does not.
  assert.ok(js.includes("t('This code works once, for 30 minutes. Once you’re linked, you stay linked until either of you unlinks.')"));
  assert.ok(js.includes("t('Linked since {date}'"));
  // The popup: body-level, polite live region, never takes focus (MSGPOP: one top card, no auto-hide).
  assert.match(js, /aria-live', 'polite'/);
  const pop = js.slice(js.indexOf('function showPopup'), js.indexOf('// end popup'));
  assert.ok(pop.length > 100, 'showPopup exists');
  assert.ok(!/\.focus\(/.test(pop), 'the popup never takes focus');
  // The quiet community count is not the accent badge.
  assert.ok(js.includes('msgs-quiet'));
  // Settings rows, each with a tip.
  for (const id of ['msgs-popup', 'msgs-sound', 'msgs-community']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, id);
    const row = html.slice(html.lastIndexOf('<label', at), html.indexOf('</label>', at));
    assert.match(row, /class="tip"/, `${id} has a tip`);
  }
  // Sound is off by default and made in the page (no audio file, no autoplay before a gesture).
  assert.match(js, /AudioContext/);
  // The SSE event carries ids and a notice flag only (never text).
  const main = read('src/main.ts');
  assert.match(main, /type: 'pm', chat, notice: true/);
  assert.match(read('src/events.ts'), /type: 'pm'; chat: string; notice\?: boolean/);
});

test('T4: every new string is translated', () => {
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = read(`web/i18n/${lang}.json`);
    for (const k of ['This code works once, for 30 minutes. Once you’re linked, you stay linked until either of you unlinks.', 'Linked since {date}', 'Notify me', 'When I’m mentioned']) assert.ok(tr.includes(JSON.stringify(k)), `${lang}: ${k}`);
  }
});
