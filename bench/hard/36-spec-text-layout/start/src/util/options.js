import { fail } from './errors.js';
import { isInteger } from './strings.js';

const ALIGNS = ['left', 'right', 'center', 'decimal'];
const HEADER_ALIGNS = ['left', 'right', 'center'];
const OVERFLOWS = ['wrap', 'truncate'];
const VALIGNS = ['top', 'middle', 'bottom'];
const STYLE_NAMES = ['ascii', 'none'];

function oneOf(value, allowed, what) {
  if (value !== undefined && !allowed.includes(value)) fail(`${what} must be one of ${allowed.join(', ')}`);
}

function optionalInteger(value, what, min = 1) {
  if (value !== undefined && !isInteger(value, min)) fail(`${what} must be an integer of at least ${min}`);
}

/** Checks one column and returns it with its defaults filled in (R16, R18). */
export function normalizeColumn(column, index) {
  if (column === null || typeof column !== 'object' || Array.isArray(column)) fail(`column ${index} must be an object`);
  const what = `column ${index}`;
  const kinds = ['width', 'percent', 'flex'].filter((k) => column[k] !== undefined);
  if (kinds.length > 1) fail(`${what} has more than one of width, percent, flex`);
  optionalInteger(column.width, `${what}: width`);
  optionalInteger(column.flex, `${what}: flex`);
  optionalInteger(column.min, `${what}: min`);
  optionalInteger(column.max, `${what}: max`);
  optionalInteger(column.maxLines, `${what}: maxLines`);
  if (column.percent !== undefined && !(Number.isInteger(column.percent) && column.percent >= 1 && column.percent <= 100)) {
    fail(`${what}: percent must be an integer from 1 to 100`);
  }
  if (column.min !== undefined && column.max !== undefined && column.min > column.max) fail(`${what}: min is greater than max`);
  if (column.header !== undefined && typeof column.header !== 'string' && typeof column.header !== 'number') fail(`${what}: header must be a string`);
  oneOf(column.align, ALIGNS, `${what}: align`);
  oneOf(column.headerAlign, HEADER_ALIGNS, `${what}: headerAlign`);
  oneOf(column.overflow, OVERFLOWS, `${what}: overflow`);
  oneOf(column.valign, VALIGNS, `${what}: valign`);
  return {
    header: column.header === undefined ? undefined : String(column.header),
    kind: kinds[0] === 'width' ? 'fixed' : kinds[0] ?? 'auto',
    width: column.width,
    percent: column.percent,
    flex: column.flex,
    min: column.min ?? 1,
    max: column.max,
    align: column.align ?? 'left',
    headerAlign: column.headerAlign,
    overflow: column.overflow ?? 'wrap',
    maxLines: column.maxLines,
    valign: column.valign ?? 'top',
  };
}

/** Checks a whole table description and fills in the defaults. */
export function normalizeSpec(spec) {
  if (spec === null || typeof spec !== 'object') fail('the table must be an object');
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) fail('columns must be a non-empty array');
  const columns = spec.columns.map(normalizeColumn);
  let percentTotal = 0;
  for (const c of columns) percentTotal += c.percent ?? 0;
  if (percentTotal > 100) fail('percent columns add up to more than 100');
  const rows = spec.rows ?? [];
  if (!Array.isArray(rows)) fail('rows must be an array');
  for (const [i, row] of rows.entries()) if (!Array.isArray(row)) fail(`row ${i} must be an array`);
  optionalInteger(spec.width, 'width');
  optionalInteger(spec.pageHeight, 'pageHeight');
  oneOf(spec.style, STYLE_NAMES, 'style');
  if (spec.ellipsis !== undefined && typeof spec.ellipsis !== 'string') fail('ellipsis must be a string');
  if (spec.title !== undefined && typeof spec.title !== 'string') fail('title must be a string');
  if (spec.repeatHeader !== undefined && typeof spec.repeatHeader !== 'boolean') fail('repeatHeader must be true or false');
  if (spec.rowRules !== undefined && typeof spec.rowRules !== 'boolean') fail('rowRules must be true or false');
  return {
    columns,
    rows,
    width: spec.width,
    style: spec.style ?? 'ascii',
    ellipsis: spec.ellipsis ?? '…',
    pageHeight: spec.pageHeight,
    repeatHeader: spec.repeatHeader ?? true,
    rowRules: spec.rowRules ?? false,
    title: spec.title,
  };
}
