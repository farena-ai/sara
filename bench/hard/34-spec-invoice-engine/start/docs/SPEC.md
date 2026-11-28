# Tally invoice engine: specification (version 2)

This document is the specification of `calculateInvoice` and `createCreditNote`. Every rule is
numbered; code, tests and issues refer to rules as R1, R2, and so on. Where two rules seem to meet,
R10 (the order of calculation) and the rule that names the other one decide.

Words used below:

- *minor unit*: the smallest unit of the invoice currency (cent, fils, yen). R3.
- *exact*: an unrounded rational value (R2).
- *round* without a qualifier: round half-up to the currency's minor units (R5).
- *price-mode amount*: a net amount when `priceMode` is `"exclusive"`, a gross amount (tax
  included) when it is `"inclusive"` (R12, R13).
- *line amount*: a line's price-mode amount after its own discounts (R26).

## 1. Numbers and money

**R1. Decimal strings.** Every numeric input (quantities, prices, tier starts, rates, discount
values, minimum charges) is a string matching `^-?[0-9]+(\.[0-9]+)?$`. A JavaScript number, an
empty string, `"1e3"`, `"+1"`, `".5"` or `"5."` is rejected with `INVALID_NUMBER`.

**R2. Exact arithmetic.** All calculation is exact (rational numbers). Nothing is rounded except
where a rule says so; in particular a quotient such as 10/31 is never truncated to a few decimals.

**R3. Currencies.** The invoice `currency` must be one of the following; anything else is
`UNKNOWN_CURRENCY`.

| Currency | Minor-unit decimals | Cash increment (minor units) |
|---|---|---|
| JPY, KRW, ISK | 0 | none |
| USD, EUR, GBP | 2 | none |
| CHF | 2 | 5 |
| SEK | 2 | 100 |
| KWD, BHD, OMR | 3 | none |

**R4. Output amounts.** Every amount in a result is a string with exactly the currency's number of
decimals (`"1200"` in JPY, `"12.30"` in EUR, `"1.250"` in KWD), a leading `-` when negative, and no
thousands separators, no `+` and no spaces. Zero is always written without a sign: `"0.00"`, never
`"-0.00"`. Amounts in a result are always whole numbers of minor units (display values are rounded
first, see R26, R30, R35).

**R5. Half-up rounding.** "Round" means: to the currency's minor units, and a value exactly halfway
between two minor units goes away from zero (`2.345` becomes `2.35`, `-2.345` becomes `-2.35`).
This applies to every rounding in this document except the tax amounts named in R6.

**R6. Tax rounding setting.** The setting `taxRounding` is `"half-up"` (the default) or
`"half-even"`. It applies only to *tax amounts*: the tax of each line in line rounding mode (R34)
and the tax of each tax class in document rounding mode (R35), in both price modes. With
`"half-even"` a value exactly halfway goes to the neighbour whose last digit is even (`0.125`
becomes `0.12`, `0.135` becomes `0.14`, `-0.125` becomes `-0.12`). Nets, grosses, line amounts,
discounts, top-ups and cash rounding always use R5.

**R7. Input limits.** Besides R1, violating any of these is `INVALID_NUMBER`:

- `quantity`: greater than zero, at most 3 decimals.
- `unitPrice` and a tier's `unitPrice`: at most 6 decimals. A tier's `unitPrice` must not be
  negative; a line's `unitPrice` may be (R25).
- a tier's `from`: a whole number, at least 1.
- a `"percent"` discount `value` and a tax rate: from 0 to 100 inclusive, at most 4 decimals.
- an `"amount"` discount `value` and `minimumCharge.amount`: not negative, at most the currency's
  number of decimals (`"0.5"` and `"0.50"` are fine in EUR, `"0.505"` is not; in JPY `"100.0"` is
  not allowed).

## 2. The invoice document

**R8. Document fields and settings.** An invoice is an object with:

| Field | Required | Meaning |
|---|---|---|
| `number` | yes | non-empty string |
| `issueDate` | yes | `YYYY-MM-DD` |
| `currency` | yes | R3 |
| `lines` | yes | array of lines (may be empty) |
| `taxRates` | no | object, tax class name to rate string (R11) |
| `priceMode` | no | `"exclusive"` (default) or `"inclusive"` |
| `rounding` | no | `"line"` (default) or `"document"` |
| `taxRounding` | no | `"half-up"` (default) or `"half-even"` (R6) |
| `cashRounding` | no | boolean, default `false` (R38) |
| `discounts` | no | array of document discounts (R27) |
| `minimumCharge` | no | `{ amount, taxClass }`, `taxClass` defaulting to `"standard"` (R32) |
| `billingPeriod` | no | `{ start, end }`, dates (R21) |

A missing required field, a `number` that is not a non-empty string, or `lines` that is not an
array is `INVALID_INVOICE`. A setting with a value outside the ones listed is `INVALID_SETTING`.
Every date anywhere in an invoice must be a real calendar date in the form `YYYY-MM-DD`
(`2026-02-30` is not); otherwise `INVALID_DATE`.

**R9. Lines.** A line is an object with `id` (non-empty string), `description` (string, default
`""`), `quantity` (R7), either `unitPrice` or `tiers` (exactly one of them; both or neither is
`INVALID_LINE`), `tierMode` (`"volume"`, the default, or `"graduated"`; only meaningful with
`tiers`; any other value is `INVALID_SETTING`), `taxClass` (required, R11), `discounts` (array, default empty, R23), `discountable`
(boolean, default `true`, R27) and `period` (optional `{ start, end }`, R21). Line ids must be
unique within the invoice (`DUPLICATE_LINE_ID`). The id `"MINIMUM"` is reserved for the top-up
line (R33) and is `INVALID_LINE` on an input line.

## 3. Order of calculation

**R10. Steps.** An invoice is calculated in exactly this order. Each step uses the result of the
step before; no step looks ahead.

1. Unit price from tiers, if the line has tiers (R17 to R19).
2. Extended amount: quantity times unit price (R20).
3. Proration by the line's period (R21).
4. Line discounts: percentages, then fixed amounts (R23, R24).
5. Line rounding, in line rounding mode only (R26).
6. Document discounts: percentages, then fixed amounts (R27 to R30).
7. Allocation of the document discount to the eligible lines (R30).
8. Minimum charge top-up (R32, R33).
9. Tax per line or per class (R34, R35).
10. Totals (R37) and cash rounding (R38).

## 4. Tax classes

**R11. Classes.** The tax classes are `standard`, `reduced`, `super-reduced`, `zero` and `exempt`.
The first three take their rate (a percentage, R7) from `taxRates`; a line of one of those classes
whose rate is missing from `taxRates`, or a line with any other class name, is
`UNKNOWN_TAX_CLASS`. `zero` always has rate 0 and `exempt` has no rate and no tax; a `taxRates`
entry for either of them, or for a class no line uses, is ignored (it is not validated either).
`minimumCharge.taxClass` follows the same rules as a line's class, and it is checked (class name
and rate) whether or not a top-up is added.

**R12. Tax-exclusive prices.** With `priceMode` `"exclusive"`, prices, amount discounts and the
minimum charge are net amounts, and tax is net × rate / 100.

**R13. Tax-inclusive prices.** With `priceMode` `"inclusive"`, prices, amount discounts and the
minimum charge are gross amounts (tax included). The tax contained in a gross amount G at rate r
is G × r / (100 + r); the net is the gross minus the *rounded* tax, so net + tax always equals the
gross exactly.

**R14. Zero-rated and exempt lines.** `zero` lines have tax 0 and appear in the tax breakdown with
rate `"0"`. `exempt` lines never appear in the tax breakdown, but their amounts are part of the net
and gross totals (R37). For both, net equals gross.

**R15. Breakdown order.** The tax breakdown (`taxes` in the result) has one entry per class that
has at least one line in the result (the top-up line of R33 included, lines with a zero amount
included, `exempt` excluded). Entries are ordered by rate, highest first; entries with equal rates
are ordered by class name in ascending code-unit order (`"reduced"` before `"standard"`).

**R16. Rate in the output.** A rate is written as the given string without trailing zeros after
the decimal point and without a trailing point: `"20.00"` becomes `"20"`, `"5.50"` becomes `"5.5"`,
`"07"` becomes `"7"`. The `zero` class is written `"0"`.

## 5. Line amounts

**R17. Volume tiers.** With `tierMode` `"volume"`, the tier with the greatest `from` that is not
above the quantity gives the unit price for all units of the line. A quantity equal to a tier's
`from` belongs to that tier.

**R18. Graduated tiers.** With `tierMode` `"graduated"`, units are priced one by one: units
`from`..(next tier's `from` − 1) at that tier's price, the last tier open-ended. The line's
extended amount (R20) is the sum. In the result such a line has `unitPrice` `null`; a volume line
shows its tier's `unitPrice` string as given.

**R19. Tier rules.** Tiers may be given in any order; they are used sorted by `from`. The lowest
`from` must be 1 and no two tiers may share a `from` (`INVALID_TIERS`; an empty `tiers` array is
`INVALID_TIERS` too). A line with tiers must have a whole-number quantity
(`FRACTIONAL_TIERED_QUANTITY`; `"3.000"` counts as whole). Tier selection always uses the line's
full quantity, never a prorated one (R21).

**R20. Extended amount.** The extended amount of a line without tiers or with volume tiers is
quantity × unit price, exact.

**R21. Proration.** A line with a `period` is charged for part of the invoice's `billingPeriod`:
its extended amount is multiplied by (days in the line period) / (days in the billing period).
Both periods count calendar days with both ends included (2026-03-10 to 2026-03-31 is 22 days;
February 2028 has 29). The factor is exact (R2) and applies before any line discount.

**R22. Period rules.** A `period` or `billingPeriod` whose `start` is after its `end` is
`INVALID_PERIOD`; a line `period` on an invoice without `billingPeriod` is `INVALID_PERIOD`; a line
period that is not entirely inside the billing period is `PERIOD_OUTSIDE`. A `billingPeriod`
without any line `period` has no effect.

**R23. Line discounts.** A line discount is `{ type: "percent" | "amount", value }` (any other type
is `INVALID_DISCOUNT`). All `"percent"` discounts of the line are applied first, in the order they
are listed, each to the amount left by the previous one (10% then 5% leaves 85.5%). Then all
`"amount"` discounts are applied in the order listed. Listing an amount before a percentage does
not change this order.

**R24. Fixed line discounts.** An `"amount"` line discount is taken once from the line, whatever
its quantity, and after proration: it is never prorated. A line amount cannot go below zero; the
part of an amount discount that would take it below zero is dropped (not carried to other lines
or discounts).

**R25. Negative lines.** A line with a negative `unitPrice` (a refund or correction line) may not
have `tiers` or `discounts` (`INVALID_LINE`). It is never eligible for document discounts (R27),
whatever its `discountable` says, and it rounds like any amount (R5: `-2.345` is `-2.35`). It
counts in the minimum-charge comparison (R32).

**R26. Line rounding.** With `rounding` `"line"`, each line amount is rounded right after its line
discounts (step 5), and every later step uses the rounded amount. With `rounding` `"document"`,
line amounts stay exact through every later step; the `amount` shown on the line is the exact line
amount rounded for display only.

## 6. Document discounts

**R27. Eligible lines.** Document discounts (`discounts` on the invoice: `{ type, value, code }`,
`code` optional, type as in R23) apply to the *eligible total*: the sum of the line amounts of
eligible lines. A line is eligible unless `discountable` is `false` or it is a negative line
(R25). Lines whose amount is zero are eligible (they receive nothing in R30). The top-up line of
R33 does not exist yet at this step.

**R28. Order and rounding of document discounts.** All `"percent"` document discounts are applied
first, in the order they are listed, then all `"amount"` ones in the order listed; each applies to
what is left of the eligible total after the previous ones. In line rounding mode each document
discount's amount is rounded when it is applied, and the next discount applies to the remainder
after that rounded amount. In document rounding mode document discount amounts are exact.

**R29. Fixed document discounts.** An `"amount"` document discount takes at most what is left of
the eligible total; the rest of it is dropped.

**R30. Allocation.** The document discount total (the sum of the document discounts' amounts) is
divided among the eligible lines in proportion to their line amounts, and each line's share is its
`allocatedDiscount`.

- In line rounding mode the total is a whole number of minor units and is divided in whole minor
  units by the largest-remainder method: each line first gets the whole minor units of its exact
  proportional share (rounded down); the units left over go one each to the lines with the largest
  fractional parts; between equal fractional parts, the line that comes first in the invoice wins.
- In document rounding mode each line's share is its exact proportional share; the line shows it
  rounded for display.

The shares always add up to the document discount total. When the eligible total is zero, no line
gets a share.

**R31. Discounts in the output.** `discounts` in the result lists the document discounts in the
order they were applied (R28), not the order they were given, each as
`{ code, type, value, amount }`: `code` as given or `null`, `type` and `value` as given, and
`amount` the amount it took (rounded for display in document rounding mode). A discount that took
nothing is still listed, with amount zero.

## 7. Minimum charge

**R32. When it applies.** If the invoice has `minimumCharge` and at least one line, the sum of all
line amounts after allocation (line amount minus `allocatedDiscount`, price-mode amounts, negative
lines included, exact) is compared with `minimumCharge.amount`. Only when that sum is strictly
below the minimum is a top-up line added. An invoice without lines never gets one.

**R33. The top-up line.** The top-up line is appended after all other lines, with `id`
`"MINIMUM"`, `description` `"Minimum charge adjustment"`, `quantity` `"1"`, `taxClass` from
`minimumCharge.taxClass`, `allocatedDiscount` zero, and `amount` = minimum − sum (R32), in the same
price mode. Its `unitPrice` is its amount (as written in the output). It is taxed like any other line
of its class in steps 9 and 10, and it is not discountable.

## 8. Tax and totals

**R34. Line rounding mode tax.** With `rounding` `"line"`, each line is taxed on its own, with the
line amount minus `allocatedDiscount` as its price-mode amount A:

- exclusive: net = A, tax = A × rate / 100 rounded per R6, gross = net + tax;
- inclusive: gross = A, tax = A × rate / (100 + rate) rounded per R6, net = gross − tax.

A class's breakdown net and tax are the sums of its lines' nets and taxes.

**R35. Document rounding mode tax.** With `rounding` `"document"`, tax is computed per class from
the exact sum S of the class's lines' price-mode amounts (line amount minus allocated share, both
exact):

- exclusive: class net = S rounded (R5); class tax = S × rate / 100 rounded per R6.
- inclusive: class gross = S rounded (R5); class tax = S × rate / (100 + rate) rounded per R6;
  class net = class gross − class tax.

The tax is computed from the exact S, not from the rounded net or gross. `exempt` lines form a
group of their own whose net is the rounded exact sum of their amounts.

**R36. Line fields by mode.** Each result line has `id`, `description`, `taxClass`, `quantity`
(the string as given), `unitPrice` (R18, R33), `amount` (R26), `allocatedDiscount` (R30), `net`,
`tax` and `gross`. In line rounding mode `net`, `tax` and `gross` are the values of R34. In
document rounding mode they are `null`: per-line tax is not defined there.

**R37. Totals.** `totals` has `discount`, `net`, `tax`, `gross`, `roundingAdjustment` and
`payable`.

- `discount` is the document discount total (in document rounding mode, the exact total rounded).
- `net` is the sum of the breakdown nets plus the net of exempt lines; `tax` is the sum of the
  breakdown taxes; `gross` is `net` + `tax`. Totals are sums of already rounded values and are
  never rounded again.

**R38. Cash rounding.** With `cashRounding` `true` and a currency that has a cash increment (R3),
`payable` is `gross` rounded to the nearest multiple of the increment, halfway away from zero
(CHF `10.03` is `10.05`, CHF `10.02` is `10.00`, CHF `10.07` is `10.05`; SEK `99.49` is
`99.00`, SEK `99.50` is `100.00`, SEK `-99.50` is `-100.00`). `roundingAdjustment`
is `payable` − `gross`. Cash rounding never changes tax, net or gross. Otherwise (setting off, or
a currency without increment) `payable` is `gross` and `roundingAdjustment` is zero.

## 9. Credit notes

`createCreditNote(invoice, options)` takes the same invoice document that was given to
`calculateInvoice` (and checks it exactly as `calculateInvoice` does) and returns a result of the
same shape, with `kind` `"credit-note"`, `number` `options.number` (default `"CN-"` followed by the
invoice number), `creditFor` the invoice number and `issueDate` `options.issueDate` (default: the
invoice's; when given it must be a date as in R8, otherwise `INVALID_DATE`). An invoice result
has `kind` `"invoice"` and `creditFor` `null`.

**R39. Full credit note.** Without `options.lines` the credit note mirrors the invoice exactly:
the same lines (the top-up line included), discounts and tax breakdown in the same order, with
every amount negated: `amount`, `allocatedDiscount`, `net`, `tax`, `gross` of each line, `amount`
of each discount, `net` and `tax` of each breakdown entry, and all six totals. Quantities, unit
prices, rates, discount values, codes and `null`s are kept as on the invoice. A zero stays a zero
without sign (R4). It is never recalculated from negated inputs: the result is exactly the
negation of the invoice's result.

**R40. Partial credit note: selection.** With `options.lines` (an array of `{ id, quantity }`) only
the listed invoice lines are credited, each for `quantity` (default: the whole line quantity). An
empty array is `INVALID_CREDIT`; an id that is not an input line of the invoice (the top-up line
`"MINIMUM"` included) is `UNKNOWN_LINE`; an id listed twice is `DUPLICATE_LINE_ID`; a quantity that
breaks R7 is `INVALID_NUMBER`; a quantity above the line's quantity is `CREDIT_EXCEEDS`; a
fractional quantity on a tiered line is `FRACTIONAL_TIERED_QUANTITY`. The credited lines keep the
invoice's order, not the order of `options.lines`. Giving `options.lines` always makes a partial
credit note, even if it lists every line in full.

**R41. Partial credit note: calculation.** A partial credit note is calculated as an invoice with
the invoice's settings, `taxRates` and `billingPeriod`, holding only the credited lines with their
credited quantities, and then every amount of that result is negated as in R39. The credited lines
keep their `taxClass`, `discountable`, `period` and percentage line discounts; each `"amount"`
line discount is scaled by credited quantity / line quantity (exact, R2). Each credited line shows
the credited quantity in `quantity`: the string given in `options.lines`, or the invoice line's
`quantity` string when none is given. Document `"percent"` discounts apply as on an invoice, to
the eligible total of the credited lines (R27, R28, R30); document `"amount"` discounts are not
applied and not listed; the minimum charge is not applied. Cash rounding applies to the partial
credit note's own gross.

**R42. Partial credit note: tiers.** A credited volume-tier line uses the unit price of the tier
that the *invoice's* line quantity selected. A credited graduated line is credited for the last
units of the invoice line: its extended amount is graduated(line quantity) − graduated(line
quantity − credited quantity), where graduated(q) is the R18 sum for q units (graduated(0) is 0).

## Error codes

All errors are `InvoiceError` with one of these `code`s:

| Code | Rules |
|---|---|
| `INVALID_INVOICE` | R8 |
| `INVALID_NUMBER` | R1, R7, R40 |
| `INVALID_DATE` | R8 |
| `INVALID_SETTING` | R6, R8 |
| `UNKNOWN_CURRENCY` | R3 |
| `UNKNOWN_TAX_CLASS` | R11 |
| `DUPLICATE_LINE_ID` | R9, R40 |
| `INVALID_LINE` | R9, R25 |
| `INVALID_TIERS` | R19 |
| `FRACTIONAL_TIERED_QUANTITY` | R19, R40 |
| `INVALID_PERIOD` | R22 |
| `PERIOD_OUTSIDE` | R22 |
| `INVALID_DISCOUNT` | R23, R27 |
| `INVALID_CREDIT` | R40 |
| `UNKNOWN_LINE` | R40 |
| `CREDIT_EXCEEDS` | R40 |

When an input has more than one error, which code is reported is not specified.
