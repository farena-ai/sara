// Schema 1 -> 2 (docs/MIGRATIONS.md, "v1 -> v2").
import { StepResult, objectsOf } from '../migrate/quarantine.js';
import { normalizeEmail } from './common/email.js';
import { dedupeById, hasId } from './common/ids.js';
import { toCents } from './common/money.js';
import { poundsToGrams } from './common/units.js';

export const name = 'v1->v2';
export const from = 1;

function customer(record) {
  if (!hasId(record)) return { reason: 'missing id' };
  const email = normalizeEmail(record.email);
  if (email === null) return { reason: 'bad email' };
  const { name: fullName, ...rest } = record;
  const out = { ...rest, email };
  if (fullName !== undefined) out.full_name = fullName;
  if (out.tier === undefined || out.tier === null) out.tier = 'basic';
  return { record: out };
}

function order(record) {
  if (!hasId(record)) return { reason: 'missing id' };
  const totalCents = toCents(record.total);
  if (totalCents === null) return { reason: 'bad total' };
  const weightG = poundsToGrams(record.weight_lb);
  if (weightG === null) return { reason: 'bad weight' };
  if (!Array.isArray(record.items)) return { reason: 'bad items' };
  const items = [];
  for (const item of record.items) {
    const priceCents = item && typeof item === 'object' ? toCents(item.price) : null;
    if (priceCents === null) return { reason: 'bad item price' };
    const { price, ...rest } = item;
    items.push({ ...rest, price_cents: priceCents });
  }
  const { total, weight_lb: lb, ...rest } = record;
  return { record: { ...rest, items, total_cents: totalCents, weight_g: weightG } };
}

function migrateCollection(lines, collection, convert, result) {
  const passed = [];
  for (const record of objectsOf(lines, collection, result)) {
    const out = convert(record);
    if (out.reason) result.reject(collection, out.reason, record);
    else passed.push({ record: out.record, original: record });
  }
  const { kept, duplicates } = dedupeById(passed);
  for (const d of duplicates) result.reject(collection, 'duplicate id', d.original);
  result.keep(collection, kept.map((k) => k.record));
}

export function run(collections) {
  const result = new StepResult(name);
  migrateCollection(collections.customers, 'customers', customer, result);
  migrateCollection(collections.orders, 'orders', order, result);
  return result;
}
