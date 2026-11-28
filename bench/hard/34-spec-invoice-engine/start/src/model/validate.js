// Checks an invoice document and turns it into the engine's internal form (SPEC rules 7 to 9,
// 11, 19, 22, 23, 25 and 27). Nothing here calculates money.
import { dayNumber } from '../dates/calendar.js';
import { fail } from '../errors.js';
import { currencyInfo } from '../money/currencies.js';
import { parseDecimal } from '../num/parse.js';
import { ZERO } from '../num/rational.js';
import { resolveTaxClass } from '../tax/classes.js';
import { checkTiers } from '../pricing/tiers.js';

const PRICE_MODES = ['exclusive', 'inclusive'];
const ROUNDING = ['line', 'document'];
const TAX_ROUNDING = ['half-up', 'half-even'];

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function setting(value, allowed, name, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) fail('INVALID_SETTING', `${name} must be one of ${allowed.join(', ')}`);
  return value;
}

export function readDiscount(d, field, digits) {
  if (!isObject(d)) fail('INVALID_DISCOUNT', `${field} must be an object`);
  if (d.type === 'percent') {
    return { type: 'percent', value: d.value, code: d.code ?? null, v: parseDecimal(d.value, `${field}.value`, { min: 0, max: 100, maxDecimals: 4 }) };
  }
  if (d.type === 'amount') {
    return { type: 'amount', value: d.value, code: d.code ?? null, v: parseDecimal(d.value, `${field}.value`, { min: 0, maxDecimals: digits }) };
  }
  return fail('INVALID_DISCOUNT', `${field}.type must be "percent" or "amount"`);
}

export function readQuantity(value, field) {
  return parseDecimal(value, field, { positive: true, maxDecimals: 3 });
}

function readLine(raw, i, inv) {
  const field = `lines[${i}]`;
  if (!isObject(raw)) fail('INVALID_LINE', `${field} must be an object`);
  if (typeof raw.id !== 'string' || raw.id === '') fail('INVALID_LINE', `${field}.id must be a non-empty string`);
  if (raw.description !== undefined && typeof raw.description !== 'string') fail('INVALID_LINE', `${field}.description must be a string`);
  const hasPrice = raw.unitPrice !== undefined;
  const hasTiers = raw.tiers !== undefined;
  if (hasPrice === hasTiers) fail('INVALID_LINE', `${field} needs exactly one of unitPrice and tiers`);
  const quantity = readQuantity(raw.quantity, `${field}.quantity`);
  const tax = resolveTaxClass(raw.taxClass, inv.taxRates, `${field}.taxClass`);
  if (raw.discounts !== undefined && !Array.isArray(raw.discounts)) fail('INVALID_DISCOUNT', `${field}.discounts must be an array`);
  const discounts = (raw.discounts ?? []).map((d, j) => readDiscount(d, `${field}.discounts[${j}]`, inv.digits));
  if (raw.discountable !== undefined && typeof raw.discountable !== 'boolean') fail('INVALID_LINE', `${field}.discountable must be a boolean`);

  const line = {
    id: raw.id,
    description: raw.description ?? '',
    tax,
    quantityText: raw.quantity,
    quantity,
    unitPriceText: null,
    unitPrice: null,
    tiers: null,
    tierMode: raw.tierMode ?? 'volume',
    discounts,
    discountable: raw.discountable ?? true,
    period: raw.period ?? null,
    billingPeriod: inv.billingPeriod,
  };

  if (hasPrice) {
    line.unitPrice = parseDecimal(raw.unitPrice, `${field}.unitPrice`, { maxDecimals: 6 });
    line.unitPriceText = raw.unitPrice;
  } else {
    line.tiers = checkTiers(raw.tiers, field);
    if (!quantity.isInteger()) fail('FRACTIONAL_TIERED_QUANTITY', `${field} has tiers and a fractional quantity`);
  }
  return line;
}

/** The internal form of an invoice document. Throws InvoiceError on the first problem found. */
export function readInvoice(doc) {
  if (!isObject(doc)) fail('INVALID_INVOICE', 'an invoice must be an object');
  if (typeof doc.number !== 'string' || doc.number === '') fail('INVALID_INVOICE', 'number must be a non-empty string');
  if (doc.issueDate === undefined) fail('INVALID_INVOICE', 'issueDate is required');
  dayNumber(doc.issueDate, 'issueDate');
  if (doc.currency === undefined) fail('INVALID_INVOICE', 'currency is required');
  const cur = currencyInfo(doc.currency);
  if (!cur) fail('UNKNOWN_CURRENCY', `unknown currency ${JSON.stringify(doc.currency)}`);
  if (!Array.isArray(doc.lines)) fail('INVALID_INVOICE', 'lines must be an array');
  if (doc.taxRates !== undefined && !isObject(doc.taxRates)) fail('INVALID_INVOICE', 'taxRates must be an object');
  if (doc.cashRounding !== undefined && typeof doc.cashRounding !== 'boolean') fail('INVALID_SETTING', 'cashRounding must be a boolean');

  const inv = {
    number: doc.number,
    issueDate: doc.issueDate,
    currency: doc.currency,
    digits: cur.digits,
    cashIncrement: cur.cashIncrement ?? null,
    priceMode: setting(doc.priceMode, PRICE_MODES, 'priceMode', 'exclusive'),
    rounding: setting(doc.rounding, ROUNDING, 'rounding', 'line'),
    taxRounding: setting(doc.taxRounding, TAX_ROUNDING, 'taxRounding', 'half-up'),
    cashRounding: doc.cashRounding ?? false,
    taxRates: doc.taxRates ?? {},
    billingPeriod: doc.billingPeriod ?? null,
    discounts: [],
    minimum: null,
    lines: [],
  };

  if (doc.discounts !== undefined && !Array.isArray(doc.discounts)) fail('INVALID_DISCOUNT', 'discounts must be an array');
  inv.discounts = (doc.discounts ?? []).map((d, j) => readDiscount(d, `discounts[${j}]`, inv.digits));

  if (doc.minimumCharge !== undefined) {
    const m = doc.minimumCharge;
    if (!isObject(m)) fail('INVALID_INVOICE', 'minimumCharge must be an object');
    const amount = parseDecimal(m.amount, 'minimumCharge.amount', { min: ZERO, maxDecimals: inv.digits });
    inv.minimum = { amount, tax: resolveTaxClass(m.taxClass ?? 'standard', inv.taxRates, 'minimumCharge.taxClass') };
  }

  const seen = new Set();
  doc.lines.forEach((raw, i) => {
    const line = readLine(raw, i, inv);
    if (seen.has(line.id)) fail('DUPLICATE_LINE_ID', `line id ${line.id} is used twice`);
    seen.add(line.id);
    inv.lines.push(line);
  });
  return inv;
}
