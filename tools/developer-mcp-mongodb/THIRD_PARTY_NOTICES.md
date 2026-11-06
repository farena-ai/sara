# MongoDB qualification dependency attribution

This directory is a **blocked qualification dependency scope**, not an adapter, server,
installable recipe, or production integration. It contains no MongoDB binary distribution.

- `mongodb-mcp-server` 3.2.2: MongoDB, Inc.; Apache-2.0;
  https://github.com/mongodb-js/mongodb-mcp-server . Exact published source and its
  standalone LICENSE were inspected; original license retained in private qualification
  outputs (`upstream-LICENSE`) and installed package. Dependencies retain their own grants.
- `mongodb` 6.21.0: MongoDB, Inc.; Apache-2.0; https://github.com/mongodb/node-mongodb-native .
  Direct fixture-driver candidate only; not executed against a database.
- `package-lock.json` freezes registry URLs/integrity and the transitive resolution.
  Install only with `npm ci --ignore-scripts --no-audit --no-fund` within this directory.
  This is not a complete dependency-license clearance or security audit.
- MongoDB Community Server 8.0.34: upstream source `LICENSE-Community.txt` is SSPL-1.0,
  https://raw.githubusercontent.com/mongodb/mongo/r8.0.34/LICENSE-Community.txt .
  The Windows ZIP exceeds the authorized download budget and was NOT downloaded.
  ZIP legal contents, executable signatures and executable hashes remain uninspected.
  The MCP Apache license does not license the database server or authorize Cloud use.

Our qualification metadata/tests are MIT (standalone `LICENSE`). No upstream source or
binary is vendored into the public source files. npm deprecation warnings and the exact
resolution log are retained in `outputs/developer-addons/mcp-mongodb/npm-install.log`.
