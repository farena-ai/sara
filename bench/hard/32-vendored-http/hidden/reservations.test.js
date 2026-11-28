import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEMS } from './fixture.js';
import { setup } from './helpers.js';

const app = (script) => setup({ items: ITEMS, script });
const reserve = (call, id, body, opts = {}) => call('POST', `/items/${id}/reserve`, { body, ...opts });

test('rule 17: reserving is a write and needs a key', async () => {
  const { call } = app();
  const res = await reserve(call, 3, { qty: 1 }, { key: null });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthorized' });
});

test('rule 17: an unknown item is 404 before the body is looked at', async () => {
  const { call } = app();
  for (const body of [{ qty: 1 }, 'not json', { qty: 0 }]) {
    const res = await reserve(call, 6, body);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not-found' });
  }
  assert.equal((await reserve(call, 'abc', { qty: 1 })).status, 404);
});

test('rule 17: broken or empty JSON is 400 invalid-json', async () => {
  const { call } = app();
  for (const body of ['{"qty": 2', '', undefined]) {
    const res = await reserve(call, 3, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'invalid-json' });
  }
});

test('rule 17: qty must be a whole number >= 1 in an object (422)', async () => {
  const { call, calls } = app();
  for (const body of [{ qty: 0 }, { qty: -2 }, { qty: 1.5 }, { qty: '3' }, {}, [3], { amount: 3 }]) {
    const res = await reserve(call, 3, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'invalid', field: 'qty' });
  }
  assert.equal(calls.length, 0);
});

test('rule 17: more than the available stock is 409 with what is available', async () => {
  const { call } = app();
  const res = await reserve(call, 3, { qty: 41 });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'insufficient-stock', available: 40 });
  const empty = await reserve(call, 4, { qty: 1 });
  assert.deepEqual(empty.body, { error: 'insufficient-stock', available: 0 });
  assert.equal((await reserve(call, 3, { qty: 30 })).status, 201);
  const after = await reserve(call, 3, { qty: 11 });
  assert.equal(after.status, 409);
  assert.deepEqual(after.body, { error: 'insufficient-stock', available: 10 });
  assert.equal((await reserve(call, 3, { qty: 10 })).status, 201);
});

test('rules 18-19: a reservation is 201 with price, location and price status', async () => {
  const { call, calls } = app();
  const res = await reserve(call, 3, { qty: 5 });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { reservation: 1, itemId: 3, qty: 5, total: 1250, available: 35 });
  assert.equal(res.header('location'), '/reservations/1');
  assert.equal(res.header('x-price-status'), 'ok');
  assert.deepEqual(calls.map((c) => [c.sku, c.qty]), [['GLUE-50', '5']]);
  const item = await call('GET', '/items/3');
  assert.equal(item.body.reserved, 5);
  assert.equal(item.body.stock, 40);
});

test('rule 18: reservation numbers count up per app', async () => {
  const { call } = app();
  assert.equal((await reserve(call, 1, { qty: 1 })).body.reservation, 1);
  assert.equal((await reserve(call, 2, { qty: 1 })).body.reservation, 2);
  assert.equal((await reserve(call, 1, { qty: 2 })).body.reservation, 3);
  assert.equal((await call('GET', '/items/1')).body.reserved, 3);
  assert.equal((await setup({ items: ITEMS }).call('POST', '/items/1/reserve', { body: { qty: 1 } })).body.reservation, 1);
});

test('rule 19: without a price the reservation is still made (missing)', async () => {
  const { call } = app([{ status: 404 }]);
  const res = await reserve(call, 5, { qty: 4 });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { reservation: 1, itemId: 5, qty: 4, total: null, available: 116 });
  assert.equal(res.header('x-price-status'), 'missing');
});

test('rule 19: pricing unavailable uses the pricing rules and still reserves', async () => {
  const { call, calls, clock } = app([{ sleep: 9 }]);
  const res = await reserve(call, 5, { qty: 4 });
  assert.equal(res.status, 201);
  assert.equal(res.body.total, null);
  assert.equal(res.header('x-price-status'), 'unavailable');
  assert.equal(calls.length, 3);
  assert.equal(clock.now(), 7);
  assert.equal((await call('GET', '/items/5')).body.reserved, 4);
});

test('rule 20: a reservation can be read back', async () => {
  const { call } = app();
  await reserve(call, 3, { qty: 5 });
  await reserve(call, 1, { qty: 2 });
  const res = await call('GET', '/reservations/2');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { reservation: 2, itemId: 1, qty: 2, total: 500 });
  const none = await call('GET', '/reservations/3');
  assert.equal(none.status, 404);
  assert.deepEqual(none.body, { error: 'not-found' });
});

test('rule 21: a repeated Idempotency-Key replays the first answer', async () => {
  const { call, calls } = app();
  const first = await reserve(call, 3, { qty: 5 }, { headers: { 'Idempotency-Key': 'abc' } });
  assert.equal(first.status, 201);
  const again = await reserve(call, 3, { qty: 5 }, { headers: { 'idempotency-key': 'abc' } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.header('x-idempotent-replay'), 'true');
  assert.equal(calls.length, 1);
  assert.equal((await call('GET', '/items/3')).body.reserved, 5);
  assert.equal((await call('GET', '/reservations/2')).status, 404);
});

test('rule 21: the replay ignores the item and body of the new request', async () => {
  const { call } = app();
  const first = await reserve(call, 3, { qty: 5 }, { headers: { 'Idempotency-Key': 'k1' } });
  const other = await reserve(call, 1, 'not even json', { headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(other.status, 200);
  assert.deepEqual(other.body, first.body);
  assert.equal((await call('GET', '/items/1')).body.reserved, 0);
  const fresh = await reserve(call, 1, { qty: 1 }, { headers: { 'Idempotency-Key': 'k2' } });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.body.reservation, 2);
});

test('rule 21: a failed request does not use up its key', async () => {
  const { call } = app();
  assert.equal((await reserve(call, 3, { qty: 0 }, { headers: { 'Idempotency-Key': 'k' } })).status, 422);
  assert.equal((await reserve(call, 3, { qty: 99 }, { headers: { 'Idempotency-Key': 'k' } })).status, 409);
  const ok = await reserve(call, 3, { qty: 2 }, { headers: { 'Idempotency-Key': 'k' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.reservation, 1);
});

test('rule 13: an item with reservations cannot be deleted', async () => {
  const { call } = app();
  await reserve(call, 5, { qty: 1 });
  const res = await call('DELETE', '/items/5');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'has-reservations' });
  assert.equal((await call('GET', '/items/5')).status, 200);
  assert.equal((await call('DELETE', '/items/7')).status, 204);
});
