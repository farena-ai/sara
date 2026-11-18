// V2.1 Renewals and paperwork (docs/RENEWALS.md): one list built from the existing sources (dates in
// Library documents via src/facts.ts, renewal mail, the Money page's subscription renewals, rows the
// person adds), each date once; Remind me at the existing DAYS_BEFORE; a renewal errand; photo of a
// card = a Library photo read like any document; routes under /api/facts/renewals; web wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { templateFor, TEMPLATES } from '../src/errands.ts';
import { DAYS_BEFORE, extractFacts, factsFor } from '../src/facts.ts';
import type { InboxMail } from '../src/inbox/classify.ts';
import { LibraryStore } from '../src/library/store.ts';
import { observeMoneyMail } from '../src/money/hub.ts';
import { localDate } from '../src/memory-worker.ts';
import { mailTitle, renewalsOf, renewalAction, takeRenewalMail, whatOf } from '../src/renewals.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-11-18T15:00:00Z');
// Fake ids built at run time (never realistic-looking literals in the source).
const fakeId = (p: string, n: number) => `${p}${String(n).repeat(3)}${'0'.repeat(3)}${n}`;

function addDoc(app: ReturnType<typeof makeApp>, name: string, pages: string[], kind: 'pdf' | 'image' = 'pdf') {
  const doc = app.library!.add({ name, bytes: Buffer.from(pages.join('\n\n'), 'utf8'), keep: true, origin: 'library', learn: false });
  app.library!.setRead(doc.id, { kind, parts: pages.map((text, i) => ({ text, where: `page ${i + 1}` })), warnings: [] } as never);
  return app.library!.get(doc.id)!;
}

const mail = (id: string, from: string, subject: string, text: string): InboxMail => ({ account: 'alex@example.com', id, from, subject, date: NOW.toISOString(), text });

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.library = new LibraryStore(app.store.db, dir, () => NOW);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir };
}

const POLICY = () => ['Lakeside Mutual Auto Insurance Policy', `Policy Number: ${fakeId('LM-', 4)}`, 'Policy period: December 1, 2026 to June 1, 2027', 'Six-month premium: $612.00'].join('\n');
const REG_MAIL = () => mail('m1', 'State DMV <noreply@dmv.example>', 'Your vehicle registration renewal notice', `Your vehicle registration for plate ${fakeId('P', 7)} expires on February 28, 2027. Renew online or by mail before then.`);
const POLICY_MAIL = () => mail('m2', 'Lakeside Mutual <billing@lakeside.example>', 'Your auto policy renews soon', 'Your auto insurance policy will renew on June 1, 2027. No action is needed if your details are the same.');
const SUB_MAIL = () => mail('m3', 'StreamCo <billing@streamco.example>', 'Your StreamCo membership renews soon', 'Your StreamCo membership will renew on January 10, 2027 for $119.99 a year.');
const PROMO_MAIL = () => mail('m4', 'Shop <deals@shop.example>', 'Last chance', 'This offer expires on December 31, 2026. Shop now!');

test('V2.1 card photos: EXP on a license card is an expiry date (read like any document)', () => {
  const f = extractFacts({ name: 'IMG_2041.jpg' }, [{ text: `DRIVER LICENSE\nDL ${fakeId('D', 2)}\nEXP 03/14/2029\nISS 03/14/2021`, page: null, place: '' }]);
  const d = f.find((x) => x.dateKind);
  assert.equal(d?.date, '2029-03-14');
  assert.equal(d?.dateKind, 'license_expiry');
  assert.ok(!f.some((x) => x.date === '2021-03-14'), 'the issue date is not an expiry');
});

test('V2.1 one list: a Library doc and renewal mail show once each; promo mail and bills stay out', (t) => {
  const { app } = rig(t);
  addDoc(app, 'Auto policy.pdf', [POLICY()]);
  addDoc(app, 'Passport scan.pdf', ['United States of America PASSPORT', 'Date of expiry 09 MAR 2031']);
  addDoc(app, 'Electric bill.pdf', ['City Power. Amount due: $82.10. Payment due date: December 5, 2026.']);
  addDoc(app, 'Card photo.jpg', [`DRIVER LICENSE\nEXP 03/14/2029`], 'image');
  for (const m of [REG_MAIL(), POLICY_MAIL(), SUB_MAIL(), PROMO_MAIL()]) {
    const sub = observeMoneyMail(app, m);
    takeRenewalMail(app, m, sub);
  }
  // The same mail seen again changes nothing.
  takeRenewalMail(app, REG_MAIL(), false);
  const list = renewalsOf(app);
  const dates = list.map((r) => r.date);
  assert.equal(new Set(dates).size, dates.length, `each date once: ${dates.join(', ')}`);
  const by = (d: string) => list.find((r) => r.date === d)!;
  assert.equal(by('2027-06-01').what, 'insurance');
  assert.equal(by('2027-06-01').source.kind, 'document', 'the document wins; the mail is the same date');
  assert.equal(by('2027-06-01').alsoIn, 'mail');
  assert.equal(by('2031-03-09').what, 'passport');
  assert.equal(by('2029-03-14').what, 'license');
  assert.equal(by('2027-02-28').what, 'registration');
  assert.equal(by('2027-02-28').source.kind, 'mail');
  assert.equal(by('2027-01-10').what, 'subscription');
  assert.ok(!dates.includes('2026-12-05'), 'a bill due date is not a renewal');
  assert.ok(!dates.includes('2026-12-31'), 'a shop offer is not a renewal');
  assert.deepEqual(dates, [...dates].sort(), 'soonest first');
  assert.equal(whatOf('Vehicle registration renewal', ''), 'registration');
  assert.equal(by('2027-02-28').title, 'Vehicle registration renewal', 'a mail subject reads as a name');
  assert.equal(mailTitle('Re: Your auto policy renews soon'), 'Auto policy renews');
  assert.equal(whatOf('Warranty card', 'warranty ends'), 'warranty');
});

test('V2.1 Remind me sets the reminder at the existing DAYS_BEFORE for every source', (t) => {
  const { app } = rig(t);
  addDoc(app, 'Auto policy.pdf', [POLICY()]);
  takeRenewalMail(app, REG_MAIL(), observeMoneyMail(app, REG_MAIL()));
  takeRenewalMail(app, SUB_MAIL(), observeMoneyMail(app, SUB_MAIL()));
  const own = renewalAction(app, 'add', { what: 'warranty', title: 'Dishwasher warranty', date: '2027-08-01' });
  assert.equal(own.ok, true);
  const tz = 'America/Chicago';
  for (const r of renewalsOf(app)) {
    const res = renewalAction(app, 'remind', { id: r.id });
    assert.equal(res.ok, true, r.id);
    const rem = app.planner!.reminder(res.reminderId!)!;
    const wantDay = new Date(Date.UTC(Number(r.date.slice(0, 4)), Number(r.date.slice(5, 7)) - 1, Number(r.date.slice(8, 10))) - DAYS_BEFORE[r.kind] * 86_400_000).toISOString().slice(0, 10);
    assert.equal(localDate(new Date(rem.dueAt), tz), wantDay, `${r.what} ${r.date}: ${DAYS_BEFORE[r.kind]} days before`);
    assert.match(rem.text, new RegExp(r.title.slice(0, 6)));
  }
  const again = renewalsOf(app);
  assert.ok(again.every((r) => r.reminder), 'each row shows its reminder');
  // Remind twice: still one reminder.
  const first = again[0];
  assert.equal(renewalAction(app, 'remind', { id: first.id }).reminderId, first.reminder!.id);
  // The document's suggestion card is accepted too (no second card on Today).
  assert.equal(factsFor(app).suggestions().filter((s) => s.date === '2027-06-01').length, 0);
});

test('V2.1 renewal errand, hide, add by hand and bad input', (t) => {
  const { app } = rig(t);
  takeRenewalMail(app, REG_MAIL(), false);
  const r = renewalsOf(app)[0];
  const e = renewalAction(app, 'errand', { id: r.id });
  assert.equal(e.ok, true);
  assert.equal(e.errand!.template, 'renew');
  assert.equal(e.errand!.status, 'planning', 'from the page it waits for Start');
  assert.equal(e.errand!.deadline, '2027-02-28');
  assert.match(e.errand!.goal, /registration/i);
  assert.equal(renewalsOf(app)[0].errandId, e.errand!.id);
  assert.equal(templateFor('renew my passport')?.id, 'renew');
  assert.equal(templateFor('renovar mi pasaporte')?.id, 'renew');
  assert.equal(templateFor('cancel my subscription before it renews')?.id, 'cancel');
  assert.ok(TEMPLATES.some((x) => x.id === 'renew'));
  assert.equal(renewalAction(app, 'hide', { id: r.id }).ok, true);
  assert.equal(renewalsOf(app).length, 0);
  takeRenewalMail(app, REG_MAIL(), false);
  assert.equal(renewalsOf(app).length, 0, 'a hidden row stays hidden');
  assert.throws(() => renewalAction(app, 'add', { what: 'passport', title: '', date: '2027-01-01' }), /name/i);
  assert.throws(() => renewalAction(app, 'add', { what: 'passport', title: 'Passport', date: 'soon' }), /date/i);
  assert.throws(() => renewalAction(app, 'remind', { id: 'x9' }), /not found/i);
  const a = renewalAction(app, 'add', { what: '', title: 'Boat registration', date: '2027-04-30' });
  assert.equal(renewalsOf(app)[0].id, a.id);
  assert.equal(renewalsOf(app)[0].source.kind, 'you');
  assert.equal(renewalsOf(app)[0].what, 'registration', 'no kind picked: guessed from the name');
  assert.equal(renewalAction(app, 'remove', { id: a.id! }).ok, true);
  assert.equal(renewalsOf(app).length, 0);
});

test('V2.1 routes: /api/facts/renewals list, add, remind, errand, hide, unknown id', async (t) => {
  const { app, dir } = rig(t);
  addDoc(app, 'Auto policy.pdf', [POLICY()]);
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  let r = await call('GET', '/facts/renewals');
  assert.equal(r.status, 200);
  assert.equal(r.json.renewals.length, 1);
  assert.deepEqual(r.json.daysBefore, DAYS_BEFORE);
  r = await call('POST', '/facts/renewals', { what: 'passport', title: 'Passport', date: '2030-05-01' });
  assert.equal(r.status, 200);
  r = await call('POST', '/facts/renewals', { what: 'passport', title: 'Passport', date: 'nope' });
  assert.equal(r.status, 400);
  const id = (await call('GET', '/facts/renewals')).json.renewals[0].id;
  r = await call('POST', `/facts/renewals/${id}/remind`, {});
  assert.equal(r.status, 200);
  assert.ok(r.json.reminderId);
  r = await call('POST', `/facts/renewals/${id}/errand`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.errand.template, 'renew');
  r = await call('POST', `/facts/renewals/${id}/hide`, {});
  assert.equal(r.status, 200);
  r = await call('POST', '/facts/renewals/zz/remind', {});
  assert.equal(r.status, 404);
  assert.equal((await call('GET', '/facts/renewals')).json.renewals.length, 1);
});

test('V2.1 web: section on What Sara knows above the fold, tips, i18n, helper hook, doc', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const page = html.slice(html.indexOf('data-page="you-knows"'), html.indexOf('data-page="you-adult"'));
  assert.ok(page.indexOf('id="rnw-box"') > 0 && page.indexOf('id="rnw-box"') < page.indexOf('id="wsk-suggest"'), 'Renewals comes first on the page');
  assert.match(page, /<h3>Renewals and paperwork <button type="button" class="tip"/);
  for (const id of ['rnw-what', 'rnw-title', 'rnw-date', 'rnw-photo']) assert.match(page, new RegExp(`id="${id}"`));
  const tips = JSON.parse(readFileSync(join(ROOT, 'web/tips.json'), 'utf8'));
  for (const id of ['rnw-what', 'rnw-title', 'rnw-date', 'rnw-photo']) assert.ok(tips.tips?.[id] ?? tips[id], `tip for ${id}`);
  const js = readFileSync(join(ROOT, 'web/renewals.js'), 'utf8');
  assert.match(js, /\/facts\/renewals/);
  assert.match(js, /askInChat|hooks\.ask/);
  assert.ok(!/fetch\(/.test(js), 'goes through api()');
  const helper = readFileSync(join(ROOT, 'src/inbox/helper.ts'), 'utf8');
  assert.match(helper, /takeRenewalMail\(/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = readFileSync(join(ROOT, `web/i18n/${lang}.json`), 'utf8');
    assert.match(tr, /"Renewals and paperwork": /, lang);
  }
  assert.match(readFileSync(join(ROOT, 'docs/RENEWALS.md'), 'utf8'), /DAYS_BEFORE|30 days/);
});
