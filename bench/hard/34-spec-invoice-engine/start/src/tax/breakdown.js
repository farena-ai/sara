// The tax breakdown of a result (SPEC rules 14 to 16 and 34).
import { ZERO } from '../num/rational.js';

/** Groups taxed lines by class. Returns { entries: [{ tax, net, taxAmount }], exemptNet }. */
export function buildBreakdown(lines) {
  const groups = new Map();
  let exemptNet = ZERO;
  for (const l of lines) {
    if (l.tax.exempt) {
      exemptNet = exemptNet.add(l.net);
      continue;
    }
    if (!groups.has(l.tax.name)) groups.set(l.tax.name, { tax: l.tax, net: ZERO, taxAmount: ZERO });
    const g = groups.get(l.tax.name);
    g.net = g.net.add(l.net);
    g.taxAmount = g.taxAmount.add(l.taxAmount);
  }
  const entries = [...groups.values()];
  entries.sort((a, b) => b.tax.rate.cmp(a.tax.rate));
  return { entries, exemptNet };
}
