// E3 (docs/MONEY.md): money. Brokerage and bank export header mapping on invented fixtures, OFX/QFX,
// dedupe across imports, categories and the person's corrections, the subscription finder, summary
// math in cents, budget limits, bills on Planner reminders, the mail watch (a fake mail reader),
// portfolio value from fake quotes, the briefing line, Today's Money tile, household isolation,
// private chats, the persona and the lean picker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { gatherFacts, plainBriefing } from '../src/briefing.ts';
import { LIVE_DATA_TOOL, OFFSERVER_TOOL } from '../src/chat.ts';
import type { QuoteResult } from '../src/data-sources.ts';
import { LiveWatches } from '../src/live-watch.ts';
import { DEFAULT_LEAN, eligibleFor, familyOf, leanFor } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { categorize, findSubscriptions, merchantKey, monthPeriod, previousPeriod, summarize, type Tx } from '../src/money/budget.ts';
import { billReminder, moneyPart, nextDue, portfolioLine, valuePortfolio } from '../src/money/core.ts';
import { holdingsFromGrid, holdingsFromText, mapHeader, readHoldings, readTransactions } from '../src/money/parse.ts';
import { MoneyStore, moneyStore, type Bill } from '../src/money/store.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import { createMoneyTools } from '../src/tools/money.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-13T15:00:00Z'); // 9:00 AM in Chicago
const FX = join(import.meta.dirname, 'fixtures', 'e3');
const fx = (n: string) => readFileSync(join(FX, n));

function quotesOf(prices: Record<string, [number, number | null]>, at = '2026-11-13T14:31:00Z') {
  return async (syms: string[]): Promise<QuoteResult> => ({
    quotes: syms.filter((s) => prices[s]).map((s) => ({ symbol: s, price: prices[s][0], change: prices[s][1], changePct: null, currency: 'USD', source: 'Yahoo Finance', at, fetchedAt: at })),
    missing: syms.filter((s) => !prices[s]),
  });
}

function setup(t: { after: (fn: () => void) => void }, now = NOW): { app: TestApp; clock: { now: Date }; run: (n: string, a: Record<string, unknown>) => Promise<string>; conv: string; tools: Tool[]; add: (name: string) => void } {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const clock = { now };
  const app = makeApp(dir, clock);
  t.after(() => app.store.close());
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  const tools = createMoneyTools(() => app);
  for (const x of tools) app.tools.add(x);
  const conv = app.store.createConversation({ title: 'money' }).id;
  const ctx = (): ToolContext => ({ workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: 'tests' }, conversationId: conv }) as ToolContext;
  const add = (name: string) => app.library!.add({ name, bytes: fx(name), keep: true });
  return { app, clock, tools, conv, add, run: async (n, a) => String(await tools.find((x) => x.spec.name === n)!.run(a, ctx())) };
}

// ---------------------------------------------------------------- brokerage exports

test('holdings: Fidelity, Schwab, Vanguard, Robinhood and E*TRADE columns map by name; cash and totals handled', () => {
  const fid = readHoldings('Portfolio_Positions.csv', fx('fidelity-positions.csv'));
  assert.deepEqual(
    fid.map((h) => [h.account, h.symbol, h.qty, h.costCents, h.cashCents]),
    [
      ['Individual', 'CASH', 0, null, 152033],
      ['Individual', 'AAPL', 10, 120000, null],
      ['Individual', 'VTI', 5.5, 100000, null],
      ['ROTH IRA', 'FXAIX', 2.123, 30000, null],
    ],
  );
  const sch = readHoldings('schwab.csv', fx('schwab-positions.csv'), 'Schwab individual');
  assert.deepEqual(sch.map((h) => [h.account, h.symbol, h.qty, h.costCents, h.cashCents]), [
    ['Schwab individual', 'MSFT', 8, 240000, null],
    ['Schwab individual', 'SCHD', 20, null, null],
    ['Schwab individual', 'CASH', 0, null, 31050],
  ]);
  const vg = readHoldings('vanguard.csv', fx('vanguard-positions.csv'));
  assert.deepEqual(vg.map((h) => [h.account, h.symbol, h.qty, h.costCents]), [
    ['00000003', 'VTSAX', 12.5, null],
    ['00000003', 'VMFXX', 250.25, null],
  ], 'the transactions table under the positions is not read as holdings');
  const rh = readHoldings('robinhood.csv', fx('robinhood-positions.csv'));
  assert.deepEqual(rh.map((h) => [h.symbol, h.qty, h.costCents]), [['NVDA', 3, 30000], ['TSLA', 1.5, 30000]], 'average cost × shares');
  const et = readHoldings('etrade.csv', fx('etrade-positions.csv'));
  assert.deepEqual(et.map((h) => [h.symbol, h.qty, h.costCents, h.cashCents]), [['GOOG', 10, 150000, null], ['CASH', 0, null, 125000]]);
  assert.throws(() => holdingsFromGrid([['Name', 'Value'], ['x', '1']]), /Symbol \(or Ticker\)/);
  assert.throws(() => readHoldings('statement.pdf', Buffer.from('%PDF-1.4')), /PDF statements/);
});

test('holdings: header synonyms prefer the first listed; a plain typed list works', () => {
  assert.deepEqual(mapHeader(['Ticker', 'Shares', 'Avg Cost'], { symbol: ['symbol', 'ticker'], qty: ['quantity', 'shares'], cost: ['average cost', 'avg cost'] }), { symbol: 0, qty: 1, cost: 2 });
  const list = holdingsFromText('AAPL 10 @ 150\n10 shares of MSFT at 380.50\nVTI, 25, cost 5000\nI have 2 NVDA');
  assert.deepEqual(list.map((h) => [h.symbol, h.qty, h.costCents]), [['AAPL', 10, 150000], ['MSFT', 10, 380500], ['VTI', 25, 500000], ['NVDA', 2, null]]);
});

// ---------------------------------------------------------------- bank exports

test('transactions: Chase, Bank of America (summary block first) and Capital One (debit/credit) map by name', () => {
  const chase = readTransactions('Chase1234_Activity.csv', fx('chase-card.csv'), 'Chase card');
  assert.equal(chase.rows.length, 10);
  assert.deepEqual(chase.rows[0], { date: '2026-10-28', description: 'NETFLIX.COM', amountCents: -1549, account: 'Chase card', bankCategory: 'Entertainment' });
  assert.equal(chase.rows.find((r) => /Payment/.test(r.description))!.amountCents, 50000);
  const bofa = readTransactions('stmt.csv', fx('bofa-checking.csv'), 'Checking');
  assert.equal(bofa.rows.length, 5);
  assert.equal(bofa.skipped, 1, 'the beginning-balance row has no amount');
  assert.deepEqual(bofa.rows.map((r) => r.amountCents), [300000, -12000, -50000, -2499, -2499]);
  const c1 = readTransactions('transactions.csv', fx('capitalone-card.csv'));
  assert.deepEqual(c1.rows.map((r) => [r.date, r.amountCents, r.account]), [
    ['2026-10-02', -1199, '0000'],
    ['2026-10-04', 20000, '0000'],
    ['2026-10-09', -1820, '0000'],
    ['2026-09-02', -1199, '0000'],
  ]);
});

test('transactions: OFX (SGML) and QFX (XML) statements; charges written as positive numbers are flipped', () => {
  const o = readTransactions('checking.ofx', fx('checking.ofx'), 'Checking');
  assert.deepEqual(o.rows.map((r) => [r.date, r.amountCents, r.description, r.account]), [
    ['2026-10-05', -999, 'HULU 877-0000000 CA', 'Checking …2333'],
    ['2026-10-15', 150000, 'DIRECT DEP ACME', 'Checking …2333'],
    ['2026-10-20', -4550, 'WHOLEFDS MKT 10234', 'Checking …2333'],
  ]);
  const q = readTransactions('card.qfx', fx('card.qfx'), 'Card');
  assert.deepEqual(q.rows.map((r) => [r.amountCents, r.description, r.account]), [[-6400, 'CITGO 000 & MART', 'Card …9999'], [30000, 'ONLINE PAYMENT', 'Card …9999']]);
  const amex = readTransactions('amex.csv', Buffer.from('Date,Description,Amount\n10/01/2026,BLUE DOOR CAFE,23.45\n10/02/2026,KROGER,50.00\n10/03/2026,ONLINE PAYMENT - THANK YOU,-73.45\n'), 'Amex');
  assert.equal(amex.flipped, true);
  assert.deepEqual(amex.rows.map((r) => r.amountCents), [-2345, -5000, 7345]);
});

// ---------------------------------------------------------------- store: dedupe, categories, corrections

test('dedupe: importing the same export again adds nothing; two equal rows on one day both count', () => {
  const s = new MoneyStore(new DatabaseSync(':memory:'), () => NOW);
  const rows = readTransactions('c.csv', fx('chase-card.csv'), 'Chase card').rows;
  const first = s.importTransactions(rows);
  assert.equal(first.added.length, 10);
  assert.equal(first.added.filter((t) => t.merchant === 'blue door cafe').length, 2, 'two coffees the same day');
  const again = s.importTransactions(rows);
  assert.deepEqual([again.added.length, again.duplicates], [0, 10]);
  // An overlapping later export: only the new row is added.
  const later = s.importTransactions([...rows.slice(0, 3), { date: '2026-11-02', description: 'NETFLIX.COM', amountCents: -1549, account: 'Chase card', bankCategory: '' }]);
  assert.deepEqual([later.added.length, later.duplicates], [1, 3]);
  // Same row, another account: not a duplicate.
  assert.equal(s.importTransactions([{ ...rows[0], account: 'Other card' }]).added.length, 1);
});

test('categories: keyword table, the bank\'s own category, the sign; the person\'s correction moves rows and sticks', () => {
  const s = new MoneyStore(new DatabaseSync(':memory:'), () => NOW);
  s.importTransactions(readTransactions('c.csv', fx('chase-card.csv'), 'Chase card').rows);
  s.importTransactions(readTransactions('b.csv', fx('bofa-checking.csv'), 'Checking').rows);
  s.importTransactions(readTransactions('o.csv', fx('capitalone-card.csv')).rows);
  const cat = (m: string) => s.transactions().find((t) => t.merchant === m)?.category;
  assert.equal(merchantKey('TST* BLUE DOOR CAFE'), 'blue door cafe');
  assert.equal(merchantKey('KROGER #1234 AUSTIN TX'), 'kroger');
  assert.equal(merchantKey('NETFLIX.COM'), 'netflix');
  assert.equal(cat('netflix'), 'subscriptions');
  assert.equal(cat('kroger'), 'groceries');
  assert.equal(cat('shell oil'), 'fuel');
  assert.equal(cat('blue door cafe'), 'dining');
  assert.equal(cat('costco whse'), 'shopping');
  assert.equal(cat(merchantKey('Payment Thank You-Mobile')), 'transfers');
  assert.equal(cat(merchantKey('ACME CORP DES:PAYROLL ID:XXXXX INDN:ALEX SAMPLE CO ID:XXXXX PPD')), 'income');
  assert.equal(cat(merchantKey('CITY OF SPRINGFIELD DES:UTILITY ID:XXXX')), 'utilities');
  assert.equal(cat('planet fitness'), 'health');
  assert.equal(cat('uber eats'), 'dining');
  assert.equal(cat(merchantKey('CAPITAL ONE MOBILE PYMT')), 'transfers', "the bank's own category");
  assert.equal(categorize({ description: 'SOMETHING ODD', amountCents: -100 }, []), 'other');
  assert.equal(categorize({ description: 'SOMETHING ODD', amountCents: 100 }, []), 'income');
  const r = s.setRule('Costco', 'groceries');
  assert.deepEqual(r, { merchant: 'costco', changed: 1 });
  assert.equal(cat('costco whse'), 'groceries');
  const next = s.importTransactions([{ date: '2026-11-01', description: 'COSTCO WHSE #0456', amountCents: -9000, account: 'Chase card', bankCategory: 'Shopping' }]);
  assert.equal(next.added[0].category, 'groceries', 'remembered for later imports');
  assert.ok(s.removeRule('costco'));
});

// ---------------------------------------------------------------- summaries and subscriptions

const tx = (date: string, merchant: string, cents: number, category: string, id = 0): Tx => ({ id, date, description: merchant, merchant, amountCents: cents, account: 'A', category });

test('summary: totals by category in cents, against the month before, biggest changes and top merchants', () => {
  const list = [
    tx('2026-10-02', 'kroger', -8210, 'groceries'),
    tx('2026-10-15', 'kroger', -4590, 'groceries'),
    tx('2026-10-12', 'blue door cafe', -2345, 'dining'),
    tx('2026-10-05', 'amazon', 1299, 'shopping'), // a refund lowers spending
    tx('2026-10-06', 'amazon', -5000, 'shopping'),
    tx('2026-10-20', 'payment', 50000, 'transfers'),
    tx('2026-10-01', 'acme', 300000, 'income'),
    tx('2026-09-03', 'kroger', -10000, 'groceries'),
    tx('2026-09-10', 'blue door cafe', -1000, 'dining'),
    tx('2026-09-30', 'shell', -4000, 'fuel'),
  ];
  const s = summarize(list, monthPeriod('2026-10'));
  assert.deepEqual(s.period, { from: '2026-10-01', to: '2026-10-31', label: 'October 2026' });
  assert.equal(s.previous.label, 'September 2026');
  assert.deepEqual(s.spending.map((c) => [c.category, c.cents]), [['groceries', 12800], ['shopping', 3701], ['dining', 2345]]);
  assert.equal(s.spentCents, 18846);
  assert.equal(s.previousSpentCents, 15000);
  assert.equal(s.incomeCents, 300000);
  assert.deepEqual(s.changes.map((c) => [c.category, c.deltaCents]), [['fuel', -4000], ['shopping', 3701], ['groceries', 2800], ['dining', 1345]]);
  assert.deepEqual(s.topMerchants[0], { merchant: 'kroger', cents: 12800, count: 2 });
  assert.deepEqual(previousPeriod({ from: '2026-10-10', to: '2026-10-19', label: '' }), { from: '2026-09-30', to: '2026-10-09', label: '2026-09-30 to 2026-10-09' });
  assert.equal(monthPeriod('2028-02').to, '2028-02-29');
});

test('subscriptions: same merchant and amount monthly or yearly, next date and yearly cost; shopping trips are not', () => {
  const list = [
    tx('2026-08-28', 'netflix', -1549, 'subscriptions'),
    tx('2026-09-28', 'netflix', -1549, 'subscriptions'),
    tx('2026-10-28', 'netflix', -1799, 'subscriptions'), // a price rise is still the same subscription
    tx('2026-08-31', 'gym', -2499, 'health'),
    tx('2026-09-30', 'gym', -2499, 'health'),
    tx('2025-11-02', 'amazon prime', -13900, 'subscriptions'),
    tx('2026-11-01', 'amazon prime', -13900, 'subscriptions'),
    tx('2026-06-01', 'old app', -499, 'subscriptions'),
    tx('2026-07-01', 'old app', -499, 'subscriptions'),
    tx('2026-09-01', 'target', -4500, 'shopping'),
    tx('2026-09-09', 'target', -12000, 'shopping'),
    tx('2026-10-27', 'target', -3000, 'shopping'),
    tx('2026-09-05', 'kroger', -8000, 'groceries'),
    tx('2026-10-05', 'kroger', -8000, 'groceries'),
  ];
  const subs = findSubscriptions(list, '2026-11-13');
  const by = Object.fromEntries(subs.map((x) => [x.merchant, x]));
  assert.deepEqual(Object.keys(by).sort(), ['amazon prime', 'gym', 'netflix', 'old app']);
  assert.deepEqual([by.netflix.every, by.netflix.amountCents, by.netflix.next, by.netflix.yearlyCents, by.netflix.count], ['month', 1799, '2026-11-28', 21588, 3]);
  assert.deepEqual([by.gym.next, by.gym.maybeStopped], ['2026-10-30', false], 'the month-end charge clamps to Oct 30');
  assert.deepEqual([by['amazon prime'].every, by['amazon prime'].next, by['amazon prime'].yearlyCents], ['year', '2027-11-01', 13900]);
  assert.equal(by['old app'].maybeStopped, true);
  assert.equal(subs.at(-1)!.merchant, 'old app', 'stopped ones last');
});

// ---------------------------------------------------------------- tools: budget

test('budget tools: import from the Library, dedupe on a second import, summary, correction, subscriptions, limits told once', async (t) => {
  const { app, run, add } = setup(t);
  const sent: string[] = [];
  app.push = { notifyOwner: async (title: string, text: string) => void sent.push(`${title}: ${text}`) } as never;
  add('chase-card.csv');
  add('bofa-checking.csv');
  let out = await run('budget_import', { document: 'chase-card', account: 'Chase card' });
  assert.match(out, /Read 10 transactions from chase-card\.csv \(Fri, Aug 28 to Wed, Oct 28; accounts: Chase card\)\. Added 10; 0 were already loaded\./);
  assert.match(out, /Categories: .*subscriptions 3/);
  out = await run('budget_import', { document: 'chase-card', account: 'Chase card' });
  assert.match(out, /Added 0; 10 were already loaded/);
  await run('budget_import', { document: 'bofa-checking', account: 'Checking' });
  out = await run('budget_summary', { month: '2026-10' });
  assert.match(out, /^October 2026: spent \$341\.48 over 12 transactions; September 2026: \$165\.49 \(\+\$175\.99\)\. Income \$3,000\.00\./);
  assert.match(out, /- utilities: \$120\.00/);
  assert.match(out, /Top merchants: city of springfield \$120\.00 \(1\); kroger \$82\.10 \(1\)/);
  assert.match(out, /- shopping: -\$12\.99/, 'a refund month');
  out = await run('budget_category', { merchant: 'COSTCO WHSE', category: 'grocery' });
  assert.match(out, /“costco whse” is groceries; 1 loaded transaction moved/);
  out = await run('budget_limit', { category: 'dining', amount: '40' });
  assert.match(out, /Limit for dining: \$40\.00 a month/);
  assert.equal(sent.length, 0, 'October is not this month');
  add('capitalone-card.csv');
  // This month (November): a dining charge over the limit, told once.
  app.library!.add({ name: 'nov.csv', bytes: Buffer.from('Date,Description,Amount\n11/02/2026,TST* BLUE DOOR CAFE,-45.00\n'), keep: true });
  out = await run('budget_import', { document: 'nov.csv', account: 'Chase card' });
  assert.match(out, /Over the limit \(told once this month\): dining: \$45\.00 this month, over your \$40\.00 limit/);
  assert.equal(sent.length, 1);
  app.library!.add({ name: 'nov2.csv', bytes: Buffer.from('Date,Description,Amount\n11/05/2026,DINER 24,-5.00\n'), keep: true });
  out = await run('budget_import', { document: 'nov2.csv', account: 'Chase card' });
  assert.doesNotMatch(out, /Over the limit/);
  assert.equal(sent.length, 1, 'once a month');
  out = await run('budget_subscriptions', {});
  assert.match(out, /- netflix: \$15\.49 every month \(3 charges, last Wed, Oct 28\) · next expected Sat, Nov 28 · \$185\.88 a year/);
  assert.doesNotMatch(out, /planet fitness/, 'two charges 5 days apart are not a subscription');
});

// ---------------------------------------------------------------- bills

test('bills: monthly reminders 3 days before at 9 AM local, paid moves to the next month; yearly and once', async (t) => {
  const { app, run } = setup(t);
  let out = await run('bill_add', { name: 'Electric', amount: '120', due_day: 20, repeat: 'monthly' });
  assert.match(out, /Bill #1 added: #1 Electric · \$120\.00 · monthly on day 20 · due Fri, Nov 20 \(in 7 days\)/);
  const rem = app.planner!.reminders({ status: 'pending' });
  assert.equal(rem.length, 1);
  assert.equal(rem[0].dueAt, '2026-11-17T15:00:00.000Z', 'Nov 17, 9 AM Chicago');
  assert.equal(rem[0].repeat, 'monthly');
  assert.match(rem[0].text, /Electric \(\$120\.00\) is due on the 20th, in 3 days\./);
  out = await run('bill_paid', { bill: 'electric' });
  assert.match(out, /Marked Electric paid for Fri, Nov 20\. Next due Sun, Dec 20, with a reminder 3 days before/);
  const after = app.planner!.reminders({ status: 'pending' });
  assert.equal(after.length, 1);
  assert.equal(after[0].dueAt, '2026-12-17T15:00:00.000Z');
  out = await run('bill_add', { name: 'Car insurance', amount: '600', due_date: '2026-03-01', repeat: 'yearly', autopay: true });
  assert.match(out, /due Mon, Mar 1 \(in 108 days\) · autopay/, 'a past yearly date rolls to next year');
  out = await run('bill_add', { name: 'Dentist', amount: '80', due_date: '2026-11-14', repeat: 'once' });
  assert.match(out, /due in 1 days, sooner than the reminder would be: tell them now/);
  out = await run('bill_list', {});
  assert.match(out, /^- #3 Dentist/);
  assert.match(out, /Due within 7 days: 1 \(\$80\.00\)/);
  out = await run('bill_paid', { bill: '3' });
  assert.match(out, /it's done/);
  out = await run('bill_remove', { bill: 'car' });
  assert.match(out, /Stopped tracking Car insurance/);
  assert.equal(nextDue({ repeat: 'monthly', dueDay: 31, dueDate: null }, '2027-02-01'), '2027-02-28');
  const b = { id: 9, name: 'Rent', amountCents: null, repeat: 'monthly', dueDay: 1, dueDate: null, autopay: false, leadDays: 3, reminderId: null, paidFor: null, paidAt: null, done: false, createdAt: '' } as Bill;
  assert.equal(billReminder(b, 'America/Chicago', NOW)!.dueAt, '2026-11-28T15:00:00.000Z', 'rent on the 1st: the 28th before');
});

// ---------------------------------------------------------------- portfolio

test('portfolio: value, day change, gain against cost and allocation from fake quotes, in cents', async () => {
  const s = new MoneyStore(new DatabaseSync(':memory:'), () => NOW);
  s.importHoldings(readHoldings('f.csv', fx('fidelity-positions.csv')));
  const v = await valuePortfolio(s.holdings(), quotesOf({ AAPL: [151.25, 1.25], VTI: [199.5, -0.5], FXAIX: [181.0, null] }));
  assert.equal(v.valueCents, 152033 + 151250 + 109725 + 38426); // FXAIX 2.123 × 181 = 384.263
  assert.equal(v.dayChangeCents, 1250 - 275);
  assert.equal(v.dayPct, 0.22);
  assert.equal(v.costCents, 250000);
  assert.equal(v.gainCents, 151250 + 109725 + 38426 - 250000);
  assert.equal(v.rows[0].symbol, 'AAPL');
  assert.equal(v.rows[0].allocationPct, 33.5);
  assert.equal(v.source, 'Yahoo Finance');
  const some = await valuePortfolio(s.holdings(), quotesOf({ AAPL: [150, 0] }));
  assert.deepEqual(some.missing, ['VTI', 'FXAIX']);
  assert.equal(some.valueCents, 152033 + 150000, 'missing prices are left out, never guessed');
});

test('portfolio tools: import a list, show with source and time; briefing line; Today Money tile only once used', async (t) => {
  const { app, run, add } = setup(t);
  const ctx = (day = '2026-11-13') => ({ app, demo: false, day, now: NOW }) as never;
  assert.equal(await moneyPart(ctx()), undefined, 'nothing until used');
  assert.equal(await portfolioLine(app), undefined);
  app.dataSources = { quotes: quotesOf({ MSFT: [400, 4], SCHD: [27.5, -0.1] }) } as never;
  add('schwab-positions.csv');
  let out = await run('portfolio_import', { document: 'schwab', account: 'Schwab' });
  assert.match(out, /Loaded 3 holdings from schwab-positions\.csv \(accounts: Schwab;/);
  assert.match(out, /No cost basis for SCHD/);
  out = await run('portfolio_show', {});
  assert.match(out, /^Portfolio value: \$4,060\.50 · today \+\$30\.00 \(\+0\.74%\) · total gain \+\$800\.00 \(\+33\.33%\) on a cost basis of \$2,400\.00\./);
  assert.match(out, /- MSFT \(MICROSOFT CORP\): 8 × 400 = \$3,200\.00 · 78\.8%/);
  assert.match(out, /Prices from Yahoo Finance, as of Nov 13, 8:31 AM CST/);
  assert.match(out, /not financial advice/);
  const line = await portfolioLine(app);
  assert.equal(line, 'Portfolio: $4,061, +0.7% today (Yahoo Finance, 8:31 AM)');
  const facts = await gatherFacts(app, NOW, async () => new Response('{}'));
  assert.equal(facts.money, line);
  assert.match(plainBriefing(facts), /Portfolio: \$4,061, \+0\.7% today/);
  // A plain list replaces that account's holdings.
  out = await run('portfolio_import', { text: 'MSFT 10 @ 300', account: 'Schwab' });
  assert.equal(moneyStore(app).holdings().length, 1);
  const tile = await moneyPart(ctx());
  assert.equal(tile?.portfolio?.source, 'Yahoo Finance');
  await run('bill_add', { name: 'Phone', amount: '45', due_day: 16 });
  assert.deepEqual((await moneyPart(ctx()))?.bills, { count: 1, totalCents: 4500, next: { name: 'Phone', due: '2026-11-16', autopay: false } });
  // The source down: the last value, said as such.
  app.dataSources = { quotes: async () => { throw new Error('down'); } } as never;
  assert.match((await portfolioLine(app))!, /^Portfolio: \$4,000 at the last check \(Yahoo Finance, 2026-11-13 8:31 AM\); no fresh prices right now\.$/);
});

// ---------------------------------------------------------------- mail watch

test('mail watch: fires once per new matching message after it was set, sender and subject only; needs a mailbox', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation({ title: 'chat' }).id;
  let threads: Record<string, unknown>[] = [];
  const reads: number[] = [];
  const lw = new LiveWatches(app, app.store.db, async (_a, days) => {
    reads.push(days);
    return { threads: threads as never, problems: [] };
  });
  assert.throws(() => lw.add({ kind: 'mail', when: 'arrives', from: 'dana' }), /No mailbox is connected/);
  app.mailAccounts = { list: () => [{ id: 'm1', kind: 'imap', provider: 'fastmail', address: 'alex@example.com', addedAt: '', calendar: false }] } as never;
  assert.throws(() => lw.add({ kind: 'mail', when: 'arrives' }), /from\) or which words/);
  const w = lw.add({ kind: 'mail', when: 'arrives', from: 'Dana', how: 'chat', conversationId: conv });
  assert.equal(w.label, 'Email from Dana');
  const words = lw.add({ kind: 'mail', when: 'arrives', words: 'invoice, contract', how: 'chat', conversationId: conv });
  const m = (id: string, from: string, subject: string, date: string, snippet = 'private words in the body') => ({ account: 'alex@example.com', threadId: `t${id}`, latestId: id, from, to: 'alex@example.com', cc: '', subject, date, snippet, unread: true, count: 1, fromMe: false, headers: {} });
  threads = [m('1', 'Dana Rivera <dana@client.example>', 'Old news', '2026-11-13T14:00:00Z'), m('2', 'Sam <sam@example.com>', 'Lunch?', '2026-11-13T15:05:00Z')];
  clock.now = new Date('2026-11-13T15:10:00Z');
  assert.equal(await lw.check(clock.now), 0, 'older than the watch, or not from Dana');
  threads.push(m('3', 'Dana Rivera <dana@client.example>', 'Signed contract attached', '2026-11-13T15:12:00Z'));
  clock.now = new Date('2026-11-13T15:16:00Z');
  assert.equal(await lw.check(clock.now), 0, 'mail is read at most every 10 minutes');
  clock.now = new Date('2026-11-13T15:21:00Z');
  assert.equal(await lw.check(clock.now), 2, 'the from-watch and the words-watch both match');
  const notes = app.store.messages(conv).filter((x) => x.role === 'notice').map((x) => x.content);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^livewatch:New email from Dana Rivera <dana@client\.example>: “Signed contract attached” \(alex@example\.com, Nov 13, 9:12 AM CST\)\. Open your mail to read it\.$/);
  assert.ok(!notes.join('\n').includes('private words'), 'the message body stays in the mailbox');
  clock.now = new Date('2026-11-13T15:32:00Z');
  assert.equal(await lw.check(clock.now), 0, 'once per message');
  assert.deepEqual(reads, [2, 2, 2]);
  assert.equal(lw.get(words.id)!.fired, 1);
});

// ---------------------------------------------------------------- spaces, privacy, persona, picker

test('household isolation: each space has its own money; a companion shares its person\'s store', () => {
  const main = { store: { db: new DatabaseSync(':memory:') }, now: () => NOW };
  const second = { store: { db: new DatabaseSync(':memory:') }, now: () => NOW, companions: { main: { app: main } } };
  const member = { store: { db: new DatabaseSync(':memory:') }, now: () => NOW };
  moneyStore(second).importHoldings(holdingsFromText('AAPL 1'));
  moneyStore(second).importTransactions([{ date: '2026-11-01', description: 'X', amountCents: -100, account: 'A', bankCategory: '' }]);
  assert.equal(moneyStore(main).holdings().length, 1);
  assert.ok(moneyStore(main).hasTransactions());
  assert.equal(moneyStore(member).holdings().length, 0);
  assert.equal(moneyStore(member).hasTransactions(), false);
});

test('private chats: prices are off (network); chats with someone else get nothing of the person\'s money', async (t) => {
  const { app, tools } = setup(t);
  assert.ok(LIVE_DATA_TOOL('portfolio_show') && OFFSERVER_TOOL('portfolio_show'));
  assert.ok(!LIVE_DATA_TOOL('budget_summary'), 'budget math is local');
  app.dataSources = { quotes: quotesOf({}) } as never;
  const conv = app.store.createConversation({ title: 'p' });
  const priv = eligibleFor(app, { ...conv, private: true }).map((x) => x.spec.name);
  assert.ok(!priv.includes('portfolio_show') && priv.includes('budget_summary'));
  const { setPrivateLocal } = await import('../src/net-guard.ts');
  setPrivateLocal(true);
  try {
    assert.equal(tools.find((x) => x.spec.name === 'portfolio_show')!.isAvailable!(), false);
  } finally {
    setPrivateLocal(false);
  }
  const partner = app.store.createConversation({ title: 'Sam', partner: 'Sam', channel: 'telegram', channelKey: '9' });
  await assert.rejects(tools.find((x) => x.spec.name === 'budget_summary')!.run({}, { conversationId: partner.id } as never), /private to the person/);
});

test('persona: money is information and math, numbers from the tools with their age, never advice', () => {
  const persona = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'persona', 'sara.json'), 'utf8'));
  const p = buildSystemPrompt(persona, { now: NOW, ownerName: 'Alex', tools: ['portfolio_show', 'budget_summary', 'bill_add'] });
  assert.match(p, /## Money/);
  assert.match(p, /not financial advice/);
  assert.match(p, /how old the prices are/);
  assert.doesNotMatch(buildSystemPrompt(persona, { now: NOW, ownerName: 'Alex', tools: ['remind'] }), /## Money/);
});

test('lean picker: the money tools are one family, found for their words in six languages', (t) => {
  const { tools } = setup(t);
  for (const x of tools) assert.equal(familyOf(x).id, 'money', x.spec.name);
  const lean = { ...DEFAULT_LEAN.tools, mode: 'always' as const, localCore: true };
  const msgs = ['how is my portfolio', 'how are my stocks', 'show my holdings', 'what did I spend on food', 'my budget', 'find my subscriptions', 'which bills are due', 'here is my bank statement', 'mi presupuesto', 'cuánto gasté', 'mes abonnements', 'mon budget', 'meine Ausgaben', 'Kontoauszug', 'minhas assinaturas', 'meu orçamento', 'le mie spese', 'estratto conto'];
  for (const msg of msgs) {
    const tt = leanFor(lean, tools, { text: msg, mode: 'chat', local: true, turnId: 1, ownerTurnIds: [1] });
    assert.ok(tt.offeredNames(tools).some((n) => tools.some((x) => x.spec.name === n)), msg);
  }
});
