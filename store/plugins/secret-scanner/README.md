# Secret scanner

Detect credential patterns in explicitly supplied text files; return locations and value-free finding IDs. No automatic disk scan.

Self-contained native Sara plugin1.0.0; Sara >=2.68.0 <3.0.0; Node24+. Tool: analyze. Disabled until reviewed and explicitly enabled for a companion; defaults Ask.

No model, network, shell, subprocess, workspace-read, persistence or independent card-post permission. Input is explicit bounded data. Native invocation-scoped result.card is attached by the host; cards:false deliberately forbids independent broker posts. All nested tool schemas are closed and repeated at the handler boundary.

## Detection and redaction

Accepts1–12 explicit objects containing a display path and text; does not read the path from disk. Detects classic GitHub token prefixes, AWS access-key IDs, private-key headers, credential assignments, and bearer strings. This is deliberately a small documented pattern set, not entropy analysis or a guarantee of no secrets. No provider validation, history scan, remote service, or automatic broad scan.

Each finding contains only detector, redacted display path, 1-based line/column, and SHA256 finding ID. IDs hash file ordinal, coordinates and detector (not secret values, low-entropy secret hashes, or paths); they are stable location IDs, NOT content identities. Matching values are held transiently to redact their occurrence in any finding path. Nothing is persisted by handlers. Paths containing detector matches are replaced in full. Output omits source snippets.

Limits:32768 UTF16 code units/file,65536 aggregate UTF8 bytes,160 code units/path,120 findings. CRLF/LF/CR lines supported. Empty text is valid. A limit error never returns a misleading partial scan.

Generic keys (`password`, `passwd`, `secret`, `token`, `api_key`/`api-key`/`apikey`, case-insensitive) accept bare assignments or matching single/double-quoted keys, including ordinary JSON. Values may be bare or matching quoted strings, including spaces, punctuation, Unicode, JSON escapes, and single-quote escapes in single-quoted values. Closing JSON object/array punctuation is not part of a bare value. Values are bounded to512 raw and decoded UTF16 code units; incomplete, empty, unsupported escaped/template, or oversized detected assignments refuse the whole request with a static localized error. This is a pattern scanner, not a JavaScript/template evaluator.

Redaction compares complete extracted values across all input files, not just their first whitespace-delimited token. Paths with percent/backslash encoding are conservatively withheld. If any quoted credential contains escapes, or a private-key header is detected, all finding display paths are withheld; line/column and location IDs remain. This deliberately avoids leaking decoded, encoded or alternate escaped spellings through a display path. Raw credential text, decoded values, private-key bodies and secret digests never appear in results/cards/errors.

Example: analyze({files:[{path:'synthetic/config.env',text:'password=synthetic-example'}]}). Returned data contains no matching value. Caller/model history may already contain supplied text; this plugin cannot erase host input history.

## Results, languages and limits

content is JSON with machine status plus localized message/scope; card contains localized title/summary. English, Spanish, French, German, Brazilian Portuguese and Italian are covered in actual ready descriptions, successful output/card and refusal tests. Source identifiers, SPDX expressions, crypto/format identifiers and machine status codes remain literal. Unknown locale falls back to English. Input errors never echo user values. Successful content is limited to48000 UTF8 bytes and the serialized channel envelope to60000 bytes; oversize requests are refused, not silently clipped.

shots/1.png is a clearly labelled SYNTHETIC FIXTURE PREVIEW generated from an actual fixture handler result; it is not an app screenshot. Qualification: test/developer-security*.test.ts and docs/ops/DEVELOPER_SECURITY_QUALIFICATION.md. Windows node-only is NOT an OS sandbox; manager/registered-tool qualification is not ordinary chat-approval or paid-provider proof. Unsigned local packages are not signed/published store releases.
