// Document discounts (SPEC rules 27 to 29 and 31).
import { fail } from '../errors.js';
import { ZERO } from '../num/rational.js';

/** The lines a document discount spreads over. */
export function isEligible(line) {
  return line.discountable;
}

/**
 * Applies the document discounts to the eligible total. Returns
 * { applied: [{ discount, amount }], total }.
 */
export function applyDocumentDiscounts(eligibleTotal, discounts, inv) {
  if (discounts.length > 0) fail('NOT_IMPLEMENTED', 'document discounts');
  return { applied: [], total: ZERO };
}
