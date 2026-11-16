// S5 (docs/ASK_EVERYTHING.md): one question across mail, files, chats, calendar, notes, lists and
// contacts, answered with quotes and numbered citations that open each source at the spot.
// Fixtures for every source; isolation: private chats, off the record, household members, kids.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { askEverything, askWords, ASK_SOURCES, createAskEverythingTool, readAskMail } from '../src/ask-everything.ts';
import { OwnerAuth } from '../src/auth.ts';
import { KID_TOOLS } from '../src/family.ts';
import { CORE_CHAT } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { interruptible } from '../src/pending.ts';
import { PeopleStore } from '../src/people.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-16T15:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
const fakeAddr = (who: string) => `${who}@example.test`;
// Built at run time: no realistic-looking ids in the source.
const mailId = (n: number) => ['m', 'x', n].join('-');

interface FakeMail { id: string; from: string; subject: string; date: string; text: string }
/** A fake app-password mailbox with a calendar (the MailAccounts surface ask-everything reads). */
function fakeAccounts(address: string, mails: FakeMail[], events: { id: string; title: string; start: string; location?: string }[], opts: { failMail?: boolean } = {}) {
  const info = { id: 'im_one', address, kind: 'imap', provider: 'other', calendar: true };
  const asMsg = (m: FakeMail) => ({ id: m.id, threadId: m.id, from: m.from, to: address, subject: m.subject, date: m.date, snippet: m.text.slice(0, 120), unread: false, flagged: false, headers: {}, text: m.text });
  const searched: string[][] = [];
  const provider = {
    async searchIds(terms: { words: string[] }) {
      if (opts.failMail) throw new Error('mailbox offline');
      searched.push(terms.words);
      const ids = mails.filter((m) => terms.words.every((w) => `${m.subject} ${m.text}`.toLowerCase().includes(w.toLowerCase()))).map((m) => m.id);
      return { ids, capped: false };
    },
    async list(ids: string[]) {
      return mails.filter((m) => ids.includes(m.id)).map(asMsg);
    },
    async get(id: string) {
      const m = mails.find((x) => x.id === id);
      if (!m) throw new Error('not found');
      return asMsg(m);
    },
    calendar: {
      async events(from: Date, to: Date) {
        return events.filter((e) => Date.parse(e.start) >= from.getTime() && Date.parse(e.start) <= to.getTime()).map((e) => ({ ...e, allDay: false }));
      },
    },
  };
  return { searched, accts: { list: () => [info], combined: () => [info], default: () => info, provider: () => provider, view: () => ({}) } };
}

function space(member?: { id: string; name: string; child?: Record<string, unknown> }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.people = new PeopleStore(app.store.db);
  if (member) {
    const rec = { id: member.id, name: member.name, status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 }, ...(member.child ? { child: member.child } : {}) };
    (app as unknown as { member: unknown }).member = { record: () => rec, child: () => rec.child, limits: () => rec.limits };
  }
  return app;
}

// The owner's life: the lease renewal shows up in every source.
const owner = space();
const ownerMail = fakeAccounts(fakeAddr('alex'), [
  { id: mailId(1), from: `Dan Landlord <${fakeAddr('dan')}>`, subject: 'Lease renewal', date: '2026-10-02T14:00:00Z', text: 'Hi Alex, the lease renewal is due December 1. Please sign the renewal form by then.' },
  { id: mailId(2), from: `Shop <${fakeAddr('shop')}>`, subject: 'Your order shipped', date: '2026-10-03T14:00:00Z', text: 'Your blender shipped today.' },
], [{ id: 'ev1', title: 'Sign lease renewal with Dan', start: '2026-11-28T16:00:00Z', location: 'Office on Main St' }]);
(owner as unknown as { mailAccounts: unknown }).mailAccounts = ownerMail.accts;
const chat = owner.store.createConversation({ title: 'Apartment plans' });
owner.store.addMessage(chat.id, 'user', 'Dan told me on the phone that the lease renewal goes up 3 percent.');
owner.store.addMessage(chat.id, 'user', 'When is the lease renewal due again?');
owner.store.addMessage(chat.id, 'assistant', 'Your lease renewal is due **December 1** [1][2].');
const priv = owner.store.createConversation({ title: 'Private thoughts', private: true });
owner.store.addMessage(priv.id, 'user', 'Secret: I might not do the lease renewal at all, zebrafish.');
const forgot = owner.store.createConversation({ title: 'Old chat' });
owner.store.addMessage(forgot.id, 'user', 'Forgotten line about the lease renewal and a walrus.', { forgotten: true });
owner.planner!.saveNote({ title: 'Apartment', body: 'Lease renewal: ask Dan about parking before signing.' });
owner.planner!.addTask({ title: 'Print the lease renewal form' });
const leaseDoc = owner.library!.importDoc({
  name: 'lease.pdf',
  title: 'Apartment lease',
  passages: [
    { place: 'page 1', heading: null, text: 'This agreement is between the tenant and the landlord for the apartment.' },
    { place: 'page 4', heading: 'Renewal', text: 'The tenant must give notice of lease renewal 60 days before the end of the term on December 1.' },
  ],
});
owner.people!.create({ name: 'Dan', fullName: 'Dan Landlord', relation: 'landlord', notes: 'Handles the lease renewal and repairs.', status: 'active' });

after(() => {
  for (const a of apps) a.store.close();
  for (const c of dirs) c();
});

test('askWords keeps the words that matter in a question', () => {
  assert.deepEqual(askWords('When is my lease renewal due?'), ['lease', 'renewal', 'due']);
  assert.deepEqual(askWords('¿Cuándo vence el contrato?'), ['cuándo', 'vence', 'contrato']);
  assert.deepEqual(askWords('   '), []);
});

test('one question reaches every source, grouped, each hit with a quote and where to open it', async () => {
  const r = await askEverything(owner, 'When is the lease renewal due?');
  const by = Object.fromEntries(r.groups.map((g) => [g.source, g]));
  for (const s of ['mail', 'files', 'chats', 'calendar', 'notes', 'lists', 'contacts']) assert.ok(by[s]?.items.length, `${s}: ${JSON.stringify(r.groups.map((g) => [g.source, g.items.length, g.error]))}`);
  assert.deepEqual(r.groups.map((g) => g.source), ASK_SOURCES.filter((s) => by[s]));
  const mail = by.mail.items[0];
  assert.equal(mail.open.kind, 'mail');
  assert.equal((mail.open as { id: string }).id, mailId(1));
  assert.match(mail.quote, /due December 1/);
  assert.match(mail.where ?? '', /Dan Landlord/);
  assert.ok(!by.mail.items.some((h) => /blender/.test(h.quote)), 'the unrelated email is not a hit');
  const file = by.files.items[0];
  assert.deepEqual(file.open, { kind: 'library', docId: leaseDoc, page: 4 });
  assert.match(file.where ?? '', /page 4/);
  assert.match(file.quote, /60 days before/);
  const c = by.chats.items[0];
  assert.equal((c.open as { conversationId: string }).conversationId, chat.id);
  assert.ok((c.open as { messageId?: number }).messageId);
  assert.equal(by.calendar.items[0].open.kind, 'event');
  assert.match(by.calendar.items[0].where ?? '', /Office on Main St/);
  assert.equal(by.contacts.items[0].open.kind, 'person');
  // The cited answer: numbered lines, each pointing at a hit.
  assert.ok(r.answer.length >= 3 && r.answer.length <= 7, String(r.answer.length));
  const cites = new Set(r.groups.flatMap((g) => g.items.map((h) => h.cite)).filter(Boolean));
  for (const line of r.answer) assert.ok(cites.has(line.cite), JSON.stringify(line));
  assert.ok(!by.chats.items.some((h) => /\?$/.test(h.quote) && h.where === 'you'), 'a bare question is no answer');
  assert.ok(!by.chats.items.some((h) => /\[\d\]/.test(h.quote)), 'her own cited answer is not a source');
  assert.ok(new Set(r.answer.map((l) => l.source)).size >= 3, 'the answer draws on several sources');
});

test('private chats, forgotten messages and off the record never show', async () => {
  const r = await askEverything(owner, 'lease renewal zebrafish walrus');
  assert.ok(r.groups.find((g) => g.source === 'chats')?.items.length, 'the open chat is found');
  const all = JSON.stringify([r.groups, r.answer]);
  assert.ok(!all.includes('zebrafish'), 'a private chat leaked');
  assert.ok(!all.includes('walrus'), 'a forgotten message leaked');
  assert.ok(!all.includes(priv.id));
  const off = await askEverything({ ...owner, offRecord: true } as App, 'lease renewal');
  assert.equal(off.groups.length, 0);
  assert.ok(off.skipped.length && off.skipped.every((s) => /record/i.test(s.why)));
});

test('a household member only sees their own life', async () => {
  const sam = space({ id: 'mem1', name: 'Sam' });
  const c = sam.store.createConversation({ title: 'Guitar' });
  sam.store.addMessage(c.id, 'user', 'My guitar lesson moved to Thursday.');
  sam.planner!.saveNote({ title: 'Guitar', body: 'Lesson songs: Wonderwall.' });
  const mine = await askEverything(sam, 'guitar lesson');
  assert.ok(mine.groups.find((g) => g.source === 'chats')?.items.length);
  const theirs = await askEverything(sam, 'lease renewal');
  assert.equal(theirs.groups.reduce((n, g) => n + g.items.length, 0), 0, JSON.stringify(theirs.groups));
  // And the owner never sees the member's.
  const back = await askEverything(owner, 'guitar Wonderwall');
  assert.equal(back.groups.reduce((n, g) => n + g.items.length, 0), 0);
});

test("kid mode: only the sources a child's allowlist covers", async () => {
  const kid = space({ id: 'kid1', name: 'Mia', child: { band: '10-12', shopAllow: [] } });
  const k = fakeAccounts(fakeAddr('mia'), [{ id: mailId(3), from: fakeAddr('friend'), subject: 'Science fair', date: '2026-11-01T10:00:00Z', text: 'The science fair is Friday.' }], [{ id: 'ev2', title: 'Science fair', start: '2026-11-20T15:00:00Z' }]);
  (kid as unknown as { mailAccounts: unknown }).mailAccounts = k.accts;
  kid.planner!.saveNote({ title: 'Science fair', body: 'Volcano project for the science fair.' });
  kid.people!.create({ name: 'Science teacher', relation: 'teacher', notes: 'runs the science fair', status: 'active' });
  const r = await askEverything(kid, 'science fair', { sources: ['mail', 'calendar', 'contacts', 'notes'] });
  assert.deepEqual(r.groups.map((g) => g.source), ['notes']);
  assert.deepEqual(r.skipped.map((s) => s.source).sort(), ['calendar', 'contacts', 'mail']);
  assert.equal(k.searched.length, 0, 'a child’s mailbox was searched');
  assert.ok(KID_TOOLS.has('ask_everything'));
});

test('one source failing does not hide the others', async () => {
  const a = space();
  (a as unknown as { mailAccounts: unknown }).mailAccounts = fakeAccounts(fakeAddr('lee'), [], [], { failMail: true }).accts;
  a.planner!.saveNote({ title: 'Bikes', body: 'Bike tune-up in spring.' });
  const r = await askEverything(a, 'bike tune-up');
  assert.ok(r.groups.find((g) => g.source === 'notes')?.items.length);
  assert.match(r.groups.find((g) => g.source === 'mail')?.error ?? '', /offline/);
});

test('the tool: numbered citations, read-only, offered by default', async () => {
  const tool = createAskEverythingTool(() => owner);
  assert.equal(tool.spec.name, 'ask_everything');
  assert.equal(tool.defaultPermission, 'auto');
  assert.ok(interruptible('ask_everything'));
  assert.ok((CORE_CHAT as readonly string[]).includes('ask_everything'));
  const out = String(await tool.run({ question: 'lease renewal due' }, { signal: new AbortController().signal } as never));
  assert.match(out, /\[1\]/);
  assert.match(out, /lease\.pdf|Apartment lease/);
  assert.match(out, /page 4/);
  assert.match(out, /information only/i);
  assert.ok(!out.includes('zebrafish'));
  await assert.rejects(() => tool.run({}, { signal: new AbortController().signal } as never), /question/i);
});

test('reading an email at the spot', async () => {
  const m = await readAskMail(owner, 'im_one', mailId(1));
  assert.equal(m.subject, 'Lease renewal');
  assert.match(m.text, /due December 1/);
  await assert.rejects(() => readAskMail(owner, 'nope', mailId(1)));
});

describeRoutes();
function describeRoutes() {
  const auth = new OwnerAuth(owner.dataDir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app: owner, auth, webDir: join(ROOT, 'web') } as never);
  let base = '';
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());
  const get = (p: string) => fetch(base + p, { headers: { authorization: `Bearer ${token}` } });
  test('routes: GET /api/find/ask and /api/find/ask/mail', async () => {
    const r = await get('/api/find/ask?q=' + encodeURIComponent('lease renewal'));
    assert.equal(r.status, 200);
    const body = (await r.json()) as { groups: { source: string }[]; answer: unknown[] };
    assert.ok(body.groups.length >= 5);
    assert.ok(body.answer.length);
    const only = (await (await get('/api/find/ask?q=lease&sources=notes,files')).json()) as { groups: { source: string }[] };
    assert.deepEqual([...new Set(only.groups.map((g) => g.source))].sort(), ['files', 'notes']);
    assert.equal((await get('/api/find/ask?q=')).status, 400);
    const m = await get(`/api/find/ask/mail?account=im_one&id=${mailId(1)}`);
    assert.equal(m.status, 200);
    assert.match(((await m.json()) as { text: string }).text, /December 1/);
    assert.equal((await get(`/api/find/ask/mail?account=im_one&id=${mailId(99)}`)).status, 404);
  });
}

test('web: the ask box, its strings and translations', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'web/ask-everything.js'), 'utf8');
  assert.match(html, /<dialog id="ask-all"/);
  assert.match(html, /Ask about anything in your life/);
  assert.match(js, /\/find\/ask\?q=/);
  for (const s of ['Emails', 'Files', 'Chats', 'Calendar', 'Notes', 'Lists', 'Contacts']) assert.ok(js.includes(`t('${s}')`), s);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(readFileSync(join(ROOT, 'web/ask-everything.css'), 'utf8')), 'theme variables only');
  const es = readFileSync(join(ROOT, 'web/i18n/es.json'), 'utf8');
  assert.ok(es.includes('"Ask about anything in your life"'));
});
