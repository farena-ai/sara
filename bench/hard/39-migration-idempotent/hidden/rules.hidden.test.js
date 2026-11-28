import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, lines, ndjson, read, withStore } from './helpers.js';

const v1Order = (id, total, items = [], more = {}) => ({ id, customer: 'c', total, weight_lb: 1, items, ...more });

test('hidden MIGRATIONS v1->v2: dollar amounts become exact cents (totals and item prices)', () => {
  const amounts = ['0.29', '4.35', '1.15', '0.57', '1,234.50', '1,000,000', '19.99', '0.1', '8.7', '0'];
  const orders = amounts.map((a, i) => v1Order(`o${i}`, a, [{ sku: 's', qty: 1, price: a }]));
  withStore({ schema: 1, files: { 'records/customers.ndjson': '', 'records/orders.ndjson': ndjson(orders) } }, (dir) => {
    api.migrate(dir, { to: 2 });
    const out = lines(read(dir, 'records/orders.ndjson'));
    assert.deepEqual(out.map((o) => o.total_cents), [29, 435, 115, 57, 123450, 100000000, 1999, 10, 870, 0]);
    assert.deepEqual(out.map((o) => o.items[0].price_cents), [29, 435, 115, 57, 123450, 100000000, 1999, 10, 870, 0]);
  });
});

test('hidden MIGRATIONS rules for every step: the first record with an id is kept, later ones are quarantined as duplicate id', () => {
  const customers = [
    { id: 'a', name: 'First', email: 'one@x.io' },
    { id: 'b', name: 'B', email: 'b@x.io' },
    { id: 'a', name: 'Second', email: 'two@x.io' },
    { id: 'a', name: 'Third', email: 'bad' },
  ];
  withStore({ schema: 1, files: { 'records/customers.ndjson': ndjson(customers), 'records/orders.ndjson': '' } }, (dir) => {
    api.migrate(dir, { to: 2 });
    assert.deepEqual(lines(read(dir, 'records/customers.ndjson')).map((c) => [c.id, c.full_name]), [['a', 'First'], ['b', 'B']]);
    assert.deepEqual(lines(read(dir, 'quarantine/customers.ndjson')), [
      { reason: 'bad email', record: { email: 'bad', id: 'a', name: 'Third' }, step: 'v1->v2' },
      { reason: 'duplicate id', record: { email: 'two@x.io', id: 'a', name: 'Second' }, step: 'v1->v2' },
    ]);
  });
});

test('hidden MIGRATIONS v1->v2: check order for orders (bad total, bad weight, bad items, bad item price) and missing id', () => {
  const orders = [
    v1Order('a', '1.0.0'),
    v1Order('b', '1.00', [], { weight_lb: -1 }),
    v1Order('c', '1.00', 'x'),
    v1Order('d', '1.00', [{ sku: 'k', price: '1.999' }]),
    v1Order('', '1.00'),
    v1Order('e', '12,34.00'),
  ];
  withStore({ schema: 1, files: { 'records/customers.ndjson': '', 'records/orders.ndjson': ndjson(orders) } }, (dir) => {
    api.migrate(dir, { to: 2 });
    assert.deepEqual(lines(read(dir, 'quarantine/orders.ndjson')).map((e) => [e.record.id, e.reason]), [['a', 'bad total'], ['b', 'bad weight'], ['c', 'bad items'], ['d', 'bad item price'], ['', 'missing id'], ['e', 'bad total']]);
  });
});

function v2Store(customers, orders = []) {
  return { schema: 2, files: { 'records/customers.ndjson': ndjson(customers), 'records/orders.ndjson': ndjson(orders) } };
}
const v2c = (id, more = {}) => ({ id, full_name: 'A B', email: `${id}@x.io`, created: '2024-01-01', tier: 'basic', ...more });

test('hidden MIGRATIONS v2->v3: full_name splits at the last space after collapsing whitespace', () => {
  const names = ['Ada Lovelace', '  Grace   Brewster  Hopper ', 'Plato', '', null, 'Zoë\tÜnal'];
  const customers = names.map((n, i) => v2c(`c${i}`, { full_name: n }));
  customers.push({ id: 'none', email: 'none@x.io', created: '2024-01-01', tier: 'basic' });
  withStore(v2Store(customers), (dir) => {
    api.migrate(dir, { to: 3 });
    assert.deepEqual(lines(read(dir, 'records/customers.ndjson')).map((c) => [c.first_name, c.last_name, 'full_name' in c]), [
      ['Ada', 'Lovelace', false],
      ['Grace Brewster', 'Hopper', false],
      ['Plato', '', false],
      ['', '', false],
      ['', '', false],
      ['Zoë', 'Ünal', false],
      ['', '', false],
    ]);
  });
});

test('hidden MIGRATIONS v2->v3: phones become +1 and ten digits, empty phones go away, others are quarantined', () => {
  const phones = ['(555) 123-4567', '1 555 123 4567', '+1-555-123-4567', '', null, '555-1234', '2 555 123 4567', 5551234567];
  const customers = phones.map((p, i) => v2c(`c${i}`, { phone: p }));
  withStore(v2Store(customers), (dir) => {
    api.migrate(dir, { to: 3 });
    assert.deepEqual(lines(read(dir, 'records/customers.ndjson')).map((c) => [c.id, c.phone]), [['c0', '+15551234567'], ['c1', '+15551234567'], ['c2', '+15551234567'], ['c3', undefined], ['c4', undefined]]);
    assert.deepEqual(lines(read(dir, 'quarantine/customers.ndjson')).map((e) => [e.record.id, e.reason, e.step]), [['c5', 'bad phone', 'v2->v3'], ['c6', 'bad phone', 'v2->v3'], ['c7', 'bad phone', 'v2->v3']]);
    assert.ok(!lines(read(dir, 'records/customers.ndjson'))[3].hasOwnProperty('phone'));
  });
});

test('hidden MIGRATIONS v2->v3: customers with the same email merge into the first, filling only absent keys', () => {
  const customers = [
    v2c('m1', { email: 'same@x.io', tier: '' }),
    v2c('solo'),
    v2c('m2', { email: 'same@x.io', tier: 'gold', phone: '5551112222', vip: true }),
    v2c('m3', { email: 'same@x.io', phone: '5553334444', vip: false, extra: 'x' }),
  ];
  withStore(v2Store(customers), (dir) => {
    api.migrate(dir, { to: 3 });
    const out = lines(read(dir, 'records/customers.ndjson'));
    assert.deepEqual(out.map((c) => c.id), ['m1', 'solo']);
    assert.deepEqual(out[0], { created: '2024-01-01', email: 'same@x.io', extra: 'x', first_name: 'A', id: 'm1', last_name: 'B', merged_ids: ['m2', 'm3'], phone: '+15551112222', tier: '', vip: true });
    assert.equal('merged_ids' in out[1], false);
  });
});

test('hidden MIGRATIONS v2->v3: orders of merged customers point to the survivor; unknown customers are quarantined', () => {
  const customers = [v2c('a', { email: 's@x.io' }), v2c('b', { email: 's@x.io' }), v2c('bad', { phone: '1' })];
  const orders = [
    { id: 'o1', customer: 'b', total_cents: 0, weight_g: 0, items: [] },
    { id: 'o2', customer: 'bad', total_cents: 0, weight_g: 0, items: [] },
    { id: 'o3', customer: 'nobody', total_cents: 0, weight_g: 0, items: [] },
    { id: 'o4', customer: 'a', total_cents: 0, weight_g: 0, items: [] },
  ];
  withStore(v2Store(customers, orders), (dir) => {
    api.migrate(dir, { to: 3 });
    assert.deepEqual(lines(read(dir, 'records/orders.ndjson')).map((o) => [o.id, o.customer, o.line_count]), [['o1', 'a', 0], ['o4', 'a', 0]]);
    assert.deepEqual(lines(read(dir, 'quarantine/orders.ndjson')).map((e) => [e.record.id, e.reason]), [['o2', 'unknown customer'], ['o3', 'unknown customer']]);
  });
});

test('hidden MIGRATIONS v2->v3: items become order_lines with <order>#<n> ids, in order of orders then items', () => {
  const orders = [
    { id: 'x', customer: 'a', total_cents: 5, weight_g: 0, items: [{ sku: 's1', qty: 1, price_cents: 2 }, { sku: 's2', qty: 1, price_cents: 3, id: 'own', order: 'own' }] },
    { id: 'y', customer: 'a', total_cents: 0, weight_g: 0, items: [] },
    { id: 'z', customer: 'a', total_cents: 4, weight_g: 0, items: [{ sku: 's3', qty: 2, price_cents: 2, colour: 'red' }] },
  ];
  withStore({ ...v2Store([v2c('a')], orders), files: { ...v2Store([v2c('a')], orders).files, 'records/order_lines.ndjson': '{"id":"old"}\n' } }, (dir) => {
    api.migrate(dir, { to: 3 });
    assert.equal(
      read(dir, 'records/order_lines.ndjson'),
      '{"id":"x#1","order":"x","price_cents":2,"qty":1,"sku":"s1"}\n{"id":"x#2","order":"x","price_cents":3,"qty":1,"sku":"s2"}\n{"colour":"red","id":"z#1","order":"z","price_cents":2,"qty":2,"sku":"s3"}\n',
    );
    assert.deepEqual(lines(read(dir, 'records/orders.ndjson')).map((o) => [o.id, o.line_count, 'items' in o]), [['x', 2, false], ['y', 0, false], ['z', 1, false]]);
  });
});

function v3Store(customers, orders, orderLines) {
  return { schema: 3, files: { 'records/customers.ndjson': ndjson(customers), 'records/orders.ndjson': ndjson(orders), 'records/order_lines.ndjson': ndjson(orderLines) } };
}

test('hidden MIGRATIONS v3->v4: created_at, marketing_opt_in default, bad date quarantined', () => {
  const customers = [
    { id: 'a', created: '2024-02-03', email: 'a@x' },
    { id: 'b', created: '2024-2-3', email: 'b@x' },
    { id: 'c', created: '2024-02-03', email: 'c@x', marketing_opt_in: true },
    { id: 'd', created: '2024-02-03', email: 'd@x', marketing_opt_in: null },
    { id: 'e', email: 'e@x' },
  ];
  withStore(v3Store(customers, [], []), (dir) => {
    api.migrate(dir, { to: 4 });
    assert.equal(
      read(dir, 'records/customers.ndjson'),
      '{"created_at":"2024-02-03T00:00:00Z","email":"a@x","id":"a","marketing_opt_in":false}\n{"created_at":"2024-02-03T00:00:00Z","email":"c@x","id":"c","marketing_opt_in":true}\n{"created_at":"2024-02-03T00:00:00Z","email":"d@x","id":"d","marketing_opt_in":false}\n',
    );
    assert.deepEqual(lines(read(dir, 'quarantine/customers.ndjson')).map((e) => [e.record.id, e.reason, e.step]), [['b', 'bad date', 'v3->v4'], ['e', 'bad date', 'v3->v4']]);
  });
});

test('hidden MIGRATIONS v3->v4: weight in kilograms, currency defaults to USD, line totals', () => {
  const orders = [
    { id: 'o', customer: 'a', total_cents: 700, weight_g: 1234, currency: 'EUR', line_count: 2 },
    { id: 'p', customer: 'a', total_cents: 0, weight_g: 5, line_count: 0 },
  ];
  const ls = [{ id: 'o#1', order: 'o', qty: 3, price_cents: 200, sku: 'a' }, { id: 'o#2', order: 'o', qty: 1, price_cents: 100, sku: 'b' }];
  withStore(v3Store([], orders, ls), (dir) => {
    api.migrate(dir, { to: 4 });
    assert.equal(
      read(dir, 'records/orders.ndjson'),
      '{"currency":"EUR","customer":"a","id":"o","line_count":2,"total_cents":700,"weight_kg":1.234}\n{"currency":"USD","customer":"a","id":"p","line_count":0,"total_cents":0,"weight_kg":0.005}\n',
    );
    assert.deepEqual(lines(read(dir, 'records/order_lines.ndjson')).map((l) => l.line_total_cents), [600, 100]);
  });
});

test('hidden MIGRATIONS v3->v4: a total that does not match its lines quarantines the order and all its lines', () => {
  const orders = [
    { id: 'ok', customer: 'a', total_cents: 300, weight_g: 1 },
    { id: 'off', customer: 'a', total_cents: 301, weight_g: 1 },
    { id: 'badline', customer: 'a', total_cents: 300, weight_g: 1 },
    { id: 'heavy', customer: 'a', total_cents: 100, weight_g: 'x' },
  ];
  const ls = [
    { id: 'ok#1', order: 'ok', qty: 1, price_cents: 300 },
    { id: 'off#1', order: 'off', qty: 1, price_cents: 300 },
    { id: 'badline#1', order: 'badline', qty: 1.5, price_cents: 100 },
    { id: 'badline#2', order: 'badline', qty: 1, price_cents: 150 },
    { id: 'heavy#1', order: 'heavy', qty: 1, price_cents: 100 },
    { id: 'orphan#1', order: 'gone', qty: 1, price_cents: 1 },
    { id: 'ok#1', order: 'ok', qty: 9, price_cents: 9 },
  ];
  withStore(v3Store([], orders, ls), (dir) => {
    api.migrate(dir, { to: 4 });
    assert.deepEqual(lines(read(dir, 'records/orders.ndjson')).map((o) => o.id), ['ok']);
    assert.deepEqual(lines(read(dir, 'records/order_lines.ndjson')).map((l) => l.id), ['ok#1']);
    assert.deepEqual(lines(read(dir, 'quarantine/orders.ndjson')).map((e) => [e.record.id, e.reason]), [['off', 'total mismatch'], ['badline', 'total mismatch'], ['heavy', 'bad weight']]);
    assert.deepEqual(lines(read(dir, 'quarantine/order_lines.ndjson')).map((e) => [e.record.id, e.reason]), [
      ['badline#1', 'bad line'],
      ['ok#1', 'duplicate id'],
      ['off#1', 'order quarantined'],
      ['badline#2', 'order quarantined'],
      ['heavy#1', 'order quarantined'],
      ['orphan#1', 'order quarantined'],
    ]);
    assert.equal('line_total_cents' in lines(read(dir, 'quarantine/order_lines.ndjson'))[2].record, false);
  });
});

test('hidden MIGRATIONS: quarantine entries are added after the ones already in the file', () => {
  withStore({ schema: 2, files: { 'records/customers.ndjson': ndjson([v2c('a', { phone: 'x' })]), 'quarantine/customers.ndjson': '{"old":true}\n' } }, (dir) => {
    api.migrate(dir, { to: 3 });
    assert.equal(read(dir, 'quarantine/customers.ndjson').split('\n')[0], '{"old":true}');
    assert.equal(lines(read(dir, 'quarantine/customers.ndjson')).length, 2);
    assert.equal(read(dir, 'records/orders.ndjson'), '');
  });
});
