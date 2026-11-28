// Turns an internal result into the plain result object of docs/SPEC.md (rules 4, 31, 36, 37).
import { formatAmount } from '../money/format.js';

export function toResult(internal, meta) {
  const { inv } = internal;
  const show = (x) => formatAmount(x, inv.digits);
  return {
    kind: meta.kind,
    number: meta.number,
    creditFor: meta.creditFor,
    issueDate: meta.issueDate,
    currency: inv.currency,
    priceMode: inv.priceMode,
    rounding: inv.rounding,
    lines: internal.lines.map((l) => ({
      id: l.id,
      description: l.description,
      taxClass: l.tax.name,
      quantity: l.quantityText,
      unitPrice: l.unitPriceText,
      amount: show(l.amount),
      allocatedDiscount: show(l.allocated),
      net: show(l.net),
      tax: show(l.taxAmount),
      gross: show(l.gross),
    })),
    discounts: internal.applied.map((a) => ({ code: a.discount.code, type: a.discount.type, value: a.discount.value, amount: show(a.amount) })),
    taxes: internal.entries.map((e) => ({ taxClass: e.tax.name, rate: e.tax.rateText, net: show(e.net), tax: show(e.taxAmount) })),
    totals: Object.fromEntries(['discount', 'net', 'tax', 'gross', 'roundingAdjustment', 'payable'].map((k) => [k, show(internal.totals[k])])),
  };
}
