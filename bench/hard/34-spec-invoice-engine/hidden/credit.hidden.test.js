import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateInvoice, createCreditNote } from '../src/index.js';
import { codeOf, invoice, line, pick } from './helpers.js';

const tiers = [
  { from: '1', unitPrice: '5.00' },
  { from: '10', unitPrice: '4.00' },
  { from: '20', unitPrice: '3.00' },
];

function negate(s) {
  if (s === null) return null;
  if (/^[0.]+$/.test(s)) return s;
  return s.startsWith('-') ? s.slice(1) : `-${s}`;
}

const busy = () =>
  invoice({
    taxRates: { standard: '20', reduced: '7' },
    discounts: [{ type: 'amount', value: '3.00', code: 'WELCOME' }, { type: 'percent', value: '12.5' }],
    minimumCharge: { amount: '200.00', taxClass: 'reduced' },
    lines: [
      line('A', '3', '19.99', 'standard', { description: 'Seats', discounts: [{ type: 'amount', value: '2.00' }] }),
      { id: 'T', quantity: '25', tiers, tierMode: 'graduated', taxClass: 'reduced' },
      line('Z', '1', '0.00', 'zero'),
      line('N', '1', '-4.995', 'standard'),
    ],
  });

test('R39: a full credit note is the exact negation of the invoice', () => {
  const doc = busy();
  const inv = calculateInvoice(doc);
  const cn = createCreditNote(doc, { issueDate: '2026-04-02' });
  assert.equal(cn.kind, 'credit-note');
  assert.equal(cn.number, 'CN-INV-100');
  assert.equal(cn.creditFor, 'INV-100');
  assert.equal(cn.issueDate, '2026-04-02');
  assert.equal(cn.currency, inv.currency);
  assert.deepEqual(pick(cn, 'id'), ['A', 'T', 'Z', 'N', 'MINIMUM']);
  for (const k of ['amount', 'allocatedDiscount', 'net', 'tax', 'gross']) assert.deepEqual(pick(cn, k), pick(inv, k).map(negate), k);
  for (const k of ['quantity', 'unitPrice', 'taxClass', 'description']) assert.deepEqual(pick(cn, k), pick(inv, k), k);
  assert.deepEqual(cn.discounts, inv.discounts.map((d) => ({ ...d, amount: negate(d.amount) })));
  assert.deepEqual(cn.taxes, inv.taxes.map((t) => ({ ...t, net: negate(t.net), tax: negate(t.tax) })));
  assert.deepEqual(cn.totals, Object.fromEntries(Object.entries(inv.totals).map(([k, v]) => [k, negate(v)])));
});

test('R32 R33 R39: the invoice values behind the full credit note', () => {
  const inv = calculateInvoice(busy());
  assert.deepEqual(pick(inv, 'amount'), ['57.97', '103.00', '0.00', '-5.00', '67.15']);
  assert.deepEqual(pick(inv, 'allocatedDiscount'), ['8.33', '14.79', '0.00', '0.00', '0.00']);
  assert.deepEqual(inv.discounts.map((d) => d.amount), ['20.12', '3.00']);
  assert.equal(inv.lines[4].unitPrice, '67.15');
  assert.deepEqual(inv.taxes.map((t) => [t.taxClass, t.net, t.tax]), [['standard', '44.64', '8.93'], ['reduced', '155.36', '10.87'], ['zero', '0.00', '0.00']]);
  assert.deepEqual(inv.totals, { discount: '23.12', net: '200.00', tax: '19.80', gross: '219.80', roundingAdjustment: '0.00', payable: '219.80' });
});

test('R39: the credit note number and defaults', () => {
  const doc = invoice({ lines: [line('A', '1', '1.00')] });
  assert.equal(createCreditNote(doc, { number: 'GS-7' }).number, 'GS-7');
  assert.equal(createCreditNote(doc).issueDate, '2026-03-01');
  assert.equal(codeOf(() => createCreditNote(doc, { issueDate: '2026-02-31' })), 'INVALID_DATE');
});

test('R39 R36: a full credit note in document rounding mode keeps the nulls', () => {
  const doc = invoice({ rounding: 'document', cashRounding: true, currency: 'CHF', discounts: [{ type: 'percent', value: '3' }], lines: [line('A', '1', '10.333'), line('B', '1', '7.777', 'reduced')] });
  const inv = calculateInvoice(doc);
  const cn = createCreditNote(doc);
  assert.deepEqual(pick(cn, 'net'), [null, null]);
  assert.deepEqual(pick(cn, 'amount'), ['-10.33', '-7.78']);
  assert.deepEqual(pick(cn, 'allocatedDiscount'), ['-0.31', '-0.23']);
  assert.deepEqual(inv.totals, { discount: '0.54', net: '17.56', tax: '2.75', gross: '20.31', roundingAdjustment: '-0.01', payable: '20.30' });
  assert.deepEqual(cn.totals, { discount: '-0.54', net: '-17.56', tax: '-2.75', gross: '-20.31', roundingAdjustment: '0.01', payable: '-20.30' });
});

test('R40: selection errors', () => {
  const doc = busy();
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [] })), 'INVALID_CREDIT');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'X' }] })), 'UNKNOWN_LINE');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'MINIMUM' }] })), 'UNKNOWN_LINE');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'A' }, { id: 'A', quantity: '1' }] })), 'DUPLICATE_LINE_ID');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'A', quantity: '4' }] })), 'CREDIT_EXCEEDS');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'A', quantity: '0' }] })), 'INVALID_NUMBER');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'A', quantity: 1 }] })), 'INVALID_NUMBER');
  assert.equal(codeOf(() => createCreditNote(doc, { lines: [{ id: 'T', quantity: '1.5' }] })), 'FRACTIONAL_TIERED_QUANTITY');
  assert.equal(createCreditNote(doc, { lines: [{ id: 'A', quantity: '2.5' }] }).lines[0].quantity, '2.5');
});

test('R40 R41: credited lines keep invoice order; listing everything is still partial', () => {
  const doc = busy();
  const cn = createCreditNote(doc, { lines: [{ id: 'N' }, { id: 'Z' }, { id: 'T' }, { id: 'A' }] });
  assert.deepEqual(pick(cn, 'id'), ['A', 'T', 'Z', 'N']);
  assert.deepEqual(cn.discounts, [{ code: null, type: 'percent', value: '12.5', amount: '-20.12' }]);
  assert.deepEqual(pick(cn, 'quantity'), ['3', '25', '1', '1']);
  assert.deepEqual(pick(cn, 'allocatedDiscount'), ['-7.25', '-12.87', '0.00', '0.00']);
  assert.equal(cn.totals.discount, '-20.12');
  assert.equal(cn.totals.net, '-135.85');
});

test('R41: fixed line discounts are scaled by the credited share', () => {
  const doc = invoice({ lines: [line('A', '4', '25.00', 'standard', { discounts: [{ type: 'amount', value: '20.00' }, { type: 'percent', value: '10' }] })] });
  const cn = createCreditNote(doc, { lines: [{ id: 'A', quantity: '1' }] });
  assert.equal(cn.lines[0].amount, '-17.50');
  assert.equal(cn.lines[0].tax, '-3.50');
  const third = createCreditNote(invoice({ lines: [line('A', '3', '10.00', 'standard', { discounts: [{ type: 'amount', value: '1.00' }] })] }), { lines: [{ id: 'A', quantity: '1' }] });
  assert.equal(third.lines[0].amount, '-9.67');
});

test('R41: no fixed document discounts and no minimum charge on a partial credit', () => {
  const doc = invoice({ discounts: [{ type: 'amount', value: '10.00', code: 'TEN' }, { type: 'percent', value: '10', code: 'P' }], minimumCharge: { amount: '500.00' }, lines: [line('A', '1', '100.00'), line('B', '1', '50.00')] });
  const cn = createCreditNote(doc, { lines: [{ id: 'B' }] });
  assert.deepEqual(pick(cn, 'id'), ['B']);
  assert.deepEqual(cn.discounts.map((d) => [d.code, d.amount]), [['P', '-5.00']]);
  assert.deepEqual(cn.totals, { discount: '-5.00', net: '-45.00', tax: '-9.00', gross: '-54.00', roundingAdjustment: '0.00', payable: '-54.00' });
});

test('R41 R38: cash rounding of a partial credit note uses its own gross', () => {
  const doc = invoice({ currency: 'CHF', cashRounding: true, taxRates: { standard: '8.1' }, lines: [line('A', '1', '10.00'), line('B', '1', '20.00')] });
  const inv = calculateInvoice(doc);
  assert.deepEqual([inv.totals.gross, inv.totals.payable], ['32.43', '32.45']);
  const cn = createCreditNote(doc, { lines: [{ id: 'A' }] });
  assert.deepEqual(cn.totals, { discount: '0.00', net: '-10.00', tax: '-0.81', gross: '-10.81', roundingAdjustment: '0.01', payable: '-10.80' });
});

test('R42: credited volume lines keep the invoice tier', () => {
  const doc = invoice({ lines: [{ id: 'V', quantity: '25', tiers, taxClass: 'standard' }] });
  const cn = createCreditNote(doc, { lines: [{ id: 'V', quantity: '5' }] });
  assert.equal(cn.lines[0].unitPrice, '3.00');
  assert.equal(cn.lines[0].amount, '-15.00');
});

test('R42: credited graduated lines are the last units', () => {
  const doc = invoice({ lines: [{ id: 'G', quantity: '25', tiers, tierMode: 'graduated', taxClass: 'standard' }] });
  const ten = createCreditNote(doc, { lines: [{ id: 'G', quantity: '10' }] });
  assert.equal(ten.lines[0].amount, '-34.00');
  assert.equal(ten.lines[0].unitPrice, null);
  assert.equal(createCreditNote(doc, { lines: [{ id: 'G', quantity: '20' }] }).lines[0].amount, '-78.00');
  assert.equal(createCreditNote(doc, { lines: [{ id: 'G' }] }).lines[0].amount, '-103.00');
});

test('R21 R41 R42: a prorated graduated line credited in part', () => {
  const doc = invoice({
    billingPeriod: { start: '2026-04-01', end: '2026-04-30' },
    discounts: [{ type: 'percent', value: '10' }],
    lines: [{ id: 'G', quantity: '12', tiers, tierMode: 'graduated', taxClass: 'standard', period: { start: '2026-04-11', end: '2026-04-30' }, discounts: [{ type: 'amount', value: '6.00' }] }],
  });
  const inv = calculateInvoice(doc);
  assert.equal(inv.lines[0].amount, '32.00');
  const cn = createCreditNote(doc, { lines: [{ id: 'G', quantity: '4' }] });
  assert.equal(cn.lines[0].amount, '-9.33');
  assert.equal(cn.lines[0].allocatedDiscount, '-0.93');
  assert.equal(cn.totals.gross, '-10.08');
});
