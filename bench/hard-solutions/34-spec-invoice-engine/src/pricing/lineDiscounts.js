// A line's own discounts (SPEC rules 23 and 24).
import { HUNDRED, Rational, ZERO } from '../num/rational.js';

/**
 * Applies a line's discounts to its prorated amount. `amountScale` multiplies every fixed
 * discount (1 on an invoice; see rule 41 for credit notes).
 */
export function applyLineDiscounts(amount, discounts, amountScale) {
  let a = amount;
  for (const d of discounts) if (d.type === 'percent') a = a.mul(HUNDRED.sub(d.v)).div(HUNDRED);
  for (const d of discounts) if (d.type === 'amount') a = Rational.max(ZERO, a.sub(d.v.mul(amountScale)));
  return a;
}
