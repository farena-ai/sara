// Amounts are strings with up to two decimals ("12.5", "-3.07", "100"); internally they are integer cents.

const AMOUNT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function parseAmount(text) {
  if (typeof text === 'number' && Number.isInteger(text)) return text * 100;
  const m = AMOUNT.exec(String(text ?? '').trim());
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
