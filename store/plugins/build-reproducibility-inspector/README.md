# Build Reproducibility Inspector

Build a **staged fixture twice, independently**, and compare the real artifact bytes. Tool `inspect`
has two operations: `plan` hashes `build.js` and every `source/` file and returns a `planSha`
without running anything; `compare` runs exactly that plan and refuses if any staged byte changed.

## Staging and authority

With the plugin disabled, a trusted operator stages `<plugin-native-data-home>/repro-v1/<profile>/`
with `build.js` (a classic script defining `function build(inputs, env)` that returns an object of
relative output path → text) and a `source/` tree (64 files, depth 6, 1 MiB, UTF-8 only, no links).
The plugin reads only its own data home and accepts no roots, commands or URLs.

Each build runs in a fresh `node:vm` context (string code generation and WebAssembly disabled, no
host objects, 5 s timeout) inside the permission-limited plugin process. Both builds receive the
same in-memory source snapshot and `env.sourceDateEpoch`; they differ only in a controlled clock
(`Date`, one day and 1.234 s apart) and `env.buildRoot`. `node:vm` is not a security boundary on its
own and Windows node-only mode is not an OS sandbox: stage only build code you trust. This is not
a general build system runner: no compilers, package managers or child processes are executed.

## Report

Each output file gets both SHA-256 digests and a status: `identical`, `explained` (the bytes become
equal once that build's own clock — ISO, UTC string, epoch ms/s — and build root are masked, with
line-numbered evidence of both values), `unexplained` (first differing byte offset) or missing in
one build. Tree hashes cover all paths. Outputs: 64 files, 4 MiB; results 48 KiB.
