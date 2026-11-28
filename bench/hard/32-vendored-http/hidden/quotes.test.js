import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEMS } from './fixture.js';
import { setup } from './helpers.js';

const app = (script) => setup({ items: ITEMS, script });
const unavailable = { error: 'pricing-unavailable' };

test('rule 15: a quote passes qty on and returns the price', async () => {
  const { call, calls } = app();
  const res = await call('GET', '/items/3/quote?qty=4');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 3, sku: 'GLUE-50', qty: 4, unit: 250, total: 1000 });
  assert.deepEqual(calls.map((c) => [c.sku, c.qty]), [['GLUE-50', '4']]);
});

test('rule 15: qty defaults to 1; rule 7: a repeated qty uses the first', async () => {
  const { call } = app();
  assert.equal((await call('GET', '/items/1/quote')).body.qty, 1);
  assert.equal((await call('GET', '/items/1/quote?qty=2&qty=9')).body.total, 500);
});

test('rule 15: a bad qty is 400 bad-qty; an unknown item is 404 first', async () => {
  const { call, calls } = app();
  for (const qty of ['0', '1001', 'x', '1.5', '']) {
    const res = await call('GET', `/items/1/quote?qty=${qty}`);
    assert.equal(res.status, 400, `qty=${qty}`);
    assert.deepEqual(res.body, { error: 'bad-qty' });
  }
  const missing = await call('GET', '/items/6/quote?qty=0');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'not-found' });
  assert.equal(calls.length, 0);
});

test('rule 14: an answer within 2 seconds is used', async () => {
  const { call, calls, clock } = app([{ sleep: 1.5 }]);
  const res = await call('GET', '/items/1/quote?qty=2');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(clock.now(), 1.5);
});

test('rule 14: each attempt times out after 2 seconds, three attempts, 0.5 s apart', async () => {
  const { call, calls, clock } = app([{ sleep: 5 }]);
  const res = await call('GET', '/items/1/quote');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, unavailable);
  assert.deepEqual(calls.map((c) => c.at), [0, 2.5, 5]);
  assert.equal(clock.now(), 7);
});

test('rule 14: a slow first answer is retried', async () => {
  const { call, calls, clock } = app([{ sleep: 3 }, {}]);
  const res = await call('GET', '/items/2/quote?qty=10');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2500);
  assert.deepEqual(calls.map((c) => c.at), [0, 2.5]);
  assert.equal(clock.now(), 2.5);
});

test('rule 14: 503 twice then an answer: retried, waiting 0.5 s each time', async () => {
  const { call, calls, clock } = app([{ status: 503 }, { status: 503 }, {}]);
  const res = await call('GET', '/items/1/quote');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.at), [0, 0.5, 1]);
  assert.equal(clock.now(), 1);
});

test('rule 14: 502 and 504 are retried too', async () => {
  const { call, calls } = app([{ status: 502 }, { status: 504 }, {}]);
  assert.equal((await call('GET', '/items/1/quote')).status, 200);
  assert.equal(calls.length, 3);
});

test('rule 14: other statuses are not retried (500 is unavailable at once)', async () => {
  const { call, calls, clock } = app([{ status: 500 }, {}]);
  const res = await call('GET', '/items/1/quote');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, unavailable);
  assert.equal(calls.length, 1);
  assert.equal(clock.now(), 0);
});

test('rule 16: 503 on every attempt is pricing-unavailable after 3 attempts', async () => {
  const { call, calls, clock } = app([{ status: 503 }]);
  const res = await call('GET', '/items/1/quote');
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, unavailable);
  assert.equal(calls.length, 3);
  assert.equal(clock.now(), 1);
});

test('rule 16: a pricing 404 is no-price and is not retried', async () => {
  const { call, calls } = app([{ status: 404 }]);
  const res = await call('GET', '/items/4/quote');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'no-price' });
  assert.equal(calls.length, 1);
});
