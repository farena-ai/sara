# Contributing

- No dependencies: the library and its tests use Node's standard library only.
- docs/LAYOUT.md is the specification. A change in behaviour starts as a change to LAYOUT.md;
  rule numbers are never reused or renumbered, a removed rule stays as "(withdrawn)".
- Every rule should have at least one test whose name starts with the rule number, for example
  `test('R21: ...')`. Tests that check how two rules work together name both.
- docs/EXAMPLES.md outputs are exact. If you change behaviour, regenerate them and check every
  line by hand against the rules.
- Keep `src/text/` free of table concepts (see docs/DESIGN.md).
- Files are UTF-8 without a byte order mark, with "\n" line endings.

Run the tests with:

```sh
node --test
```
