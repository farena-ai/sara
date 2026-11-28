import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rational, ZERO } from '../src/num/rational.js';

const r = (s) => Rational.parse(s);

test('parse and normalize', () => {
  assert.equal(r('12.50').toString(), '25/2');
  assert.equal(r('-0.125').toString(), '-1/8');
  assert.equal(r('007').toString(), '7');
  assert.ok(r('0.0').isZero());
  assert.throws(() => r('1e3'), SyntaxError);
});

test('arithmetic is exact', () => {
  const third = Rational.of(1).div(3);
  assert.ok(third.add(third).add(third).eq(1));
  assert.equal(r('0.1').add(r('0.2')).toString(), '3/10');
  assert.equal(r('2.5').mul(r('-4')).toString(), '-10');
  assert.ok(r('1.005').gt(r('1.0049999')));
  assert.throws(() => r('1').div(ZERO), RangeError);
});

test('floor, sign and comparisons', () => {
  assert.equal(r('2.7').floor(), 2n);
  assert.equal(r('-2.1').floor(), -3n);
  assert.equal(r('-2').floor(), -2n);
  assert.equal(r('-0.5').sign(), -1);
  assert.equal(ZERO.sign(), 0);
  assert.ok(Rational.min(r('1'), r('2')).eq(1));
  assert.ok(Rational.max(r('1'), r('2')).eq(2));
  assert.ok(Rational.sum([r('0.5'), r('0.25'), r('0.25')]).eq(1));
});
