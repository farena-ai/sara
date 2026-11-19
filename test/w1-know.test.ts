// W1.1 (docs/design/W1KNOW.md): one "What I know about you" page you can see and steer. Settings → You →
// What Sara knows grows into the one place: everything she knows grouped by topic with source and age
// (W0.6), search, "That's wrong" (edit, undo on the timeline), "Forget" (undo on the timeline),
// duplicate merge suggestions, "Why do you think that?" (the source message), counts of what else she
// keeps (people, notes, renewals, purchases, health only as "kept private", learned skills) and each
// household member sees only their own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { factsFor } from '../src/facts.ts';
import { duplicatePairs, knowView, knowWhy, knowForget, knowEdit, knowMerge, knowKeepBoth } from '../src/know.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createSaraServer } from '../src/server.ts';
import { timelineOf } from '../src/timeline.ts';
import { makeApp, tempDir } from './helpers.ts';
import { N6_DOCS } from './n6-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-11-19T15:00:00Z');

function rig(t: TestContext, o: { docs?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.library = new LibraryStore(app.store.db, dir, () => NOW);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  if (o.docs) {
    const d = N6_DOCS.lease;
    const doc = app.library.add({ name: d.name, bytes: Buffer.from(d.pages.join('\n\n'), 'utf8'), keep: true, origin: 'library', learn: false });
    app.library.setRead(doc.id, { kind: 'pdf', parts: d.pages.map((text, i) => ({ text, where: `page ${i + 1}` })), warnings: [] });
  }
  const conv = app.store.createConversation({ title: 'Catching up', mode: 'chat' });
  const said = (text: string) => app.store.addMessage(conv.id, 'user', text);
  const fact = (content: string, evidence: string, day = '2026-11-10') => {
    const msg = said(evidence);
    return app.memory!.add({ kind: 'fact', content, conversationId: conv.id, sourceMessageId: msg.id, happenedOn: day, evidence });
  };
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir, conv, fact, said };
}

test('W1.1 view: grouped by topic, source and W0.6 age, search, counts of what else she keeps', (t) => {
  const { app, fact } = rig(t, { docs: true });
  fact('Their wife is Dana; she loves hiking', 'My wife Dana loves hiking', '2026-11-18');
  fact('They work as an accountant at Deloitte', 'I work as an accountant at Deloitte', '2026-08-19');
  app.memory!.add({ kind: 'summary', content: 'Talked about the trip', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  const v = knowView(app);
  assert.equal(v.today, '2026-11-19');
  const ids = v.topics.map((g) => g.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => ['people', 'home', 'vehicles', 'health', 'work', 'money', 'dates', 'other'].indexOf(a) - ['people', 'home', 'vehicles', 'health', 'work', 'money', 'dates', 'other'].indexOf(b)));
  const people = v.topics.find((g) => g.id === 'people')!;
  const dana = people.items.find((f) => /Dana/.test(f.text))!;
  assert.equal(dana.ageDays, 1);
  assert.equal(dana.age, 'yesterday', 'W0.6 day age');
  assert.equal(dana.source.kind, 'chat');
  assert.equal(dana.why, true, 'a chat fact can say why');
  const work = v.topics.find((g) => g.id === 'work')!.items[0]!;
  assert.equal(work.age, '3 months ago');
  assert.ok(v.topics.some((g) => g.items.some((f) => f.source.kind === 'document')), 'document facts are in the same list');
  assert.equal(v.total, v.topics.reduce((n, g) => n + g.items.length, 0));
  // Search: words anywhere in the fact, its quote or its source.
  const s = knowView(app, { q: 'hiking' });
  assert.equal(s.total, 1);
  assert.match(s.topics[0]!.items[0]!.text, /Dana/);
  assert.equal(knowView(app, { q: 'catching up' }).total, 2, 'the chat title finds facts said there');
  assert.equal(knowView(app, { q: 'zzzz' }).total, 0);
  // Counts only for the other stores; health is never counted or shown here.
  const c = Object.fromEntries(v.also.map((x) => [x.id, x]));
  assert.equal(c.notes!.count, 1);
  assert.equal(c.people!.count, 0);
  assert.ok('renewals' in c && 'purchases' in c && 'skills' in c && 'style' in c);
  assert.equal(c.health, undefined, 'no health log: nothing said about it');
  assert.ok(!JSON.stringify(v).includes('penicillin'));
});

test('W1.1 why: the source message (masked, forgotten ones never shown), document page, or "you added it"', (t) => {
  const { app, fact } = rig(t, { docs: true });
  const m = fact('Their card ends in 1111', 'my card is 4111 1111 1111 1111 and it is the blue one');
  const w = knowWhy(app, `m${m.id}`);
  assert.equal(w.kind, 'chat');
  assert.equal(w.title, 'Catching up');
  assert.ok(w.message && !w.message.text.includes('4111 1111 1111 1111'), 'card numbers are masked');
  assert.match(w.message!.text, /blue one/);
  assert.equal(w.message!.role, 'user');
  assert.ok(w.message!.at);
  // A forgotten source message is never shown again.
  app.store.updateMessageMeta(m.sourceMessageId!, { forgotten: true });
  const gone = knowWhy(app, `m${m.id}`);
  assert.equal(gone.message, null);
  assert.equal(gone.gone, true);
  const mine = app.memory!.addOwner({ kind: 'fact', content: 'I like tea', happenedOn: '2026-11-19' });
  assert.equal(knowWhy(app, `m${mine.id}`).kind, 'you');
  const lease = factsFor(app).list().find((f) => f.label === 'Lease ends')!;
  const d = knowWhy(app, lease.id);
  assert.equal(d.kind, 'document');
  assert.equal(d.page, 1);
  assert.match(d.quote!, /May 31, 2027/);
  assert.throws(() => knowWhy(app, 'm999999'), /not found/i);
});

test('W1.1 Forget goes on the timeline and Undo brings it back exactly; document facts too', async (t) => {
  const { app, fact } = rig(t, { docs: true });
  const m = fact('Their dog is Biscuit', 'My dog is called Biscuit');
  const r = knowForget(app, `m${m.id}`);
  assert.ok(r.timelineId > 0);
  assert.equal(app.memory!.get(m.id), undefined);
  assert.ok(!factsFor(app).list().some((f) => f.id === `m${m.id}`));
  const row = timelineOf(app).get(r.timelineId)!;
  assert.equal(row.canRevert, true);
  assert.equal(row.title, 'Forgot: {text}');
  await timelineOf(app).revert(r.timelineId, app);
  const back = app.memory!.get(m.id)!;
  assert.equal(back.content, 'Their dog is Biscuit');
  assert.equal(back.sourceMessageId, m.sourceMessageId);
  assert.equal(back.evidence, m.evidence);
  assert.ok(app.memory!.search('Biscuit').some((h) => h.memory.id === m.id), 'searchable again');
  await assert.rejects(timelineOf(app).revert(r.timelineId, app), /already/);
  // A document fact: hidden, then active again.
  const lease = factsFor(app).list().find((f) => f.label === 'Lease ends')!;
  const r2 = knowForget(app, lease.id);
  assert.ok(!factsFor(app).list().some((f) => f.id === lease.id));
  await timelineOf(app).revert(r2.timelineId, app);
  assert.ok(factsFor(app).list().some((f) => f.id === lease.id));
});

test("W1.1 That's wrong: the fix is saved, and Undo puts the old words back", async (t) => {
  const { app, fact } = rig(t);
  const m = fact('Their sister is Ana, a teacher', 'My sister Ana is a teacher');
  const r = knowEdit(app, `m${m.id}`, 'Their sister is Ana, a nurse in Denver');
  assert.equal(r.fact.text, 'Their sister is Ana, a nurse in Denver');
  assert.equal(app.memory!.get(m.id)!.edited, true);
  await timelineOf(app).revert(r.timelineId, app);
  assert.equal(app.memory!.get(m.id)!.content, 'Their sister is Ana, a teacher');
  assert.throws(() => knowEdit(app, `m${m.id}`, ''), /1 to 500/);
  assert.throws(() => knowEdit(app, `m${m.id}`, 'SSN 123-45-6789'), /never kept/);
});

test('W1.1 duplicates: near-same facts are suggested; Merge keeps one (undo), Keep both stops asking', async (t) => {
  const { app, fact } = rig(t);
  const a = fact('They live in Austin, Texas', 'I live in Austin, Texas', '2026-10-01');
  const b = fact('They live in Austin Texas now', 'we live in Austin Texas now', '2026-11-15');
  fact('Their wife is Dana', 'My wife is Dana');
  fact('They have a dog named Biscuit', 'we have a dog named Biscuit');
  const pairs = duplicatePairs(factsFor(app).list());
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0]!.keep.id, pairs[0]!.drop.id], [`m${b.id}`, `m${a.id}`], 'keeps the newer one');
  assert.equal(knowView(app).duplicates.length, 1);
  const r = knowMerge(app, `m${b.id}`, `m${a.id}`);
  assert.equal(app.memory!.get(a.id)!.supersededBy, b.id);
  assert.equal(knowView(app).duplicates.length, 0);
  assert.ok(!knowView(app).topics.some((g) => g.items.some((f) => f.id === `m${a.id}`)));
  await timelineOf(app).revert(r.timelineId, app);
  assert.equal(app.memory!.get(a.id)!.supersededBy, null);
  assert.equal(knowView(app).duplicates.length, 1);
  knowKeepBoth(app, `m${b.id}`, `m${a.id}`);
  assert.equal(knowView(app).duplicates.length, 0, 'Keep both is remembered');
  assert.throws(() => knowMerge(app, `m${a.id}`, `m${a.id}`), /two different/);
});

test('W1.1 routes: view, why, forget + undo through /timeline, edit, merge; each member only their own', async (t) => {
  const own = rig(t);
  const other = rig(t);
  const m = own.fact('Their dog is Biscuit', 'My dog is called Biscuit');
  other.fact('Their cat is Mochi', 'My cat is Mochi');
  const serve = async (r: ReturnType<typeof rig>) => {
    const auth = new OwnerAuth(r.dir);
    const server = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const token = auth.newToken;
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
  };
  const call = await serve(own);
  const call2 = await serve(other);
  const v = await call('GET', '/facts/know');
  assert.equal(v.status, 200);
  const text = JSON.stringify(v.body);
  assert.match(text, /Biscuit/);
  assert.doesNotMatch(text, /Mochi/, "another person's facts never show");
  assert.doesNotMatch(JSON.stringify((await call2('GET', '/facts/know')).body), /Biscuit/);
  assert.equal((await call('GET', '/facts/know?q=biscuit')).body.total, 1);
  const why = await call('GET', `/facts/m${m.id}/why`);
  assert.equal(why.status, 200);
  assert.match(why.body.message.text, /called Biscuit/);
  const f = await call('POST', `/facts/m${m.id}/forget`, {});
  assert.equal(f.status, 200);
  assert.equal((await call('GET', '/facts/know')).body.total, 0);
  assert.equal((await call('POST', `/timeline/${f.body.timelineId}/revert`, {})).status, 200);
  assert.equal((await call('GET', '/facts/know')).body.total, 1);
  const e = await call('POST', `/facts/m${m.id}/wrong`, { text: 'Their dog is Biscuit, a beagle' });
  assert.equal(e.status, 200);
  assert.ok(e.body.timelineId > 0);
  assert.equal((await call('POST', '/facts/merge', { keep: `m${m.id}`, drop: `m${m.id}` })).status, 400);
  assert.equal((await call('GET', '/facts/m999999/why')).status, 404);
  // Forgetting on the other person's server changes only their own facts.
  assert.equal((await call2('POST', `/facts/m${m.id}/forget`, {})).status, 200);
  assert.match(JSON.stringify((await call('GET', '/facts/know')).body), /Biscuit/);
  assert.equal((await call2('GET', '/facts/know')).body.total, 0);
});

test('W1.1 page wiring: one page, sections above the fold, tips, i18n ×5, docs', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const page = html.slice(html.indexOf('data-page="you-knows"'), html.indexOf('data-page="you-adult"'));
  for (const id of ['kn-q', 'kn-also', 'kn-dups', 'wsk-list']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.ok(page.indexOf('id="rnw-box"') < page.indexOf('id="kn-q"'), 'Renewals stays first (V2.1)');
  assert.ok(page.indexOf('id="kn-q"') < page.indexOf('id="wsk-suggest"'), 'what she knows comes right after renewals');
  assert.equal((html.match(/data-page="you-knows"/g) ?? []).length, 1, 'no second page');
  const tips = JSON.parse(readFileSync(join(ROOT, 'web/tips.json'), 'utf8'));
  assert.ok(tips.tips?.['kn-q'] ?? tips['kn-q'], 'search has a tip');
  const js = readFileSync(join(ROOT, 'web/facts.js'), 'utf8');
  for (const k of ["t('That’s wrong')", "t('Forget')", "t('Why do you think that?')", "t('Undo')", "t('Merge')", "t('Keep both')"]) assert.ok(js.includes(k), k);
  assert.match(js, /\/timeline\/\$\{/);
  assert.ok(!/fetch\(/.test(js), 'goes through api()');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const raw = readFileSync(join(ROOT, `web/i18n/${lang}.json`), 'utf8');
    for (const k of ['That’s wrong', 'Why do you think that?', 'Keep both']) assert.ok(raw.includes(`"${k}":`), `${lang}: ${k}`);
  }
  assert.match(readFileSync(join(ROOT, 'docs/WHAT_SARA_KNOWS.md'), 'utf8'), /W1\.1/);
});
