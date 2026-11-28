// A line's amount before document discounts: steps 1 to 5 of SPEC rule 10.
import { roundHalfUp } from '../num/round.js';
import { applyLineDiscounts } from './lineDiscounts.js';
import { prorate } from './proration.js';
import { graduatedAmount, volumeTier } from './tiers.js';

/** The extended amount (step 2) and the unit price shown on the line. */
export function extendedAmount(line) {
  if (!line.tiers) return { unitPriceText: line.unitPriceText, extended: line.quantity.mul(line.unitPrice) };
  if (line.tierMode === 'volume') {
    const tier = volumeTier(line.tiers, line.quantity);
    return { unitPriceText: tier.priceText, extended: line.quantity.mul(tier.price) };
  }
  return { unitPriceText: null, extended: graduatedAmount(line.tiers, line.quantity.n) };
}

/** Steps 1 to 5: { unitPriceText, amount }. */
export function lineAmount(line, inv) {
  const { unitPriceText, extended } = extendedAmount(line);
  const prorated = prorate(extended, line);
  const amount = applyLineDiscounts(prorated, line.discounts);
  return { unitPriceText, amount: roundHalfUp(amount, inv.digits) };
}
