// A plain-text rendering of a result, for the command line. It only formats what the engine
// computed; it never calculates.
import { columns, padLeft, padRight } from './columns.js';
import { label } from './labels.js';

function lineRows(result) {
  return result.lines.map((l) => [l.id, l.description, l.quantity, l.unitPrice ?? '(tiers)', l.amount, l.allocatedDiscount, l.taxClass]);
}

export function renderText(result, lang = 'en') {
  const out = [];
  const title = result.kind === 'invoice' ? label('invoice', lang) : label('creditNote', lang);
  out.push(`${title} ${result.number}  ${result.issueDate}  ${result.currency}`);
  if (result.creditFor) out.push(`${label('creditFor', lang)} ${result.creditFor}`);
  out.push(`${label('prices', lang)}: ${label(result.priceMode, lang)}, ${label('rounding', lang)}: ${label(result.rounding, lang)}`);
  out.push('');
  const head = ['id', 'description', 'qty', 'unit', 'amount', 'discount', 'class'].map((k) => label(k, lang));
  out.push(...columns([head, ...lineRows(result)], [padRight, padRight, padLeft, padLeft, padLeft, padLeft, padRight]));
  if (result.discounts.length > 0) {
    out.push('');
    for (const d of result.discounts) out.push(`${label('discount', lang)} ${d.code ?? ''} ${d.type === 'percent' ? `${d.value}%` : d.value}: ${d.amount}`.replace('  ', ' '));
  }
  out.push('');
  for (const t of result.taxes) out.push(`${label('tax', lang)} ${t.taxClass} ${t.rate}%: ${label('net', lang)} ${t.net}, ${label('tax', lang)} ${t.tax}`);
  out.push('');
  const tot = result.totals;
  const rows = [
    [label('net', lang), tot.net],
    [label('tax', lang), tot.tax],
    [label('gross', lang), tot.gross],
  ];
  if (tot.payable !== tot.gross) rows.push([label('cashRounding', lang), tot.roundingAdjustment]);
  rows.push([label('payable', lang), tot.payable]);
  out.push(...columns(rows, [padRight, padLeft]));
  return `${out.join('\n')}\n`;
}
