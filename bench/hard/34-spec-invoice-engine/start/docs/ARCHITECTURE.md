# Source layout

```
bin/tally.js              command line entry point
src/index.js              public API
src/errors.js             InvoiceError and the error codes
src/num/                  exact numbers
  rational.js             BigInt rationals; every amount is one
  parse.js                reading decimal strings, writing rates
  round.js                rounding to minor units and to cash increments
src/money/                currencies and formatting of amounts
src/dates/calendar.js     YYYY-MM-DD dates and day counting
src/model/validate.js     checks a document, builds the internal form
src/pricing/              steps 1 to 5 of SPEC R10 (one line at a time)
  tiers.js                volume and graduated tiers
  proration.js            proration by period
  lineDiscounts.js        a line's own discounts
  lineAmount.js           puts steps 1 to 5 together
src/discounts/            steps 6 and 7 (document discounts and their allocation)
src/billing/minimum.js    step 8 (minimum charge)
src/tax/                  tax classes, tax amounts and the breakdown (step 9)
src/engine/               the pipeline, totals (step 10) and the result object
src/credit/               credit notes
src/render/               text rendering for the command line
src/cli/, src/io/         the command line and reading JSON files
```

## Conventions

- Money is never a JavaScript number. Inputs are decimal strings, parsed into `Rational`
  (src/num/rational.js) and kept exact until a rule says to round.
- `model/validate.js` produces the *internal form* of an invoice: settings with their defaults,
  resolved tax classes (`{ name, rate, rateText, exempt }`), parsed lines. The rest of the engine
  works only on that form.
- `engine/calculate.js` returns an *internal result* with Rational amounts;
  `engine/output.js` turns it into the public result object of strings. Nothing outside
  `output.js` formats amounts.
- Every failure is an `InvoiceError` with one of the codes in `src/errors.js`.
