# V1.4 Open benchmark page (design, one page)

**Goal.** Show how Sara does on her own original coding tasks next to other agent harnesses, run on
the same computer and graded by the same hidden tests, on one static page anyone can rebuild.

**What existed (kept, extended).** `bench/tasks` (14) and `bench/projects` (3) with start/, hidden/
and reference solutions; `scripts/bench-tasks.ts` (verify / agent / raw, `runHidden`, `taskText`);
`scripts/publish-results.ts` (private raw → public `docs/results/*.json`, every run kept);
docs/RESULTS.md. Nothing ran the tasks through anything but Sara, and there was no page.

**Built.**
- `scripts/bench-compare.ts`: a *harness* is a command line only (`{prompt}`, `{promptFile}`,
  `{workspace}`, `{node}`, `{python}`, or stdin). Presets: Claude Code, Codex CLI, Aider; the user's
  own list in `evals/harnesses.json` (same id overrides; bad entries reported, never run). No other
  project's code is in the repository.
- Per task: fresh copy of start/ in the OS temp folder (outside the repo, so no hidden tests or
  solutions nearby), the task text = Sara's own `taskText`, the tier's time limit with a process-tree
  kill, then `runHidden` on what is left. Windows `.cmd` shims go through `cmd.exe` with quoting and
  refuse arguments cmd would rewrite (pass the task by file or stdin).
- `--mode verify`: bench-tasks verify + a pipeline self-test with `scripts/bench-fake-harness.ts`
  (one that lays the reference solution must pass, one that does nothing must fail) + which CLIs are
  on PATH with their versions. No model.
- One rerun: `node scripts/bench-compare.ts` = every harness found on PATH, Sara too when Ollama
  answers (bench-tasks agent + publish-results), then the page. `--harness a,b`, `--tier`, `--only`.
- Results: raw rows `evals/results/<date>-compare-<tier>-<id>.json` (private, appended), public
  summary `docs/results/compare-<tier>-<id>.json` (scores, model, dates, command template; no replies,
  test output or folder names).
- Page `docs/results/index.html` (`--page`, offline): summary (harness, model or "the CLI's own
  default", set, score with every run of the day, date, re-run command), task-by-task grids per
  tier, exact commands with platform/Python, how it is run. One file, no scripts or outside
  requests, light/dark by `prefers-color-scheme`, stacked rows on phones. A test keeps the shipped
  page equal to what the summaries build.

**Rules kept.** Only CLIs the user installed, with their own keys; nothing signs up or publishes;
nothing sandboxed (like bench-tasks), so only trusted CLIs belong in the list. Cloud CLIs cost the
user's own money: the default run uses what is on PATH, so the docs say so.

**Not built / later.** No in-app Settings page (the page is a docs artifact); no sandboxing of
other harnesses; pass@k (one run per task).
