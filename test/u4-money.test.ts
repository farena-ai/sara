// U4.20 (docs/MONEY.md): the Money place. QIF, CSV column mapping saved per bank, duplicates across
// overlapping files, editable + learned categories (model suggestions optional), trends, budgets with
// gentle alerts on the 'money' feed, bills due (tracked + recurring), subscriptions from transactions
// and mail (price changes, trials ending, how to cancel), net worth from typed balances, the Ask source
// 'money', routes (members isolated, kids refused, demo 404), private local mode. Invented data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { askAllowed, askEverything, ASK_SOURCES } from '../src/ask-everything.ts';
import { FEEDS } from '../src/destinations.ts';
import { childRouteCheck } from '../src/family.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { readTransactions, transactionsFromQif, MappingNeeded } from '../src/money/parse.ts';
import { moneyStore } from '../src/money/store.ts';
import { addBalance, billsDue, budgetAlerts, budgetStatus, cancelLink, importFile, moneyOverview, netWorth, observeMoneyMail, priceChanges, setPrefs, prefsOf, removeBalance, suggestCategories, trends } from '../src/money/hub.ts';
import { makeApp, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-13T15:00:00Z');
const root = join(import.meta.dirname, '..');

function setup(t: { after: (fn: () => void) => void }): { app: TestApp; clock: { now: Date } } {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  t.after(() => app.store.close());
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  return { app, clock };
}
const csv = (s: string) => Buffer.from(s.replace(/^\n/, ''));

test('QIF: bank and card files, US dates with apostrophe years, payee/memo, signed amounts', () => {
  const qif = '!Type:CCard\nD11/02\'26\nT-45.10\nPKROGER #123\nLGroceries\n^\nD11/5/2026\nU-15.99\nPNETFLIX.COM\n^\nD11/06/2026\nT1,200.00\nMPAYROLL ACME\n^\n';
  const r = transactionsFromQif(qif, 'Visa');
  assert.deepEqual(r.rows.map((x) => [x.date, x.description, x.amountCents, x.account, x.bankCategory]), [
    ['2026-11-02', 'KROGER #123', -4510, 'Visa', 'Groceries'],
    ['2026-11-05', 'NETFLIX.COM', -1599, 'Visa', ''],
    ['2026-11-06', 'PAYROLL ACME', 120000, 'Visa', ''],
  ]);
  const via = readTransactions('card.qif', Buffer.from(qif), 'Visa');
  assert.equal(via.rows.length, 3);
});

test('CSV with unknown columns asks for a mapping; the mapping is saved per bank and reused', async (t) => {
  const { app } = setup(t);
  const file = csv('\nBuchung,Was,Betrag EUR,Notiz\n11/03/2026,COFFEE HOUSE,-4.50,x\n11/04/2026,BOOKSHOP,-20.00,y\n');
  assert.throws(() => readTransactions('weird.csv', file), (e: unknown) => e instanceof MappingNeeded && e.columns.join('|') === 'Buchung|Was|Betrag EUR|Notiz');
  const first = await importFile(app, { name: 'weird.csv', bytes: file });
  assert.equal(first.needMapping, true);
  assert.deepEqual(first.columns, ['Buchung', 'Was', 'Betrag EUR', 'Notiz']);
  assert.equal(first.sample?.length, 2);
  const done = await importFile(app, { name: 'weird.csv', bytes: file, account: 'Euro card', mapping: { date: 0, description: 1, amount: 2, bank: 'My Euro bank' } });
  assert.equal(done.added, 2);
  // Next month's file from the same bank: no question, the saved mapping is used.
  const next = await importFile(app, { name: 'weird-dec.csv', bytes: csv('Buchung,Was,Betrag EUR,Notiz\n12/01/2026,COFFEE HOUSE,-4.50,x\n') });
  assert.equal(next.needMapping, undefined);
  assert.equal(next.added, 1);
  assert.equal(moneyOverview(app, '2026-11').mappings[0].bank, 'My Euro bank');
});

test('overlapping files: rows already loaded from another file of the same account are duplicates (file-name accounts, last-4 digits, OFX vs CSV)', async (t) => {
  const { app } = setup(t);
  const oct = csv('Date,Description,Amount\n10/28/2026,KROGER #1,-30.00\n10/30/2026,SHELL OIL,-40.00\n11/01/2026,NETFLIX.COM,-15.99\n');
  const nov = csv('Date,Description,Amount\n10/30/2026,SHELL OIL,-40.00\n11/01/2026,NETFLIX.COM,-15.99\n11/03/2026,KROGER #1,-22.00\n11/03/2026,KROGER #1,-22.00\n');
  const a = await importFile(app, { name: 'chase-oct.csv', bytes: oct });
  const b = await importFile(app, { name: 'chase-nov.csv', bytes: nov });
  assert.equal(a.added, 3);
  assert.equal(b.added, 2, 'two equal groceries on one day both count');
  assert.equal(b.duplicates, 2);
  const ofx = Buffer.from('<OFX><CCSTMTRS><ACCTID>4111000011119876<STMTTRN><DTPOSTED>20261105<TRNAMT>-9.00<NAME>BLUE BOTTLE</STMTTRN></CCSTMTRS></OFX>');
  await importFile(app, { name: 'card.ofx', bytes: ofx, account: 'Card' });
  const again = await importFile(app, { name: 'card-export.csv', bytes: csv('Date,Description,Amount,Card No.\n11/05/2026,BLUE BOTTLE,-9.00,9876\n'), account: 'Card 9876' });
  assert.equal(again.added, 0, 'same card (last 4 digits) in another format');
  assert.deepEqual(moneyOverview(app, '2026-11').imports.map((i) => [i.name, i.added, i.duplicates]).slice(0, 2), [['card-export.csv', 0, 1], ['card.ofx', 1, 0]]);
});

test('categories: rules the person edits, learned from a correction, model suggestions only when turned on', async (t) => {
  const { app } = setup(t);
  await importFile(app, { name: 'a.csv', bytes: csv('Date,Description,Amount\n11/02/2026,ZEPHYR GOODS 22,-12.00\n11/03/2026,ZEPHYR GOODS 22,-8.00\n11/04/2026,MOONLIGHT ATELIER,-30.00\n') });
  const s = moneyStore(app);
  assert.ok(s.transactions().every((x) => x.category === 'other'));
  s.setRule('ZEPHYR GOODS', 'groceries');
  assert.deepEqual(s.transactions().map((x) => x.category), ['groceries', 'groceries', 'other']);
  assert.deepEqual(moneyOverview(app, '2026-11').rules, [{ merchant: 'zephyr goods', category: 'groceries' }]);
  await assert.rejects(suggestCategories(app), /turned off/i);
  setPrefs(app, { suggest: true });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  app.script.push(text('{"moonlight atelier": "shopping", "zephyr goods": "dining", "bogus": "x"}'));
  const sug = await suggestCategories(app);
  assert.deepEqual(sug, [{ merchant: 'moonlight atelier', category: 'shopping' }], 'only uncategorized merchants, never over a rule');
  const sent = JSON.stringify(app.requests.at(-1)?.messages ?? []);
  assert.doesNotMatch(sent, /30\.00|-3000/, 'merchants only, no amounts');
});

test('trends, budgets and gentle alerts: near once, over once, on the Money feed', async (t) => {
  const { app } = setup(t);
  assert.ok(FEEDS.some((f) => f.id === 'money'));
  const rows = ['Date,Description,Amount', '09/10/2026,KROGER,-100.00', '10/10/2026,KROGER,-120.00', '11/02/2026,KROGER,-85.00', '11/03/2026,STARBUCKS,-10.00'];
  await importFile(app, { name: 'x.csv', bytes: csv(rows.join('\n')) });
  const tr = trends(moneyStore(app).transactions(), '2026-11', 3);
  assert.deepEqual(tr.months, ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(tr.categories.find((c) => c.category === 'groceries')?.cents, [10000, 12000, 8500]);
  assert.deepEqual(tr.totals, [10000, 12000, 9500]);
  const s = moneyStore(app);
  s.setLimit('groceries', 10000);
  assert.deepEqual(budgetStatus(s, '2026-11-13').map((b) => [b.category, b.spentCents, b.pct, b.state]), [['groceries', 8500, 85, 'near']]);
  const posted: string[] = [];
  const before = app.store.listConversations().length;
  let out = budgetAlerts(app, null);
  assert.match(out, /groceries.*\$85\.00.*\$100\.00/i);
  const conv = app.store.listConversations().find((c) => c.title === 'Money');
  assert.ok(conv, 'posted in the Money chat (alert destination)');
  assert.equal(app.store.listConversations().length, before + 1);
  posted.push(...app.store.messages(conv!.id).map((m) => m.content));
  assert.equal(budgetAlerts(app, null), '', 'told once');
  await importFile(app, { name: 'y.csv', bytes: csv('Date,Description,Amount\n11/05/2026,KROGER,-30.00\n') });
  const msgs = app.store.messages(conv!.id).map((m) => m.content);
  assert.equal(msgs.length, 2, 'over: one more, gentle');
  assert.match(msgs[1], /past your \$100\.00/);
  setPrefs(app, { gentle: false });
  s.setLimit('dining', 500);
  await importFile(app, { name: 'z.csv', bytes: csv('Date,Description,Amount\n11/06/2026,STARBUCKS,-10.00\n') });
  assert.equal(app.store.messages(conv!.id).length, 2, 'alerts off: nothing posted');
  assert.deepEqual(prefsOf(app), { gentle: false, nearPct: 80, suggest: false });
});

test('bills due: tracked bills and recurring charges not tracked yet; subscriptions with price changes and cancel links', async (t) => {
  const { app } = setup(t);
  const rows = ['Date,Description,Amount', '08/15/2026,CITY WATER UTILITY,-60.00', '09/15/2026,CITY WATER UTILITY,-61.00', '10/15/2026,CITY WATER UTILITY,-60.50', '08/03/2026,NETFLIX.COM,-15.49', '09/03/2026,NETFLIX.COM,-15.49', '10/03/2026,NETFLIX.COM,-17.99', '11/03/2026,NETFLIX.COM,-17.99'];
  await importFile(app, { name: 'b.csv', bytes: csv(rows.join('\n')) });
  const s = moneyStore(app);
  s.addBill({ name: 'Rent', amountCents: 150000, repeat: 'monthly', dueDay: 20, dueDate: null, autopay: false, leadDays: 3 });
  const due = billsDue(app, '2026-11-13');
  assert.deepEqual(due.bills.map((b) => [b.name, b.due, b.days]), [['Rent', '2026-11-20', 7]]);
  assert.deepEqual(due.recurring.map((r) => [r.merchant, r.next, r.amountCents]), [['city water utility', '2026-11-15', 6050]]);
  const pc = priceChanges(s.transactions(), '2026-11-13');
  assert.deepEqual(pc.map((p) => [p.merchant, p.fromCents, p.toCents, p.on]), [['netflix', 1549, 1799, '2026-10-03']]);
  assert.match(cancelLink('netflix'), /^https:\/\/www\.netflix\.com\//);
  assert.match(cancelLink('moonlight atelier'), /^https:\/\/duckduckgo\.com\/\?q=how\+to\+cancel\+moonlight\+atelier/);
  const ov = moneyOverview(app, '2026-11');
  const nf = ov.subscriptions.find((x) => x.merchant === 'netflix');
  assert.equal(nf?.priceChange?.toCents, 1799);
  assert.ok(nf?.cancel);
  assert.ok(!ov.subscriptions.some((x) => x.merchant === 'city water utility'), 'utilities are bills, not subscriptions');
});

test('subscriptions found in mail: free trial ending (reminder + gentle alert once), price increase, never acts', async (t) => {
  const { app } = setup(t);
  const trial = { account: 'me@example.test', id: 'm1', from: 'StreamCo <billing@streamco.example>', subject: 'Your free trial ends soon', date: NOW.toISOString(), text: 'Your free trial ends on November 20, 2026. After that you will be charged $9.99/month.' };
  assert.equal(observeMoneyMail(app, trial), true);
  assert.equal(observeMoneyMail(app, trial), false, 'the same mail once');
  observeMoneyMail(app, { account: 'me@example.test', id: 'm2', from: 'Gym Pass <hello@gympass.example>', subject: 'Price update for your membership', date: NOW.toISOString(), text: 'Your membership price will change from $29.00 to $34.00 starting December 1, 2026.' });
  observeMoneyMail(app, { account: 'me@example.test', id: 'm3', from: 'Friend <a@b.example>', subject: 'lunch?', date: NOW.toISOString(), text: 'free on friday' });
  const ov = moneyOverview(app, '2026-11');
  assert.deepEqual(ov.mailSubs.map((m) => [m.merchant, m.kind, m.ends, m.fromCents, m.toCents]), [
    ['StreamCo', 'trial', '2026-11-20', null, 999],
    ['Gym Pass', 'price', '2026-12-01', 2900, 3400],
  ]);
  assert.ok(ov.mailSubs[0].cancel.startsWith('https://'));
  const rem = app.planner?.reminders({ status: 'all' }) ?? [];
  assert.ok(rem.some((r: { text: string }) => /StreamCo.*trial/i.test(r.text)), 'a Planner reminder before the trial ends');
  const conv = app.store.listConversations().find((c) => c.title === 'Money');
  assert.match(app.store.messages(conv!.id).map((m) => m.content).join('\n'), /never cancels/i);
});

test('net worth from typed balances, with a daily history; portfolio last value counted when there', (t) => {
  const { app } = setup(t);
  const s = moneyStore(app);
  const a = addBalance(app, { name: 'Checking', kind: 'asset', amount: '2,500.00' });
  addBalance(app, { name: 'House', kind: 'asset', amount: '300000' });
  addBalance(app, { name: 'Mortgage', kind: 'debt', amount: '210000' });
  s.setState('portfolio_last', { valueCents: 1000000, dayChangeCents: 0, dayPct: null, source: 'Yahoo Finance', at: NOW.toISOString(), checkedAt: NOW.toISOString(), currency: 'USD' });
  let nw = netWorth(app);
  assert.equal(nw.assetsCents, 250000 + 30000000 + 1000000);
  assert.equal(nw.debtsCents, 21000000);
  assert.equal(nw.netCents, nw.assetsCents - nw.debtsCents);
  assert.equal(nw.portfolioCents, 1000000);
  assert.equal(nw.history.at(-1)?.day, '2026-11-13');
  removeBalance(app, a.id);
  nw = netWorth(app);
  assert.equal(nw.assetsCents, 30000000 + 1000000);
  assert.equal(nw.history.length, 1, 'one snapshot per day');
  assert.throws(() => addBalance(app, { name: '', kind: 'asset', amount: '5' }), /name/i);
});

test('Ask about anything: source money finds merchants and amounts; members isolated; kids skipped', async (t) => {
  const { app } = setup(t);
  assert.ok((ASK_SOURCES as readonly string[]).includes('money'));
  await importFile(app, { name: 'q.csv', bytes: csv('Date,Description,Amount\n11/02/2026,BLUE BOTTLE COFFEE,-6.75\n11/04/2026,HARDWARE HUT,-42.10\n') });
  let r = await askEverything(app, 'blue bottle coffee', { sources: ['money'] });
  assert.equal(r.groups[0]?.source, 'money');
  assert.match(r.groups[0].items[0].quote, /6\.75/);
  assert.deepEqual(r.groups[0].items[0].open, { kind: 'money', tx: moneyStore(app).transactions()[0].id });
  r = await askEverything(app, 'what was 42.10', { sources: ['money'] });
  assert.match(r.groups[0]?.items[0]?.title ?? '', /hardware hut/i);
  // A member's space is their own app with its own store: nothing of the owner's.
  const { app: member } = setup(t);
  r = await askEverything(member, 'blue bottle coffee', { sources: ['money'] });
  assert.equal(r.groups.length, 0);
  (member as unknown as { member: { child: () => boolean } }).member = { child: () => true };
  assert.ok(askAllowed(member).skipped.some((x) => x.source === 'money'));
});

test('routes: members get their own Money, kids are refused, money is audited; the page says tracking only', () => {
  assert.ok(MEMBER_ROUTES.has('money'));
  assert.equal(childRouteCheck('k1', { child: true } as never, 'GET', ['money'])?.status, 403);
  const server = readFileSync(join(root, 'src', 'server.ts'), 'utf8');
  assert.match(server, /createMoneyRoutes/);
  assert.match(server, /'goal-plans', 'money'/, 'money changes get an audit row');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  assert.match(html, /<dialog id="money"/);
  assert.match(html, /data-dest="money"/);
  assert.match(html, /never logs in to a bank, pays, transfers or cancels anything/);
  const nav = readFileSync(join(root, 'web', 'nav.js'), 'utf8');
  assert.match(nav, /'trips', 'money'/);
  const helper = readFileSync(join(root, 'src', 'inbox', 'helper.ts'), 'utf8');
  assert.match(helper, /observeMoneyMail\(this\.#app, m\)/);
});

test('private local mode: import, overview and alerts need no network', async (t) => {
  const { app } = setup(t);
  const { setPrivateLocal } = await import('../src/net-guard.ts');
  setPrivateLocal?.(true);
  t.after(() => setPrivateLocal?.(false));
  const r = await importFile(app, { name: 'p.qif', bytes: Buffer.from('!Type:Bank\nD11/02/2026\nT-5.00\nPCORNER STORE\n^\n') });
  assert.equal(r.added, 1);
  const ov = moneyOverview(app, '2026-11');
  assert.equal(ov.month.spentCents, 500);
  assert.match(ov.trackingOnly, /never/);
  const src = readFileSync(join(root, 'src', 'money', 'hub.ts'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|netFetch/, 'no network in the Money hub');
});
