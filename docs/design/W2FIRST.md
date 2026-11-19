# W2.2 The first ten minutes

One page. Spec: ROADMAP_W.md W2.2.

## What existed (extended, not duplicated)
- R2 guided setup (`src/get-started.ts`, `web/get-started.js`): five skippable, resumable steps
  (model, mail, calendar, phone, computer) ticked by what is connected, sample space, packs.
- Phase 67 `src/local-models.ts`: nvidia-smi / sysctl / RAM detection, GPU and CPU tier tables,
  Ollama detection, `/api/local-models/pull|use` (one download at a time, Cancel, winget install).
- V1.1 Bring everything (Settings → Data → Move in, `dh-movein`), V1.3 Where do you text?
  (`/api/plugins/where*`: pick with defaults, check, send-test), Telegram/Discord `test-picture`.
- First-run setup wizard (`web/setup-wizard.js`, connect a brain) stays as is: it runs before the guide.

## What W2.2 adds
- Guide steps: `model, bring, chat, mail, calendar, phone, computer` (members: the last four).
- `src/first-ten.ts` (pure helpers):
  - `modelPlan(hw, ollama, {privateLocal})`: graphics card (GPU or Apple unified memory ≥ 4 GB) →
    `gpu`; else ≥ 8 GB RAM and ≥ 4 cores → `cpu` small model; else `cloud`. Private local mode
    never offers cloud. Each offered way carries its model and action: `use` (already in Ollama),
    `download`, `get-ollama`, `cloud`. Never downloads.
  - `broughtIn` (any `import-*` conversation), `chatAppName` (Telegram/Discord linked, or a
    plugin bridge on + linked), `importedNote` (newest active memory from an import, ≤ 60 chars),
    `quickWins` (reminder [on the linked app], checklist, note question | mail | week).
  - `firstTenDeps` seams (hardware, Ollama) for tests and live checks.
- `detectHardware` also reads the processor (`os.cpus()`: name + logical cores).
- Routes in the existing `get-started` family: `GET /api/get-started/model` (owner only),
  `GET /api/get-started/wins` (`{wins, chat}`). No new route family (no household-isolation churn).
- Web `web/first-ten.js`: the model step (this computer, three path cards with "Best for this
  computer", one main button; download progress via `/local-models/pull`, Cancel, resumes a running
  download), the chat step (app buttons → the app's page with defaults; done → Send me a test), the
  quick wins on the end screen (`startWin` lent by app.js: new chat + send).
- Guide fixes found live: opened by hand marks it offered and drops the first-run queue entry (it
  re-opened after Finish), one ✕ (`data-nox`), sticky action bar, readable card hover.

## Not done / later
- The cloud path opens Models → Default model (its own free-tier presets); no account is made.
- Quick wins are fixed prompts; no per-pack wins yet.
