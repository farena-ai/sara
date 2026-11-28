import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateInvoice } from '../src/index.js';
import { invoice, line, pick } from './helpers.js';

const pct = (value, code) => ({ type: 'percent', value, ...(code ? { code } : {}) });
const amt = (value, code) => ({ type: 'amount', value, ...(code ? { code } : {}) });

test('R27: discountable false and zero-amount lines', () => {
  const r = calculateInvoice(
    invoice({
      discounts: [pct('10')],
      lines: [line('A', '1', '100.00'), line('B', '1', '50.00', 'standard', { discountable: false }), line('C', '1', '0.00')],
    }),
  );
  assert.equal(r.discounts[0].amount, '10.00');
  assert.deepEqual(pick(r, 'allocatedDiscount'), ['10.00', '0.00', '0.00']);
  assert.equal(r.totals.discount, '10.00');
});

test('R28 R31: percentages first, each rounded when applied, listed in application order', () => {
  const r = calculateInvoice(invoice({ discounts: [amt('10.00', 'TEN'), pct('10', 'PCT')], lines: [line('A', '1', '100.00')] }));
  assert.deepEqual(r.discounts, [
    { code: 'PCT', type: 'percent', value: '10', amount: '10.00' },
    { code: 'TEN', type: 'amount', value: '10.00', amount: '10.00' },
  ]);
  assert.equal(r.totals.discount, '20.00');
  const steps = calculateInvoice(invoice({ discounts: [pct('50'), pct('50')], lines: [line('A', '1', '0.07')] }));
  assert.deepEqual(steps.discounts.map((d) => d.amount), ['0.04', '0.02']);
  assert.equal(steps.totals.discount, '0.06');
  assert.equal(steps.lines[0].net, '0.01');
});

test('R28: document rounding keeps discount amounts exact', () => {
  const lines = [line('A', '1', '0.333'), line('B', '1', '0.333'), line('C', '1', '0.333')];
  const byDoc = calculateInvoice(invoice({ rounding: 'document', discounts: [pct('50')], lines }));
  assert.equal(byDoc.discounts[0].amount, '0.50');
  assert.equal(byDoc.totals.discount, '0.50');
  assert.equal(byDoc.totals.net, '0.50');
  const byLine = calculateInvoice(invoice({ discounts: [pct('50')], lines }));
  assert.equal(byLine.discounts[0].amount, '0.50');
  assert.equal(byLine.totals.net, '0.49');
});

test('R29 R31: a fixed document discount takes at most what is left', () => {
  const r = calculateInvoice(invoice({ discounts: [amt('50.00', 'BIG'), amt('5.00', 'SMALL')], lines: [line('A', '1', '30.00')] }));
  assert.deepEqual(r.discounts.map((d) => [d.code, d.amount]), [['BIG', '30.00'], ['SMALL', '0.00']]);
  assert.equal(r.lines[0].net, '0.00');
  assert.equal(r.totals.gross, '0.00');
});

test('R30: largest remainder, ties to the earlier line', () => {
  const three = calculateInvoice(invoice({ discounts: [amt('0.10')], lines: [line('A', '1', '1.00'), line('B', '1', '1.00'), line('C', '1', '1.00')] }));
  assert.deepEqual(pick(three, 'allocatedDiscount'), ['0.04', '0.03', '0.03']);
  const four = calculateInvoice(invoice({ discounts: [amt('0.02')], lines: ['A', 'B', 'C', 'D'].map((id) => line(id, '1', '1.00')) }));
  assert.deepEqual(pick(four, 'allocatedDiscount'), ['0.01', '0.01', '0.00', '0.00']);
  const mixed = calculateInvoice(invoice({ discounts: [amt('1.00')], lines: [line('A', '1', '1.00'), line('B', '1', '2.00'), line('C', '1', '4.00')] }));
  assert.deepEqual(pick(mixed, 'allocatedDiscount'), ['0.14', '0.29', '0.57']);
});

test('R30 R35 R36: document rounding allocates exact shares', () => {
  const r = calculateInvoice(invoice({ rounding: 'document', discounts: [amt('1.00')], lines: [line('A', '1', '1.00'), line('B', '1', '2.00', 'reduced')] }));
  assert.deepEqual(pick(r, 'allocatedDiscount'), ['0.33', '0.67']);
  assert.deepEqual(pick(r, 'net'), [null, null]);
  assert.deepEqual(pick(r, 'tax'), [null, null]);
  assert.deepEqual(pick(r, 'gross'), [null, null]);
  assert.deepEqual(r.taxes, [
    { taxClass: 'standard', rate: '20', net: '0.67', tax: '0.13' },
    { taxClass: 'reduced', rate: '10', net: '1.33', tax: '0.13' },
  ]);
  assert.equal(r.totals.net, '2.00');
  assert.equal(r.totals.gross, '2.26');
});

test('R32: the minimum is compared after document discounts, strictly below', () => {
  const doc = (min, discounts = [pct('10')]) => invoice({ discounts, minimumCharge: { amount: min }, lines: [line('A', '1', '100.00')] });
  const r = calculateInvoice(doc('95.00'));
  assert.deepEqual(pick(r, 'id'), ['A', 'MINIMUM']);
  assert.equal(r.lines[1].amount, '5.00');
  assert.equal(calculateInvoice(doc('90.00')).lines.length, 1);
  assert.equal(calculateInvoice(doc('90.01')).lines[1].amount, '0.01');
  assert.equal(calculateInvoice(invoice({ minimumCharge: { amount: '50.00' } })).lines.length, 0);
  const neg = calculateInvoice(invoice({ minimumCharge: { amount: '90.00' }, lines: [line('A', '1', '100.00'), line('N', '1', '-20.00')] }));
  assert.equal(neg.lines[2].amount, '10.00');
});

test('R33: the top-up line', () => {
  const r = calculateInvoice(invoice({ discounts: [pct('50')], minimumCharge: { amount: '25.00', taxClass: 'reduced' }, lines: [line('A', '1', '20.00', 'standard', { description: 'Hosting' })] }));
  assert.deepEqual(r.lines[1], {
    id: 'MINIMUM',
    description: 'Minimum charge adjustment',
    taxClass: 'reduced',
    quantity: '1',
    unitPrice: '15.00',
    amount: '15.00',
    allocatedDiscount: '0.00',
    net: '15.00',
    tax: '1.50',
    gross: '16.50',
  });
  assert.equal(r.discounts[0].amount, '10.00');
  assert.deepEqual(r.taxes.map((t) => [t.taxClass, t.net, t.tax]), [['standard', '10.00', '2.00'], ['reduced', '15.00', '1.50']]);
  assert.equal(r.totals.gross, '28.50');
});

test('R13 R32 R33 R34: inclusive invoice with a document discount and a top-up', () => {
  const r = calculateInvoice(invoice({ priceMode: 'inclusive', discounts: [pct('10')], minimumCharge: { amount: '60.00' }, lines: [line('A', '1', '50.00')] }));
  assert.deepEqual(pick(r, 'gross'), ['45.00', '15.00']);
  assert.deepEqual(pick(r, 'tax'), ['7.50', '2.50']);
  assert.deepEqual(pick(r, 'net'), ['37.50', '12.50']);
  assert.deepEqual(r.totals, { discount: '5.00', net: '50.00', tax: '10.00', gross: '60.00', roundingAdjustment: '0.00', payable: '60.00' });
});

test('R34: line rounding sums rounded line taxes', () => {
  const lines = ['A', 'B', 'C'].map((id) => line(id, '1', '0.05', 'reduced'));
  const byLine = calculateInvoice(invoice({ lines }));
  assert.deepEqual(pick(byLine, 'tax'), ['0.01', '0.01', '0.01']);
  assert.equal(byLine.taxes[0].tax, '0.03');
  const byDoc = calculateInvoice(invoice({ lines, rounding: 'document' }));
  assert.equal(byDoc.taxes[0].tax, '0.02');
  assert.equal(byDoc.totals.gross, '0.17');
});

test('R35: document rounding takes tax from the exact class sum', () => {
  const excl = calculateInvoice(invoice({ rounding: 'document', taxRates: { reduced: '7' }, lines: [line('A', '1', '14.3571', 'reduced')] }));
  assert.deepEqual(excl.taxes, [{ taxClass: 'reduced', rate: '7', net: '14.36', tax: '1.00' }]);
  const incl = calculateInvoice(invoice({ rounding: 'document', priceMode: 'inclusive', lines: [line('A', '1', '10.046')] }));
  assert.deepEqual(incl.taxes, [{ taxClass: 'standard', rate: '20', net: '8.38', tax: '1.67' }]);
  assert.equal(incl.totals.gross, '10.05');
  const exempt = calculateInvoice(invoice({ rounding: 'document', lines: [line('E', '1', '0.004', 'exempt'), line('F', '1', '0.004', 'exempt')] }));
  assert.deepEqual(exempt.taxes, []);
  assert.equal(exempt.totals.net, '0.01');
});

test('R36: line fields in line rounding mode', () => {
  const r = calculateInvoice(invoice({ discounts: [pct('10')], lines: [line('A', '2', '12.50', 'standard', { description: 'Seats' })] }));
  assert.deepEqual(r.lines[0], { id: 'A', description: 'Seats', taxClass: 'standard', quantity: '2', unitPrice: '12.50', amount: '25.00', allocatedDiscount: '2.50', net: '22.50', tax: '4.50', gross: '27.00' });
});

test('R37: totals are sums of rounded values', () => {
  const r = calculateInvoice(
    invoice({
      rounding: 'document',
      discounts: [pct('10')],
      lines: [line('A', '1', '0.335'), line('B', '1', '0.335', 'reduced'), line('C', '1', '0.335', 'exempt')],
    }),
  );
  assert.deepEqual(r.taxes.map((t) => [t.taxClass, t.net, t.tax]), [['standard', '0.30', '0.06'], ['reduced', '0.30', '0.03']]);
  assert.deepEqual(r.totals, { discount: '0.10', net: '0.90', tax: '0.09', gross: '0.99', roundingAdjustment: '0.00', payable: '0.99' });
});

test('R38: cash rounding to the currency increment', () => {
  const chf = (price, cashRounding = true) => calculateInvoice(invoice({ currency: 'CHF', cashRounding, taxRates: { standard: '0' }, lines: [line('A', '1', price)] })).totals;
  assert.deepEqual([chf('10.03').payable, chf('10.03').roundingAdjustment], ['10.05', '0.02']);
  assert.deepEqual([chf('10.02').payable, chf('10.02').roundingAdjustment], ['10.00', '-0.02']);
  assert.deepEqual([chf('10.07').payable, chf('10.07').gross], ['10.05', '10.07']);
  assert.deepEqual([chf('10.03', false).payable, chf('10.03', false).roundingAdjustment], ['10.03', '0.00']);
  const sek = (price) => calculateInvoice(invoice({ currency: 'SEK', cashRounding: true, taxRates: { standard: '0' }, lines: [line('A', '1', price)] })).totals;
  assert.equal(sek('99.50').payable, '100.00');
  assert.equal(sek('99.49').payable, '99.00');
  assert.deepEqual([sek('-99.50').payable, sek('-99.50').roundingAdjustment], ['-100.00', '-0.50']);
  const eur = calculateInvoice(invoice({ cashRounding: true, lines: [line('A', '1', '10.03')] })).totals;
  assert.deepEqual([eur.payable, eur.roundingAdjustment], ['12.04', '0.00']);
  const t = calculateInvoice(invoice({ currency: 'CHF', cashRounding: true, taxRates: { standard: '8.1' }, lines: [line('A', '1', '10.00')] }));
  assert.deepEqual(t.totals, { discount: '0.00', net: '10.00', tax: '0.81', gross: '10.81', roundingAdjustment: '-0.01', payable: '10.80' });
});

test('R10 R28 R30 R34 R15: a multi-class invoice in line rounding mode', () => {
  const r = calculateInvoice(
    invoice({
      taxRates: { standard: '20', reduced: '5.50' },
      discounts: [amt('5.00', 'FIVE'), pct('10', 'TEN')],
      lines: [line('A', '3', '19.99'), line('B', '1', '7.333', 'reduced'), line('C', '2', '4', 'exempt')],
    }),
  );
  assert.deepEqual(pick(r, 'amount'), ['59.97', '7.33', '8.00']);
  assert.deepEqual(pick(r, 'allocatedDiscount'), ['9.98', '1.22', '1.33']);
  assert.deepEqual(pick(r, 'net'), ['49.99', '6.11', '6.67']);
  assert.deepEqual(pick(r, 'tax'), ['10.00', '0.34', '0.00']);
  assert.deepEqual(r.discounts.map((d) => [d.code, d.amount]), [['TEN', '7.53'], ['FIVE', '5.00']]);
  assert.deepEqual(r.taxes, [
    { taxClass: 'standard', rate: '20', net: '49.99', tax: '10.00' },
    { taxClass: 'reduced', rate: '5.5', net: '6.11', tax: '0.34' },
  ]);
  assert.deepEqual(r.totals, { discount: '12.53', net: '62.77', tax: '10.34', gross: '73.11', roundingAdjustment: '0.00', payable: '73.11' });
});

test('R3 R7 R28 R30: three-decimal currency with a document discount', () => {
  const r = calculateInvoice(invoice({ currency: 'KWD', discounts: [pct('10'), amt('0.5')], lines: [line('A', '1', '1.2345'), line('B', '2', '0.4445', 'reduced')] }));
  assert.deepEqual(pick(r, 'amount'), ['1.235', '0.889']);
  assert.deepEqual(r.discounts.map((d) => d.amount), ['0.212', '0.500']);
  assert.deepEqual(pick(r, 'allocatedDiscount'), ['0.414', '0.298']);
  assert.equal(r.totals.net, '1.412');
});
