// Spreading the document discount total over the eligible lines (SPEC rule 30).
import { fail } from '../errors.js';
import { ZERO } from '../num/rational.js';

/** Shares of `total` over `weights`, one per weight. */
export function allocate(total, weights, inv) {
  if (total.isZero()) return weights.map(() => ZERO);
  return fail('NOT_IMPLEMENTED', 'discount allocation');
}
