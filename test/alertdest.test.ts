// ALERTDEST (docs/ALERTS_DESTINATIONS.md): the person chooses where her alerts and results go: the
// chat it was made in (today's behavior), one of their own chats, a project's chat named after the
// feed, a chat just for the feed, or only their chat apps; per feed and per item; by chat
// (alerts_route) and in Settings → Automations → Where alerts go.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { test, type TestContext } from 'node:test';
import { alertPlace, createAlertTools, describeDest, destFor, matchFeed, matchProject, postAlert, resolveTo, setFeedDest, setItemDest } from '../src/destinations.ts';
import { LiveWatches } from '../src/live-watch.ts';
import { PlannerStore } from '../src/planner.ts';
import { Automations } from '../src/automations.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (...p: string[]) => readFileSync([ROOT, ...p].join('/'), 'utf8');

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' });
  app.planner = new PlannerStore(app.store.db, () => clock.now);
  let price = 390;
  app.dataSources = { quotes: async (syms: string[]) => ({ quotes: syms.map((s) => ({ symbol: s, price, currency: 'USD', changePct: 1, at: clock.now.toISOString(), source: 'Test quotes' })) }), quota: () => undefined, provider: () => ({ id: 'x' }) } as never;
  app.push = { notifyOwner: async () => undefined } as never;
  const w = new LiveWatches(app, app.store.db);
  app.liveWatches = w;
  const chat = app.store.createConversation({ channel: 'web', title: 'Evening chat' });
  app.store.addMessage(chat.id, 'user', 'hi');
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const fire = async (to: number) => {
    price = to;
    clock.now = new Date(clock.now.getTime() + 61_000);
    return w.check(clock.now);
  };
  const cards = (id: string) => app.store.messages(id).filter((m) => m.content.startsWith('livewatch:'));
  const tool = createAlertTools(() => app)[0]!;
  const ctx = (conversationId?: string) => ({ conversationId, signal: AbortSignal.timeout(5000) }) as unknown as ToolContext;
  return { app, w, chat, fire, cards, tool, ctx, clock };
}

test('alertdest: default is where it was made (today); the feed default moves stock alerts into a project chat named after the feed', async (t) => {
  const r = rig(t);
  const a = r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 400, conversationId: r.chat.id });
  assert.deepEqual(destFor(r.app, 'stocks', `live:${a.id}`), { where: 'origin' });
  await r.fire(401);
  assert.equal(r.cards(r.chat.id).length, 1, 'origin = the chat it was made in');
  const pid = r.app.planner!.projectId('Stock Alerts')!;
  setFeedDest(r.app, 'stocks', { where: 'project', projectId: pid }, true);
  await r.fire(395);
  await r.fire(402);
  const conv = r.app.store.listConversations().find((c) => c.projectId === pid)!;
  assert.equal(conv.title, 'Stock alerts');
  assert.equal(r.cards(conv.id).length, 1, 'now in the project chat');
  assert.equal(r.cards(r.chat.id).length, 1, 'nothing more in the old chat');
  assert.equal(describeDest(r.app, 'stocks', `live:${a.id}`), 'Stock Alerts › Stock alerts');
  // The same chat next time (made once).
  await r.fire(395);
  await r.fire(403);
  assert.equal(r.cards(conv.id).length, 2);
  assert.equal(r.app.store.listConversations().filter((c) => c.projectId === pid).length, 1);
});

test('alertdest: routing per kind: a game watch stays where it was made while stock alerts move; per-item override wins', async (t) => {
  const r = rig(t);
  const price = r.w.add({ kind: 'price', symbol: 'MSFT', when: 'above', value: 400, conversationId: r.chat.id });
  const game = r.w.add({ kind: 'game', league: 'nfl', team: 'Chiefs', when: 'final', conversationId: r.chat.id });
  setFeedDest(r.app, 'stocks', { where: 'dedicated' }, true);
  assert.equal(alertPlace(r.app, 'sports', { item: `live:${game.id}`, origin: () => r.chat.id }).conversationId, r.chat.id);
  const stockPlace = alertPlace(r.app, 'stocks', { item: `live:${price.id}`, origin: () => r.chat.id });
  assert.notEqual(stockPlace.conversationId, r.chat.id);
  assert.equal(r.app.store.getConversation(stockPlace.conversationId!)!.title, 'Stock alerts');
  const other = r.app.store.createConversation({ channel: 'web', title: 'Money talk' });
  setItemDest(r.app, `live:${price.id}`, { where: 'chat', conversationId: other.id });
  await r.fire(401);
  assert.equal(r.cards(other.id).length, 1, 'the item’s own choice wins over the feed default');
});

test('alertdest: origin gone → a chat named after the feed, never whichever chat came first', async (t) => {
  const r = rig(t);
  const gone = r.app.store.createConversation({ channel: 'web', title: 'Old' });
  r.w.add({ kind: 'price', symbol: 'NVDA', when: 'above', value: 400, conversationId: gone.id });
  r.app.store.deleteConversation(gone.id);
  await r.fire(401);
  assert.equal(r.cards(r.chat.id).length, 0, 'not the first web chat');
  const made = r.app.store.listConversations().find((c) => c.title === 'Stock alerts')!;
  assert.ok(made, 'a Stock alerts chat');
  assert.equal(r.cards(made.id).length, 1);
});

test('alertdest: fuzzy project and feed words', (t) => {
  const r = rig(t);
  r.app.planner!.projectId('Stock Alerts');
  r.app.planner!.projectId('Home renovation');
  assert.equal(matchProject(r.app, 'the stock alerts project')?.name, 'Stock Alerts');
  assert.equal(matchProject(r.app, 'stocks alert')?.name, 'Stock Alerts');
  assert.equal(matchProject(r.app, 'renovation')?.name, 'Home renovation');
  assert.equal(matchFeed('my stock alerts'), 'stocks');
  assert.equal(matchFeed('stocks'), 'stocks');
  assert.equal(matchFeed('sports and odds'), 'sports');
  assert.equal(matchFeed('automation results'), 'automations');
  assert.equal(matchFeed('email watches'), 'mail');
  assert.deepEqual(resolveTo(r.app, 'Stock Alerts project'), { dest: { where: 'project', projectId: matchProject(r.app, 'Stock Alerts')!.id } });
  assert.deepEqual(resolveTo(r.app, 'Evening chat'), { dest: { where: 'chat', conversationId: r.chat.id } });
  assert.deepEqual(resolveTo(r.app, 'Crypto project'), { missingProject: 'Crypto' });
  assert.deepEqual(resolveTo(r.app, 'telegram'), { dest: {}, app: 'telegram' });
});

test('alertdest: alerts_route asks before making a missing project, then makes it, sets the feed and moves existing watches', async (t) => {
  const r = rig(t);
  for (const s of ['AAPL', 'MSFT', 'NVDA', 'TSLA']) r.w.add({ kind: 'price', symbol: s, when: 'above', value: 400, conversationId: r.chat.id });
  const ask = await r.tool.run({ feed: 'stock alerts', to: 'Stock Alerts project' }, r.ctx(r.chat.id));
  assert.match(ask, /no project called “Stock Alerts”.*ask_choice/s);
  assert.equal(r.app.planner!.projects().length, 0, 'nothing made without a yes');
  assert.equal(r.tool.asksFirst?.({ create_project: true }), true, 'making a project is an approval card');
  assert.equal(r.tool.asksFirst?.({ to: 'x' }), false);
  const done = await r.tool.run({ feed: 'stock alerts', to: 'Stock Alerts project', create_project: true }, r.ctx(r.chat.id));
  const pid = r.app.planner!.projects().find((p) => p.name === 'Stock Alerts')!.id;
  assert.match(done, /4 existing ones moved/);
  assert.match(done, /Your 4 stock alerts now post to Stock Alerts › Stock alerts/);
  for (const w of r.w.list()) assert.deepEqual(destFor(r.app, 'stocks', `live:${w.id}`), { where: 'project', projectId: pid });
  // "only new ones": the ones they have keep where they post today.
  const b = await r.tool.run({ feed: 'stocks', to: 'here', also_existing: false }, r.ctx(r.chat.id));
  assert.match(b, /new ones only/);
  assert.deepEqual(destFor(r.app, 'stocks', `live:${r.w.list()[0]!.id}`), { where: 'project', projectId: pid });
  assert.deepEqual(destFor(r.app, 'stocks', 'live:999'), { where: 'chat', conversationId: r.chat.id });
});

test('alertdest: isolation: never a group, room, partner, private or chat-app conversation; apps only when connected', async (t) => {
  const r = rig(t);
  const partner = r.app.store.createConversation({ channel: 'web', title: 'With Sam', partner: 'sam' } as never);
  const priv = r.app.store.createConversation({ channel: 'web', title: 'Secret', private: true } as never);
  const tg = r.app.store.createConversation({ channel: 'telegram', channelKey: '1', title: 'Telegram' });
  for (const c of [partner, priv, tg]) {
    await assert.rejects(r.tool.run({ feed: 'stocks', to: 'here' }, r.ctx(c.id)), /can’t take alerts/);
    assert.equal(resolveTo(r.app, c.title).hasOwnProperty('dest') && (resolveTo(r.app, c.title) as { dest: { conversationId?: string } }).dest.conversationId === c.id, false, `${c.title} is never offered`);
  }
  assert.match(await r.tool.run({ feed: 'stocks', to: 'telegram' }, r.ctx(r.chat.id)), /isn't connected/);
  // Connected: the alert goes to her DM there too (a notice is never mirrored, so it is sent).
  const sent: string[] = [];
  r.app.bridges = { telegram: { status: () => ({ running: true, linked: true }), sendOwnText: async (x: string) => void sent.push(x) } } as never;
  await r.tool.run({ feed: 'stocks', to: 'telegram' }, r.ctx(r.chat.id));
  r.w.add({ kind: 'price', symbol: 'AMD', when: 'above', value: 400, conversationId: r.chat.id });
  await r.fire(401);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /AMD is above 400/);
  // Apps only: no new message here.
  setFeedDest(r.app, 'stocks', { where: 'apps', telegram: true }, true);
  const before = r.app.store.listConversations().length;
  assert.equal(postAlert(r.app, 'stocks', { role: 'notice', content: 'livewatch:x' }), undefined);
  assert.equal(r.app.store.listConversations().length, before);
});

test('alertdest: automation results, research done notices and reminders follow their feed', async (t) => {
  const r = rig(t);
  const auto = new Automations(r.app, r.app.store.db, { notify: async () => undefined, quiet: () => false, runTask: async () => ({ reply: 'Done.' }) });
  r.app.automations = auto;
  const a = auto.create({ name: 'Ping', trigger: { kind: 'schedule', every: 'day', time: '10:00' }, actions: [{ kind: 'notify', text: 'Hello from the automation', how: 'chat' }] });
  const pid = r.app.planner!.projectId('Daily')!;
  setFeedDest(r.app, 'automations', { where: 'project', projectId: pid }, true);
  await auto.fire(a.id, 'test', { force: true });
  await auto.settled();
  const conv = r.app.store.listConversations().find((c) => c.projectId === pid)!;
  assert.equal(conv.title, 'Automations');
  assert.ok(r.app.store.messages(conv.id).some((m) => /Hello from the automation/.test(m.content)));
  // Origin (default) keeps its own "Automation: Ping" chat.
  setItemDest(r.app, `auto:${a.id}`, { where: 'origin' });
  await auto.fire(a.id, 'test', { force: true });
  await auto.settled();
  assert.ok(r.app.store.listConversations().some((c) => c.title === 'Automation: Ping'));
  // Producers wired to the shared module (grep: every proactive poster goes through it).
  for (const f of ['src/live-watch.ts', 'src/shopping/watch.ts', 'src/automations.ts', 'src/long-goals.ts', 'src/travel.ts', 'src/research.ts', 'src/inbox/helper.ts', 'src/reminders.ts', 'src/briefing.ts', 'src/own-photos.ts']) assert.match(read(f), /from '\.\.?\/(\.\.\/)?destinations\.ts'/, f);
});

test('alertdest: Settings route lists feeds with where they post, sets a feed or one item, refuses unsafe places', async (t) => {
  const r = rig(t);
  const auth = new OwnerAuth(r.app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/automations`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json', origin: new URL(base).origin }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const w = r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 400, conversationId: r.chat.id });
  const pid = r.app.planner!.projectId('Stock Alerts')!;
  let g = await call('GET', '/alerts');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.feeds.find((f: { id: string }) => f.id === 'stocks').dest, { where: 'origin' });
  assert.equal(g.body.feeds.find((f: { id: string }) => f.id === 'stocks').items, 1);
  assert.deepEqual(g.body.projects, [{ id: pid, name: 'Stock Alerts' }]);
  assert.deepEqual(g.body.chats.map((c: { title: string }) => c.title), ['Evening chat']);
  g = await call('PUT', '/alerts', { feed: 'stocks', dest: { where: 'project', projectId: pid } });
  assert.equal(g.body.feeds.find((f: { id: string }) => f.id === 'stocks').postsTo, 'Stock Alerts › Stock alerts');
  const list = await call('GET', '');
  assert.equal(list.body.items.find((x: { key: string }) => x.key === `live:${w.id}`).postsTo, 'Stock Alerts › Stock alerts');
  // One item back to where it was made.
  await call('PUT', '/alerts', { item: `live:${w.id}`, dest: { where: 'origin' } });
  assert.equal((await call('GET', '')).body.items.find((x: { key: string }) => x.key === `live:${w.id}`).postsTo, 'Evening chat');
  const tg = r.app.store.createConversation({ channel: 'telegram', channelKey: '7', title: 'Group' });
  assert.equal((await call('PUT', '/alerts', { feed: 'stocks', dest: { where: 'chat', conversationId: tg.id } })).status, 400);
  assert.equal((await call('PUT', '/alerts', { feed: 'reminders', dest: { where: 'apps', telegram: true } })).status, 400);
  assert.equal((await call('PUT', '/alerts', { feed: 'nope', dest: { where: 'origin' } })).status, 404);
});

// U1.1 real-model run: the model passed to:"Stock Alerts" (no word "project"); the chat it was asked in,
// auto-titled "Put my stock alerts in the Stock Alerts project", matched by title, so the alerts went to
// that chat and "Make it" (create_project) never made the project.
test('alertdest: the chat she is asked in is not a by-name match; create_project always makes the project', async (t) => {
  const r = rig(t);
  r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 400, conversationId: r.chat.id });
  const here = r.app.store.createConversation({ channel: 'web', title: 'Put my stock alerts in the Stock Alerts project' });
  r.app.store.addMessage(here.id, 'user', 'Put my stock alerts in the Stock Alerts project');
  assert.deepEqual(resolveTo(r.app, 'Stock Alerts', here.id), { missingProject: 'Stock Alerts' });
  const ask = await r.tool.run({ feed: 'stocks', to: 'Stock Alerts' }, r.ctx(here.id));
  assert.match(ask, /no project called “Stock Alerts”/);
  const other = r.app.store.createConversation({ channel: 'web', title: 'Stock alerts talk' });
  r.app.store.addMessage(other.id, 'user', 'hi');
  await r.tool.run({ feed: 'stocks', to: 'Stock Alerts', create_project: true }, r.ctx(here.id));
  const pid = matchProject(r.app, 'Stock Alerts')?.id;
  assert.ok(pid, 'the project was made');
  assert.deepEqual(destFor(r.app, 'stocks'), { where: 'project', projectId: pid });
});
