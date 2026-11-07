# Performance Regression Lab

Measure a **real slowdown** between two versions of a small benchmark. Tool `compare` has two
operations: `plan` hashes the staged scripts and returns a `planSha` without running anything;
`run` executes exactly that plan and refuses if any staged byte changed.

## Staging and authority

With the plugin disabled, a trusted operator copies two self-contained classic scripts into
`<plugin-native-data-home>/perf-lab-v1/<benchmark>/baseline.js` and `candidate.js`. Each defines
`function bench()` returning a finite number. The plugin reads only its own data home (process cwd);
it accepts no roots, commands, URLs or measured numbers from the caller.

Each script runs in its own `node:vm` context with string code generation and WebAssembly
disabled, no host objects and a per-call timeout, inside the permission-limited plugin process
(no child processes, workers, network APIs or workspace access). `node:vm` is not a security
boundary on its own and Windows node-only mode is not an OS sandbox: stage only code you trust.

## Measurement and verdicts

Warm-up then measured calls alternate baseline/candidate in ABBA order on the same host. Every raw
sample (nanoseconds) is returned with CPU/platform/Node metadata. With at least 10 samples per side
and relative median absolute deviation at most 0.25, a seeded 2000-resample bootstrap gives a 95%
interval for the median ratio. `regression` requires the interval to clear `minEffectPercent` and a
one-sided Mann-Whitney z above 2.326; `no-regression` requires the whole interval below it. Anything
else is `inconclusive` (`underpowered`, `noisy` or `effect-uncertain`) and carries **no percentage**.

Limits: 5–60 samples, 0–20 warm-ups, 256 KiB per script, worst-case 20 s per run. One machine's
timings say nothing about other hardware; the result is not a production performance guarantee.
