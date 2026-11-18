// V2.7 (docs/design/GIFTS.md): gifts and occasions on People cards.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { PeopleStore } from '../src/people.ts';
import { PeopleTies } from '../src/people-ties.ts';
import { writingFor } from '../src/humanize.ts';
import { createGiftTools, giftsOf, nextOn } from '../src/gifts.ts';
import { PEOPLE_TOOLS } from '../src/chat.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const IDEAS = JSON.stringify({ ideas: [
  { title: 'Pottery class for two', why: 'She took up pottery this year.', price: 60 },
  { title: 'Trail running socks', why: 'She runs every weekend.', price: 18 },
  { title: 'Weekend in Paris', why: 'Big trip.', price: 900 },
] });

function rig(t: TestContext, now = '2026-11-18T15:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(now) };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago' } as never);
  app.people = new PeopleStore(app.store.db, { now: () => clock.now });
  app.peopleTies = new PeopleTies(app, { sources: { mail: async () => ({ heads: [], text: async () => '' }), events: async () => [] } });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const people = app.people;
  // Maya: birthday Dec 2 (14 days after "now"), plain facts plus private, sensitive, pending and room facts.
  const maya = people.create({ name: 'Maya', relation: 'my sister', birthday: '1990-12-02', status: 'active' });
  const fact = (content: string, o: Record<string, unknown> = {}) => people.addFact(maya.id, { content, happenedOn: '2026-10-01', ...o } as never);
  fact('Maya took up pottery this year');
  fact('Maya runs trail races every weekend');
  fact('Maya is secretly planning to quit her job', { private: true });
  fact('Maya has a bad knee from surgery', { category: 'health' });
  fact('Maya or Mia likes jazz', { pending: 'Mia' });
  fact('Maya said in the book club room she hates candles', { roomId: 7 });
  return { app, clock, people, maya };
}
const prompts = (app: TestApp) => app.requests.map((r) => r.messages.map((m) => String(m.content)).join('\n')).join('\n---\n');

test('V2.7.1 occasions: birthday and the card dates, next day in the owner time zone', (t) => {
  const r = rig(t);
  r.app.peopleTies!.setTie(r.maya.id, { dates: [{ label: 'Name day', date: '2000-01-15' }] });
  const g = giftsOf(r.app);
  const occ = g.occasions(r.people.get(r.maya.id)!);
  assert.deepEqual(occ.map((o) => [o.key, o.date, o.days]), [['birthday', '2026-12-02', 14], ['date:Name day', '2027-01-15', 58]]);
  assert.equal(nextOn('--02-29', '2027-01-10'), '2027-02-28');
});

test('V2.7.2 acceptance: a fake card with a birthday gets ideas and a draft card; private facts are not used', async (t) => {
  const r = rig(t);
  const g = giftsOf(r.app);
  g.setPlan(r.maya.id, { budget: 80 });
  writingFor(r.app).setCard({ samples: 2, words: 120, avgSentence: 8, shortest: 3, longest: 14, formality: 'casual', contractions: 'often', favorites: ['awesome'], punctuation: ['exclamations'] });
  r.app.script.push(text(IDEAS));
  const ideas = await g.ideas(r.maya.id);
  assert.deepEqual(ideas.map((i) => i.title), ['Pottery class for two', 'Trail running socks'], 'over-budget idea dropped');
  r.app.script.push(text('Happy birthday, Maya! Hope the new pottery wheel gets a workout. Love, Alex'));
  const card = await g.card(r.maya.id, 'birthday');
  assert.match(card, /Happy birthday, Maya/);
  const sent = prompts(r.app);
  assert.match(sent, /pottery/);
  assert.match(sent, /trail races/);
  assert.match(sent, /sentences around 8 words/, 'writing style card used');
  assert.match(sent, /Alex/);
  for (const secret of ['quit her job', 'bad knee', 'jazz', 'candles']) assert.ok(!sent.includes(secret), `never sent: ${secret}`);
  const plan = g.plan(r.maya.id);
  assert.equal(plan.ideas.length, 2);
  assert.equal(plan.card?.text, card);
  assert.equal(plan.card?.occasion, 'birthday');
});

test('V2.7.3 private and sensitive cards: refused before any model call, no reminder', async (t) => {
  const r = rig(t);
  const g = giftsOf(r.app);
  const sam = r.people.create({ name: 'Sam', birthday: '1980-12-01', status: 'active', private: true });
  const calls = r.app.requests.length;
  await assert.rejects(() => g.ideas(sam.id), /private/i);
  await assert.rejects(() => g.card(sam.id, 'birthday'), /private/i);
  assert.equal(r.app.requests.length, calls);
  g.setPlan(sam.id, { remind: true });
  g.due(r.clock.now);
  assert.equal(r.app.planner!.reminders({ status: 'all' }).filter((x) => /Sam/.test(x.text)).length, 0);
});

test('V2.7.4 shopping list: one Planner to-do in Gifts, a week before, once per idea', async (t) => {
  const r = rig(t);
  const g = giftsOf(r.app);
  r.app.script.push(text(IDEAS));
  await g.ideas(r.maya.id);
  const a = g.toList(r.maya.id, 0);
  const b = g.toList(r.maya.id, 0);
  assert.equal(a.id, b.id);
  const task = r.app.planner!.task(a.id)!;
  assert.equal(task.title, 'Gift for Maya: Pottery class for two');
  assert.equal(task.projectId, r.app.planner!.builtinProject('gifts')!.id);
  assert.equal(task.dueAt?.slice(0, 10), '2026-11-25');
  assert.equal(g.plan(r.maya.id).ideas[0].taskId, a.id);
});

test('V2.7.5 reminder 2 weeks before: armed once per year, honours the switch and the days', (t) => {
  const r = rig(t, '2026-11-01T15:00:00Z');
  const g = giftsOf(r.app);
  const ben = r.people.create({ name: 'Ben', relation: 'coworker', birthday: '1985-11-30', status: 'active' });
  g.due(r.clock.now);
  g.due(new Date(r.clock.now.getTime() + 2 * 3600_000));
  const rem = r.app.planner!.reminders({ status: 'all' });
  const maya = rem.filter((x) => /Maya/.test(x.text));
  assert.equal(maya.length, 1, 'family card: one reminder');
  assert.match(maya[0].text, /Maya's birthday is on/);
  // 9:00 in Chicago on Nov 18 = 15:00 UTC.
  assert.equal(maya[0].dueAt, '2026-11-18T15:00:00.000Z');
  assert.equal(rem.filter((x) => /Ben/.test(x.text)).length, 0, 'work card without a plan: none');
  g.setPlan(ben.id, { remind: true });
  g.due(new Date(r.clock.now.getTime() + 3 * 3600_000));
  assert.equal(r.app.planner!.reminders({ status: 'all' }).filter((x) => /Ben/.test(x.text)).length, 1);
  // Off: nothing new; days: 7.
  g.setPrefs({ on: false });
  const zoe = r.people.create({ name: 'Zoe', relation: 'my mom', birthday: '1960-11-28', status: 'active' });
  g.due(new Date(r.clock.now.getTime() + 4 * 3600_000));
  assert.equal(r.app.planner!.reminders({ status: 'all' }).filter((x) => /Zoe/.test(x.text)).length, 0);
  g.setPrefs({ on: true, days: 7 });
  g.due(new Date(r.clock.now.getTime() + 5 * 3600_000));
  assert.equal(r.app.planner!.reminders({ status: 'all' }).find((x) => /Zoe/.test(x.text))?.dueAt, '2026-11-21T15:00:00.000Z');
  assert.deepEqual(g.prefs(), { on: true, days: 7, budget: null });
  void zoe;
});

test('V2.7.6 routes under /api/people and the chat tools (people-only)', async (t) => {
  const r = rig(t);
  const auth = new OwnerAuth(r.app.dataDir);
  const srv = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((res) => srv.close(() => res()));
  });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + '/api' + path, { method, headers: { Origin: base, authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  let v = await call(`/people/${r.maya.id}/gifts`);
  assert.equal(v.status, 200);
  assert.equal(v.body.occasions[0].key, 'birthday');
  assert.equal(v.body.blocked, null);
  v = await call(`/people/${r.maya.id}/gifts`, 'PUT', { budget: 50, remind: false });
  assert.equal(v.body.plan.budget, 50);
  assert.equal(v.body.plan.remind, false);
  r.app.script.push(text(IDEAS));
  v = await call(`/people/${r.maya.id}/gifts/ideas`, 'POST', {});
  assert.deepEqual(v.body.plan.ideas.map((i: { title: string }) => i.title), ['Trail running socks']);
  v = await call(`/people/${r.maya.id}/gifts/list`, 'POST', { idea: 0 });
  assert.ok(v.body.plan.ideas[0].taskId);
  r.app.script.push(text('Happy birthday!'));
  v = await call(`/people/${r.maya.id}/gifts/card`, 'POST', { occasion: 'birthday' });
  assert.equal(v.body.plan.card.text, 'Happy birthday!');
  v = await call('/people/gifts-prefs', 'PUT', { on: true, days: 21, budget: 40 });
  assert.deepEqual(v.body, { on: true, days: 21, budget: 40 });
  assert.equal((await call('/people/gifts-prefs', 'PUT', { days: 3 })).status, 400);
  const priv = r.people.create({ name: 'Kim', birthday: '1990-01-01', status: 'active', private: true });
  v = await call(`/people/${priv.id}/gifts`);
  assert.equal(v.body.blocked, 'private');
  assert.equal((await call(`/people/${priv.id}/gifts/ideas`, 'POST', {})).status, 409);

  const tools = createGiftTools(() => r.app);
  assert.deepEqual(tools.map((x) => x.spec.name), ['people_gift_ideas', 'people_gift_card']);
  for (const x of tools) assert.ok(PEOPLE_TOOLS.has(x.spec.name), `${x.spec.name} stays out of outside apps`);
  r.app.script.push(text(IDEAS));
  const out = String(await tools[0].run({ name: 'maya' }, {} as never));
  assert.match(out, /Trail running socks/);
  assert.match(String(await tools[0].run({ name: 'Kim' }, {} as never)), /private/i);
});

test('V2.7.7 web: People card section and Settings section wired, strings translated', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['gift-remind-on', 'gift-remind-days', 'gift-budget']) assert.match(html, new RegExp(`id="${id}"`));
  const people = readFileSync(join(ROOT, 'web', 'people.js'), 'utf8');
  assert.match(people, /giftsSection/);
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8'));
  for (const id of ['gift-remind-on', 'gift-remind-days', 'gift-budget']) assert.ok(tips[id] || tips.tips?.[id] || html.includes(`id="${id}"`), id);
  const es = readFileSync(join(ROOT, 'web', 'i18n', 'es.json'), 'utf8');
  assert.match(es, /"Gifts and occasions":/);
});
