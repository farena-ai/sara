# Real-model task runs (ROADMAP_U U1.1)

`scripts/eval-real.ts` proves the features work with a **real model**, not only with the scripted fake
models of the tests. It runs about 40 everyday tasks through real chat turns and real tools on throwaway
Saras, checks what happened, has a second model score each task, and writes a report.

```
node scripts/eval-real.ts                      # all tasks, then the judge pass
node scripts/eval-real.ts --list               # what the tasks are
node scripts/eval-real.ts --only s7-template,s7-revise --redo s7-revise
node scripts/eval-real.ts --model gemma4:12b --judge qwen3.5:9b --out outputs/real-runs/gemma
```

| Flag | Default | What it does |
|---|---|---|
| `--model` | `qwen3.8:27b-mtp-q4_K_M` | The model Sara uses for every turn (Ollama on this computer). |
| `--judge` | `qwen3.5:9b` | The model that scores each task 1-5 with a one-line reason. |
| `--ollama` | `http://127.0.0.1:11434` | Where Ollama answers. |
| `--only`, `--redo` | | Run only these task ids; run these again even if they are done. |
| `--fresh` | off | Forget earlier results in the output folder and start over. |
| `--no-judge`, `--judge-only` | | Skip the judge pass; only (re)score saved results. |
| `--cap-tokens`, `--cap-minutes` | 3,000,000 / 360 | The cost cap: no new task starts after this many tokens or minutes (`capHit` in the report). |
| `--turn-seconds` | 600 | One chat turn is stopped after this long (counted as a turn error). |
| `--allow-cloud` | off | Cloud-tagged Ollama models (`:cloud`, `-cloud`) are refused without it. |
| `--out` | `outputs/real-runs/<date>` | `results.json` (everything, resumable) and `report.md` (summary table + failures). |
| `--publish <label>` | | Also write the short public summary `docs/results/real-runs-<date>-<label>.json` (scores, features, names of failed checks; no prompts, replies or paths). `node scripts/bench-compare.ts --page` then shows it on the [benchmark page](results/index.html). |

## How it works (one page)

- **Throwaway Saras, in this process.** Each "world" is a real Sara server (`createSaraServer`) on a temporary
  data folder and a free 127.0.0.1 port: `home` (almost every feature), `mail` (Google + iCloud accounts) and
  `pair` (Hank and Sam, two linked servers for support looks and remote fixes). The owner's Sara, data and
  accounts are never touched; nothing goes to the internet except Ollama on this computer.
- **Fixtures, from the tests.** Fake mailbox and calendar (lease mail, events), fake web search + pages
  (heat pumps, e-readers) behind the research address guard, booking mails (`test/travel-fixtures.ts`), sent
  mail with promises, a recorded meeting heard by a fake hearing engine (`test/fixtures/s2-audio.ts`), a
  contract template and a past contract (.docx), a fake Google (OAuth + Gmail answers), a broken setting for
  self-repair, a tiny buggy source tree (`add.js` + `test.js`), Hank's private log lines that must not leak.
- **Real turns.** Every message goes through `POST /api/conversations/:id/messages` (lean tool picking,
  approvals, receipts, the claim check, all real). Every approval card is answered Yes. Where a feature needs
  the owner to press a button in the app (approve a research plan or a team plan, give and accept a fix
  pass), the script calls the same route or engine method the button calls.
- **Checks first, then the judge.** Each task has deterministic checks: no turn error, a reply, no refusal,
  the right tool called and ran ok, the rows/files exist (reminder at the right local time, goal, Library
  document, tracked version, signing PDF, Stock Alerts project, fix plan received), facts unchanged
  (humanize keeps Unit 4B / March 3 / $180 / November 28; nothing private crosses servers; the test file
  is not edited). Then the judge reads the transcript, tool results and check results and gives 1-5 + a reason.
- **One model at a time.** All tasks run with the main model; then it is unloaded (`keep_alive: 0`) and the
  judge scores everything; then the judge is unloaded. Fits one GPU.
- **Time, tokens, cost.** Per task: wall time and the tokens the model reported (every model call during the
  task, also side jobs like titles and summaries). Local models cost $0; the cap is on tokens and minutes.
- **Resumable.** `results.json` is written after every task; a rerun skips finished tasks (an `error` task
  is retried). `--redo` reruns chosen tasks; `--judge-only` rescored with another judge.

- **Round 2 (W0.1): one task per newer feature.** `v-canvas` (live checklist in the chat), `v-second-opinion`
  ("get a second opinion on that" → the plan card, no model call), `v-receipts` (what she says she did is
  backed by tool receipts), `v-renewals`, `v-purchases`, `v-interpreter`, `v-movein` (Bring everything from
  ChatGPT), `v-waiting` (waiting on you), `v-friend-time` (pair world), `v-myapps`, `v-timeline` (add, then
  undo), `v-time` (W0.6: "how long ago…" from the stored message time) and `v-always` (W0.7: Always allow
  everything on → no card, still on the action timeline).

## What a failure means

A failed check is either a **product bug** (a route throws, a tool is not offered for the words a person
uses, a tool reports success without doing it) or **model weakness** (the model picked the wrong tool,
answered from memory instead of looking, got a date wrong). The results section in `docs/RESULTS.md` says
which is which; product bugs are fixed with a test or listed in `docs/BACKLOG.md` with the evidence.

Limits: one run per task (no repeats, so a single run is a sample, not a rate); the calendar is a fixture
tool pair (`calendar_events`/`calendar_add`), not the real Google/IMAP calendar code; the judge is a small
local model and can be wrong, so read the reasons with the transcript in `results.json`.
