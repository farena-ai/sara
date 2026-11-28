import { fail } from './errors.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDate(v) {
  if (typeof v !== 'string') return false;
  const m = DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

export const TYPES = {
  int: (v) => Number.isInteger(v),
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  text: (v) => typeof v === 'string',
  bool: (v) => typeof v === 'boolean',
  date: isDate,
};

/** Turns a define() definition into the internal schema. */
export function compileSchema(name, def) {
  if (typeof name !== 'string' || !name) fail('bad-definition', 'table name must be a non-empty string');
  if (!def || typeof def !== 'object') fail('bad-definition', `table "${name}": definition must be an object`);
  const { key, columns, unique = [] } = def;
  for (const k of Object.keys(def)) {
    if (!['key', 'columns', 'unique'].includes(k)) fail('bad-definition', `table "${name}": unknown definition field "${k}"`);
  }
  if (!columns || typeof columns !== 'object' || !Object.keys(columns).length) fail('bad-definition', `table "${name}": columns must be a non-empty object`);
  const cols = new Map();
  for (const [col, spec] of Object.entries(columns)) {
    if (typeof spec !== 'string') fail('bad-definition', `table "${name}": column "${col}" type must be a string`);
    const nullable = spec.endsWith('?');
    const type = nullable ? spec.slice(0, -1) : spec;
    if (!TYPES[type]) fail('bad-definition', `table "${name}": column "${col}" has unknown type "${spec}"`);
    cols.set(col, { type, nullable });
  }
  if (!cols.has(key)) fail('bad-definition', `table "${name}": key "${key}" is not one of its columns`);
  const keyCol = cols.get(key);
  if (keyCol.nullable || !['int', 'text'].includes(keyCol.type)) fail('bad-definition', `table "${name}": key column must be "int" or "text" and not nullable`);
  if (!Array.isArray(unique)) fail('bad-definition', `table "${name}": unique must be an array of column names`);
  for (const u of unique) if (!cols.has(u)) fail('bad-definition', `table "${name}": unique column "${u}" does not exist`);
  return Object.freeze({ name, key, columns: cols, unique: [...unique], autoKey: keyCol.type === 'int' });
}

export function checkColumn(schema, column) {
  if (!schema.columns.has(column)) fail('unknown-column', `table "${schema.name}" has no column "${column}"`);
  return schema.columns.get(column);
}

function checkValue(schema, col, value) {
  const { type, nullable } = schema.columns.get(col);
  if (value === null) {
    if (!nullable) fail('schema', `table "${schema.name}": column "${col}" may not be null`);
    return;
  }
  if (!TYPES[type](value)) fail('schema', `table "${schema.name}": column "${col}" must be ${type}, got ${JSON.stringify(value)}`);
}

/**
 * Checks a whole row and returns a new object with every column present (nullable columns that
 * were left out become null). The key may be left out when it is an int key (`withoutKey`).
 */
export function checkRow(schema, row, { withoutKey = false } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('schema', `table "${schema.name}": a row must be an object`);
  for (const k of Object.keys(row)) if (!schema.columns.has(k)) fail('schema', `table "${schema.name}" has no column "${k}"`);
  const out = {};
  for (const [col, { nullable }] of schema.columns) {
    if (col === schema.key && withoutKey && row[col] === undefined) continue;
    let v = row[col];
    if (v === undefined) {
      if (!nullable) fail('schema', `table "${schema.name}": column "${col}" is required`);
      v = null;
    }
    checkValue(schema, col, v);
    out[col] = v;
  }
  return out;
}

/** Checks a patch (some columns, never the key) and returns a copy. */
export function checkChanges(schema, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) fail('schema', `table "${schema.name}": changes must be an object`);
  const out = {};
  for (const [col, v] of Object.entries(changes)) {
    if (!schema.columns.has(col)) fail('schema', `table "${schema.name}" has no column "${col}"`);
    if (col === schema.key) fail('schema', `table "${schema.name}": the key column "${col}" cannot be changed`);
    if (v === undefined) fail('schema', `table "${schema.name}": column "${col}" cannot be set to undefined (use null)`);
    checkValue(schema, col, v);
    out[col] = v;
  }
  return out;
}

export function checkKey(schema, key) {
  const { type } = schema.columns.get(schema.key);
  return TYPES[type](key);
}
