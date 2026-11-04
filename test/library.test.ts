// Phase 44: her library. Passages, who can see what (kept vs read once, never partner chats),
// search by words and by meaning, learning key facts with the exact-words rule, the turn, the API.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { LibraryStore, toPassages } from '../src/library/store.ts';
import { learnOne, learnWindows, loose, parseLearned, readOne } from '../src/library/worker.ts';
import { createLibraryTool, librarySection } from '../src/library/use.ts';
import { docsNote, readOnceAsked } from '../src/library/intake.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { createSaraServer } from '../src/server.ts';
import { OwnerAuth } from '../src/auth.ts';
import { exportAll, importAll } from '../src/export.ts';
import { listen, makeApp, readBody, ROOT, tempDir, text } from './helpers.ts';

const LEASE = [
  { where: 'page 1', text: 'RESIDENTIAL LEASE AGREEMENT\n\nThis lease is between Pine Property LLC (landlord) and Frank Arena (tenant) for the apartment at 14 Elm Street, Unit 3B.' },
  { where: 'page 2', text: 'The term of this lease begins on April 1, 2026 and ends on March 31, 2027. Monthly rent is $1,450, due on the first day of each month.\n\nA late fee of $75 applies after the fifth day of the month.' },
  { where: 'page 3', text: 'Pets: one cat or one small dog is allowed with a $300 deposit. The tenant must give 60 days written notice before moving out.' },
];

const setup = (t: { after: (fn: () => void) => void }) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-26T18:00:00Z') };
  const app = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.tools.add(createLibraryTool(() => app));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString() });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir, lib: app.library };
};

const addRead = (lib: LibraryStore, name: string, parts: { where: string; text: string }[], o: { keep?: boolean; conversationId?: string | null } = {}) => {
  const d = lib.add({ name, bytes: Buffer.from(parts.map((p) => p.text).join('\n') + name), keep: o.keep ?? true, conversationId: o.conversationId ?? null });
  return lib.setRead(d.id, { kind: 'pdf', parts, warnings: [] })!;
};

test('library: passages keep their page, split long text on sentence and paragraph ends, and overlap a little', () => {
  const ps = toPassages(LEASE);
  assert.deepEqual(
    ps.map((p) => p.place),
    ['page 1', 'page 2', 'page 3'],
  );
  assert.match(ps[1].text, /March 31, 2027/);
  const long = toPassages([{ where: 'page 9', text: Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about the boiler and its yearly service.`).join(' ') }], 400, 80);
  assert.ok(long.length > 3, 'split into several passages');
  assert.ok(long.every((p) => p.text.length <= 480 && p.place === 'page 9'));
  // The end of one passage starts the next (a fact on the boundary is found from either side).
  assert.ok(long[1].text.startsWith(long[0].text.slice(-80).replace(/^\S*\s/, '')));
  const md = toPassages([{ where: '', text: '# Setup\n\nPlug it in.\n\n# Cleaning\n\nRinse the filter monthly.' }]);
  assert.deepEqual(md.map((p) => p.heading), ['Setup', 'Cleaning']);
});

test('library: kept documents are found everywhere, read-once only in their chat; search by words', (t) => {
  const { app, lib } = setup(t);
  const a = app.store.createConversation({ title: 'A' });
  const b = app.store.createConversation({ title: 'B' });
  addRead(lib, 'lease.pdf', LEASE);
  addRead(lib, 'menu.pdf', [{ where: 'page 1', text: 'Margherita pizza with basil, eleven dollars.' }], { keep: false, conversationId: a.id });
  assert.equal(lib.searchWords('when does the lease end')[0].passage.place, 'page 2');
  assert.equal(lib.searchWords('margherita basil').length, 0, 'read-once is not in the library');
  assert.equal(lib.searchWords('margherita basil', { conversationId: a.id }).length, 1);
  assert.equal(lib.searchWords('margherita basil', { conversationId: b.id }).length, 0);
  assert.equal(lib.list().length, 1);
  assert.equal(lib.list({ conversationId: a.id }).length, 1);
  // The same file twice is kept once.
  const again = lib.findKept(Buffer.from(LEASE.map((p) => p.text).join('\n') + 'lease.pdf'));
  assert.ok(again);
  // Deleting the chat removes what was read once in it, and its file.
  assert.equal(lib.deleteForConversation(a.id), 1);
  assert.equal(lib.list({ conversationId: a.id }).length, 0);
  assert.equal(readdirSync(lib.dir).length, 1);
});

test('library: meaning search finds passages said in other words and merges with word search', async (t) => {
  const { app, lib } = setup(t);
  addRead(lib, 'lease.pdf', LEASE);
  // A tiny embedding server: words map to topics, so "move out" ~ "notice", "animals" ~ "pets".
  const TOPICS: [RegExp, number][] = [[/pet|cat|dog|animal/i, 0], [/rent|\$|pay|late fee|money/i, 1], [/notice|move|leav/i, 2], [/term|begin|end|expire|date/i, 3]];
  const vec = (s: string): number[] => [...TOPICS.map(([re]): number => (re.test(s) ? 1 : 0)), 0.05];
  const srv = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { input: string[] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map((s, index) => ({ index, embedding: vec(s) })) }));
  });
  t.after(() => srv.server.close());
  app.settings.update({ providers: [...app.settings.get().providers, { id: 'emb', label: 'E', kind: 'openai-compatible', baseUrl: srv.url }], routes: { embeddings: { providerId: 'emb', model: 'nomic-embed-text' } } });
  const target = { config: app.settings.get().providers.find((p) => p.id === 'emb')!, model: 'nomic-embed-text' };
  assert.equal(await lib.indexVectors(target), 3);
  assert.equal(await lib.indexVectors(target), 0, 'nothing left to do');
  const hits = await lib.find('can I have animals here?', { target });
  assert.equal(hits[0].passage.place, 'page 3', 'found by meaning (no shared words)');
  assert.equal(hits[0].by, 'meaning');
  const both = await lib.find('the cat deposit', { target });
  assert.equal(both[0].by, 'both');
});

test('library: learning writes key facts with the source, and drops notes whose words are not in the document', async (t) => {
  const { app, lib } = setup(t);
  const d = addRead(lib, 'lease.pdf', LEASE);
  app.script.push(
    text(
      JSON.stringify({
        about: 'A 12-month apartment lease for 14 Elm Street, April 2026 to March 2027.',
        notes: [
          { note: "Alex's lease at 14 Elm Street ends on March 31, 2027.", quote: 'ends on March 31, 2027' },
          { note: 'Rent is $1,450 a month, due on the first.', quote: 'Monthly rent is $1,450, due on the first day of each month' },
          { note: 'The landlord allows parrots.', quote: 'parrots are welcome in every unit' },
        ],
      }),
    ),
  );
  const n = await learnOne(app, lib, lib.get(d.id)!);
  assert.equal(n, 2, 'the made-up note is dropped');
  const facts = app.memory!.fromDoc(d.id);
  assert.deepEqual(facts.map((f) => f.evidence), ['ends on March 31, 2027', 'Monthly rent is $1,450, due on the first day of each month']);
  assert.equal(facts[0].kind, 'fact');
  const after = lib.get(d.id)!;
  assert.equal(after.learn, 'done');
  assert.equal(after.facts, 2);
  assert.match(after.summary ?? '', /12-month apartment lease/);
  // The prompt named the document and asked for exact words.
  assert.match(String(app.requests.at(-1)!.messages[1].content), /lease\.pdf[\s\S]*copied exactly/);
  assert.equal(parseLearned('no json here'), null);
  assert.equal(loose('“Ends”   on\nMarch'), '"ends" on march');
  assert.equal(learnWindows('x'.repeat(50_000)).length, 6);
});

test('library: her turn has a "Your library" section with the passage and where it came from; never in partner chats', async (t) => {
  const { app, lib } = setup(t);
  addRead(lib, 'lease.pdf', LEASE);
  const conv = app.store.createConversation({ title: 'Home' });
  app.script.push(text('It ends on March 31, 2027 (your lease, page 2).'));
  for await (const _ of runTurn(app, conv.id, 'When does my lease end?')) void _;
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /## Your library/);
  assert.match(sys, /lease\.pdf/);
  assert.match(sys, /\[lease\.pdf, page 2\][\s\S]*March 31, 2027/, 'the passage, with its source');
  assert.match(sys, /always say which document it came from/);
  const partner = app.store.createConversation({ title: 'Bob', partner: 'Bob' });
  assert.equal(await librarySection(app, partner, 'When does the lease end?'), undefined);
});

test('library: a small document shared once is given to her whole in that chat only', async (t) => {
  const { app, lib } = setup(t);
  const conv = app.store.createConversation({ title: 'Dinner' });
  const other = app.store.createConversation({ title: 'Other' });
  addRead(lib, 'menu.pdf', [{ where: 'page 1', text: 'Margherita pizza with basil, eleven dollars. Tiramisu, seven dollars.' }], { keep: false, conversationId: conv.id });
  const here = (await librarySection(app, conv, 'what should I get?'))!;
  assert.match(here, /Shared with you in this conversation[\s\S]*#### menu\.pdf[\s\S]*Tiramisu, seven dollars/);
  assert.equal(await librarySection(app, other, 'what should I get?'), undefined);
  assert.match(docsNote([{ id: 1, name: 'menu.pdf', keep: false }]), /"menu\.pdf" \(to read here, not kept\)/);
  assert.ok(readOnceAsked('just read this once please'));
  assert.ok(!readOnceAsked('here is my lease'));
});

test('library tool: search says where; read goes on from a page; partner chats get nothing', async (t) => {
  const { app, lib } = setup(t);
  addRead(lib, 'lease.pdf', LEASE);
  const tool = createLibraryTool(() => app);
  const conv = app.store.createConversation({ title: 'X' });
  const ctx = { conversationId: conv.id } as Parameters<typeof tool.run>[1];
  const found = String(await tool.run({ action: 'search', query: 'pets deposit' }, ctx));
  assert.match(found, /^\[lease\.pdf, page 3\]/);
  const read = String(await tool.run({ action: 'read', document: 'lease', place: 'page 2' }, ctx));
  assert.match(read, /\[page 2\][\s\S]*\[page 3\]/);
  assert.doesNotMatch(read, /RESIDENTIAL LEASE/);
  assert.match(String(await tool.run({ action: 'list' }, ctx)), /lease\.pdf/);
  assert.match(String(await tool.run({ action: 'search', query: 'swimming pool' }, ctx)), /Nothing about/);
  const partner = app.store.createConversation({ title: 'Bob', partner: 'Bob' });
  await assert.rejects(() => tool.run({ action: 'list' }, { conversationId: partner.id } as Parameters<typeof tool.run>[1]), /private/);
});

test('library API: upload, read in the background, open, search, keep a read-once file, remove and forget', async (t) => {
  const { app, lib } = setup(t);
  const owner = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth: owner, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: `Bearer ${owner.newToken}` };
  const notes = '# Boiler\n\nThe boiler service is due every October. The code for the side gate is 4471.\n\n# Bins\n\nRecycling goes out on Tuesday nights.';
  let r = await fetch(`${base}/api/library?name=${encodeURIComponent('house notes.md')}&keep=1`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: notes });
  assert.equal(r.status, 201);
  const doc = ((await r.json()) as { doc: { id: number; status: string } }).doc;
  assert.equal(doc.status, 'waiting');
  // A file she can't read is refused up front.
  r = await fetch(`${base}/api/library?name=x.exe`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) });
  assert.equal(r.status, 415);
  // The worker reads it (no model needed for a text file), then learns (scripted model).
  app.script.push(text(JSON.stringify({ about: 'House notes: boiler and bins.', notes: [{ note: 'The side gate code is 4471.', quote: 'The code for the side gate is 4471' }] })));
  await readOne(app, lib, lib.get(doc.id)!);
  await learnOne(app, lib, lib.get(doc.id)!);
  const one = (await (await fetch(`${base}/api/library/${doc.id}`, { headers: auth })).json()) as { doc: { status: string; passages: number; facts: number }; facts: { id: number; content: string }[]; passages: { place: string; heading: string }[] };
  assert.equal(one.doc.status, 'ready');
  assert.equal(one.facts[0].content, 'The side gate code is 4471.');
  assert.deepEqual(one.passages.map((p) => p.heading), ['Boiler', 'Bins']);
  const list = (await (await fetch(`${base}/api/library`, { headers: auth })).json()) as { docs: { id: number; sha?: string }[]; counts: { docs: number } };
  assert.equal(list.counts.docs, 1);
  assert.equal(list.docs[0].sha, undefined, 'internal hash not sent');
  const hits = (await (await fetch(`${base}/api/library/search?q=recycling`, { headers: auth })).json()) as { hits: { name: string; heading: string }[] };
  assert.equal(hits.hits[0].heading, 'Bins');
  const file = await fetch(`${base}/api/library/${doc.id}/file`, { headers: auth });
  assert.equal(await file.text(), notes);
  // Read once in a chat, then kept after all.
  const conv = app.store.createConversation({ title: 'C' });
  r = await fetch(`${base}/api/library?name=menu.txt&keep=0&conversation=${conv.id}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: 'Soup of the day: lentil.' });
  const once = ((await r.json()) as { doc: { id: number; keep: boolean } }).doc;
  assert.equal(once.keep, false);
  r = await fetch(`${base}/api/library/${once.id}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ keep: true }) });
  assert.equal(((await r.json()) as { doc: { keep: boolean; learn: string } }).doc.learn, 'waiting');
  // Remove and forget what she learned: only those notes; a chat message saying the same stays.
  const chat = app.store.createConversation({ title: 'Gate' });
  const said = app.store.addMessage(chat.id, 'user', 'The code for the side gate is 4471, remember?');
  r = await fetch(`${base}/api/library/${doc.id}?forget=1`, { method: 'DELETE', headers: auth });
  assert.equal(((await r.json()) as { forgotten: number }).forgotten, 1);
  assert.equal(app.memory!.fromDoc(doc.id).length, 0);
  assert.equal(lib.get(doc.id), undefined);
  assert.ok(!app.store.messages(chat.id).find((m) => m.id === said.id)?.meta?.forgotten, 'the chat message is not hidden');
  assert.ok(!existsSync(join(lib.dir, 'missing')));
});

test('library: export and import keep her documents (their text) and what she learned from them', (t) => {
  const a = setup(t);
  const d = addRead(a.lib, 'lease.pdf', LEASE);
  a.app.memory!.add({ kind: 'fact', content: 'The lease ends on March 31, 2027.', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-26', evidence: 'ends on March 31, 2027', sourceDocId: d.id });
  const file = JSON.parse(JSON.stringify(exportAll(a.app)));
  assert.equal(file.library.length, 1);
  const b = setup(t);
  const r = importAll(b.app, file);
  assert.equal(r.documents, 1);
  const [doc] = b.lib.list();
  assert.equal(doc.name, 'lease.pdf');
  assert.equal(doc.status, 'ready');
  assert.equal(b.lib.searchWords('late fee')[0].passage.place, 'page 2');
  assert.equal(b.app.memory!.fromDoc(doc.id).length, 1, 'the learned note still points at it');
  assert.match(b.lib.file(doc)!.toString('utf8'), /\[page 2\]\nThe term of this lease/);
  // Importing the same file again doesn't double it.
  assert.equal(importAll(b.app, file).documents, 0);
});

test('library: a note learned from a document names it in her memory, so she can say where it came from', async (t) => {
  const { app, lib } = setup(t);
  const d = addRead(lib, 'house notes.md', [{ where: '', text: 'The boiler is serviced every October by Mike from Warmth Heating (555-0199).' }]);
  app.memory!.add({ kind: 'fact', content: 'Mike from Warmth Heating (555-0199) services the boiler.', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-26', evidence: 'serviced every October by Mike', sourceDocId: d.id });
  const conv = app.store.createConversation({ title: 'X' });
  app.script.push(text('Mike from Warmth Heating, says your house notes.'));
  for await (const _ of runTurn(app, conv.id, 'who services the boiler?')) void _;
  assert.match(String(app.requests.at(-1)!.messages[0].content), /from the document "house notes\.md" in your library\) Mike from Warmth Heating/);
});

test('library on Telegram: a document from the owner goes to her library and she answers about it; strangers are told no', async (t) => {
  const { app, lib } = setup(t);
  const TOKEN = '123456789:test';
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const file = Buffer.from('# Car\n\nThe car insurance renews on 3 February 2027 with Acme Mutual, policy AC-55821.');
  const srv = await listen(async (req, res) => {
    if (req.url === `/file/bot${TOKEN}/documents/file_7.md`) return void res.end(file);
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getFile' ? { file_path: 'documents/file_7.md' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : method === 'sendMessage' ? { message_id: sent.length } : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  t.after(() => srv.server.close());
  app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: true, ownerChatId: 1001 } });
  app.vault.set(TELEGRAM_VAULT, TOKEN);
  // No background worker in tests: read right away when nudged.
  app.libraryNudge = () => void (async () => {
    for (const d of lib.waiting()) await readOne(app, lib, d);
  })();
  const bridge = new TelegramBridge(app, { apiBase: srv.url });
  await bridge.restart();
  t.after(() => bridge.stop());
  app.script.push(text('Got it, I keep it in my library. It renews on 3 February 2027.'));
  await bridge.handle({ update_id: 1, message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 1001, first_name: 'Alex' }, caption: 'my car insurance', document: { file_id: 'f7', file_name: 'car insurance.md', file_size: file.length } } });
  const [doc] = lib.list();
  assert.equal(doc.name, 'car insurance.md');
  assert.equal(doc.origin, 'telegram');
  assert.equal(doc.status, 'ready');
  const req = app.requests.at(-1)!;
  assert.match(String(req.messages.at(-1)!.content), /my car insurance \[Note from the app: the owner shared a document with this message: "car insurance\.md" \(kept in your library\)\.\]/);
  assert.match(String(req.messages[0].content), /car insurance\.md/);
  // "Just read this once" keeps it out of the library.
  await bridge.handle({ update_id: 2, message: { message_id: 2, chat: { id: 1001, type: 'private' }, from: { id: 1001, first_name: 'Alex' }, caption: 'just read this once', document: { file_id: 'f8', file_name: 'car copy.md', file_size: file.length } } });
  assert.equal(lib.list().length, 1);
  // Someone else's file is not taken.
  await bridge.handle({ update_id: 3, message: { message_id: 3, chat: { id: 555, type: 'private' }, from: { id: 555, first_name: 'Eve' }, document: { file_id: 'f9', file_name: 'x.md' } } });
  assert.equal(lib.list().length, 1);
});
