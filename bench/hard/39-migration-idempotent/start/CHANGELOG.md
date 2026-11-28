# Changelog

## 0.4.0

- All writes go through `src/store/fsx.js`, with the fault hook (docs/RESUME.md) for testing interruptions.
- `migrate status`.
- Lines that are not JSON objects are quarantined instead of stopping the run.

## 0.3.0

- Quarantine files: records that cannot be upgraded are set aside with a reason instead of being dropped.
- Canonical output: keys sorted, no spaces.

## 0.2.0

- The v1 -> v2 step: renamed fields, cents instead of dollar strings, grams instead of pounds.
