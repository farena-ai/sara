// U3.19 (docs/ASK_EVERYTHING.md): Ask about anything also covers meetings (S2 transcripts and notes,
// cited with the meeting and the time in the recording), trips (S6 bookings), people (S4 card notes,
// promises and last contact; private cards only in a private chat), documents (S7 templates, drafts
// and clause checklists), research reports (S1) and goals (S3). Fixtures for every source; each one
// follows its feature's privacy rules (members isolated, kids skipped, private/adult chats left out,
// Private local mode still searches what lives here) and each hit opens the exact item.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { askEverything, ASK_SOURCES, formatAsk } from '../src/ask-everything.ts';
import { makeDocument } from '../src/documents/make.ts';
import { docTemplates } from '../src/documents/templates.ts';
import { LibraryStore } from '../src/library/store.ts';
import { LongGoals } from '../src/long-goals.ts';
import { Meetings } from '../src/meetings.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { PeopleStore } from '../src/people.ts';
import { PeopleTies } from '../src/people-ties.ts';
import { Research } from '../src/research.ts';
import { Travel } from '../src/travel.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-16T15:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
after(() => {
  for (const a of apps) a.store.close();
  for (const d of dirs) d();
});

function space(member?: { id: string; name: string; child?: Record<string, unknown> }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' });
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.people = new PeopleStore(app.store.db);
  app.travel = new Travel(app, app.store.db, { notify: async () => undefined, quiet: () => true } as never);
  app.longGoals = new LongGoals(app, app.store.db, { notify: async () => undefined, quiet: () => true });
  if (member) {
    const rec = { id: member.id, name: member.name, status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 }, ...(member.child ? { child: member.child } : {}) };
    (app as unknown as { member: unknown }).member = { record: () => rec, child: () => rec.child, limits: () => rec.limits };
  } else {
    app.meetings = new Meetings(app, app.store.db, { events: async () => [] });
    app.research = new Research(app, app.store.db);
    app.peopleTies = new PeopleTies(app);
  }
  return app;
}

/** A trip with one flight, as the travel assistant keeps it. */
function trip(app: App, title: string, flight: { number: string; from: string; to: string; start: string; confirmation: string }): number {
  const db = app.store.db;
  const now = clock.now.toISOString();
  const id = Number(db.prepare('INSERT INTO travel_trips (title, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?)').run(title, new Date(flight.start).toISOString(), new Date(flight.start).toISOString(), now).lastInsertRowid);
  db.prepare("INSERT INTO travel_bookings (trip_id, key, kind, data_json, starts_at, accounts_json, created_at) VALUES (?, ?, 'flight', ?, ?, '[]', ?)").run(id, `k-${flight.number}`, JSON.stringify({ title: `Flight ${flight.number} ${flight.from} to ${flight.to}`, number: flight.number, airline: 'Skyway Air', from: flight.from, to: flight.to, start: flight.start, confirmation: flight.confirmation, tz: 'America/Chicago' }), new Date(flight.start).toISOString(), now);
  return id;
}

function meeting(app: App, title: string, lines: { speaker: string; text: string; t: number }[], notes: Record<string, unknown>): number {
  const db = app.store.db;
  const at = clock.now.toISOString();
  const id = Number(db.prepare("INSERT INTO meetings (title, source, status, created_at, notes) VALUES (?, 'file', 'done', ?, ?)").run(title, at, JSON.stringify(notes)).lastInsertRowid);
  lines.forEach((l, i) => db.prepare("INSERT INTO meeting_lines (meeting_id, n, kind, speaker, text, at, t) VALUES (?, ?, 'said', ?, ?, ?, ?)").run(id, i + 1, l.speaker, l.text, at, l.t));
  return id;
}

function research(app: App, question: string, report: string, conv: string | null): number {
  return Number(app.store.db.prepare("INSERT INTO research_runs (question, status, plan, report, conv, created_at, updated_at) VALUES (?, 'done', ?, ?, ?, ?, ?)").run(question, JSON.stringify({ steps: [], pages: 5 }), report, conv, clock.now.toISOString(), clock.now.toISOString()).lastInsertRowid);
}

// ---------------------------------------------------------------- the owner's fixtures
const owner = space();
const priv = owner.store.createConversation({ title: 'Private', private: true });
const plain = owner.store.createConversation({ title: 'Plans' });
const mtg = meeting(owner, 'Kitchen remodel kickoff', [
  { speaker: 'Dana', text: 'Welcome everyone, glad we could meet.', t: 3 },
  { speaker: 'Sam', text: 'The contractor quote for the kitchen remodel came in at 41 thousand.', t: 725.4 },
], { summary: 'We agreed on the kitchen remodel scope.', decisions: ['Go with the walnut cabinets for the kitchen remodel'], actions: [{ task: 'Send the contractor the signed quote', owner: 'Sam', due: 'Friday', dueAt: null, taskId: null }], questions: [] });
const denver = trip(owner, 'Denver trip', { number: 'SK 1452', from: 'ORD', to: 'DEN', start: '2026-11-20T08:05:00-06:00', confirmation: 'QX7P2L' });
const rosa = owner.people!.create({ name: 'Rosa', fullName: 'Rosa Marquez', relation: 'accountant', notes: 'Handles the quarterly taxes; prefers email over calls.', status: 'active' });
owner.peopleTies!.addPromise(rosa.id, { text: 'Send Rosa the quarterly taxes receipts', due: '2026-11-20' });
owner.peopleTies!.decidePromise(owner.peopleTies!.promises({ personId: rosa.id, status: 'all' })[0].id, 'confirm');
owner.store.db.prepare("INSERT INTO person_contact (person_id, channel, dir, at, ref, label) VALUES (?, 'mail', 'in', ?, NULL, 'Taxes')").run(rosa.id, '2026-11-10T12:00:00Z');
const secretFriend = owner.people!.create({ name: 'Quill', notes: 'Quill knows about the quarterly taxes surprise party.', status: 'active', private: true });
// Documents studio: a contract template and a made proposal draft; a draft made in a private chat stays out.
const tplDoc = owner.library!.add({ name: 'Consulting contract template.docx', bytes: Buffer.from('fake'), keep: true, origin: 'library', learn: false } as never);
docTemplates(owner).mark(tplDoc.id, 'contract', [{ label: 'client name', kind: 'text', raw: '[CLIENT NAME]' } as never, { label: 'hourly rate', kind: 'text', raw: '[RATE]' } as never]);
const { made } = makeDocument(owner, { format: 'md', title: 'Greenhouse proposal', content: '# Greenhouse proposal\n\nWe propose a cedar greenhouse with automatic vents. Payment terms: 30 days after delivery. Either party may terminate with 14 days notice.' }, { conversationId: plain.id });
makeDocument(owner, { format: 'md', title: 'Greenhouse private memo', content: 'A private memo about the greenhouse budget.' }, { conversationId: priv.id, keep: false });
const rs = research(owner, 'Best heat pump for a cold climate', 'For a cold climate the best heat pump models keep 80 percent of their heat at -15 C [1].', plain.id);
research(owner, 'Heat pump for the secret cabin', 'The secret cabin heat pump report.', priv.id);
const goal = owner.longGoals!.create({ title: 'Run a half marathon', due: '2027-04-01', milestones: [{ text: 'Run 10 km without stopping', due: '2026-12-15' }] }, { by: 'page', conversationId: plain.id });
// (Goals can't be set up from a private chat at all: S3 refuses them.)

const group = (r: Awaited<ReturnType<typeof askEverything>>, s: string) => r.groups.find((g) => g.source === s)?.items ?? [];

test('U3.19: the new sources are listed after the old ones (old order unchanged)', () => {
  assert.deepEqual([...ASK_SOURCES], ['mail', 'files', 'chats', 'calendar', 'notes', 'lists', 'contacts', 'meetings', 'trips', 'documents', 'research', 'goals', 'money', 'health']);
});

test('U3.19 meetings: transcripts and notes, cited with the meeting and the time in the recording', async () => {
  const r = await askEverything(owner, 'contractor quote kitchen remodel', { sources: ['meetings'] });
  const hits = group(r, 'meetings');
  const said = hits.find((h) => h.open.kind === 'meeting' && h.open.line === 2);
  assert.ok(said, JSON.stringify(hits));
  assert.equal(said.title, 'Kitchen remodel kickoff');
  assert.match(said.quote, /41 thousand/);
  assert.match(said.where ?? '', /Sam · 12:05/, 'speaker and timestamp');
  assert.deepEqual(said.open, { kind: 'meeting', id: mtg, line: 2, t: 725.4 });
  const note = hits.find((h) => h.open.kind === 'meeting' && h.open.line === undefined);
  assert.ok(note && /signed quote|walnut/.test(note.quote), 'the notes (decisions, actions) are searched too');
  assert.match(formatAsk(r), /Meetings:\n\[1\] Kitchen remodel kickoff · Sam · 12:05/);
});

test('U3.19 trips: bookings on the trip timeline open the trip', async () => {
  const r = await askEverything(owner, 'flight to Denver confirmation', { sources: ['trips'] });
  const [h] = group(r, 'trips');
  assert.ok(h, JSON.stringify(r));
  assert.equal(h.title, 'Denver trip');
  assert.match(h.quote, /SK 1452/);
  assert.match(h.quote, /QX7P2L/);
  assert.deepEqual(h.open, { kind: 'trip', id: denver, booking: h.open.kind === 'trip' ? h.open.booking : 0 });
  assert.ok(h.open.kind === 'trip' && h.open.booking! > 0);
});

test('U3.19 people: card notes, promises and last contact; private cards only in a private chat', async () => {
  const r = await askEverything(owner, 'quarterly taxes', { sources: ['contacts'] });
  const hits = group(r, 'contacts');
  assert.ok(hits.some((h) => h.title === 'Rosa Marquez' && /prefers email/.test(h.quote)), 'card notes');
  const promise = hits.find((h) => /receipts/.test(h.quote));
  assert.ok(promise, 'a promise');
  assert.match(promise.where ?? '', /promise/);
  assert.deepEqual(promise.open, { kind: 'person', id: rosa.id });
  assert.ok(hits.some((h) => /last contact/i.test(h.where ?? '') && /2026-11-10/.test(h.where ?? '')), 'last contact');
  assert.ok(!hits.some((h) => h.open.kind === 'person' && h.open.id === secretFriend.id), 'a private card stays out of a normal ask');
  const inPriv = await askEverything(owner, 'quarterly taxes', { sources: ['contacts'], conversationId: priv.id });
  assert.ok(group(inPriv, 'contacts').some((h) => h.open.kind === 'person' && h.open.id === secretFriend.id), 'a private card shows in a private chat');
});

test('U3.19 documents: templates, drafts and clause checklists open in the Library', async () => {
  const t1 = await askEverything(owner, 'consulting contract hourly rate', { sources: ['documents'] });
  const tpl = group(t1, 'documents').find((h) => h.open.kind === 'library' && h.open.docId === tplDoc.id);
  assert.ok(tpl, JSON.stringify(t1));
  assert.match(tpl.where ?? '', /template/i);
  assert.match(tpl.quote, /hourly rate/);
  const t2 = await askEverything(owner, 'greenhouse payment terms', { sources: ['documents'] });
  const hits = group(t2, 'documents');
  const draft = hits.find((h) => h.title === 'Greenhouse proposal' && /Payment terms/.test(h.quote));
  assert.ok(draft, JSON.stringify(hits));
  assert.deepEqual(draft.open, { kind: 'library', docId: made.libraryId });
  assert.ok(!hits.some((h) => /private memo/.test(h.title)), 'a draft from a private chat stays out');
  const t3 = await askEverything(owner, 'greenhouse proposal timeline', { sources: ['documents'] });
  const line = group(t3, 'documents').find((h) => /clause checklist · Proposal/.test(h.where ?? ''));
  assert.ok(line, JSON.stringify(group(t3, 'documents')));
  assert.match(line.quote, /^Timeline: “Payment terms: 30 days after delivery\.”$/, 'the clause it found, quoted');
  assert.deepEqual(line.open, { kind: 'library', docId: made.libraryId });
});

test('U3.19 research and goals: reports and goals open at the item; private-chat ones stay out', async () => {
  const r = await askEverything(owner, 'heat pump cold climate', { sources: ['research'] });
  const hits = group(r, 'research');
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].title, 'Best heat pump for a cold climate');
  assert.match(hits[0].quote, /80 percent/);
  assert.deepEqual(hits[0].open, { kind: 'research', id: rs });
  const g = await askEverything(owner, 'marathon 10 km', { sources: ['goals'] });
  const gh = group(g, 'goals');
  assert.equal(gh.length, 1, JSON.stringify(gh));
  assert.equal(gh[0].title, 'Run a half marathon');
  assert.match(gh[0].quote, /10 km/);
  assert.deepEqual(gh[0].open, { kind: 'goal', id: goal.id });
});

test('U3.19 privacy: off the record nothing; kids skip the new sources; Private local still searches what lives here', async () => {
  owner.offRecord = true;
  try {
    const r = await askEverything(owner, 'kitchen remodel');
    assert.equal(r.groups.length, 0);
    for (const s of ['meetings', 'trips', 'documents', 'research', 'goals']) assert.ok(r.skipped.some((x) => x.source === s), s);
  } finally {
    owner.offRecord = false;
  }
  setPrivateLocal(true);
  try {
    const r = await askEverything(owner, 'kitchen remodel contractor');
    assert.ok(group(r, 'meetings').length, 'meetings live on this computer');
    assert.ok(!r.skipped.some((x) => x.source === 'meetings'));
  } finally {
    setPrivateLocal(false);
  }
  const kid = space({ id: 'k1', name: 'Kai', child: { age: 9 } });
  trip(kid, 'Grandma visit', { number: 'SK 9', from: 'ORD', to: 'DEN', start: '2026-12-20T08:05:00-06:00', confirmation: 'KIDTRIP' });
  const k = await askEverything(kid, 'Grandma visit Denver');
  for (const s of ['meetings', 'trips', 'documents', 'research', 'goals']) assert.ok(k.skipped.some((x) => x.source === s), `kid skips ${s}`);
});

test('U3.19 members: their own trips and goals only, never the owner meetings, research or documents', async () => {
  const bo = space({ id: 'm1', name: 'Bo' });
  trip(bo, 'Bo in Denver', { number: 'SK 77', from: 'ORD', to: 'DEN', start: '2026-12-01T08:05:00-06:00', confirmation: 'BOTRIP' });
  const r = await askEverything(bo, 'Denver kitchen remodel heat pump marathon');
  assert.deepEqual(group(r, 'trips').map((h) => h.title), ['Bo in Denver']);
  assert.equal(group(r, 'meetings').length, 0);
  assert.equal(group(r, 'research').length, 0);
  assert.ok(!JSON.stringify(r).includes('Kitchen remodel'));
  assert.ok(!JSON.stringify(r).includes('half marathon'));
});

test('U3.19 ui: the ✦ ask box legend lists the new sources and opens each at the item', () => {
  const js = readFileSync(join(ROOT, 'web/ask-everything.js'), 'utf8');
  for (const s of ["'meetings'", "'trips'", "'documents'", "'research'", "'goals'", "t('Meetings')", "t('Trips')", "t('Documents')", "t('Research')", "t('Goals')", 'openMeetingsView', 'openTrips', 'openGoals', 'openResearch']) assert.ok(js.includes(s), s);
  const doc = readFileSync(join(ROOT, 'docs/ASK_EVERYTHING.md'), 'utf8');
  for (const s of ['Meetings', 'Trips', 'Documents', 'Research', 'Goals']) assert.ok(doc.includes(s), s);
});
