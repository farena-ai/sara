export function invoice(over = {}) {
  return { number: 'INV-100', issueDate: '2026-03-01', currency: 'EUR', taxRates: { standard: '20', reduced: '10' }, lines: [], ...over };
}

export function line(id, quantity, unitPrice, taxClass = 'standard', extra = {}) {
  return { id, quantity, unitPrice, taxClass, ...extra };
}

export function codeOf(fn) {
  try {
    fn();
  } catch (e) {
    return e.code ?? `untyped error: ${e.message}`;
  }
  return 'no error';
}

export function pick(result, field) {
  return result.lines.map((l) => l[field]);
}
