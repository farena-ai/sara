import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEMS, skus } from './fixture.js';
import { setup } from './helpers.js';

const app = () => setup({ items: ITEMS });

test('rule 1: request ids count every request, errors included', async () => {
  const { call } = app();
  assert.equal((await call('GET', '/nowhere')).header('x-request-id'), 'req-1');
  assert.equal((await call('POST', '/items', { key: null, body: {} })).header('x-request-id'), 'req-2');
  assert.equal((await call('GET', '/items/1')).header('x-request-id'), 'req-3');
});

test('rule 3: the X-Api-Key header name is not case-sensitive', async () => {
  const { call } = app();
  const body = { sku: 'PIN-1', name: 'Pin', stock: 1 };
  assert.equal((await call('POST', '/items', { key: null, body, headers: { 'x-api-key': 'test-key' } })).status, 201);
  assert.equal((await call('POST', '/items', { key: null, body: { ...body, sku: 'PIN-2' }, headers: { 'X-API-KEY': 'test-key' } })).status, 201);
});

test('rule 3: missing or wrong keys get 401, reads need no key', async () => {
  const { call } = app();
  const body = { sku: 'PIN-1', name: 'Pin', stock: 1 };
  for (const key of [null, 'wrong']) {
    const res = await call('POST', '/items', { key, body });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  }
  assert.equal((await call('DELETE', '/items/1', { key: 'nope' })).status, 401);
  assert.equal((await call('POST', '/nowhere', { key: null, body })).status, 401);
  assert.equal((await call('GET', '/items/1', { key: null })).status, 200);
  assert.equal((await call('GET', '/items', { key: null })).body.count, 3 + 3);
});

test('rule 3: a write with a valid key runs exactly once', async () => {
  const { call } = app();
  const res = await call('POST', '/items', { body: { sku: 'PIN-1', name: 'Pin', stock: 1 } });
  assert.equal(res.status, 201);
  assert.equal((await call('GET', '/items')).body.count, 7);
});

test('rule 4: unknown routes are 404, unsupported methods 405 with allow', async () => {
  const { call } = app();
  const none = await call('GET', '/items/1/notes');
  assert.equal(none.status, 404);
  assert.deepEqual(none.body, { error: 'no-route' });
  const put = await call('PUT', '/items', { body: {} });
  assert.equal(put.status, 405);
  assert.equal(put.header('allow'), 'GET, POST');
});

test('rule 5: the list is sorted by id with a count', async () => {
  const res = await app().call('GET', '/items');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((i) => i.id), [1, 2, 3, 4, 5, 7]);
  assert.equal(res.body.count, 6);
  assert.deepEqual(res.body.items[4], { id: 5, sku: 'DOWEL-8', name: 'Beech dowel 8 mm', tags: ['wood', 'round'], stock: 120, reserved: 0 });
});

test('rule 6: one tag filters by that tag', async () => {
  const { call } = app();
  assert.deepEqual(skus(await call('GET', '/items?tag=metal')), ['BOLT-M6', 'NUT-M6', 'HOOK-S']);
  assert.deepEqual(skus(await call('GET', '/items?tag=round')), ['DOWEL-8']);
  assert.deepEqual(skus(await call('GET', '/items?tag=glass')), []);
});

test('rule 6: repeated tags match items with any of them', async () => {
  const { call } = app();
  assert.deepEqual(skus(await call('GET', '/items?tag=wood&tag=paper')), ['GLUE-50', 'TAPE-25', 'DOWEL-8']);
  assert.deepEqual(skus(await call('GET', '/items?tag=round&tag=fastener&tag=glass')), ['BOLT-M6', 'NUT-M6', 'DOWEL-8']);
});

test('rule 7: q matches names ignoring case', async () => {
  const { call } = app();
  assert.deepEqual(skus(await call('GET', '/items?q=HEX')), ['BOLT-M6', 'NUT-M6']);
  assert.deepEqual(skus(await call('GET', '/items?q=8+mm')), ['DOWEL-8']);
  assert.deepEqual(skus(await call('GET', '/items?q=wood&tag=wood')), ['GLUE-50']);
});

test('rule 7: q and limit given twice use the first value', async () => {
  const { call } = app();
  assert.deepEqual(skus(await call('GET', '/items?q=nut&q=bolt')), ['NUT-M6']);
  assert.deepEqual(skus(await call('GET', '/items?limit=2&limit=500')), ['BOLT-M6', 'NUT-M6']);
});

test('rule 8: limit defaults to 20 and applies after filtering', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, sku: `P-${i + 1}`, name: `Part ${i + 1}`, tags: i % 2 ? ['odd'] : ['even'], stock: 1 }));
  const { call } = setup({ items: many });
  assert.equal((await call('GET', '/items')).body.count, 20);
  assert.equal((await call('GET', '/items?limit=100')).body.count, 25);
  const odd = await call('GET', '/items?tag=odd&limit=3');
  assert.deepEqual(skus(odd), ['P-2', 'P-4', 'P-6']);
  assert.equal(odd.body.count, 3);
});

test('rule 8: a bad limit is 400 bad-limit', async () => {
  const { call } = app();
  for (const limit of ['0', '101', 'ten', '2.5', '', '-1']) {
    const res = await call('GET', `/items?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit}`);
    assert.deepEqual(res.body, { error: 'bad-limit' });
  }
});

test('rule 9: one item by id', async () => {
  const { call } = app();
  const res = await call('GET', '/items/3');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 3, sku: 'GLUE-50', name: 'Wood glue 50 ml', tags: ['wood'], stock: 40, reserved: 0 });
  assert.equal((await call('GET', '/items/7')).body.sku, 'HOOK-S');
});

test('rule 9: unknown and non-numeric ids are 404', async () => {
  const { call } = app();
  const res = await call('GET', '/items/6');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not-found' });
  for (const id of ['abc', '2.5', '-1', '%20']) assert.equal((await call('GET', `/items/${id}`)).status, 404, id);
});

test('rule 10: an empty body or broken JSON is 400 invalid-json', async () => {
  const { call } = app();
  for (const body of ['{"sku": "PIN-1",', '', '   ', 'sku=PIN-1']) {
    const res = await call('POST', '/items', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'invalid-json' });
  }
});

test('rule 10: the first bad field is reported with 422', async () => {
  const { call } = app();
  const cases = [
    [[1, 2], 'body'],
    ['"PIN-1"', 'body'],
    [{ sku: 'pin-1', name: 'Pin', stock: 1 }, 'sku'],
    [{ sku: 'PIN 1', name: '', stock: -1 }, 'sku'],
    [{ sku: 'PIN-1', name: '  ', stock: 1 }, 'name'],
    [{ sku: 'PIN-1', name: 'Pin', tags: 'metal', stock: 1 }, 'tags'],
    [{ sku: 'PIN-1', name: 'Pin', tags: ['metal', 3], stock: 1 }, 'tags'],
    [{ sku: 'PIN-1', name: 'Pin', stock: 1.5 }, 'stock'],
    [{ sku: 'PIN-1', name: 'Pin' }, 'stock'],
  ];
  for (const [body, field] of cases) {
    const res = await call('POST', '/items', { body });
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'invalid', field });
  }
});

test('rule 11: a duplicate sku is 409', async () => {
  const res = await app().call('POST', '/items', { body: { sku: 'NUT-M6', name: 'Another nut', stock: 3 } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'duplicate-sku' });
});

test('rule 12: a created item gets the next id, a location and can be read back', async () => {
  const { call } = app();
  const res = await call('POST', '/items', { body: { sku: 'PIN-1', name: 'Pin', stock: 9 } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 8, sku: 'PIN-1', name: 'Pin', tags: [], stock: 9, reserved: 0 });
  assert.equal(res.header('location'), '/items/8');
  assert.deepEqual((await call('GET', '/items/8')).body, res.body);
  const second = await call('POST', '/items', { body: { sku: 'PIN-2', name: 'Pin 2', tags: ['metal'], stock: 0 } });
  assert.equal(second.body.id, 9);
  assert.deepEqual(skus(await call('GET', '/items?tag=metal')), ['BOLT-M6', 'NUT-M6', 'HOOK-S', 'PIN-2']);
});

test('rule 13: delete answers 204 without a body', async () => {
  const { call } = app();
  const res = await call('DELETE', '/items/2');
  assert.equal(res.status, 204);
  assert.equal(res.body, undefined);
  assert.equal(res.text, '');
  assert.equal((await call('GET', '/items/2')).status, 404);
  assert.equal((await call('GET', '/items')).body.count, 5);
});

test('rule 13: deleting an unknown item is 404', async () => {
  const res = await app().call('DELETE', '/items/6');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not-found' });
});
