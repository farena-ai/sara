import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.js';

test('health answers and every response gets a request id', async () => {
  const { call } = setup();
  const res = await call('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.header('x-request-id'), 'req-1');
  assert.equal((await call('GET', '/health')).header('x-request-id'), 'req-2');
});

test('the item list', async () => {
  const { call } = setup();
  const res = await call('GET', '/items');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 4);
  assert.deepEqual(res.body.items.map((i) => i.sku), ['BOLT-M6', 'NUT-M6', 'GLUE-50', 'TAPE-25']);
});

test('unknown routes', async () => {
  const { call } = setup();
  const res = await call('GET', '/nowhere');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'no-route' });
});

test('writes need a key', async () => {
  const { call } = setup();
  const res = await call('POST', '/items', { body: { sku: 'PIN-1', name: 'Pin', stock: 1 }, key: null });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthorized' });
});
