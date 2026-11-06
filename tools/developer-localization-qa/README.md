# Trusted owned-fixture qualification tools

These scripts are developer-only, outside the installable native package. They do not provide a
Sara browser endpoint, accept app URLs, execute project scripts or access personal desktop state.
No package installation, browser download, model, paid API, account or server is involved.

From the isolated Sara-Addons root, use Node24 and the root's existing TypeScript/test dependencies.
Set TMPDIR/TEMP/TMP to the explicit Hermes scratch directory for native host/browser gates.

```
SARA_LOCALIZATION_BROWSER=0 SARA_LOCALIZATION_FREEZE=0 node --test --test-concurrency=2 test/developer-localization-qa*.test.ts
SARA_LOCALIZATION_PLAYWRIGHT_MODULE="$EXISTING_PLAYWRIGHT_MODULE" PLAYWRIGHT_BROWSERS_PATH="$EXISTING_BROWSER_DIRECTORY" SARA_LOCALIZATION_BROWSER=1 node --test test/developer-localization-qa-render.test.ts
SARA_LOCALIZATION_BROWSER=0 node --test test/developer-localization-qa-host.test.ts
SARA_LOCALIZATION_FREEZE=1 node --test test/developer-localization-qa-freeze.test.ts
node node_modules/typescript/bin/tsc -p tools/developer-localization-qa/tsconfig.json
node tools/developer-localization-qa/verify.ts
```

Run browser capture before host qualification and freeze verification, serially; do not overwrite
fixtures during a concurrent host run. The default suite never launches a browser. Browser and
freeze are explicit opt-ins: freeze requires ignored outputs from the host and browser gates.
Operator must explicitly set `SARA_LOCALIZATION_PLAYWRIGHT_MODULE` to an existing module file and
`PLAYWRIGHT_BROWSERS_PATH` to an existing browser installation directory for each capture command.
There are no owner-path literals, personal-cache defaults or environment mutation in the utility.
`capture.mjs` imports only that specified existing Playwright installation and verifies the
expected executable exists under the existing browser installation. No automatic fallback download.
Qualification used Chromium151.0.7922.34; exact executable digest is in capture-provenance.json.
No dependencies or package lock were introduced; the plugin uses Node built-ins and the exact SDK.

Capture opens fresh nonpersistent contexts in its own browser, uses the checked-in static HTML
only, writes catalogs via `textContent`, fixes font/DPR/viewports/locale/timezone, waits for fonts
and two animation frames, aborts all routed network requests and blocks service workers. No
`--no-sandbox`, arbitrary page, supplied script, navigation URL, listener or persistent profile.
`finally` closes every context and the browser; cleanup receipts are inside this lane's outputs.

The tracked captured-input.json is **actual browser output**, not handwritten geometry. It contains
only synthetic fixture catalogs, metrics and source identities. Do not substitute boxes to create a
passing report. The deliberate coherent-forgery regression documents that offline identities are
not cryptographic attestation of browser execution. The verifier binds current checked source,
ZIP runtime, actual manager approval and capture provenance. It checks SHA equality, not a signed
publication or a clean committed-tree rebuild. All original RED/failure logs are retained.
