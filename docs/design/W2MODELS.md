# W2.4 Free models first (design, one page)

**Spec (ROADMAP_W):** a curated, tested list of free/local models per job with expected quality, download
on request, and a monthly re-check.

## What existed (extended, not duplicated)
- `src/local-models.ts`: hardware detection, Ollama detection, `GPU_TIERS`/`CPU_TIERS` (chat only),
  `ModelPuller` + `/api/local-models/pull|use` (one download at a time, progress, Cancel).
- `src/first-ten.ts` `modelPlan` + `firstTenDeps` seams (W2.2 first-run guide).
- `src/modelpicks.ts` JOBS (which model does what, connected models only), `src/voice-install.ts`
  (local hearing/voices), Android `LocalModel.java` (Qwen 2.5 0.5B offline copy).
- Evals: `docs/results/*` (real-runs, HumanEval, claims judges, library-meaning), `scripts/bench-compare.ts`
  page, Phase 84 monthly eval re-check (off by default) on the hourly evals timer.

## What W2.4 adds
- `src/free-models.json` + `src/free-models.ts`: versioned list for 7 jobs (chat, coding, vision, hearing,
  voice, embeddings, phone) with minGb/cpuRamGb, size, license, why, own-eval link; `validateList`,
  `recommendFor` (biggest that fits), `installedAs` (local builds like `qwen3.8:27b-mtp-q4_K_M`, never
  cloud), `qualityOf` (here > eval > untested), `recommendations`. Chat rows mirror GPU/CPU tiers (tested).
- `src/model-recheck.ts`: small probe set per job against loopback Ollama only; generated code runs in
  `node --permission` with no grants; `<data>/model-recheck.json`; `tick()` monthly + 20 min idle, off by
  default; driven from main.ts's hourly evals timer (no new timer).
- Routes inside the existing owner-only `local-models` family: `GET recommended`, `GET|PUT|POST recheck`;
  `POST pull {use:false}` keeps her talking model.
- Web: a section on Settings → On this computer (`web/free-models.js`, `#fm-*`), no new page.
- `scripts/model-recheck.ts [--publish]` → `docs/results/model-recheck.json` → `recheckSection` on the
  results page.

## Not done
- Voice/hearing and the phone model are not re-checked (no local probe yet); their marks come from
  RESULTS.md or say Untested.
- Licenses are curated by hand on the list date; no automatic license fetch (no network in the list).
