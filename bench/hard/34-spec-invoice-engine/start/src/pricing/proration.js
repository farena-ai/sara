// Proration of a line by its period (SPEC rules 21 and 22).
import { fail } from '../errors.js';

/** The share of the billing period a line period covers. */
export function prorationFactor(period, billingPeriod) {
  return fail('NOT_IMPLEMENTED', 'proration');
}

export function prorate(extended, line) {
  if (line.period) return extended.mul(prorationFactor(line.period, line.billingPeriod));
  return extended;
}
