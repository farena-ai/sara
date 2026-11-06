# Developer security fixtures

All artifacts, identities and credentials are synthetic. Classic provider-shaped credential strings are assembled only at test runtime, not stored as literal test tokens. Ed25519 key pairs are generated in memory; no private keys or owner data are retained.

- `package-lock-v3.json`: intentionally hand-authored four-path npm shape for targeted SPDX unknown/denial/exception and all-zero digest tests. The zero digest is a deliberate synthetic SRI value, not a claim about downloaded bytes.
- `npm-generated-v3.json`: actual npm `install --package-lock-only --ignore-scripts --no-audit --no-fund` output using synthetic root `synthetic-lock-fixture@1.0.0` and exact dependencies `@types/estree@1.0.6`, `is-number@7.0.0`, `is-odd@3.0.1`. The latter resolves nested `is-number@6.0.0`; names, SPDX metadata and SHA512 integrities are actual npm registry metadata.
- `npm-generated-v2.json`: actual npm conversion of the same generated lock with `--lockfile-version=2 --package-lock-only --ignore-scripts --no-audit --no-fund`; its redundant legacy dependency tree is intentionally not used as an installed-path inventory.

Generation ran only in an owned Hermes scratch directory; no dependency code was installed or executed and the scratch was removed afterward. Registry metadata retrieval is not a live account integration or artifact integrity verification. Version/hash evidence and output BOMs are under `outputs/developer-addons/security/`. Tests validate actual emitted BOMs against the unmodified authoritative CycloneDX1.5 schema with its SPDX/JSF references using scoped pinned Ajv tooling.
