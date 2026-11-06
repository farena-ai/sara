# Localization QA

Check explicitly supplied flat JSON catalogs for missing/extra keys and named-placeholder
mismatches, including multiplicity, escaping and types. Supply an **actual render report** for
layout checking; absent evidence is visibly `not-measured`, never “all translations valid”.

This native plugin does **not** launch a browser, read a workspace, open an application URL,
capture a desktop or execute application scripts. It has no network/model/broker permissions.
The trusted developer-only capture utility outside this package renders only the checked-in static
synthetic fixture with preinstalled Chromium; it is not a live-capture feature or selected-root grant.

## Inputs and grammar

Tool `check` takes `base` and `target` as raw JSON strings, `grammar: "named-v1"`, and optionally
`evidence` matching `schema.json`. Flat, nonempty string maps only: 32 keys, key length 128
UTF-16 code units, value length 512 UTF-16 code units; each raw document <=24,000 UTF-8 bytes. Duplicate decoded keys, nested values,
prototype names and malformed JSON refuse. No file paths or URLs are accepted.

Only `{name}`, `{name:string}`, `{name:number}` are placeholders; names are ASCII identifiers
starting with a letter, at most 32 characters. Implicit string and explicit string are identical.
Order may change, multiplicity and type may not. Backslash escapes `{`, `}` and backslash only.
Braces otherwise require named-v1 placeholders. ICU plural/select, double braces, positional braces,
custom types and malformed escapes refuse the whole request. Only named-v1 is validated. Plain
`%s` and `%d` are literal text, not validated as printf placeholders; changing or dropping them
need not produce a finding. All entries, including extra/missing ones, are parsed. This is not an
ICU parser, Unicode well-formedness/bidi safety checker, markup validator or translation-quality validator.

## Render evidence and identity

Evidence is accepted only for `localization-owned-v1`, exact fixture HTML digest, Chromium,
DPR1, 16px Arial, viewports390x720/900x720, fixed180x24 cells. Every common key needs exactly
one baseline/target pair per viewport. Raw catalog digests and each measured text digest must match.
Metrics must be finite/bounded, inside the viewport, have matching control geometry and internally
consistent client/scroll/range dimensions. Baseline overflow refuses; target overflow is derived
from measured scroll dimensions > client dimensions +1 CSS pixel, not string length or a verdict.
These are literal template-text measurements, not application interpolation or full UI correctness.

Reports expose only ordinal `k001` key references (lexicographic UTF-16 ordering, independent
base/target sides), kind and numeric overflow. Resolve locally against the corresponding catalog;
references are invocation/catalog scoped, not globally stable identifiers. Results/cards/errors
never copy catalog keys, translations, hashes or supplied paths. No automatic secret detection is
claimed. Inputs pass through Sara tool arguments and may be visible in host review/history or to
its configured model; do not supply private catalogs without that consent. The host's generic
argument summarizer is outside this plugin's privacy guarantee. The capture utility stores only
synthetic public fixture contents, hashes and screenshots. SHA identities are consistency checks,
not signatures or proof that an untrusted submitter actually ran Chromium. Trust the capture source
and provenance separately; forged coherent geometry cannot be authenticated by this offline tool.

## Limits

The entire request must satisfy `JSON.stringify(args).length <=65536` (65,536 serialized UTF-16
code units, matching the real manager) AND <=180,000 serialized UTF-8 bytes, including outer JSON
escaping, property names, grammar and optional render evidence. Two individually valid catalogs
can exceed this combined cap and refuse; quotes, backslashes and controls amplify on serialization.
Do not sum raw catalog sizes to infer host usability. Schema `maxLength` counts Unicode code points,
not UTF-8 bytes or JavaScript UTF-16 units; all runtime limits apply together, without lowering
independent catalog limits. Depth12, inspected nodes5000; unknown fields,
accessors, hidden properties, callbacks, cyclic references and exotic prototypes fail closed on
in-process calls. Proxies are not an isolation boundary. JSON transport cannot carry callbacks.
Output is refused above46,000 content bytes/60,000 framed bytes, below host64KiB content/1MiB
channel caps. No dependencies besides the exact standalone Sara SDK and Node built-ins.

Six locales: en/es/fr/de/pt-BR/it for descriptions, cards, explanatory and error text. Protocol enums
and ordinal evidence references remain literal. Ask permission; explicit install trust/enable required.
Qualification covers the isolated2.67 authoring host with explicit2.68 packaging target, not the
complete2.68 app, chat approval, Windows OS sandbox, arbitrary apps or signed publication.
