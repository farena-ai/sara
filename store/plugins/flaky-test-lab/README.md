# Flaky Test Lab

Repeats one exactly named test of a staged project and tells you whether it is flaky.

1. With the plugin switched off, stage a copy of the project in its data folder under
   `projects/<name>/` (plain files; no links). Stage only code you trust to run.
2. `repeat` with `operation: "plan"`, the project, the ES module test file, the exact test name and
   `runs` (2–20). Nothing runs; you get a `planSha` bound to the staged files.
3. `repeat` with `operation: "run"` and that `planSha`. The plugin writes a small driver
   (`.sara-flaky/runner.test.mjs`, outside the plan hash) that imports the test file once per run
   with `globalThis.SARA_FLAKY_SEED` set to the run number (1…runs) while the module loads. Sara
   shows you the exact command and runs all repetitions as **one** job after you allow it, in a
   disposable copy that is deleted afterwards.

Every run's outcome, duration and seed are kept. Passes and failures mixed: **flaky** (with the
failing seeds and a 95% interval for the failure rate). Always passing or always failing: not
flaky. Stopped, timed out or incomplete: no verdict.

Fence: on Linux with bubblewrap the job is OS-sandboxed without network; on Windows and elsewhere
it is not OS-sandboxed (Node's permission model only, limited to the copy). Tests that keep
module-level state outside the module (files, globals other than the seed) are not isolated
between repetitions.
