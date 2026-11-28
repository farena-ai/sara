// The calculation pipeline of SPEC rule 10, on the internal form made by model/validate.js.
import { minimumTopUp } from '../billing/minimum.js';
import { allocateExact, allocateLargestRemainder } from '../discounts/allocate.js';
import { applyDocumentDiscounts, isEligible } from '../discounts/document.js';
import { ZERO } from '../num/rational.js';
import { lineAmount } from '../pricing/lineAmount.js';
import { buildBreakdown } from '../tax/breakdown.js';
import { splitLine } from '../tax/compute.js';
import { computeTotals } from './totals.js';

/**
 * Calculates an invoice. Options (used by credit notes):
 *   documentAmountDiscounts  apply "amount" document discounts (default true)
 *   minimumCharge            apply the minimum charge (default true)
 * Returns the internal result: { inv, lines, applied, entries, exemptNet, totals }, amounts as Rationals.
 */
export function calculate(inv, options = {}) {
  const { documentAmountDiscounts = true, minimumCharge = true } = options;

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
      negative: l.negative,
      topUp: false,
    };
  });

  const eligible = lines.filter(isEligible);
  const eligibleTotal = eligible.reduce((s, l) => s.add(l.amount), ZERO);
  const discounts = documentAmountDiscounts ? inv.discounts : inv.discounts.filter((d) => d.type === 'percent');
  const { applied, total } = applyDocumentDiscounts(eligibleTotal, discounts, inv);
  const weights = eligible.map((l) => l.amount);
  const shares = inv.rounding === 'line' ? allocateLargestRemainder(total, weights, inv.digits) : allocateExact(total, weights);
  eligible.forEach((l, i) => {
    l.allocated = shares[i];
  });

  if (minimumCharge) {
    const top = minimumTopUp(lines, inv);
    if (top) lines.push(top);
  }

  if (inv.rounding === 'line') {
    for (const l of lines) {
      const { net, tax, gross } = splitLine(l.amount.sub(l.allocated), l.tax, inv);
      l.net = net;
      l.taxAmount = tax;
      l.gross = gross;
    }
  }

  const { entries, exemptNet } = buildBreakdown(lines, inv);
  const totals = computeTotals({ entries, exemptNet, discountTotal: total }, inv);
  return { inv, lines, applied, entries, exemptNet, totals };
}
