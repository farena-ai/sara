// E6 (docs/BUSINESS_TOOLS.md): invoices and quotes. The numbers come from code (src/biz/money.ts),
// the file from the person's own template when they have one (fill_document's engine, a checked
// copy of THEIR file) or from make_document's engine with a clean default layout. Due reminders go
// through the Planner's ordinary reminders (the existing tick); nothing here sends email.
import { fillFile, normLabel, type FillItem } from '../documents/fill.ts';
import { readXlsxCells } from '../library/ooxml.ts';
import { openZip } from '../library/zip.ts';
import { fmtMoney } from './money.ts';
import { addDays, morningOf, type BusinessDetails, type Invoice } from './store.ts';

export const KIND_WORD = { invoice: 'Invoice', quote: 'Quote' } as const;

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : String(q));
/** "2026-11-13" → "Nov 13, 2026" (US English). */
export const usDate = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** The default layout, as Markdown for make_document's engine (Word and PDF read it the same way). */
export function invoiceMarkdown(inv: Invoice, biz: BusinessDetails, hasLogo: boolean): string {
  const word = KIND_WORD[inv.kind];
  const m = (c: number) => fmtMoney(c, inv.currency);
  const out: string[] = [];
  // The heading comes first (it is the document's title); the logo under it, without a caption.
  out.push(`# ${word} ${inv.number}`, '');
  if (hasLogo && biz.logoDocId) out.push(`![](library:${biz.logoDocId})`, '');
  const from = [biz.name ? `**${biz.name}**` : '', ...biz.address.split(/\n/).map((l) => l.trim()).filter(Boolean), [biz.email, biz.phone].filter(Boolean).join(' · '), biz.taxId ? `Tax ID: ${biz.taxId}` : ''].filter(Boolean);
  if (from.length) out.push(from.join('  \n'), '');
  const to = [inv.clientName, inv.clientEmail, inv.clientAddress].filter(Boolean).join(', ');
  out.push('| | |', '| --- | --- |', `| ${inv.kind === 'quote' ? 'Prepared for' : 'Bill to'} | ${esc(to)} |`, `| ${word} number | ${inv.number} |`, `| Date | ${usDate(inv.issued)} |`);
  if (inv.due) out.push(`| ${inv.kind === 'quote' ? 'Valid until' : 'Due date'} | ${usDate(inv.due)} |`);
  out.push('', '| Description | Qty | Unit price | Amount |', '| --- | ---: | ---: | ---: |');
  for (const l of inv.lines) out.push(`| ${esc(l.desc)} | ${qtyText(l.qty)} | ${m(l.unitCents)} | ${m(l.amountCents)} |`);
  out.push(`| | | Subtotal | ${m(inv.subtotalCents)} |`);
  if (inv.taxRatePct) out.push(`| | | Tax (${inv.taxRatePct}%) | ${m(inv.taxCents)} |`);
  out.push(`| | | **Total** | **${m(inv.totalCents)}** |`, '');
  if (inv.kind === 'invoice' && biz.payment.trim()) out.push('## How to pay', '', biz.payment.trim(), '');
  if (inv.notes.trim()) out.push('## Notes', '', inv.notes.trim(), '');
  return out.join('\n');
}

// ---------------------------------------------------------------- the person's own template

const SYN: Record<string, string[]> = {
  number: ['invoice number', 'invoice no', 'invoice #', 'invoice num', 'quote number', 'quote no', 'quote #', 'estimate number', 'estimate #', 'estimate no'],
  date: ['invoice date', 'quote date', 'date', 'date issued', 'issue date'],
  due: ['due date', 'payment due', 'due', 'valid until', 'expiration date', 'expires'],
  client: ['bill to', 'billed to', 'client', 'customer', 'to', 'prepared for', 'client name', 'customer name'],
  email: ['client email', 'customer email', 'email'],
  subtotal: ['subtotal', 'sub total', 'sub-total'],
  tax: ['tax', 'sales tax', 'vat', 'gst', 'tax amount'],
  total: ['total', 'total due', 'amount due', 'balance due', 'grand total', 'total amount'],
  notes: ['notes', 'comments', 'memo'],
  payment: ['payment instructions', 'payment details', 'how to pay', 'payment'],
};
const COLS: Record<'desc' | 'qty' | 'unit' | 'amount', RegExp> = {
  desc: /^(description|item|items|service|services|product|details|item description|work)$/,
  qty: /^(qty|quantity|hours|hrs|units|qty\/hrs|qty \/ hours)$/,
  unit: /^(unit price|price|rate|unit cost|cost|price each|rate\/price|hourly rate)$/,
  amount: /^(amount|line total|total|subtotal|ext price|extended)$/,
};

/** The template's item table (xlsx): the header row with a description column, and its columns. */
export function xlsxItemTable(bytes: Buffer): { sheet: string; row: number; cols: Partial<Record<keyof typeof COLS, string>> } | undefined {
  const sheets = readXlsxCells(openZip(bytes));
  for (const [sheet, cells] of sheets) {
    const rows = new Map<number, { col: string; text: string }[]>();
    for (const [ref, text] of cells) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
      const list = rows.get(Number(m[2])) ?? [];
      list.push({ col: m[1], text: normLabel(text) });
      rows.set(Number(m[2]), list);
    }
    for (const [row, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const cols: Partial<Record<keyof typeof COLS, string>> = {};
      for (const c of list) for (const k of Object.keys(COLS) as (keyof typeof COLS)[]) if (!cols[k] && COLS[k].test(c.text)) cols[k] = c.col;
      if (cols.desc && (cols.qty || cols.unit || cols.amount)) return { sheet, row, cols };
    }
  }
  return undefined;
}

/** What goes into the person's template: its labels (found by probing) and, for xlsx, the item rows by cell. */
export function templateItems(name: string, bytes: Buffer, inv: Invoice, biz: BusinessDetails): { items: FillItem[]; placedLines: boolean } {
  const m = (c: number) => fmtMoney(c, inv.currency);
  const val: Record<string, string> = {
    number: inv.number,
    date: usDate(inv.issued),
    due: inv.due ? usDate(inv.due) : '',
    client: [inv.clientName, inv.clientAddress].filter(Boolean).join(', '),
    email: inv.clientEmail,
    subtotal: m(inv.subtotalCents),
    tax: inv.taxRatePct ? m(inv.taxCents) : '',
    total: m(inv.totalCents),
    notes: inv.notes,
    payment: biz.payment,
  };
  // A trial fill with every wording finds which labels the template has; the first that fills wins.
  const trial: { key: string; label: string }[] = [];
  for (const [key, list] of Object.entries(SYN)) if (val[key]) for (const label of list) trial.push({ key, label });
  const lineLabels = ['description', 'items', 'services', 'item description'];
  let probe;
  try {
    probe = fillFile(name, bytes, [...trial.map((x) => ({ kind: 'label' as const, label: x.label, value: val[x.key] })), ...lineLabels.map((label) => ({ kind: 'label' as const, label, value: 'x' }))]);
  } catch {
    probe = undefined;
  }
  const filledLabels = new Set((probe?.fields ?? []).filter((f) => f.status === 'filled').map((f) => normLabel(f.field)));
  const items: FillItem[] = [];
  const used = new Set<string>();
  for (const [key, list] of Object.entries(SYN)) {
    if (!val[key]) continue;
    const hit = list.find((s) => filledLabels.has(normLabel(s)) && !used.has(normLabel(s)));
    if (!hit) continue;
    used.add(normLabel(hit));
    items.push({ kind: 'label', label: hit, value: val[key] });
  }
  const have = new Set(lineLabels.filter((s) => filledLabels.has(s)));
  let placedLines = false;
  if (/\.xlsx$/i.test(name)) {
    const t = xlsxItemTable(bytes);
    if (t) {
      inv.lines.forEach((l, i) => {
        const r = t.row + 1 + i;
        const at = (col: string | undefined, value: string | number) => col && items.push({ kind: 'cell', cell: `${col}${r}`, value, sheet: t.sheet });
        at(t.cols.desc, l.desc);
        at(t.cols.qty, l.qty);
        at(t.cols.unit, l.unitCents / 100);
        at(t.cols.amount, l.amountCents / 100);
      });
      placedLines = true;
    }
  }
  if (!placedLines) {
    // Word templates: the items as lines under a Description / Items label, when there is one.
    const hit = ['description', 'items', 'services', 'item description'].find((s) => have.has(s));
    if (hit) {
      items.push({ kind: 'label', label: hit, value: inv.lines.map((l) => `${l.desc} — ${qtyText(l.qty)} × ${m(l.unitCents)} = ${m(l.amountCents)}`).join('\n') });
      placedLines = true;
    }
  }
  return { items, placedLines };
}

// ---------------------------------------------------------------- reminders

/** The due reminders for a sent invoice: the day before it's due, and 3 days after if still unpaid. */
export function dueReminders(inv: Invoice, timeZone: string | undefined, now: Date): { text: string; dueAt: string }[] {
  if (inv.kind !== 'invoice' || !inv.due) return [];
  const amount = fmtMoney(inv.totalCents, inv.currency);
  const plan = [
    { day: addDays(inv.due, -1), text: `Invoice ${inv.number} to ${inv.clientName} (${amount}) is due tomorrow.` },
    { day: addDays(inv.due, 3), text: `Invoice ${inv.number} to ${inv.clientName} (${amount}) is 3 days overdue. Mark it paid if it came in (invoice_mark), or send a friendly nudge.` },
  ];
  return plan.map((p) => ({ text: p.text, dueAt: morningOf(p.day, timeZone).toISOString() })).filter((p) => Date.parse(p.dueAt) > now.getTime());
}
