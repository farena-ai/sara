// R6 (docs/WORK_APPS.md): accounting export files. Invoices and expenses (E6, src/biz) and time
// (N7, src/work) as the CSV files QuickBooks Online and Xero import, plus one generic CSV. Files
// only: nothing is sent to QuickBooks, Xero or anyone (no API calls, no keys).
import type { AppContext } from '../chat.ts';
import { bizStore, type Invoice } from '../biz/store.ts';
import { timeOf } from '../tools/work.ts';
import { str, ToolError, type Tool } from '../tools/types.ts';

export const ACCOUNTING_FORMATS = ['quickbooks', 'xero', 'wave', 'generic'] as const;
export type AccountingFormat = (typeof ACCOUNTING_FORMATS)[number];
export const ACCOUNTING_PARTS = ['invoices', 'expenses', 'time', 'summary', 'all'] as const;
export type AccountingPart = (typeof ACCOUNTING_PARTS)[number];
export const FORMAT_NAME: Record<AccountingFormat, string> = { quickbooks: 'QuickBooks Online', xero: 'Xero', wave: 'Wave (bank statement CSV)', generic: 'generic CSV' };

/** One CSV line: quoted when needed; text that a spreadsheet would run as a formula gets a leading '. */
export function csvLine(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      let s = typeof c === 'number' ? String(c) : String(c ?? '');
      if (typeof c !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}
const money = (cents: number) => (cents / 100).toFixed(2);
const us = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const hm = (h: number) => `${Math.floor(h)}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
/** A line's share of the invoice tax (the last line takes the rounding rest). */
function lineTaxes(inv: Invoice): number[] {
  if (!inv.taxCents) return inv.lines.map(() => 0);
  let left = inv.taxCents;
  return inv.lines.map((l, i) => {
    if (i === inv.lines.length - 1) return left;
    const t = inv.subtotalCents ? Math.round((inv.taxCents * l.amountCents) / inv.subtotalCents) : 0;
    left -= t;
    return t;
  });
}

export interface ExportOpts {
  from: string;
  to: string;
  format: AccountingFormat;
  what: AccountingPart;
}
export interface ExportFile {
  name: string;
  csv: string;
  rows: number;
}

/** One CSV for one part (or, generic only, everything in one file). */
export function accountingCsv(app: AppContext, o: ExportOpts): ExportFile {
  if (!DAY.test(o.from) || !DAY.test(o.to)) throw new ToolError('Use dates like 2026-11-01.');
  if (o.from > o.to) throw new ToolError('The start date must be before the end date.');
  if (!(ACCOUNTING_FORMATS as readonly string[]).includes(o.format)) throw new ToolError('The format is quickbooks, xero, wave or generic.');
  if (o.what === 'summary') return summaryCsv(app, o);
  if (o.format === 'wave') return waveCsv(app, o);
  if (o.what === 'all' && o.format !== 'generic') throw new ToolError('QuickBooks and Xero take invoices, expenses and time as separate files.');
  const biz = bizStore(app);
  const inRange = (d: string) => d >= o.from && d <= o.to;
  const invoices = o.what === 'invoices' || o.what === 'all' ? biz.invoices().filter((i) => i.kind === 'invoice' && i.status !== 'void' && inRange(i.issued)).sort((a, b) => (a.issued < b.issued ? -1 : 1)) : [];
  const expenses = o.what === 'expenses' || o.what === 'all' ? biz.expenses({ from: o.from, to: o.to }).sort((a, b) => (a.date < b.date ? -1 : 1)) : [];
  const time = o.what === 'time' || o.what === 'all' ? timeOf(app).list({ from: o.from, to: o.to }).filter((e) => !e.running && e.hours !== null) : [];
  const out: string[] = [];
  let rows = 0;
  const push = (cells: (string | number)[]) => {
    out.push(csvLine(cells));
    rows++;
  };
  if (o.format === 'generic') {
    out.push(csvLine(['Type', 'Date', 'Number', 'Party', 'Description', 'Quantity', 'Rate', 'Amount', 'Tax', 'Currency', 'Status']));
    for (const inv of invoices) {
      const tax = lineTaxes(inv);
      inv.lines.forEach((l, i) => push(['invoice', inv.issued, inv.number, inv.clientName, l.desc, l.qty, money(l.unitCents), money(l.amountCents), money(tax[i]), inv.currency, inv.status]));
    }
    for (const e of expenses) push(['expense', e.date, '', e.vendor, [e.category, e.note].filter(Boolean).join(' - '), 1, money(e.totalCents), money(-e.totalCents), money(e.taxCents), e.currency, '']);
    for (const t of time) push(['time', t.day, '', t.client, [t.project, t.note].filter(Boolean).join(' - '), t.hours!, '', '', '', '', t.invoiceId ? 'billed' : 'unbilled']);
  } else if (o.what === 'invoices') {
    if (o.format === 'quickbooks') {
      out.push(csvLine(['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', 'ItemTaxCode', 'ItemTaxAmount', 'Currency']));
      for (const inv of invoices) {
        const tax = lineTaxes(inv);
        const terms = inv.due ? (daysBetween(inv.issued, inv.due) === 0 ? 'Due on receipt' : `Net ${daysBetween(inv.issued, inv.due)}`) : '';
        inv.lines.forEach((l, i) => push([inv.number, inv.clientName, us(inv.issued), inv.due ? us(inv.due) : us(inv.issued), terms, l.desc, l.qty, money(l.unitCents), money(l.amountCents), tax[i] ? 'TAX' : 'NON', money(tax[i]), inv.currency]));
      }
    } else {
      out.push(csvLine(['*ContactName', 'EmailAddress', 'POAddressLine1', '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate', '*Description', '*Quantity', '*UnitAmount', 'Discount', '*AccountCode', '*TaxType', 'TaxAmount', 'Currency']));
      for (const inv of invoices) {
        const tax = lineTaxes(inv);
        inv.lines.forEach((l, i) => push([inv.clientName, inv.clientEmail, inv.clientAddress.split('\n')[0] ?? '', inv.number, inv.notes.slice(0, 50), dmy(inv.issued), dmy(inv.due ?? inv.issued), l.desc, l.qty, money(l.unitCents), '', '200', tax[i] ? 'Tax on Sales' : 'Tax Exempt', money(tax[i]), inv.currency]));
      }
    }
  } else if (o.what === 'expenses') {
    if (o.format === 'quickbooks') {
      // QuickBooks Online's 3-column bank transaction file (money out is negative).
      out.push(csvLine(['Date', 'Description', 'Amount']));
      for (const e of expenses) push([us(e.date), [e.vendor, e.category, e.note].filter(Boolean).join(' - '), money(-e.totalCents)]);
    } else {
      // Xero's bank statement import (precoded columns).
      out.push(csvLine(['*Date', '*Amount', 'Payee', 'Description', 'Reference']));
      for (const e of expenses) push([dmy(e.date), money(-e.totalCents), e.vendor, [e.category, e.note].filter(Boolean).join(' - '), `Sara expense ${e.id}`]);
    }
  } else if (o.format === 'quickbooks') {
    // QuickBooks Online time activity columns (Duration as hh:mm).
    out.push(csvLine(['Date', 'Customer', 'Service', 'Description', 'Duration', 'Billable']));
    for (const t of time) push([us(t.day), t.client, t.project, t.note, hm(t.hours!), t.invoiceId ? 'No' : 'Yes']);
  } else {
    out.push(csvLine(['Date', 'Contact', 'Project', 'Description', 'Hours', 'Billed']));
    for (const t of time) push([dmy(t.day), t.client, t.project, t.note, t.hours!, t.invoiceId ? 'Yes' : 'No']);
  }
  return { name: `${o.format}-${o.what}-${o.from}-to-${o.to}.csv`, csv: `${out.join('\r\n')}\r\n`, rows };
}

/** U4.29: income and expenses by category for the period (invoices issued, not void; tax apart). */
function summaryCsv(app: AppContext, o: ExportOpts): ExportFile {
  const biz = bizStore(app);
  const rows = new Map<string, { type: string; cat: string; amount: number; tax: number; n: number; cur: string }>();
  const add = (type: string, cat: string, amount: number, tax: number, cur: string) => {
    const k = `${type}|${cat}|${cur}`;
    const r = rows.get(k) ?? { type, cat, amount: 0, tax: 0, n: 0, cur };
    r.amount += amount;
    r.tax += tax;
    r.n++;
    rows.set(k, r);
  };
  for (const i of biz.invoices()) if (i.kind === 'invoice' && i.status !== 'void' && i.issued >= o.from && i.issued <= o.to) add('income', 'Sales', i.subtotalCents, i.taxCents, i.currency);
  for (const e of biz.expenses({ from: o.from, to: o.to })) add('expense', e.category || 'Other', e.totalCents, e.taxCents, e.currency);
  const list = [...rows.values()].sort((a, b) => (a.type === b.type ? a.cat.localeCompare(b.cat) : a.type === 'income' ? -1 : 1));
  const out = [csvLine(['Type', 'Category', 'Amount', 'Tax', 'Count', 'Currency']), ...list.map((r) => csvLine([r.type, r.cat, money(r.amount), money(r.tax), r.n, r.cur]))];
  return { name: `summary-${o.from}-to-${o.to}.csv`, csv: `${out.join('\r\n')}\r\n`, rows: list.length };
}

/** U4.29: Wave's (and most bank-statement importers') 3-column CSV: money in positive, out negative. */
function waveCsv(app: AppContext, o: ExportOpts): ExportFile {
  const biz = bizStore(app);
  const lines: [string, string, number][] = [];
  if (o.what === 'invoices' || o.what === 'all') for (const i of biz.invoices()) if (i.kind === 'invoice' && i.status !== 'void' && i.issued >= o.from && i.issued <= o.to) lines.push([i.issued, `${i.number} ${i.clientName}`, i.totalCents]);
  if (o.what === 'expenses' || o.what === 'all') for (const e of biz.expenses({ from: o.from, to: o.to })) lines.push([e.date, [e.vendor, e.category, e.note].filter(Boolean).join(' - '), -e.totalCents]);
  if (o.what === 'time') throw new ToolError('Wave takes money only: export time as generic, QuickBooks or Xero.');
  lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [csvLine(['Date', 'Description', 'Amount']), ...lines.map((l) => csvLine([l[0], l[1], money(l[2])]))];
  return { name: `wave-${o.what}-${o.from}-to-${o.to}.csv`, csv: `${out.join('\r\n')}\r\n`, rows: lines.length };
}

/** The files one export makes: generic and Wave are one file, QuickBooks and Xero one per part. */
export function accountingFiles(app: AppContext, o: Omit<ExportOpts, 'what'> & { what?: AccountingPart }): ExportFile[] {
  const what = o.what ?? 'all';
  if (what === 'summary' || o.format === 'wave') return [accountingCsv(app, { ...o, what })];
  if (o.format === 'generic') return [accountingCsv(app, { ...o, what })];
  const parts: AccountingPart[] = what === 'all' ? ['invoices', 'expenses', 'time'] : [what];
  return parts.map((p) => accountingCsv(app, { ...o, what: p }));
}

export function createAccountingTool(getApp: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'accounting_export',
      description: 'Make CSV files of the person\'s invoices, expenses and tracked time between two dates, in the format QuickBooks Online or Xero imports (or a generic CSV). Files only: nothing is sent to any accounting service. The files go to the Library.',
      parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, format: { type: 'string', enum: [...ACCOUNTING_FORMATS] }, what: { type: 'string', enum: [...ACCOUNTING_PARTS], description: 'Default: all' } }, required: ['from', 'to', 'format'], additionalProperties: false },
    },
    summarize: (a) => `accounting export (${String(a.format ?? '')}) ${String(a.from ?? '')} → ${String(a.to ?? '')}`,
    async run(args) {
      const app = getApp();
      const format = str(args, 'format') as AccountingFormat;
      const what = (str(args, 'what', false) || 'all') as AccountingPart;
      if (!(ACCOUNTING_PARTS as readonly string[]).includes(what)) throw new ToolError('what is invoices, expenses, time or all.');
      const files = accountingFiles(app, { from: str(args, 'from'), to: str(args, 'to'), format, what });
      const lines: string[] = [];
      for (const f of files) {
        if (!f.rows) {
          lines.push(`- ${f.name}: nothing in that period, no file made.`);
          continue;
        }
        const doc = app.library?.add({ name: f.name, bytes: Buffer.from(f.csv, 'utf8'), keep: true, origin: 'library', learn: false });
        lines.push(`- ${f.name}: ${f.rows} row${f.rows === 1 ? '' : 's'}${doc ? `, saved in the Library (document ${doc.id}, download at /api/library/${doc.id}/file)` : ''}.`);
      }
      return `${FORMAT_NAME[format] ?? format} export, ${str(args, 'from')} to ${str(args, 'to')}:\n${lines.join('\n')}\nNo data was sent anywhere: import the files in ${format === 'quickbooks' ? 'QuickBooks Online (Settings → Import data)' : format === 'xero' ? 'Xero (Business → Invoices → Import, Accounting → Bank accounts → Import a statement)' : 'your spreadsheet or accounting app'}.`;
    },
  };
}
