# Tally

Tally turns an invoice document (plain JSON: lines, tax rates, discounts, settings) into a fully
calculated invoice: line amounts, discount allocation, a tax breakdown and totals. It also makes
credit notes for invoices it calculated.

There are no dependencies. Node 24 or later.

```js
import { calculateInvoice, createCreditNote, renderText } from './src/index.js';

const doc = {
  number: '2026-0141',
  issueDate: '2026-03-02',
  currency: 'EUR',
  taxRates: { standard: '19', reduced: '7' },
  lines: [{ id: '1', description: 'Desk lamp', quantity: '2', unitPrice: '24.90', taxClass: 'standard' }],
};
const invoice = calculateInvoice(doc);
console.log(renderText(invoice));
const credit = createCreditNote(doc, { issueDate: '2026-03-20' });
```

From the command line:

```
node bin/tally.js calc examples/01-shop.json
node bin/tally.js calc examples/01-shop.json --json
node bin/tally.js credit examples/03-subscription.json --lines seats:5 --date 2028-03-10
```

## Documents

- [docs/SPEC.md](docs/SPEC.md): the specification, rules R1 to R42. It is the only authority on
  what the engine computes.
- [docs/EXAMPLES.md](docs/EXAMPLES.md): worked examples with exact results (the inputs are in
  `examples/`).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the source is laid out.
- [CHANGELOG.md](CHANGELOG.md): what has been done in version 2 so far.

## The result

`calculateInvoice(doc)` returns a plain object:

```js
{
  kind: 'invoice',            // or 'credit-note'
  number: '2026-0141',
  creditFor: null,            // the invoice number on a credit note
  issueDate: '2026-03-02',
  currency: 'EUR',
  priceMode: 'exclusive',
  rounding: 'line',
  lines: [{ id, description, taxClass, quantity, unitPrice, amount, allocatedDiscount, net, tax, gross }],
  discounts: [{ code, type, value, amount }],
  taxes: [{ taxClass, rate, net, tax }],
  totals: { discount, net, tax, gross, roundingAdjustment, payable },
}
```

All amounts are strings in the currency's minor units (SPEC R4). Errors are thrown as
`InvoiceError` with a `code` from the table at the end of the specification.

## Tests

```
node --test
```
