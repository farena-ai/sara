// A line's own discounts (SPEC rules 23 and 24).
import { HUNDRED, Rational, ZERO } from '../num/rational.js';

/** Applies a line's discounts to its amount. */
export function applyLineDiscounts(amount, discounts) {
  let a = amount;
  for (const d of discounts) {
    if (d.type === 'percent') a = a.mul(HUNDRED.sub(d.v)).div(HUNDRED);
    else a = Rational.max(ZERO, a.sub(d.v));
  }
  return a;
}
