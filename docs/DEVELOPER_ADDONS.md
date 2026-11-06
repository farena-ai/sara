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

## Typed local workbench foundation

`tools/developer-workbench/` exposes only `contract_diff` and `repo_map` over real stdio MCP.
An administrator stages reviewed fixture snapshots into its own home; remote callers cannot
choose arbitrary host roots or commands. Mapping returns real file hashes and refuses changed
or unindexed data, unsafe paths, links and exhausted budgets.

This is not complete Repository Onboarding: it does not execute a documented build. A server's
own data-home mount is not a selected-project grant. There is no installable Store recipe until
saved disabled/Ask defaults and other runtime requirements are guaranteed.

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
