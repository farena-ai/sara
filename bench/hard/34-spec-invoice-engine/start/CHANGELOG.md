# Changelog

## 2.0.0 (in progress)

Version 2 replaces the floating-point engine of 1.x with exact arithmetic and a written
specification (docs/SPEC.md). The new engine is being built module by module.

Done so far:

- Exact rationals, decimal parsing, half-up rounding, amount formatting.
- The currency table and calendar dates.
- Reading and checking invoice documents (most of R1, R3, R7 to R9, R11).
- Tax-exclusive invoices in line rounding mode with plain unit prices, volume tiers and line
  discounts; the tax breakdown and totals for them.
- The text rendering and the `tally` command.

Not done yet: everything else in the specification.

## 1.6.2

- Last release of the 1.x engine (floating point, one tax rate per invoice).
