# Build Cache Inspector qualification tooling

Run from the repository root with Node24+ and the already-installed root TypeScript dependency.
Do not install or run repository build commands for an arbitrary staged project. The fixture
producer runs only the checked-in source.ts with the existing fixed compiler and fixed options.
It creates a fresh owned temporary directory; no source/project/cache root option is accepted.
Runtime plugin code never imports this producer and has no child-process grant.

Set TMPDIR, TEMP and TMP explicitly to an operator-chosen owned scratch directory before tests.
For example, require `SARA_CACHE_INSPECTOR_TEST_TMP` in your shell rather than embedding a personal
home path. Then use the equivalent of:

```sh
: "${SARA_CACHE_INSPECTOR_TEST_TMP:?set an owned scratch directory}"
export TMPDIR="$SARA_CACHE_INSPECTOR_TEST_TMP" TEMP="$SARA_CACHE_INSPECTOR_TEST_TMP" TMP="$SARA_CACHE_INSPECTOR_TEST_TMP"
node --test --test-concurrency=1 test/developer-build-cache-inspector*.test.ts
node node_modules/typescript/bin/tsc -p tools/developer-build-cache-inspector/tsconfig.json --noEmit
node tools/developer-build-cache-inspector/verify.ts
```

The real manager test official-packs and smoke-runs with explicit2.68 target, then stages,
trusts, enables and invokes both operations in all six locales, attaches12 result cards, disables,
and proves source/cache byte hashes and actual installed mtimes unchanged. It emits an archive,
receipt and synthetic ordinal mapping under outputs/developer-addons/build-cache-inspector.
Proof copies retain actual compiler-produced bytes; their copy mtimes are NOT the original
installed mtimes. Original before/after timestamps are in the actual host receipt.
The independent byte verifier parses the real ZIP and compares source/archive/approved SHA,
standalone SDK and full root MIT license, plus materialized produced/installed proof bytes.

`capture-card.ts` generates an HTML rendering from an actual measured owned fixture result.card.
Open that file in a browser and capture it for the package screenshot. This illustrates the
native card data, not a screenshot of Sara Settings or a live selected-workspace scan.
Preserve earlier receipts/logs before replacing them; early/ contains the first passing package
and its source-hash ledger, and RED logs are kept at the output root.
