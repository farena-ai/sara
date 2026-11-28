import { fail } from './errors.js';
import { Query } from './query.js';
import { checkChanges, checkKey, checkRow } from './schema.js';
import { applyOps, INTERNAL, nextKey } from './store.js';

/**
 * A transaction sees the store as it was when begin() was called, plus its own writes. Nothing it
 * does reaches the store until commit(); a transaction that is never committed simply has no
 * effect. Duplicate keys, duplicate unique values and rows changed by someone else are found by
 * commit(), which reports them in its return value instead of throwing.
 */
export class Transaction {
  #store;
  #snapshot;
  #ops = [];
  #closed = false;
  #views = new Map();

  constructor(store) {
    this.#store = store;
    this.#snapshot = store[INTERNAL].tables();
  }

  get open() {
    return !this.#closed;
  }

  #check() {
    if (this.#closed) fail('closed', 'this transaction was already committed or rolled back');
  }

  #schema(name) {
    const t = this.#snapshot.get(name);
    if (!t) fail('unknown-table', `no table "${name}"`);
    return t.schema;
  }

  /** The table as this transaction sees it: Map key -> row. */
  #view(name) {
    if (this.#views.has(name)) return this.#views.get(name);
    const rows = new Map();
    for (const [k, e] of this.#snapshot.get(name).rows) rows.set(k, e.row);
    for (const op of this.#ops) {
      if (op.table !== name) continue;
      if (op.type === 'insert') rows.set(op.key, Object.freeze({ ...op.row }));
      else if (op.type === 'patch') rows.set(op.key, Object.freeze({ ...rows.get(op.key), ...op.changes }));
      else rows.delete(op.key);
    }
    this.#views.set(name, rows);
    return rows;
  }

  #record(op) {
    this.#ops.push(op);
    this.#views.delete(op.table);
  }

  from(name) {
    this.#check();
    const schema = this.#schema(name);
    return new Query(() => {
      this.#check();
      return [...this.#view(name).values()];
    }, schema);
  }

  lookup(name, key) {
    this.#check();
    const schema = this.#schema(name);
    if (!checkKey(schema, key)) return null;
    const row = this.#view(name).get(key);
    return row ? Object.freeze({ ...row }) : null;
  }

  /** Adds a row; returns its key (assigned here when an int key is left out). */
  insert(name, row) {
    this.#check();
    const schema = this.#schema(name);
    const checked = checkRow(schema, row, { withoutKey: schema.autoKey });
    if (checked[schema.key] === undefined) checked[schema.key] = nextKey(this.#view(name));
    this.#record({ type: 'insert', table: name, key: checked[schema.key], row: checked });
    return checked[schema.key];
  }

  /** Changes some columns of one row. Returns false (and records nothing) when there is no such row. */
  patch(name, key, changes) {
    this.#check();
    const schema = this.#schema(name);
    const checked = checkChanges(schema, changes);
    if (!checkKey(schema, key) || !this.#view(name).has(key)) return false;
    this.#record({ type: 'patch', table: name, key, changes: checked, planned: this.#snapshot.get(name).rows.has(key) });
    return true;
  }

  /** Deletes one row. Returns false (and records nothing) when there is no such row. */
  remove(name, key) {
    this.#check();
    const schema = this.#schema(name);
    if (!checkKey(schema, key) || !this.#view(name).has(key)) return false;
    this.#record({ type: 'remove', table: name, key, planned: this.#snapshot.get(name).rows.has(key) });
    return true;
  }

  /**
   * Writes everything to the store at once, or nothing. Returns [null, counts] on success and
   * [error, null] when the store refused the changes. Either way the transaction is closed.
   */
  commit() {
    this.#check();
    this.#closed = true;
    const internal = this.#store[INTERNAL];
    if (!this.#ops.length) return [null, Object.freeze({ inserted: 0, patched: 0, removed: 0 })];
    const result = applyOps(internal.tables(), this.#ops, this.#snapshot, internal.version() + 1);
    if (result.error) return [result.error, null];
    internal.install(result.tables);
    return [null, Object.freeze(result.counts)];
  }

  rollback() {
    this.#check();
    this.#closed = true;
    this.#ops = [];
  }
}
