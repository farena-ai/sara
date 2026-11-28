// calculateInvoice: the public entry point for invoices.
import { readInvoice } from '../model/validate.js';
import { calculate } from './calculate.js';
import { toResult } from './output.js';

export function calculateInvoice(doc) {
  const inv = readInvoice(doc);
  return toResult(calculate(inv), { kind: 'invoice', number: inv.number, creditFor: null, issueDate: inv.issueDate });
}
