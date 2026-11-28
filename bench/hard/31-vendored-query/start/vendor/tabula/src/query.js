import { fail } from './errors.js';
import { compileFilter } from './ops.js';
import { checkColumn } from './schema.js';

/** Orders two column values: null first, then false < true, numbers and strings by < and >. */
export function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseOrder(schema, spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  if (!list.length) fail('bad-order', 'orderBy() needs at least one field');
  return list.map((s) => {
    if (typeof s !== 'string' || !s || s === '-') fail('bad-order', `bad order field ${JSON.stringify(s)}`);
    const desc = s.startsWith('-');
    const field = desc ? s.slice(1) : s;
    checkColumn(schema, field);
    return { field, desc };
  });
}

/**
 * A query over one table. Queries are values: every method returns a NEW query and leaves the one
 * it was called on as it was, so a base query can be shared and narrowed in different ways.
 */
export class Query {
  #source;
  #schema;
  #filters;
  #order;
  #page;
  #fields;

  /** @internal Use store.from(name) or tx.from(name). */
  constructor(source, schema, state = {}) {
    this.#source = source;
    this.#schema = schema;
    this.#filters = state.filters ?? [];
    this.#order = state.order ?? [];
    this.#page = state.page ?? null;
    this.#fields = state.fields ?? null;
    Object.freeze(this);
  }

  #with(patch) {
    return new Query(this.#source, this.#schema, {
      filters: this.#filters,
      order: this.#order,
      page: this.#page,
      fields: this.#fields,
      ...patch,
    });
  }

  get table() {
    return this.#schema.name;
  }

  where(column, op, value) {
    const test = compileFilter(this.#schema, column, op, value, arguments.length);
    return this.#with({ filters: [...this.#filters, test] });
  }

  whereAny(conditions) {
    if (!Array.isArray(conditions) || !conditions.length) fail('bad-op', 'whereAny() needs a non-empty array of [column, op, value] conditions');
    const tests = conditions.map((c) => {
      if (!Array.isArray(c)) fail('bad-op', 'each whereAny() condition must be an array [column, op, value]');
      return compileFilter(this.#schema, c[0], c[1], c[2], c.length);
    });
    return this.#with({ filters: [...this.#filters, (row) => tests.some((t) => t(row))] });
  }

  orderBy(spec) {
    if (arguments.length !== 1) fail('bad-order', 'orderBy() takes exactly one argument: "field", "-field" or an array of them');
    return this.#with({ order: parseOrder(this.#schema, spec) });
  }

  page(index, size) {
    if (!Number.isInteger(index) || index < 0) fail('bad-page', `page index must be an integer >= 0, got ${JSON.stringify(index)}`);
    if (!Number.isInteger(size) || size < 1) fail('bad-page', `page size must be an integer >= 1, got ${JSON.stringify(size)}`);
    return this.#with({ page: { index, size } });
  }

  select(fields) {
    if (!Array.isArray(fields) || !fields.length) fail('unknown-column', 'select() needs a non-empty array of column names');
    for (const f of fields) checkColumn(this.#schema, f);
    return this.#with({ fields: [...fields] });
  }

  #matching() {
    const key = this.#schema.key;
    const rows = this.#source().filter((row) => this.#filters.every((t) => t(row)));
    const order = this.#order;
    rows.sort((a, b) => {
      for (const { field, desc } of order) {
        const c = compareValues(a[field], b[field]);
        if (c) return desc ? -c : c;
      }
      return compareValues(a[key], b[key]);
    });
    return rows;
  }

  #shape(row) {
    if (!this.#fields) return Object.freeze({ ...row });
    const out = {};
    for (const f of this.#fields) out[f] = row[f];
    return Object.freeze(out);
  }

  run() {
    const all = this.#matching();
    const p = this.#page;
    const rows = p ? all.slice(p.index * p.size, p.index * p.size + p.size) : all;
    return Object.freeze({
      rows: Object.freeze(rows.map((r) => this.#shape(r))),
      matched: all.length,
      index: p ? p.index : null,
      size: p ? p.size : null,
    });
  }

  first() {
    const [row] = this.#matching();
    return row ? this.#shape(row) : null;
  }

  count() {
    return this.#matching().length;
  }

  sum(column) {
    const { type } = checkColumn(this.#schema, column);
    if (type !== 'int' && type !== 'num') fail('unknown-column', `sum() needs a number column; "${column}" is ${type}`);
    let total = 0;
    for (const row of this.#matching()) if (row[column] !== null) total += row[column];
    return total;
  }

  group(column, sumColumn) {
    checkColumn(this.#schema, column);
    if (sumColumn !== undefined) {
      const { type } = checkColumn(this.#schema, sumColumn);
      if (type !== 'int' && type !== 'num') fail('unknown-column', `group() can only sum a number column; "${sumColumn}" is ${type}`);
    }
    const groups = new Map();
    for (const row of this.#matching()) {
      const k = row[column];
      const g = groups.get(k) ?? { key: k, count: 0, sum: 0 };
      g.count++;
      if (sumColumn !== undefined && row[sumColumn] !== null) g.sum += row[sumColumn];
      groups.set(k, g);
    }
    return Object.freeze(
      [...groups.values()]
        .sort((a, b) => compareValues(a.key, b.key))
        .map((g) => Object.freeze(sumColumn === undefined ? { key: g.key, count: g.count } : g)),
    );
  }
}
