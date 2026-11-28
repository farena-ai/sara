// Writing amounts as the strings of an invoice result (SPEC rule 4).
import { Rational } from '../num/rational.js';

/**
 * Formats a value that is already a whole number of minor units: fixed decimals, a leading "-"
 * for negatives, no separators. Throws if the value has finer parts than the currency allows.
 */
export function formatAmount(x, digits) {
  const scale = 10n ** BigInt(digits);
  const minor = x.mul(new Rational(scale));
  if (!minor.isInteger()) throw new RangeError(`${x} is not a whole number of minor units`);
  let n = minor.n;
  const neg = n < 0n;
  if (neg) n = -n;
  let s = n.toString();
  if (digits > 0) {
    s = s.padStart(digits + 1, '0');
    s = `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  }
  return neg ? `-${s}` : s;
}

/** Reads a formatted amount back. */
export function parseAmount(s) {
  return Rational.parse(s);
}
