import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateInvoice } from '../src/index.js';
import { codeOf, invoice, line, pick } from './helpers.js';

const APRIL = { start: '2026-04-01', end: '2026-04-30' };
const tiers = [
  { from: '20', unitPrice: '3.00' },
  { from: '1', unitPrice: '5.00' },
  { from: '10', unitPrice: '4.00' },
];

test('R10 R21 R23 R24: proration, then percentages, then fixed amounts', () => {
  const r = calculateInvoice(
    invoice({
      billingPeriod: APRIL,
      lines: [line('A', '2', '50.00', 'standard', { period: { start: '2026-04-16', end: '2026-04-30' }, discounts: [{ type: 'amount', value: '5.00' }, { type: 'percent', value: '10' }] })],
    }),
  );
  assert.equal(r.lines[0].amount, '40.00');
  assert.equal(r.lines[0].tax, '8.00');
});

test('R11: tax classes and rates', () => {
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'luxury')] }))), 'UNKNOWN_TAX_CLASS');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'Standard')] }))), 'UNKNOWN_TAX_CLASS');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'super-reduced')] }))), 'UNKNOWN_TAX_CLASS');
  assert.equal(codeOf(() => calculateInvoice(invoice({ taxRates: {}, lines: [line('A', '1', '1.00')] }))), 'UNKNOWN_TAX_CLASS');
  const r = calculateInvoice(invoice({ taxRates: { standard: '20', zero: '15', exempt: '7', reduced: 'abc', 'super-reduced': 3 }, lines: [line('Z', '1', '10.00', 'zero'), line('E', '1', '10.00', 'exempt'), line('S', '1', '10.00')] }));
  assert.deepEqual(pick(r, 'tax'), ['0.00', '0.00', '2.00']);
});

test('R11 R32: the minimum charge class is validated even without a top-up', () => {
  const doc = invoice({ taxRates: { standard: '20' }, lines: [line('A', '1', '100.00')], minimumCharge: { amount: '10.00', taxClass: 'reduced' } });
  assert.equal(codeOf(() => calculateInvoice(doc)), 'UNKNOWN_TAX_CLASS');
  assert.equal(codeOf(() => calculateInvoice({ ...doc, minimumCharge: { amount: '10.00', taxClass: 'other' } })), 'UNKNOWN_TAX_CLASS');
  assert.equal(calculateInvoice({ ...doc, minimumCharge: { amount: '10.00' } }).lines.length, 1);
});

test('R12: exclusive prices', () => {
  const r = calculateInvoice(invoice({ lines: [line('A', '3', '19.99'), line('B', '1', '7.25', 'reduced')] }));
  assert.deepEqual(pick(r, 'net'), ['59.97', '7.25']);
  assert.deepEqual(pick(r, 'tax'), ['11.99', '0.73']);
  assert.deepEqual(pick(r, 'gross'), ['71.96', '7.98']);
});

test('R13: inclusive prices, net is gross minus the rounded tax', () => {
  const r = calculateInvoice(invoice({ priceMode: 'inclusive', taxRates: { standard: '20', reduced: '5.5' }, lines: [line('A', '1', '10.00'), line('B', '1', '9.99', 'reduced'), line('C', '1', '4.00', 'zero')] }));
  assert.deepEqual(pick(r, 'gross'), ['10.00', '9.99', '4.00']);
  assert.deepEqual(pick(r, 'tax'), ['1.67', '0.52', '0.00']);
  assert.deepEqual(pick(r, 'net'), ['8.33', '9.47', '4.00']);
  assert.equal(r.totals.gross, '23.99');
  assert.equal(r.totals.net, '21.80');
});

test('R14 R37: zero-rated lines are in the breakdown, exempt lines only in the totals', () => {
  const r = calculateInvoice(invoice({ lines: [line('Z', '1', '4.00', 'zero'), line('E', '2', '3.50', 'exempt'), line('S', '1', '10.00')] }));
  assert.deepEqual(r.taxes, [
    { taxClass: 'standard', rate: '20', net: '10.00', tax: '2.00' },
    { taxClass: 'zero', rate: '0', net: '4.00', tax: '0.00' },
  ]);
  assert.equal(r.lines[1].net, '7.00');
  assert.equal(r.lines[1].gross, '7.00');
  assert.deepEqual(r.totals, { discount: '0.00', net: '21.00', tax: '2.00', gross: '23.00', roundingAdjustment: '0.00', payable: '23.00' });
});

test('R15: breakdown order by rate, then class name; zero-amount lines count', () => {
  const r = calculateInvoice(
    invoice({
      taxRates: { standard: '7', reduced: '10', 'super-reduced': '10.0' },
      lines: [
        line('Z', '1', '1.00', 'zero'),
        line('S', '1', '1.00', 'super-reduced'),
        line('T', '1', '1.00'),
        line('R', '1', '1.00', 'reduced', { discounts: [{ type: 'percent', value: '100' }] }),
      ],
    }),
  );
  assert.deepEqual(r.taxes.map((t) => [t.taxClass, t.rate, t.net]), [
    ['reduced', '10', '0.00'],
    ['super-reduced', '10', '1.00'],
    ['standard', '7', '1.00'],
    ['zero', '0', '1.00'],
  ]);
});

test('R16: rates are written without trailing zeros', () => {
  const rates = [['20.00', '20'], ['5.50', '5.5'], ['07', '7'], ['07.250', '7.25'], ['0.0', '0'], ['100', '100']];
  for (const [given, shown] of rates) {
    const r = calculateInvoice(invoice({ taxRates: { standard: given }, lines: [line('A', '1', '1.00')] }));
    assert.equal(r.taxes[0].rate, shown, given);
  }
});

test('R17: volume tiers price every unit at the reached tier', () => {
  const at = (q) => calculateInvoice(invoice({ lines: [{ id: 'T', quantity: q, tiers, taxClass: 'standard' }] })).lines[0];
  assert.deepEqual([at('9').amount, at('9').unitPrice], ['45.00', '5.00']);
  assert.deepEqual([at('10').amount, at('10').unitPrice], ['40.00', '4.00']);
  assert.deepEqual([at('25').amount, at('25').unitPrice], ['75.00', '3.00']);
});

test('R18: graduated tiers price units one by one', () => {
  const at = (q) => calculateInvoice(invoice({ lines: [{ id: 'G', quantity: q, tiers, tierMode: 'graduated', taxClass: 'standard' }] })).lines[0];
  assert.equal(at('9').amount, '45.00');
  assert.equal(at('10').amount, '49.00');
  assert.equal(at('25').amount, '103.00');
  assert.equal(at('25').unitPrice, null);
});

test('R19: tier rules', () => {
  const doc = (t, q = '5', mode = 'volume') => invoice({ lines: [{ id: 'T', quantity: q, tiers: t, tierMode: mode, taxClass: 'standard' }] });
  assert.equal(codeOf(() => calculateInvoice(doc([{ from: '2', unitPrice: '1.00' }]))), 'INVALID_TIERS');
  assert.equal(codeOf(() => calculateInvoice(doc([{ from: '1', unitPrice: '1.00' }, { from: '01', unitPrice: '2.00' }]))), 'INVALID_TIERS');
  assert.equal(codeOf(() => calculateInvoice(doc([]))), 'INVALID_TIERS');
  assert.equal(codeOf(() => calculateInvoice(doc(tiers, '2.5'))), 'FRACTIONAL_TIERED_QUANTITY');
  assert.equal(codeOf(() => calculateInvoice(doc(tiers, '2.5', 'graduated'))), 'FRACTIONAL_TIERED_QUANTITY');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [{ id: 'T', quantity: '1', tiers, tierMode: 'stepped', taxClass: 'standard' }] }))), 'INVALID_SETTING');
  assert.equal(calculateInvoice(doc(tiers, '10.000')).lines[0].amount, '40.00');
});

test('R19 R21: tiers are selected on the full quantity, then prorated', () => {
  const r = calculateInvoice(invoice({ billingPeriod: APRIL, lines: [{ id: 'T', quantity: '10', tiers, taxClass: 'standard', period: { start: '2026-04-01', end: '2026-04-15' } }] }));
  assert.equal(r.lines[0].unitPrice, '4.00');
  assert.equal(r.lines[0].amount, '20.00');
});

test('R20: quantity times unit price is exact before rounding', () => {
  const r = calculateInvoice(invoice({ lines: [line('A', '2.5', '3.333333'), line('B', '0.001', '4.999999'), line('C', '3', '0.335')] }));
  assert.deepEqual(pick(r, 'amount'), ['8.33', '0.00', '1.01']);
});

test('R21: days counted with both ends, leap February', () => {
  const march = calculateInvoice(invoice({ billingPeriod: { start: '2026-03-01', end: '2026-03-31' }, lines: [line('A', '1', '31.00', 'standard', { period: { start: '2026-03-10', end: '2026-03-31' } })] }));
  assert.equal(march.lines[0].amount, '22.00');
  const feb = calculateInvoice(invoice({ billingPeriod: { start: '2028-02-01', end: '2028-02-29' }, lines: [line('A', '1', '29.00', 'standard', { period: { start: '2028-02-15', end: '2028-02-29' } })] }));
  assert.equal(feb.lines[0].amount, '15.00');
  const one = calculateInvoice(invoice({ billingPeriod: { start: '2026-12-31', end: '2027-01-01' }, lines: [line('A', '1', '10.00', 'standard', { period: { start: '2027-01-01', end: '2027-01-01' } })] }));
  assert.equal(one.lines[0].amount, '5.00');
});

test('R22: period rules', () => {
  const p = (period, billingPeriod = APRIL) => invoice({ billingPeriod, lines: [line('A', '1', '1.00', 'standard', { period })] });
  assert.equal(codeOf(() => calculateInvoice(p({ start: '2026-04-10', end: '2026-04-09' }))), 'INVALID_PERIOD');
  assert.equal(codeOf(() => calculateInvoice(p({ start: '2026-04-10', end: '2026-04-12' }, { start: '2026-04-30', end: '2026-04-01' }))), 'INVALID_PERIOD');
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'standard', { period: { start: '2026-04-10', end: '2026-04-12' } })] }))), 'INVALID_PERIOD');
  assert.equal(codeOf(() => calculateInvoice(p({ start: '2026-03-31', end: '2026-04-12' }))), 'PERIOD_OUTSIDE');
  assert.equal(codeOf(() => calculateInvoice(p({ start: '2026-04-20', end: '2026-05-01' }))), 'PERIOD_OUTSIDE');
  assert.equal(calculateInvoice(invoice({ billingPeriod: APRIL, lines: [line('A', '1', '9.99')] })).lines[0].amount, '9.99');
  assert.equal(calculateInvoice(p(APRIL)).lines[0].amount, '1.00');
});

test('R23: percentages compound in order, then fixed amounts', () => {
  const r = calculateInvoice(
    invoice({
      lines: [
        line('A', '1', '100.00', 'standard', { discounts: [{ type: 'percent', value: '10' }, { type: 'percent', value: '5' }] }),
        line('B', '1', '100.00', 'standard', { discounts: [{ type: 'amount', value: '10.00' }, { type: 'percent', value: '10' }] }),
        line('C', '1', '0.10', 'standard', { discounts: [{ type: 'percent', value: '33.3333' }, { type: 'percent', value: '50' }] }),
      ],
    }),
  );
  assert.deepEqual(pick(r, 'amount'), ['85.50', '80.00', '0.03']);
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'standard', { discounts: [{ type: 'fixed', value: '1.00' }] })] }))), 'INVALID_DISCOUNT');
});

test('R24: fixed line discounts are per line, not prorated, and stop at zero', () => {
  const r = calculateInvoice(
    invoice({
      discounts: [{ type: 'amount', value: '100.00' }],
      lines: [line('A', '3', '10.00', 'standard', { discounts: [{ type: 'amount', value: '5.00' }] }), line('B', '1', '30.00', 'standard', { discounts: [{ type: 'amount', value: '20.00' }, { type: 'amount', value: '25.00' }] })],
    }),
  );
  assert.deepEqual(pick(r, 'amount'), ['25.00', '0.00']);
  assert.deepEqual(pick(r, 'allocatedDiscount'), ['25.00', '0.00']);
  assert.equal(r.discounts[0].amount, '25.00');
});

test('R25: negative lines', () => {
  assert.equal(codeOf(() => calculateInvoice(invoice({ lines: [line('N', '1', '-5.00', 'standard', { discounts: [{ type: 'percent', value: '10' }] })] }))), 'INVALID_LINE');
  const r = calculateInvoice(invoice({ discounts: [{ type: 'percent', value: '10' }], lines: [line('A', '1', '100.00'), line('N', '1', '-20.00', 'standard', { discountable: true })] }));
  assert.equal(r.discounts[0].amount, '10.00');
  assert.deepEqual(pick(r, 'allocatedDiscount'), ['10.00', '0.00']);
  assert.deepEqual(pick(r, 'net'), ['90.00', '-20.00']);
  assert.equal(r.totals.gross, '84.00');
});

test('R26: line rounding rounds each line, document rounding does not', () => {
  const lines = [line('A', '1', '0.004'), line('B', '1', '0.004'), line('C', '1', '0.004')];
  const byLine = calculateInvoice(invoice({ lines }));
  assert.equal(byLine.totals.net, '0.00');
  const byDoc = calculateInvoice(invoice({ lines, rounding: 'document' }));
  assert.deepEqual(pick(byDoc, 'amount'), ['0.00', '0.00', '0.00']);
  assert.equal(byDoc.totals.net, '0.01');
});
