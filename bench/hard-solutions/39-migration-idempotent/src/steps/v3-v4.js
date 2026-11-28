// Schema 3 -> 4 (docs/MIGRATIONS.md, "v3 -> v4").
import { StepResult } from '../migrate/quarantine.js';
import { migrateCollection } from './common/collection.js';

export const name = 'v3->v4';
export const from = 3;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function customer(record) {
  if (typeof record.created !== 'string' || !DATE.test(record.created)) return { reason: 'bad date' };
  const { created, ...rest } = record;
  const out = { ...rest, created_at: `${created}T00:00:00Z` };
  if (out.marketing_opt_in === undefined || out.marketing_opt_in === null) out.marketing_opt_in = false;
  return { record: out };
}

function line(record) {
  if (!Number.isInteger(record.qty) || record.qty < 0 || !Number.isInteger(record.price_cents)) return { reason: 'bad line' };
  return { record: { ...record, line_total_cents: record.qty * record.price_cents } };
}

export function run(collections) {
  const result = new StepResult(name);
  result.keep('customers', migrateCollection(collections.customers, 'customers', customer, result).map((k) => k.record));

  const keptLines = migrateCollection(collections.order_lines, 'order_lines', line, result);
  const sums = new Map();
  for (const { record } of keptLines) sums.set(record.order, (sums.get(record.order) ?? 0) + record.line_total_cents);

  const order = (record) => {
    if (typeof record.weight_g !== 'number' || !Number.isFinite(record.weight_g)) return { reason: 'bad weight' };
    if (record.total_cents !== (sums.get(record.id) ?? 0)) return { reason: 'total mismatch' };
    const { weight_g: grams, ...rest } = record;
    const out = { ...rest, weight_kg: grams / 1000 };
    if (out.currency === undefined || out.currency === null) out.currency = 'USD';
    return { record: out };
  };
  const orders = migrateCollection(collections.orders, 'orders', order, result).map((k) => k.record);
  result.keep('orders', orders);

  const orderIds = new Set(orders.map((o) => o.id));
  const lines = [];
  for (const { record, original } of keptLines) {
    if (orderIds.has(record.order)) lines.push(record);
    else result.reject('order_lines', 'order quarantined', original);
  }
  result.keep('order_lines', lines);
  return result;
}
