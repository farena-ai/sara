# License auditor

Audit npm lockfile v2/v3 license metadata and SPDX expressions against an explicit allow/deny policy. Unknowns require review; not legal advice.

Self-contained native Sara plugin1.0.0; Sara >=2.68.0 <3.0.0; Node24+. Tool: analyze. Disabled until reviewed and explicitly enabled for a companion; defaults Ask.

No model, network, shell, subprocess, workspace-read, persistence or independent card-post permission. Input is explicit bounded data. Native invocation-scoped result.card is attached by the host; cards:false deliberately forbids independent broker posts. All nested tool schemas are closed and repeated at the handler boundary.

## Policy semantics

Accepts explicit npm package-lock JSON v2/v3 plus path-keyed license metadata overrides and explicit allow/deny arrays of atomic SPDX rules. Uses actual installed paths, including scoped and nested entries; ignores the redundant legacy v2 dependencies tree. Explicit metadata overrides lockfile license strings. Duplicate or unknown metadata paths are refused.

Bundled spdx-expression-parse4.0.0 parses parentheses, AND, OR, WITH, plus and LicenseRef/DocumentRef. Identifier lists are pinned; malformed or unrecognized expressions become review without echoing malformed input. Missing metadata is unknown. Atomic matching includes the exact exception and plus semantics: MIT permission does not authorize every WITH combination or every later-version license. Rule whitespace is normalized by parsing. Deny wins for the same atom. AND requires every operand allowed; any denied operand denies it. OR allows an explicitly allowed alternative; all-denied alternatives deny; other combinations require review. LicenseRef/custom rules not listed remain review.

These are configured policy decisions, not a universal legal approval, source-license inspection, compatibility guarantee or legal advice. Review applicable obligations and metadata quality yourself.

Limits:65536 UTF8 bytes of JSON,60 installed paths,240 code units/path,128/package name,80/version,256/expression,60 overrides and60 atoms per policy list. Reject links/workspace paths, unsupported versions and malformed identities. Outputs never include registry URLs or package source text.

Example: analyze({lock:PACKAGE_LOCK_JSON_TEXT,metadata:[],policy:{allow:['MIT','Apache-2.0'],deny:['GPL-3.0-only']}}).

## Third-party sources

Runtime vendor files are local and do not require installation. spdx-expression-parse4.0.0 (MIT), spdx-license-ids3.0.24 (CC0-1.0), spdx-exceptions2.5.0 (CC-BY-3.0; Linux Foundation/SPDX attribution retained). See THIRD_PARTY.md and vendor notices.

## Results, languages and limits

content is JSON with machine status plus localized message/scope; card contains localized title/summary. English, Spanish, French, German, Brazilian Portuguese and Italian are covered in actual ready descriptions, successful output/card and refusal tests. Source identifiers, SPDX expressions, crypto/format identifiers and machine status codes remain literal. Unknown locale falls back to English. Input errors never echo user values. Successful content is limited to48000 UTF8 bytes and the serialized channel envelope to60000 bytes; oversize requests are refused, not silently clipped.

shots/1.png is a clearly labelled SYNTHETIC FIXTURE PREVIEW generated from an actual fixture handler result; it is not an app screenshot. Qualification: test/developer-security*.test.ts and docs/ops/DEVELOPER_SECURITY_QUALIFICATION.md. Windows node-only is NOT an OS sandbox; manager/registered-tool qualification is not ordinary chat-approval or paid-provider proof. Unsigned local packages are not signed/published store releases.
