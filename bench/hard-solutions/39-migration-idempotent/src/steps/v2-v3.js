// Schema 2 -> 3 (docs/MIGRATIONS.md, "v2 -> v3").
import { StepResult } from '../migrate/quarantine.js';
import { migrateCollection } from './common/collection.js';

export const name = 'v2->v3';
export const from = 2;

export function splitName(fullName) {
  if (typeof fullName !== 'string') return { first_name: '', last_name: '' };
  const clean = fullName.trim().split(/\s+/).filter(Boolean).join(' ');
  const at = clean.lastIndexOf(' ');
  if (at === -1) return { first_name: clean, last_name: '' };
  return { first_name: clean.slice(0, at), last_name: clean.slice(at + 1) };
}

export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function customer(record) {
  const { full_name: fullName, phone, ...rest } = record;
  const out = { ...rest, ...splitName(fullName) };
  if (phone !== undefined && phone !== null && phone !== '') {
    const normal = normalizePhone(phone);
    if (normal === null) return { reason: 'bad phone' };
    out.phone = normal;
  }
  return { record: out };
}

/** Customers with the same email become one: the first in file order, with what it lacks from the others. */
function mergeByEmail(customers) {
  const byEmail = new Map();
  const survivors = [];
  const mergedInto = new Map();
  for (const c of customers) {
    const first = byEmail.get(c.email);
    if (!first) {
      byEmail.set(c.email, { survivor: c, others: [] });
      survivors.push(c);
      continue;
    }
    first.others.push(c);
    mergedInto.set(c.id, first.survivor.id);
  }
  for (const { survivor, others } of byEmail.values()) {
    if (others.length === 0) continue;
    for (const other of others) {
      for (const [key, value] of Object.entries(other)) if (!(key in survivor)) survivor[key] = value;
    }
    survivor.merged_ids = others.map((o) => o.id);
  }
  return { survivors, mergedInto };
}

export function run(collections) {
  const result = new StepResult(name);
  const kept = migrateCollection(collections.customers, 'customers', customer, result).map((k) => k.record);
  const { survivors, mergedInto } = mergeByEmail(kept);
  result.keep('customers', survivors);
  const known = new Set(survivors.map((c) => c.id));

  const order = (record) => {
    const customerId = mergedInto.get(record.customer) ?? record.customer;
    if (!known.has(customerId)) return { reason: 'unknown customer' };
    if (!Array.isArray(record.items)) return { reason: 'bad items' };
    const { items, ...rest } = record;
    return { record: { ...rest, customer: customerId, line_count: items.length, items } };
  };
  const orders = migrateCollection(collections.orders, 'orders', order, result).map((k) => k.record);
  const lines = [];
  for (const o of orders) {
    o.items.forEach((item, i) => lines.push({ ...item, id: `${o.id}#${i + 1}`, order: o.id }));
    delete o.items;
  }
  result.keep('orders', orders);
  result.keep('order_lines', lines);
  return result;
}
