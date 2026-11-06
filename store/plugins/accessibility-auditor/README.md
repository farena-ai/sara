# Accessibility Auditor

Offline, bounded HTML5 structural analysis using bundled parse5 8.0.0 (MIT). Supply a complete explicit HTML document to audit. No live browser, URLs, workspace, network, model, files, execution or delegation authority. Output does not echo supplied text, identifiers, attributes, URLs or selectors. Evidence is a source SHA-256 plus AST ordinal, closed tag, UTF-16 offsets and one-based line/column.

Rules: missing document language, image alternative, simple button/control name presence, duplicate IDs, missing/ambiguous ARIA ID references. This deliberately partial name check is not the accessible-name algorithm. Hidden/inert/aria-hidden and template contents are excluded from exposed-element findings; hidden ID targets can still participate in reference ambiguity. Decorative images and supported positive naming controls are honored.

Every finding is static, NOT a confirmed rendered violation. CSS, JavaScript, shadow DOM, custom/foreign elements and unsupported semantics explicitly require browser review. An empty report is never WCAG conformance. Contrast, focus, layout, live pages and dynamic states are not audited. No complete browser audit is promised.

Limits: 6000 UTF-16 input units, 24KB UTF-8; explicit html root; <=512 tree nodes, depth<=32, <=768 parser allocations, 32 parser errors, 64 findings; ID value<=256 units, reference field<=512 units and <=16 references. Atomic refusal, never clipped findings. Static report<=20KB, content<=24KB and channel<=32KB. A 500ms elapsed guard surrounds bounded work; it is not a preemptive OS CPU quota. Host 128MiB heap/30s invocation cap remain separate. Native runtime has no permissions beyond audit.

Qualification uses only trusted owned static fixtures in a fresh sandboxed headless Chromium with pinned axe-core, blocked network and service workers. Those fixture receipts are not live capture authority. Six-language native descriptions/cards/errors are included; protocol rule identifiers remain literal. Local candidate, not published or ready.
