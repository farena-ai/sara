// Tiered unit prices (SPEC rules 17 to 19).
import { fail } from '../errors.js';
import { parseDecimal } from '../num/parse.js';
import { Rational, ZERO } from '../num/rational.js';

/** Validates a tiers array and returns it sorted by `from`: [{ from: bigint, price, priceText }]. */
export function checkTiers(tiers, field) {
  if (!Array.isArray(tiers) || tiers.length === 0) fail('INVALID_TIERS', `${field}.tiers must be a non-empty array`);
  const out = tiers.map((t, i) => {
    if (t === null || typeof t !== 'object') fail('INVALID_TIERS', `${field}.tiers[${i}] must be an object`);
    const from = parseDecimal(t.from, `${field}.tiers[${i}].from`, { integer: true, min: 1 });
    const price = parseDecimal(t.unitPrice, `${field}.tiers[${i}].unitPrice`, { min: 0, maxDecimals: 6 });
    return { from: from.n, price, priceText: t.unitPrice };
  });
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (out[0].from !== 1n) fail('INVALID_TIERS', `${field}.tiers must start at 1`);
  for (let i = 1; i < out.length; i++) if (out[i].from === out[i - 1].from) fail('INVALID_TIERS', `${field}.tiers has two tiers from ${out[i].from}`);
  return out;
}

/** The tier a volume-priced quantity falls in. */
export function volumeTier(tiers, quantity) {
  let pick = tiers[0];
  for (const t of tiers) if (new Rational(t.from).cmp(quantity) <= 0) pick = t;
  return pick;
}

/** The graduated price of `units` whole units: each unit at the price of the tier it falls in. */
export function graduatedAmount(tiers, units) {
  let total = ZERO;
  for (let i = 0; i < tiers.length; i++) {
    const first = tiers[i].from;
    const last = i + 1 < tiers.length ? tiers[i + 1].from - 1n : units;
    const top = last < units ? last : units;
    if (top >= first) total = total.add(tiers[i].price.mul(new Rational(top - first + 1n)));
  }
  return total;
}
