// Turns an internal result into the plain result object of docs/SPEC.md (rules 4, 31, 36, 37).
import { formatAmount } from '../money/format.js';
import { roundHalfUp } from '../num/round.js';

export function toResult(internal, meta) {
  const { inv } = internal;
  const show = (x) => formatAmount(roundHalfUp(x, inv.digits), inv.digits);
  const lineMode = inv.rounding === 'line';
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
      unitPrice: l.topUp ? show(l.amount) : l.unitPriceText,
      amount: show(l.amount),
      allocatedDiscount: show(l.allocated),
      net: lineMode ? show(l.net) : null,
      tax: lineMode ? show(l.taxAmount) : null,
      gross: lineMode ? show(l.gross) : null,
    })),
    discounts: internal.applied.map((a) => ({ code: a.discount.code, type: a.discount.type, value: a.discount.value, amount: show(a.amount) })),
    taxes: internal.entries.map((e) => ({ taxClass: e.tax.name, rate: e.tax.rateText, net: show(e.net), tax: show(e.taxAmount) })),
    totals: Object.fromEntries(['discount', 'net', 'tax', 'gross', 'roundingAdjustment', 'payable'].map((k) => [k, show(internal.totals[k])])),
  };
}
