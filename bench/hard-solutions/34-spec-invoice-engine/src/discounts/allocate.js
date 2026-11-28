// Spreading the document discount total over the eligible lines (SPEC rule 30).
import { Rational, ZERO } from '../num/rational.js';

/** Exact proportional shares of `total` over `weights` (document rounding mode). */
export function allocateExact(total, weights) {
  const sum = Rational.sum(weights);
  if (sum.isZero()) return weights.map(() => ZERO);
  return weights.map((w) => total.mul(w).div(sum));
}

/**
 * Shares of `total` in whole minor units by the largest-remainder method (line rounding mode).
 * Ties between equal remainders go to the earlier weight.
 */
export function allocateLargestRemainder(total, weights, digits) {
  const sum = Rational.sum(weights);
  if (sum.isZero()) return weights.map(() => ZERO);
  const scale = new Rational(10n ** BigInt(digits));
  const units = total.mul(scale);
  const quotas = weights.map((w) => units.mul(w).div(sum));
  const base = quotas.map((q) => q.floor());
  let left = units.n - base.reduce((s, b) => s + b, 0n);
  const order = quotas
    .map((q, i) => ({ i, rest: q.sub(new Rational(base[i])) }))
    .sort((a, b) => b.rest.cmp(a.rest) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0n) break;
    base[i] += 1n;
    left -= 1n;
  }
  return base.map((b) => new Rational(b).div(scale));
}
