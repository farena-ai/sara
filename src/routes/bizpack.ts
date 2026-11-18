// U4.29 (docs/BUSINESS_PACK.md): the Business place, in each person's own space (the owner's or a
// household member's own store.db; never the demo, never a child: src/family.ts CHILD_DENIED).
//   GET    /api/bizpack                         everything the page shows
//   POST   /api/bizpack/timer        {action: 'start', client, project, note} | {action: 'stop'}
//   POST   /api/bizpack/time         {day, hours | start+end, client, project, note}
//   DELETE /api/bizpack/time/:id
//   POST   /api/bizpack/clients      {id?, name, email, rate, termsDays, address, phone}
//   POST   /api/bizpack/invoices/:id {status: sent|paid|accepted|void} | {action: 'invoice'} (a quote)
//   POST   /api/bizpack/bill         {client, expenses: [ids]}  invoice the unbilled hours (+ expenses)
//   POST   /api/bizpack/expenses     {vendor, date, total, category, note} | {fromMoney: txId}
//   POST   /api/bizpack/portal       {client, expires, docs?} → {link, expiresAt}   (EC11 share link)
//   DELETE /api/bizpack/portal/:id
//   GET    /api/bizpack/export?from&to&format&what   one CSV file
// Sending an invoice by email is a chat turn (invoice_send), so the person approves the exact email.
import type { ServerResponse } from 'node:http';
import { MONEY_TO_BIZ, billedExpenses, expenseFromMoney, quoteInvoiceOf, takenFromMoney } from '../biz/pack.ts';
import { buildPortal, PORTAL_PREFIX } from '../biz/portal.ts';
import { toCents } from '../biz/money.ts';
import { addDays, bizStore, EXPENSE_CATEGORIES, localDay, shownStatus } from '../biz/store.ts';
import { madeDocs } from '../documents/make.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { moneyStore } from '../money/store.ts';
import { privateLocalOn } from '../net-guard.ts';
import { policy } from '../policy-profile.ts';
import { SHARE_EXPIRY, shares, type ShareExpiry } from '../share.ts';
import { todayChanged } from '../today.ts';
import { createBizTools } from '../tools/biz.ts';
import { invoiceFromQuote } from '../tools/bizpack.ts';
import type { ToolContext } from '../tools/types.ts';
import { clientsOf, createWorkTools, timeOf } from '../tools/work.ts';
import { ACCOUNTING_FORMATS, ACCOUNTING_PARTS, accountingCsv, type AccountingFormat, type AccountingPart } from '../workapps/accounting.ts';
import { foldName } from '../work/clients.ts';
import { sumHours } from '../work/time.ts';
import { originOf } from './share.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function createBizPackRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts, spaceId } = ctx;
  const tz = () => app.settings.get().timeZone;
  const today = () => localDay(app.now(), tz());
  const toolCtx = (): ToolContext => ({ workspaceDir: app.dataDir, signal: new AbortController().signal, sandbox: app.sandbox }) as ToolContext;
  const tool = (name: string) => [...createBizTools(() => app), ...createWorkTools(() => app)].find((t) => t.spec.name === name)!;
  const fail = (err: unknown): never => {
    throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
  };

  const view = () => {
    const b = bizStore(app);
    const ts = timeOf(app);
    const day = today();
    const run = ts.running();
    const made = madeDocs(app);
    const billed = billedExpenses(app);
    const taken = takenFromMoney(app);
    const unbilled = (id: number, name: string) => sumHours(ts.unbilled((e) => e.clientId === id || (e.clientId === null && foldName(e.client) === foldName(name))).map((e) => e.hours ?? 0));
    const fileOf = (ids: number[]) => ids.map((id) => made.get(id)).find((m) => m && m.format === 'pdf')?.id ?? ids[0] ?? null;
    const money = (() => {
      try {
        return moneyStore(app)
          .transactions({ from: addDays(day, -90), to: day })
          .filter((t) => t.amountCents < 0 && !taken.has(t.id) && t.category !== 'transfers')
          .slice(-40)
          .reverse()
          .map((t) => ({ id: t.id, date: t.date, merchant: t.merchant || t.description, amountCents: -t.amountCents, category: t.category, bizCategory: MONEY_TO_BIZ[t.category] ?? 'Other' }));
      } catch {
        return [];
      }
    })();
    const details = b.details();
    return {
      details: { name: details.name, currency: details.currency, timeStep: details.timeStep, timeRound: details.timeRound, dueDays: details.dueDays, payment: Boolean(details.payment) },
      timer: run ? { client: run.client, project: run.project, note: run.note, start: run.start, hours: ts.runningHours(run) } : null,
      clients: clientsOf(app)
        .list()
        .map((c) => ({ id: c.id, name: c.name, email: c.email, stage: c.stage, rateCents: c.rateCents, termsDays: c.termsDays, address: c.address, phone: c.phone, currency: c.currency, unbilled: unbilled(c.id, c.name) })),
      entries: ts
        .list({ from: addDays(day, -45), to: day })
        .reverse()
        .slice(0, 60)
        .map((e) => ({ id: e.id, day: e.day, client: e.client, project: e.project, note: e.note, hours: e.hours, running: e.running, billed: e.invoiceId !== null })),
      invoices: b
        .invoices()
        .slice(0, 80)
        .map((i) => ({ id: i.id, kind: i.kind, number: i.number, client: i.clientName, email: i.clientEmail, totalCents: i.totalCents, currency: i.currency, status: shownStatus(i, day), issued: i.issued, due: i.due, file: fileOf(i.docIds), invoiced: i.kind === 'quote' ? (b.invoice(quoteInvoiceOf(app, i.id) ?? -1)?.number ?? null) : null })),
      expenses: b
        .expenses({ from: addDays(day, -365), to: day })
        .reverse()
        .slice(0, 60)
        .map((e) => ({ id: e.id, date: e.date, vendor: e.vendor, totalCents: e.totalCents, category: e.category, currency: e.currency, billed: billed.has(e.id) })),
      money,
      portals: (shares()?.list(spaceId) ?? []).filter((s) => s.conversationId.startsWith(PORTAL_PREFIX) && Date.parse(s.expiresAt) > app.now().getTime()).map((s) => ({ id: s.id, client: s.title, expiresAt: s.expiresAt, views: s.views })),
      categories: EXPENSE_CATEGORIES,
      formats: ACCOUNTING_FORMATS,
      sharing: Boolean(shares()) && policy().sharingOn && !privateLocalOn(),
    };
  };
  const changed = () => todayChanged(app, 'worktime');

  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'bizpack') return NEXT;
    if (opts.demo || app.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Not on the demo.'));
    }
    if (!b && method === 'GET') return send(res, 200, view());
    if (b === 'export' && method === 'GET') return exportCsv(res, new URL(req.url ?? '/', 'http://x').searchParams);
    if (method === 'DELETE' && b === 'time' && c) {
      try {
        if (!timeOf(app).remove(Number(c))) throw new HttpError(404, 'Not found');
      } catch (err) {
        fail(err);
      }
      changed();
      return send(res, 200, view());
    }
    if (method === 'DELETE' && b === 'portal' && c) {
      const s = shares();
      const row = s?.get(c);
      if (!s || !row || row.space !== spaceId || !row.conversationId.startsWith(PORTAL_PREFIX)) throw new HttpError(404, 'Not found');
      s.revoke(c);
      return send(res, 200, view());
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = (await readJson(req)) as Record<string, unknown>;
    const str = (k: string) => String(body[k] ?? '').trim();
    try {
      if (b === 'timer') {
        const ts = timeOf(app);
        if (body.action === 'stop') {
          const run = ts.running();
          if (!run) throw new HttpError(409, en('No timer is running.'));
          if (run.reminderId) app.planner?.cancelReminder(run.reminderId);
          ts.stop();
        } else {
          const known = str('client') ? clientsOf(app).find(str('client')) : undefined;
          ts.start({ clientId: known?.id ?? null, client: known?.name ?? str('client'), project: str('project'), note: str('note') }, tz());
        }
        changed();
        return send(res, 200, view());
      }
      if (b === 'time') {
        const day = str('day') || today();
        if (!DAY.test(day)) throw new HttpError(400, en('Give the day as YYYY-MM-DD.'));
        const known = str('client') ? clientsOf(app).find(str('client')) : undefined;
        timeOf(app).add({ day, ...(str('start') || str('end') ? { start: str('start'), end: str('end') } : { hours: Number(body.hours) }), clientId: known?.id ?? null, client: known?.name ?? str('client'), project: str('project'), note: str('note') }, tz());
        changed();
        return send(res, 200, view());
      }
      if (b === 'clients') {
        const cs = clientsOf(app);
        const rate = body.rate === undefined || body.rate === '' ? undefined : toCents(body.rate);
        if (body.rate !== undefined && body.rate !== '' && (rate === undefined || rate < 0)) throw new HttpError(400, en('The rate is an amount like 85 or 85.00.'));
        const terms = body.termsDays === undefined || body.termsDays === '' || body.termsDays === null ? null : Number(body.termsDays);
        if (terms !== null && (!Number.isFinite(terms) || terms < 0 || terms > 365)) throw new HttpError(400, en('Payment terms are 0 to 365 days.'));
        const patch = { name: str('name'), email: str('email'), address: String(body.address ?? ''), phone: str('phone'), termsDays: terms, ...(rate !== undefined ? { rateCents: rate } : {}) };
        if (patch.email && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(patch.email)) throw new HttpError(400, en('That email address does not look right.'));
        if (body.id) {
          if (!cs.update(Number(body.id), patch)) throw new HttpError(404, 'Not found');
        } else cs.add({ ...patch, stage: 'won', currency: bizStore(app).details().currency });
        changed();
        return send(res, 200, view());
      }
      if (b === 'invoices' && c) {
        const inv = bizStore(app).invoice(Number(c));
        if (!inv) throw new HttpError(404, 'Not found');
        if (body.action === 'invoice') {
          const made = await invoiceFromQuote(() => app, inv.number, toolCtx());
          return send(res, 200, { ...view(), made: made.invoice.number });
        }
        await tool('invoice_mark').run({ id: inv.number, status: str('status') }, toolCtx());
        changed();
        return send(res, 200, view());
      }
      if (b === 'bill') {
        const out = String(await tool('time_invoice').run({ client: str('client'), ...(Array.isArray(body.expenses) && body.expenses.length ? { expenses: body.expenses.map(Number) } : {}) }, toolCtx()));
        changed();
        return send(res, 200, { ...view(), said: out.split('\n')[0] });
      }
      if (b === 'expenses') {
        if (body.fromMoney !== undefined) expenseFromMoney(app, Number(body.fromMoney));
        else {
          const total = toCents(body.total);
          if (!str('vendor') || total === undefined || total <= 0) throw new HttpError(400, en('Give who was paid and an amount.'));
          const date = str('date') || today();
          if (!DAY.test(date)) throw new HttpError(400, en('Give the day as YYYY-MM-DD.'));
          const cat = (EXPENSE_CATEGORIES as readonly string[]).includes(str('category')) ? str('category') : 'Other';
          const bz = bizStore(app);
          bz.addExpense({ vendor: str('vendor'), date, totalCents: total, taxCents: 0, category: cat, currency: bz.details().currency, docId: null, docName: '', note: str('note').slice(0, 500) });
        }
        return send(res, 200, view());
      }
      if (b === 'portal') {
        const s = shares();
        if (!s || !policy().sharingOn) throw new HttpError(403, en('Share links are turned off on this server.'));
        if (privateLocalOn()) throw new HttpError(409, en('Nothing leaves this computer is on, so there are no links.'));
        if ((opts.member || app.member) && !s.settings().members) throw new HttpError(403, 'The owner has turned off share links for household members.', { membersOff: true });
        const expires = (String(body.expires ?? '30d') as ShareExpiry) in SHARE_EXPIRY ? (String(body.expires ?? '30d') as ShareExpiry) : '30d';
        const docs = Array.isArray(body.docs) ? body.docs.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
        const p = buildPortal(app, str('client'), { docs });
        const made = s.create({ space: spaceId, companion: 'main', conversationId: p.key, expires, options: { tools: false, pictures: true }, snapshot: p.snapshot, pictures: p.pictures });
        return send(res, 201, { ...view(), link: `${originOf(req, opts.trustProxy)}/s/${made.token}`, expiresAt: made.expiresAt });
      }
    } catch (err) {
      fail(err);
    }
    throw new HttpError(404, 'Not found');
  };

  function exportCsv(res: ServerResponse, q: URLSearchParams) {
    const format = (q.get('format') ?? 'generic') as AccountingFormat;
    const what = (q.get('what') ?? 'summary') as AccountingPart;
    if (!(ACCOUNTING_PARTS as readonly string[]).includes(what)) throw new HttpError(400, en('Pick what to export.'));
    let file;
    try {
      file = accountingCsv(app, { from: q.get('from') ?? '', to: q.get('to') ?? '', format, what });
    } catch (err) {
      fail(err);
    }
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${file!.name.replace(/[^\w.-]/g, '_')}"`, 'cache-control': 'no-store' });
    res.end(file!.csv);
  }
}
