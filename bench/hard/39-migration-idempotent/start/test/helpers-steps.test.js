import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEmail } from '../src/steps/common/email.js';
import { hasId } from '../src/steps/common/ids.js';
import { toCents } from '../src/steps/common/money.js';
import { GRAMS_PER_POUND, poundsToGrams } from '../src/steps/common/units.js';
import { entry, objectsOf, StepResult } from '../src/migrate/quarantine.js';
import { LATEST, STEPS } from '../src/index.js';

test('normalizeEmail trims, lower-cases and wants exactly one @ with text around it', () => {
  assert.equal(normalizeEmail('  Ann@Example.ORG '), 'ann@example.org');
  for (const bad of ['', 'ann', '@x.org', 'ann@', 'a@b@c', 42, null, undefined]) assert.equal(normalizeEmail(bad), null, String(bad));
});

test('hasId wants a non-empty string id', () => {
  assert.equal(hasId({ id: 'a' }), true);
  for (const id of ['', 7, null, undefined]) assert.equal(hasId({ id }), false);
});

test('toCents reads plain and grouped dollar amounts', () => {
  assert.equal(toCents('12.50'), 1250);
  assert.equal(toCents('1,000'), 100000);
  assert.equal(toCents('7'), 700);
  for (const bad of ['', '1.234', '12,34', '1,2345', '-1', ' 1', '$1', 1, null]) assert.equal(toCents(bad), null, String(bad));
});

test('poundsToGrams rounds to whole grams and refuses what is not a weight', () => {
  assert.equal(GRAMS_PER_POUND, 453.59237);
  assert.equal(poundsToGrams(1), 454);
  assert.equal(poundsToGrams(0), 0);
  assert.equal(poundsToGrams(2.5), 1134);
  for (const bad of [-1, '1', NaN, Infinity, null]) assert.equal(poundsToGrams(bad), null, String(bad));
});

test('a step result collects kept records and quarantine entries per collection', () => {
  const result = new StepResult('v1->v2');
  const records = objectsOf([{ record: { id: 'a' } }, { raw: 'junk' }], 'orders', result);
  result.reject('orders', 'bad total', { id: 'b' });
  result.keep('orders', records);
  assert.deepEqual(result.collections, { orders: [{ id: 'a' }] });
  assert.deepEqual(result.quarantine, { orders: [entry('v1->v2', 'not a JSON object', 'junk'), entry('v1->v2', 'bad total', { id: 'b' })] });
});

test('the registry lists the steps in order', () => {
  assert.deepEqual(STEPS.map((s) => [s.name, s.from]).slice(0, 1), [['v1->v2', 1]]);
  assert.equal(LATEST, STEPS.length + 1);
});
