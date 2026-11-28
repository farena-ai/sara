// A line's amount before document discounts: steps 1 to 5 of SPEC rule 10.
import { roundHalfUp } from '../num/round.js';
import { Rational } from '../num/rational.js';
import { applyLineDiscounts } from './lineDiscounts.js';
import { prorate } from './proration.js';
import { graduatedAmount, volumeTier } from './tiers.js';

/**
 * The extended amount (step 2) and the unit price shown on the line.
 * `tierQuantity` is the quantity that selects tiers; `quantity` the quantity charged.
 */
export function extendedAmount(line) {
  const tierQuantity = line.tierQuantity ?? line.quantity;
  if (!line.tiers) return { unitPriceText: line.unitPriceText, extended: line.quantity.mul(line.unitPrice) };
  if (line.tierMode === 'volume') {
    const tier = volumeTier(line.tiers, tierQuantity);
    return { unitPriceText: tier.priceText, extended: line.quantity.mul(tier.price) };
  }
  const all = tierQuantity.n;
  const charged = line.quantity.n;
  return { unitPriceText: null, extended: graduatedAmount(line.tiers, all).sub(graduatedAmount(line.tiers, all - charged)) };
}

/** Steps 1 to 5: { unitPriceText, amount } with amount exact in document rounding mode. */
export function lineAmount(line, inv) {
  const { unitPriceText, extended } = extendedAmount(line);
  const prorated = prorate(extended, line);
  let amount = applyLineDiscounts(prorated, line.discounts, line.amountDiscountScale ?? new Rational(1n));
  if (inv.rounding === 'line') amount = roundHalfUp(amount, inv.digits);
  return { unitPriceText, amount };
}
