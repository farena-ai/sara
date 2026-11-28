import { fail } from './errors.js';
import { checkColumn } from './schema.js';

// Each operator: how many values it takes ('one', 'list', 'pair', 'none') and the test.
// A null column value only ever matches 'null' and 'ne'/'nin' (see docs/API.md, "Nulls").
const OPS = {
  eq: ['one', (a, b) => a !== null && a === b],
  ne: ['one', (a, b) => a !== b],
  lt: ['one', (a, b) => a !== null && a < b],
  le: ['one', (a, b) => a !== null && a <= b],
  gt: ['one', (a, b) => a !== null && a > b],
  ge: ['one', (a, b) => a !== null && a >= b],
  in: ['list', (a, list) => a !== null && list.includes(a)],
  nin: ['list', (a, list) => !list.includes(a)],
  between: ['pair', (a, [lo, hi]) => a !== null && a >= lo && a < hi],
  has: ['one', (a, s) => typeof a === 'string' && a.includes(s)],
  ihas: ['one', (a, s) => typeof a === 'string' && a.toLowerCase().includes(s.toLowerCase())],
  null: ['none', (a) => a === null],
  notnull: ['none', (a) => a !== null],
};

export const OPERATORS = Object.freeze(Object.keys(OPS));

/** Builds a row predicate for (column, op, value); `given` is how many arguments were passed. */
export function compileFilter(schema, column, op, value, given) {
  checkColumn(schema, column);
  if (!Object.hasOwn(OPS, op)) fail('bad-op', `unknown operator ${JSON.stringify(op)}; operators are ${OPERATORS.join(', ')}`);
  const [shape, test] = OPS[op];
  if (shape === 'none') {
    if (given > 2) fail('bad-op', `operator "${op}" takes no value`);
  } else if (given < 3 || value === undefined) {
    fail('bad-op', `operator "${op}" needs a value`);
  } else if (shape === 'list' && !Array.isArray(value)) {
    fail('bad-op', `operator "${op}" needs an array of values`);
  } else if (shape === 'pair' && !(Array.isArray(value) && value.length === 2)) {
    fail('bad-op', `operator "${op}" needs [low, high]`);
  } else if ((op === 'has' || op === 'ihas') && typeof value !== 'string') {
    fail('bad-op', `operator "${op}" needs a string`);
  }
  const frozen = Array.isArray(value) ? [...value] : value;
  return (row) => test(row[column], frozen);
}
