// V2.2 (docs/PURCHASES.md): Purchases: receipts, returns, warranties. A list of what you bought
// (item, store, price, date, return-by, warranty-until) from receipt mail and receipt photos, a
// reminder before a return window closes and a "Start a return" errand. Reads facts.ts, never edits it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { errandsFor, planFor, templateFor } from '../src/errands.ts';
import { classify, type InboxMail } from '../src/inbox/classify.ts';
import { LibraryStore } from '../src/library/store.ts';
import { addPurchase, observePurchaseMail, purchasePrefs, purchases, purchasesOverview, readReceiptTerms, removePurchase, scanPurchaseDocs, setPurchasePrefs, setPurchaseStatus, startReturn, STORE_POLICIES, updatePurchase } from '../src/money/purchases.ts';
import { createSaraServer } from '../src/server.ts';
import { createPurchaseTools } from '../src/tools/purchases.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const NOW = new Date('2026-11-18T15:00:00Z');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function setup(t: { after: (fn: () => void) => void }): { app: TestApp; dir: string } {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: NOW });
  t.after(() => app.store.close());
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  app.library = new LibraryStore(app.store.db, dir, () => NOW);
  return { app, dir };
}
const mail = (o: Partial<InboxMail>): InboxMail => ({ account: 'alex@example.test', id: `m${Math.random().toString(36).slice(2, 8)}`, from: 'Shop <orders@shop.test>', subject: 'Your receipt', date: '2026-11-16T18:00:00Z', text: '', ...o });

const BESTBUY = mail({
  from: 'Best Buy <orders@bestbuy.test>',
  subject: 'Thanks for your order',
  text: 'Ordered on Nov 16, 2026\nOrder #BB-55120\nSony WH-1000XM5 headphones $348.00\nSubtotal $348.00\nTax $28.71\nTotal: $376.71\nIncludes a 1-year limited warranty.',
});
const PHOTO = 'A photo of a store receipt.\nTARGET\nStore 1234\n11/14/2026 3:42 PM\nKITCHENAID HAND MIXER 49.99\nSubtotal 49.99\nTax 4.21\nTOTAL 54.20\nReturns accepted within 90 days with receipt.';

test('V2.2 terms: return-by from the receipt (date or days), else the store policy; warranty by date or length', () => {
  assert.deepEqual(readReceiptTerms('Return by Dec 20, 2026 for a full refund.', { date: '2026-11-16' }), { returnBy: '2026-12-20', returnFrom: 'receipt' });
  assert.deepEqual(readReceiptTerms('Items can be returned within 30 days of purchase.', { date: '2026-11-16' }), { returnBy: '2026-12-16', returnFrom: 'receipt' });
  assert.deepEqual(readReceiptTerms('No terms here.', { date: '2026-11-16', store: 'Best Buy' }), { returnBy: '2026-12-01', returnFrom: 'store' });
  assert.deepEqual(readReceiptTerms('Nothing.', { date: '2026-11-16', store: 'Corner Hardware' }), {});
  assert.deepEqual(readReceiptTerms('2-year manufacturer warranty included.', { date: '2026-11-16' }), { warrantyUntil: '2028-11-16', warrantyFrom: 'receipt' });
  assert.deepEqual(readReceiptTerms('Warranty valid until 2028-01-31.', { date: '2026-11-16' }), { warrantyUntil: '2028-01-31', warrantyFrom: 'receipt' });
  assert.deepEqual(readReceiptTerms('Final sale. No returns.', { date: '2026-11-16', store: 'Target' }), { returnBy: null, returnFrom: 'receipt' });
  assert.ok(STORE_POLICIES.length >= 6 && STORE_POLICIES.every((p) => p.days > 0 && p.days <= 365));
});

test('V2.2 acceptance: a fake receipt mail becomes a row with the right return-by (store policy) and a reminder', (t) => {
  const { app } = setup(t);
  const { findings } = classify(BESTBUY, NOW);
  const p = observePurchaseMail(app, BESTBUY, findings)!;
  assert.ok(p, 'a receipt mail makes a purchase');
  assert.equal(p.store, 'Best Buy');
  assert.match(p.item, /Sony WH-1000XM5 headphones/);
  assert.equal(p.priceCents, 37671);
  assert.equal(p.date, '2026-11-16');
  assert.equal(p.returnBy, '2026-12-01');
  assert.equal(p.returnFrom, 'store');
  assert.equal(p.warrantyUntil, '2027-11-16');
  assert.equal(p.source, 'mail');
  assert.equal(p.order, 'BB-55120');
  // A reminder 3 days before the window closes, in the morning (Chicago).
  const r = app.planner!.reminder(p.reminderId!)!;
  assert.match(r.text, /return.*Best Buy.*Dec 1/i);
  assert.equal(r.dueAt.slice(0, 10), '2026-11-28');
  // The same mail again changes nothing.
  assert.equal(observePurchaseMail(app, BESTBUY, findings), undefined);
  assert.equal(purchases(app).length, 1);
  // A mail that is not a receipt is ignored.
  const news = mail({ subject: 'Our winter sale', text: 'Up to 50% off. Unsubscribe.' });
  assert.equal(observePurchaseMail(app, news, classify(news, NOW).findings), undefined);
});

test('V2.2 acceptance: a fake receipt photo in the Library becomes a row with the right return-by', (t) => {
  const { app } = setup(t);
  const lib = app.library!;
  const doc = lib.add({ name: 'IMG_2041.jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), keep: true, origin: 'library', learn: false });
  // What the picture model writes for a photo (src/picture-reader.ts READ_PROMPT).
  lib.setRead(doc.id, { kind: 'image', parts: [{ text: PHOTO, where: '' }] as never, warnings: [] });
  // An unrelated document is never a purchase.
  const other = lib.add({ name: 'notes.txt', bytes: Buffer.from('Grocery ideas: apples, bread'), keep: true, origin: 'library', learn: false });
  lib.setRead(other.id, { kind: 'text', parts: [{ text: 'Grocery ideas: apples, bread', where: '' }] as never, warnings: [] });
  assert.equal(scanPurchaseDocs(app), 1);
  const [p] = purchases(app);
  assert.equal(p.store, 'TARGET');
  assert.equal(p.item, 'KITCHENAID HAND MIXER');
  assert.equal(p.priceCents, 5420);
  assert.equal(p.date, '2026-11-14');
  assert.equal(p.returnBy, '2027-02-12');
  assert.equal(p.returnFrom, 'receipt');
  assert.equal(p.source, 'photo');
  assert.equal(p.docId, doc.id);
  // Scanning again adds nothing; the same receipt arriving by mail later joins the same row.
  assert.equal(scanPurchaseDocs(app), 0);
  const m = mail({ from: 'Target <receipts@target.test>', subject: 'Your Target receipt', text: 'Nov 14, 2026\nKitchenAid hand mixer $49.99\nTotal: $54.20' });
  observePurchaseMail(app, m, classify(m, NOW).findings);
  assert.equal(purchases(app).length, 1);
  // Deleting the photo from the Library keeps the row (it is the person's list), without the link.
  lib.delete(doc.id);
  scanPurchaseDocs(app);
  assert.equal(purchases(app).length, 1);
});

test('V2.2 reminders: off in prefs = none; Keep it and delete cancel the reminder; past windows get none', (t) => {
  const { app } = setup(t);
  assert.deepEqual(purchasePrefs(app), { remind: true, days: 3 });
  const a = addPurchase(app, { item: 'Desk lamp', store: 'IKEA', price: '39.99', date: '2026-11-10' });
  assert.equal(a.returnBy, '2027-11-10');
  assert.equal(a.returnFrom, 'store');
  assert.ok(a.reminderId);
  const kept = setPurchaseStatus(app, a.id, 'kept')!;
  assert.equal(kept.reminderId, null);
  assert.equal(app.planner!.reminder(a.reminderId!)!.status, 'cancelled');
  setPurchasePrefs(app, { remind: false });
  const b = addPurchase(app, { item: 'Rug', store: 'Target', price: 80, date: '2026-11-12' });
  assert.equal(b.reminderId, null);
  setPurchasePrefs(app, { remind: true, days: 7 });
  const c = addPurchase(app, { item: 'Old thing', store: 'Best Buy', price: 10, date: '2026-10-01' });
  assert.equal(c.returnBy, '2026-10-16');
  assert.equal(c.reminderId, null, 'a closed window gets no reminder');
  // Editing the return-by date moves the reminder.
  const d = addPurchase(app, { item: 'Chair', store: 'Somewhere', price: 60, date: '2026-11-15', returnBy: '2026-12-15' });
  assert.equal(d.returnFrom, 'you');
  assert.equal(app.planner!.reminder(d.reminderId!)!.dueAt.slice(0, 10), '2026-12-08');
  const moved = updatePurchase(app, d.id, { returnBy: '2026-12-31', warrantyUntil: '2028-12-31' })!;
  assert.notEqual(moved.reminderId, d.reminderId);
  assert.equal(moved.warrantyFrom, 'you');
  assert.equal(app.planner!.reminder(moved.reminderId!)!.dueAt.slice(0, 10), '2026-12-24');
  assert.throws(() => setPurchasePrefs(app, { days: 40 }), /Pick one of the offered/);
  assert.throws(() => addPurchase(app, { store: 'X' }), /Say what you bought/);
  assert.ok(removePurchase(app, moved.id));
  assert.equal(purchases(app).length, 3);
  const o = purchasesOverview(app);
  assert.equal(o.prefs.days, 7);
  assert.ok(o.policies.some((x) => x.store === 'Best Buy'));
  assert.equal(o.purchases.find((x) => x.id === c.id)!.state, 'closed');
  assert.equal(o.purchases.find((x) => x.id === b.id)!.state, 'open');
});

test('V2.2 Start a return: one errand per purchase with the facts filled, deadline = return-by', (t) => {
  const { app } = setup(t);
  const { findings } = classify(BESTBUY, NOW);
  const p = observePurchaseMail(app, BESTBUY, findings)!;
  const e = startReturn(app, p.id);
  assert.equal(e.template, 'return');
  assert.equal(e.deadline, '2026-12-01');
  assert.equal(e.facts.merchant, 'Best Buy');
  assert.equal(e.facts.order, 'BB-55120');
  assert.match(e.goal, /Return Sony WH-1000XM5.*Best Buy/);
  assert.ok(e.steps.some((s) => s.kind === 'message' && /return/i.test(s.body ?? '')));
  assert.equal(e.status, 'planning', 'nothing is sent until the person starts it');
  assert.equal(startReturn(app, p.id).id, e.id, 'a second tap opens the same errand');
  assert.equal(purchases(app)[0].errandId, e.id);
  // The template is also offered on the Errands page and matches plain words.
  assert.equal(templateFor('start a return for my headphones')?.id, 'return');
  assert.equal(templateFor('get a refund for this charge')?.id, 'refund');
  assert.equal(planFor('x', { template: 'return' }).template, 'return');
  assert.ok(errandsFor(app).get(e.id));
});

test('V2.2 tools: purchase_add reads terms by code, purchases_list shows windows, purchase_return asks first', async (t) => {
  const { app } = setup(t);
  const tools = createPurchaseTools(() => app);
  const by = (n: string) => tools.find((x) => x.spec.name === n)!;
  const ctx = { workspaceDir: app.dataDir, signal: AbortSignal.timeout(5000), sandbox: app.sandbox, conversationId: 'c1' } as never;
  const out = await by('purchase_add').run({ item: 'Air fryer', store: 'Walmart', price: '89.00', date: '2026-11-17' }, ctx);
  assert.match(out, /Saved purchase #1: Air fryer from Walmart, \$89\.00, Nov 17, 2026\. Return by Feb 15, 2027 \(Walmart's usual window\)/);
  assert.match(await by('purchases_list').run({}, ctx), /#1 Air fryer · Walmart · \$89\.00 · bought Nov 17, 2026 · return by Feb 15, 2027/);
  assert.equal(by('purchase_return').defaultPermission, 'ask');
  assert.match(by('purchase_return').summarize!({ id: 1 } as never), /return/i);
  assert.match(await by('purchase_return').run({ id: 1 }, ctx), /errand #\d+/i);
  const lean = read('src/lean.ts');
  assert.match(lean, /purchases\?_/);
  assert.match(read('src/main.ts'), /createPurchaseTools\(/);
});

test('V2.2 route: list, add by hand, edit, Keep it, Start a return, prefs, delete', async (t) => {
  const { app, dir } = setup(t);
  const auth = new OwnerAuth(dir, () => app.now());
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => (server.closeAllConnections(), server.close()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/money/purchases`;
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('', 'POST', { store: 'X' })).status, 400);
  const add = (await (await call('', 'POST', { item: 'Kettle', store: 'Target', price: '29.99', date: '2026-11-15' })).json()) as { id: number; returnBy: string };
  assert.equal(add.returnBy, '2027-02-13');
  const list = (await (await call('')).json()) as { purchases: { id: number; state: string }[]; prefs: { remind: boolean } };
  assert.equal(list.purchases.length, 1);
  assert.equal(list.prefs.remind, true);
  assert.equal((await call(`/${add.id}`, 'PATCH', { returnBy: 'soon' })).status, 400);
  assert.equal(((await (await call(`/${add.id}`, 'PATCH', { returnBy: '2026-12-20' })).json()) as { returnBy: string }).returnBy, '2026-12-20');
  const e = (await (await call(`/${add.id}/return`, 'POST', {})).json()) as { errand: { id: number } };
  assert.ok(e.errand.id);
  assert.equal(((await (await call(`/${add.id}/status`, 'POST', { status: 'returned' })).json()) as { status: string }).status, 'returned');
  assert.equal((await call(`/${add.id}/status`, 'POST', { status: 'lost' })).status, 400);
  assert.equal(((await (await call('/prefs', 'PUT', { days: 5 })).json()) as { days: number }).days, 5);
  assert.equal((await call('/999', 'DELETE')).status, 404);
  assert.equal((await call(`/${add.id}`, 'DELETE')).status, 200);
});

test('V2.2 web + docs: a Purchases section on Money, photo button through the Library, strings via t()', () => {
  const html = read('web/index.html');
  assert.match(html, /<h3>Purchases <button type="button" class="tip"/);
  assert.match(html, /id="mn-buys"/);
  assert.match(html, /id="pu-photo"[^>]*accept="image\/jpeg,image\/png,application\/pdf"/);
  const js = read('web/purchases.js');
  assert.match(js, /export async function loadPurchases/);
  assert.match(js, /\/api\/library\?name=/);
  assert.match(js, /\/money\/purchases/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*[^'"`]/, 'rows are built with DOM nodes, never raw HTML');
  assert.match(read('web/money.js'), /loadPurchases/);
  // facts.ts is read, never edited, by this task.
  assert.match(read('src/money/purchases.ts'), /from '\.\.\/facts\.ts'/);
  assert.match(read('src/inbox/helper.ts'), /observePurchaseMail\(/);
  // Every control has its own ? tip (scripts/tip-coverage.ts checks the rest).
  for (const id of ['pu-remind', 'pu-days', 'pu-item', 'pu-photo', 'pu-date']) assert.ok(new RegExp(`class="tip"[^\\n]{0,400}id="${id}"|id="${id}"[^\\n]{0,200}class="tip"`).test(html), `tip for ${id}`);
  assert.match(read('docs/PURCHASES.md'), /Return-by/);
});
