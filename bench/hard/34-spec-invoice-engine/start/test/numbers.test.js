import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysInclusive, dayNumber, isLeapYear } from '../src/dates/calendar.js';
import { formatAmount } from '../src/money/format.js';
import { decimalsOf, normalizeDecimal, parseDecimal } from '../src/num/parse.js';
import { Rational } from '../src/num/rational.js';
import { roundHalfUp } from '../src/num/round.js';

const r = (s) => Rational.parse(s);

test('parseDecimal checks the form and the limits', () => {
  assert.ok(parseDecimal('1.25', 'x').eq(r('1.25')));
  assert.throws(() => parseDecimal(1.25, 'x'), { code: 'INVALID_NUMBER' });
  assert.throws(() => parseDecimal('1.255', 'x', { maxDecimals: 2 }), { code: 'INVALID_NUMBER' });
  assert.throws(() => parseDecimal('0', 'x', { positive: true }), { code: 'INVALID_NUMBER' });
  assert.throws(() => parseDecimal('101', 'x', { max: 100 }), { code: 'INVALID_NUMBER' });
  assert.throws(() => parseDecimal('2.5', 'x', { integer: true }), { code: 'INVALID_NUMBER' });
  assert.equal(decimalsOf('3.140'), 3);
  assert.equal(decimalsOf('3'), 0);
});

test('normalizeDecimal', () => {
  assert.equal(normalizeDecimal('20.00'), '20');
  assert.equal(normalizeDecimal('5.50'), '5.5');
  assert.equal(normalizeDecimal('0.0'), '0');
});

test('half-up rounding goes away from zero', () => {
  assert.equal(roundHalfUp(r('2.345'), 2).toString(), '47/20');
  assert.equal(formatAmount(roundHalfUp(r('-2.345'), 2), 2), '-2.35');
  assert.equal(formatAmount(roundHalfUp(r('2.344999'), 2), 2), '2.34');
  assert.equal(formatAmount(roundHalfUp(r('1000.5'), 0), 0), '1001');
  assert.equal(formatAmount(roundHalfUp(r('0.0005'), 3), 3), '0.001');
});

test('formatAmount writes minor units', () => {
  assert.equal(formatAmount(r('12.3'), 2), '12.30');
  assert.equal(formatAmount(r('1200'), 0), '1200');
  assert.equal(formatAmount(r('1.25'), 3), '1.250');
  assert.equal(formatAmount(r('-0.05'), 2), '-0.05');
  assert.equal(formatAmount(r('0'), 2), '0.00');
  assert.throws(() => formatAmount(r('0.005'), 2), RangeError);
});

test('calendar days', () => {
  assert.equal(daysInclusive('2026-03-10', '2026-03-31'), 22);
  assert.equal(daysInclusive('2028-02-01', '2028-02-29'), 29);
  assert.equal(daysInclusive('2026-12-31', '2027-01-01'), 2);
  assert.ok(isLeapYear(2000) && !isLeapYear(1900) && isLeapYear(2028));
  assert.throws(() => dayNumber('2026-02-29'), { code: 'INVALID_DATE' });
  assert.throws(() => dayNumber('2026-3-1'), { code: 'INVALID_DATE' });
});
