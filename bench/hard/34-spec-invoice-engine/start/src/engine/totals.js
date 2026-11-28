// Document totals and cash rounding (SPEC rules 37 and 38).
import { fail } from '../errors.js';
import { ZERO } from '../num/rational.js';

export function cashRound(gross, inv) {
  if (!inv.cashRounding || inv.cashIncrement === null) return gross;
  return fail('NOT_IMPLEMENTED', 'cash rounding');
}

export function computeTotals({ entries, exemptNet, discountTotal }, inv) {
  const net = entries.reduce((s, e) => s.add(e.net), ZERO).add(exemptNet);
  const tax = entries.reduce((s, e) => s.add(e.taxAmount), ZERO);
  const gross = net.add(tax);
  const payable = cashRound(gross, inv);
  return { discount: discountTotal, net, tax, gross, roundingAdjustment: payable.sub(gross), payable };
}
