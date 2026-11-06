# Bundled third-party SPDX sources

Runtime files in `vendor/` are derived only from these exact npm registry packages, whose resolved tarball integrity is pinned in `tools/developer-security/package-lock.json`:

| Source | Version | License | Distribution |
|---|---|---|---|
| https://github.com/jslicense/spdx-expression-parse.js | 4.0.0 | MIT | index.js/scan.js/parse.js renamed .cjs; only require targets rewritten to local files. Full LICENSE and AUTHORS retained. |
| https://github.com/jslicense/spdx-license-ids | 3.0.24 | CC0-1.0 | index.json and deprecated.json copied unchanged; README license notice retained. |
| https://github.com/jslicense/spdx-exceptions.js | 2.5.0 | CC-BY-3.0 | index.json copied unchanged; full upstream README attribution retained in NOTICE-exceptions.md. |

SPDX identifier/exception content attribution: Copyright ©2010–2015 Linux Foundation and its Contributors, Creative Commons Attribution3.0 Unported, https://creativecommons.org/licenses/by/3.0/. SPDX is a registered trademark of The Linux Foundation. CC0 dedication: https://creativecommons.org/publicdomain/zero/1.0/.

No runtime install, remote resolve, dynamic plugin load, network, or executable dependency. Parser source was inspected before bundling; it tokenizes local strings against local JSON identifier lists, then parses expression precedence into a tree. Errors from it are not exposed to callers. The host tool enforces bounded expression lengths before parsing.

`tools/developer-security/vendor-spdx.mjs` reproduces the local-require adaptations. `vendor/LICENSE-parser`, `vendor/AUTHORS`, `vendor/NOTICE-licenses.md`, `vendor/NOTICE-exceptions.md` retain upstream notices. Source BOM/schema tooling is qualification-only and is not included as a runtime import.
