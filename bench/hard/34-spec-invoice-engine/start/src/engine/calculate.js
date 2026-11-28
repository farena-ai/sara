// The calculation pipeline of SPEC rule 10, on the internal form made by model/validate.js.
import { minimumTopUp } from '../billing/minimum.js';
import { allocate } from '../discounts/allocate.js';
import { applyDocumentDiscounts, isEligible } from '../discounts/document.js';
import { fail } from '../errors.js';
import { ZERO } from '../num/rational.js';
import { lineAmount } from '../pricing/lineAmount.js';
import { buildBreakdown } from '../tax/breakdown.js';
import { splitLine } from '../tax/compute.js';
import { computeTotals } from './totals.js';

/**
 * Calculates an invoice.
 * Returns the internal result: { inv, lines, applied, entries, exemptNet, totals }, amounts as Rationals.
 */
export function calculate(inv) {
  if (inv.rounding === 'document') fail('NOT_IMPLEMENTED', 'document rounding');

  const lines = inv.lines.map((l) => {
    const { unitPriceText, amount } = lineAmount(l, inv);
    return {
      id: l.id,
      description: l.description,
      tax: l.tax,
      quantityText: l.quantityText,
      unitPriceText,
      amount,
      allocated: ZERO,
      discountable: l.discountable,
    };
  });

  const eligible = lines.filter(isEligible);
  const eligibleTotal = eligible.reduce((s, l) => s.add(l.amount), ZERO);
  const { applied, total } = applyDocumentDiscounts(eligibleTotal, inv.discounts, inv);
  const shares = allocate(total, eligible.map((l) => l.amount), inv);
  eligible.forEach((l, i) => {
    l.allocated = shares[i];
  });

  const top = minimumTopUp(lines, inv);
  if (top) lines.push(top);

  for (const l of lines) {
    const { net, tax, gross } = splitLine(l.amount.sub(l.allocated), l.tax, inv);
    l.net = net;
    l.taxAmount = tax;
    l.gross = gross;
  }

  const { entries, exemptNet } = buildBreakdown(lines, inv);
  const totals = computeTotals({ entries, exemptNet, discountTotal: total }, inv);
  return { inv, lines, applied, entries, exemptNet, totals };
}
