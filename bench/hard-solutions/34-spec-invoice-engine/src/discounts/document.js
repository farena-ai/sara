// Document discounts (SPEC rules 27 to 29 and 31).
import { roundHalfUp } from '../num/round.js';
import { HUNDRED, Rational, ZERO } from '../num/rational.js';

/** The lines a document discount spreads over. */
export function isEligible(line) {
  return line.discountable && !line.negative;
}

/**
 * Applies the document discounts to the eligible total. Returns
 * { applied: [{ discount, amount }], total } in the order of application.
 */
export function applyDocumentDiscounts(eligibleTotal, discounts, inv) {
  const ordered = [...discounts.filter((d) => d.type === 'percent'), ...discounts.filter((d) => d.type === 'amount')];
  const applied = [];
  let left = eligibleTotal;
  for (const d of ordered) {
    let amount;
    if (d.type === 'percent') {
      amount = left.mul(d.v).div(HUNDRED);
      if (inv.rounding === 'line') amount = roundHalfUp(amount, inv.digits);
    } else {
      amount = Rational.min(d.v, left);
    }
    left = left.sub(amount);
    applied.push({ discount: d, amount });
  }
  return { applied, total: applied.reduce((s, a) => s.add(a.amount), ZERO) };
}
