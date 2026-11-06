# Owned fixture capture

This is test-only capture of the fixed local fixture set, not a URL, live-page, CDP or personal-profile browser bridge. No downloads or installation are performed. Supply both `SARA_PLAYWRIGHT_MODULE` (absolute path to the preinstalled Playwright `index.mjs`) and `PLAYWRIGHT_BROWSERS_PATH` (its browser cache) **on the command invocation**, together with `ACCESSIBILITY_OWN_BROWSER=1`. There are no owner-specific defaults. Missing either setting refuses before import or launch.

Use Playwright 1.62.1 and matching Chromium revision 1234. The collector verifies version/revision, uses `chromiumSandbox:true`, creates fresh owned temporary profiles, aborts network requests and blocks service workers. Set TEMP/TMP/TMPDIR to an explicit owned scratch directory and DEBUG=pw:browser when collecting cleanup receipts. Do not use --no-sandbox, global environment changes or an existing personal profile.

Run `node tools/developer-accessibility-auditor/capture-owned.mjs`, then the scoped tests, scoped TypeScript config and `verify.ts`. Preserve old evidence before recapture. Baseline rule observations and naming positive/precision controls are recorded separately; bounded structural findings and explicit naming uncertainty are not full accessible-name or WCAG conformance claims.

## Offline recorded oracle

Default tests read `test/fixtures/developer/accessibility-auditor/recorded-browser-evidence.json`, not private `outputs/`. This is an actual recorded observation of synthetic owned fixtures, explicitly `freshCapture:false`; running the default test does **not** launch a browser or claim a fresh capture. Independent recorded axe names/targets and Chromium geometry/ARIA snapshots are compared with current offline semantics and fixture hashes.

Only a successful explicit owned-browser run refreshes the public fixture, after all assertions and context/browser closure. `recorded-evidence.mjs` recursively selects a closed field allowlist, never spreads receipts, process IDs, profile/module paths or log objects. Public metadata binds the private evidence SHA256, collector source SHA256, projection source SHA256, axe source and naming-case/source/screenshot hashes. `verify.ts` requires exact deep equality with the allowlisted actual private capture plus current source/hash provenance and private cleanup receipts. Hashes are provenance bindings, not independent proof that a public consumer freshly ran Chromium.

The allowlist is specific to these fixed synthetic inputs; it is not a general private-data scrubber for arbitrary pages or arbitrary content in allowed string fields. The capture admits no such inputs. Keep owner-pattern scanning in the parent export gates. Missing module/cache or missing explicit capture opt-in refuses without launch or public refresh.
