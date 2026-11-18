// U4.20 (docs/MONEY.md): the Money place, each person's own (a household member's lives in their own
// space; a child is refused by family.ts; never the demo). Tracking only: nothing here logs in to a
// bank, pays, transfers or cancels anything, and nothing uses the network.
//   GET    /api/money?month=YYYY-MM          the page (month, trends, budgets, bills due, subscriptions, net worth, rules…)
//   POST   /api/money/import                 {name, data (base64), account?, mapping?} → ImportResult (needMapping + columns when asked)
//   DELETE /api/money/mappings/:sig          forget a saved CSV column mapping
//   PUT    /api/money/rules                  {merchant, category} → moves that merchant's rows, remembered
//   DELETE /api/money/rules?merchant=…
//   PATCH  /api/money/tx/:id                 {category}: a correction, learned as a rule for its merchant
//   PUT    /api/money/limits                 {category, amount} (0 removes)
//   PUT    /api/money/prefs                  {gentle?, nearPct?, suggest?}
//   POST   /api/money/suggest                → {suggestions} (only when suggestions are on; merchant names only)
//   POST   /api/money/bills                  {merchant} (track a recurring charge) or {name, amount?, dueDay}
//   POST   /api/money/bills/:id/paid
//   DELETE /api/money/bills/:id
//   POST   /api/money/balances               {name, kind: asset|debt, amount}; PATCH/DELETE /api/money/balances/:id
//   DELETE /api/money/mailsubs/:id           hide a subscription found in mail (and its trial reminder)
import { toCents } from '../biz/money.ts';
import { addDays, localDay } from '../biz/store.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en, trOwner } from '../i18n.ts';
import { addMonths, cleanBudgetCategory, findSubscriptions } from '../money/budget.ts';
import { billStatus, scheduleBill } from '../money/core.ts';
import { addBalance, dismissMailSub, forgetMapping, importFile, moneyOverview, MoneyHubError, removeBalance, setPrefs, suggestCategories, updateBalance, budgetAlerts } from '../money/hub.ts';
import { MoneyParseError } from '../money/parse.ts';
import { moneyStore } from '../money/store.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const MAX_FILE = 8 * 1024 * 1024;

export function createMoneyRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof MoneyHubError) throw new HttpError(err.status, T(err.message));
      if (err instanceof MoneyParseError) throw new HttpError(400, T(err.message));
      throw err;
    }
  };
  const today = () => localDay(app.now(), app.settings.get().timeZone);
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'money') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = moneyStore(app);
    const url = new URL(req.url ?? '/', 'http://x');
    if (!b && method === 'GET') return send(res, 200, moneyOverview(app, url.searchParams.get('month') ?? undefined));
    if (b === 'import' && !c && method === 'POST') {
      const body = await readJson(req, Math.ceil(MAX_FILE * 1.4) + 4096);
      const bytes = Buffer.from(String(body.data ?? ''), 'base64');
      if (!bytes.length) throw new HttpError(400, T(en('Pick a bank or card export file.')));
      if (bytes.length > MAX_FILE) throw new HttpError(413, T(en('That file is too big for a bank export.')));
      return send(res, 200, await wrap(() => importFile(app, { name: String(body.name ?? ''), bytes, account: body.account ? String(body.account) : undefined, mapping: body.mapping && typeof body.mapping === 'object' ? (body.mapping as Record<string, unknown>) : undefined })));
    }
    if (b === 'mappings' && c && method === 'DELETE') {
      if (!forgetMapping(app, decodeURIComponent(c))) throw new HttpError(404, 'Not found');
      return send(res, 200, { ok: true });
    }
    if (b === 'rules' && !c) {
      if (method === 'PUT') {
        const body = await readJson(req);
        const cat = cleanBudgetCategory(body.category);
        const merchant = String(body.merchant ?? '').trim();
        if (!cat || !merchant) throw new HttpError(400, T(en('Pick a merchant and a category.')));
        return send(res, 200, s.setRule(merchant, cat));
      }
      if (method === 'DELETE') {
        if (!s.removeRule(url.searchParams.get('merchant') ?? '')) throw new HttpError(404, 'Not found');
        return send(res, 200, { ok: true });
      }
    }
    if (b === 'tx' && c && !d && method === 'PATCH') {
      const body = await readJson(req);
      const t = s.tx(Number(c));
      if (!t) throw new HttpError(404, 'Not found');
      const cat = cleanBudgetCategory(body.category);
      if (!cat) throw new HttpError(400, T(en('Pick a category.')));
      return send(res, 200, s.setRule(t.merchant || t.description, cat));
    }
    if (b === 'limits' && !c && method === 'PUT') {
      const body = await readJson(req);
      const cat = cleanBudgetCategory(body.category);
      const cents = body.amount === '' || body.amount === 0 || body.amount === '0' ? 0 : toCents(body.amount);
      if (!cat || cents === undefined || cents < 0) throw new HttpError(400, T(en('Type the amount as a number, like 2500.00.')));
      s.setLimit(cat, cents);
      budgetAlerts(app, null);
      return send(res, 200, { ok: true });
    }
    if (b === 'prefs' && !c && method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, { prefs: await wrap(() => setPrefs(app, body)) });
    }
    if (b === 'suggest' && !c && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { suggestions: await wrap(() => suggestCategories(app)) });
    }
    if (b === 'bills') {
      if (!c && method === 'POST') {
        const body = await readJson(req);
        const day = today();
        if (body.merchant) {
          const sub = findSubscriptions(s.transactions(), day).find((x) => x.merchant === String(body.merchant));
          if (!sub || sub.every === 'week') throw new HttpError(404, T(en('That recurring charge is gone.')));
          const repeat = sub.every === 'month' ? 'monthly' : 'yearly';
          const bill = s.addBill({ name: sub.merchant.replace(/\b\w/g, (x) => x.toUpperCase()), amountCents: sub.amountCents, repeat, dueDay: repeat === 'monthly' ? Number(sub.next.slice(8)) : null, dueDate: repeat === 'yearly' ? sub.next : null, autopay: false, leadDays: 3 });
          // The charge for this cycle already went through: that due date counts as paid.
          const st = billStatus(bill, day);
          const paid = st.due && st.due <= day && sub.last >= addDays(st.due, -5) ? s.setBill(bill.id, { paidFor: st.due, paidAt: `${sub.last}T12:00:00.000Z` })! : bill;
          return send(res, 200, { bill: scheduleBill(app, s, paid, null, paid.paidFor ?? undefined) });
        }
        const name = String(body.name ?? '').trim().slice(0, 120);
        const dueDay = Math.round(Number(body.dueDay));
        if (!name || !(dueDay >= 1 && dueDay <= 31)) throw new HttpError(400, T(en('Give the bill a name and a day of the month (1-31).')));
        const amountCents = body.amount === undefined || body.amount === '' ? null : (toCents(body.amount) ?? null);
        const bill = s.addBill({ name, amountCents, repeat: 'monthly', dueDay, dueDate: null, autopay: body.autopay === true, leadDays: 3 });
        return send(res, 200, { bill: scheduleBill(app, s, bill, null) });
      }
      const bill = c ? s.bill(Number(c)) : undefined;
      if (!bill) throw new HttpError(404, 'Not found');
      if (d === 'paid' && method === 'POST') {
        await readJson(req).catch(() => ({}));
        const day = today();
        const due = billStatus(bill, day).due ?? day;
        let next = s.setBill(bill.id, { paidFor: due, paidAt: app.now().toISOString() })!;
        if (bill.repeat === 'once') {
          next = s.setBill(bill.id, { done: true })!;
          if (bill.reminderId) app.planner?.cancelReminder(bill.reminderId);
          return send(res, 200, { bill: next });
        }
        if (bill.repeat === 'yearly') next = s.setBill(bill.id, { dueDate: addMonths(due, 12) })!;
        return send(res, 200, { bill: scheduleBill(app, s, next, null, due) });
      }
      if (!d && method === 'DELETE') {
        if (bill.reminderId) app.planner?.cancelReminder(bill.reminderId);
        s.removeBill(bill.id);
        return send(res, 200, { ok: true });
      }
    }
    if (b === 'balances') {
      if (!c && method === 'POST') return send(res, 200, { balance: await wrap(async () => addBalance(app, await readJson(req))) });
      if (c && method === 'PATCH') return send(res, 200, { balance: await wrap(async () => updateBalance(app, Number(c), await readJson(req))) });
      if (c && method === 'DELETE') {
        if (!removeBalance(app, Number(c))) throw new HttpError(404, 'Not found');
        return send(res, 200, { ok: true });
      }
    }
    if (b === 'mailsubs' && c && method === 'DELETE') {
      if (!dismissMailSub(app, Number(c))) throw new HttpError(404, 'Not found');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
