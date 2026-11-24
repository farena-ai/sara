// T45 C14: "check everything" reaches the mail even when the model picks `library` (action ask)
// instead of ask_everything. The person's own words this turn decide (they named their mail, or
// said everything); ask_everything's rules decide what may be read (private chat, a child, off the
// record, the tool's own "ask first" setting). Fake mailbox, no network.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { beyondDocsCue, createAskEverythingTool } from '../src/ask-everything.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createLibraryTool } from '../src/library/use.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeApp, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-16T15:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
after(() => {
  for (const a of apps) a.store.close();
  for (const c of dirs) c();
});

const addr = (who: string) => `${who}@example.test`;

/** A space with a lease in the Library, a note, and a mailbox whose searches are counted. */
function space(member?: { child: Record<string, unknown> }) {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.library.importDoc({ name: 'lease.pdf', title: 'Apartment lease', passages: [{ place: 'page 4', heading: 'Renewal', text: 'The tenant must give notice of lease renewal 60 days before the end of the term on December 1.' }] });
  app.planner!.saveNote({ title: 'Apartment', body: 'Lease renewal: ask Dan about parking before signing.' });
  const mails = [{ id: ['m', 'x', 1].join('-'), from: `Dan Landlord <${addr('dan')}>`, subject: 'Lease renewal', date: '2026-10-02T14:00:00Z', text: 'Hi Alex, the lease renewal is due December 1. Please sign the renewal form by then.' }];
  const info = { id: 'im_one', address: addr('alex'), kind: 'imap', provider: 'other', calendar: false };
  const searched: string[][] = [];
  const provider = {
    async searchIds(terms: { words: string[] }) {
      searched.push(terms.words);
      return { ids: mails.filter((m) => terms.words.every((w) => `${m.subject} ${m.text}`.toLowerCase().includes(w.toLowerCase()))).map((m) => m.id), capped: false };
    },
    async list(ids: string[]) {
      return mails.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, threadId: m.id, from: m.from, to: info.address, subject: m.subject, date: m.date, snippet: m.text, unread: false, flagged: false, headers: {}, text: m.text }));
    },
  };
  (app as unknown as { mailAccounts: unknown }).mailAccounts = { list: () => [info], combined: () => [info], default: () => info, provider: () => provider, view: () => ({}) };
  if (member) {
    const rec = { id: 'kid1', name: 'Mia', status: 'active', limits: { voice: false, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 }, child: member.child };
    (app as unknown as { member: unknown }).member = { record: () => rec, child: () => rec.child, limits: () => rec.limits };
  }
  app.tools.add(createAskEverythingTool(() => app));
  const library: Tool = createLibraryTool(() => app);
  app.tools.add(library);
  /** One turn: what the person said, then her `library` ask with the model's own (shorter) query. */
  const ask = async (said: string, o: { private?: boolean; channel?: string; query?: string } = {}) => {
    const conv = app.store.createConversation({ title: 'Home', ...(o.private ? { private: true } : {}), ...(o.channel ? { channel: o.channel } : {}) });
    app.store.addMessage(conv.id, 'user', said);
    const ctx = { workspaceDir: dir, signal: AbortSignal.timeout(20_000), sandbox: { mode: 'none', network: true, detail: 'test' }, conversationId: conv.id } as ToolContext;
    return String(await library.run({ action: 'ask', query: o.query ?? 'When is the lease renewal due?' }, ctx));
  };
  return { app, ask, searched };
}

test('the cue: their mail or "everything", in six languages; ordinary questions have none', () => {
  assert.equal(beyondDocsCue('When is my lease renewal due? Check everything you have, mail, documents and notes.'), 'all');
  assert.equal(beyondDocsCue('Look in my email too'), 'mail');
  assert.equal(beyondDocsCue('Busca también en mi correo'), 'mail');
  assert.equal(beyondDocsCue('Cherche partout'), 'all');
  assert.equal(beyondDocsCue('Schau überall nach'), 'all');
  assert.equal(beyondDocsCue('Procura também no meu e-mail'), 'mail');
  assert.equal(beyondDocsCue('Cerca ovunque'), 'all');
  assert.equal(beyondDocsCue('When does my lease end?'), undefined);
  assert.equal(beyondDocsCue('Add it to my todo list'), undefined);
  assert.equal(beyondDocsCue('What does the mailman policy say?'), undefined);
});

test('"check everything, mail, documents and notes" through library ask reads the mail and the notes too', async () => {
  const s = space();
  const out = await s.ask('When is my lease renewal due? Check everything you have, mail, documents and notes.');
  // The documents answer is still there, first.
  assert.match(out, /^Found in their documents/);
  assert.match(out, /Apartment lease, page 4/);
  // And the mail was really searched and quoted, marked as other people's words.
  assert.ok(s.searched.length > 0, 'the mailbox was searched');
  assert.match(out, /Emails:\n\[\d+\] Lease renewal · Dan Landlord/);
  assert.match(out, /due December 1/);
  assert.match(out, /information only/i);
  assert.match(out, /Notes:\n\[\d+\] Apartment/);
  // Files are the library's own answer: not listed twice.
  assert.doesNotMatch(out, /^Files:/m);
});

test('naming only the mail adds only the mail', async () => {
  const s = space();
  const out = await s.ask('When is the lease renewal due? Look in my email as well.');
  assert.match(out, /Emails:\n\[1\] Lease renewal/);
  assert.doesNotMatch(out, /^Notes:/m);
});

test('a plain question about their papers reads no mail', async () => {
  const s = space();
  const out = await s.ask('When does my lease renewal come due?');
  assert.match(out, /^Found in their documents/);
  assert.equal(s.searched.length, 0);
  assert.doesNotMatch(out, /Emails:/);
});

test('a private chat keeps the mail unread and says so', async () => {
  const s = space();
  const out = await s.ask('Check everything, my mail too: when is the lease renewal due?', { private: true });
  assert.equal(s.searched.length, 0);
  assert.doesNotMatch(out, /Emails:/);
  assert.match(out, /Not searched: .*emails \(Not in a private chat/);
  assert.match(out, /Notes:/, 'local sources still answer');
});

test('a child never has their mailbox searched this way', async () => {
  const s = space({ child: { band: '10-12', shopAllow: [] } });
  const out = await s.ask('Check everything, my mail too: when is the lease renewal due?');
  assert.equal(s.searched.length, 0);
  assert.doesNotMatch(out, /Emails:/);
});

test('off the record nothing more is searched', async () => {
  const s = space();
  (s.app as unknown as { offRecord: boolean }).offRecord = true;
  const out = await s.ask('Check everything, my mail too: when is the lease renewal due?');
  assert.equal(s.searched.length, 0);
  assert.doesNotMatch(out, /Emails:|Notes:/);
});

test('ask_everything set to ask first or never: library stays with the documents', async () => {
  for (const p of ['ask', 'never'] as const) {
    const s = space();
    s.app.settings.update({ toolPermissions: { ask_everything: p } });
    const out = await s.ask('Check everything, my mail too: when is the lease renewal due?');
    assert.equal(s.searched.length, 0, p);
    assert.doesNotMatch(out, /Emails:|Notes:/, p);
    assert.match(out, /^Found in their documents/);
  }
});

test('mail search set to ask first: the mail is left alone and she is pointed at mail_search', async () => {
  const s = space();
  s.app.tools.add({ spec: { name: 'mail_search', description: 'x', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'x', run: async () => 'x' });
  s.app.settings.update({ toolPermissions: { mail_search: 'ask' } });
  const out = await s.ask('Check everything, my mail too: when is the lease renewal due?');
  assert.equal(s.searched.length, 0);
  assert.doesNotMatch(out, /Emails:/);
  assert.match(out, /Notes:/);
  assert.match(out, /email was not searched from here .*mail_search/);
  // Only the mail named: just the pointer.
  const only = await s.ask('Look in my email: when is the lease renewal due?');
  assert.equal(s.searched.length, 0);
  assert.match(only, /email was not searched from here/);
  // With mail search allowed again it is read.
  s.app.settings.update({ toolPermissions: { mail_search: 'auto' } });
  assert.match(await s.ask('Look in my email: when is the lease renewal due?'), /Emails:\n\[1\] Lease renewal/);
});

test('other apps, group rooms and work channels get the documents only', async () => {
  const s = space();
  for (const channel of ['api', 'mcp', 'group', 'discord-work']) {
    const out = await s.ask('Check everything, my mail too: when is the lease renewal due?', { channel });
    assert.doesNotMatch(out, /Emails:|Notes:/, channel);
  }
  assert.equal(s.searched.length, 0);
});

test('the cue can also be in the query she passes', async () => {
  const s = space();
  const out = await s.ask('When is the lease renewal due?', { query: 'lease renewal due date in my email' });
  assert.match(out, /Emails:/);
});
