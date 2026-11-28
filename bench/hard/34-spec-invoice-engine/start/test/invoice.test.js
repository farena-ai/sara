import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateInvoice } from '../src/index.js';
import { errorCode, invoice, line } from './helpers.js';

test('R1 R7: numbers are decimal strings within limits', () => {
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [line('A', 2, '1.00')] }))), 'INVALID_NUMBER');
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.5e2')] }))), 'INVALID_NUMBER');
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [line('A', '0.0001', '1.00')] }))), 'INVALID_NUMBER');
});

test('R3 R4: currencies and their minor units', () => {
  const jpy = calculateInvoice(invoice({ currency: 'JPY', taxRates: { standard: '10' }, lines: [line('A', '2', '1250')] }));
  assert.deepEqual([jpy.lines[0].amount, jpy.lines[0].tax, jpy.totals.gross], ['2500', '250', '2750']);
  const kwd = calculateInvoice(invoice({ currency: 'KWD', taxRates: { standard: '5' }, lines: [line('A', '1', '2.5')] }));
  assert.deepEqual([kwd.lines[0].amount, kwd.lines[0].tax], ['2.500', '0.125']);
  assert.equal(errorCode(() => calculateInvoice(invoice({ currency: 'DEM' }))), 'UNKNOWN_CURRENCY');
});

test('R5: line amounts round half-up', () => {
  const r = calculateInvoice(invoice({ lines: [line('A', '3', '0.335'), line('B', '1', '0.004')] }));
  assert.deepEqual(r.lines.map((l) => l.amount), ['1.01', '0.00']);
});

test('R8 R9: document checks', () => {
  assert.equal(errorCode(() => calculateInvoice(invoice({ number: undefined }))), 'INVALID_INVOICE');
  assert.equal(errorCode(() => calculateInvoice(invoice({ priceMode: 'net' }))), 'INVALID_SETTING');
  assert.equal(errorCode(() => calculateInvoice(invoice({ issueDate: '2026-02-29' }))), 'INVALID_DATE');
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00'), line('A', '1', '2.00')] }))), 'DUPLICATE_LINE_ID');
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [{ id: 'A', quantity: '1', taxClass: 'standard' }] }))), 'INVALID_LINE');
});

test('R11: tax classes need a rate', () => {
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [line('A', '1', '1.00', 'luxury')] }))), 'UNKNOWN_TAX_CLASS');
  assert.equal(errorCode(() => calculateInvoice(invoice({ taxRates: { reduced: '10' }, lines: [line('A', '1', '1.00')] }))), 'UNKNOWN_TAX_CLASS');
});

test('R12 R16: a tax-exclusive invoice', () => {
  const r = calculateInvoice(invoice({ taxRates: { standard: '20.0', reduced: '5.50' }, lines: [line('A', '2', '10.00', 'standard', { description: 'Widget' }), line('B', '1', '4.00', 'reduced')] }));
  assert.deepEqual(r.lines[0], { id: 'A', description: 'Widget', taxClass: 'standard', quantity: '2', unitPrice: '10.00', amount: '20.00', allocatedDiscount: '0.00', net: '20.00', tax: '4.00', gross: '24.00' });
  assert.deepEqual(r.taxes, [
    { taxClass: 'standard', rate: '20', net: '20.00', tax: '4.00' },
    { taxClass: 'reduced', rate: '5.5', net: '4.00', tax: '0.22' },
  ]);
  assert.deepEqual(r.totals, { discount: '0.00', net: '24.00', tax: '4.22', gross: '28.22', roundingAdjustment: '0.00', payable: '28.22' });
  assert.equal(r.kind, 'invoice');
});

test('R17 R20: volume tiers', () => {
  const tiers = [{ from: '1', unitPrice: '2.00' }, { from: '100', unitPrice: '1.50' }];
  const small = calculateInvoice(invoice({ lines: [{ id: 'T', quantity: '99', tiers, taxClass: 'standard' }] }));
  assert.deepEqual([small.lines[0].unitPrice, small.lines[0].amount], ['2.00', '198.00']);
  const big = calculateInvoice(invoice({ lines: [{ id: 'T', quantity: '100', tiers, taxClass: 'standard' }] }));
  assert.deepEqual([big.lines[0].unitPrice, big.lines[0].amount], ['1.50', '150.00']);
  assert.equal(errorCode(() => calculateInvoice(invoice({ lines: [{ id: 'T', quantity: '1', tiers: [{ from: '5', unitPrice: '1.00' }], taxClass: 'standard' }] }))), 'INVALID_TIERS');
});
