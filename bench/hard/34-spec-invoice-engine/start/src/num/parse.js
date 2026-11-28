// Reading the decimal strings of an invoice document (SPEC rules 1 and 7).
import { fail } from '../errors.js';
import { Rational } from './rational.js';

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** The number of digits after the decimal point, as written. */
export function decimalsOf(s) {
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Parses a decimal string field. Options:
 *   maxDecimals  most digits allowed after the point
 *   min, max     inclusive bounds (Rational or integer)
 *   positive     must be greater than zero
 *   integer      must be a whole number
 */
export function parseDecimal(value, field, opts = {}) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail('INVALID_NUMBER', `${field} must be a decimal string, got ${JSON.stringify(value)}`);
  if (opts.maxDecimals !== undefined && decimalsOf(value) > opts.maxDecimals) fail('INVALID_NUMBER', `${field} has more than ${opts.maxDecimals} decimals`);
  const r = Rational.parse(value);
  if (opts.min !== undefined && r.lt(opts.min)) fail('INVALID_NUMBER', `${field} is below ${opts.min}`);
  if (opts.max !== undefined && r.gt(opts.max)) fail('INVALID_NUMBER', `${field} is above ${opts.max}`);
  if (opts.positive && r.sign() <= 0) fail('INVALID_NUMBER', `${field} must be greater than zero`);
  if (opts.integer && !r.isInteger()) fail('INVALID_NUMBER', `${field} must be a whole number`);
  return r;
}

/** Writes a rate or percentage without trailing zeros: "5.50" -> "5.5", "20.0" -> "20". */
export function normalizeDecimal(s) {
  const neg = s.startsWith('-');
  let body = neg ? s.slice(1) : s;
  let [int, frac = ''] = body.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  body = frac ? `${int}.${frac}` : int;
  return neg && body !== '0' ? `-${body}` : body;
}
