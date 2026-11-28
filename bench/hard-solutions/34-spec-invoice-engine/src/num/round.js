// Rounding to a number of decimal places (SPEC rules 5 and 6) and to a cash increment (rule 38).
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

/** Rounds to `digits` decimals; a value exactly halfway goes to the even neighbour. */
export function roundHalfEven(x, digits) {
  const scale = scaleOf(digits);
  const a = x.abs().mul(scale);
  const whole = a.n / a.d;
  const twiceRest = 2n * (a.n - whole * a.d);
  let n = whole;
  if (twiceRest > a.d || (twiceRest === a.d && whole % 2n === 1n)) n = whole + 1n;
  return new Rational(x.sign() < 0 ? -n : n, scale);
}

/** The rounding function for a `taxRounding` setting. */
export function taxRounder(mode) {
  if (mode === 'half-up') return roundHalfUp;
  if (mode === 'half-even') return roundHalfEven;
  return fail('INVALID_SETTING', `unknown taxRounding ${mode}`);
}

/** Rounds to a multiple of `increment` minor units, halfway away from zero. */
export function roundToIncrement(x, digits, increment) {
  const unit = new Rational(BigInt(increment), scaleOf(digits));
  const steps = roundHalfUp(x.div(unit), 0);
  return steps.mul(unit);
}
