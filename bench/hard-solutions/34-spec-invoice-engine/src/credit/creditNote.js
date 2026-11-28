// createCreditNote: full and partial credit notes (SPEC rules 39 to 42).
import { calculate } from '../engine/calculate.js';
import { toResult } from '../engine/output.js';
import { dayNumber } from '../dates/calendar.js';
import { fail } from '../errors.js';
import { readInvoice, readQuantity } from '../model/validate.js';
import { negateResult } from './negate.js';

function creditedLines(inv, wanted) {
  if (!Array.isArray(wanted) || wanted.length === 0) fail('INVALID_CREDIT', 'lines must be a non-empty array');
  const byId = new Map(inv.lines.map((l) => [l.id, l]));
  const picked = new Map();
  wanted.forEach((w, i) => {
    if (w === null || typeof w !== 'object') fail('INVALID_CREDIT', `lines[${i}] must be an object`);
    const line = byId.get(w.id);
    if (!line) fail('UNKNOWN_LINE', `lines[${i}]: the invoice has no line ${JSON.stringify(w.id)}`);
    if (picked.has(w.id)) fail('DUPLICATE_LINE_ID', `lines[${i}]: line ${w.id} is listed twice`);
    const quantityText = w.quantity ?? line.quantityText;
    const quantity = w.quantity === undefined ? line.quantity : readQuantity(w.quantity, `lines[${i}].quantity`);
    if (quantity.gt(line.quantity)) fail('CREDIT_EXCEEDS', `lines[${i}]: credits more than the invoiced quantity`);
    if (line.tiers && !quantity.isInteger()) fail('FRACTIONAL_TIERED_QUANTITY', `lines[${i}]: a tiered line is credited in whole units`);
    picked.set(w.id, { quantity, quantityText });
  });
  return inv.lines
    .filter((l) => picked.has(l.id))
    .map((l) => {
      const { quantity, quantityText } = picked.get(l.id);
      return { ...l, quantity, quantityText, tierQuantity: l.quantity, amountDiscountScale: quantity.div(l.quantity) };
    });
}

export function createCreditNote(doc, options = {}) {
  const inv = readInvoice(doc);
  const issueDate = options.issueDate ?? inv.issueDate;
  dayNumber(issueDate, 'issueDate');
  const meta = { kind: 'credit-note', number: options.number ?? `CN-${inv.number}`, creditFor: inv.number, issueDate };
  if (options.lines === undefined) return negateResult(toResult(calculate(inv), meta));
  const partial = { ...inv, lines: creditedLines(inv, options.lines) };
  return negateResult(toResult(calculate(partial, { documentAmountDiscounts: false, minimumCharge: false }), meta));
}
