# Developer security package qualification tooling

This directory is local build/qualification tooling, **not** a plugin runtime dependency. Native handlers import only package-local files and Node built-in crypto. Scoped dependencies are exactly `ajv@8.17.1` and `spdx-expression-parse@4.0.0`; all transitive versions and registry SHA512 integrity strings are frozen by package-lock.json. Install reproducibly here with `npm ci --prefix tools/developer-security --ignore-scripts --no-audit --no-fund`, never globally or into the shared root. `node_modules/` is ignored. Dependency licenses: Ajv/fast-deep-equal/json-schema-traverse/require-from-string/parser MIT; fast-uri BSD-3-Clause; SPDX IDs CC0-1.0; SPDX exceptions CC-BY-3.0. The parser/list source and license notices were inspected before bundling; vendor runtime modules only parse bounded strings and local JSON. Ajv code-generates validation functions for the **fixed trusted official schemas** in tests; callers never supply schemas to this tool or plugin.

## Reproducible assembly and focused gates

Run with system Node24+, explicit Hermes scratch in TMPDIR/TEMP/TMP:

1. `node tools/developer-security/vendor-spdx.mjs` — reproduce inspected parser files; only local require paths adapted, lists/notices unchanged.
2. `node tools/developer-security/assemble.mjs` — reproducible schemas, locales, manifests, SDK copies and wrapper modules. Does not overwrite engines, READMEs, third-party notices or screenshots.
3. `node tools/developer-security/write-docs.mjs` — regenerate the four user README scope/format contracts.
4. `node tools/developer-security/previews.mjs`, then Windows `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/developer-security/render-previews.ps1` — render clearly labelled synthetic result-card previews. Does not run a plugin shell; these are packaging-only commands. UTF8 read is explicit for Windows PowerShell5.
5. `node --test --test-concurrency=2 test/developer-security.test.ts test/developer-security-channel.test.ts test/developer-security-host.test.ts` — real parser/crypto,24 locale permission-limited channels, actual PluginManager trust/enable/invoke/card/disable and official packaging/smoke. Host tests produce unsigned zip/receipt files under outputs/developer-addons/security.
6. Scoped TypeScript6: `node node_modules/typescript/bin/tsc --ignoreConfig --types node --noEmit --module nodenext --moduleResolution nodenext --target es2024 --strict --skipLibCheck --allowImportingTsExtensions --verbatimModuleSyntax test/developer-security.test.ts test/developer-security-channel.test.ts test/developer-security-host.test.ts`.

Parent owns combined/full gates, catalog/SDK inventory integration, Settings UI, Git and publication. Do not run the full npm gate while peer lanes edit. Re-run host tests after **any** package change, including README/declarations: the exact approved source and packed archive hashes must refer to final bytes.

## Authoritative format inputs (downloaded once; no network in handlers/tests)

- https://raw.githubusercontent.com/CycloneDX/specification/1.5/schema/bom-1.5.schema.json
- https://raw.githubusercontent.com/CycloneDX/specification/1.5/schema/spdx.schema.json
- https://raw.githubusercontent.com/CycloneDX/specification/1.5/schema/jsf-0.82.schema.json
- https://raw.githubusercontent.com/CycloneDX/specification/1.5/LICENSE (Apache2.0, retained as LICENSE-CycloneDX)
- https://raw.githubusercontent.com/package-url/purl-spec/main/types/npm-definition.json (scope percent encoding and examples; retained reference only)

All three unmodified schema files are compiled together by Ajv draft07. `validateFormats:false` deliberately disables optional format annotations; emitted inventory uses enum/pattern constraints, supported SRI lengths and explicit purl tests. Tests also reject an actually invalid component to prove schema validation is effective. The tool does not claim certification or universal CycloneDX profile support. Schema/purl bytes are pinned by the qualification evidence file, not silently re-fetched during a test. The tiny purl-types.rst file is an upstream redirect/reference retained from initial format lookup, not the authoritative npm definition.

Evidence scope and limits: docs/ops/DEVELOPER_SECURITY_QUALIFICATION.md. No accounts, paid APIs, providers, CI, network services, global installation or canonical workspace writes.
