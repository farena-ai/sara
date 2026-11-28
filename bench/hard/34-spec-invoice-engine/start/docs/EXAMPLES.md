# Worked examples

Each example is a file in `examples/`; the numbers below are the exact results the engine must
produce for it, with the working. Rule numbers refer to docs/SPEC.md.

## 1. A shop order (`examples/01-shop.json`)

EUR, exclusive prices, line rounding. Standard rate 19, reduced rate 7. Document discounts are
listed as `WELCOME5` (5.00 off) then `SPRING10` (10%).

| Line | Working | Line amount |
|---|---|---|
| 1 Desk lamp | 2 × 24.90 = 49.80; 5% first (R23): 47.31; then 3.00 off: 44.31 | 44.31 |
| 2 Coffee beans | 3 × 13.49 | 40.47 |
| 3 Gift wrapping | 1 × 2.50, `discountable: false` | 2.50 |

Document discounts (R27, R28): the eligible total is 44.31 + 40.47 = 84.78 (line 3 is not
eligible). The percentage goes first although it is listed second: 10% of 84.78 = 8.478, rounded
8.48. The fixed discount then takes 5.00 of the remaining 76.30. The total is 13.48, and
`discounts` lists `SPRING10` (8.48) before `WELCOME5` (5.00) (R31).

Allocation (R30) of 1348 cents over 44.31 and 40.47:

| Line | Exact share in cents | Whole cents | Fraction | Final |
|---|---|---|---|---|
| 1 | 1348 × 44.31 / 84.78 = 704.53… | 704 | .53 | 705 |
| 2 | 1348 × 40.47 / 84.78 = 643.47… | 643 | .47 | 643 |

One cent is left over and goes to line 1, which has the larger fraction.

Tax per line (R34):

| Line | Net | Tax | Gross |
|---|---|---|---|
| 1 | 44.31 − 7.05 = 37.26 | 19% = 7.0794 → 7.08 | 44.34 |
| 2 | 40.47 − 6.43 = 34.04 | 7% = 2.3828 → 2.38 | 36.42 |
| 3 | 2.50 | 19% = 0.475 → 0.48 | 2.98 |

Breakdown: standard 19, net 39.76, tax 7.56; reduced 7, net 34.04, tax 2.38. Totals: discount
13.48, net 73.80, tax 9.94, gross 83.74, payable 83.74.

## 2. Inclusive prices and a minimum charge (`examples/02-inclusive-minimum.json`)

GBP, inclusive prices (R13), standard rate 20, 15% staff discount, minimum charge 30.00.

| Line | Working | Line amount |
|---|---|---|
| A Repair labour | 0.5 × 45.00 | 22.50 |
| B Spare part | 1 × 8.99 | 8.99 |
| C Postage refund | 1 × −3.20, a negative line (R25) | −3.20 |

The eligible total is 22.50 + 8.99 = 31.49 (C never is). 15% of 31.49 = 4.7235 → 4.72. Allocation:
A 337.25… cents, B 134.75… cents; the left-over cent goes to B (fraction .75), so A gets 3.37 and
B 1.35.

Minimum charge (R32): 19.13 + 7.64 − 3.20 = 23.57, below 30.00, so a top-up line `MINIMUM` of
6.43 is added in the standard class (R33).

Tax from gross amounts (R13, R34), rate 20 so tax = gross / 6:

| Line | Gross | Tax | Net |
|---|---|---|---|
| A | 19.13 | 3.18833… → 3.19 | 15.94 |
| B | 7.64 | 1.27333… → 1.27 | 6.37 |
| C | −3.20 | −0.53333… → −0.53 | −2.67 |
| MINIMUM | 6.43 | 1.07166… → 1.07 | 5.36 |

Totals: discount 4.72, net 25.00, tax 5.00, gross 30.00, payable 30.00.

## 3. A prorated subscription (`examples/03-subscription.json`)

USD, standard rate 8.875, billing period 2028-02-01 to 2028-02-29 (29 days, a leap year).

- `seats`: 25 seats on graduated tiers (R18): 10 × 12.00 + 10 × 10.00 + 5 × 8.00 = 260.00. The line
  shows `unitPrice` `null`.
- `addon`: 29.00 for 2028-02-10 to 2028-02-29, 20 days (R21): 29.00 × 20 / 29 = 20.00, then the
  5.00 fixed discount, which is not prorated (R24): 15.00.
- `support`: one volume tier (R17) at 99.00, exempt (R14).

Tax: seats 260.00 × 8.875% = 23.075 → 23.08; addon 15.00 × 8.875% = 1.33125 → 1.33. Breakdown:
standard 8.875, net 275.00, tax 24.41. The exempt line has no breakdown entry, but its 99.00 is in
the totals: net 374.00, tax 24.41, gross 398.41.

A partial credit note for 5 seats (`lines: [{ id: "seats", quantity: "5" }]`) credits the last
five seats (R42): graduated(25) − graduated(20) = 260.00 − 220.00 = 40.00, tax 3.55. Its totals are
net −40.00, tax −3.55, gross −43.55.

## 4. Document rounding in a three-decimal currency (`examples/04-document-rounding.json`)

KWD (3 decimals), `rounding: "document"`, standard rate 5, a fixed 1.000 discount.

| Line | Exact line amount | Shown |
|---|---|---|
| L1 | 1250 × 0.0125 = 15.625 | 15.625 |
| L2 | 7 × 0.3333 = 2.3331 | 2.333 |
| L3 (zero) | 2 × 4.1255 = 8.251 | 8.251 |

In document rounding mode the 1.000 is shared exactly (R30): L1 15.625 / 26.2091 = 0.59617…,
L2 0.08901…, L3 0.31481…, shown as 0.596, 0.089 and 0.315. Lines show `null` for net, tax and
gross (R36).

Per class (R35): standard S = 15.625 + 2.3331 − 0.59617… − 0.08901… = 17.27291…, so net 17.273 and
tax 5% of S = 0.86364… → 0.864. Zero: 8.251 − 0.31481… = 7.93618… → 7.936, tax 0.000. Totals:
discount 1.000, net 25.209, tax 0.864, gross 26.073.

## 5. Cash rounding and half-even tax (`examples/05-cash-rounding.json`)

CHF, `cashRounding: true`, `taxRounding: "half-even"`, standard rate 8.1, reduced rate 2.6.

- K1: 1.25 × 180.00 = 225.00; tax 8.1% = 18.225, exactly halfway, half-even gives 18.22 (R6).
- K2: 12.50; tax 2.6% = 0.325 → 0.32.

Gross 225.00 + 18.22 + 12.50 + 0.32 = 256.04. Cash rounding to 0.05 (R38): 256.04 / 0.05 = 5120.8
→ 5121 steps = 256.05; `roundingAdjustment` 0.01, `payable` 256.05.

A partial credit note for a quarter hour (`lines: [{ id: "K1", quantity: "0.25" }]`): 45.00, tax
3.645 → 3.64 (half-even), gross 48.64, cash rounded on its own gross to 48.65 (R41), and then
negated: gross −48.64, `roundingAdjustment` −0.01, `payable` −48.65.
