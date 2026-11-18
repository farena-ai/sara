# Repository tasks benchmark

Small, original coding tasks written for Sara (none are copied from other benchmarks). Each one is
a tiny project with a request that needs reading several files, running the tests and editing more
than one module. Run them with [`scripts/bench-tasks.ts`](../scripts/bench-tasks.ts); results and
how to read them are in [docs/RESULTS.md](../docs/RESULTS.md).

```sh
node scripts/bench-tasks.ts --mode verify            # no model: every task fails at the start and passes on the reference
node scripts/bench-tasks.ts --mode agent --model <m>  # through her agent loop (tools, runs tests)
node scripts/bench-tasks.ts --mode raw --model <m>    # the same model, every file in one prompt, no tools
node scripts/publish-results.ts                       # writes docs/results/tasks-*.json
```

## Layout

```
bench/
  tasks/<id>/
    task.json   title, kind (bug | feature | refactor), lang (js | python), the request, the hidden-test command
    start/      the project she gets (copied into a fresh workspace)
    hidden/     tests she never sees; copied in as __hidden__/ after she's done
  solutions/<id>/   reference solution: files laid over start/ (only used by --mode verify)
```

| Task | Kind | Language | What it needs |
|---|---|---|---|
| 01-cart-totals | bug | JS | Three bugs in three modules, against a README's rules |
| 02-csv-quotes | bug | JS | A CSV reader that handles quotes and line breaks |
| 03-event-emitter | feature | JS | `once`, `off`, unsubscribe and a snapshot rule, in two modules |
| 04-slugify-spec | feature | JS | Slugs that follow a written SPEC.md exactly |
| 05-date-range | bug | JS | An off-by-one and a time-zone bug (hidden tests run in America/Chicago) |
| 06-config-merge | bug | JS | Deep merge and environment variables per SPEC.md |
| 07-refactor-tax | refactor | JS | Move duplicated rules into one module without changing behaviour |
| 08-router-params | feature | JS | Params, wildcards and route precedence |
| 09-lru-cache | bug | JS | Eviction order, hit rate and memoize, across three modules |
| 10-inventory-cli | feature | JS | Output formats and a filter for a command-line tool |
| 11-py-gradebook | bug | Python | Weighted averages, grade letters and shared places |
| 12-py-textstats | feature | Python | Tokenizer rules and two new functions |
| 13-py-ledger-decimal | refactor | Python | Floats to `Decimal` across a package |
| 14-py-ini-spec | feature | Python | A settings-file reader that follows SPEC.md |

## Real-size projects (Phase 62)

`bench/projects/<id>/` holds bigger projects in the same format (start/, hidden/, task.json; reference
solutions in `bench/project-solutions/<id>/`): 20 to 40 files each, with a README and docs that
state the rules, their own test suites (partly failing), and problems spread over several modules,
so the agent has to read around and run code to find them. Graded only by the hidden tests.

```sh
node scripts/bench-tasks.ts --tier projects --mode verify
node scripts/bench-tasks.ts --tier projects --mode agent --model <m>   # 900 s per project by default
node scripts/bench-tasks.ts --tier projects --mode raw --model <m>
```

| Project | Kind | Files / lines | What it needs |
|---|---|---|---|
| 21-notes-api | bug | 36 / 1,065 | A JSON web API (node:http): three reported auth problems; causes in the auth middleware (scheme case, refresh grace applied everywhere) and the note access rules |
| 22-ledger-cli | bug | 32 / 867 | A money-ledger CLI after a refactor: four regressions across the shared option parser (`--x=y`, negative numbers), the amount parser and the date filter |
| 23-units-lib | refactor | 22 / 539 | A units library: units are defined in four places; move them into one registry so `registerUnit()` works everywhere, then add three units |

## Adding a task

1. Write a small project in `tasks/<nn-name>/start/` with its own tests (some may fail) and a
   README or SPEC that states every rule the hidden tests check. A hidden test must never check
   something the request or the docs don't say.
2. Write `task.json` (copy one) and the hidden tests in `hidden/`.
3. Put your reference solution in `solutions/<nn-name>/` (only the files that change).
4. `node scripts/bench-tasks.ts --mode verify --only <nn-name>` must say `OK`.

JavaScript tasks use only Node's built-in test runner; Python tasks only the standard library.

## The same tasks through other harnesses (V1.4)

[`scripts/bench-compare.ts`](../scripts/bench-compare.ts) runs these tasks through agent CLIs that
you installed yourself (your own keys and settings), grades them with the same hidden tests, and
builds the results page [docs/results/index.html](../docs/results/index.html) (one file, no
scripts, works offline, light and dark).

```sh
node scripts/bench-compare.ts --mode verify     # no model: tasks solvable + a fake harness grades right; lists the CLIs it finds
node scripts/bench-compare.ts                   # every harness found on PATH (+ Sara when Ollama answers), then the page
node scripts/bench-compare.ts --harness aider   # one harness; `sara` = her own agent loop
node scripts/bench-compare.ts --page            # rebuild the page from docs/results only
```

A harness is only a command line: presets for Claude Code, Codex CLI and Aider (check the flags
against your version's `--help`); add or override any in `evals/harnesses.json`:

```json
[{ "id": "my-agent", "label": "My agent", "command": ["my-agent", "--task-file", "{promptFile}"],
   "version": ["my-agent", "--version"], "model": "the model it is set to" }]
```

Placeholders: `{prompt}`, `{promptFile}`, `{workspace}`, `{node}`, `{python}`; `"stdin": true`
pipes the task in. On Windows, npm CLIs are `.cmd` shims: give them the task by `{promptFile}` or
stdin (a multi-line `{prompt}` is refused). Each task runs once in a throwaway copy outside the
repository with the tier's time limit (`--timeout`), and nothing is sandboxed, so only list CLIs
you trust. Running a cloud CLI uses your own account and may cost money; the script never signs
up for anything and never publishes. Raw rows: `evals/results/<date>-compare-<tier>-<id>.json`
(private); public summaries without replies or folder names: `docs/results/compare-<tier>-<id>.json`.
