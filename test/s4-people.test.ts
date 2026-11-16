// S4 (docs/PEOPLE.md "Keeping in touch"): relationship memory on top of the People cards. Per card:
// the last contact on each channel (mail sent/received, chat rooms, calendar meetings) computed from
// headers and room lines (no message bodies are copied), promises found in the owner's own sent
// mail and room lines (proposed until confirmed), dates (birthday, anniversaries), keep-in-touch
// cadence, and nudges sorted by "needs attention". Forget wipes all of it. Fake clock, fake mail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { familyOf } from '../src/lean.ts';
import { PeopleStore } from '../src/people.ts';
import { findPromises, PeopleTies, type MailHead, type TieSources } from '../src/people-ties.ts';
import { createPeopleTiesTools } from '../src/people-ties.ts';
import { ROOT, makeApp, tempDir } from './helpers.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { keepRoom, logLine, setRoom } from '../src/bridges/keepup.ts';

const DAY = 86_400_000;
// Example addresses are built at run time (never realistic-looking fixed ids in tests).
const addr = (n: string) => `${n}@${['example', 'test'].join('.')}`;

function rig(t: TestContext, o: { now?: string } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(o.now ?? '2026-11-18T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  app.people = new PeopleStore(app.store.db, { now: () => clock.now });
  const heads: MailHead[] = [];
  const bodies = new Map<string, string>();
  const events: { start: string; title: string; attendees?: string[] }[] = [];
  let mailCalls = 0;
  const sources: TieSources = {
    mail: async (since) => {
      mailCalls++;
      return { heads: heads.filter((h) => Date.parse(h.date) >= since.getTime()), text: async (h) => bodies.get(h.id) ?? '' };
    },
    events: async () => events,
  };
  const ties = new PeopleTies(app, { sources });
  app.peopleTies = ties;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const ago = (days: number) => new Date(clock.now.getTime() - days * DAY).toISOString();
  return { app, clock, ties, heads, bodies, events, ago, mailCalls: () => mailCalls, people: app.people };
}

test('S4.1 promises: own sentences with a due date; questions, negations and quotes are not promises', () => {
  const at = '2026-11-18T15:00:00Z'; // a Wednesday in Chicago
  const tz = 'America/Chicago';
  const a = findPromises("Hi Ana,\nThanks for the call. I'll send you the slides by Friday.\nBest, Alex", at, tz);
  assert.equal(a.length, 1);
  assert.match(a[0].text, /send you the slides by Friday/);
  assert.equal(a[0].due, '2026-11-20');
  assert.equal(findPromises('I will call you tomorrow about the lease.', at, tz)[0]?.due, '2026-11-19');
  assert.equal(findPromises("I'll get back to you next week.", at, tz)[0]?.due, '2026-11-25');
  assert.equal(findPromises('Let me check and I will email you the numbers.', at, tz)[0]?.due, null);
  assert.equal(findPromises('Will you send it Friday?', at, tz).length, 0);
  assert.equal(findPromises("I'll never send that. I won't call.", at, tz).length, 0);
  assert.equal(findPromises('Sounds good.\n\nOn Tue, Nov 17, 2026 Ana wrote:\n> I will send the invoice tomorrow.', at, tz).length, 0);
  assert.equal(findPromises('> I will send the invoice tomorrow.', at, tz).length, 0);
});

test('S4.2 mail: last contact per channel, waiting for your reply, promises proposed then confirmed', async (t) => {
  const r = rig(t);
  const dan = r.people.create({ name: 'Dan', status: 'active' });
  const ana = r.people.create({ name: 'Ana', fullName: 'Ana Ruiz', status: 'active' });
  r.ties.setTie(dan.id, { emails: [addr('dan')] });
  // Dan wrote 15 days ago and never got an answer; Ana got the owner's promise 1 day ago.
  r.heads.push({ id: 'm1', threadId: 't1', account: 'a', from: `Dan <${addr('dan')}>`, to: addr('alex'), date: r.ago(15), subject: 'Lease question', sent: false });
  r.heads.push({ id: 'm2', threadId: 't2', account: 'a', from: addr('alex'), to: `"Ana Ruiz" <${addr('ana')}>`, date: r.ago(1), subject: 'Slides', sent: true });
  r.heads.push({ id: 'm3', threadId: 't3', account: 'a', from: `News <news@${['example', 'test'].join('.')}>`, to: addr('alex'), date: r.ago(2), subject: 'Weekly', sent: false, bulk: true });
  r.bodies.set('m2', "Hi Ana, I'll send you the slides by Friday.");
  r.events.push({ start: r.ago(5), title: 'Coffee', attendees: [addr('ana')] });
  await r.ties.scan();
  // Ana's address was learned from her full name in the header.
  assert.deepEqual(r.ties.tie(ana.id).emails, [addr('ana')]);
  const contact = r.ties.contacts(ana.id);
  assert.ok(contact.some((c) => c.channel === 'mail' && c.dir === 'out'));
  assert.ok(contact.some((c) => c.channel === 'meeting' && c.dir === 'met'));
  // No message text is kept: only the promise sentence.
  const blob = JSON.stringify(r.app.store.db.prepare('SELECT * FROM person_contact').all());
  assert.doesNotMatch(blob, /slides by Friday/);
  const due = r.ties.attention();
  const waiting = due.find((n) => n.kind === 'waiting');
  assert.equal(waiting?.personId, dan.id);
  assert.equal(waiting?.text, '{name} has waited {n} weeks for your reply');
  assert.equal(waiting?.params.n, 2);
  const proposed = r.ties.promises({ status: 'proposed' });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].personId, ana.id);
  assert.equal(proposed[0].due, '2026-11-20');
  assert.ok(due.some((n) => n.kind === 'promise-check'), 'a confirmation card first');
  // A second scan doesn't propose the same promise again.
  await r.ties.scan();
  assert.equal(r.ties.promises({ status: 'all' }).length, 1);
  r.ties.decidePromise(proposed[0].id, 'confirm');
  const p = r.ties.attention().find((n) => n.kind === 'promise');
  assert.equal(p?.text, 'You promised {name}: {what} (by {date})');
  // Past due: overdue and first.
  r.clock.now = new Date(r.clock.now.getTime() + 4 * DAY);
  const late = r.ties.attention();
  assert.equal(late[0].kind, 'promise');
  assert.equal(late[0].text, 'You promised {name}: {what} (overdue since {date})');
  r.ties.decidePromise(proposed[0].id, 'done');
  assert.ok(!r.ties.attention().some((n) => n.kind === 'promise'));
  // Replying to Dan clears the wait.
  r.heads.push({ id: 'm4', threadId: 't1', account: 'a', from: addr('alex'), to: addr('dan'), date: r.clock.now.toISOString(), subject: 'Re: Lease question', sent: true });
  await r.ties.scan();
  assert.ok(!r.ties.attention().some((n) => n.kind === 'waiting'));
});

test('S4.3 keep in touch, dates and snoozes', async (t) => {
  const r = rig(t);
  const ben = r.people.create({ name: 'Ben', status: 'active', birthday: '1990-11-20' });
  r.ties.setTie(ben.id, { keepDays: 30, emails: [addr('ben')], dates: [{ label: 'Wedding anniversary', date: '2015-11-21' }] });
  r.heads.push({ id: 'b1', account: 'a', from: addr('alex'), to: addr('ben'), date: r.ago(70), subject: 'Hi', sent: true });
  await r.ties.scan();
  const due = r.ties.attention();
  const keep = due.find((n) => n.kind === 'keep');
  assert.equal(keep?.text, "You haven't been in touch with {name} for {n} months");
  assert.equal(keep?.params.n, 2);
  assert.ok(due.some((n) => n.kind === 'birthday' && n.params.n === 2));
  assert.ok(due.some((n) => n.kind === 'date' && n.params.label === 'Wedding anniversary'));
  // Today leaves birthdays to its Dates tile.
  const tile = r.ties.todayTile();
  assert.ok(tile && !tile.items.some((x) => x.kind === 'birthday'));
  // "Done": touched today, the nudge goes; "Later" snoozes a date for a week.
  r.ties.act(keep!.key, 'done');
  assert.ok(!r.ties.attention().some((n) => n.kind === 'keep'));
  const date = r.ties.attention().find((n) => n.kind === 'date')!;
  r.ties.act(date.key, 'later');
  assert.ok(!r.ties.attention().some((n) => n.kind === 'date'));
  // A person never contacted with a cadence: a gentle nudge once the cadence passed since it was set.
  const cy = r.people.create({ name: 'Cy', status: 'active' });
  r.ties.setTie(cy.id, { keepDays: 14 });
  assert.ok(!r.ties.attention().some((n) => n.personId === cy.id));
  r.clock.now = new Date(r.clock.now.getTime() + 15 * DAY);
  assert.equal(r.ties.attention().find((n) => n.personId === cy.id)?.text, 'Time to get in touch with {name}');
});

test('S4.4 chat rooms count; adult rooms never; owner promises from room lines', async (t) => {
  const r = rig(t);
  const app = r.app;
  const mia = r.people.create({ name: 'Mia', status: 'active' });
  const room = noteRoom(app, { bridge: 'discord', key: 'g1', kind: 'room', title: 'general' });
  setRoom(app, room.id, { keepUp: true });
  const adult = noteRoom(app, { bridge: 'discord', key: 'g2', kind: 'room', title: 'after dark', adult: true });
  setRoom(app, adult.id, { keepUp: true });
  r.people.linkRoom(mia.id, room.id, 'u-mia');
  r.people.linkRoom(mia.id, adult.id, 'u-mia');
  logLine(app, keepRoom(app, room.id)!, { platformId: 'p1', authorId: 'u-mia', author: 'Mia', who: 'person', text: 'Anyone have the notes?', at: r.ago(3) });
  logLine(app, keepRoom(app, room.id)!, { platformId: 'p2', authorId: 'u-alex', author: 'Alex', who: 'owner', text: "I'll send them tomorrow, Mia.", replyTo: 'p1', at: r.ago(3) });
  logLine(app, keepRoom(app, adult.id)!, { platformId: 'p3', authorId: 'u-mia', author: 'Mia', who: 'person', text: 'late line', at: r.ago(1) });
  await r.ties.scan();
  const c = r.ties.contacts(mia.id).filter((x) => x.channel === 'chat');
  assert.ok(c.some((x) => x.dir === 'in' && x.at === r.ago(3)), 'the adult room line is not used');
  assert.ok(c.some((x) => x.dir === 'out'));
  assert.equal(r.ties.promises({ status: 'proposed' })[0]?.personId, mia.id);
});

test('S4.5 privacy: off-record, switch off, private cards, forget wipes, merge moves', async (t) => {
  const r = rig(t);
  const dan = r.people.create({ name: 'Dan', status: 'active' });
  const sec = r.people.create({ name: 'Sol', status: 'active', private: true });
  r.ties.setTie(dan.id, { emails: [addr('dan')], keepDays: 7 });
  r.ties.setTie(sec.id, { emails: [addr('sol')], keepDays: 7 });
  r.heads.push({ id: 'd1', account: 'a', from: addr('dan'), to: addr('alex'), date: r.ago(20), subject: 'Hello', sent: false });
  r.heads.push({ id: 's1', account: 'a', from: addr('sol'), to: addr('alex'), date: r.ago(20), subject: 'Hello', sent: false });
  r.app.offRecord = true;
  await r.ties.scan();
  assert.equal(r.mailCalls(), 0, 'off the record nothing is read');
  r.app.offRecord = false;
  r.ties.setOn(false);
  await r.ties.scan();
  assert.equal(r.mailCalls(), 0, 'switched off nothing is read');
  r.ties.setOn(true);
  await r.ties.scan();
  assert.ok(r.ties.attention().some((n) => n.personId === dan.id));
  assert.ok(!r.ties.attention().some((n) => n.personId === sec.id), 'a private card stays out of normal views');
  assert.ok(r.ties.attention({ private: true }).some((n) => n.personId === sec.id));
  r.ties.addPromise(dan.id, { text: 'Return the drill', due: '2026-11-25' });
  // Merge: the derived rows move with the card.
  const dan2 = r.people.create({ name: 'Daniel', status: 'active' });
  r.people.merge(dan.id, dan2.id);
  assert.ok(r.ties.contacts(dan2.id).length);
  assert.equal(r.ties.promises({ status: 'all' })[0].personId, dan2.id);
  assert.deepEqual(r.ties.tie(dan2.id).emails, [addr('dan')]);
  // Forget: every derived row for the person goes.
  r.people.forget(dan2.id);
  for (const tbl of ['person_contact', 'person_promises', 'person_ties']) {
    const n = (r.app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE person_id = ?`).get(dan2.id) as { n: number }).n;
    assert.equal(n, 0, tbl);
  }
  assert.equal((r.app.store.db.prepare("SELECT COUNT(*) AS n FROM memory_kv WHERE key LIKE 'ties:snooze:%:" + dan2.id + ":%'").get() as { n: number }).n, 0);
});

test('S4.6 members are isolated: each space has its own ties', async (t) => {
  const a = rig(t);
  const b = rig(t);
  const pa = a.people.create({ name: 'Dan', status: 'active' });
  a.ties.setTie(pa.id, { keepDays: 7 });
  a.ties.addPromise(pa.id, { text: 'Call back' });
  assert.equal(b.ties.promises({ status: 'all' }).length, 0);
  assert.equal(b.ties.attention().length, 0);
});

test('S4.7 tick: scans on the reminder tick at most every 30 minutes; tools people_due and promise_list', async (t) => {
  const r = rig(t);
  const dan = r.people.create({ name: 'Dan', status: 'active' });
  r.ties.setTie(dan.id, { emails: [addr('dan')] });
  r.heads.push({ id: 'd1', account: 'a', from: addr('dan'), to: addr('alex'), date: r.ago(9), subject: 'Hello', sent: false });
  await r.ties.due(r.clock.now);
  await r.ties.due(new Date(r.clock.now.getTime() + 10 * 60_000));
  assert.equal(r.mailCalls(), 1);
  await r.ties.due(new Date(r.clock.now.getTime() + 31 * 60_000));
  assert.equal(r.mailCalls(), 2);
  r.ties.addPromise(dan.id, { text: 'Send the photos', due: '2026-11-20' });
  const tools = createPeopleTiesTools(() => r.app);
  const due = tools.find((x) => x.spec.name === 'people_due')!;
  const list = tools.find((x) => x.spec.name === 'promise_list')!;
  const out = await due.run({}, { signal: new AbortController().signal, conversationId: undefined } as never);
  assert.match(String(out), /Dan has waited 9 days for your reply/);
  assert.match(String(out), /You promised Dan: Send the photos/);
  assert.match(String(await list.run({}, { signal: new AbortController().signal } as never)), /Send the photos.*2026-11-20/);
  assert.equal(due.defaultPermission, 'auto');
  assert.equal(familyOf({ spec: { name: 'promise_list', description: '', parameters: {} } } as never).id, 'people');
  assert.equal(familyOf({ spec: { name: 'people_due', description: '', parameters: {} } } as never).id, 'people');
});

test('S4.8 wiring: Today tile, page markup, docs', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /id="td-people"/);
  assert.match(html, /id="ppl-ties-on"/);
  assert.match(readFileSync(join(ROOT, 'src', 'today-layout.ts'), 'utf8'), /td-people/);
  assert.match(readFileSync(join(ROOT, 'web', 'today.js'), 'utf8'), /td-people/);
  assert.match(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8'), /peopleTies\?\.due/);
  assert.match(readFileSync(join(ROOT, 'docs', 'PEOPLE.md'), 'utf8'), /## Keeping in touch/);
});
