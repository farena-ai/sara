// The one error type the engine throws. `code` is one of the codes listed in docs/SPEC.md
// ("Error codes"); the message is for people and may change.

export class InvoiceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'InvoiceError';
    this.code = code;
  }
}

export const CODES = Object.freeze([
  'INVALID_INVOICE',
  'INVALID_NUMBER',
  'INVALID_DATE',
  'INVALID_SETTING',
  'UNKNOWN_CURRENCY',
  'UNKNOWN_TAX_CLASS',
  'DUPLICATE_LINE_ID',
  'INVALID_LINE',
  'INVALID_TIERS',
  'FRACTIONAL_TIERED_QUANTITY',
  'INVALID_PERIOD',
  'PERIOD_OUTSIDE',
  'INVALID_DISCOUNT',
  'INVALID_CREDIT',
  'UNKNOWN_LINE',
  'CREDIT_EXCEEDS',
  'NOT_IMPLEMENTED',
]);

export function fail(code, message) {
  throw new InvoiceError(code, message);
}
