// V2.8 (docs/TRIM.md): Subscription trimmer. A monthly "maybe cancel" list built from what Money
// already knows (repeating charges, subscription mail: price changes, trials, renewals) plus new mail
// signals ("we miss you", subscription receipts): unused, price went up, two of the same kind.
// One tap opens a cancel errand that waits for Start, and its final confirm asks again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { errandsFor } from '../src/errands.ts';
import type { InboxMail } from '../src/inbox/classify.ts';
import { importFile, observeMoneyMail } from '../src/money/hub.ts';
import { observePurchaseMail, purchases } from '../src/money/purchases.ts';
import { observeTrimMail, serviceGroup, subKey, trimAction, trimLines, trimList, trimPrefs, trimTick } from '../src/money/trim.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-11-18T15:00:00Z');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function setup(t: { after: (fn: () => void) => void }, now: Date = NOW): { app: TestApp; dir: string } {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  let clock = now;
  const app = makeApp(dir, { get now() { return clock; } });
  (app as unknown as { setNow: (d: Date) => void }).setNow = (d: Date) => (clock = d);
  t.after(() => app.store.close());
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  return { app, dir };
}
let n = 0;
const mail = (o: Partial<InboxMail>): InboxMail => ({ account: 'alex@example.test', id: `m${++n}`, from: 'Shop <hi@shop.test>', subject: 'Hello', date: '2026-11-10T18:00:00Z', text: '', ...o });
/** The inbox helper's order: Money first, then the trimmer (both read every mail). */
const take = (app: TestApp, m: InboxMail) => {
  observeMoneyMail(app, m);
  return observeTrimMail(app, m);
};

const MAILS = {
  netflixPrice: mail({ from: 'Netflix <info@mailer.netflix.test>', subject: 'An update to your Netflix price', text: 'Your monthly price will change from $15.49 to $17.99 starting December 3, 2026.' }),
  huluMiss: mail({ from: 'Hulu <hello@hulu.test>', subject: 'We miss you, Alex', text: "You haven't watched anything on Hulu in 60 days. Your plan renews on December 9, 2026 for $7.99." }),
  disneyReceipt: mail({ from: 'Disney+ <billing@disneyplus.test>', subject: 'Your Disney+ receipt', text: 'Thanks for your subscription payment of $13.99. Your plan renews monthly.' }),
  spotifyReceipt: mail({ from: 'Spotify <no-reply@spotify.test>', subject: 'Your Spotify Premium receipt', text: '$11.99 charged for your Premium subscription.' }),
  spotifyPromo: mail({ from: 'Spotify <news@spotify.test>', subject: 'Get 3 months of Premium for free', text: 'Try Premium free for 3 months. Cancel anytime.' }),
  trial: mail({ from: 'StreamCo <billing@streamco.test>', subject: 'Your free trial ends soon', text: 'Your free trial ends on November 25, 2026. After that you will be charged $9.99/month.' }),
  friend: mail({ from: 'Sam <sam@example.test>', subject: 'lunch?', text: 'we miss you at lunch, come back friday' }),
};

test('V2.8 names: merchant keys match across mail and bank rows; service kinds', () => {
  assert.equal(subKey('Netflix'), subKey('netflix'));
  assert.equal(subKey('NETFLIX.COM'), 'netflix');
  assert.equal(subKey('Disney+'), subKey('disney plus'));
  assert.equal(subKey('spotify usa').startsWith(subKey('Spotify')), true);
  assert.equal(serviceGroup('Hulu'), 'video');
  assert.equal(serviceGroup('Spotify Premium'), 'music');
  assert.equal(serviceGroup('Dropbox'), 'storage');
  assert.equal(serviceGroup('Moonlight Atelier'), null);
});

test('V2.8 acceptance: fake subscription mails produce the right maybe-cancel list', (t) => {
  const { app } = setup(t);
  assert.equal(take(app, MAILS.huluMiss), true, 'a "we miss you" mail is a usage signal');
  assert.equal(take(app, MAILS.huluMiss), false, 'the same mail once');
  assert.equal(take(app, MAILS.disneyReceipt), true);
  assert.equal(take(app, MAILS.spotifyReceipt), true);
  assert.equal(take(app, MAILS.spotifyPromo), false, 'promo mail is not a subscription');
  assert.equal(take(app, MAILS.friend), false, 'a friend saying "we miss you" is not a service');
  take(app, MAILS.netflixPrice);
  take(app, MAILS.trial);
  const list = trimList(app);
  const by = Object.fromEntries(list.rows.map((r) => [r.name, r.reasons.map((x) => x.kind).sort()]));
  assert.deepEqual(by, {
    Hulu: ['duplicate', 'unused'],
    Netflix: ['duplicate', 'price'],
    'Disney+': ['duplicate'],
    StreamCo: ['trial'],
  });
  assert.ok(!list.rows.some((r) => /spotify/i.test(r.name)), 'one music service, used: not on the list');
  // A subscription's receipt is not a purchase to return (V2.2 Purchases skips it).
  const receipt = [{ kind: 'receipt', vendor: 'Disney+', amount: '13.99' }] as never;
  assert.equal(observePurchaseMail(app, { ...MAILS.disneyReceipt, id: 'p1' }, receipt), undefined);
  assert.equal(purchases(app).length, 0);
  const nf = list.rows.find((r) => r.name === 'Netflix')!;
  assert.deepEqual(nf.reasons.find((x) => x.kind === 'price'), { kind: 'price', fromCents: 1549, toCents: 1799 });
  assert.equal(nf.amountCents, 1799);
  assert.equal(nf.every, 'month', '"Your monthly price" says how often');
  assert.equal(nf.yearlyCents, 1799 * 12);
  assert.equal(list.rows.find((r) => r.name === 'StreamCo')!.every, 'month');
  const hulu = list.rows.find((r) => r.name === 'Hulu')!;
  assert.deepEqual(hulu.reasons.find((x) => x.kind === 'duplicate'), { kind: 'duplicate', group: 'video', with: ['Netflix', 'Disney+'].sort() });
  assert.equal(hulu.reasons.find((x) => x.kind === 'unused')?.from, 'mail');
  assert.equal(list.rows[0].name, 'Hulu', 'most reasons first');
  assert.ok(list.rows.every((r) => r.cancel.startsWith('https://')));
  assert.equal(list.yearlyCents, list.rows.reduce((s, r) => s + (r.yearlyCents ?? 0), 0));
  // The chat tool (budget_subscriptions) carries the same list in plain words.
  assert.match(trimLines(app), /- Hulu[^\n]*has not been used lately/);
  assert.match(trimLines(app), /final confirm asks again/);
});

test('V2.8 bank rows count too: a repeating charge whose price went up, and two storage plans', async (t) => {
  const { app } = setup(t);
  const rows = ['Date,Description,Amount', '08/03/2026,NETFLIX.COM,-15.49', '09/03/2026,NETFLIX.COM,-15.49', '10/03/2026,NETFLIX.COM,-17.99', '11/03/2026,NETFLIX.COM,-17.99', '09/12/2026,DROPBOX,-11.99', '10/12/2026,DROPBOX,-11.99', '11/12/2026,DROPBOX,-11.99', '09/20/2026,GOOGLE ONE STORAGE,-2.99', '10/20/2026,GOOGLE ONE STORAGE,-2.99', '11/14/2026,GOOGLE ONE STORAGE,-2.99'];
  await importFile(app, { name: 'b.csv', bytes: Buffer.from(rows.join('\n')) });
  take(app, MAILS.netflixPrice); // the same price change by mail: still one row, one price reason
  const list = trimList(app);
  const names = list.rows.map((r) => r.name.toLowerCase()).sort();
  assert.deepEqual(names, ['dropbox', 'google one storage', 'netflix']);
  const nf = list.rows.find((r) => /netflix/i.test(r.name))!;
  assert.equal(nf.reasons.filter((x) => x.kind === 'price').length, 1);
  assert.equal(nf.yearlyCents, 1799 * 12);
  assert.equal(list.rows.find((r) => /dropbox/i.test(r.name))!.reasons[0].kind, 'duplicate');
});

test('V2.8 one tap opens a cancel errand that waits; nothing cancels without OK; Keep and Not using it', (t) => {
  const { app } = setup(t);
  take(app, MAILS.huluMiss);
  take(app, MAILS.trial);
  const hulu = trimList(app).rows.find((r) => r.name === 'Hulu')!;
  const r = trimAction(app, hulu.key, 'cancel');
  const e = r.errand!;
  assert.equal(e.template, 'cancel');
  assert.equal(e.status, 'planning', 'waits on the Errands page until you press Start');
  assert.match(e.goal, /Cancel my Hulu subscription/);
  assert.equal(e.facts.merchant, 'Hulu');
  assert.equal(e.steps.at(-1)?.needsOk, true, 'the final confirm asks first');
  assert.ok(e.steps.every((s) => s.status === 'todo'), 'nothing ran');
  assert.equal(trimAction(app, hulu.key, 'cancel').errand!.id, e.id, 'one errand per subscription');
  assert.equal(trimList(app).rows.find((x) => x.name === 'Hulu')!.errandId, e.id);
  // Keep it: off the list until something new is found about it.
  const sc = trimList(app).rows.find((x) => x.name === 'StreamCo')!;
  trimAction(app, sc.key, 'keep');
  assert.ok(!trimList(app).rows.some((x) => x.name === 'StreamCo'));
  assert.equal(trimList(app).kept, 1);
  assert.deepEqual(trimList(app).keptRows, [{ key: sc.key, name: 'StreamCo' }]);
  trimAction(app, sc.key, 'unkeep');
  assert.ok(trimList(app).rows.some((x) => x.name === 'StreamCo'));
  // Not using it: any known subscription joins the list.
  take(app, MAILS.spotifyReceipt);
  assert.ok(!trimList(app).rows.some((x) => /spotify/i.test(x.name)));
  trimAction(app, subKey('Spotify'), 'unused');
  assert.deepEqual(trimList(app).rows.find((x) => /spotify/i.test(x.name))!.reasons, [{ kind: 'unused', from: 'you' }]);
  trimAction(app, 'Spotify Premium', 'used'); // by the name the Subscriptions list shows
  assert.ok(!trimList(app).rows.some((x) => /spotify/i.test(x.name)));
  assert.deepEqual(trimList(app).keptRows, []);
  assert.throws(() => trimAction(app, 'nope', 'cancel'), /not on your list/i);
  // A cancel errand that finished: the row says so and leaves the list.
  errandsFor(app).stop(e.id);
  assert.ok(trimList(app).rows.some((x) => x.name === 'Hulu'), 'a stopped errand keeps the row (cancel again)');
});

test('V2.8 monthly note: once a month on the Money feed, off by the setting; never acts', (t) => {
  const { app } = setup(t, new Date('2026-12-01T16:00:00Z'));
  take(app, MAILS.huluMiss);
  take(app, MAILS.netflixPrice);
  const before = app.store.listConversations().find((c) => c.title === 'Money');
  const was = before ? app.store.messages(before.id).length : 0;
  assert.equal(trimTick(app, app.now()), true);
  assert.equal(trimTick(app, app.now()), false, 'once a month');
  const conv = app.store.listConversations().find((c) => c.title === 'Money')!;
  const msgs = app.store.messages(conv.id).map((m) => m.content).slice(was);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Hulu/);
  assert.match(msgs[0], /without your OK/i);
  assert.equal(errandsFor(app).list({ open: true }).length, 0, 'the note never starts an errand');
  (app as unknown as { setNow: (d: Date) => void }).setNow(new Date('2027-01-01T16:00:00Z'));
  trimAction(app, '', 'prefs', { monthly: false });
  assert.equal(trimPrefs(app).monthly, false);
  assert.equal(trimTick(app, app.now()), false, 'off: nothing posted');
});

test('V2.8 routes under /api/money/trim; web, tips, i18n and docs are wired', async (t) => {
  const { app, dir } = setup(t);
  take(app, MAILS.huluMiss);
  const auth = new OwnerAuth(dir, () => app.now());
  const token = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/money/trim`;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const got = (await (await fetch(base, { headers: h })).json()) as ReturnType<typeof trimList>;
  assert.equal(got.rows[0].name, 'Hulu');
  const c = await fetch(`${base}/${encodeURIComponent(got.rows[0].key)}/cancel`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(c.status, 200);
  assert.equal(((await c.json()) as { errand: { status: string } }).errand.status, 'planning');
  assert.equal((await fetch(`${base}/x/explode`, { method: 'POST', headers: h, body: '{}' })).status, 404);
  const p = await fetch(`${base}/prefs`, { method: 'PUT', headers: h, body: JSON.stringify({ monthly: false }) });
  assert.equal(((await p.json()) as { monthly: boolean }).monthly, false);
  const html = read('web/index.html');
  assert.match(html, /id="trm-list"/);
  assert.match(html, /id="trm-monthly"/);
  assert.match(read('web/money.js'), /initTrim/);
  assert.match(html, /<input id="trm-monthly" type="checkbox"> [^<]+<button type="button" class="tip" data-tip=/, 'the setting has its tip');
  assert.match(read('src/inbox/helper.ts'), /observeTrimMail/);
  assert.match(read('src/reminders.ts'), /trimTick/);
  assert.match(read('docs/TRIM.md'), /Maybe cancel/);
});
