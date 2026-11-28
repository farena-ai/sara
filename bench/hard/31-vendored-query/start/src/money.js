/** Formats integer cents as "1,234.50" (negative amounts get a leading minus). */
export function formatCents(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`cents must be an integer, got ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parses "12.5", "1,234.50" or "7" into cents. Throws RangeError on anything else. */
export function parseCents(text) {
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
  if (!m) throw new RangeError(`not an amount: ${text}`);
  return Number(m[1].replaceAll(',', '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
