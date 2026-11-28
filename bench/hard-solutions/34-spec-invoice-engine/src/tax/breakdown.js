// The tax breakdown of a result (SPEC rules 14 to 16, 34 and 35).
import { ZERO } from '../num/rational.js';
import { splitClass } from './compute.js';

function compareEntries(a, b) {
  const byRate = b.tax.rate.cmp(a.tax.rate);
  if (byRate !== 0) return byRate;
  return a.tax.name < b.tax.name ? -1 : a.tax.name > b.tax.name ? 1 : 0;
}

/** Groups lines by class. Returns { entries: [{ tax, net, taxAmount }], exemptNet }. */
export function buildBreakdown(lines, inv) {
  const groups = new Map();
  let exemptLines = [];
  for (const l of lines) {
    if (l.tax.exempt) {
      exemptLines.push(l);
      continue;
    }
    if (!groups.has(l.tax.name)) groups.set(l.tax.name, { tax: l.tax, lines: [] });
    groups.get(l.tax.name).lines.push(l);
  }
  const entries = [];
  for (const g of groups.values()) {
    if (inv.rounding === 'line') {
      entries.push({ tax: g.tax, net: g.lines.reduce((s, l) => s.add(l.net), ZERO), taxAmount: g.lines.reduce((s, l) => s.add(l.taxAmount), ZERO) });
    } else {
      const sum = g.lines.reduce((s, l) => s.add(l.amount).sub(l.allocated), ZERO);
      const { net, tax } = splitClass(sum, g.tax, inv);
      entries.push({ tax: g.tax, net, taxAmount: tax });
    }
  }
  entries.sort(compareEntries);
  let exemptNet;
  if (inv.rounding === 'line') exemptNet = exemptLines.reduce((s, l) => s.add(l.net), ZERO);
  else exemptNet = splitClass(exemptLines.reduce((s, l) => s.add(l.amount).sub(l.allocated), ZERO), exemptLines[0]?.tax ?? { rate: null }, inv).net;
  return { entries, exemptNet };
}
