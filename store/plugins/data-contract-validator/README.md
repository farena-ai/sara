# Schema and Data Contract Validator

Explicit-input offline contract comparison and actual payload validation. Register `analyze` with Ask permission. No file, network, model or broker grants. Uses pinned Ajv 8.17.1 (MIT) and protobufjs 7.5.4 (BSD-3-Clause); retained notices in THIRD_PARTY_LICENSES.md.

```json
{"format":"json-schema","before":"{\"type\":\"integer\"}","after":"{\"type\":\"string\"}","payloads":["1","\"synthetic\""]}
```

For Protobuf use `format:"protobuf"`, .proto source strings including syntax declaration, `message:"Item"`, and JSON object payload strings. Parser/verify/encode/decode are real library operations. Output distinguishes compatibility/breaking changes from each payload's validity and includes encoded wire length for valid Protobuf.

JSON Schema draft-07 admitted subset: single type, properties, required, boolean additionalProperties, homogeneous items, enum, numeric min/max, string length and array length bounds, title/description. New required fields, type/enum narrowing, tighter bounds and formerly open property/item restrictions break backward acceptance. Adding an optional property to a previously closed object is compatible.

Protobuf supports flat messages, packages, top-level enums, repeated scalar fields, 32-bit signed/unsigned integers, float/double, string and bool. Compatibility keys on field numbers/type/cardinality and enum numbers. Resolved enum declaration/member renames preserving numeric acceptance are wire-compatible, as are field-only renames; JSON-name compatibility is NOT implied. Enum declarations must contain safe integral signed-int32 values; proto3 starts with zero. Syntax must be explicitly declared, with real parser validation beyond these checks. Signed/unsigned ranges and float32 overflow are checked explicitly. Every admitted payload is encoded and decoded, then supplied field values are compared: float32 uses its normalized IEEE-754 rounding, doubles and other numbers retain numeric identity. Lossy string wire round trips refuse payload validity too.

Backward acceptance recognizes integer-to-number and omitted-type widening. Empty/annotation-only property and items schemas retain unrestricted fallbacks. Enum equality is structural: object member order is irrelevant, array order remains significant. The bounded comparator is conservative, not a complete schema-inclusion theorem; genuine type/bound/required/closed-object and nested restrictions remain breaking.

Unsupported constructs **refuse**, not silently pass: all JSON Schema refs/local recursion/definitions/combinators/formats/regex/custom code; Protobuf imports/services/nested messages/message references/recursion/maps/oneof/options/reserved/extensions/bytes/64-bit integers. Not full standard compatibility or live workspace access. Caller code is never accepted; Ajv internally generates validators from guarded schemas.

Limits: contracts 16384 characters each, 20 payloads of 8192 characters; parsed depth 12 / 2500 nodes; 80 Protobuf declarations, 40 fields/message, 40 enum values, 100 repeated entries. Complete closed tool shape in schema.json. Malformed/deep/prototype inputs and output above 46000 content / 60000 envelope bytes refuse. Six real channel locales cover ready descriptions, result cards/messages and non-echo errors. Protocol fields, schema paths and diagnostic reason identifiers remain stable technical identifiers.

`shots/1.png` is a labelled synthetic preview from actual handler output. Authoring host 2.67; official 2.68 package assessment does not claim the complete 2.68 application or OS sandbox ran. Rebuild vendors with scoped locked tooling under tools/developer-data; URL solidus escapes preserve runtime strings while avoiding scanner false positives on inert schema IDs/comment URLs. No network permission was added.
