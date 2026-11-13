// E6 (docs/BUSINESS_TOOLS.md): receipts to an expense report. A receipt's text (a PDF's text, or a
// photo read by the Library / the picture reader) is parsed by code for the vendor, date, total and
// tax; the model may give or correct any of them. Duplicates (same vendor, day and total) are
// caught before saving. The report is made with make_document's engine (xlsx or pdf): every
// expense, totals by category, and the receipts listed with their Library numbers.
import { fmtMoney, toCents } from './money.ts';
import { EXPENSE_CATEGORIES, type Expense } from './store.ts';
import type { Sheet } from '../documents/spec.ts';
import { usDate } from './invoices.ts';

export interface ReceiptGuess {
  vendor?: string;
  date?: string;
  totalCents?: number;
  taxCents?: number;
  category?: string;
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A date as written on a receipt → YYYY-MM-DD (US order for 01/02/2026; 2-digit years are 20xx). */
export function receiptDate(text: string): string | undefined {
  const tries: [RegExp, (m: RegExpExecArray) => [number, number, number]][] = [
    [/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/, (m) => [+m[1], +m[2], +m[3]]],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, (m) => [+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]]],
    [/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/, (m) => [+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]]],
    [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i, (m) => [+m[3], MON.indexOf(m[1].toLowerCase()) + 1, +m[2]]],
    [/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\b/i, (m) => [+m[3], MON.indexOf(m[2].toLowerCase()) + 1, +m[1]]],
  ];
  for (const [re, f] of tries) {
    const m = re.exec(text);
    if (!m) continue;
    const [y, mo, d] = f(m);
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (mo >= 1 && mo <= 12 && t.getUTCMonth() === mo - 1 && y > 2000 && y < 2100) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return undefined;
}

const AMOUNT = /(-?\$?\s?\d{1,3}(?:[,.]\d{3})*[.,]\d{2}|-?\$?\s?\d+[.,]\d{2})\b/g;
const amountsIn = (line: string) => [...line.matchAll(AMOUNT)].map((m) => toCents(m[1])).filter((c): c is number => c !== undefined);

const CATEGORY_WORDS: [string, RegExp][] = [
  ['Meals', /\b(restaurant|cafe|café|coffee|starbucks|diner|grill|pizza|burger|bistro|bar|kitchen|taco|sushi|bakery|deli|doordash|uber ?eats|grubhub|mcdonald|chipotle)\b/i],
  ['Fuel', /\b(shell|chevron|exxon|mobil|bp|texaco|valero|gas station|fuel|gasoline|diesel|unleaded|pump)\b/i],
  ['Travel', /\b(airline|airlines|delta|united|american airlines|southwest|uber|lyft|taxi|parking|toll|amtrak|train|rental car|hertz|avis|enterprise)\b/i],
  ['Lodging', /\b(hotel|inn|motel|marriott|hilton|hyatt|airbnb|lodge|resort|suites)\b/i],
  ['Office supplies', /\b(staples|office depot|officemax|paper|toner|ink|pens|supplies)\b/i],
  ['Software', /\b(software|subscription|saas|license|adobe|microsoft 365|google workspace|github|dropbox|zoom)\b/i],
  ['Equipment', /\b(best buy|apple store|monitor|laptop|keyboard|printer|camera|hardware|tools?)\b/i],
  ['Phone and internet', /\b(verizon|at&t|t-mobile|comcast|xfinity|spectrum|internet|wireless|phone bill)\b/i],
  ['Shipping', /\b(ups|fedex|usps|dhl|postage|shipping|post office)\b/i],
  ['Advertising', /\b(advertis\w*|facebook ads|google ads|promotion|flyers|signage)\b/i],
  ['Professional services', /\b(attorney|lawyer|accountant|cpa|consult\w*|legal services)\b/i],
];
export function guessCategory(text: string): string {
  for (const [c, re] of CATEGORY_WORDS) if (re.test(text)) return c;
  return 'Other';
}
export function cleanCategory(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  return EXPENSE_CATEGORIES.find((c) => c.toLowerCase() === s.toLowerCase()) ?? s.slice(0, 40).replace(/^\w/, (x) => x.toUpperCase());
}

/** What code can read from a receipt's text: vendor (the first named line), date, total, tax. */
export function parseReceipt(text: string): ReceiptGuess {
  const lines = text
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^\[[^\]]{1,40}\]$/.test(l));
  const out: ReceiptGuess = {};
  const vendorLine = lines.find((l) => /\p{L}{3}/u.test(l) && !/\b(receipt|invoice|tax|total|date|order|thank|welcome|tel|phone|www\.|http|store #|cashier|transaction)\b/i.test(l) && !/^\d/.test(l) && l.length <= 60);
  if (vendorLine) out.vendor = vendorLine.replace(/[*#]+/g, '').trim();
  out.date = receiptDate(text);
  // Total: the last "total" line that isn't a subtotal / tax line; else "amount due / balance"; else the largest amount.
  const totalLines = lines.filter((l) => /\b(total|amount due|balance due|amount paid|grand total|charged)\b/i.test(l) && !/\b(sub-?\s?total|tax|savings|discount|items?)\b/i.test(l));
  const fromTotals = totalLines.flatMap(amountsIn).filter((c) => c > 0);
  if (fromTotals.length) out.totalCents = Math.max(...fromTotals);
  else {
    const all = lines.flatMap(amountsIn).filter((c) => c > 0);
    if (all.length) out.totalCents = Math.max(...all);
  }
  const taxLine = lines.filter((l) => /\b(tax|vat|gst|hst)\b/i.test(l) && !/\b(before tax|pre-?tax|tax id|tax ?#|incl)\b/i.test(l));
  const tax = taxLine.flatMap(amountsIn).filter((c) => c > 0 && (!out.totalCents || c < out.totalCents));
  if (tax.length) out.taxCents = tax[tax.length - 1];
  out.category = guessCategory(text);
  return out;
}

export interface ReportParts {
  totalCents: number;
  byCategory: { category: string; count: number; totalCents: number; taxCents: number }[];
  sheets: Sheet[];
  markdown: string;
}

/** The report's numbers (by code) and its content for xlsx (sheets) or pdf/docx (Markdown). */
export function expenseReport(list: Expense[], o: { from: string; to: string; who: string; currency: string; pictures?: Set<number> }): ReportParts {
  const m = (c: number) => fmtMoney(c, o.currency);
  const cats = new Map<string, { count: number; totalCents: number; taxCents: number }>();
  for (const e of list) {
    const c = cats.get(e.category) ?? { count: 0, totalCents: 0, taxCents: 0 };
    c.count++;
    c.totalCents += e.totalCents;
    c.taxCents += e.taxCents;
    cats.set(e.category, c);
  }
  const byCategory = [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category));
  const totalCents = list.reduce((n, e) => n + e.totalCents, 0);
  const taxCents = list.reduce((n, e) => n + e.taxCents, 0);
  const receipt = (e: Expense) => (e.docId ? `${e.docName || 'receipt'} (Library #${e.docId})` : '');
  const sheets: Sheet[] = [
    {
      name: 'Expenses',
      rows: [['Date', 'Vendor', 'Category', 'Tax', 'Total', 'Receipt', 'Note'], ...list.map((e) => [e.date, e.vendor, e.category, e.taxCents / 100, e.totalCents / 100, receipt(e), e.note]), ['', 'Total', '', taxCents / 100, totalCents / 100, '', '']],
    },
    { name: 'By category', rows: [['Category', 'Receipts', 'Tax', 'Total'], ...byCategory.map((c) => [c.category, c.count, c.taxCents / 100, c.totalCents / 100]), ['Total', list.length, taxCents / 100, totalCents / 100]] },
  ];
  const md: string[] = [`# Expense report`, '', `${o.who ? `${o.who} · ` : ''}${usDate(o.from)} to ${usDate(o.to)} · ${list.length} receipt${list.length === 1 ? '' : 's'} · total ${m(totalCents)}`, '', '## By category', '', '| Category | Receipts | Tax | Total |', '| --- | ---: | ---: | ---: |'];
  for (const c of byCategory) md.push(`| ${c.category} | ${c.count} | ${m(c.taxCents)} | ${m(c.totalCents)} |`);
  md.push(`| **Total** | **${list.length}** | **${m(taxCents)}** | **${m(totalCents)}** |`, '', '## Expenses', '', '| Date | Vendor | Category | Tax | Total | Receipt |', '| --- | --- | --- | ---: | ---: | --- |');
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  for (const e of list) md.push(`| ${usDate(e.date)} | ${cell(e.vendor)} | ${cell(e.category)} | ${m(e.taxCents)} | ${m(e.totalCents)} | ${cell(receipt(e))} |`);
  const pics = list.filter((e) => e.docId && o.pictures?.has(e.docId)).slice(0, 30);
  if (pics.length) {
    md.push('', '[page break]', '', '## Receipts', '');
    for (const e of pics) md.push(`![${cell(`${e.vendor}, ${usDate(e.date)}, ${m(e.totalCents)}`)}](library:${e.docId})`, '');
  }
  return { totalCents, byCategory, sheets, markdown: md.join('\n') };
}
