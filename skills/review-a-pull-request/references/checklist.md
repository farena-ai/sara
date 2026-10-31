# Review checklist

## Correctness
- [ ] The change does what its description says.
- [ ] Empty input, one item, many items, very large input.
- [ ] Missing or wrong input gives a clear error, not a crash.
- [ ] Repeated calls and calls at the same time are safe.
- [ ] Time zones, dates and numbers are handled the same way as the rest of the code.

## Tests
- [ ] New behaviour has a test; a bug fix has a test that failed before.
- [ ] Tests don't depend on the clock, the network or the order they run in.
- [ ] No test was weakened or deleted to make the change pass.

## Security and data
- [ ] User input is checked before it reaches files, commands, SQL or HTML.
- [ ] No secrets, keys or personal data in the code, logs or test fixtures.
- [ ] Permissions: only the right people can reach the new code path.
- [ ] Anything sent off the machine is expected and documented.

## Compatibility
- [ ] Saved data and settings from older versions still load (migrations are additive).
- [ ] Public functions, routes and file formats keep working for existing callers.

## Readability
- [ ] Names say what things are; functions do one thing.
- [ ] Comments explain why, not what.
- [ ] Docs and the changelog are updated when behaviour changes.
