# V1.1 Move in: one button, nothing left behind

Spec: docs/design/ROADMAP_V.md V1.1 (VAUDIT item 11). One page; extends what exists, no second importer.

## What existed (kept, extended)
- `src/movein/` (MI1-MI3, 3.1.1): local agent finder (`local.ts`), collectors, bundle check, staging,
  one preview + one batch Import with Undo and a four-list report, config/hook/plugin translation cards
  (`config.ts`, `code-read.ts`, `translate.ts`).
- `src/history-import/` (Phase 51): ChatGPT / Claude zip → preview → archived conversations + learning.
- What was missing: every card (personality, settings, hooks, plugins) had to be decided one by one
  before Import; ChatGPT memories/custom instructions and Claude project knowledge were dropped;
  many Hermes config keys only said "Sara manages this differently"; after Import there was a report
  but no short "what now" list.

## What V1.1 adds
1. **Bring everything** (button on each found agent, and on any ready bundle):
   `POST /api/movein/bundles/:id/everything` confirms every proposed settings card and every code card
   without a safety flag (hooks never run; rules are safety-checked; guards only make Sara stricter),
   and answers `{ preview, choices, bring }`: suggested choices (every section with findings on, the
   first personality draft picked) and counts per kind (persona, notes, chats, skills, jobs, settings,
   hooks, plugins). It is still a review: nothing reaches Sara's stores until Import; every card can
   still be changed.
2. **Export notes** (`src/history-import/notes.ts`): ChatGPT `memories*.json`, memory writes inside
   chats (`recipient: "bio"`), custom instructions in `user.json`/`user_settings.json`/
   `custom_instructions.json`; Claude `projects.json` instructions + knowledge files. Deduped; a file
   longer than a note (2000 chars) is clipped and counted (`skipped.clipped`). Saved on Import as notes
   on a hidden archived "Notes from ChatGPT" conversation on the source channel, so "Remove imported
   history" removes them too.
3. **One review for both**: the review can take a ChatGPT/Claude export too (the existing history
   preview); `POST …/import {choices, history}` runs both from one press.
4. **Hermes config mapped**: `HERMES_KNOBS` in `config.ts` gives stt, delegation, compression, memory,
   display, smart routing, checkpoints, toolsets, quick commands, honcho, session reset, security,
   browser and code execution a specific Sara place + page and a plain "here is how" line.
5. **First evening checklist** (`src/movein/evening.ts`,
   `GET /api/movein/batches/:id/evening`, `GET /api/movein/evening` for an export alone): model,
   voice, bridges (named from the old config), then every skipped kind with its reason (report
   left-behind lines, needs-you lines, export skip counts). Shown under "Moved in".

## Not done (parked)
- Live Hermes on another machine (one-paste flow exists; untouched).
- Claude project files as Library documents (notes only, clipped past 2000 chars; the checklist says so).
