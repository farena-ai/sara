// Phase 108 (CH2): a tidy session list (docs/design/CHATS.md §5.8 "Done when"): channel projects,
// the one-time filing and its Undo, rename / hide / delete / archive rules, filing that sticks
// through /new, See more paging (client rule and the server's pages), room chips, static checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { channelProjectFor, fileChannelChats, filedCount, FILED_KEY, unfileChannelChats } from '../src/bridges/rooms.ts';
import { DISCORD_VAULT, DiscordBridge, type GatewaySocket } from '../src/bridges/discord.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { exportAll, importAll } from '../src/export.ts';
import { createSaraServer } from '../src/server.ts';
import { tipCoverage } from '../scripts/tip-coverage.ts';
import { listen, makeApp, readBody, tempDir, text, type TestApp } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const OWNER = 1001;
let uid = 1;
interface Row {
  id: string;
  updatedAt: string;
  endedAt?: string | null;
  sessionOf?: string | null;
  channel?: string;
  channelKey?: string;
  room?: { kind: string; title: string; parent: string | null };
}
interface Chain {
  head: Row;
  earlier: Row[];
}
/** web/session-list.js (plain JS, shared by the sidebar and the project page). */
const list = (await import(pathToFileURL(join(ROOT, 'web', 'session-list.js')).href)) as {
  PAGE_STEP: number;
  pageOf: (convs: Row[], o: { shown: number; total?: number; size?: number }) => { rows: Chain[]; more: number; less: boolean; needsFetch: boolean };
  chains: (convs: Row[]) => Chain[];
  byRoom: (convs: Row[]) => { key: string; convs: Row[] }[];
  pageSize: (storage: { getItem: (k: string) => string | null }) => number;
};

async function fakeTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  return { sent, close: () => server.close(), url };
}

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-31T20:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: new Date().toISOString() });
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const c of closers.reverse()) c();
    app.store.close();
    cleanup();
  });
  return { app, dir, clock, closers };
}

async function tgBridge(t: { after: (fn: () => void) => void }) {
  const s = setup(t);
  const tg = await fakeTelegram();
  s.app.settings.update({ telegram: { enabled: true, allowOthers: true, mirror: false, ownerChatId: OWNER } });
  s.app.vault.set(TELEGRAM_VAULT, '123456789:test');
  const bridge = new TelegramBridge(s.app, { apiBase: tg.url });
  await bridge.restart();
  await bridge.menus;
  s.closers.push(() => tg.close(), () => bridge.stop());
  return { ...s, bridge };
}
const dm = (chatId: number, txt: string, name = 'Alex') => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, first_name: name }, text: txt } });
const grp = (chatId: number, fromId: number, txt: string, title = 'Book club') => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'supergroup' as const, title }, from: { id: fromId, first_name: 'Bob' }, text: txt } });

async function server(t: { after: (fn: () => void) => void }, app: TestApp, dir: string, closers: (() => void)[]) {
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '2.41.0', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => srv.close());
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: ['Bearer', token].join(' '), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> & { conversations?: { id: string; updatedAt: string; title: string; projectId: number | null }[] } };
  };
}

test('the table: Telegram and Discord families, one project per plugin bridge; web and the rest never', () => {
  for (const ch of ['telegram', 'telegram-nsfw', 'telegram-work', 'telegram-work-nsfw']) assert.equal(channelProjectFor(ch)?.builtin, 'channel:telegram', ch);
  for (const ch of ['discord', 'discord-nsfw', 'discord-work', 'discord-work-nsfw']) assert.equal(channelProjectFor(ch)?.name, 'Discord', ch);
  assert.deepEqual(channelProjectFor('plugin-signal'), { builtin: 'channel:plugin-signal', name: 'Signal', kind: 'plugin', bridge: 'plugin-signal' });
  assert.equal(channelProjectFor('plugin-whatsapp')?.name, 'WhatsApp');
  assert.equal(channelProjectFor('plugin-line')?.name, 'LINE');
  assert.equal(channelProjectFor('plugin-chat-hub', 'Chat Hub bridge')?.name, 'Chat Hub bridge', "else the plugin's own name");
  for (const ch of ['web', 'api', 'mcp', 'home-assistant', 'alexa', 'a2a', 'webhook', 'group', 'board', 'import-chatgpt', 'telegramx']) assert.equal(channelProjectFor(ch), undefined, ch);
});

test('first Telegram message: a builtin Telegram project holds it; his own "Telegram" project is untouched', async (t) => {
  const { app, bridge } = await tgBridge(t);
  app.script.push(text('Hi Alex.'));
  await bridge.handle(dm(OWNER, 'hello'));
  const conv = app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!;
  const p = app.planner!.builtinProject('channel:telegram')!;
  assert.equal(p.name, 'Telegram');
  assert.equal(conv.projectId, p.id);
  // A group chat (a partner conversation) lands there too.
  app.script.push(text('Hello, book club.'));
  await bridge.handle(grp(-100700, 4242, '@sara_test_bot hi'));
  assert.equal(app.store.currentChannelConversation('telegram', '-100700', 'partner')!.projectId, p.id);

  // A server where he already has a project called "Telegram".
  const b = await tgBridge(t);
  const his = b.app.planner!.projectId('telegram')!;
  b.app.script.push(text('Hi.'));
  await b.bridge.handle(dm(OWNER, 'hello'));
  const builtin = b.app.planner!.builtinProject('channel:telegram')!;
  assert.equal(builtin.name, 'Telegram chats');
  assert.notEqual(builtin.id, his);
  const mine = b.app.planner!.projects().find((x) => x.id === his)!;
  assert.equal(mine.builtin, null, 'his project is never taken over');
  assert.equal(mine.name, 'telegram');
  assert.equal(b.app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!.projectId, builtin.id);
});

test('the one-time filing moves only unfiled bridge chats; Undo puts exactly those back', (t) => {
  const { app } = setup(t);
  const s = app.store;
  const garden = app.planner!.projectId('Garden')!;
  const mk = (channel: string, extra: Record<string, unknown> = {}) => s.createConversation({ title: channel, channel, channelKey: `${channel}-1`, ...extra }).id;
  const tg = [mk('telegram'), mk('telegram-work'), mk('telegram-nsfw', { partner: 'Bob' })];
  const dc = [mk('discord'), mk('discord-work-nsfw')];
  const sig = mk('plugin-signal');
  const filedByHim = mk('telegram', { projectId: garden, channelKey: 'other' });
  const never = ['web', 'api', 'mcp', 'home-assistant', 'alexa', 'a2a', 'webhook', 'group', 'import-chatgpt'].map((ch) => mk(ch));
  const r = fileChannelChats(app);
  assert.equal(r.moved, 6);
  const tp = app.planner!.builtinProject('channel:telegram')!.id;
  const dp = app.planner!.builtinProject('channel:discord')!.id;
  const sp = app.planner!.builtinProject('channel:plugin-signal')!;
  assert.equal(sp.name, 'Signal');
  for (const id of tg) assert.equal(s.getConversation(id)!.projectId, tp);
  for (const id of dc) assert.equal(s.getConversation(id)!.projectId, dp);
  assert.equal(s.getConversation(sig)!.projectId, sp.id);
  assert.equal(s.getConversation(filedByHim)!.projectId, garden, 'his own filing stays');
  for (const id of never) assert.equal(s.getConversation(id)!.projectId, null, s.getConversation(id)!.channel);
  // Filing doesn't count as activity, and it runs once.
  assert.deepEqual(fileChannelChats(app), { moved: 0, already: true });
  assert.ok(app.memory!.kvGet(FILED_KEY));
  assert.equal(filedCount(app, tp), 3);
  // He moves one out before pressing Undo: it stays where he put it. A new chat filed later stays too.
  s.updateConversation(tg[1], { projectId: garden });
  const later = mk('telegram', { channelKey: 'later', projectId: tp });
  assert.equal(filedCount(app, tp), 2);
  assert.equal(unfileChannelChats(app, tp), 2);
  assert.equal(s.getConversation(tg[0])!.projectId, null);
  assert.equal(s.getConversation(tg[2])!.projectId, null);
  assert.equal(s.getConversation(tg[1])!.projectId, garden);
  assert.equal(s.getConversation(later)!.projectId, tp);
  assert.equal(s.getConversation(dc[0])!.projectId, dp, 'Undo is per project');
  assert.equal(filedCount(app, tp), 0);
  assert.equal(unfileChannelChats(app, tp), 0, 'Undo happens once');
});

test('routes: rename and hide work; archive refused; delete refused (409) while the channel is on, allowed after', async (t) => {
  const { app, dir, closers } = setup(t);
  const api = await server(t, app, dir, closers);
  app.settings.update({ telegram: { enabled: true } });
  const conv = app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '1001' });
  fileChannelChats(app);
  const p = app.planner!.builtinProject('channel:telegram')!;
  const list = await api('GET', '/projects');
  const row = (list.json as unknown as { id: number; builtin: string; hidden: boolean; channel: { kind: string; on: boolean; name: string }; filed: number; conversations: number }[]).find((x) => x.id === p.id)!;
  assert.deepEqual([row.builtin, row.hidden, row.channel.kind, row.channel.on, row.channel.name, row.filed, row.conversations], ['channel:telegram', false, 'telegram', true, 'Telegram', 1, 1]);
  const ren = await api('PATCH', `/projects/${p.id}`, { name: 'My Telegram' });
  assert.equal(ren.status, 200);
  assert.equal(ren.json.name, 'My Telegram');
  assert.equal(app.planner!.builtinProject('channel:telegram')!.name, 'My Telegram', 'the builtin key stays');
  const hide = await api('PATCH', `/projects/${p.id}`, { hidden: true });
  assert.equal(hide.json.hidden, true);
  assert.equal((await api('PATCH', `/projects/${p.id}`, { status: 'archived' })).status, 409, "a channel project can't be archived");
  assert.equal((await api('PATCH', `/projects/${p.id}`, { workspace: 'main' })).status, 400, 'name and Hide only');
  const own = app.planner!.projectId('Kitchen')!;
  assert.equal((await api('PATCH', `/projects/${own}`, { hidden: true })).status, 400, 'his projects are archived, not hidden');
  assert.equal((await api('PATCH', `/projects/${own}`, { name: 'my telegram' })).status, 409, 'names stay unique');
  const del = await api('DELETE', `/projects/${p.id}`);
  assert.equal(del.status, 409);
  assert.match(String(del.json.error), /This project holds the Telegram chats\. Turn Telegram off first, or hide it\./);
  assert.equal(del.json.errorKey, 'This project holds the {channel} chats. Turn {channel} off first, or hide it.');
  // The session is still searchable and in the full list while hidden.
  assert.ok(((await api('GET', '/conversations')).json as unknown as { id: string }[]).some((c) => c.id === conv.id));
  // Undo through the route.
  const un = await api('POST', `/projects/${p.id}/unfile`, {});
  assert.deepEqual(un.json, { ok: true, moved: 1 });
  assert.equal(app.store.getConversation(conv.id)!.projectId, null);
  app.settings.update({ telegram: { enabled: false } });
  const del2 = await api('DELETE', `/projects/${p.id}`);
  assert.equal(del2.status, 200);
  assert.equal(app.planner!.builtinProject('channel:telegram'), undefined);
});

test('a session he moved out stays out, and /new follows his filing', async (t) => {
  const { app, bridge } = await tgBridge(t);
  app.script.push(text('Hi.'));
  await bridge.handle(dm(OWNER, 'hello'));
  const first = app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!;
  const garden = app.planner!.projectId('Garden')!;
  app.store.updateConversation(first.id, { projectId: garden });
  app.script.push(text('Still here.'));
  await bridge.handle(dm(OWNER, 'more'));
  assert.equal(app.store.getConversation(first.id)!.projectId, garden, 'new messages leave it where he put it');
  await bridge.handle(dm(OWNER, '/new'));
  const next = app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!;
  assert.notEqual(next.id, first.id);
  assert.equal(next.projectId, garden, '/new keeps the previous session\'s project');
  app.script.push(text('Fresh.'));
  await bridge.handle(dm(OWNER, 'next'));
  assert.ok(app.store.messages(next.id).some((m) => m.content === 'next'));
});

test('paging (client rule): 30 sessions → 8 rows + See more (22); a press adds 20; ended sessions sit under their chat', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  const convs = Array.from({ length: 30 }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}`, updatedAt: at(i), endedAt: null, sessionOf: null }));
  const p1 = list.pageOf(convs, { shown: 8, size: 8 });
  assert.equal(p1.rows.length, 8);
  assert.equal(p1.more, 22);
  assert.equal(p1.rows[0].head.id, 'c29', 'newest first');
  assert.equal(p1.less, false);
  const p2 = list.pageOf(convs, { shown: 8 + list.PAGE_STEP, size: 8 });
  assert.equal(p2.rows.length, 28);
  assert.equal(p2.more, 2);
  assert.equal(p2.less, true, 'Show less after the first page');
  // Rows the app hasn't loaded yet count too (the server's total).
  const p3 = list.pageOf(convs, { shown: 28, total: 230, size: 8 });
  assert.equal(p3.more, 202);
  assert.equal(list.pageOf(convs, { shown: 48, total: 230, size: 8 }).needsFetch, true);
  // One chat with /new twice: one row (the open session), two earlier ones under it.
  const chat = [
    { id: 'a1', updatedAt: at(1), endedAt: at(2), sessionOf: null },
    { id: 'a2', updatedAt: at(3), endedAt: at(4), sessionOf: 'a1' },
    { id: 'a3', updatedAt: at(5), endedAt: null, sessionOf: 'a1' },
    { id: 'w1', updatedAt: at(4), endedAt: null, sessionOf: null },
  ];
  const rows = list.chains(chat);
  assert.deepEqual(rows.map((r) => r.head.id), ['a3', 'w1']);
  assert.deepEqual(rows[0].earlier.map((c) => c.id), ['a2', 'a1']);
  // Page size: 5 / 8 / 10 on this device, 8 by default.
  const store = (v: string | null) => ({ getItem: () => v });
  assert.equal(list.pageSize(store(null)), 8);
  assert.equal(list.pageSize(store('5')), 5);
  assert.equal(list.pageSize(store('12')), 8);
  // Group by room: rooms in order of their newest session.
  const rooms = list.byRoom([
    { id: 'x', updatedAt: at(1), channel: 'discord', channelKey: '1', room: { kind: 'channel', title: 'general', parent: 'S' } },
    { id: 'y', updatedAt: at(9), channel: 'discord-work', channelKey: '2', room: { kind: 'channel', title: 'dev', parent: 'S' } },
    { id: 'z', updatedAt: at(5), channel: 'discord', channelKey: '1', room: { kind: 'channel', title: 'general', parent: 'S' } },
  ]);
  assert.deepEqual(rooms.map((r) => [r.key, r.convs.map((c) => c.id)]), [['discord:2', ['y']], ['discord:1', ['z', 'x']]]);
});

test('paging (server): limit/before pages are complete and in order, with equal updated_at; ?cap totals; project page limit', async (t) => {
  const { app, dir, closers } = setup(t);
  const api = await server(t, app, dir, closers);
  const proj = app.planner!.projectId('Long project')!;
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push(app.store.createConversation({ title: `s${i}`, projectId: proj }).id);
  // Ten of them share one time (a backfill or an import does that).
  app.store.db.prepare(`UPDATE conversations SET updated_at = '2026-10-01T00:00:00.000Z' WHERE id IN (${ids.slice(5, 15).map(() => '?').join(',')})`).run(...ids.slice(5, 15));
  for (let i = 0; i < 5; i++) app.store.createConversation({ title: `loose${i}` });
  const seen: string[] = [];
  let before = '';
  for (let guard = 0; guard < 10; guard++) {
    const r = await api('GET', `/conversations?project=${proj}&limit=7${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    assert.equal(r.status, 200);
    const page = r.json.conversations!;
    seen.push(...page.map((c) => c.id));
    assert.equal(r.json.more, 30 - seen.length);
    if (!r.json.more) break;
    const last = page.at(-1)!;
    before = `${last.updatedAt},${last.id}`;
  }
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30, 'no duplicates across pages');
  const all = app.store.listConversations().filter((c) => c.projectId === proj).sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1));
  assert.deepEqual(seen, all.map((c) => c.id), 'newest first, then id');
  const none = await api('GET', '/conversations?project=none&limit=50');
  assert.equal(none.json.conversations!.length, 5);
  assert.equal((await api('GET', '/conversations?project=abc')).status, 400);
  // ?cap: each group's newest N and the full counts.
  const cap = await api('GET', '/conversations?cap=20');
  assert.equal((cap.json.totals as Record<string, number>)[`p${proj}`], 30);
  assert.equal((cap.json.totals as Record<string, number>).none, 5);
  assert.equal(cap.json.conversations!.filter((c) => c.projectId === proj).length, 20);
  // The old form is unchanged for older apps (an array of everything).
  assert.equal(((await api('GET', '/conversations')).json as unknown as unknown[]).length, 35);
  // The project page: the newest 8 and how many more.
  const pg = await api('GET', `/projects/${proj}?limit=8`);
  assert.equal((pg.json.conversations as unknown[]).length, 8);
  assert.equal(pg.json.more, 22);
  assert.equal(((await api('GET', `/projects/${proj}`)).json.conversations as unknown[]).length, 30, 'without limit: all (older apps)');
});

test('discord: the first message files into Discord; the room gets its real name and chip (B3)', async (t) => {
  const { app, closers } = setup(t);
  const { server: srv, url } = await listen(async (req, res) => {
    const raw = await readBody(req);
    const path = req.url ?? '';
    let result: unknown = {};
    if (path === '/users/@me') result = { id: '900', username: 'Sara' };
    else if (path === '/channels/555' && req.method === 'GET') result = { id: '555', name: 'general', guild_id: '77', nsfw: false };
    else if (path === '/guilds/77') result = { id: '77', name: 'My Server' };
    else if (path.endsWith('/typing')) return void res.writeHead(204).end();
    void raw;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  app.settings.update({ discord: { enabled: true, allowServers: true, mirror: false, ownerUserId: '100' } });
  app.vault.set(DISCORD_VAULT, 'test-token');
  let sock: GatewaySocket | undefined;
  const bridge = new DiscordBridge(app, { api: url, connect: () => (sock = { send: () => undefined, close: () => undefined, onmessage: null, onclose: null }) });
  await bridge.restart();
  sock!.onmessage!(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: '900', username: 'Sara' }, application: { id: 'app1' } } }));
  await bridge.menus;
  closers.push(() => srv.close(), () => bridge.stop());
  app.script.push(text('Hello everyone.'));
  await bridge.handleMessage({ id: `${uid++}`, channel_id: '555', guild_id: '77', author: { id: '300', username: 'bob' }, content: '<@900> hi', mentions: [{ id: '900', username: 'Sara' }] });
  const conv = app.store.currentChannelConversation('discord', '555', 'partner')!;
  assert.equal(conv.projectId, app.planner!.builtinProject('channel:discord')!.id);
  assert.equal(conv.title, 'Discord: #general · My Server');
  const { roomOf, roomChip } = await import('../src/bridges/rooms.ts');
  assert.deepEqual(roomChip(roomOf(app, 'discord', '555')), { kind: 'channel', title: 'general', parent: 'My Server' });
});

test('export and import: a channel project lands in the other server\'s own channel project', (t) => {
  const a = setup(t).app;
  a.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '1001' });
  fileChannelChats(a);
  a.planner!.updateProject(a.planner!.builtinProject('channel:telegram')!.id, { name: 'TG' });
  const file = exportAll(a);
  const b = setup(t).app;
  b.planner!.createBuiltinProject('channel:telegram', 'Telegram');
  importAll(b, JSON.parse(JSON.stringify(file)));
  const p = b.planner!.builtinProject('channel:telegram')!;
  assert.equal(b.planner!.projects(true).filter((x) => x.builtin === 'channel:telegram').length, 1);
  assert.equal(b.store.listConversations().find((c) => c.channel === 'telegram')!.projectId, p.id);
  // Into a server without one: it becomes that server's channel project.
  const c = setup(t).app;
  importAll(c, JSON.parse(JSON.stringify(file)));
  assert.equal(c.planner!.builtinProject('channel:telegram')?.name, 'TG');
});

test('static: classes, 44 px targets, no inline styles, every new string translated, tips covered, service worker', () => {
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  for (const cls of ['.conv-more-row', '.conv-room-chip', '.group-builtin', '.conv-earlier', '.hidden-project']) assert.ok(css.includes(cls), cls);
  assert.match(css, /button\.conv-see-more, button\.conv-show-less \{ min-height: 44px;/);
  assert.match(css, /#conversations a\.conv \{ min-height: 44px; \}/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.ok(!/\sstyle="/.test(html), 'no inline style=');
  for (const id of ['pp-channel', 'pp-ch-shown', 'pp-ch-rooms', 'pp-ch-unfile', 'ap-sessions']) assert.ok(html.includes(`id="${id}"`), id);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.ok(!/style="/.test(app));
  const tips = (JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')) as { tips: Record<string, [string, string]> }).tips;
  for (const id of ['ap-sessions', 'pp-ch-shown', 'pp-ch-rooms']) assert.ok(tips[id] && tips[id][0].length <= 260, id);
  assert.equal(tipCoverage(html, tips).uncovered.length, 0);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const k of ['See more ({n})', 'Show less', 'Hidden projects ({n})', 'Group by room', 'Channel project', 'DM', '{name} (group)', 'This project holds the {channel} chats. Turn {channel} off first, or hide it.']) assert.ok(d[k], `${lang}: ${k}`);
  }
  assert.match(readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8'), /caches\.open\('sara-shell-v(4[2-9]|[5-9]\d)'\)/);
});
