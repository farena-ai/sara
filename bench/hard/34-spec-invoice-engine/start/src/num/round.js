// Rounding to a number of decimal places (SPEC rules 5 and 6).
import { fail } from '../errors.js';
import { Rational } from './rational.js';

function scaleOf(digits) {
  return 10n ** BigInt(digits);
}

/** Rounds to `digits` decimals; a value exactly halfway goes away from zero. */
export function roundHalfUp(x, digits) {
  const scale = scaleOf(digits);
  const a = x.abs().mul(scale);
  const n = (2n * a.n + a.d) / (2n * a.d);
  return new Rational(x.sign() < 0 ? -n : n, scale);
}

/** The rounding function for a `taxRounding` setting. */
export function taxRounder(mode) {
  if (mode === 'half-up') return roundHalfUp;
  if (mode === 'half-even') return fail('NOT_IMPLEMENTED', 'taxRounding "half-even"');
  return fail('INVALID_SETTING', `unknown taxRounding ${mode}`);
}
