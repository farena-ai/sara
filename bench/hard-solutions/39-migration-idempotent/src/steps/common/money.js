// Dollar amounts as written by schema 1 ("12.50", "0.5", "1,234.50") to whole cents.

const AMOUNT = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** Cents for a schema-1 amount string, or null when it is not one. */
export function toCents(text) {
  if (typeof text !== 'string' || !AMOUNT.test(text)) return null;
  const [whole, fraction = ''] = text.replace(/,/g, '').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
