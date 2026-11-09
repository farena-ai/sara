# Sara: notes for coding agents and contributors

Sara is a self-hosted AI companion and coding partner: TypeScript on Node 24, no build step, zero
runtime dependencies. Start with [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
and [CONTRIBUTING.md](CONTRIBUTING.md).

## Keep the documents current

A change is not done until the documents that describe it are updated in the same pull request:
the user docs in `docs/` and `web/help.html`, `docs/ARCHITECTURE.md` for structure changes,
`CHANGELOG.md` (under "Unreleased") for anything users notice, and README for headline features.
If a document disagrees with the code, fix one of them; don't leave a known-wrong document behind.

## Rules

- **Write the code yourself.** Don't copy code from other projects; no new runtime dependencies.
- **No credentials or personal data** in code, tests, docs or screenshots. Examples use invented
  people (the example owner is "Alex").
- **The safety layer is not optional** (`src/safety.ts`, `docs/COMPLIANCE.md`): AI disclosure,
  honesty when sincerely asked, crisis resources and the hard block on sexual content involving
  minors apply to every way in. Never add a switch that turns these off; changes to the minors check
  need tests for both what must block and what must not.
- **UI:** simple defaults; every setting has a **?** tip (`node scripts/tip-coverage.ts`); every
  string goes through `t()` with translations in `web/i18n/*.json` (`node scripts/i18n-extract.ts`);
  no inline `style=`.

## Commands

- `npm ci` · `npm run dev` · `npm run check` (typecheck + all tests; must pass).
- Before collecting a release, run `npm run release:check-presentation`. Keep all six README status
  versions, newest release rows/tag links and download/install/star actions current. Review feature
  claims against actual release evidence; do not advertise planned work as shipped.
- TypeScript runs directly under Node's type stripping: erasable syntax only (no enums, namespaces
  or constructor parameter properties) and `.ts` import extensions.
