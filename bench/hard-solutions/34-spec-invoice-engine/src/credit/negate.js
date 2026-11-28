// Negating the amounts of a result (SPEC rule 39).

/** The negation of a formatted amount; a zero keeps no sign. */
export function negateAmount(s) {
  if (s === null) return null;
  if (/^-?[0.]+$/.test(s)) return s.replace('-', '');
  return s.startsWith('-') ? s.slice(1) : `-${s}`;
}

const LINE_AMOUNTS = ['amount', 'allocatedDiscount', 'net', 'tax', 'gross'];

/** A copy of a result with every amount field negated and everything else kept. */
export function negateResult(result) {
  return {
    ...result,
    lines: result.lines.map((l) => {
      const out = { ...l };
      for (const k of LINE_AMOUNTS) out[k] = negateAmount(l[k]);
      return out;
    }),
    discounts: result.discounts.map((d) => ({ ...d, amount: negateAmount(d.amount) })),
    taxes: result.taxes.map((t) => ({ ...t, net: negateAmount(t.net), tax: negateAmount(t.tax) })),
    totals: Object.fromEntries(Object.entries(result.totals).map(([k, v]) => [k, negateAmount(v)])),
  };
}
