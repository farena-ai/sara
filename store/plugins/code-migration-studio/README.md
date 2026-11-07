# Code Migration Studio

Run a **versioned AST codemod** over explicitly selected files and apply only the approved patch.
Tool `migrate` has two operations. `preview` parses each selected file with the bundled Babel
parser, computes edits and returns them with before/after SHA-256 digests and a `planSha`; it
writes nothing. `apply` recomputes the preview from the current bytes, refuses unless it yields the
same `planSha`, writes each changed file through a same-folder temporary file and rename, then
reads every selected file back and verifies the planned digest.

## Codemod `rename-named-import` version 1

Renames one named import (`from` → `to`) from one module. Relative specifiers are resolved per
file against the workspace-relative `module`. Unaliased imports rename the binding and every
reference Babel's scope analysis binds to it (shorthand properties become `from: to`); shadowed
names stay untouched. Aliased imports change only the imported name. It refuses namespace imports,
re-exports, dynamic imports of the module, reassignment, existing `to` bindings and any file that
fails to parse before or after migration.

## Staging and authority

With the plugin disabled, a trusted operator stages a **disposable copy** of the selected project at
`<plugin-native-data-home>/migration-v1/workspace`. Only files named in `files` (max 32 `.js`/`.mjs`,
256 KiB each) can change; links, junctions, hard links, `..`, absolute or backslash paths refuse.
The plugin never reads or writes the owner's real project or main workspace, runs no compilers,
tests or commands, and uses no network or model. Compile and test the migrated copy yourself before
taking its changes back. This is not a general refactoring engine or TypeScript support.
