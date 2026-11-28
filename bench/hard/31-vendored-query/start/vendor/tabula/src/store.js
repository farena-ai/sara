import { fail, TabulaError } from './errors.js';
import { Query } from './query.js';
import { checkKey, checkRow, compileSchema } from './schema.js';
import { Transaction } from './transaction.js';

export const INTERNAL = Symbol('tabula.internal');

/** The next int key for a table: one more than the largest key in `rows` (1 for an empty table). */
export function nextKey(rows) {
  let max = 0;
  for (const k of rows.keys()) if (k > max) max = k;
  return max + 1;
}

/** Finds a duplicate unique value among `rows` (a Map key -> {row}); returns a message or null. */
export function findUniqueClash(schema, rows) {
  for (const col of schema.unique) {
    const seen = new Map();
    for (const [k, { row }] of rows) {
      const v = row[col];
      if (v === null) continue;
      if (seen.has(v)) return `table "${schema.name}": duplicate ${col} ${JSON.stringify(v)} (keys ${JSON.stringify(seen.get(v))} and ${JSON.stringify(k)})`;
      seen.set(v, k);
    }
  }
  return null;
}

/**
 * Applies a list of operations to copies of the tables they touch. Returns
 * { error } or { tables, counts } without changing anything it was given.
 * `base` is the table map the operations were planned against (for stale checks), or null.
 */
export function applyOps(tables, ops, base, version) {
  const copies = new Map();
  const counts = { inserted: 0, patched: 0, removed: 0 };
  const copyOf = (name) => {
    if (!copies.has(name)) copies.set(name, { schema: tables.get(name).schema, rows: new Map(tables.get(name).rows) });
    return copies.get(name);
  };
  for (const op of ops) {
    const t = copyOf(op.table);
    const current = t.rows.get(op.key);
    if (op.type === 'insert') {
      if (current) return { error: new TabulaError('conflict', `table "${op.table}": key ${JSON.stringify(op.key)} already exists`) };
      t.rows.set(op.key, { row: Object.freeze({ ...op.row }), ver: version });
      counts.inserted++;
      continue;
    }
    if (!current) return { error: new TabulaError('missing', `table "${op.table}": key ${JSON.stringify(op.key)} no longer exists`) };
    const seen = base?.get(op.table)?.rows.get(op.key);
    if (base && op.planned && (!seen || seen.ver !== current.ver)) {
      return { error: new TabulaError('stale', `table "${op.table}": key ${JSON.stringify(op.key)} was changed by another commit`) };
    }
    if (op.type === 'patch') {
      t.rows.set(op.key, { row: Object.freeze({ ...current.row, ...op.changes }), ver: version });
      counts.patched++;
    } else {
      t.rows.delete(op.key);
      counts.removed++;
    }
  }
  for (const t of copies.values()) {
    const clash = findUniqueClash(t.schema, t.rows);
    if (clash) return { error: new TabulaError('conflict', clash) };
  }
  const next = new Map(tables);
  for (const [name, t] of copies) next.set(name, t);
  return { tables: next, counts };
}

export class Store {
  #tables = new Map();
  #version = 0;

  constructor() {
    Object.defineProperty(this, INTERNAL, {
      value: {
        tables: () => this.#tables,
        version: () => this.#version,
        install: (tables) => {
          this.#tables = tables;
          this.#version++;
        },
      },
    });
  }

  /** Number of successful commits and loads so far. */
  get version() {
    return this.#version;
  }

  #table(name) {
    const t = this.#tables.get(name);
    if (!t) fail('unknown-table', `no table "${name}"`);
    return t;
  }

  define(name, definition) {
    if (this.#tables.has(name)) fail('bad-definition', `table "${name}" is already defined`);
    const schema = compileSchema(name, definition);
    const next = new Map(this.#tables);
    next.set(name, { schema, rows: new Map() });
    this.#tables = next;
    return this;
  }

  tables() {
    return [...this.#tables.keys()];
  }

  /** Bulk insert outside a transaction, all or nothing. Throws on any problem. Returns the keys. */
  load(name, rows) {
    const { schema, rows: existing } = this.#table(name);
    if (!Array.isArray(rows)) fail('schema', 'load() needs an array of rows');
    let next = schema.autoKey ? nextKey(existing) : 0;
    const keys = [];
    const ops = rows.map((r) => {
      const row = checkRow(schema, r, { withoutKey: schema.autoKey });
      if (row[schema.key] === undefined) row[schema.key] = next++;
      else if (schema.autoKey && row[schema.key] >= next) next = row[schema.key] + 1;
      keys.push(row[schema.key]);
      return { type: 'insert', table: name, key: row[schema.key], row };
    });
    const result = applyOps(this.#tables, ops, null, this.#version + 1);
    if (result.error) throw result.error;
    this.#tables = result.tables;
    this.#version++;
    return keys;
  }

  from(name) {
    const t = this.#table(name);
    return new Query(() => [...this.#tables.get(name).rows.values()].map((e) => e.row), t.schema);
  }

  lookup(name, key) {
    const t = this.#table(name);
    if (!checkKey(t.schema, key)) return null;
    const e = t.rows.get(key);
    return e ? Object.freeze({ ...e.row }) : null;
  }

  begin() {
    return new Transaction(this);
  }
}
