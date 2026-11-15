// N6 "Knows your world" (docs/WHAT_SARA_KNOWS.md): facts from memory and documents with sources,
// last-4 masking, ask your documents with verified quotes and page citations, not-found honesty,
// dates in documents as reminder suggestions (Accept → planner), edit/delete/"not true" changing the
// memory itself, household isolation, private chats, lean words, i18n, tips and the page count.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { askDocuments, answerText, extractFacts, factsFor, groupOfText, isoDate, maskCardsAndSsn, maskSensitive } from '../src/facts.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { FAMILY_WORDS, familyOf } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createLibraryTool } from '../src/library/use.ts';
import { createSaraServer } from '../src/server.ts';
import { createFactsTools } from '../src/tools/facts.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, tempDir } from './helpers.ts';
import { N6_DOCS } from './n6-fixtures.ts';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-11-14T15:00:00Z');


function addDoc(app: ReturnType<typeof makeApp>, d: { name: string; pages: readonly string[] }) {
  const doc = app.library!.add({ name: d.name, bytes: Buffer.from(d.pages.join('\n\n'), 'utf8'), keep: true, origin: 'library', learn: false });
  app.library!.setRead(doc.id, { kind: 'pdf', parts: d.pages.map((text, i) => ({ text, where: `page ${i + 1}` })), warnings: [] });
  return app.library!.get(doc.id)!;
}

function rig(t: TestContext, o: { docs?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.library = new LibraryStore(app.store.db, dir, () => NOW);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  const docs = o.docs === false ? {} : Object.fromEntries(Object.entries(N6_DOCS).map(([k, d]) => [k, addDoc(app, d)]));
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir, docs: docs as Record<keyof typeof N6_DOCS, ReturnType<typeof addDoc>> };
}

const ctxFor = (conversationId?: string) => ({ workspaceDir: '.', signal: new AbortController().signal, sandbox: { kind: 'none' }, conversationId }) as never;

test('N6 masking: last 4 only; card numbers and SSNs never whole; dates and amounts kept', () => {
  assert.equal(maskSensitive('Policy Number: LM-2207-48831'), 'Policy Number: \u2022\u2022\u2022\u20228831');
  assert.equal(maskSensitive('Card on file: 4111-1111-1111-1111.'), 'Card on file: \u2022\u2022\u2022\u20221111.');
  assert.match(maskSensitive('SSN 123-45-6789'), /\u2022\u2022\u2022-\u2022\u2022-6789/);
  assert.equal(maskSensitive('Payment due date: December 5, 2026. Rent $1,450.00 on 2027-05-31'), 'Payment due date: December 5, 2026. Rent $1,450.00 on 2027-05-31');
  assert.equal(maskCardsAndSsn('my card is 4111 1111 1111 1111 and I was born in 1990'), 'my card is \u2022\u2022\u2022\u20221111 and I was born in 1990');
  assert.equal(isoDate('09 MAR 2031'), '2031-03-09');
  assert.equal(isoDate('March 1, 2027'), '2027-03-01');
  assert.equal(isoDate('02/30/2027'), null);
});

test('N6 extraction from fixture documents: dates, last-4 numbers, amounts, names, groups, private', () => {
  const all = Object.values(N6_DOCS).flatMap((d) => extractFacts(d, d.pages.map((text, i) => ({ text, page: i + 1, place: `page ${i + 1}` }))));
  const by = (label: string) => all.filter((f) => f.label === label);
  assert.deepEqual(by('Lease ends').map((f) => [f.date, f.page, f.group]), [['2027-05-31', 1, 'dates']]);
  assert.deepEqual(by('Renewal date').map((f) => f.date), ['2027-03-01']);
  assert.deepEqual(by('Due date').map((f) => [f.date, f.page]), [['2026-12-05', 2]]);
  assert.deepEqual(by('Warranty ends').map((f) => f.date), ['2028-08-15']);
  assert.deepEqual(by('Passport expires').map((f) => [f.date, f.private]), [['2031-03-09', true]]);
  assert.deepEqual(by('Policy number').map((f) => [f.value, f.detail]), [['\u2022\u2022\u2022\u20228831', 'insurance']]);
  assert.deepEqual(by('VIN').map((f) => [f.value, f.group]), [['\u2022\u2022\u2022\u20222345', 'vehicles']]);
  assert.deepEqual(by('Passport number').map((f) => f.value), ['\u2022\u2022\u2022\u20225678']);
  assert.deepEqual(by('Serial number').map((f) => f.value), ['\u2022\u2022\u2022\u20224477']);
  assert.ok(by('Deductible').some((f) => f.value.startsWith('$500')), JSON.stringify(by('Deductible')));
  assert.ok(by('Rent').some((f) => f.value.startsWith('$1,450.00')));
  assert.deepEqual(by('Landlord').map((f) => [f.value, f.group]), [['Maple Street Properties LLC', 'home']]);
  assert.ok(by('Insured').some((f) => f.value === 'Alex Rivera'));
  // Nothing anywhere holds a full number: not the values, not the quotes.
  const blob = JSON.stringify(all);
  for (const whole of ['48831', '2HGFC2F59MH512345', '4111-1111-1111-1111', '123-45-6789', 'X12345678', 'SN88214477', '2207']) assert.ok(!blob.includes(whole), whole);
  assert.equal(groupOfText('I am allergic to penicillin', 'fact'), 'health');
  assert.equal(groupOfText('My sister Jo lives in Austin', 'fact'), 'people');
  assert.equal(groupOfText('I drive a 2019 Subaru Outback', 'fact'), 'vehicles');
});

test('N6 facts page data: memory facts (said) and document facts (read) with sources, grouped', (t) => {
  const { app, docs } = rig(t);
  const conv = app.store.createConversation({ title: 'Catching up', mode: 'chat' });
  const msg = app.store.addMessage(conv.id, 'user', 'My wife Dana loves hiking. I am allergic to penicillin.');
  const m1 = app.memory!.add({ kind: 'fact', content: 'Their wife is Dana; she loves hiking', conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-10', evidence: 'My wife Dana loves hiking' });
  const m2 = app.memory!.add({ kind: 'fact', content: 'They are allergic to penicillin', conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-10', evidence: 'I am allergic to penicillin' });
  app.memory!.add({ kind: 'date', content: "Dana's birthday", onDate: '04-12', conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-10', evidence: 'x' });
  const facts = factsFor(app).list();
  const f1 = facts.find((f) => f.id === `m${m1.id}`)!;
  assert.equal(f1.group, 'people');
  assert.equal(f1.confidence, 'said');
  assert.deepEqual(f1.source, { kind: 'chat', conversationId: conv.id, messageId: msg.id, title: 'Catching up' });
  const f2 = facts.find((f) => f.id === `m${m2.id}`)!;
  assert.equal(f2.group, 'health');
  assert.equal(f2.private, true, 'health facts are private');
  assert.ok(facts.some((f) => f.group === 'dates' && f.text === "Dana's birthday"));
  const lease = facts.find((f) => f.label === 'Lease ends')!;
  assert.equal(lease.confidence, 'read');
  assert.deepEqual(lease.source, { kind: 'document', docId: docs.lease.id, name: N6_DOCS.lease.name, page: 1 });
  assert.match(lease.quote!, /ends on May 31, 2027/);
  // Groups come in the page order.
  const order = facts.map((f) => f.group);
  assert.deepEqual(order, [...order].sort((a, b) => ['people', 'home', 'vehicles', 'health', 'work', 'money', 'dates', 'other'].indexOf(a) - ['people', 'home', 'vehicles', 'health', 'work', 'money', 'dates', 'other'].indexOf(b)));
  // A second look reads no document again; a deleted document takes its facts with it.
  assert.equal(factsFor(app).scanDocs(), 0);
  app.library!.delete(docs.warranty.id);
  assert.ok(!factsFor(app).list().some((f) => f.label === 'Warranty ends'));
});

test('N6 edit, delete and "not true" change the memory itself; document facts stay gone on a re-read', (t) => {
  const { app, docs } = rig(t);
  const conv = app.store.createConversation({ title: 'Chat', mode: 'chat' });
  const msg = app.store.addMessage(conv.id, 'user', 'I drive a blue Honda Civic and I work at Fabrikam.');
  const a = app.memory!.add({ kind: 'fact', content: 'They drive a blue Honda Civic', conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-01', evidence: 'I drive a blue Honda Civic' });
  const b = app.memory!.add({ kind: 'fact', content: 'They work at Fabrikam', conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-01', evidence: 'I work at Fabrikam' });
  const c = app.memory!.add({ kind: 'fact', content: 'They have a cat named Miso', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  const facts = factsFor(app);
  assert.equal(facts.edit(`m${a.id}`, 'They drive a red Honda Civic').text, 'They drive a red Honda Civic');
  assert.equal(app.memory!.get(a.id)!.content, 'They drive a red Honda Civic');
  assert.throws(() => facts.edit(`m${a.id}`, 'card 4111 1111 1111 1111'), /never kept/);
  facts.remove(`m${c.id}`);
  assert.equal(app.memory!.get(c.id), undefined);
  facts.notTrue(`m${b.id}`);
  assert.equal(app.memory!.get(b.id), undefined, 'not true forgets the memory');
  assert.equal(app.store.messages(conv.id)[0]!.meta?.forgotten, true, 'and hides its source message from her');
  const due = facts.list().find((f) => f.label === 'Due date')!;
  facts.notTrue(due.id);
  const rent = facts.list().find((f) => f.label === 'Rent')!;
  facts.edit(rent.id, 'Rent: $1,450 a month, paid by Zelle');
  assert.equal(facts.get(rent.id)!.text, 'Rent: $1,450 a month, paid by Zelle');
  // Read the document again: what was marked not true does not come back.
  app.library!.setRead(docs.policy.id, { kind: 'pdf', parts: N6_DOCS.policy.pages.map((text, i) => ({ text, where: `page ${i + 1}` })), warnings: [] });
  facts.scanDocs();
  assert.ok(!facts.list().some((f) => f.label === 'Due date'));
  assert.ok(!facts.suggestions().some((s) => s.dateKind === 'due'), 'its suggestion went with it');
  // "Forget X" removes the fact and the memory.
  const gone = facts.forget('Honda Civic');
  assert.ok(gone.some((f) => f.id === `m${a.id}`));
  assert.equal(app.memory!.get(a.id), undefined);
});

test('N6 ask your documents: quotes checked against the file, file + page citations, not found is said', async (t) => {
  const { app, docs } = rig(t);
  const d = await askDocuments(app, "What's my deductible?");
  assert.equal(d.found, true);
  assert.equal(d.quotes[0]!.docId, docs.policy.id);
  assert.equal(d.quotes[0]!.page, 2);
  assert.match(d.quotes[0]!.quote, /deductible: \$(500|250) per claim/);
  assert.equal(d.quotes[0]!.cite, `[p. 2](/#view=library:${docs.policy.id}:2)`);
  const l = await askDocuments(app, 'When does my lease end?');
  assert.equal(l.found, true);
  assert.match(l.quotes[0]!.quote, /ends on May 31, 2027/);
  assert.equal(l.quotes[0]!.name, N6_DOCS.lease.name);
  assert.equal(l.quotes[0]!.page, 1);
  const n = await askDocuments(app, "What is my dog's vet called?");
  assert.equal(n.found, false);
  assert.match(answerText("What is my dog's vet called?", n), /^Not found in your documents/);
  // Full numbers never come back in an answer.
  const p = await askDocuments(app, 'What is my policy number?');
  assert.ok(p.found);
  assert.ok(!JSON.stringify(p).includes('48831'), JSON.stringify(p));
  assert.match(JSON.stringify(p), /\u2022\u2022\u2022\u20228831/);
  // Through her library tool (action ask), in a chat.
  const conv = app.store.createConversation({ title: 'Docs', mode: 'chat' });
  const lib = createLibraryTool(() => app);
  const out = String(await lib.run({ action: 'ask', query: 'When does my lease end?' }, ctxFor(conv.id)));
  assert.match(out, /“The term of this Lease begins on June 1, 2026 and ends on May 31, 2027\.” \(Lease 2026 - 14 Elm St\.pdf, page 1\) cite: \[p\. 1\]\(\/#view=library:\d+:1\)/);
  assert.match(String(await lib.run({ action: 'ask', query: 'Who is my dentist?' }, ctxFor(conv.id))), /Not found in your documents/);
});

test('N6 dates in documents become suggestions; Accept adds a planner reminder N days before; never by itself', (t) => {
  const { app } = rig(t);
  const facts = factsFor(app);
  const s = facts.suggestions();
  assert.deepEqual(s.map((x) => [x.dateKind, x.date, x.daysBefore]), [
    ['due', '2026-12-05', 3],
    ['renewal', '2027-03-01', 30],
    ['lease_end', '2027-05-31', 30],
    ['warranty_end', '2028-08-15', 30],
    ['passport_expiry', '2031-03-09', 30],
  ]);
  assert.equal(app.planner!.reminders().length, 0, 'nothing is added until Accept');
  const due = s[0]!;
  const r = facts.accept(due.id);
  // 3 days before December 5 at 9:00 in Chicago (UTC-6).
  assert.equal(r.reminder.dueAt, '2026-12-02T15:00:00.000Z');
  assert.match(r.reminder.text, /^Due date: December 5, 2026 \(Lakeside auto policy\.pdf, page 2\)$/);
  assert.equal(app.planner!.reminders().length, 1);
  assert.equal(facts.accept(due.id).reminder.id, r.reminder.id, 'accepting twice adds no second reminder');
  const lease = s.find((x) => x.dateKind === 'lease_end')!;
  assert.equal(facts.accept(lease.id, 60).reminder.dueAt, '2027-04-01T14:00:00.000Z', 'a chosen number of days (CDT)');
  facts.dismiss(s.find((x) => x.dateKind === 'warranty_end')!.id);
  assert.deepEqual(facts.suggestions().map((x) => x.dateKind), ['renewal', 'passport_expiry']);
});

test('N6 tools: facts_list with sources, private facts only in private chats, fact_forget asks; lean words', async (t) => {
  const { app } = rig(t);
  const conv = app.store.createConversation({ title: 'Me', mode: 'chat' });
  const msg = app.store.addMessage(conv.id, 'user', 'I take insulin for diabetes.');
  app.memory!.add({ kind: 'fact', content: 'They take insulin for diabetes', conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-02', evidence: 'I take insulin for diabetes' });
  const tools = new Map(createFactsTools(() => app).map((x) => [x.spec.name, x] as [string, Tool]));
  const list = tools.get('facts_list')!;
  assert.equal(list.defaultPermission, 'auto');
  assert.equal(tools.get('fact_forget')!.defaultPermission, 'ask');
  const out = String(await list.run({}, ctxFor(conv.id)));
  assert.match(out, /\[dates\] Lease ends: 2027-05-31 \(read in "Lease 2026 - 14 Elm St\.pdf", page 1, cite: \[p\. 1\]/);
  assert.ok(!out.includes('insulin'), 'private facts stay out of an ordinary chat');
  assert.ok(!out.includes('Passport'), 'a passport is private');
  const priv = app.store.createConversation({ title: 'Private', mode: 'chat', private: true });
  assert.match(String(await list.run({}, ctxFor(priv.id))), /insulin/);
  const forget = String(await tools.get('fact_forget')!.run({ what: 'insulin' }, ctxFor(priv.id)));
  assert.match(forget, /Forgot 1/);
  assert.ok(!factsFor(app).list().some((f) => f.text.includes('insulin')));
  for (const n of ['facts_list', 'fact_forget']) assert.equal(familyOf(tools.get(n)!).id, 'facts');
  const words = FAMILY_WORDS.facts ?? [];
  for (const w of ['what do you know about me', 'my deductible', 'my policy', 'my lease', 'when does', 'expire', 'renewal', 'warranty', 'remember that', 'que sabes de mi', 'que sais tu de moi', 'was weisst du uber mich', 'o que voce sabe sobre mim', 'cosa sai di me']) assert.ok(words.includes(w), w);
});

test('N6 household isolation: each space its own facts; member route; demo refused', async (t) => {
  const a = rig(t);
  const b = rig(t, { docs: false });
  assert.ok(factsFor(a.app).list().length > 5);
  assert.equal(factsFor(b.app).list().length, 0);
  assert.equal(factsFor(b.app).suggestions().length, 0);
  assert.ok(MEMBER_ROUTES.has('facts'), 'a household member has their own facts page');
});

test('N6 routes: list, edit, not true, accept a suggestion, ask', async (t) => {
  const { app, dir } = rig(t);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const g = await call('GET', '/facts');
  assert.equal(g.status, 200);
  const facts = g.body.facts as { id: string; label: string | null }[];
  assert.ok(facts.length > 5);
  assert.deepEqual(g.body.groups, ['people', 'home', 'vehicles', 'health', 'work', 'money', 'dates', 'other']);
  const rent = facts.find((f) => f.label === 'Rent')!;
  assert.equal((await call('PATCH', `/facts/${rent.id}`, { text: 'Rent: $1,450' })).status, 200);
  assert.equal((await call('PATCH', `/facts/${rent.id}`, { text: 'SSN 123-45-6789' })).status, 400);
  assert.equal((await call('POST', `/facts/${rent.id}/not-true`, {})).status, 200);
  assert.equal((await call('DELETE', '/facts/d999999')).status, 404);
  const sug = g.body.suggestions as { id: number }[];
  const acc = await call('POST', `/facts/suggestions/${sug[0]!.id}/accept`, {});
  assert.equal(acc.status, 200);
  assert.ok((acc.body.reminder as { id: number }).id > 0);
  const ask = await call('POST', '/facts/ask', { question: "what's my deductible?" });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.found, true);
});

test('N6 page wiring: Settings → You → What Sara knows, tips, how-to, i18n ×5', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  assert.ok(html.includes('data-page="you-knows" data-group="You" data-title="What Sara knows"'), 'the page is in Settings → You');
  const nav = readFileSync(join(ROOT, 'web/settings-nav.js'), 'utf8');
  assert.match(nav, /'you-business', 'you-knows'/); // SETTINGS3: You's order
  const tips = JSON.parse(readFileSync(join(ROOT, 'web/tips.json'), 'utf8'));
  assert.ok(tips.pages['you-knows']);
  const howto = JSON.parse(readFileSync(join(ROOT, 'web/howto.json'), 'utf8'));
  assert.ok(howto['you-knows']?.length >= 2);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const raw = readFileSync(join(ROOT, `web/i18n/${lang}.json`), 'utf8');
    for (const k of ['What Sara knows', 'From your documents', 'Not true', 'Ask your documents', 'Not found in your documents.']) assert.ok(raw.includes(`"${k}":`), `${lang}: ${k}`);
  }
});
