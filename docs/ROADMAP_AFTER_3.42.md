# Roadmap after 3.42.0

Written 2026-11-24 by Claude Code at the owner's request ("create another exhaustive roadmap to
features and tightening current features and polish from there on recommended things to
add/improve/develop"). A proposal: the owner decides the order and what ships. It replaces
docs/ROADMAP_AFTER_3.40.md as the working plan; evidence for each item is in docs/BACKLOG.md and the
handoffs named there.

It was made from an inventory of the whole product (every BACKLOG bullet, the "Limits" and "Not
verified" sections of the docs and the last fifteen handoffs, the feature list in the README) and
from what the measurements of 3.37 to 3.42 showed. Three things stand out, and the order below
follows them:

1. **Much of what was built has never run for real.** No call has reached Claude itself since the
   Claude work began. No phone, Windows-app or Mac-app pass has followed the last six releases. A
   real desktop action, a real phone line, a real iPhone, a real cluster, two real machines for
   remote repair: all unrun. The largest risk in Sara today is not a missing feature.
2. **Measuring finds what reading does not.** The tool evals found that the tool list, not the
   model, was the weak part. The crisis eval found a wording that made her refuse help. The
   real-model run found the one-model computer. Every area without an eval is an area of guesses.
3. **The owner's own days are the best test.** The crisis lines, the chat list, pairing a device:
   the most valuable fixes of the last week came from him using her.

Each item says what it is, why, and how to know it worked. Sizes: S (a day), M (a few days), L (a
week or more). Items marked **owner** need him: a device, an account, a decision.

---

**Status 2026-11-24** (owner: "Run all tracks in roadmap, anything that needs human add to the human
roadmap and push those until the end"): a first pass is in 3.43.0. Done, measured-and-left, and
still open are listed in docs/BACKLOG.md under "T43"; everything that needs him is in
docs/HUMAN_ROADMAP.md.

## Track A: run it for real (first, and before any new feature)

| # | Item | Why | Done when | Size |
|---|---|---|---|---|
| A1 | **A real-run checklist the owner can do in half an hour**, written as a page in the app (Settings → Updates → "Try what's new") and a doc: each step one sentence, each with a Worked / Did not button that files the result. | Every release ends with a list of things only he can try. They are scattered in handoffs and get lost. | The list for 3.42 exists, he has run it once, and the results are in the repo. | M |
| A2 | **Claude for real** (**owner**: sign in `claude` on the build computer, or an API key): the thinking level on a subscription, background work on "low", thinking handed back between tool steps, the cache split, the refusal fallback. | Z5, S2 and S3 follow the published rules and a stand-in only. | `npm run eval:tools -- --model` and one real chat on each of Quick and Thorough pass through Claude, and what failed is fixed. | M |
| A3 | **Structured answers through the Claude program** (`--json-schema`), once A2 gives a signed-in CLI to see its output. | The security review has a fixed shape on Ollama and on a key, not on a subscription. | The review's answer parses first time on a subscription. | S |
| A4 | **Phone and desktop-app pass** (**owner**, with A1): reload speed after 3.39, the home chat, Settings at phone width, the Windows installer art, quick ask, self-update. | Six releases, no device pass. | A written pass per device, and its misses filed. | M |
| A5 | **A real desktop action and `pc_run`** through a connected computer, and a screenshot for a model that can see. | The tool executor was split (Z3) and these paths are the least covered. | Three real actions, logged. | S |
| A6 | **Real lines and devices that have never been used**: a real phone number for phone calls; a real iPhone for Shortcuts, Siri, share sheet, push; two real machines for remote repair and the support link; the Helm chart on a real cluster; Outlook.com sign-in; pairing by QR over Tailscale. | Each is documented as "never run". | One line per item: ran, or what broke. | L |
| A7 | **The clock line for local models** (`moveClockToEnd`): the code is ready and waits for real-model runs. | Keeps the long first part of her instructions the same from turn to turn on OpenAI-style servers too, so a model's cache is reused. | The time evals pass on two local models with the line moved, and first-word time is measured before and after. | S |

## Track B: measure more, then tighten

| # | Item | Why | Done when | Size |
|---|---|---|---|---|
| B1 | **One command for every eval that needs no paid model** (`npm run eval:all`), a results page per release in docs/results, and a table of this release against the last. | There are 30 eval scripts; ten have an npm name; none run together. | One command, one page, in the release steps. | M |
| B2 | **Tool evals with connected accounts**: fake mail, calendar and a paired computer in the throwaway Sara, and cases for them. | The eval runs a fresh install; the tools people use most with accounts are unmeasured. | 40 cases; offered and first-move numbers. | M |
| B3 | **Crisis eval, next round**: long conversations (a hard talk that stays hard for twenty turns; one that turns to danger), the context rules in the other five languages, a reader's judgment of the replies (kind, on the subject) with a second model, and the eval run for every recommended talking model. | S5 measured single messages and judged by patterns. | The danger row stays complete on every recommended model; the reader's scores are written down. | M |
| B4 | **The crisis notice, once per conversation** (**owner decides**: it is the legal layer): shown on the first flagged message, again only after a gap or when the message says more. | Today it repeats on every flagged message of a conversation. | His decision is in DECISIONS; if yes, the eval shows the first flag always gets it. | S |
| B5 | **Did she do what she said** (the receipt check): recall is 0.38 on held-out replies; conditionals are false positives; "last week" is not treated as earlier work. | It is the check behind "she really did what she says she did". | Recall above 0.7 on held-out replies with no more false positives. | M |
| B6 | **The memory evals made steady**: `eval:memory` moved between 10 and 12 of 12 on the same code. Fix the grader ("fuzzy on it" is an honest no), run each probe three times, report the spread. | A noisy eval cannot say whether a change helped; it stopped the memory-notes schema in 3.42. | Three runs agree; then try the notes schema again. | S |
| B7 | **Routing evals for the other jobs**: coding, pictures, quick replies, private chats, Auto's picks. | Only research routing is measured. | Cases and numbers for each job. | M |
| B8 | **Real tasks** (`eval-real`): "check everything" skips the mail; goal progress goes to a note instead of `goal_update`; the script leaves temp folders on Windows. | Known misses from real runs. | Both pass on two models; no folders left. | S |
| B9 | **Long coding turns**: one hit the 80-step stop, one got an empty reply mid-task; the coding benches use small projects and only OpenAI-style servers. | Coding is where long turns happen. | A bench on a real-size project through any provider; the two failures reproduced and fixed. | L |
| B10 | **Embedding models**: floors for mxbai, arctic and OpenAI's embedders; a floor that drops additions on small talk (26 → 32 tools a turn today); vectors kept in the database. | Only nomic and bge-m3 are measured; every turn pays for five more tools. | Numbers per model; the token cost of meaning on small talk halves. | M |

## Track C: tighten what exists

### Conversations and the turn
- **C1. The turn function, to the end** (L): context assembly after the history (S6 moved the history), then what happens after a failed call (about 130 lines that `continue` the loop; needs a result type), then `runToolCall` into its own file. Measure: `runTurnInner` under 1,000 lines, the 1,840 turn tests unchanged.
- **C2. One route resolver** (M): `modelAuthorityOf` and `resolveChainAll` decide the same thing twice. Measure: one function, parity tests kept.
- **C3. A thinking level per conversation** (S): the setting is one for all chats; a hard chat wants Thorough while the rest stay Quick. In the chat's own menu.
- **C4. Team helpers on the main loop's rules** (M): no pruning past 25 rounds, an empty reply counts as done, the time limit is checked only between rounds. **Done** (Y8 and T46, 2026-11-24; what is left is in BACKLOG "debt, team helpers").
- **C5. Private chats that are never stored** (M, an old idea in BACKLOG): "Off the record" exists; this is the stricter kind with nothing written at all.
- **C6. Typing that feels human, as an option** (S).

### Memory and what she knows
- **C7. Edits and deletes reach what was already built** (M, a privacy item): history is snapshotted before a wait, so an edit or delete does not rewrite the dialogue already assembled; audit the other producers and the forget lifecycle.
- **C8. Memory's meaning search without a second model load** (M): on a computer that keeps one model loaded, ask Ollama for the embedding model on the processor (`num_gpu: 0`, measured 74 ms a message once loaded); S6 made it rest, this makes it work.
- **C9. Learning from history reads more than the newest 30,000 characters** (S).
- **C10. Per-model persona tuning** (M, an old idea): the crisis work showed how differently two models read the same instructions; a short per-model addendum, measured with `eval:consistency`.

### Tools and routing
- **C11. MCP tool pinning** (S, security): ask again when a tool's description or hints change after it was allowed.
- **C12. Typed ON for code changes without a passkey** (S, security): ask for the owner token; needs a screen.
- **C13. Did-it-work for mail drafts** (S): Outlook and IMAP drafts are not read back. **Done (T45):** Outlook reads the draft back by its id, IMAP finds it in Drafts by its Message-ID; `test/t45-draft-readback.test.ts`.
- **C14. `library` and `ask_everything`** (S): "check everything" should reach mail (see B8). **Done (T45), not yet run on a real model:** a `library` ask in a turn where the person said everything or named their mail also searches the rest with ask_everything's rules; `test/t45-library-everything.test.ts`.

### Voice, calls, pictures
- **C15. Her look on engines other than Grok** (M): outfit and expression edits that keep the face (OpenAI edits, ComfyUI image-to-image). The owner asked for this in 3.38.
- **C16. Talking portrait for an uploaded picture; mouth shapes timed from the voice provider** (M).
- **C17. Video calls**: face cues outside English; pictures in Grok live calls (M).
- **C18. Expressive speech on calls** (L, on the public roadmap).
- **C19. Voice rooms** (L, on the public roadmap).

### Planner, proactive, everyday
- **C20. Errands start to finish** (L, on the public roadmap).
- **C21. Today**: "Leave by" ordering; times in the hour the clocks go back (S).
- **C22. Stocks**: market holidays; non-US symbols on their own hours (S).
- **C23. Research**: more than one run at a time; a PDF font that has every script (M).

### People, household, groups
- **C24. Group chats on phones and bridges** (L): room screens on Android and iPhone, Telegram and Discord group rooms, members joining and leaving, photos and approvals in rooms.
- **C25. Household**: group chats across people, server tools for members, imports and bridges for members (L).
- **C26. Rooms**: `/new` in a room should not unlink the seat; bridge on/off checked after linking too (S).

### Coding
- **C27. Previews with hot reload** (M) and a doctor line for the testing browser.
- **C28. Code map**: harder questions on a bigger codebase; `.gitignore` negation lines (S).
- **C29. SSH**: file copy up and down (done in T46: `ssh_upload`, `ssh_download`); still open: Windows servers whose shell is cmd.exe (M).
- **C30. A container sandbox on Windows and Mac** (L, on the public roadmap): today commands there can read the vault key.

### Computers and browsers
- **C31. Linux desktop mode for hands**: screenshot and input portals, a global Stop shortcut, takeover, an indicator (L).
- **C32. Screenshot-assisted correction** in browser use, shown for real, not only DOM success (M).

### Add-ons, clients, APIs
- **C33. Open Responses**: app-defined function tools (**owner decision**), WebSocket transport, `/v1/responses/compact` (the 10 failing compliance cases) (M).
- **C34. Prerequisites**: a real install on each OS; native add-ons wired to them; an "Install it for me" for npm (M).
- **C35. Store listings in every language; the Glama listing for the MCP server** (S).

### Business mode
- **C36. Sharing; retention, legal hold and per-person export; SCIM Bulk and ETags; refusals in six languages** (L, when a business needs them).

## Track D: structure and upkeep (a little every release)

- **D1. Schema versions** (L): 381 tables in 149 files are created and altered on every start; one `openDb()` helper and `user_version` per module. Measure: start-up time, and a migration test per module.
- **D2. Timers** (M): about 25 `setInterval` workers onto `src/tick-jobs.ts`.
- **D3. One feature in one place** (L): a feature is wired in six places today; a per-feature manifest.
- **D4. Tests that read source as text** (ongoing): 272 files, about 1,630 assertions; replace with behaviour tests when a file is touched. The S-stage tests added a few of these too.
- **D5. Tests that fail only under load** (S): `business-oidc`, `phase86:540`, `w0-hearing:123`, `business-isolation:10`, and the Signal linking test seen in 3.41: find the wait each depends on. Also: a release gate must never share its log or its worktree with another run (it happened in 3.41). **T47:** `w0-hearing` (a random file name, never load), `business-isolation` and one fixed wait in the Signal linking test are fixed; `npm run check` holds a lock per folder (`scripts/check.ts`). `business-oidc` and `phase86:540` did not come back under load and are unchanged (docs/BACKLOG.md).
- **D6. SOURCE_OF_TRUTH is 78 KB** (S): move finished releases to docs/ops/history; about 20 GB of evidence folders under `outputs/`.
- **D7. Settings' 84 pages are in the page from the start; `content-visibility` on chat messages** (M), and loading each place on first open if A4's phone numbers call for it.
- **D8. Debug logging** (S): few debug lines, so the Debug level adds little. **Done (T45) for a turn:** the model picked and why, the history budget, tools offered per step, each tool call, fallbacks, after-turn jobs and the end of the turn (`debugLine` in src/log.ts; `test/t45-debug-log.test.ts`). Background workers have none yet.
- **D9. Node 26 on macOS** (S): two process and port checks and one fixture.
- **D10. Long runs** (L): a day and a week of soak, disk pressure, real provider latency, a large PDF, recovery time measured.

## Track E: polish

- **E1. The owner's list of screens** (**owner**), the Windows app first. Still the most valuable polish input.
- **E2. Layout consistency** (L): about 1,500 raw spacing values to tokens; one shared window header; Name and personality in three tabs; a date chip.
- **E3. Words** (M): ten English tips over 260 characters; `VoiceError` and other plain errors still English (T46: the voice errors and about 35 others are translated; what is left is in docs/BACKLOG.md); agreement for a he/they companion in fr/es/pt-BR/it and German; spot-check the machine translations.
- **E4. Phone details** (M): tap targets at 390 px (model chip, + Project, Off the record, the status line); + and Send missing a tap while the keyboard closes; the `sara hands` command cut off; the Default-look "?" wrapping.
- **E5. Small truths** (S each): "Needs you" lists a down model twice; the no-search notice fires on ordinary chat; Ollama `:cloud` models labelled local and free; "Not connected" without a reason; add-on browser calls show "Not checked"; "checked 2 h ago ↻ Refresh" wraps on a phone.
- **E6. Other browsers** (S): Firefox and Safari have not been looked at.
- **E7. The gallery step in the setup wizard; the gallery cards at phone width** (S).
- **E8. README screenshot** without the failed job (S).

## Track F: new things worth building

Ordered by how much they would change a day with her, not by size.

1. **"Try what's new" and a release that tests itself** (A1 + B1 together). Turns every release's open questions into something done in half an hour.
2. **A model check-up for the person's own model** (M): run the short evals (tools, crisis, memory, consistency) on the model someone has picked and say in plain words what it is good and bad at ("gives hotline numbers when you are sad", "misses tools said your own way"), with a suggested other model. The crisis finding was about one model; nobody could have known.
3. **Multiple personas on one server** (L, an old idea), each with her own memory and look, built on the group-chat companions.
4. **iPhone app in the App Store with CallKit** (L, on the public roadmap) and **being found in stores and catalogs**.
5. **Easy start** (L, R2 on the public roadmap): from download to first chat with no terminal, the embedding model and a talking model fetched for the computer it is on.
6. **A weekly "how she did"** for the owner (M): what she got wrong and fixed, tools that failed, turns that were slow, what the evals say after an update. The data exists (runs, receipts, trouble notices).
7. **Shared reading and watching** (M, E5 in BACKLOG): a document or a feed open together, with her place in it.
8. **Monitoring that stays in bounds** (M, E4): file scope, bounded reads, rotation, stop controls, then watching a folder or a log for him.
9. **Mobile wrapper for iPhone and Android from one code base** (L, an old idea), if the App Store route needs it.
10. **Scale-out, measured** (L, on the public roadmap): only if a business install asks for it.

## A suggested order

- **3.43**: A1, A2, A3, A4, A5, A7 (all of Track A that the owner can reach), B1, B6, D5, E5. A release that is mostly "we ran it".
- **3.44**: B2, B3, B4, B5, C1 (next block), C3, C8, C15, E3, E4.
- **3.45**: F2 (the model check-up), B7, B8, B10, C2, C7, C11, C12, D2.
- **3.46 and on**: C20 (errands), C24 (group chats on phones), F3 (personas), F5 (easy start), D1, D3, C30, then the rest by what he uses.

## Every release from here

- Run `npm run eval:tools` (with `--embed bge-m3 --adopt`) and `npm run eval:crisis -- --model <the recommended talking model>` and write the numbers into docs/results. The danger row of the crisis eval must be complete.
- One gate run at a time, in its own worktree, with its own log.
- Whatever could not be run for real goes on the "Try what's new" list (A1), not only into a handoff.

## Waiting on the owner

- A signed-in `claude` on the build computer or an API key (A2, A3).
- Half an hour with a phone and the Windows app (A4).
- His list of screens (E1).
- Two decisions: the crisis notice once per conversation (B4); app-defined function tools in Open Responses (C33).
