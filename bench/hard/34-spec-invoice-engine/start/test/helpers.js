export function invoice(over = {}) {
  return { number: 'T-1', issueDate: '2026-01-15', currency: 'EUR', taxRates: { standard: '20', reduced: '10' }, lines: [], ...over };
}

export function line(id, quantity, unitPrice, taxClass = 'standard', extra = {}) {
  return { id, quantity, unitPrice, taxClass, ...extra };
}

export function errorCode(fn) {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
}
