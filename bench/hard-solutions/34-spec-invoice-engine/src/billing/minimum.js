// The minimum charge (SPEC rules 32 and 33).
import { ZERO } from '../num/rational.js';

/** The top-up line to append, or null. `lines` are calculated lines with `amount` and `allocated`. */
export function minimumTopUp(lines, inv) {
  if (!inv.minimum || lines.length === 0) return null;
  const sum = lines.reduce((s, l) => s.add(l.amount).sub(l.allocated), ZERO);
  if (sum.cmp(inv.minimum.amount) >= 0) return null;
  return {
    id: 'MINIMUM',
    description: 'Minimum charge adjustment',
    tax: inv.minimum.tax,
    quantityText: '1',
    unitPriceText: null,
    amount: inv.minimum.amount.sub(sum),
    allocated: ZERO,
    topUp: true,
  };
}
