# Test Doctor

Runs one exactly named test of a staged project once and tells you why it failed.

1. With the plugin switched off, stage a copy of the project in its data folder under
   `projects/<name>/` (plain files; no links). Stage only code you trust to run.
2. `diagnose` with `operation: "plan"`, the project, the test file and the exact test name. Nothing
   runs; you get a `planSha` bound to the staged files and the command.
3. `diagnose` with `operation: "run"` and that `planSha`. Sara shows you the exact command
   (`node --test --test-reporter=tap --test-isolation=none --test-name-pattern=… <file>`) and runs it
   only after you allow it, in a disposable copy that is deleted afterwards. Nothing is written back.

The answer is read from Node's real test report: the failing assertion (operator, expected,
actual), its line, and the source of the functions that line calls. A timeout, a test marked todo
(an expected failure) and an error that is not an assertion are reported as such, without a
root cause. Runtime frames outside the project are not blamed.

Fence: on Linux with bubblewrap the job is OS-sandboxed without network; on Windows and elsewhere
it is not OS-sandboxed (Node's permission model only, limited to the copy). Node test files only.
