#!/usr/bin/env node
// Writes a synthetic schema-1 store, for trying the migration on more data than the example has.
//
//   node tools/make-store.js <folder> [--customers N] [--orders N] [--seed S]
//
// The data is the same for the same seed. About one record in twenty is broken on purpose (bad emails,
// duplicate ids, bad totals, odd phones, shared emails), so every quarantine reason shows up.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function option(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
}

export function makeStore(dir, { customers = 200, orders = 1000, seed = 1 } = {}) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const firsts = ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald', 'Frances', 'Ken', 'Zoë', 'Émile'];
  const lasts = ['Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Knuth', 'Allen', 'Thompson', 'Ünal', 'Zola'];
  const cs = [];
  for (let i = 1; i <= customers; i++) {
    const first = pick(firsts);
    const last = pick(lasts);
    const c = { id: `c${i}`, name: `${first} ${last}`, email: `${first}.${last}${i}@example.com`, created: `2024-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}` };
    const roll = r();
    if (roll < 0.3) c.phone = `(555) ${100 + Math.floor(r() * 900)}-${1000 + Math.floor(r() * 9000)}`;
    else if (roll < 0.33) c.phone = '555-01';
    if (r() < 0.2) c.tier = pick(['gold', 'silver', '']);
    if (r() < 0.03) c.email = 'broken';
    if (r() < 0.03 && i > 1) c.email = cs[Math.floor(r() * cs.length)].email.toUpperCase();
    if (r() < 0.02 && i > 1) c.id = `c${i - 1}`;
    if (r() < 0.01) c.created = 'yesterday';
    cs.push(c);
  }
  const os = [];
  for (let i = 1; i <= orders; i++) {
    const items = [];
    let cents = 0;
    for (let n = Math.floor(r() * 4); n > 0; n--) {
      const price = 50 + Math.floor(r() * 5000);
      const qty = 1 + Math.floor(r() * 3);
      cents += price * qty;
      items.push({ sku: `sku-${Math.floor(r() * 50)}`, qty, price: `${Math.floor(price / 100)}.${String(price % 100).padStart(2, '0')}` });
    }
    if (r() < 0.02) cents += 1;
    const dollars = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    const o = { id: `o${i}`, customer: `c${1 + Math.floor(r() * (customers + 5))}`, total: r() < 0.01 ? `${dollars}0` : dollars, weight_lb: Math.round(r() * 400) / 10, status: pick(['new', 'paid', 'shipped']), items };
    if (r() < 0.1) o.currency = 'EUR';
    os.push(o);
  }
  mkdirSync(join(dir, 'records'), { recursive: true });
  writeFileSync(join(dir, 'store.json'), '{"schema":1}\n');
  writeFileSync(join(dir, 'records', 'customers.ndjson'), cs.map((c) => `${JSON.stringify(c)}\n`).join(''));
  writeFileSync(join(dir, 'records', 'orders.ndjson'), os.map((o) => `${JSON.stringify(o)}\n`).join(''));
  return { customers: cs.length, orders: os.length };
}

if (process.argv[1] && process.argv[1].endsWith('make-store.js')) {
  const [dir] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
  if (!dir) {
    process.stderr.write('usage: node tools/make-store.js <folder> [--customers N] [--orders N] [--seed S]\n');
    process.exitCode = 2;
  } else {
    const argv = process.argv.slice(2);
    const made = makeStore(dir, { customers: option(argv, 'customers', 200), orders: option(argv, 'orders', 1000), seed: option(argv, 'seed', 1) });
    process.stdout.write(`wrote ${made.customers} customers and ${made.orders} orders to ${dir}\n`);
  }
}
