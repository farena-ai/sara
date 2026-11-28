// Reading invoice documents from JSON files.
import { readFileSync } from 'node:fs';
import { InvoiceError } from '../errors.js';

export function parseInvoiceJson(text, name = 'input') {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new InvoiceError('INVALID_INVOICE', `${name} is not valid JSON (${e.message})`);
  }
}

export function loadInvoice(file) {
  return parseInvoiceJson(readFileSync(file, 'utf8'), file);
}
