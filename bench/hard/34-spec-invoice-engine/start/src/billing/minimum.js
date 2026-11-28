// The minimum charge (SPEC rules 32 and 33).
import { fail } from '../errors.js';

/** The top-up line to append, or null. */
export function minimumTopUp(lines, inv) {
  if (!inv.minimum) return null;
  return fail('NOT_IMPLEMENTED', 'minimum charge');
}
