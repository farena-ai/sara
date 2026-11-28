import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateInvoice, createCreditNote } from '../src/index.js';
import { codeOf, invoice, line, pick } from './helpers.js';

test('R1: numeric inputs must be plain decimal strings', () => {
  for (const q of [3, '', '1e3', '+1', '.5', '5.', ' 1', '1,5']) {
    assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', q, '1.00')] }))), 'INVALID_NUMBER', `quantity ${JSON.stringify(q)}`);
  }
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', 19.99)] }))), 'INVALID_NUMBER');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00')], discounts: [{ type: 'percent', value: 10 }] }))), 'INVALID_NUMBER');
  assert.equal(codeOf(() => calculateInvoice(invoice({ taxRates: { standard: 20 }, lines: [line('A', '1', '1.00')] }))), 'INVALID_NUMBER');
});

test('R2 R26: proration shares stay exact in document rounding mode', () => {
  const r = calculateInvoice(
    invoice({
      rounding: 'document',
      billingPeriod: { start: '2026-03-01', end: '2026-03-03' },
      lines: ['01', '02', '03'].map((d) => line(`D${d}`, '1', '1.00', 'standard', { period: { start: `2026-03-${d}`, end: `2026-03-${d}` } })),
    }),
  );
  assert.deepEqual(pick(r, 'amount'), ['0.33', '0.33', '0.33']);
  assert.equal(r.totals.net, '1.00');
  assert.equal(r.totals.tax, '0.20');
});

test('R2: a long proration factor is not truncated', () => {
  const r = calculateInvoice(
    invoice({
      currency: 'KWD',
      billingPeriod: { start: '2026-01-01', end: '2026-12-31' },
      lines: [line('Y', '1', '3650000', 'standard', { period: { start: '2026-01-01', end: '2026-01-01' } })],
    }),
  );
  assert.equal(r.lines[0].amount, '10000.000');
});

test('R3 R4: minor units per currency', () => {
  const jpy = calculateInvoice(invoice({ currency: 'JPY', lines: [line('A', '3', '333.5')] }));
  assert.equal(jpy.lines[0].amount, '1001');
  assert.equal(jpy.lines[0].tax, '200');
  assert.equal(jpy.totals.gross, '1201');
  const kwd = calculateInvoice(invoice({ currency: 'KWD', lines: [line('A', '1', '1.2345')] }));
  assert.equal(kwd.lines[0].amount, '1.235');
  assert.equal(kwd.lines[0].tax, '0.247');
  assert.equal(kwd.totals.payable, '1.482');
  const bhd = calculateInvoice(invoice({ currency: 'BHD', lines: [line('A', '2', '0.5')] }));
  assert.equal(bhd.totals.net, '1.000');
});

test('R3: unknown currencies are rejected', () => {
  for (const c of ['XYZ', 'eur', '', 'EURO']) assert.equal(codeOf(() => calculateInvoice(invoice({ currency: c }))), 'UNKNOWN_CURRENCY', c);
});

test('R4: zero has no sign and negatives have a leading minus', () => {
  const r = calculateInvoice(invoice({ lines: [line('A', '1', '-2.345'), line('Z', '1', '5.00', 'zero')] }));
  assert.equal(r.lines[0].amount, '-2.35');
  assert.equal(r.lines[1].tax, '0.00');
  const cn = createCreditNote(invoice({ lines: [line('Z', '1', '5.00', 'zero')] }));
  assert.equal(cn.lines[0].tax, '0.00');
  assert.equal(cn.totals.tax, '0.00');
  assert.equal(cn.totals.discount, '0.00');
  assert.equal(cn.totals.roundingAdjustment, '0.00');
  assert.equal(cn.taxes[0].tax, '0.00');
  assert.equal(cn.totals.net, '-5.00');
});

test('R5: halfway values round away from zero', () => {
  const r = calculateInvoice(invoice({ lines: [line('A', '1', '2.345'), line('B', '1', '-2.345'), line('C', '1', '0.625')] }));
  assert.deepEqual(pick(r, 'amount'), ['2.35', '-2.35', '0.63']);
  assert.equal(r.lines[0].tax, '0.47');
  assert.equal(r.lines[1].tax, '-0.47');
  const t = calculateInvoice(invoice({ lines: [line('A', '1', '2.25', 'reduced'), line('B', '1', '-2.25', 'reduced')] }));
  assert.deepEqual(pick(t, 'tax'), ['0.23', '-0.23']);
});

test('R6: half-even applies to tax amounts only', () => {
  const doc = (extra) => invoice({ taxRounding: 'half-even', ...extra });
  const a = calculateInvoice(doc({ lines: [line('A', '1', '1.25', 'reduced'), line('B', '1', '1.125', 'exempt'), line('C', '1', '1.35', 'reduced'), line('D', '1', '0.625')] }));
  assert.deepEqual(pick(a, 'amount'), ['1.25', '1.13', '1.35', '0.63']);
  assert.deepEqual(pick(a, 'tax'), ['0.12', '0.00', '0.14', '0.13']);
  assert.equal(a.taxes.find((t) => t.taxClass === 'reduced').tax, '0.26');
  const b = calculateInvoice(doc({ rounding: 'document', lines: [line('A', '1', '0.625')] }));
  assert.equal(b.taxes[0].tax, '0.12');
  assert.equal(b.taxes[0].net, '0.63');
  const c = calculateInvoice(doc({ priceMode: 'inclusive', lines: [line('A', '1', '1.35')] }));
  assert.equal(c.lines[0].tax, '0.22');
  assert.equal(c.lines[0].net, '1.13');
});

test('R6 R25: half-even on a negative tax', () => {
  const up = calculateInvoice(invoice({ rounding: 'document', lines: [line('N', '1', '-0.625')] }));
  assert.equal(up.taxes[0].tax, '-0.13');
  const even = calculateInvoice(invoice({ rounding: 'document', taxRounding: 'half-even', lines: [line('N', '1', '-0.625')] }));
  assert.equal(even.taxes[0].tax, '-0.12');
  assert.equal(even.totals.gross, '-0.75');
});

test('R7: input limits', () => {
  const bad = [
    { lines: [line('A', '0', '1.00')] },
    { lines: [line('A', '1.2345', '1.00')] },
    { lines: [line('A', '-1', '1.00')] },
    { lines: [line('A', '1', '1.1234567')] },
    { lines: [line('A', '1', '1.00', 'standard', { discounts: [{ type: 'percent', value: '100.5' }] })] },
    { lines: [line('A', '1', '1.00', 'standard', { discounts: [{ type: 'percent', value: '12.34567' }] })] },
    { lines: [line('A', '1', '1.00', 'standard', { discounts: [{ type: 'amount', value: '0.505' }] })] },
    { lines: [line('A', '1', '1.00', 'standard', { discounts: [{ type: 'amount', value: '-1.00' }] })] },
    { lines: [line('A', '1', '1.00')], minimumCharge: { amount: '10.001' } },
    { currency: 'JPY', lines: [line('A', '1', '100')], minimumCharge: { amount: '100.0' } },
    { lines: [{ id: 'T', quantity: '1', taxClass: 'standard', tiers: [{ from: '1', unitPrice: '-1.00' }] }] },
    { lines: [{ id: 'T', quantity: '1', taxClass: 'standard', tiers: [{ from: '1.5', unitPrice: '1.00' }] }] },
    { lines: [{ id: 'T', quantity: '1', taxClass: 'standard', tiers: [{ from: '0', unitPrice: '1.00' }] }] },
    { lines: [line('A', '1', '1.00')], taxRates: { standard: '101' } },
  ];
  for (const over of bad) assert.equal(codeOf(() => calculateInvoice(invoice(over))), 'INVALID_NUMBER', JSON.stringify(over));
  const ok = calculateInvoice(invoice({ lines: [line('A', '1.125', '0.000001', 'standard', { discounts: [{ type: 'amount', value: '0.5' }, { type: 'percent', value: '12.3456' }] })] }));
  assert.equal(ok.lines[0].amount, '0.00');
  assert.equal(calculateInvoice(invoice({ lines: [line('A', '1', '1.00')], taxRates: { standard: '100' } })).lines[0].tax, '1.00');
});

test('R8: required fields, settings and defaults', () => {
  assert.equal(codeOf(() => calculateInvoice({ issueDate: '2026-03-01', currency: 'EUR', lines: [] })), 'INVALID_INVOICE');
  assert.equal(codeOf(() => calculateInvoice(invoice({ number: '' }))), 'INVALID_INVOICE');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: undefined }))), 'INVALID_INVOICE');
  assert.equal(codeOf(() => calculateInvoice({ number: 'X', currency: 'EUR', lines: [] })), 'INVALID_INVOICE');
  assert.equal(codeOf(() => calculateInvoice({ number: 'X', issueDate: '2026-03-01', lines: [] })), 'INVALID_INVOICE');
  assert.equal(codeOf(() => calculateInvoice(invoice({ priceMode: 'gross' }))), 'INVALID_SETTING');
  assert.equal(codeOf(() => calculateInvoice(invoice({ rounding: 'none' }))), 'INVALID_SETTING');
  assert.equal(codeOf(() => calculateInvoice(invoice({ taxRounding: 'bankers' }))), 'INVALID_SETTING');
  assert.equal(codeOf(() => calculateInvoice(invoice({ cashRounding: 'yes' }))), 'INVALID_SETTING');
  for (const d of ['2026-02-30', '2026-13-01', '2026-3-01', '01.03.2026', '2025-02-29']) assert.equal(codeOf(() => calculateInvoice(invoice({ issueDate: d }))), 'INVALID_DATE', d);
  assert.equal(codeOf(() => calculateInvoice(invoice({ billingPeriod: { start: '2026-04-31', end: '2026-05-01' } }))), 'INVALID_DATE');
  const r = calculateInvoice(invoice({ issueDate: '2028-02-29' }));
  assert.equal(r.priceMode, 'exclusive');
  assert.equal(r.rounding, 'line');
  assert.equal(r.kind, 'invoice');
  assert.equal(r.creditFor, null);
  assert.equal(r.issueDate, '2028-02-29');
  assert.deepEqual(r.totals, { discount: '0.00', net: '0.00', tax: '0.00', gross: '0.00', roundingAdjustment: '0.00', payable: '0.00' });
});

test('R9: line fields and ids', () => {
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00'), line('A', '2', '1.00')] }))), 'DUPLICATE_LINE_ID');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('MINIMUM', '1', '1.00')] }))), 'INVALID_LINE');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('', '1', '1.00')] }))), 'INVALID_LINE');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [{ id: 'A', quantity: '1', taxClass: 'standard' }] }))), 'INVALID_LINE');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'standard', { tiers: [{ from: '1', unitPrice: '1.00' }] })] }))), 'INVALID_LINE');
  const r = calculateInvoice(invoice({ lines: [line('A', '1', '1.00')] }));
  assert.equal(r.lines[0].description, '');
  assert.deepEqual(Object.keys(r.lines[0]).sort(), ['allocatedDiscount', 'amount', 'description', 'gross', 'id', 'net', 'quantity', 'tax', 'taxClass', 'unitPrice']);
});
