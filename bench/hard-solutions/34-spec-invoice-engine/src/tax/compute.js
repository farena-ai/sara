// Tax amounts (SPEC rules 12 to 14, 34 and 35).
import { roundHalfUp, taxRounder } from '../num/round.js';
import { HUNDRED, ZERO } from '../num/rational.js';

/** The exact tax in a price-mode amount at a rate. */
export function exactTax(amount, rate, priceMode) {
  if (rate === null || rate.isZero()) return ZERO;
  return priceMode === 'inclusive' ? amount.mul(rate).div(HUNDRED.add(rate)) : amount.mul(rate).div(HUNDRED);
}

/** Splits a rounded price-mode amount into { net, tax, gross } (line rounding mode, rule 34). */
export function splitLine(amount, tax, inv) {
  const round = taxRounder(inv.taxRounding);
  const t = round(exactTax(amount, tax.rate, inv.priceMode), inv.digits);
  if (inv.priceMode === 'inclusive') return { net: amount.sub(t), tax: t, gross: amount };
  return { net: amount, tax: t, gross: amount.add(t) };
}

/** Net and tax of one class from the exact sum of its amounts (document rounding mode, rule 35). */
export function splitClass(sum, tax, inv) {
  const round = taxRounder(inv.taxRounding);
  const t = round(exactTax(sum, tax.rate, inv.priceMode), inv.digits);
  const shown = roundHalfUp(sum, inv.digits);
  if (inv.priceMode === 'inclusive') return { net: shown.sub(t), tax: t };
  return { net: shown, tax: t };
}
