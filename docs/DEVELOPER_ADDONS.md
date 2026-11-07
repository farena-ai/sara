# Developer add-ons

The nineteen native packages below are **released through the signed Sara Store**, with
Sara2.70.0 installation and registered-host checks on Windows and Linux. HTTP and Webhook
Workbench additionally passed installation and scripted chat-approval checks against the
current Sara2.71.0 source. Browse the
[Developer collection](https://backstagecoding.com/sara/store/browse/category/developer/), or open
**Settings → Add-ons → Get more** in Sara. Review permissions before installing; installation
leaves the add-on Off until you explicitly enable it for a companion.

Each package has a bounded supported scope, shown below and on its listing. The remaining
developer targets and MCP qualification previews are not promoted by this release. Normal chat
approval and account/provider acceptance remain distinct from synthetic host checks; N21 has
explicit scripted-model chat approval evidence, not real-provider or owner-UI acceptance.

## Released native add-ons

| Add-on | Useful work performed | Scope you must not assume |
|---|---|---|
| API Contract Guard | Compares supported OpenAPI JSON operations, request acceptance and response guarantees; reports breaking changes with exact document pointers | Not complete OpenAPI/JSON Schema support; unsupported semantics are refused, never silently declared compatible |
| Secret Scanner | Detects five documented credential-pattern families with redacted file/line/column findings | Not an automatic workspace/history scan or proof that no secret exists |
| License Auditor | Inspects npm lockfile installed paths and SPDX expressions against explicit allow/deny rules | Supplied license metadata is not verified legal advice; unknown/review decisions remain visible |
| SBOM Builder | Produces deterministic CycloneDX1.5 dependency inventories with nested/scoped package identities and validated SRI hashes | Not a complete dependency-edge graph or proof that downloaded artifacts match the lockfile |
| Artifact Provenance Verifier | Checks actual SHA256/Ed25519 signatures, independently expected identity and pinned public-key fingerprint | Supports the documented local attestation format, not Sigstore, DSSE, certificates or SLSA certification |
| Coverage Explorer | Parses real LCOV branch/count/location evidence against supplied source and changed ranges | Does not run tests; unknown or contradictory coverage is not declared covered |
| Log Explorer | Searches structured/multiline logs with redacted timestamp/file/line citations | Pattern/literal redaction is not universal secret detection; incomplete pages remain incomplete |
| Incident Workbench | Correlates explicitly supplied operational evidence into cited chronology | Ordering does not prove causation or recovery; missing/ambiguous evidence stays explicit |
| Environment Config Doctor | Validates bounded dotenv/flat JSON against typed configuration rules without returning values | No vault import, automatic workspace scan or erasure of submitted chat arguments |
| Database Fixture Studio | Generates seeded synthetic relational rows and SQLite SQL, verified against actual constraints | SQLite-only supported constraints; no production import or live database connection |
| Schema and Data Contract Validator | Uses real JSON Schema/Protobuf parsers and payload validation with compatibility checks | Bounded documented vocabularies; unsupported refs, composition and complex Protobuf constructs refuse |
| Change Impact Analyzer | Resolves supported lexical AST imports/calls from supplied source snapshots to affected callers, packages and tests | Not runtime coverage; ambiguous/escaping/unsupported relationships remain incomplete rather than invented |
| Architecture Guard | Finds supported forbidden imports, dependency cycles and layer violations in real parsed source | Supplied snapshots only; not an automatic workspace scan or proof about dynamic dependency loading |
| SQL Migration Reviewer | Executes a closed additive migration rehearsal against a bounded in-memory SQLite database and verifies rollback | No live database, destructive/general SQL, hard OS deadline or automatic project authority |
| Visual Regression | Decodes admitted bounded RGB/RGBA PNG pairs and reports exact changed pixels and rectangles | Supplied images only; no desktop/live capture, perceptual tolerance or arbitrary PNG-format support |
| Localization QA | Checks flat catalogs and named placeholders; derives overflow from consistent owned-render measurements | Offline evidence analysis, not live capture, full ICU/printf support or authenticated browser attestation |
| Accessibility Auditor | Parses real HTML5 and identifies seven bounded structural finding types with source/element coordinates | Static scope, not full accessible-name/WCAG or a live browser grant; uncertain naming/rendering stays explicit |
| Build Cache Inspector | Measures actual operator-staged native-home cache files and previews bounded pruning choices | No apply/delete, selected-project grant, OS-enforced read-only home or hostile-writer race proof |
| HTTP and Webhook Workbench | Sends bounded JSON requests to an explicitly configured owned loopback service; compares one explicit replay and redacts known sensitive fields/values | No public listener, external/LAN URLs, queries, chunking, compression or general secret detection. Requests can have effects; replay may duplicate them. Synthetic data only; supplied arguments can remain in host/model history |

These packages use **explicit bounded inputs**, without model or delegated-tool permissions or
automatic workspace authority. HTTP and Webhook Workbench explicitly grants brokered local
network access; its requests can have effects. Results use invocation-scoped cards. See each source package's README under
`store/plugins/` for its actual schema, limits and fixture examples. Synthetic previews are not
screenshots of a live application. Do not paste real credentials into chat; scanner/config
redaction of returned findings does not erase input already present in a conversation. Cache
inspection additionally reads its own explicitly staged plugin-data namespace; this is not
permission to inspect an owner's arbitrary build caches. Snapshots may stale after a preview.

The manifests require Sara >=2.68.0 <3.0.0; the current release was exercised with Sara2.70.0,
Windows Node24.20.0 and Linux Node24.22.1. Linux's default bubblewrap package smoke also passed.
The actual public signed downloads were verified and installed through StoreClient/StoreInstaller,
with first-party consent, Off-by-default installation and explicit enable/disable checks. This
does not claim complete application/chat approval or macOS qualification.

## Lab add-ons: local candidates, not yet released

Three further packages appear in **Settings → Plugins → Workflow candidates** only. They are
host-tested on Windows against the current development source (official package smoke, real
manager trust/enable/run/result card/disable on synthetic staged fixtures); they are not signed,
Store-listed, Linux-qualified or chat-approval accepted. Each runs only what a trusted operator
staged in its own native data home while it was disabled, and only after a `plan`/`preview` hash
is passed back unchanged.

| Add-on | Useful work performed | Scope you must not assume |
|---|---|---|
| Performance Regression Lab | Runs staged `baseline.js`/`candidate.js` benchmarks with warm-up and ABBA-interleaved samples, returns every raw sample, bootstrap interval and Mann-Whitney z; calls a regression only past your threshold | Noisy (relative MAD over 0.25) or under-10-sample runs are inconclusive with no percentage; one host's timings only |
| Code Migration Studio | `rename-named-import` v1: scope-aware Babel AST preview over selected `.js`/`.mjs` files, then applies only that hash-bound patch to the staged workspace copy and verifies every written file | Refuses namespace imports, re-exports, dynamic imports, conflicts, links, unselected or stale files and syntax errors; never touches the real project; runs no compiler/tests (do that on the copy) |
| Build Reproducibility Inspector | Executes a staged `build(inputs, env)` twice in fresh contexts with different clocks and build roots; compares per-file/tree SHA-256 and explains timestamp/path differences with line evidence | JavaScript build functions only, not compilers, package managers or child processes; other differences stay unexplained |

Staged scripts run in `node:vm` contexts (string code generation and WebAssembly off, no host
objects, per-call timeouts) inside the permission-limited plugin process. That is not an OS sandbox
on Windows node-only mode: stage only code you trust. Tests:
`node --test --test-concurrency=2 test/developer-performance-regression-lab*.test.ts test/developer-code-migration-studio*.test.ts test/developer-build-reproducibility-inspector*.test.ts`.

**Held:** Offline and PWA Auditor (N18) needs a real browser engine with an isolated profile and
offline control; native plugins have no child-process or browser authority and fenced host
execution (H3) has no browser or device authority (plugin jobs run only `node`/`npm`), so an emulated service worker or recorded trace would not meet its
acceptance. Mobile Device Lab (N30) needs a real build, install and log on a dedicated emulator or
explicitly selected test device, owner device consent and the same H3 execution authority; a
protocol fixture cannot produce those receipts.

## Typed local workbench foundation

`tools/developer-workbench/` exposes only `contract_diff` and `repo_map` over real stdio MCP.
An administrator stages reviewed fixture snapshots into its own home; remote callers cannot
choose arbitrary host roots or commands. Mapping returns real file hashes and refuses changed
or unindexed data, unsafe paths, links and exhausted budgets.

It does not execute a documented build; the native Repository Onboarding add-on above does that
as an approved job. A server's
own data-home mount is not a selected-project grant. There is no installable Store recipe until
saved disabled/Ask defaults and other runtime requirements are guaranteed.

## Run/build/test add-ons on the host job (H_EXEC)

These add-ons promise to actually run a documented build, test, gate or command. Until now none
could: a plugin process cannot start programs (Node permission model: `ERR_ACCESS_DENIED`), and the
only route, Sara's `shell` tool through `callTools`, runs in the owner's main workspace (no sandbox
on Windows) and, until this fix, still ran when approved after the plugin's 30-second invocation
had expired. Now a plugin with `permissions.run` can ask for an **owner-approved, cancellable job
in a disposable copy** (`job.run`, [ops/H_EXEC_DESIGN.md](ops/H_EXEC_DESIGN.md)): the card shows the
exact command; the copy has no `.git`, links or dependency folders and is deleted afterwards;
nothing is written back. On Linux with bubblewrap the job is OS-sandboxed without network; on
Windows and elsewhere it is **not OS-sandboxed** (Node's permission model only, `node` only, no
child processes). Approvals and jobs end with the plugin request that asked for them.

These are built as local candidates (Settings → Plugins → Workflow candidates; not signed,
Store-listed, Linux-qualified or chat-approval accepted; the operator stages a project under
`projects/<name>` in the plugin's data home while it is switched off):

| Add-on | Useful work performed | Scope you must not assume |
|---|---|---|
| Test Doctor (N03) | Runs one exactly named test once (`node --test`, TAP) as an approved job, then reports the real failing assertion (operator, expected, actual, line) and the source of the imported functions that line calls | Timeouts, todo (expected) failures and non-assertion errors get no root cause; runtime frames are never blamed; Node test files only |
| Flaky Test Lab (N04) | Repeats one named test 2–20 times in **one** approved job (fresh imports seeded through `globalThis.SARA_FLAKY_SEED`), keeps every seed's outcome and duration, a 95% interval, and says *flaky* only for mixed outcomes | Always-pass/always-fail are not flaky; stopped, timed-out or incomplete runs give no verdict; state outside the module is shared |
| Documentation Doctor (N24) | Checks the staged Markdown's local links and heading anchors (file and line; external links listed, never fetched) and lists the commands shown in shell code blocks; runs one of them only when you choose it, as an approved job, and reports its real exit code and output | Only `node`/`npm` commands without shell syntax; comments, inline code and prose are never run. `npm` commands are **held on Windows** (no OS sandbox for npm) and run only inside bubblewrap on Linux (guarded test, not yet run on a Linux host) |
| Release Readiness (N10) | Reads the staged project's versioned gate profile (`release-gates.json`: id, requirement, node/npm command), runs **one approved job per gate** and returns each real exit code, output SHA-256 and tail; *ready* only when every gate passed, *blocked* naming the failing requirement, *incomplete* when a gate was held, declined or stopped | Local gates only: publish, sign, upload, deploy or CI gates refuse before anything runs. `npm` gates are **held on Windows** (bubblewrap only; Linux guarded test not yet run on a Linux host) |
| Repository Onboarding (N01) | Maps the staged repository without running anything (languages, folders, `package.json` manifests, lockfiles, docs, the README's prerequisites as met/missing/unverified and its Build-section commands), then reproduces one documented build as an approved job with a receipt: real exit code, output tail and SHA-256, files created in the copy | Only README Build-section commands, exactly as written; invented commands and missing documented files or Node versions refuse. `npm` builds are **held on Windows** (bubblewrap only; Linux guarded test not yet run on a Linux host). The workbench `repo_map` below is unchanged |

Tests: `node --test --test-concurrency=2 test/developer-test-doctor*.test.ts test/developer-flaky-test-lab*.test.ts test/developer-documentation-doctor*.test.ts test/developer-release-readiness*.test.ts test/developer-repository-onboarding*.test.ts test/plugin-exec-job*.test.ts test/plugin-late-approval.test.ts`.

**Still held:** Dependency Upgrade Workbench (N07) needs `npm`, which plugin jobs refuse without an OS sandbox, plus an offline
fixture registry; it waits for Linux/bubblewrap qualification. No supplied-text stand-ins are
offered in their place.

## Developer MCP connections (M01–M30)

Settings → Add-ons → Other programs (MCP) → **Developer connections** lists all thirty MCP
targets: 2 fixture-tested, 22 needing your account or service, 6 blocked.

| State | Targets | What you can do |
|---|---|---|
| Fixture-tested | Storybook, Qdrant (local) | *Copy into the add form* (switched off), review, then *Save and connect* |
| Needs account | Postman, AWS, Azure, Google Cloud, Terraform, Kubernetes, Argo CD, Netlify, Redis, Elasticsearch/OpenSearch, ClickHouse, Snowflake, Neon, Pinecone, Datadog, Grafana, New Relic, PostHog, LaunchDarkly, Auth0, Jenkins, Buildkite | Read the owner step on the card; no install action |
| Blocked | Local Git, Pulumi, Vercel, MongoDB, Stripe, CircleCI | Read the reason; no install action |

Storybook connects to the MCP endpoint of `@storybook/addon-mcp` 10.6.6 inside your own Storybook
(`storybook dev -p 6006 --host 127.0.0.1`), dev toolset only. Qdrant runs
`uvx --python=3.12 mcp-server-qdrant==0.8.1` with an embedded collection in the server's own
folder; read-only is on by default, which leaves only `qdrant-find`. Its first start downloads a
small embedding model from Hugging Face. After either connects, set every tool to *Ask me first* or
*Off* in Tools and approvals and read the settings back. Pins, integrity values, licences and the
fixture evidence are in the private qualification ledger; the opt-in acceptance test is
`test/developer-mcp-batch-host.test.ts` (`MCP_BATCH_QUALIFY=1`).

## Local Git is still blocked for project use

The pinned upstream can inspect real disposable repositories through Sara, but its read-only
diff operations can execute external diff/textconv commands from repository configuration;
config includes can read outside the chosen repository. An Ask label or repository-path check
is not an OS fence. The source recipe stays an unpublished qualification preview, not a safe
production launch. It also does not reproduce the fully hash-locked qualification environment.
Do not admit owner or untrusted repositories through it.

## Reproduce the current native/workbench tests

Use the tested Node24.20 runtime, the repository's normal locked development install, and a
disposable cache scratch folder. Scoped security/data/graph qualifications need their locked tooling:

```bash
npm ci --prefix tools/developer-security --ignore-scripts --no-audit --no-fund
npm ci --prefix tools/developer-data --ignore-scripts --no-audit --no-fund
npm ci --prefix tools/developer-code-graph --ignore-scripts --no-audit --no-fund
npm ci --prefix tools/developer-visual-regression --ignore-scripts --no-audit --no-fund
npm ci --prefix tools/developer-accessibility-auditor --ignore-scripts --no-audit --no-fund
node --test --test-concurrency=2 test/developer-security.test.ts test/developer-security-scanner.test.ts test/developer-security-channel.test.ts test/developer-security-host.test.ts
node --test --test-concurrency=2 test/developer-workbench.test.ts test/developer-workbench-variance.test.ts test/developer-workbench-map.test.ts test/developer-workbench-protocol.test.ts test/developer-workbench-host.test.ts test/developer-api-contract-guard.test.ts
```

These run actual analyzers, native subprocesses, official packaging/smoke and registered-host
lifecycles against synthetic data. Windows Node permission tests do not establish an OS sandbox.
The frozen eighteen-package source snapshot passed the complete root suite and a fresh exported
subset before current-host and signed-release checks. That does not qualify later source edits
or the separate execution-sandbox experiment. Account, paid-service, personal-device and normal
conversation approval acceptance remain separate; no account or provider calls were used to
qualify these local-only add-ons.

## MongoDB local fixture tier remains blocked

Real authenticated fixture reads, schema and indexed explain ran against the pinned official
upstream and disposable local engine. Write, foreign-namespace and JavaScript denials were
exercised. However `find(limit: 0)` returned twenty fixture documents despite a configured
maximum of five. The expected-correctness failure is retained; default source/policy tests
passing do not close it. There is no installable recipe, normal owner account qualification or
production admission. Read-only annotations alone do not bound query size or prevent dynamic
connection tools; inspected actual disabled-tool controls remain necessary.
