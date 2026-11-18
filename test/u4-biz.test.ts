// U4.29 (docs/BUSINESS_PACK.md): the business pack. Clients with terms, time with rounding rules,
// quotes → invoices, invoices from hours and expenses, send-after-approval, the client portal link
// (EC11 share links), the bookkeeping export and business expenses taken from Money. Invented
// people: Alex (owner), Rivera Studio and Kestrel Labs (clients).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { billedExpenses, expenseFromMoney, MONEY_TO_BIZ, quoteInvoiceOf } from '../src/biz/pack.ts';
import { buildPortal, PORTAL_PREFIX } from '../src/biz/portal.ts';
import { bizStore } from '../src/biz/store.ts';
import { madeDocs } from '../src/documents/make.ts';
import { OFFSERVER_TOOL } from '../src/chat.ts';
import { childRouteCheck } from '../src/family.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { familyOf } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { moneyStore } from '../src/money/store.ts';
import { createSaraServer } from '../src/server.ts';
import { setShares, shares, ShareStore } from '../src/share.ts';
import { createBizTools } from '../src/tools/biz.ts';
import { BIZPACK_TOOLS, createBizPackTools } from '../src/tools/bizpack.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { clientsOf, createWorkTools, timeOf } from '../src/tools/work.ts';
import { accountingCsv } from '../src/workapps/accounting.ts';
import { roundBy, sumHours } from '../src/work/time.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const NOW = new Date('2026-11-13T15:00:00Z'); // Fri Nov 13 2026, 9:00 AM in Chicago
type T = { after: (fn: () => void) => void };

function space(t: T, clock = { now: NOW }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  const tools = [...createWorkTools(() => app), ...createBizTools(() => app), ...createBizPackTools(() => app)];
  for (const x of tools) app.tools.add(x);
  const conv = app.store.createConversation({ title: 'work' }).id;
  const ctx = (): ToolContext => ({ workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: 'tests' }, conversationId: conv }) as ToolContext;
  const tool = (n: string): Tool => tools.find((x) => x.spec.name === n)!;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir, clock, tool, ctx, run: async (n: string, a: Record<string, unknown>) => String(await tool(n).run(a, ctx())) };
}

test('rounding rules: 6 minutes to the nearest stays the default; 15/30/60 minutes, nearest or up, apply when time ends', (t) => {
  assert.equal(roundBy(20, { step: 6, round: 'nearest' }), 0.3);
  assert.equal(roundBy(20, { step: 15, round: 'nearest' }), 0.25);
  assert.equal(roundBy(20, { step: 15, round: 'up' }), 0.5);
  assert.equal(roundBy(31, { step: 30, round: 'up' }), 1);
  assert.equal(roundBy(29, { step: 60, round: 'nearest' }), 0);
  assert.equal(sumHours([0.25, 0.25, 0.1]), 0.6);
  const s = space(t);
  const ts = timeOf(s.app);
  assert.equal(ts.add({ day: '2026-11-12', start: '9:00', end: '9:20', client: 'Rivera Studio' }, 'America/Chicago').hours, 0.3, 'default: 0.1 h');
  bizStore(s.app).saveDetails({ timeStep: 15, timeRound: 'up' });
  assert.deepEqual({ step: bizStore(s.app).details().timeStep, round: bizStore(s.app).details().timeRound }, { step: 15, round: 'up' });
  assert.equal(ts.add({ day: '2026-11-12', start: '10:00', end: '10:20', client: 'Rivera Studio' }, 'America/Chicago').hours, 0.5);
  assert.equal(ts.add({ day: '2026-11-12', hours: 1.1, client: 'Rivera Studio' }, 'America/Chicago').hours, 1.25);
  ts.start({ client: 'Rivera Studio' }, 'America/Chicago');
  s.clock.now = new Date(NOW.getTime() + 7 * 60_000);
  assert.equal(ts.stop()!.hours, 0.25, 'a stopped timer uses the rule too');
  bizStore(s.app).saveDetails({ timeStep: 7, timeRound: 'sideways' });
  assert.equal(bizStore(s.app).details().timeStep, 15, 'unknown values keep the saved rule');
});

test('clients carry terms, address and phone; an invoice for them uses their terms and address', async (t) => {
  const s = space(t);
  const c = clientsOf(s.app).add({ name: 'Rivera Studio', email: 'pay@rivera.test', rateCents: 9000, termsDays: 14, address: '5 Elm St, Springfield', phone: '555-0100' });
  assert.equal(c.termsDays, 14);
  assert.equal(clientsOf(s.app).update(c.id, { termsDays: 10 })!.termsDays, 10);
  await s.run('invoice_make', { client: 'Rivera Studio', items: [{ desc: 'Design', qty: 2, unit_price: 90 }] });
  const inv = bizStore(s.app).invoices()[0]!;
  assert.equal(inv.due, '2026-11-23', 'issued Nov 13 + 10 days');
  assert.equal(inv.clientAddress, '5 Elm St, Springfield');
  assert.equal(inv.clientEmail, 'pay@rivera.test');
  await s.run('invoice_make', { client: 'Rivera Studio', items: [{ desc: 'More', qty: 1, unit_price: 10 }], due_days: 3 });
  assert.equal(bizStore(s.app).invoices()[0]!.due, '2026-11-16', 'an explicit due_days still wins');
});

test('quote → invoice: same lines and tax, quote marked accepted, never invoiced twice', async (t) => {
  const s = space(t);
  await s.run('invoice_make', { kind: 'quote', client: 'Kestrel Labs <ap@kestrel.test>', items: [{ desc: 'Audit', qty: 3, unit_price: 120 }], tax_rate: 8.25 });
  const q = bizStore(s.app).invoices()[0]!;
  const out = await s.run('invoice_from_quote', { id: q.number });
  const inv = bizStore(s.app).invoices().find((i) => i.kind === 'invoice')!;
  assert.match(out, new RegExp(inv.number));
  assert.equal(inv.totalCents, q.totalCents);
  assert.equal(inv.taxRatePct, 8.25);
  assert.deepEqual(inv.lines.map((l) => l.desc), ['Audit']);
  assert.equal(bizStore(s.app).invoice(q.id)!.status, 'accepted');
  assert.equal(quoteInvoiceOf(s.app, q.id), inv.id);
  await assert.rejects(s.tool('invoice_from_quote').run({ id: q.number }, s.ctx()), new RegExp(`already.*${inv.number}`, 'i'));
  await assert.rejects(s.tool('invoice_from_quote').run({ id: inv.number }, s.ctx()), /not a quote/i);
});

test('an invoice from hours can carry expenses at cost; billed expenses are never billed twice; voiding frees them', async (t) => {
  const s = space(t);
  clientsOf(s.app).add({ name: 'Rivera Studio', rateCents: 10000 });
  timeOf(s.app).add({ day: '2026-11-10', hours: 2, client: 'Rivera Studio', project: 'Site' }, 'America/Chicago');
  const e = bizStore(s.app).addExpense({ vendor: 'Print Shop', date: '2026-11-09', totalCents: 4550, taxCents: 0, category: 'Office supplies', currency: 'USD', docId: null, docName: '', note: '' });
  await s.run('time_invoice', { client: 'Rivera Studio', expenses: [e.id] });
  const inv = bizStore(s.app).invoices()[0]!;
  assert.deepEqual(inv.lines.map((l) => [l.desc.replace(/ \(.*$/, ''), l.amountCents]), [['Site', 20000], ['Expense: Print Shop', 4550]]);
  assert.equal(billedExpenses(s.app).get(e.id), inv.id);
  timeOf(s.app).add({ day: '2026-11-11', hours: 1, client: 'Rivera Studio', project: 'Site' }, 'America/Chicago');
  await assert.rejects(s.tool('time_invoice').run({ client: 'Rivera Studio', expenses: [e.id] }, s.ctx()), /already billed/i);
  await s.run('invoice_mark', { id: inv.number, status: 'void' });
  assert.equal(billedExpenses(s.app).has(e.id), false, 'a void invoice frees its expenses');
});

test('invoice_send asks first, attaches the invoice file, sends through the mail tool and marks it sent', async (t) => {
  const s = space(t);
  const tool = s.tool('invoice_send');
  assert.equal(tool.defaultPermission, 'ask');
  assert.equal(tool.isAvailable?.(), false, 'no mail tool: hidden');
  const sent: Record<string, unknown>[] = [];
  s.app.tools.add({ spec: { name: 'mail_send', description: 'x', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => 'send', async run(a) { sent.push(a); return 'Sent from alex@example.test.'; } });
  assert.equal(tool.isAvailable?.(), true);
  await s.run('invoice_make', { client: 'Rivera Studio <pay@rivera.test>', items: [{ desc: 'Design', qty: 1, unit_price: 500 }] });
  const inv = bizStore(s.app).invoices()[0]!;
  const args: Record<string, unknown> = { id: inv.number };
  const prep = await tool.prepare!(args, s.ctx());
  assert.match(String(prep.summary), /To: pay@rivera\.test/);
  assert.match(String(prep.summary), new RegExp(inv.number));
  assert.match(String(prep.summary), /\$500\.00/);
  const out = await s.run('invoice_send', args);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'pay@rivera.test');
  assert.deepEqual(sent[0]!.attachments, inv.docIds.map((id) => String(madeDocs(s.app).get(id)!.libraryId)));
  assert.match(String(sent[0]!.subject), new RegExp(inv.number));
  assert.match(out, /marked sent/i);
  assert.equal(bizStore(s.app).invoice(inv.id)!.status, 'sent');
  assert.equal(bizStore(s.app).invoice(inv.id)!.reminderIds.length, 2, 'due reminders set');
  await s.run('invoice_make', { client: 'Nobody', items: [{ desc: 'X', qty: 1, unit_price: 1 }] });
  await assert.rejects(tool.run({ id: bizStore(s.app).invoices()[0]!.number }, s.ctx()), /email address/i);
  assert.ok(OFFSERVER_TOOL('invoice_send'), 'off in private chats');
  for (const n of BIZPACK_TOOLS) assert.equal(familyOf({ spec: { name: n } } as never)?.id, 'business', n);
});

test('client portal: one client\'s invoices and files only, frozen, expiring, served by the share page', async (t) => {
  const s = space(t);
  const store = new ShareStore(s.dir, () => s.clock.now);
  setShares(store);
  t.after(() => {
    store.close();
    setShares(undefined);
  });
  await s.run('invoice_make', { client: 'Rivera Studio <pay@rivera.test>', items: [{ desc: 'Design <b>', qty: 1, unit_price: 500 }] });
  await s.run('invoice_make', { client: 'Kestrel Labs', items: [{ desc: 'Secret work', qty: 1, unit_price: 900 }] });
  assert.throws(() => buildPortal(s.app, 'Rivera Studio'), /no invoices/i, 'drafts are never shown');
  await s.run('invoice_mark', { id: 'INV-2026-0001', status: 'sent' });
  await s.run('invoice_mark', { id: 'INV-2026-0002', status: 'sent' });
  const built = buildPortal(s.app, 'Rivera Studio');
  assert.equal(built.snapshot.portal!.invoices.length, 1);
  assert.ok(!JSON.stringify(built.snapshot).includes('Kestrel'));
  assert.equal(built.pictures[0]!.mime, 'application/pdf');
  assert.throws(() => buildPortal(s.app, 'Nobody Inc'), /no invoices/i);
  const auth = new OwnerAuth(s.dir, () => s.clock.now);
  const server = createSaraServer({ app: s.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json', origin: base };
  const made = await fetch(`${base}/api/bizpack/portal`, { method: 'POST', headers: H, body: JSON.stringify({ client: 'Rivera Studio', expires: '7d' }) });
  assert.equal(made.status, 201);
  const { link } = (await made.json()) as { link: string };
  const path = new URL(link).pathname;
  assert.ok(shares()!.list('owner').some((x) => x.conversationId.startsWith(PORTAL_PREFIX)));
  const page = await (await fetch(`${base}${path}`)).text();
  assert.match(page, /Rivera Studio/);
  assert.match(page, /INV-2026-0001/);
  assert.match(page, /Design &lt;b&gt;/, 'escaped');
  assert.doesNotMatch(page, /Kestrel|Secret work|<script/);
  const pdf = await fetch(`${base}${path}/p/0`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  s.clock.now = new Date(NOW.getTime() + 8 * 86_400_000);
  assert.equal((await fetch(`${base}${path}`)).status, 404, 'expired');
});

test('bookkeeping export: income and expenses by category for the period, plus Wave-style bank lines', async (t) => {
  const s = space(t);
  await s.run('invoice_make', { client: 'Rivera Studio', items: [{ desc: 'Design', qty: 1, unit_price: 500 }], tax_rate: 10 });
  const b = bizStore(s.app);
  b.addExpense({ vendor: 'Cafe', date: '2026-11-05', totalCents: 1200, taxCents: 100, category: 'Meals', currency: 'USD', docId: null, docName: '', note: '' });
  b.addExpense({ vendor: 'Diner', date: '2026-11-06', totalCents: 800, taxCents: 0, category: 'Meals', currency: 'USD', docId: null, docName: '', note: '' });
  b.addExpense({ vendor: 'Old', date: '2026-09-01', totalCents: 99999, taxCents: 0, category: 'Travel', currency: 'USD', docId: null, docName: '', note: '' });
  const sum = accountingCsv(s.app, { from: '2026-11-01', to: '2026-11-30', format: 'generic', what: 'summary' });
  assert.equal(sum.csv, 'Type,Category,Amount,Tax,Count,Currency\r\nincome,Sales,500.00,50.00,1,USD\r\nexpense,Meals,20.00,1.00,2,USD\r\n');
  const wave = accountingCsv(s.app, { from: '2026-11-01', to: '2026-11-30', format: 'wave', what: 'all' });
  assert.match(wave.csv, /^Date,Description,Amount\r\n/);
  assert.match(wave.csv, /2026-11-13,INV-2026-0001 Rivera Studio,550\.00/);
  assert.match(wave.csv, /2026-11-05,Cafe - Meals,-12\.00/);
  assert.doesNotMatch(wave.csv, /Old/);
});

test('business expenses from Money: a bank row becomes an expense with a mapped category, once', (t) => {
  const s = space(t);
  moneyStore(s.app); // makes the money tables
  s.app.store.db.prepare("INSERT INTO money_tx (key, date, description, merchant, amount, account, category, created_at) VALUES ('k1', '2026-11-04', 'SQ *BLUE BOTTLE', 'Blue Bottle', -650, 'Card', 'dining', '2026-11-04')").run();
  const id = Number((s.app.store.db.prepare("SELECT id FROM money_tx WHERE key = 'k1'").get() as { id: number }).id);
  const e = expenseFromMoney(s.app, id);
  assert.deepEqual([e.vendor, e.date, e.totalCents, e.category], ['Blue Bottle', '2026-11-04', 650, MONEY_TO_BIZ.dining]);
  assert.equal(MONEY_TO_BIZ.dining, 'Meals');
  assert.throws(() => expenseFromMoney(s.app, id), /already/i);
});

test('routes and wiring: members get their own pack, kids and the demo are refused; the place exists', () => {
  assert.ok(MEMBER_ROUTES.has('bizpack'));
  assert.equal(childRouteCheck('k1', { child: true } as never, 'GET', ['bizpack'])?.status, 403);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<dialog id="bizpack"/);
  assert.match(html, /data-dest="bizpack"/);
  assert.match(html, /never charges a card/);
  // The U4-A merge once dropped the Money dialog's closing tags, so Settings rendered inside it.
  assert.equal((html.match(/<dialog\b/g) ?? []).length, (html.match(/<\/dialog>/g) ?? []).length, 'every dialog is closed');
  assert.match(readFileSync(join(ROOT, 'web', 'nav.js'), 'utf8'), /'money', 'bizpack'/);
  assert.match(readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8'), /createBizPackRoutes/);
});
