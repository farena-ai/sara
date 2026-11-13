// E6 (docs/BUSINESS_TOOLS.md): money in whole cents. Every total is worked out here in code, never
// by the model: amounts are parsed from text or numbers into integer cents, multiplied, rounded half
// away from zero to the cent, and summed as integers.

/** Rounds to the nearest whole number, halves away from zero (2.5 → 3, -2.5 → -3), ignoring float dust. */
export function roundHalf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  // 1e-7 absorbs binary dust like 2998.4999999999995 without moving any real value.
  return s * Math.floor(a + 0.5 + 1e-7);
}

/** "$1,234.56", "1.234,56 €", 12.5, "12" → cents. Undefined when it isn't an amount. */
export function toCents(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? roundHalf(Number(`${v}e2`)) : undefined;
  let s = String(v ?? '').trim();
  if (!s) return undefined;
  const neg = /^\(.*\)$/.test(s) || /^-|-$/.test(s.replace(/[\s$€£¥]/g, ''));
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return undefined;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  // The later separator with 1-2 digits after it is the decimal mark ("1.234,56", "1,234.56", "12,5").
  const dec = Math.max(lastDot, lastComma);
  let whole = s;
  let frac = '';
  if (dec >= 0 && s.length - dec - 1 <= 2 && s.length - dec - 1 > 0) {
    whole = s.slice(0, dec);
    frac = s.slice(dec + 1);
  }
  whole = whole.replace(/[.,]/g, '');
  const n = Number(`${whole || '0'}.${frac || '0'}`);
  if (!Number.isFinite(n)) return undefined;
  const c = roundHalf(Number(`${n}e2`));
  return neg ? -c : c;
}

/** A quantity (hours, pieces): a plain number, up to 4 decimals kept. */
export function toQty(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return undefined;
  return roundHalf(n * 10_000) / 10_000;
}

/** 1234567 → "$12,345.67" (US English; other currencies by code). */
export function fmtMoney(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export interface LineIn {
  desc: string;
  qty: number;
  unitCents: number;
}
export interface Line extends LineIn {
  amountCents: number;
}
export interface Totals {
  lines: Line[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** Line amounts (qty × unit price, rounded to the cent), subtotal, tax on the subtotal (rate in %), total. */
export function totals(items: LineIn[], taxRatePct = 0): Totals {
  const lines = items.map((i) => ({ ...i, amountCents: roundHalf(i.qty * i.unitCents) }));
  const subtotalCents = lines.reduce((n, l) => n + l.amountCents, 0);
  const taxCents = taxRatePct ? roundHalf((subtotalCents * taxRatePct) / 100) : 0;
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
