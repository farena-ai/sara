// E6 (docs/BUSINESS_TOOLS.md): invoices and quotes, follow-ups, contract reading, expenses, action
// items. Money math, numbering, status and reminders; fixture threads; a fixture contract; receipts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { findActionItems, dueAtOf } from '../src/biz/actions.ts';
import { extractContract, sentencesOf, verifyQuotes } from '../src/biz/contracts.ts';
import { expenseReport, parseReceipt, receiptDate } from '../src/biz/expenses.ts';
import { looksAutomated, rankFollowUps, type ThreadTip } from '../src/biz/followups.ts';
import { dueReminders, xlsxItemTable } from '../src/biz/invoices.ts';
import { fmtMoney, roundHalf, toCents, totals } from '../src/biz/money.ts';
import { BizStore, bizStore, shownStatus } from '../src/biz/store.ts';
import { madeDocs } from '../src/documents/make.ts';
import { cleanSpec } from '../src/documents/spec.ts';
import { makeXlsx } from '../src/documents/xlsx.ts';
import { DEFAULT_LEAN, familyOf, leanFor } from '../src/lean.ts';
import { readXlsxCells } from '../src/library/ooxml.ts';
import { readDocument } from '../src/library/read.ts';
import { LibraryStore } from '../src/library/store.ts';
import { Zip } from '../src/library/zip.ts';
import { createBizTools } from '../src/tools/biz.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-13T15:00:00Z');

function setup(t: { after: (fn: () => void) => void }, now = NOW): { app: TestApp; tool: (n: string) => Tool; run: (n: string, a: Record<string, unknown>) => Promise<string>; conv: string } {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now });
  app.library = new LibraryStore(app.store.db, dir, () => now);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  const tools = createBizTools(() => app);
  for (const x of tools) app.tools.add(x);
  const conv = app.store.createConversation({ title: 'work' }).id;
  const tool = (n: string) => tools.find((x) => x.spec.name === n)!;
  const ctx = (): ToolContext => ({ workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: 'tests' }, conversationId: conv }) as ToolContext;
  return { app, tool, conv, run: async (n, a) => String(await tool(n).run(a, ctx())) };
}

// ---------------------------------------------------------------- money

test('money: amounts parse to cents, line amounts and tax round half away from zero, totals add as integers', () => {
  assert.equal(toCents('$1,234.56'), 123456);
  assert.equal(toCents('1.234,56 €'), 123456);
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents('85'), 8500);
  assert.equal(toCents('12,5'), 1250);
  assert.equal(toCents('(4.20)'), -420);
  assert.equal(toCents('abc'), undefined);
  assert.equal(roundHalf(2998.5), 2999);
  assert.equal(roundHalf(-2.5), -3);
  const t = totals([{ desc: 'Design', qty: 1.5, unitCents: 1999 }, { desc: 'Hosting', qty: 3, unitCents: 3333 }], 8.25);
  assert.deepEqual(t.lines.map((l) => l.amountCents), [2999, 9999]);
  assert.equal(t.subtotalCents, 12998);
  assert.equal(t.taxCents, 1072); // 12998 × 8.25% = 1072.335
  assert.equal(t.totalCents, 14070);
  assert.equal(totals([{ desc: 'x', qty: 1, unitCents: 1000 }], 8.25).taxCents, 83); // 82.5 rounds up
  assert.equal(fmtMoney(14070), '$140.70');
});

// ---------------------------------------------------------------- invoices

test('invoices: numbers run per kind and year; each household space has its own series', () => {
  const a = new BizStore(new DatabaseSync(':memory:'), () => NOW);
  const b = new BizStore(new DatabaseSync(':memory:'), () => NOW);
  const mk = (s: BizStore, kind: 'invoice' | 'quote', issued = '2026-11-13') => s.createInvoice({ kind, clientName: 'Rivera Co', items: [{ desc: 'Work', qty: 1, unitCents: 10000 }], issued, dueDays: 30 });
  assert.equal(mk(a, 'invoice').number, 'INV-2026-0001');
  assert.equal(mk(a, 'invoice').number, 'INV-2026-0002');
  assert.equal(mk(a, 'quote').number, 'Q-2026-0001');
  assert.equal(mk(a, 'invoice', '2027-01-02').number, 'INV-2027-0001');
  assert.equal(mk(b, 'invoice').number, 'INV-2026-0001', "another person's space starts its own series");
  assert.equal(a.invoices().length, 4);
  assert.equal(b.invoices().length, 1);
  assert.equal(a.find('INV-2026-0002')?.number, 'INV-2026-0002');
  assert.equal(a.find('inv 2')?.number, 'INV-2026-0002');
  assert.equal(a.find('q 1')?.number, 'Q-2026-0001');
});

test('invoices: overdue is worked out from the due date; reminders the day before and 3 days after, at 9 AM local', () => {
  const s = new BizStore(new DatabaseSync(':memory:'), () => NOW);
  const inv = s.createInvoice({ kind: 'invoice', clientName: 'Rivera Co', items: [{ desc: 'Work', qty: 2, unitCents: 5000 }], issued: '2026-11-13', dueDays: 14 });
  assert.equal(inv.due, '2026-11-27');
  assert.equal(shownStatus(inv, '2026-11-28'), 'draft');
  const sent = s.setInvoice(inv.id, { status: 'sent' })!;
  assert.equal(shownStatus(sent, '2026-11-27'), 'sent');
  assert.equal(shownStatus(sent, '2026-11-28'), 'overdue');
  const r = dueReminders(sent, 'America/Chicago', NOW);
  assert.deepEqual(r.map((x) => x.dueAt), ['2026-11-26T15:00:00.000Z', '2026-11-30T15:00:00.000Z']);
  assert.match(r[0].text, /Invoice INV-2026-0001 to Rivera Co \(\$100\.00\) is due tomorrow/);
  assert.match(r[1].text, /3 days overdue/);
  assert.deepEqual(dueReminders(sent, 'America/Chicago', new Date('2026-11-27T00:00:00Z')).length, 1, 'past reminders are not set');
  assert.equal(s.moneyIn('2026-11-28')?.overdue, 1);
  assert.equal(s.moneyIn('2026-11-28')?.unpaidCents, 10000);
});

test('invoice tools: make (pdf + docx), list, mark sent (reminders), mark paid (reminders cleared)', async (t) => {
  const { app, run } = setup(t);
  bizStore(app).saveDetails({ name: 'Alex Design LLC', address: '12 Main St\nSpringfield', payment: 'Bank transfer to account 000-111', taxRatePct: 8.25, dueDays: 14 });
  const out = await run('invoice_make', { client: 'Rivera Co <billing@rivera.example>', items: [{ desc: 'Logo design', qty: 1.5, unit_price: 19.99 }, { desc: 'Hosting', qty: 3, unit_price: '33.33' }], format: 'both' });
  assert.match(out, /Made invoice INV-2026-0001 for Rivera Co <billing@rivera\.example>/);
  assert.match(out, /Subtotal \$129\.98, tax 8\.25% \$10\.72, total \$140\.70, due Nov 27, 2026\. Status: draft\./);
  const docs = madeDocs(app);
  const inv = bizStore(app).find('INV-2026-0001')!;
  assert.equal(inv.docIds.length, 2);
  const formats = inv.docIds.map((id) => docs.get(id)!.format).sort();
  assert.deepEqual(formats, ['docx', 'pdf']);
  const docx = app.library!.file(app.library!.get(docs.get(inv.docIds.find((id) => docs.get(id)!.format === 'docx')!)!.libraryId!)!)!;
  const read = (await readDocument('i.docx', docx)).parts.map((p) => p.text).join('\n');
  assert.match(read, /Invoice INV-2026-0001/);
  assert.match(read, /Alex Design LLC/);
  assert.match(read, /\$140\.70/);
  assert.match(read, /Bank transfer to account 000-111/);
  assert.match(await run('invoice_list', {}), /INV-2026-0001 · Rivera Co · \$140\.70 · draft/);
  const sent = await run('invoice_mark', { id: 'INV-2026-0001', status: 'sent' });
  assert.match(sent, /is now sent\. Reminders set: Nov 26, 2026 \(due tomorrow\), Nov 30, 2026 \(if still unpaid\)/);
  const rem = app.planner!.reminders({ status: 'pending' });
  assert.equal(rem.length, 2);
  assert.match(await run('invoice_list', { status: 'unpaid' }), /Unpaid: \$140\.70 on 1 invoice/);
  const paid = await run('invoice_mark', { id: '1', status: 'paid', date: '2026-11-20' });
  assert.match(paid, /is now paid as of Nov 20, 2026\. Its due reminders were cleared\./);
  assert.equal(app.planner!.reminders({ status: 'pending' }).length, 0);
  await assert.rejects(run('invoice_mark', { id: 'INV-2026-0001', status: 'accepted' }), /is an invoice/);
  await assert.rejects(run('invoice_make', { client: 'X', items: [{ desc: 'a', qty: 0, unit_price: 5 }] }), /qty must be a number above 0/);
  // A quote: its own series, "valid until", accepted.
  assert.match(await run('invoice_make', { kind: 'quote', client: 'Ben', items: [{ desc: 'Survey', qty: 1, unit_price: 250 }], tax_rate: 0 }), /Made quote Q-2026-0001 .* total \$250\.00, valid until/);
  assert.match(await run('invoice_mark', { id: 'Q-2026-0001', status: 'accepted' }), /is now accepted/);
});

test("invoice from the person's own Excel template: labels and the item table filled in a copy", async (t) => {
  const { app, run } = setup(t);
  const tpl = makeXlsx(cleanSpec({ format: 'xlsx', title: 'My invoice', sheets: [{ name: 'Invoice', rows: [['INVOICE #:', null], ['DATE:', null], ['BILL TO:', null], [], ['Description', 'Qty', 'Rate', 'Amount'], [null, null, null, null], [null, null, null, null], [], ['TOTAL:', null]], head: 4, tableRows: 3 }] }));
  assert.deepEqual(xlsxItemTable(tpl), { sheet: 'Invoice', row: 5, cols: { desc: 'A', qty: 'B', unit: 'C', amount: 'D' } });
  const lib = app.library!.add({ name: 'My Invoice Template.xlsx', bytes: tpl, keep: true, origin: 'library', learn: false });
  const out = await run('invoice_make', { client: 'Rivera Co', items: [{ desc: 'Logo design', qty: 2, unit_price: 100 }, { desc: 'Cards', qty: 1, unit_price: 45.5 }], tax_rate: 0, template: 'invoice template' });
  assert.match(out, /Filled \d+ of \d+ places in their template “My Invoice Template\.xlsx”/);
  const inv = bizStore(app).find('INV-2026-0001')!;
  const m = madeDocs(app).get(inv.docIds[0])!;
  assert.equal(m.format, 'xlsx');
  const cells = readXlsxCells(new Zip(app.library!.file(app.library!.get(m.libraryId!)!)!)).get('Invoice')!;
  assert.equal(cells.get('B1'), 'INV-2026-0001');
  assert.equal(cells.get('B3'), 'Rivera Co');
  assert.equal(cells.get('A6'), 'Logo design');
  assert.equal(cells.get('D6'), '200');
  assert.equal(cells.get('A7'), 'Cards');
  assert.equal(cells.get('B9'), '$245.50');
  assert.ok(app.library!.file(app.library!.get(lib.id)!)!.equals(tpl), 'the template itself is unchanged');
});

// ---------------------------------------------------------------- follow-ups

const th = (o: Partial<ThreadTip>): ThreadTip => ({ account: 'alex@example.com', threadId: 't', latestId: 'm', from: 'Dana <dana@client.example>', to: 'alex@example.com', cc: '', subject: 'Proposal', date: '2026-11-08T15:00:00Z', snippet: 'Can you send the numbers?', unread: false, count: 2, fromMe: false, headers: {}, ...o });

test('follow-ups: only people writing to them, not answered, not automated, older than N days; questions first', () => {
  const threads = [
    th({ threadId: 'q', latestId: 'q1' }),
    th({ threadId: 'fyi', latestId: 'f1', snippet: 'Here are the notes from today.', date: '2026-11-03T15:00:00Z', count: 1 }),
    th({ threadId: 'mine', fromMe: true }),
    th({ threadId: 'me2', from: 'Alex <alex@example.com>' }),
    th({ threadId: 'news', from: 'Shop <newsletter@shop.example>' }),
    th({ threadId: 'list', headers: { 'list-unsubscribe': '<mailto:x>' } }),
    th({ threadId: 'auto', headers: { 'auto-submitted': 'auto-generated' } }),
    th({ threadId: 'receipt', from: 'Billing <hello@app.example>', subject: 'Your order has shipped' }),
    th({ threadId: 'cc', to: 'boss@example.com', cc: 'alex@example.com' }),
    th({ threadId: 'new', date: '2026-11-13T09:00:00Z' }),
    th({ threadId: 'promo', category: 'promotions' }),
  ];
  const out = rankFollowUps(threads, ['alex@example.com'], NOW, 2);
  assert.deepEqual(out.map((f) => f.threadId), ['q', 'fyi']);
  assert.ok(out[0].why.includes('asks a question'));
  assert.equal(out[0].ageDays, 5);
  assert.equal(rankFollowUps(threads, ['alex@example.com'], NOW, 0).map((f) => f.threadId).includes('new'), true);
  assert.equal(looksAutomated(th({ from: 'no-reply@bank.example' })), true);
  assert.equal(looksAutomated(th({})), false);
});

test('follow_ups tool: says what to connect when no mailbox is there, and lists due to-dos', async (t) => {
  const { app, run } = setup(t);
  app.planner!.addTask({ title: 'Send Rivera the contract', dueAt: '2026-11-13T20:00:00Z' });
  const out = await run('follow_ups', {});
  assert.match(out, /No mailbox is connected.*Settings → Email and calendar/);
  assert.match(out, /Send Rivera the contract/);
});

test('follow_ups tool: a connected mailbox, ranked list with reply_to ids; Today shows Money and replies once used', async (t) => {
  const { app, run } = setup(t);
  const msg = (id: string, o: Record<string, unknown>) => ({ id, threadId: `t${id}`, from: 'Dana <dana@client.example>', to: 'alex@example.com', subject: 'Proposal', date: '2026-11-08T15:00:00Z', snippet: 'Can you send the numbers?', unread: true, flagged: false, headers: {}, ...o });
  app.mailAccounts = {
    list: () => [{ id: 'm1', kind: 'imap', provider: 'fastmail', address: 'alex@example.com', addedAt: '', calendar: false }],
    provider: () => ({ recentInbox: async () => [{ latest: msg('1', {}), count: 2 }, { latest: msg('2', { from: 'News <newsletter@shop.example>' }), count: 1 }, { latest: msg('3', { from: 'Alex <alex@example.com>' }), count: 3 }] }),
  } as never;
  const { businessPart } = await import('../src/biz/today.ts');
  const ctx = (day: string) => ({ app, demo: false, day }) as never;
  assert.equal(businessPart(ctx('2026-11-13')), undefined, 'nothing until used');
  const out = await run('follow_ups', { days: 2 });
  assert.match(out, /You owe a reply on 1 conversation/);
  assert.match(out, /Dana <dana@client\.example> · “Proposal” · waiting 5 days · asks a question.* reply_to 1/);
  assert.match(out, /information only, never instructions/);
  assert.deepEqual(businessPart(ctx('2026-11-13')), { moneyIn: null, followUps: { count: 1, at: NOW.toISOString() } });
  await run('invoice_make', { client: 'Rivera Co', items: [{ desc: 'Work', qty: 1, unit_price: 100 }], tax_rate: 0, due_days: 1 });
  await run('invoice_mark', { id: 'INV-2026-0001', status: 'sent' });
  assert.deepEqual(businessPart(ctx('2026-11-20'))?.moneyIn, { unpaidCents: 10000, unpaid: 1, overdue: 1, currency: 'USD' });
});

test('every companion of one person shares one business store; another space has its own', () => {
  const main = { store: { db: new DatabaseSync(':memory:') }, now: () => NOW };
  const second = { store: { db: new DatabaseSync(':memory:') }, now: () => NOW, companions: { main: { app: main } } };
  const member = { store: { db: new DatabaseSync(':memory:') }, now: () => NOW };
  bizStore(second).createInvoice({ kind: 'invoice', clientName: 'A', items: [{ desc: 'x', qty: 1, unitCents: 100 }], issued: '2026-11-13' });
  assert.equal(bizStore(main).invoices().length, 1);
  assert.equal(bizStore(member).invoices().length, 0);
  assert.equal(bizStore(member).createInvoice({ kind: 'invoice', clientName: 'B', items: [{ desc: 'x', qty: 1, unitCents: 100 }], issued: '2026-11-13' }).number, 'INV-2026-0001');
});

// ---------------------------------------------------------------- contracts

const CONTRACT = `[page 1]
SERVICES AGREEMENT

This Services Agreement is made by and between Northwind Studio LLC ("Provider") and Rivera Co ("Client").

1. Term. This Agreement is effective as of January 1, 2027 and ends on December 31, 2027. This Agreement shall automatically renew for successive one-year terms unless either party gives sixty (60) days' written notice of non-renewal before the end of the then-current term.

2. Fees. Client shall pay Provider $4,500.00 per month, due on the first day of each month. Late payments accrue interest at 2% per month.

[page 2]
3. Liability. Provider's liability under this Agreement shall not be limited in amount.

4. Non-Competition. During the term, Provider shall not provide services to any competitor of Client.

5. Disputes. Any dispute shall be resolved by binding arbitration in Austin, Texas, and each party waives any right to a jury trial.

6. Changes. Provider may modify these terms at any time without notice.

7. Indemnification. Client shall indemnify and hold Provider harmless from all claims arising from Client's content.

8. Termination. Either party may terminate this Agreement for material breach with thirty (30) days' written notice.
`;

test('contract: dates, notice deadline, money, rates and the checklist, each with its sentence and page/section', () => {
  const ss = sentencesOf(CONTRACT);
  assert.ok(ss.some((s) => s.page === 2 && /Section 3/.test(s.section)));
  const f = extractContract(CONTRACT);
  assert.deepEqual(f.parties.map((p) => p.value), ['Northwind Studio LLC', 'Rivera Co']);
  assert.ok(f.dates.some((d) => d.kind === 'start' && d.norm === '2027-01-01'));
  assert.ok(f.dates.some((d) => d.norm === '2027-12-31'));
  const notice = f.deadlines.find((d) => /Last day to give notice/.test(d.what));
  assert.ok(notice, JSON.stringify(f.deadlines));
  assert.equal(notice.day, '2027-11-01', '60 days before Dec 31, 2027');
  assert.match(notice.where, /page 1, Section 1/);
  assert.ok(f.money.some((m) => m.norm === 450000 && /due on the first day/.test(m.quote)));
  assert.ok(f.rates.some((r) => r.norm === 2));
  const ids = f.flags.map((x) => x.id).sort();
  assert.deepEqual(ids, ['arbitration', 'auto_renewal', 'indemnity', 'late_fee', 'non_compete', 'unilateral_changes', 'unlimited_liability']);
  assert.match(f.flags.find((x) => x.id === 'unlimited_liability')!.where, /page 2/);
  assert.ok(f.termination.some((x) => /material breach/.test(x.quote)));
  // A late fee at or under 1.5% a month is not flagged; 18% a year is exactly 1.5.
  assert.equal(extractContract('Late payments accrue interest at 18% per annum.').flags.length, 0);
  assert.equal(extractContract('Late payments accrue interest at 1% per month.').flags.length, 0);
});

test('contract: the model\'s points are kept only with a word-for-word quote', () => {
  const { kept, rejected } = verifyQuotes(CONTRACT, [
    { topic: 'obligations', point: 'Client pays monthly', quote: 'Client shall pay Provider $4,500.00 per month' },
    { topic: 'obligations', point: 'Curly quotes and spacing are fine', quote: 'Client  shall indemnify and hold Provider harmless' },
    { topic: 'termination', point: 'Either side can leave anytime', quote: 'Either party may terminate at any time for convenience' },
    { topic: 'money', point: 'There is a deposit' },
  ]);
  assert.deepEqual(kept.map((k) => k.point), ['Client pays monthly', 'Curly quotes and spacing are fine']);
  assert.match(kept[0].where, /page 1, Section 2/);
  assert.deepEqual(rejected.map((r) => r.why), ['the quote is not in the document word for word', 'no quote from the document']);
});

test('contract_review tool: reads the Library document, lists the checklist and says it is not legal advice', async (t) => {
  const { app, run } = setup(t);
  const doc = app.library!.add({ name: 'Rivera services agreement.md', bytes: Buffer.from(CONTRACT.replace(/\[page \d\]\n/g, ''), 'utf8'), keep: true, origin: 'library', learn: false });
  app.library!.setRead(doc.id, { kind: 'markdown', parts: [{ text: CONTRACT.split('[page 2]')[0].replace('[page 1]\n', ''), where: 'page 1' }, { text: CONTRACT.split('[page 2]')[1], where: 'page 2' }] as never, warnings: [] });
  const out = await run('contract_review', { document: 'rivera' });
  assert.match(out, /Parties: Northwind Studio LLC and Rivera Co/);
  assert.match(out, /Last day to give notice .*: Nov 1, 2027/);
  assert.match(out, /⚑ Automatic renewal/);
  assert.match(out, /⚑ Late fees above 1\.5% a month \(2% per month is about 2% a month\)/);
  assert.match(out, /Exclusivity: not found/);
  assert.match(out, /not legal advice/);
  const second = await run('contract_review', { document: String(doc.id), findings: [{ topic: 'x', point: 'made up', quote: 'Provider will refund everything' }] });
  assert.match(second, /Rejected \(don't tell them these as facts\)/);
});

// ---------------------------------------------------------------- expenses

const RECEIPT = `BLUE BOTTLE COFFEE
123 Market St
11/10/2026 08:42 AM
Latte          5.50
Croissant      4.25
Subtotal       9.75
Tax            0.85
TOTAL         10.60
VISA ****1234`;

test('expenses: receipt text parsed by code (vendor, date, total, tax, category)', () => {
  assert.deepEqual(parseReceipt(RECEIPT), { vendor: 'BLUE BOTTLE COFFEE', date: '2026-11-10', totalCents: 1060, taxCents: 85, category: 'Meals' });
  assert.equal(receiptDate('Date: Nov 3, 2026'), '2026-11-03');
  assert.equal(receiptDate('2026-02-30'), undefined);
  assert.equal(parseReceipt('SHELL\n11/09/26\nUNLEADED 10.2 GAL\nAMOUNT DUE $38.70').category, 'Fuel');
  assert.equal(parseReceipt('SHELL\n11/09/26\nUNLEADED 10.2 GAL\nAMOUNT DUE $38.70').totalCents, 3870);
});

test('expense tools: from a receipt in the Library, duplicates refused, report totals by category (xlsx)', async (t) => {
  const { app, run } = setup(t);
  const doc = app.library!.add({ name: 'receipt-bluebottle.txt', bytes: Buffer.from(RECEIPT, 'utf8'), keep: true, origin: 'library', learn: false });
  app.library!.setRead(doc.id, { kind: 'text', parts: [{ text: RECEIPT, where: '' }] as never, warnings: [] });
  assert.match(await run('expense_add', { receipt: 'bluebottle' }), /Saved expense #1: BLUE BOTTLE COFFEE, Nov 10, 2026, \$10\.60 \(tax \$0\.85\), Meals/);
  assert.match(await run('expense_add', { vendor: 'Blue Bottle Coffee', date: '2026-11-10', total: '10.60' }), /Not saved: it looks like a duplicate of expense #1/);
  assert.match(await run('expense_add', { vendor: 'Shell', date: '2026-11-11', total: '38.70', category: 'fuel' }), /Saved expense #2: .*Fuel/);
  assert.match(await run('expense_add', { vendor: 'Shell', date: '2026-11-12', total: 41.2, tax: 0 }), /Saved expense #3/);
  await assert.rejects(run('expense_add', { vendor: 'Mystery' }), /couldn't read the date \(YYYY-MM-DD\), total/);
  const out = await run('expense_report', { from: '2026-11-01', to: '2026-11-30' });
  assert.match(out, /3 expenses, total \$90\.50\. By category: Fuel \$79\.90 \(2\), Meals \$10\.60 \(1\)/);
  const m = [...Array(5).keys()].map((i) => madeDocs(app).get(i + 1)).find((x) => x?.format === 'xlsx')!;
  const book = readXlsxCells(new Zip(app.library!.file(app.library!.get(m.libraryId!)!)!));
  assert.equal(book.get('By category')!.get('D2'), '79.9');
  assert.equal(book.get('By category')!.get('D4'), '90.5');
  assert.match(book.get('Expenses')!.get('F2')!, /receipt-bluebottle\.txt \(Library #1\)/);
  const r = expenseReport(bizStore(app).expenses(), { from: '2026-11-01', to: '2026-11-30', who: 'Alex', currency: 'USD' });
  assert.equal(r.totalCents, 9050);
  assert.match(r.markdown, /\| \*\*Total\*\* \| \*\*3\*\* \|/);
});

// ---------------------------------------------------------------- action items

const NOTES = `Weekly sync — Nov 12
Attendees: Dana, Sam, Alex
- Dana will send the revised deck by Friday
- Action: Sam — book the venue by Nov 20
- [ ] Update the budget sheet
- @priya to review the contract
- We talked about the launch date.
- The team agreed on blue.
Alex to call the printer by tomorrow.`;

test('action items: owners, due dates and the exact line, from pasted notes', () => {
  const items = findActionItems(NOTES);
  assert.deepEqual(items.map((i) => [i.task, i.owner, i.due]), [
    ['Send the revised deck', 'Dana', 'Friday'],
    ['Book the venue', 'Sam', 'Nov 20'],
    ['Update the budget sheet', '', ''],
    ['Review the contract', 'priya', ''],
    ['Call the printer', 'Alex', 'tomorrow'],
  ]);
  assert.equal(items[0].quote, '- Dana will send the revised deck by Friday');
  assert.equal(dueAtOf('Nov 20', NOW, 'UTC'), '2026-11-20T17:00:00.000Z');
});

test('action_items tool: extra items need a real quote; create_tasks makes Planner to-dos once', async (t) => {
  const { app, run } = setup(t);
  const out = await run('action_items', { text: NOTES, items: [{ task: 'Pick the launch date', owner: 'Dana', quote: 'We talked about the launch date.' }, { task: 'Invented', quote: 'Nobody said this at all here' }] });
  assert.match(out, /6 action items/);
  assert.match(out, /Pick the launch date · owner: Dana/);
  assert.match(out, /Dropped \(quote not in the notes\): Invented/);
  assert.match(await run('action_items', { text: NOTES, create_tasks: true }), /Added 5 to-dos to the Planner/);
  assert.match(await run('action_items', { text: NOTES, create_tasks: true }), /Added 0 to-dos to the Planner \(5 already there\)/);
  const task = app.planner!.tasks({ status: 'open' }).find((x) => x.title === 'Send the revised deck')!;
  assert.match(task.notes, /Owner: Dana/);
  assert.ok(task.dueAt);
});

test('receipts: reminders from invoice_mark sent and to-dos from action_items back her words', async () => {
  const { checkClaims } = await import('../src/receipts.ts');
  const r = (name: string, args: Record<string, unknown>) => ({ name, status: 'ok' as const, args, output: '' });
  const it = 'Ti ho messo un promemoria per le 8.';
  assert.deepEqual(checkClaims(it, [r('invoice_mark', { id: 'INV-2026-0001', status: 'sent' })]), []);
  assert.deepEqual(checkClaims(it, [r('invoice_mark', { id: 'INV-2026-0001', status: 'paid' })]).map((c) => c.kind), ['remind']);
  assert.deepEqual(checkClaims("I've added them to your to-do list.", [r('action_items', { text: 'x', create_tasks: true })]), []);
});

// ---------------------------------------------------------------- lean picker

test('lean picker: the business tools are one family, found for their words in six languages', (t) => {
  const { tool } = setup(t);
  const all = ['invoice_make', 'invoice_list', 'invoice_mark', 'follow_ups', 'contract_review', 'expense_add', 'expense_report', 'action_items'].map(tool);
  for (const x of all) assert.equal(familyOf(x).id, 'business', x.spec.name);
  const lean = { ...DEFAULT_LEAN.tools, mode: 'always' as const, localCore: true };
  const msgs = ['make an invoice for Rivera', 'who do I owe a reply', 'read this lease', 'add this receipt', 'action items from the meeting', 'mark it paid', 'haz una factura', 'revisa el contrato', 'fais un devis', 'note de frais', 'erstelle eine Rechnung', 'Quittung hinzufügen', 'faça uma fatura', 'recibo de despesa', 'prepara un preventivo', 'rimborso spese'];
  for (const msg of msgs) {
    const tt = leanFor(lean, all, { text: msg, mode: 'chat', local: true, turnId: 1, ownerTurnIds: [1] });
    assert.ok(tt.offeredNames(all).some((n) => all.some((x) => x.spec.name === n)), msg);
  }
});
