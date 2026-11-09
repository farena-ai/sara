# Release Readiness

Runs a staged project's configured local release gates and tells you whether it is ready.

1. With the plugin switched off, stage a copy of the project in its data folder under
   `projects/<name>/` (plain files; no links). Stage only code you trust to run.
2. The project carries a reviewed gate profile, `release-gates.json` by default:
   `{ "version": 1, "gates": [{ "id": "tests", "requirement": "Unit tests pass", "program": "node", "args": ["--test", "test/cart.test.mjs"] }] }`.
   Programs are `node` or `npm` (`test` or `run <script>` from `package.json`), up to 10 gates.
3. `gates` with `operation: "plan"`. Nothing runs; you get every gate's exact command and a
   `planSha` bound to the staged files and the profile.
4. `gates` with `operation: "run"` and that `planSha`. Sara asks you to approve **one job per gate**,
   each in a disposable copy that is deleted afterwards. You get each gate's real exit code, the
   SHA-256 and the end of its output, and the verdict: *ready* only when every gate passed;
   *blocked* (with the failing requirements) when one failed or timed out; *incomplete* when a gate
   was held, declined or stopped.

Local gates only: a gate (or its npm script) that looks like publishing, signing, uploading,
deploying or CI refuses the whole profile before anything runs. `npm` gates run only where Sara has
an OS sandbox (bubblewrap on Linux); elsewhere they are held and the verdict stays incomplete.

Fence: on Linux with bubblewrap each job is OS-sandboxed without network; on Windows and elsewhere
it is not OS-sandboxed (Node's permission model only, limited to the copy, `node` only).
