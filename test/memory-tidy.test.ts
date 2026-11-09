// EC13 (docs/ops/EC1213_DESIGN.md): the overnight memory tidy. A fixture with duplicates, conflicts
// and an old thread yields one merge, two proposals and one summary; Undo restores each change;
// nothing is ever deleted; private and people gates hold; local models only by default; quiet hours
// and once a night; the admin's pin; each space tidies only its own store. Scripted model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MemoryTidy, TidyError } from '../src/memory-tidy.ts';
import { PeopleStore } from '../src/people.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const LOCAL = { id: 'here', label: 'Here', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' } as const;
const CLOUD = { id: 'far', label: 'Far', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' } as const;

function rig(t: TestContext, provider: typeof LOCAL | typeof CLOUD = LOCAL, start = '2026-11-05T23:30:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(start) };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [provider], defaultProviderId: provider.id, defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  app.people = new PeopleStore(app.store.db);
  const mem = app.memory!;
  const open = app.store.createConversation({ title: 'Chat' });
  const secret = app.store.createConversation({ title: 'Secret', private: true });
  const garden = app.store.createConversation({ title: 'Garden' });
  const add = (content: string, o: { kind?: 'fact' | 'decision' | 'summary'; conv?: string; on?: string } = {}) => mem.add({ kind: o.kind ?? 'fact', content, conversationId: o.conv ?? open.id, sourceMessageId: null, happenedOn: o.on ?? '2026-10-01' });
  const f = {
    tea1: add('Alex likes green tea in the morning', { on: '2026-09-01' }),
    tea2: add('Alex likes green tea in the morning.', { on: '2026-10-20' }),
    teaPrivate: add('Alex likes green tea in the morning', { conv: secret.id }),
    coffee: add('Alex drinks coffee every day', { on: '2026-08-01' }),
    noCoffee: add('Alex no longer drinks coffee every day', { on: '2026-10-30' }),
    meet9: add('Alex and Sara decided the team meets on Mondays at 9', { kind: 'decision', on: '2026-07-01' }),
    meet10: add('Alex and Sara decided the team meets on Mondays at 10', { kind: 'decision', on: '2026-10-02' }),
    jeff1: add('Alex says Jeff has a heart condition', { on: '2026-09-02' }),
    jeff2: add('Alex says Jeff has a heart condition.', { on: '2026-09-03' }),
    old1: add('Alex and Sara planned the garden beds.', { kind: 'summary', conv: garden.id, on: '2026-05-01' }),
    old2: add('Alex and Sara picked tomatoes for the garden.', { kind: 'summary', conv: garden.id, on: '2026-05-08' }),
    old3: add('Alex and Sara talked about watering the garden.', { kind: 'summary', conv: garden.id, on: '2026-05-15' }),
    sec1: add('Alex and Sara talked about a private worry.', { kind: 'summary', conv: secret.id, on: '2026-05-01' }),
    sec2: add('Alex and Sara talked about the private worry again.', { kind: 'summary', conv: secret.id, on: '2026-05-08' }),
    sec3: add('Alex and Sara talked about the private worry a third time.', { kind: 'summary', conv: secret.id, on: '2026-05-15' }),
  };
  // A sensitive (health) person fact on one of the Jeff notes: never merged with an ordinary one.
  const jeff = app.people.create({ name: 'Jeff', status: 'active' });
  app.people.addFact(jeff.id, { content: f.jeff1.content, memoryId: f.jeff1.id, happenedOn: '2026-09-02', category: 'health' });
  app.store.addMessage(open.id, 'user', 'good night');
  const tidy = new MemoryTidy(app, mem.db);
  app.memoryTidy = tidy;
  t.after(() => {
    setPolicy(new PolicyStore());
    app.store.close();
    cleanup();
  });
  const count = () => (mem.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  return { app, dir, clock, mem, tidy, f, open, secret, garden, count };
}

const LOCAL_SCRIPT = () => [text('YES'), text('YES'), text('Alex and Sara planned the garden, picked tomatoes and talked about watering.'), text('Alex and Sara talked about a private worry three times.')];

test('memory tidy: the fixture yields one merge, two proposals and old threads summed up; nothing deleted', async (t) => {
  const r = rig(t);
  r.app.script.push(...LOCAL_SCRIPT());
  const before = r.count();
  const run = await r.tidy.run('now');
  assert.equal(run.merged, 1, JSON.stringify(run));
  assert.equal(run.proposals, 2);
  assert.equal(run.digests, 2, 'a local model may read the private thread');
  assert.equal(run.skipped, null);
  // The duplicate: the newer copy points at the older (kept) one; private and health copies stay apart.
  assert.equal(r.mem.get(r.f.tea2.id)!.supersededBy, r.f.tea1.id);
  assert.equal(r.mem.get(r.f.tea1.id)!.supersededBy, null);
  assert.equal(r.mem.get(r.f.teaPrivate.id)!.supersededBy, null, 'private gate');
  assert.equal(r.mem.get(r.f.jeff1.id)!.supersededBy, null, 'people gate');
  assert.equal(r.mem.get(r.f.jeff2.id)!.supersededBy, null, 'people gate');
  // Conflicts are only proposed.
  assert.equal(r.mem.get(r.f.coffee.id)!.supersededBy, null);
  const view = r.tidy.view(run.id)!;
  const pairs = view.changes.filter((c) => c.kind === 'contradiction').map((c) => [c.a.id, c.b.id].sort((x, y) => x - y).join('-')).sort();
  assert.deepEqual(pairs, [`${r.f.coffee.id}-${r.f.noCoffee.id}`, `${r.f.meet9.id}-${r.f.meet10.id}`].sort());
  // The old garden thread: one new summary, the three originals archived (searchable, not injected).
  for (const m of [r.f.old1, r.f.old2, r.f.old3]) assert.equal(r.mem.get(m.id)!.archived, true);
  assert.ok(r.mem.listAll().some((m) => m.kind === 'summary' && /picked tomatoes and talked about watering/.test(m.content) && !m.archived));
  assert.equal(r.count(), before + 2, 'only additions: two new summaries, no deletes');
  // The morning card in his most recent own chat.
  const card = r.app.store.messages(r.open.id).filter((m) => m.role === 'notice' && m.meta?.tidy);
  assert.equal(card.length, 1);
  assert.equal((card[0].meta!.tidy as { runId: number }).runId, run.id);
  assert.match(card[0].content, /^tidy:/);
  assert.match(readFileSync(join(ROOT, 'src', 'memory-tidy.ts'), 'utf8'), /never deletes/i);
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'memory-tidy.ts'), 'utf8'), /DELETE FROM memories|\.delete\(|setInterval|setTimeout\(/);
});

test('memory tidy: Undo restores every change; a proposal is decided and can be undone too', async (t) => {
  const r = rig(t);
  r.app.script.push(...LOCAL_SCRIPT());
  const run = await r.tidy.run('now');
  const view = r.tidy.view(run.id)!;
  const merge = view.changes.find((c) => c.kind === 'merge')!;
  r.tidy.undo(merge.id);
  assert.equal(r.mem.get(r.f.tea2.id)!.supersededBy, null);
  assert.throws(() => r.tidy.undo(merge.id), (e: TidyError) => e.status === 409, 'not twice');
  const digest = view.changes.find((c) => c.kind === 'digest' && c.a.id === r.f.old1.id)!;
  r.tidy.undo(digest.id);
  for (const m of [r.f.old1, r.f.old2, r.f.old3]) assert.equal(r.mem.get(m.id)!.archived, false);
  assert.equal(r.mem.get(digest.b.id)!.archived, true, 'the new summary is archived, not deleted');
  const coffee = view.changes.find((c) => c.kind === 'contradiction' && [c.a.id, c.b.id].includes(r.f.coffee.id))!;
  r.tidy.decide(coffee.id, 'newer');
  assert.equal(r.mem.get(r.f.coffee.id)!.supersededBy, r.f.noCoffee.id, 'the older one is replaced by the newer');
  r.tidy.undo(coffee.id);
  assert.equal(r.mem.get(r.f.coffee.id)!.supersededBy, null);
  assert.equal(r.tidy.view(run.id)!.changes.find((c) => c.id === coffee.id)!.state, 'open');
  r.tidy.decide(coffee.id, 'both');
  assert.equal(r.mem.get(r.f.coffee.id)!.supersededBy, null);
  assert.equal(r.mem.get(r.f.noCoffee.id)!.supersededBy, null);
});

test('memory tidy: local models only by default; private notes never reach a cloud model', async (t) => {
  const r = rig(t, CLOUD);
  const run = await r.tidy.run('now');
  assert.equal(r.app.requests.length, 0, 'no model on this computer: no model call at all');
  assert.equal(run.skipped, 'no-local-model');
  assert.equal(run.digests, 0);
  assert.equal(run.merged, 1, 'the code steps still run');
  assert.equal(run.proposals, 2, 'without the judge');
  // He picks "any model": the open garden thread may go to the cloud model, the private one never.
  const r2 = rig(t, CLOUD);
  r2.tidy.setSettings({ on: true, model: 'any' });
  r2.app.script.push(text('YES'), text('YES'), text('Alex and Sara planned the garden.'));
  const run2 = await r2.tidy.run('now');
  assert.equal(run2.digests, 1);
  const sent = JSON.stringify(r2.app.requests);
  assert.match(sent, /garden/);
  assert.doesNotMatch(sent, /private worry/);
  assert.doesNotMatch(sent, /heart condition/, 'a sensitive person fact never goes to a cloud model');
});

test('memory tidy: a judge that says NO drops a conflict; it can never add one', async (t) => {
  const r = rig(t);
  r.app.script.push(text('NO'), text('YES'), text('Garden.'), text('Worry.'));
  const run = await r.tidy.run('now');
  assert.equal(run.proposals, 1);
});

test('memory tidy: off by default; on, it runs once a night in quiet hours when all is quiet', async (t) => {
  const r = rig(t, LOCAL, '2026-11-05T15:00:00Z');
  assert.deepEqual(r.tidy.settings(), { on: false, model: 'local' });
  assert.equal(await r.tidy.due(r.clock.now), 0, 'off');
  r.tidy.setSettings({ on: true });
  assert.equal(await r.tidy.due(r.clock.now), 0, 'not in quiet hours (22–9)');
  r.clock.now = new Date('2026-11-05T23:00:00Z');
  r.app.store.addMessage(r.open.id, 'user', 'still up');
  assert.equal(await r.tidy.due(r.clock.now), 0, 'a message less than 30 minutes ago');
  r.clock.now = new Date('2026-11-05T23:45:00Z');
  r.app.script.push(...LOCAL_SCRIPT());
  assert.equal(await r.tidy.due(r.clock.now), 1);
  r.clock.now = new Date('2026-11-06T03:00:00Z');
  assert.equal(await r.tidy.due(r.clock.now), 0, 'once a night');
  r.clock.now = new Date('2026-11-06T23:45:00Z');
  assert.equal(await r.tidy.due(r.clock.now), 1, 'the next night');
  assert.match(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8'), /this\.#app\.memoryTidy\?\.due\(now\)/);
});

test('memory tidy: the admin pin turns it off or keeps it on this computer', async (t) => {
  const r = rig(t, CLOUD);
  const pol = new PolicyStore(r.dir);
  setPolicy(pol);
  pol.set({ name: 'House', pins: { memoryTidy: 'local' } });
  assert.throws(() => r.tidy.setSettings({ on: true, model: 'any' }), (e: TidyError) => e.status === 403);
  r.tidy.setSettings({ on: true });
  r.app.settings.update({ memoryTidy: { on: true, model: 'any' } } as never);
  const run = await r.tidy.run('now');
  assert.equal(r.app.requests.length, 0, 'pinned local: the cloud model is never used');
  assert.equal(run.skipped, 'no-local-model');
  pol.set({ name: 'House', pins: { memoryTidy: 'off' } });
  assert.throws(() => r.tidy.setSettings({ on: true }), (e: TidyError) => e.status === 403);
  await assert.rejects(r.tidy.run('now'), (e: TidyError) => e.status === 403);
  r.clock.now = new Date('2026-11-06T23:45:00Z');
  assert.equal(await r.tidy.due(r.clock.now), 0);
});

test('memory tidy: each space tidies only its own notes', async (t) => {
  const owner = rig(t);
  const member = rig(t);
  member.app.script.push(...LOCAL_SCRIPT());
  const ownerBefore = owner.mem.listAll().map((m) => [m.id, m.supersededBy, m.archived]);
  await member.tidy.run('now');
  assert.deepEqual(owner.mem.listAll().map((m) => [m.id, m.supersededBy, m.archived]), ownerBefore);
  assert.equal(owner.tidy.runs().length, 0);
  assert.equal(member.tidy.runs().length, 1);
});
