# API Contract Guard

Local candidate, not published. Requires Sara **>=2.68.0 <3.0.0**, Node 24+. MIT; no dependencies or install scripts. Install via Sara's normal plugin review, trust the author if using Windows/node-only, and explicitly enable for the intended companion. Default permission: Ask. There are no hooks, schedules, settings, model calls, filesystem grants, network, brokered tools or separate card posts.

## Real capability and boundaries

`api_contract_guard__compare` accepts `{before: <OpenAPI JSON object>, after: <OpenAPI JSON object>}`. It runs the bundled deterministic semantic engine, returning complete bounded JSON and a localized invocation-scoped `result.card`. Documents are explicitly supplied, not read from invented filenames. `before`/`after` JSON pointers identify original document locations, including resolved local component references. The MCP companion adds actual staged file/hash evidence; this native facade claims **document-pointer evidence only**.

Removed operations, newly required parameters/body fields, removed response guarantees and incompatible type/enum changes are breaking. Request acceptance is contravariant; response production is covariant: narrowing request enums breaks callers, widening response enums breaks old consumers; narrowing response enums is compatible. Optional operations/parameters can be added compatibly. A new optional request property is compatible only when its schema accepts the old effective per-name schema: an absent additionalProperties means unconstrained, not forbidden. Adding a typed optional property to an open request object can therefore break callers; adding one to a closed request object widens acceptance. Removing a named property uses the new fallback, and a new response property must satisfy the old fallback. Explicit true/false and typed/ref fallbacks, nested properties, enum/nullability and required guarantees are compared in the same request/response variance. Response status additions are conservatively breaking because consumers may not accept them. Local recursive schema references terminate through visited pointer-pairs. Missing refs, reference-only alias cycles, remote refs and executable extensions are refused.

This is a **fail-closed OpenAPI 3.0/3.1 JSON subset**, not a complete OpenAPI validator or full JSON Schema implementation. It supports object/array/scalar type, properties/required, items, enums, nullable and additionalProperties; format/readOnly/writeOnly changes are conservatively breaking. It refuses composition (`allOf`/`oneOf`/`anyOf`), numeric/string constraints, security requirements, callbacks, links, response headers, path-item refs, boolean schemas and unsupported semantic keywords rather than returning a false compatibility pass. Descriptions/examples/defaults are annotations, not executed or repeated in results. No YAML, remote fetch or model interpretation.

## Limits and privacy

Each document: 256 KiB serialized UTF-8, 12,000 nodes, depth 32; strings 8,192 characters, object keys 160 characters; 128 findings and 16 KiB serialized result. Native combined argument envelope also has a 256 KiB limit. Oversized/unsupported inputs or output amplification fail visibly, not clipped. Stable machine codes and supplied identifiers/pointers remain literal. No schema values, examples, descriptions or enum members are emitted. Treat structural identifiers themselves as public evidence: do not place secrets in API paths, property names or reference identifiers. Sensitive-looking/high-entropy structural identifiers are refused. Error messages expose only bounded codes, never raw input or OS errors.

English, Spanish, French, German, Brazilian Portuguese and Italian cover names, ready descriptions, result summaries, cards and error introductions. Machine protocol codes are language-neutral. No settings means no missing setting tips. Windows Node permission limits are **not an OS sandbox**. No arbitrary repository access/build or provider/account qualification is implied.

## Fixture example

```json
{"before":{"openapi":"3.0.3","info":{"title":"Fixture","version":"1"},"paths":{"/pets":{"get":{"responses":{"200":{"description":"OK"}}}}}},"after":{"openapi":"3.0.3","info":{"title":"Fixture","version":"1"},"paths":{}}}
```

The finding is `operation-removed`, before pointer `/paths/~1pets/get`, after pointer `/paths/~1pets`. `shots/1.png` is a **FIXTURE PREVIEW — NOT LIVE PRODUCT UI**, rendered from actual engine output using synthetic contracts; not a screenshot of Sara or a deployed/account workflow. Actual manager/card acceptance and official pack/smoke receipts are recorded separately under `outputs/developer-addons/s1/`. Standalone `sara-plugin.mjs` remains byte-equal to the official SDK.
