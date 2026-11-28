// Tax amounts (SPEC rules 12 to 14, 34 and 35).
import { fail } from '../errors.js';
import { taxRounder } from '../num/round.js';
import { HUNDRED, ZERO } from '../num/rational.js';

/** The exact tax on a net amount at a rate. */
export function exactTax(amount, rate) {
  if (rate === null || rate.isZero()) return ZERO;
  return amount.mul(rate).div(HUNDRED);
}

/** Splits a rounded line amount into { net, tax, gross }. */
export function splitLine(amount, tax, inv) {
  if (inv.priceMode === 'inclusive') fail('NOT_IMPLEMENTED', 'tax-inclusive prices');
  const round = taxRounder(inv.taxRounding);
  const t = round(exactTax(amount, tax.rate), inv.digits);
  return { net: amount, tax: t, gross: amount.add(t) };
}
