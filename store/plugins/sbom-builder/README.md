# SBOM builder

Build a deterministic CycloneDX 1.5 npm inventory from supplied lockfile v2/v3, including nested identities, purls and SRI hashes. No dependency install.

Self-contained native Sara plugin1.0.0; Sara >=2.68.0 <3.0.0; Node24+. Tool: analyze. Disabled until reviewed and explicitly enabled for a companion; defaults Ask.

No model, network, shell, subprocess, workspace-read, persistence or independent card-post permission. Input is explicit bounded data. Native invocation-scoped result.card is attached by the host; cards:false deliberately forbids independent broker posts. All nested tool schemas are closed and repeated at the handler boundary.

## Format and inventory scope

Emits a CycloneDX1.5 JSON BOM from npm package-lock v2/v3 packages entries. Root is metadata.component (application); every installed path becomes a library component, including nested duplicate versions and scoped identities. name overrides support npm alias identities. Stable bom-ref is SHA256 of install path, name and version. npm purls percent-encode scope @ and version; scoped components retain group. No timestamps or random serials: identical accepted input yields identical output.

SRI sha1/sha256/sha384/sha512 canonical base64 hashes are converted to official SHA-1/SHA-256/SHA-384/SHA-512 hexadecimal hashes after checking decoded lengths. Malformed or unsupported integrity refuses the request; absent integrity is omitted rather than invented. These are supplied metadata, NOT hashes of fetched artifacts. Source URLs and script bodies are never emitted.

Inventory only: no complete dependency graph, installed-files verification, vulnerability scan, source inspection, dependency install or build. Workspace links and non-node_modules paths are refused. License assessment is a separate plugin. Maximum65536 UTF8 bytes of lock JSON and60 installed paths. JSON wrappers can be refused if final output exceeds48000 bytes.

Actual generated fixtures from npm were validated against the unmodified official CycloneDX1.5 draft07 schema plus its SPDX and JSF refs, using pinned scoped Ajv8.17.1. Format annotations disabled; emitted fields rely on schema enums/patterns plus explicit purl/SRI tests. This is tested schema conformity for emitted inventory, not CycloneDX certification. Tools and schemas live in tools/developer-security and are not runtime dependencies.

Example: analyze({lock:PACKAGE_LOCK_JSON_TEXT}); report.bom is the complete bounded BOM, not a saved file.

## Results, languages and limits

content is JSON with machine status plus localized message/scope; card contains localized title/summary. English, Spanish, French, German, Brazilian Portuguese and Italian are covered in actual ready descriptions, successful output/card and refusal tests. Source identifiers, SPDX expressions, crypto/format identifiers and machine status codes remain literal. Unknown locale falls back to English. Input errors never echo user values. Successful content is limited to48000 UTF8 bytes and the serialized channel envelope to60000 bytes; oversize requests are refused, not silently clipped.

shots/1.png is a clearly labelled SYNTHETIC FIXTURE PREVIEW generated from an actual fixture handler result; it is not an app screenshot. Qualification: test/developer-security*.test.ts and docs/ops/DEVELOPER_SECURITY_QUALIFICATION.md. Windows node-only is NOT an OS sandbox; manager/registered-tool qualification is not ordinary chat-approval or paid-provider proof. Unsigned local packages are not signed/published store releases.
