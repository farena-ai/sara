# Fix receipts (2026-11-19)

One page. Evidence: the owner's chat "Packing for Lisbon trip" (deepseek-v4.1-flash via Ollama).

## What existed
- `src/receipts.ts`: the claim checker (`checkClaims` patterns, `unsureClaims` + the optional local
  claim judge, `judgedClaim` / `isBacked`). "Did this tool change something" was the hand-made
  `WRITE_TOOLS` set (16 names) plus a `READ_ONLY` regex.
- Tools already describe themselves: `defaultPermission` (`ask` = changes something; the V5.1
  timeline `src/timeline.ts` uses the same rule), `interruptible` (read-only; `src/pending.ts` also
  lists the built-in read-only names), and the V5.1 `registerAction` describers.
- D8 Second opinion (`src/second-opinion.ts`, `src/routes/second-opinion.ts`, `web/second-opinion.js`):
  only a reply action button.

## What changed
- `src/tools/effects.ts` (new, one source of truth): `toolEffect(tool)` = explicit `changes` on the
  tool, else `mcp_*` changes, else interruptible / read-only names read, else `ask` changes, else the
  verb in the name (last word first: `invoice_list` reads, `purchase_add` changes). `ToolRegistry.add`
  notes each tool's effect; `toolChanges(name)` answers by name (receipts carry names). 29 tools whose
  names can't tell now say `changes: true|false` (`Tool.changes`, src/tools/types.ts).
- `src/receipts.ts`: every changing tool backs write / planner / action claims (`WRITE_TOOLS` gone;
  a small `FILE_EDITS` set stays only for E3 "look again after the last edit"). New `priorThing`:
  an earlier live-view change (canvas results now say "the live checklist ...") backs a recap that
  names the checklist / its title and nothing new ("And the checklist: I changed it twice").
  "I updated the checklist with sunscreen" after a change that never added sunscreen is still a miss.
- `GET /api/tools` adds `changes` (true / false / null = undecided).
- Second opinion from chat: `asksSecondOpinion(text)` (six languages; not for doctors/lawyers, not for
  "no / don't need"; short messages only). `runTurn` answers such an ask without a model or tools
  when she has an earlier reply: a fixed reply in the asker's language + `meta.secondOpinionOffer =
  { message, private? }`. The web turns that into the existing D8 plan card for that reply
  (`secondOpinionOffer` in web/second-opinion.js: models, cost, Ask them / Not now). The plan route
  now says `asked`, so an old offer shows no card once answered. No new routes, strings or CSS.

## Not done / choices
- The V5.1 timeline still records only asking tools and its describers (no rows for quiet changes
  like canvas_post); switching it to `toolEffect` is a one-line follow-up if the owner wants it.
- A vague present-tense "I updated the checklist with them" after an earlier real change is treated
  as a recap (not flagged): it can't be told from turn 3 of the evidence.
- Tools named in the evidence that don't exist as chat tools (renewals, journal, trim, home scenes)
  need nothing; any new tool is covered by the rules or fails `test/fixreceipts.test.ts`.
