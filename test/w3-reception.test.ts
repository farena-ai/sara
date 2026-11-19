// W3.5 (docs/RECEPTION.md "Version 2", docs/design/W3RECEPTION.md): receptionist version 2, on top of
// the V3.5 website receptionist. Visitors are answered in THEIR language (read from the question, six
// languages), get the payment links the owner pasted (never a payment), a visitor who leaves an email
// gets a follow-up DRAFT that waits for the owner's OK, and the owner's corrections become approved
// answers used next time. Fake model, fake mail, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { bizStore } from '../src/biz/store.ts';
import { tr } from '../src/i18n.ts';
import { LibraryStore } from '../src/library/store.ts';
import { cleanPayLinks, contactOf, matchApproved, receptionFor, replyLang, topicOf } from '../src/reception.ts';
import { createSaraServer } from '../src/server.ts';
import { bookingFor } from '../src/workapps/booking.ts';
import { makeApp, tempDir, text, ROOT } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('W3.5 language: read from the question in six languages; short or unclear text keeps the browser language', () => {
  assert.equal(replyLang('¿Cuánto cuesta limpiar las canaletas de una casa?', 'en'), 'es');
  assert.equal(replyLang('Combien coûte le nettoyage des gouttières pour une maison ?', 'en'), 'fr');
  assert.equal(replyLang('Wie viel kostet die Reinigung der Dachrinne für ein Haus?', 'en'), 'de');
  assert.equal(replyLang('Quanto custa a limpeza das calhas para uma casa?', 'en'), 'pt-BR');
  assert.equal(replyLang('Quanto costa la pulizia delle grondaie per una casa?', 'en'), 'it');
  assert.equal(replyLang('How much is gutter cleaning for a house?', 'de'), 'en');
  assert.equal(replyLang('Hi', 'fr'), 'fr', 'too short to tell: the browser language');
  assert.equal(replyLang('ok', 'es', ['¿Trabajan ustedes los sábados por la mañana?']), 'es', 'earlier visitor lines count');
});

test('W3.5 payment links: https only, labelled, capped; payment words in six languages', () => {
  const links = cleanPayLinks('Deposit https://pay.example/deposit\nhttps://pay.example/full\njavascript:alert(1)\nCheap http://pay.example/x');
  assert.deepEqual(links, [
    { label: 'Deposit', url: 'https://pay.example/deposit' },
    { label: 'pay.example', url: 'https://pay.example/full' },
  ]);
  assert.equal(cleanPayLinks(Array.from({ length: 30 }, (_, i) => ({ label: `L${i}`, url: `https://pay.example/${i}` }))).length, 10);
  const facts = 'Bright Gutters gutter cleaning';
  for (const q of ['How can I pay the deposit?', '¿Cómo puedo pagar?', 'Comment payer la facture ?', 'Kann ich online bezahlen?', 'Como faço o pagamento?', 'Posso pagare con la carta?']) assert.equal(topicOf(q, 0, facts), 'pay', q);
});

test('W3.5 contact and approved answers: email found in text, close questions match, unrelated ones do not', () => {
  assert.deepEqual(contactOf('Please write me at Kim.V@example.com, my name is Kim'), { email: 'kim.v@example.com', name: 'Kim' });
  assert.deepEqual(contactOf('Me llamo Ana, mi correo es ana@example.org'), { email: 'ana@example.org', name: 'Ana' });
  assert.equal(contactOf('no address here @ all'), undefined);
  const approved = [{ id: 1, at: '', question: 'How much is gutter cleaning for my house?', answer: 'It is 140 dollars.', lang: 'en', uses: 0 }];
  assert.equal(matchApproved('how much does gutter cleaning cost for a house', approved)?.id, 1);
  assert.equal(matchApproved('Do you clean windows?', approved), undefined);
});

function world() {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date() };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC' } as never);
  const lib = new LibraryStore(app.store.db, dir, () => clock.now);
  app.library = lib as never;
  const faq = lib.importDoc({ name: 'faq.txt', passages: [{ place: 'p1', heading: 'Prices', text: 'Gutter cleaning costs 120 dollars for a one-story house. We work in Springfield.' }, { place: 'p2', heading: 'Precios', text: 'La limpieza de canaletas cuesta 120 dólares para una casa de una planta.' }] });
  bizStore(app).saveDetails({ name: 'Bright Gutters', email: 'hello@bright.example' });
  return { dir, cleanup, clock, app, lib, faq };
}

test('W3.5 acceptance: language, payment links, follow-up after OK, corrections used next time', async () => {
  const w = world();
  const mails: { to: string; subject: string; body: string }[] = [];
  const notices: string[] = [];
  bookingFor(w.app).setDeps({ busy: async () => [], sendMail: async (m) => (mails.push(m), 'sent'), notify: async (title) => void notices.push(title) });
  receptionFor(w.app).notify = async (title) => void notices.push(title);
  const auth = new OwnerAuth(w.dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app: w.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = (path: string, init: RequestInit = {}) => fetch(`${origin}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  type View = { settings: { id: string; payLinks: { label: string; url: string }[] }; chats: { chat: string; lang: string; turns: { id: number; question: string; reply: string; kind: string; fixed: boolean }[] }[]; approved: { id: number; question: string; answer: string }[]; followups: { id: number; email: string; subject: string; body: string; status: string; lang: string }[] };
  try {
    let r = await owner('/booking/reception', { method: 'PUT', body: JSON.stringify({ on: true, docs: [w.faq], payLinks: 'Deposit https://pay.example/deposit\nPay in full https://pay.example/full' }) });
    assert.equal(r.status, 200);
    let view = (await r.json()) as View;
    assert.deepEqual(view.settings.payLinks.map((l) => l.label), ['Deposit', 'Pay in full']);
    const id = view.settings.id;
    const html = await (await fetch(`${origin}/reception/${id}`, { headers: { 'accept-language': 'en-US' } })).text();
    const t = /data-t="([^"]+)"/.exec(html)![1];
    const ask = async (q: string, history: unknown[] = [], tok = t) => (await (await fetch(`${origin}/reception/${id}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'accept-language': 'en-US' }, body: JSON.stringify({ text: q, history, t: tok }) })).json()) as { reply: string; kind: string; lang: string; links?: { label: string; url: string }[] };

    // 1. Their language: a Spanish question on an English browser gets Spanish, in code and from the model.
    let a = await ask('¿Quién ganó la copa del mundo en 1998?');
    assert.equal(a.kind, 'off');
    assert.equal(a.lang, 'es');
    assert.equal(a.reply, tr('Sorry, I can only help with questions about {name}.', 'es', { name: 'Bright Gutters' }));
    assert.notEqual(a.reply, tr('Sorry, I can only help with questions about {name}.', 'en', { name: 'Bright Gutters' }), 'a real Spanish line');
    w.app.script.push(text('La limpieza cuesta 120 dólares.'));
    a = await ask('¿Cuánto cuesta la limpieza de canaletas para una casa?');
    assert.equal(a.kind, 'answer');
    assert.equal(a.lang, 'es');
    assert.match(JSON.stringify(w.app.requests.at(-1)!.messages), /in Spanish/, 'the model is told the visitor\'s language');

    // 2. Payment links: answered in code with the owner's links only; never a payment.
    const calls = w.app.requests.length;
    a = await ask('How can I pay the deposit?');
    assert.equal(a.kind, 'pay');
    assert.deepEqual(a.links, [{ label: 'Deposit', url: 'https://pay.example/deposit' }, { label: 'Pay in full', url: 'https://pay.example/full' }]);
    assert.equal(w.app.requests.length, calls, 'no model call for payment questions');
    assert.match(a.reply, /never see|card/i);

    // 3. Contact info: a follow-up DRAFT that waits for the OK; the address never reaches the model.
    w.app.script.push(text('Subject: Your gutter cleaning question\n\nHi Kim,\n\nThanks for asking about gutter cleaning. It costs 120 dollars for a one-story house.'));
    a = await ask('My name is Kim, please email me at kim@example.com', [{ role: 'visitor', text: 'How much is gutter cleaning?' }, { role: 'reply', text: 'It costs 120 dollars.' }]);
    assert.equal(a.kind, 'contact');
    assert.match(a.reply, /kim@example\.com/);
    assert.equal(mails.length, 0, 'nothing is sent before the owner says OK');
    assert.ok(notices.some((n) => /follow-up/i.test(n)), 'the owner gets a notice');
    assert.doesNotMatch(JSON.stringify(w.app.requests.at(-1)!.messages), /kim@example\.com/, 'the visitor\'s address is not sent to the model');
    view = (await (await owner('/booking/reception')).json()) as View;
    const f = view.followups.find((x) => x.status === 'pending')!;
    assert.equal(f.email, 'kim@example.com');
    assert.equal(f.subject, 'Your gutter cleaning question');
    assert.match(f.body, /120 dollars/);
    r = await owner(`/booking/reception/followups/${f.id}/send`, { method: 'POST', body: JSON.stringify({ subject: f.subject, body: `${f.body}\n\nAlex (edited)` }) });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'kim@example.com');
    assert.match(mails[0].body, /\(edited\)/, 'the owner\'s edits are what is sent');
    r = await owner(`/booking/reception/followups/${f.id}/send`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 409, 'sent once');
    assert.equal(mails.length, 1);
    // A second visitor whose draft the owner dismisses (model down: a plain draft in their language).
    const t2 = /data-t="([^"]+)"/.exec(await (await fetch(`${origin}/reception/${id}`)).text())![1];
    a = await ask('Me llamo Ana, escríbeme a ana@example.org por favor', [], t2);
    assert.equal(a.kind, 'contact');
    view = (await (await owner('/booking/reception')).json()) as View;
    const g = view.followups.find((x) => x.email === 'ana@example.org')!;
    assert.equal(g.lang, 'es');
    assert.ok(g.body.includes('Ana'), 'the plain draft greets the visitor');
    r = await owner(`/booking/reception/followups/${g.id}/dismiss`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1, 'a dismissed draft is never sent');

    // 4. Conversations grouped per visitor; the owner corrects an answer.
    view = (await (await owner('/booking/reception')).json()) as View;
    assert.ok(view.chats.length >= 2, 'one conversation per visitor page');
    const turn = view.chats.flatMap((c) => c.turns).find((x) => x.kind === 'answer')!;
    assert.match(turn.reply, /120/);
    r = await owner('/booking/reception/correct', { method: 'POST', body: JSON.stringify({ log: turn.id, question: 'How much is gutter cleaning for my house?', answer: 'Gutter cleaning is 140 dollars now.' }) });
    assert.equal(r.status, 200);
    view = (await r.json()) as View;
    assert.equal(view.approved.length, 1);
    assert.ok(view.chats.flatMap((c) => c.turns).find((x) => x.id === turn.id)!.fixed, 'the turn shows it was corrected');
    // Next time: the approved answer, no model call.
    const before = w.app.requests.length;
    a = await ask('How much does gutter cleaning cost for my house?');
    assert.equal(a.kind, 'approved');
    assert.equal(a.reply, 'Gutter cleaning is 140 dollars now.');
    assert.equal(w.app.requests.length, before, 'the approved answer needs no model');
    // In another language: the model gets the approved answer to translate.
    w.app.script.push(text('Cuesta 140 dólares.'));
    a = await ask('¿Cuánto cuesta la limpieza de canaletas para mi casa?');
    assert.equal(a.kind, 'answer');
    assert.match(JSON.stringify(w.app.requests.at(-1)!.messages), /140 dollars now/, 'approved answers reach the model');
    // Delete it.
    r = await owner(`/booking/reception/approved/${view.approved[0].id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as View).approved.length, 0);
    // Bad input.
    assert.equal((await owner('/booking/reception/correct', { method: 'POST', body: JSON.stringify({ log: 999999, answer: 'x' }) })).status, 404);
    assert.equal((await owner('/booking/reception/correct', { method: 'POST', body: JSON.stringify({ log: turn.id, answer: '  ' }) })).status, 400);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    w.app.store.close();
    w.cleanup();
  }
});

test('W3.5 web: chat page draws links as text with https only; owner section shows conversations, follow-ups and approved answers', () => {
  const chat = read('web/reception-chat.js');
  assert.match(chat, /links/);
  assert.match(chat, /\^https:/, 'only https links are drawn');
  assert.doesNotMatch(chat, /innerHTML/);
  const html = read('web/index.html');
  const page = html.slice(html.indexOf('data-page="you-business"'), html.indexOf('data-page="you-details"'));
  assert.match(page, /<h3>Receptionist conversations <button type="button" class="tip"/);
  assert.match(page, /id="rcv-box"/);
  const js = read('web/receptionist.js');
  for (const w of ['/booking/reception/correct', '/booking/reception/followups/', '/booking/reception/approved/', 'rc-pay']) assert.ok(js.includes(w), w);
  assert.ok(read('docs/RECEPTION.md').includes('Version 2'));
  assert.ok(read('docs/design/W3RECEPTION.md').includes('receptionist'));
});
