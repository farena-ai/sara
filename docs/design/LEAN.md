# Big tool sets: a lean tool list per turn, and `/compact` (design, Phase 123, version 2.56.0)

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at
2.55.2 (Phases 115–122 released: photos and files in chat apps, the live progress message, steer /
queue / `/btw`, the loop guard, Signal and email, goals and loops, "when it comes up" and `/continue`,
checks after her edits and @-references, the routines gallery and the safety check-up, WhatsApp,
Matrix and iMessage), plus the public feature pages of Hermes Agent, OpenClaw, Claude Code and Codex
(sources in §13). It is a ground-up design: no code, schema, prompt or wording is taken from any of
them; this file names only their **features**. Zero new npm runtime dependencies. No new run engine,
no new timer, and **no model call to pick tools**: the per-turn list is chosen by code (the
conversation's mode, words in his message, @-references, what she used recently, what the owner
pinned), and one ordinary tool, `find_tools`, lets her load the rest. The only new model call in the
phase is the summary `/compact` writes, and it goes through the Phase 109 cheap-call helper
(`src/cheap.ts`) with its local-first route, its daily ledger and its private-chat rule.

> **As built (2.56.0), 2026-11-02.** Built as designed in `src/lean.ts`, `src/compact.ts`,
> `src/routes/lean.ts`, `web/lean.js`/`lean.css`, `test/phase123.test.ts`; §11 defaults applied (cold
> built-ins deferred; auto above 6,000 tokens; no per-model window; no fold inside a turn; no `/compact`
> off the record or in partner chats; no hand-editing; `/compact` in the Telegram and Discord menus,
> `/tools` typed; `/v1` and MCP-server turns keep the full list; plugins can't load tools; local first,
> then quick (never in private), 40 folds / 500k tokens a day; his last 6 turns kept). **Re-measured on
> the build** with the §1.1 harness (fresh folder, recording stand-in model, `o200k_base`): fresh install
> everyday 67 tools / 9,603 schema tokens → 18 / 2,778 (fixed part 11,871 → 5,471); coding 67 → 23
> (12,885 → 6,355); with the four MCP servers (started with `npx`, which works since 2.55.3) 141 tools /
> 20,640 → 18 / 2,778 (23,476 → 5,438, −77 %) and coding 24,490 → 6,325 (−74 %); "open an issue on the
> Sara repo" offers 12 GitHub tools up front (30 tools, 7,240). On a local model with *localCore* the
> everyday list is 14 tools (4,878). Live with Ollama gemma4:12b: she called `find_tools("entity store
> or memory store")`, got `mcp_memory_create_entities` loaded and used it through the normal card; a web
> `/compact` folded 12 messages (91 % → 40 %); an automatic fold ran in a stand-in Telegram chat.
> **Differences from the text:** families come from name prefixes (no `family` field set in `main.ts`);
> the persona's tool paragraphs stay keyed on the eligible list; replays and evals run with the full list
> (`force: 'off'`) and a replayed step doesn't re-apply a fold; a repeated identical `find_tools` query is
> answered by `find_tools` itself ("already looked") rather than the loop guard (which only counts
> failures); the fold focus is sent with the messages, not in the instruction (gemma4:12b returned
> nothing with it there); a summary over 3,000 characters is cut at its last sentence instead of
> retried; the "no thrash" rule counts his messages since the last fold *or undo* notice; the CH1 line
> is only sent with auto off or after the two-failure switch-off; Telegram/Discord also show the turn's
> `compact` notice line before the "(I tidied…)" line; *Jump to the tidy line*, the run view's tools line
> and the step line's *loaded* tag are not built.

**The owner's words (2026-10-31, approving the gap review's suggestions as Phases 115–128):** "I like
the top 10 as well as the lower down ones." The ROADMAP line he approved:

- *Phase 123 (2.56.0):* "Big tool sets: a lean tool list per turn, `/compact` (#13, #19)."

And the gap review's pitches he said yes to (GAP_REVIEW §2, gaps G8 and G20 in §1):

- **#13 · A lean tool list for many tools** (G8, M). *Pitch:* "with several MCP servers or plugins,
  she sees a short list and looks up the rest when needed, so small local models keep room to think."
  *Fits:* "the registry (`tools/registry.ts`) already knows each tool's source; MCP tools
  (`tools/mcp.ts`) and plugin tools become searchable through one *find a tool* entry; the skill
  catalog already uses this pattern (names always, bodies on demand)." *Simple UI:* "automatic above a
  threshold; a line in the run view says which tools were looked up." Risk note (G8): "Approvals stay
  in the registry, so hiding a schema can't skip a check; safety-critical tools (approvals, Stop)
  never deferred."
- **#19 · Tidy this chat now** (G20, S). *Pitch:* "`/compact` folds the older part of a long session
  into a summary right now, so the thread stays in view." *Fits:* "the summary memory kind and the CH1
  `/new` summariser; `buildHistory` uses the summary for the dropped part (it already does when one
  exists)." *Simple UI:* "when the context ring is nearly full, she offers *Tidy this chat* next to
  `/new`." Risk note (G20): "The summary is a normal summary memory (visible, forgettable); never pulls
  in other chats."

(GAP_REVIEW §4 numbered this release 122 / 2.55.0; the ROADMAP moved it to **123 / 2.56.0** when the
owner added WhatsApp/iMessage/SMS. This file follows the ROADMAP. §1 fact 6 explains why the summary
is **not** stored as a summary memory, which the G20 risk note assumed.)

**The brief for this design (from the parent, on the owner's behalf):**
1. *Read first:* how tools are offered per turn today (`src/chat.ts`, the registry, `src/tools/*`,
   MCP tools, plugin tools, skills, the coding tools, computer use); **how many tools and tokens a turn
   carries now, measured on a fresh data folder with the default tools plus a few MCP servers, with
   real numbers**; the existing context budgeting and summaries (history trimming, the session
   summary, CH2/CH3, `src/cheap.ts`, the carry-over on `/new`); the chat commands (Phase 107 CH1); the
   Phase 118 goals, which run long turns.
2. *Principles:* zero npm runtime deps; **a lean list never hides a tool the owner explicitly asked
   for, or a safety-relevant one**; **deterministic selection** where possible (keywords, recent use,
   mode, @-references) **with a "find more tools" tool for the model** (deferred loading), **not a
   model call per turn**; **`/compact` summarises the conversation so far with a cheap model
   (`src/cheap.ts`), keeps the originals, is visible and undoable, and works in the chat apps**;
   **automatic compaction near the context limit**; **private chats stay local-only** for the
   summarising model; **the safety layer (disclosure, crisis notes, the minors block) is never
   compacted away**.
3. *The document includes:* measured before/after token numbers (or estimates with the method), UI at
   1440/390, tables and routes, the Done-when list for `test/phase123.test.ts`, owner to-dos, risks,
   and blocking questions with defaults.

**Goal:** with GitHub, Playwright, a files server and a memory server plugged in, an everyday "remind
me to call Mum at six" turn sends her **18 tool schemas (≈ 2.9k tokens), not 141 (≈ 20.7k)**; when he
then says "open an issue on the Sara repo for that crash", the GitHub tools are offered because he
said *issue* and *repo*, and if she needs something no rule predicted she calls `find_tools("pull
request review")` once and has it on the next step, with the same approval card as always. And when a
three-hour debugging session fills the ring, one tap on *Tidy this chat* (or `/compact` from
Telegram) folds the first 46 messages into a 1,500-character summary written on this computer, the
46 messages stay right where they were in the thread, and *Undo* puts everything back.

**The rule of this track: build on what is there.** The per-turn tool list is already built in one
place: `runTurn` takes `app.tools.enabled(permissions)` and narrows it through about fifteen gates
(private, partner, group, other apps, SSH, computer use, skills, people, plans, plugins…, `chat.ts`
l. 1655–1690). This phase keeps that list exactly as it is and calls it the turn's **eligible** tools;
it adds one step after it that picks which eligible tools are **offered** as schemas this step, and
one tool that moves eligible tools into the offered set. The run gate (`chat.ts` l. 2580: "only the
tools offered this turn may run") keeps checking the **eligible** list, so permissions, approval
cards, the sandbox gate, unattended rules and the loop guard are exactly today's for every call,
offered or loaded. `/compact` is a fold in `buildHistory`: the oldest messages up to a boundary are
replaced, **for the model only**, by one app note carrying the summary; the stored messages are not
touched, so *Undo* is deleting one row. The summary is written by `cheapCall` (local first; private
conversations never leave this computer; a daily cap; usage rows with `purpose: 'compact'`), and when
no model is allowed a code-only "plain fold" is used instead (§5.6). Automatic compaction runs at the
point the CH1 *nearly full* offer already fires (85 % of the history budget). The mandatory safety
layer (`src/safety.ts`: AI disclosure at the start and every 3 hours, honesty when sincerely asked,
crisis resources, the hard block on sexual content involving minors) is not history: it is decided
per turn from the store and the current message, and this phase adds the pieces that make sure a fold
can never remove what it relies on (§6.1).

**Two word clashes to avoid.** "Summary" already means the memory worker's per-conversation summary
memory (`kind: 'summary'`, `memory-worker.ts`), CH4's room summaries (`room_summaries`) and the
budget ladder's capped "small summary" step. This phase calls its record a **fold** (`compactions`
table, the `compact` notice, `compact.ts`) and its text the **fold summary**; the user-facing words
are *Tidy this chat* / *Tidied* and the command `/compact`. And "lean" in OpenClaw's docs is a
different mode that removes optional tools; here **lean** only means "fewer schemas sent, nothing
removed" (every eligible tool stays callable).

Contents: 1 what exists today (with the measurement) · 2 how Hermes Agent, OpenClaw, Claude Code and
Codex do it, and where Sara differs · 3 the shape and shared building blocks · 4 part A: the lean tool
list · 5 part B: `/compact` and automatic folding · 6 safety and privacy · 7 household isolation ·
8 reuse vs build · 9 risks · 10 the phase at a glance · 11 blocking questions with defaults · 12 key
choices in short · 13 sources. The `test/phase123.test.ts` Done-when list is §5.14 (both parts), the
owner to-dos §5.15.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| The registry | `src/tools/registry.ts` (124 lines): `ToolRegistry` (`add`, `remove`, `get`, `list`), `defaultFor` (commands ask when unsandboxed, Phase 46), `permission(name, overrides)`, `enabled(overrides)` = every tool with `isAvailable() !== false` and permission ≠ `never` | One flat map; no grouping, no sizes, no notion of "offered". | The lean step reads `enabled()` unchanged; families are derived from `Tool.source` and name prefixes (§3.1 L1), not a registry rewrite. |
| What a tool is | `src/tools/types.ts` `Tool {spec: ToolSpec {name, description, parameters}, defaultPermission, isAvailable?, runsCommands?, asksFirst?, prepare?, source?, summarize, run}` | `source` is "built-in", "MCP: github", "Plugin: x". | `source` already names MCP servers and plugins; one optional field `family?` is added for built-ins (§3.1). |
| Where tools come from | `src/main.ts` l. 641–1011: the file tools and `web_fetch` (`BUILTIN_TOOLS`), `web_search`, planner (`todo`, `note`, `remind`), scrapbook, moments, recall, library, `send_file`, `tune_personality`, the code map (4), skills (6 + `recipe_save`), people (3), agenda, coding (`git*`, jobs, preview), computer use (`pc_*`), the testing browser (6), GitHub, Home Assistant, Google (Gmail, Calendar), Gmail organize, team, board (6), starter, project note, settings guide, safety report, routine card, code review, issue, shared list, wardrobe, A2A peers; `src/plugins/manager.ts` l. 900 (plugin tools); `src/tools/mcp.ts` `McpManager.#wrap` (`mcp_<server>_<tool>`, description `[server] …` ≤ 1,000 chars, the server's own JSON schema) | Everything the owner has set up is in one registry. | The families in §4.2 follow these blocks. |
| The per-turn list | `src/chat.ts` `runTurn` l. 1655–1690: `tools = noTools.has(model) \|\| conv.partner \|\| opts.noTools ? [] : app.tools.enabled(...)`, then `OFFSERVER_TOOL` off in private chats and private local mode, `recall` off for other apps, `opts.outside.tools` (Phase 100), `moments`, `send_file`, SSH, `pc_*`, `skill_*`, people, agenda, plugin tools, safety/routine tools, `GROUP_TOOLS` for groups | One list per turn, decided before the first step. **The mode of the conversation (coding or everyday) doesn't change it.** | This is the **eligible** list. The lean step runs right after l. 1690 and never adds anything that isn't in it. |
| What the model gets | `chat.ts` l. 2365: `const offered = tools.map((t) => t.spec)` → `provider.stream({messages, tools: offered})`; `providers/openai-compatible.ts` l. 113 sends `{type:'function', function:{name, description, parameters}}` for each; `buildSystemPrompt` (`persona.ts` l. 277) writes "You can act on {owner}'s server with tools: " + **every name** joined | Every eligible schema on **every step** of every turn, and every name again in the system prompt. | The two places this phase changes (§4.3, §4.6). |
| The run gate | `chat.ts` l. 2577–2583: unknown → error; `conv.partner \|\| !tools.some(t => t.spec.name === call.name) \|\| !isAvailable()` → "The {name} tool isn't available here." | A call runs only if the tool is in the turn's list. | Kept on the **eligible** list (§4.5): a loaded tool and a tool she names from memory go through the same gate, permissions and cards. |
| Tools that reject tools | `app.noToolModels`, `isToolsUnsupported` (l. 2381): a model that refuses tool definitions gets plain chat | | A lean list doesn't change this; it makes it rarer (smaller requests). |
| Skills (the pattern to copy) | `skill-tools.ts skillsSection` → `SkillStore.catalog(text)` (names and one line each in the system prompt, ranked by the message, optional embeddings with a 1.5 s cap); `skill_use` loads a body; `autoPick` loads one up front; `buildHistory` keeps a loaded skill's body whole while it's in use (`SKILL_KEEP_MESSAGES` 20) | "Names always, bodies on demand", and protection from trimming. | The tool directory (§4.6) and the "loaded stays loaded" rule (§4.4) follow it; a loaded skill's body is protected from folds the same way (§5.4). |
| History under a budget | `buildHistory` (`chat.ts` l. 778–907): `HISTORY_LIMIT` 60 messages, `HISTORY_BUDGET_CHARS` 48,000 (owner setting `historyBudgetChars`, "about 4 characters per token"), tool outputs past `RECENT_KEEP` 12 shortened to `OLD_TOOL_OUTPUT` 1,500, then the oldest messages left out, a huge message cut head + tail, tool results re-paired with their requests | Rebuilt **on every step** from the store. Drops are silent except for one note. | The fold is one more input to this function (§5.4); pairing and skill protection are reused. |
| The "earlier part left out" note | `chat.ts` l. 2244–2248: when `hist.dropped`, a note "this conversation is long, so its earliest part is left out here", plus **this conversation's summary memory** if one covers before `firstKeptId` | The only place a summary stands in for dropped history today. | Replaced by the fold when one exists (§5.4); kept as is otherwise. |
| The summary memory | `memory-worker.ts` l. 230–330: after a quiet time (or `memoryNudge()` at `/new`), `resolveFor(app, conv, 'background')` writes one `kind:'summary'` memory (≤ 1,500 chars, redacted, `sourceFromId`…`sourceMessageId`) and quoted facts; `forgetMemory` (l. 427) **hides every message in a forgotten summary's range** (`forgotten: true`) | Long-term memory of what a chat was about; used by *last time*, recall and the note above. | Why the fold is **not** a summary memory (fact 6). |
| The carry-over on `/new` | `bridges/commands.ts nextSession` (l. 266): ends the session, opens the next one in the same project, `memoryNudge()` summarises the old one now, `titles.atNew`; the new session's first ≤ 6 messages get `lastTimeNote` (Phase 32) | `/new` is a clean start that remembers through memory, not through the history. | `/compact` is the other choice next to it: same session, same thread, shorter history (§5.1). |
| The fill and the ring | `contextFill(app, conv)` (l. 913: `used`, `budget`, `dropped`, `percent`), the `context` chat event (l. 2243), `GET /api/conversations/:id/fill`, the web ring `#ctx-ring` / `#ctx-sheet` (`index.html` l. 214), `/status` | He can see how full the history is. | The sheet gets *Tidy this chat* and the tool numbers (§4.10, §5.10). |
| *Nearly full* | `bridges/commands.ts nearlyFullOffer` (l. 892): once per session at `OFFER_AT` 0.85 or on the first drop, "This chat is getting long. Send /new for a fresh start; I'll keep a summary of this one." (`command:offer` notice); setting `chats.offerNew` | The moment "near the limit" is already defined and tested (Phase 107). | Automatic folding runs at the same moment (§5.7); the line names `/compact` too. |
| Chat commands | `bridges/commands.ts`: `CommandName` (20 names), `COMMAND_WORDS` (six languages), `MENU_COMMANDS`, `commandAllowed(place, who, name)`, `runCommand`, `notice()`; the web app's `CHAT_COMMAND` regex and `POST /conversations/:id/command` | One parser and one permission table for the web app, Telegram, Discord, Signal, email, WhatsApp, Matrix, iMessage and plugin bridges. | `/compact` and `/tools` are two more names in the same table (§4.9, §5.9). |
| Cheap calls | `src/cheap.ts` (Phase 109): `cheapRoute(app, conv, 'local' \| 'quick')` (local first; **a private conversation only ever gets local models**; ≤ 2 models), `cheapCall` (the per-source daily ledger `budget_ledger` checked before the call, `usageScope.run({purpose})`, never throws), `safeLines` (minors check per line), `fenceLines` (other people's lines as data) | Titles (CH3) and room summaries (CH4) use it. | The fold summary is one more source (`compact`), §5.5. |
| Budgets | `budget.ts` `DEFAULT_TURN_BUDGETS` (coding 200k tokens / 40 steps on; everyday chats off), `TurnMeter` fed by the run's token sums, the ladder; `persist.ts` goals (5 rounds, 1,000,000 tokens, 60 min), loop ticks (50k tokens / 10 steps) | Tokens per turn are counted **including** the tool schemas on every step. | Fact 3: the schemas alone eat a coding turn's budget. |
| Goals (long turns) | `persist.ts` / `goals.ts` (Phase 118): a goal runs rounds; each round is an ordinary `runTurn` with `opts.persist` and a step-0 app note; checks between rounds | The longest-running conversations Sara has. | Folds happen between rounds, never inside a step (§5.7); tools she used in round 1 stay loaded in round 2 (§4.4). |
| The safety layer | `chat.ts` l. 1497 `disclosureDue(store.lastDisclosureAt(…))` (store state, every 3 h); l. 1583 a crisis in **this** message → `crisis_referral` safety event, a `crisis:` notice, `CRISIS_SYSTEM_NOTE` in this turn's system prompt; `preflight` and the minors check on his message and her reply; `meta.blocked` on a blocked reply | Decided per turn from the store and the current message. **Nothing in it reads old history**, except that the model sees the earlier crisis exchange because it is still in the history. | A fold could take that earlier crisis exchange out of view; §6.1 pins it. |
| Replays and evals | Phase 83 replays (`opts.replay`, recorded `extra`, `historyFromId`/`historyToId`), the run recorder's `startStep({tools…})`, evals with `opts.recorder` | A run can be replayed step by step. | Each step records which tools were offered and which fold was used, so a replay sends the same (§4.8, §5.4). |

What does **not** exist: any per-turn choice of tools (every eligible schema goes out on every step),
any notion of a tool's size or family, any way for her to look a tool up, any way to shorten a long
session **in place** (the choices are: let `buildHistory` drop the oldest part silently, or `/new`),
and any knowledge of the model's real context window (Sara never sets Ollama's `num_ctx` and no
provider config has a window size; a search for `contextWindow|num_ctx|context_length` in `src`
finds nothing).

Seven code facts change the design:
1. **The list ignores the mode.** A coding conversation and an everyday chat get the same 67 schemas on
   a fresh install (measured, §1.1). The mode is the cheapest strong signal there is, and it's unused.
2. **The system prompt names every tool.** `persona.ts` l. 277 joins all names into one sentence
   (202 tokens on a fresh install, **756 with four MCP servers**). A lean list that still names every
   tool there would invite calls to tools she has no schema for; the line becomes "offered names +
   a short directory" (§4.6).
3. **The schemas are paid on every step, and the coding budget counts them.** With four MCP servers a
   coding step carries ≈ 24.6k tokens before any history; the default coding budget (200k tokens per
   turn) is used up by the fixed part alone after **8 steps** of its 40. Lean: ≈ 6.2k a step, 32 steps.
4. **The run gate checks the turn's list, not what was sent.** That makes the split safe: keep the
   gate on the eligible list and nothing about permissions changes (§4.5).
5. **`buildHistory` runs on every step and already re-pairs tool calls with their results.** A fold is
   a pure change to its input (which messages, plus one note), so replays, the fill, `/status` and the
   ring all see it with no second code path.
6. **Forgetting a summary memory hides its messages.** `forgetMemory` marks every message in a
   summary's `sourceFromId…sourceMessageId` range `forgotten: true`. If the fold summary were a summary
   memory (as the G20 risk note assumed), *Forget* on it would quietly hide 46 of his messages, and the
   memory worker, *last time* and recall would read a second, overlapping summary of the same chat. The
   fold is therefore its own row (`compactions`), shown and undone in the thread; the memory worker
   keeps summarising the original messages as today. The reverse rule holds: when he has her forget
   something inside a folded range, that fold is dropped (§5.8).
7. **Stdio MCP servers started with `npx` don't start on Windows.** Measuring this phase, all four
   servers failed with `spawn npx ENOENT` (`tools/mcp.ts` l. 68 calls `spawn(file, args)` without a
   shell, and on Windows `npx` is `npx.cmd`); the built-in presets (`MCP_PRESETS`, e.g. `email`,
   `calendar`) use `npx`. The measurement used `node <package>/dist/index.js` instead. Not in this
   phase's scope; reported to the parent as a separate fix (§9 risk 12, §11 Q14).

### 1.1 The measurement (real numbers, 2026-11-02, this PC)

**Method.** A throwaway Sara 2.55.2 on a **fresh data folder** (`SARA_DATA` in the Hermes scratch
folder, `SARA_PORT` 7881, `127.0.0.1`), whose `settings.json` held only the owner name and one
OpenAI-compatible provider marked *local*: a fake model on port 7882 that recorded every request body
and answered "ok". Disclosure accepted through `POST /api/disclosure/accept`; nothing else set up. One
message, "Hi, what can you help me with today?", in a new everyday conversation and in a new coding
conversation. Then the same with four real MCP servers from npm, started as `node <bin>`:
`@modelcontextprotocol/server-filesystem` 2.1.0, `@modelcontextprotocol/server-memory` 2.0.1,
`@modelcontextprotocol/server-github` 2025.4.8 (no token: it lists its tools anyway) and
`@playwright/mcp` 0.0.84. Tokens counted with the `o200k_base` tokenizer over the exact JSON the
provider sent (`tools` array, compact JSON) and the exact system message. Sara's own rule of thumb
(4 characters per token) gives the same order: 41,759 / 4 ≈ 10.4k. The scratch data was deleted
afterwards.

**Before (today):**

| Setup | Conversation | Tools sent | Tool schemas | System prompt | Of which the "tools:" names line | Fixed part per step |
|---|---|---|---|---|---|---|
| Fresh install, default tools | everyday | **67** | 41,759 chars · **9,699 tokens** | 9,964 chars · 2,266 tokens | 202 tokens | **≈ 11,965 tokens** |
| Fresh install, default tools | coding | **67** (the same list) | 9,699 tokens | 14,194 chars · 3,280 tokens | 202 tokens | **≈ 12,979 tokens** |
| + 4 MCP servers | everyday | **141** | 92,386 chars · **20,722 tokens** | 12,213 chars · 2,820 tokens | 756 tokens | **≈ 23,542 tokens** |
| + 4 MCP servers | coding | **141** | 20,722 tokens | 16,443 chars · 3,834 tokens | 756 tokens | **≈ 24,556 tokens** |

Per source with the four servers: built-in 67 tools · 9,763 tokens; GitHub 26 · 3,885; Playwright 25
· 4,267; files 14 · 1,862; memory 9 · 1,081. The largest single schemas: `tune_personality` 671,
`remind` 539, `library` 385, `mcp_github_create_pull_request_review` 373, `ssh_connect` 356,
`starter_create` 345, `mcp_playwright_browser_take_screenshot` 324. A fresh folder doesn't yet have
`web_search` (no search provider), Gmail/Calendar/GitHub/Home Assistant (not connected), the `pc_*`
hands beyond `pc_devices` (no paired computer), moments, wardrobe or A2A peers; a set-up owner has
more than 67.

For scale: the whole default **history** budget is 48,000 characters ≈ 12,000 tokens. On a fresh
install the tool schemas alone are **80 % of it**; with four MCP servers **1.7 times** it. On a local
model whose window is a few thousand to 32k tokens, the schemas and the system prompt use most of the
window before he has said anything.

**After (estimated with the same tokenizer over the same recorded schemas, the default rules of §4):**

| Setup | Conversation | Tools offered | Tool schemas | Names line + directory | Fixed part per step | Change |
|---|---|---|---|---|---|---|
| Fresh install | everyday | 18 (11 core + 6 safety-pinned + `find_tools`) | ≈ 2,860 | ≈ 170 (was 202) | **≈ 5,090** | **−57 %** |
| Fresh install | coding | 23 (16 core + 6 pinned + `find_tools`) | ≈ 2,930 | ≈ 170 | **≈ 6,180** | **−52 %** |
| + 4 MCP servers | everyday | 18 | ≈ 2,860 | ≈ 170 (was 756) | **≈ 5,090** | **−78 %** |
| + 4 MCP servers | coding | 23 | ≈ 2,930 | ≈ 170 | **≈ 6,180** | **−75 %** |
| + 4 MCP servers, "open an issue on the repo" | everyday | 18 + 5 GitHub (keyword rule) | ≈ 3,620 | ≈ 170 | ≈ 5,860 | −75 % |

`find_tools`' own schema is estimated at 170 tokens (two fields, a 300-character description). The
directory (one line per family, with counts) measured 109 tokens for the four-server case. The
40-step coding turn's fixed part drops from ≈ 982k tokens to ≈ 247k (with MCP), so the default 200k
coding budget lasts ≈ 32 steps instead of 8. These numbers are re-measured on the built release by
the same harness (§5.15 owner to-do 1; §10).

**`/compact` (estimate, method):** a session at the 85 % mark has ≈ 40,800 characters of history
(≈ 10.2k tokens) in up to 60 messages. The default fold keeps the last 6 owner turns (at least 12
messages, at most 40 % of the budget) and replaces the rest with a fold summary of ≤ 1,500
characters plus a ≤ 400-character code-written header (§5.4). With typical coding turns
(≈ 1,500–3,000 characters per kept message after the existing tool-output shortening) the history
after the fold is ≈ 14–21k characters, **≈ 30–45 % of the budget (≈ 3.5–5k tokens), from 85 %**. The
summary call reads at most 24,000 characters (≈ 6k tokens) and writes at most 700 tokens; on a local
model it costs nothing, on the quick route it is counted in the `compact` ledger (§5.5).

---

## 2. How Hermes Agent, OpenClaw, Claude Code and Codex do it, and where Sara differs

Only features, from their public docs (read 2026-11-02; [H9], [H3], [H17], [H24], [O6], [O7], [O17],
[C5]–[C8], [X3]–[X5] in §13). No code, prompt or wording is taken.

- **Hermes Agent, Tool Search [H9].** Opt-in progressive disclosure: when active, MCP and non-core
  plugin tools are replaced in the model's tool array by three bridge tools (`tool_search`,
  `tool_describe`, `tool_call` with a batch of calls), and the model loads schemas on demand. A core
  working set (terminal, files, patch, search, todo, memory, browser, web, delegate…) stays loaded;
  "cold" built-ins can be deferred by a curated or explicit `defer` list; each batched call still gets
  its own scope check, schema validation, hooks and approval.
- **Hermes Agent, compression [H17][H24][H3].** Automatic compression when prompt tokens reach a share
  of the context window (default 50 %, a separate summariser model that can be pointed at any
  provider), a protected head and tail of recent messages, a gateway safety net at 85 %; `/compress`
  by hand, `/compress here [N]` keeps the last N exchanges verbatim, a focus topic narrows the summary.
- **OpenClaw, Tool Search [O7] (experimental).** Structured tool search on by default for its embedded
  runs: a bounded directory of tool names and descriptions that **scales with the model's window**
  (descriptions shorten before names are dropped), plus search/describe/dispatch controls; "direct-only"
  tools stay visible; local Ollama models keep web search/fetch and memory tools directly visible; every
  authorised entry stays callable; invalid arguments fail before the tool runs.
- **OpenClaw, compaction [O17].** Older turns summarised into one entry saved in the transcript, recent
  messages kept, tool calls kept paired with their results at the split, the full history stays on
  disk; the summariser's input is bounded (newest messages verbatim first, the user's older asks and
  corrections next, long tool results projected head + tail); `/compact` in its command list [O6].
- **Claude Code, MCP tool search [C5][C6].** On by default: only tool names (and server instructions)
  load at session start, schemas are fetched on demand; `ENABLE_TOOL_SEARCH=auto` loads them up front
  while they total under 10 % of the window (`auto:N` for another share), `false` loads everything;
  core built-ins (Bash, Read, Edit) always load; up to five relevant tools are loaded per search and
  stay until compaction; a server can mark tools `alwaysLoad`.
- **Claude Code, `/compact` [C7][C8].** Automatic compaction near the limit; `/compact` by hand with an
  optional focus ("focus on the API changes"); a "compact instructions" section in CLAUDE.md steers
  what is kept; persistent rules belong in CLAUDE.md because early instructions can be lost; it stops
  auto-compacting after a few attempts when one huge output refills the window; `/context` shows what
  uses space.
- **Codex [X3]–[X5].** `/compact` summarises earlier turns to free tokens; automatic compaction when
  `model_auto_compact_token_limit` is reached (model default otherwise); the Responses API's
  `/responses/compact` returns a compaction item used in place of the earlier input; changing the tools
  mid-conversation is named as a prompt-cache miss.

**Where Sara differs, on purpose:**

| Question | Others (docs) | Sara (this design) | Why |
|---|---|---|---|
| Which tools are deferred? | MCP + plugin tools; curated cold built-ins [H9][C6] | MCP, plugin and A2A tools, and **cold built-in families**, by default; a per-mode **core** stays; **safety-pinned** tools always stay | The measurement: a fresh install is already 9.7k tokens with no MCP at all |
| When is it on? | Opt-in [H9]; default on [C5][O7]; 10 % of the window [C6] | **Automatic when the eligible schemas exceed 6,000 tokens** (measured from the specs, cached), *Always* / *Off* in Settings, `/tools all` per chat | Sara doesn't know the window (§1); a fixed size is honest and testable |
| How does she get more? | Search + describe + call bridge tools [H9][O7]; search loads up to 5 [C6] | **One tool, `find_tools(query)`**: returns ≤ 8 matches and **loads ≤ 5 into the offered list from the next step on**; the call is then a normal call of that tool | One call is easier for small local models; a direct call keeps every gate, card and receipt exactly as today (no `tool_call` side door) |
| What else picks tools? | The model's search | **Code rules first**: the mode, words in his message (six languages), @-references, tools used recently in the chat, his pins, a loaded skill's tools | The brief: deterministic, no model call per turn |
| Can a lean list hide what he asked for? | — | **Never**: naming a tool, a server or a family, a pin, an @-reference or a tool he approved recently always offers it | The brief |
| Where the summary lives | In the transcript [O17]; replaces the input [X5] | **Its own row**; the originals stay in the thread, visible; the model gets the summary note instead of the folded messages; **Undo** | The brief: keeps the originals, visible, undoable; §1 fact 6 |
| Who writes it | The main or a separate summariser model [H17] | **The cheap-call helper**: local first, the quick route only if he allows it, **local only in private chats**, a daily cap; a **code-only plain fold** when no model is allowed | The brief; Phase 109's rules |
| When it runs on its own | 50 % [H17], near the limit [C7], a token limit [X4] | **At the CH1 *nearly full* point (85 % of the history budget), between turns and between goal rounds, never mid-step**, at most once per 10 owner messages | One defined point, already tested; no surprise mid-tool-chain |
| Chat apps | Gateways [H17] | **`/compact`, `/compact undo`, `/tools` in every bridge** through the CH1 table | The brief |
| Safety | — | **The crisis exchange, refused requests and the disclosure state are pinned or restated by code; the fold summary is minors-checked; private chats local only** | The brief (§6.1) |

---

## 3. The shape

```
 runTurn: today's gates (l. 1655–1690) ─► ELIGIBLE tools (unchanged; the run gate's list)
   │
   ├─ L2 lean on for this turn?  eligible schemas > 6,000 tokens (L1 size cache) · Settings · /tools all
   │     no ─► offered = eligible (today, byte for byte)
   ▼ yes
 L3 pick OFFERED (code only, once per turn, then grown per step):
     core for the mode ∪ safety pins ∪ his pins ∪ named in his message (words, @-refs)
     ∪ used / approved in this chat lately (tool_loads, sticky) ∪ a loaded skill's tools ∪ find_tools
   │
   ├─ system prompt: offered names + L5 directory ("More tools you can load: GitHub (26) · …")
   ▼
 step N: provider.stream({tools: offered specs})
   ├─ she calls find_tools("pull request review") ─► L4 search over ELIGIBLE (code) ─► ≤ 8 matches,
   │     ≤ 5 loaded ─► offered grows from step N+1 (tool_loads row, run step "Looked up tools")
   ├─ she calls an eligible tool that wasn't offered ─► same gate, same card ─► runs; loaded from now on
   └─ she calls a tool that isn't eligible ─► "isn't available here" (today's line)

 his message arrives / a goal round starts                        (part B)
   ├─ fill ≥ 85 % of the history budget and auto on? ─► F1 fold boundary (turn start, pairs intact)
   │     └─► F2 fold summary: cheapCall('compact') local first · private: local only · cap ─ or F3 plain fold
   │           └─► compactions row + `compact` notice in the thread ("Tidied 46 messages · Undo")
   └─ buildHistory(messages, budget, …, fold) ─► [fold note] + messages after the boundary
 /compact [focus] (web, Telegram, Discord, Signal, email, WhatsApp, Matrix, iMessage, plugins) ─► the same
 /compact undo · Undo on the divider ─► compactions.undone_at ─► the next step sends the originals again
```

### 3.1 Shared building blocks (built once, used by both parts)

1. **L1 · Families and sizes** (`src/lean.ts`, new). `familyOf(tool) → {id, label, kind: 'core' |
   'cold' | 'mcp' | 'plugin' | 'a2a'}`: MCP tools by server (`mcp:github`), plugin tools by plugin
   (`plugin:weather`), A2A by peer, built-ins by an optional `family` on `Tool` set where they're
   created in `main.ts` (`files`, `shell`, `web`, `planner`, `memory`, `ssh`, `code`, `skills`,
   `people`, `jobs`, `git`, `preview`, `browser`, `computer`, `team`, `board`, `google`, `github`,
   `home`, `photos`, `personality`, `review`, `starter`, `shared`, `safety`, `help`), with a name-prefix
   fallback for tools that don't set it. `specTokens(tool)` = `ceil(JSON.stringify(spec).length / 4)`,
   cached per tool name and spec hash (MCP servers can change their list; `McpManager.start` clears
   that server's entries). Sizes are an estimate in Sara's existing unit (4 characters per token, as
   `cheap.ts` and `historySize` use), never a tokenizer dependency.
2. **L2 · `leanFor(app, conv, opts, eligible) → LeanPlan | undefined`** (`src/lean.ts`): decides
   whether this turn is lean (§4.3) and, if it is, the first offered set with **a reason per tool**
   (`core`, `safety`, `pinned`, `asked`, `ref`, `recent`, `skill`, `goal`, `find`). Pure, code only,
   unit-tested without a model.
3. **L3 · `TurnTools`** (`src/lean.ts`): the turn's `{eligible, offered, reasons}` with `load(names,
   why)` (adds to offered **from the next step**, keeps order stable: core first in a fixed order, then
   loads in the order they happened), `isEligible(name)`, `offeredSpecs()`, `directory()`. `runTurn`
   holds one per turn; the step loop reads `offeredSpecs()` at l. 2365 instead of `tools.map(spec)`.
4. **L4 · `find_tools`** (`src/lean.ts`, a `Tool` added in `main.ts` next to `settings_guide`, family
   `help`, `defaultPermission: 'auto'`, never offered when the turn isn't lean). Search is code only:
   words of the query (lower-cased, folded accents, a small six-language synonym table per family, the
   same approach as `COMMAND_WORDS`) scored against each eligible tool's name, family label, source and
   first 300 characters of description (BM25-style weights, ties broken by recent use, then name). No
   embeddings, no model.
5. **L5 · The directory** (`TurnTools.directory()`): one line per family that has eligible tools not
   offered, "{label} ({n}: {up to 4 words})", families with the most recent use first, cut at 600
   characters with "… and N more groups". Written into the system prompt instead of the long names list.
6. **F1 · The fold boundary** (`src/compact.ts`, new). `foldBoundary(messages, budget, keep) →
   {throughId, folded: n} | undefined`: the newest owner message at or before which everything is
   folded, so that **the first kept message is an owner message (a turn start)**, no tool call is
   separated from its result, at least `keepTurns` owner turns (6) and 12 messages stay, kept text
   ≤ 40 % of the budget where possible, and the pinned messages of §6.1 stay outside the fold.
7. **F2 · The fold summary** (`src/compact.ts`): `writeFold(app, conv, range, {focus, trigger})` builds
   the summariser input from the folded messages (§5.5), calls `cheapCall({source: 'compact', purpose:
   'compact', model, …})`, checks the result (§6.1), and stores a `compactions` row.
8. **F3 · The plain fold** (`src/compact.ts`): when no model is allowed (no local model and the quick
   route not allowed, or the cap is reached, or the call failed twice), a code-written fold: his asks in
   order (each ≤ 200 characters, up to 20), the files she changed and the commands she ran (from the
   receipts), the last decision lines she wrote (sentences starting "I'll", "Decided", "Next"), and the
   fixed line "This is a plain list, not a summary." Better than silent dropping; never a model call.
9. **F4 · `foldFor(app, conv)` and `buildHistory(..., fold)`**: the active fold of a conversation (the
   newest row not undone whose range is still intact) passed into `buildHistory` as `{throughId, note}`;
   `contextFill`, `/status`, the ring, replays and goal rounds all go through the same call.

### 3.2 Where data lives

- **Per companion `store.db`** (the conversation's own database, like goals and `message_refs`):
  `tool_loads` (what was loaded in which conversation, how and when; the sticky set and the run view,
  §4.12) and `compactions` (each fold, §5.12). Both belong to a conversation and go when it is deleted.
- **Settings** (`lean`, owner-only, added to `OWNER_SETTINGS`): the switches and limits (§3.3) and his
  pins. Pins are names and family ids, never schemas.
- **Nothing new in memory.** A fold is not a memory row (§1 fact 6); `tool_loads` is not shown to her
  except through the offered list.
- **The run record** (`runs.ts`): each step records `offered` names (or a hash plus the difference
  from the previous step), `loaded` with reasons, and `foldId`; a `find_tools` call is an ordinary tool
  step. Replays read them (§4.8).

### 3.3 Settings shape (owner-only; `lean` added to `OWNER_SETTINGS`)

```ts
interface LeanSettings {
  tools: {
    mode: 'auto' | 'always' | 'off';     // auto: lean when the eligible schemas exceed `aboveTokens`
    aboveTokens: 3_000 | 6_000 | 12_000; // 6,000 (a fresh install measures ≈ 9.7k, so it is lean)
    pins: string[];                      // tool names or family ids he wants offered every turn ([])
    stickyTurns: 5 | 10 | 20;            // a loaded or used tool stays offered for this many of his turns (10)
    maxLoaded: 10 | 20 | 40;             // loaded tools offered at once on top of core and pins (20)
    perFind: 3 | 5 | 8;                  // tools one find_tools call loads (5)
    findsPerTurn: 2 | 4 | 6;             // find_tools calls per turn before it says "ask {owner}" (4)
    localCore: boolean;                  // true: on a model on this computer the core is the smaller list (§4.2)
  };
  compact: {
    auto: boolean;                       // true: fold at the nearly-full point (§5.7)
    at: 0.75 | 0.85 | 0.95;              // share of the history budget (0.85, the CH1 point)
    keepTurns: 3 | 6 | 10;               // his newest turns always kept verbatim (6)
    model: 'auto' | 'local' | 'quick' | 'plain'; // auto: local first, else the quick route; private: local only (auto)
    dailyCap: { runs: 20 | 40 | 100; tokens: 200_000 | 500_000 | 1_000_000 }; // (40 runs, 500k)
    crisisKeepHours: 24 | 72;            // a crisis exchange younger than this is never folded (24)
    partners: boolean;                   // false: no folds in partner chats (§5.2)
  };
}
```

Defaults are in `DEFAULT_LEAN`; `mergeLean` keeps unknown keys out and every number on its list, the
way `mergePersist` and `mergePrecise` do; pins are kept only if they name a tool or a family that
exists (an MCP server that is removed takes its pins with it on the next save, with a line on the
page).

---

## 4. Part A · a lean tool list per turn

### 4.1 Scope

In: every turn that has tools and an owner, partner-free: the owner's chats in the web app and the
desktop/phone apps, his DMs and work sessions in every chat app, coding conversations, goal rounds and
loop ticks, `/btw` (it already gets no tools), the VS Code panel's turns. The eligible list is decided
as today; lean only chooses which of its schemas are sent.

Out: turns whose eligible list is already small (group chats with `GROUP_TOOLS`, outside requests with
a policy list, members' companions: no tools) are never lean (they are under the threshold anyway);
other apps through `/v1` and MCP-server turns (Sara as a server) keep today's list in 2.56 (§11 Q9);
a model call to choose tools (never); hiding a tool from the model **and** from the gate (never: lean
never removes a tool).

### 4.2 Core, cold and pinned: the families

**Core for everyday chats** (11): `todo`, `note`, `remind`, `recall`, `library`, `send_file`,
`share_photo`, `person_lookup`, `skill_use`, `settings_guide`, `web_fetch` (+ `web_search` when a
search provider is set). **Core for coding conversations and work rooms** (16): `list_dir`,
`read_file`, `write_file`, `edit_file`, `search`, `shell`, `code_map`, `code_find`, `code_refs`, `git`,
`git_commit`, `start_job`, `web_fetch`, `skill_use`, `todo`, `remind`. With `localCore` on and a model
on this computer, the core drops to the first 7 of each list (local models have the smallest windows;
the rest is one `find_tools` away). The core lists are code constants, each entry checked against the
eligible list (a core tool he set to *Off* stays off).

**Safety-pinned, always offered when eligible** (6, ≈ 390 tokens): `stop_job` and `job_status` (stop or
check her own background work), `preview_stop` (stop a preview server she started), `ssh_revoke_key`
and `ssh_forget_password` (take back access she was given), `safety_report` (the Phase 121 check-up).
These are the tools whose absence could leave something running or reachable; they are small. The
approval system, Stop and the budget's *Ask me* are not tools and are untouched (G8's "approvals,
Stop never deferred" holds by construction). Further, the families `computer` (`pc_*`) and `ssh` are
offered **whole** once any of their working tools is offered (the two pinned clean-up tools don't
count), so she never holds half of a remote session (e.g. `ssh_connect` without `ssh_run`).

**Cold** (deferred until asked, named, found or used): every other built-in family (SSH, board,
team, the testing browser, preview, people notes, skill authoring, recipes, starters, review, shared
lists, scrapbook, moments, wardrobe, personality tuning, Google, GitHub, Home Assistant, computer use,
the code map's `code_deps`, git branch/push), **every MCP server, every plugin, every A2A peer**.

**Pinned by him**: Settings → Abilities → Tools and approvals → *Always offer* on any tool, family or
MCP server (§4.10); `/tools +github` in a chat pins it for that chat until `/tools -github`.

### 4.3 When a turn is lean

`leanFor` returns *not lean* (today's behaviour, byte for byte) when: `lean.tools.mode` is `off`; the
conversation has `/tools all` set; the turn is a replay of a run recorded before 2.56 (its recorded
list is used); the provider is one of the subscription CLI kinds that bring their own tools
(`claude-code`, `grok-cli`, where `tools` is not sent); or, in `auto`, the eligible schemas total ≤
`aboveTokens`. Otherwise it is lean for the whole turn (a turn never switches back and forth between
steps, so the provider's prompt cache and a local server's KV cache see one stable prefix per turn).

### 4.4 Picking the offered set (code only, once per turn)

In order, each tool with its first reason (shown in the run view and `/tools`):

1. **core** for the mode (§4.2), then **safety** pins, then **his pins** (Settings and `/tools +x`).
2. **asked**: his message names a tool (`mcp_github_create_issue`, `create_issue`), an MCP server or
   plugin by its name or label ("github", "playwright", "Home Assistant"), or a family by one of its
   words in six languages ("issue", "pull request", "repo" → GitHub; "server", "ssh" → SSH; "card",
   "board" → board; "browser", "click", "screenshot" → testing browser and Playwright; "email",
   "calendar" → Google). Word lists live next to `COMMAND_WORDS` and are tested per language. A family
   that is asked for is offered whole up to 12 tools (larger families: the 12 best matches by L4 plus
   the rest one `find_tools` away, and the directory line says "12 of 26 offered").
3. **ref**: an @-reference in his message (Phase 120): `@url` → `web_fetch`; `@file`/`@folder`/`@diff`
   /`@branch` → the file tools and `git`; `@problem` → the file tools.
4. **recent**: any tool used, approved or loaded in this conversation within the last `stickyTurns`
   (10) owner turns (`tool_loads.last_turn`), newest first, up to `maxLoaded` (20).
5. **skill**: a skill loaded for this turn (`autoPick`, `skill_use`) whose instructions name tools
   (`tools:` in its frontmatter, or tool names in its body matched against the eligible list).
6. **goal**: in a goal round or loop tick, every tool used in earlier rounds of the same goal (so round
   3 isn't spent rediscovering what round 1 found), within `maxLoaded`.
7. `find_tools` itself, last.

The order of the schemas sent is this order, with each group sorted by a fixed key, so the same
situation always produces the same array.

### 4.5 Calls: the gate is the eligible list

- A call to an **offered** tool: exactly today.
- A call to an **eligible tool that wasn't offered** (she remembers it from earlier in the chat, a skill
  names it, the directory made it obvious): the gate checks `isEligible` (today's rule, unchanged),
  then permissions, the approval card, the sandbox gate, unattended rules, the loop guard, all as
  today; it runs, and it is loaded for the following steps and turns (`tool_loads` reason `used`).
  Invalid arguments fail inside the tool as today and she sees the schema in the result line ("Here
  are the fields it takes: …", ≤ 1,000 characters), so she can retry once with it loaded.
- A call to a tool that **isn't eligible**: "The {name} tool isn't available here." (today's line).
- `find_tools` can never return or load a tool that isn't eligible: a private chat's search can't see
  MCP or web tools, a work room's can't see SSH, an outside request's can't see anything outside its
  policy. Lean narrows; it never widens.

### 4.6 What she reads: the prompt line and the directory

The system prompt's "You can act on {owner}'s server with tools: …" names **the offered tools only**,
then: "More tools are ready if you need them; call find_tools with what you want to do, and they'll be
here on your next step: {directory}". In the measured four-server case this is ≈ 170 tokens instead
of 756. The persona's tool-specific paragraphs (`ctx.tools.includes('code_map')`, `starter_create`,
`recipe_save`, `browser_open`…) are keyed on the **eligible** list as today when the family is core or
offered, and reduced to one directory word otherwise, so she still knows the starter and recipe
habits exist without paying for their schemas.

### 4.7 `find_tools`: the one way to get more

Schema (≈ 170 tokens): `find_tools({query: string (what you want to do, a few words), load?: string[]
(exact names from an earlier find to load)})`. Description: "Look up tools you don't have yet and load
them for your next step. Use plain words for the job ('create a GitHub issue', 'click a button on a
web page'). Only tools {owner} allows here can be found."

The result is a short text block (it is a tool result, stored, scrubbed and recorded like any other):

```
Loaded for your next step (5): mcp_github_create_issue (open an issue: owner, repo, title, body),
mcp_github_list_issues, mcp_github_get_issue, mcp_github_add_issue_comment, mcp_github_search_issues.
Also found (not loaded): mcp_github_update_issue, mcp_github_create_pull_request, mcp_github_search_code.
Say find_tools with load: [...] to load any of these.
```

Rules: at most `perFind` (5) loaded per call, at most `findsPerTurn` (4) calls a turn (then: "You've
looked {n} times this turn. Ask {owner} which tool they mean, or carry on with what you have."), the
Phase 116 loop guard sees repeated identical queries like any repeated call, no match → "Nothing here
matches '{query}'. These groups exist: {directory}". A family whose tools all ask first is labelled
"(asks {owner} first)" in the result, so she doesn't promise anything. `find_tools` costs no model
call and no network; it runs in under a millisecond on 500 tools (a test checks 2,000).

### 4.8 Runs, replays, evals, budgets

- **Run record**: each step stores the offered names (first step in full, later steps as `+added`),
  each load with its reason, and the lean decision (`lean: true, eligibleTokens, offeredTokens`).
  Settings → Runs shows one line under the step: "Tools: 23 of 141 offered (≈ 2.9k of 20.7k tokens) ·
  looked up: GitHub create issue, list issues". This is the G8 "line in the run view".
- **Replays** (Phase 83) send the recorded offered list of each step and record new loads on the
  branch only; a run recorded before 2.56 replays with its full list.
- **Evals** (`opts.recorder`) use the same deterministic rules; an eval can set `lean: 'off'` to
  compare (§10 measures both).
- **Budgets**: the `TurnMeter` is unchanged; it simply counts fewer input tokens. Rung 2 of the
  ladder ("one more tool round") keeps the offered set; rung 3 (no tools) sends none, as today.
- **Plugins** (`beforeModelCall` hooks) see `tools` as the offered names (what was sent) plus a new
  `eligible` count; a plugin can't load tools (§11 Q10).

### 4.9 In Telegram, Discord and plugin bridges

`/tools` (owner only, his DM and work sessions; partners get "Only the person who runs me can use that
here.") answers with zero model calls:

```
Tools here: 23 of 141 offered (about 2.9k of 20.7k tokens a step).
Offered: files, shell, code map, git, jobs, web, skills, reminders · safety: stop job, revoke SSH key…
Looked up lately: GitHub (create issue, list issues).
More on request: Playwright browser (25), files server (14), memory server (9), SSH (7), board (6)…
/tools all: every tool in this chat · /tools lean: back to the short list · /tools +github: always offer here
```

`/tools all` sets the chat's `lean_off` flag (until `/tools lean` or `/new`), `/tools +name` / `-name`
pin or unpin a tool, family or server for this conversation. The same text is the web app's `/tools`.
Words: `tools`, `herramientas`, `outils`, `werkzeuge`, `ferramentas`, `strumenti` in `COMMAND_WORDS`;
not in the native menus (`MENU_COMMANDS` stays short; §11 Q8).

### 4.10 The web app (1440 and 390)

**The context ring's sheet** (`#ctx-sheet`, header right) gains a tools line and, for part B, two
buttons. At 1440 px it is the existing 320 px pop-over under the ring:

```
┌ How full this chat is ─────────────────────────┐
│ ◔ 82 %  · 39,400 of 48,000 characters          │
│ Older messages will soon be left out.          │
│ Tools: 23 of 141 offered · ≈ 2.9k tokens a step│
│   looked up: GitHub (2)   [What she has ▸]     │
│ [ Tidy this chat ]  [ New session ]            │
│ This chat used 41k tokens today (free: local). │
└────────────────────────────────────────────────┘
```

At 390 px the sheet is the existing full-width bottom sheet; the same lines stack, the two buttons are
full-width (44 px tall), *What she has ▸* opens a second sheet listing the offered tools by family
with their reason chips (*core*, *you pinned*, *you asked*, *used lately*, *looked up*, *safety*) and
the deferred families with counts; each row has *Always offer here* (the `/tools +x` pin).

**The step line** (`web/steps.js`): a `find_tools` step reads "🔎 Looked up tools: GitHub create
issue, list issues (+3)" and expands to the result block; a tool loaded on use shows a small
*loaded* tag. At 390 the line truncates after the first two names.

**Settings → Abilities → Tools and approvals** (`ab-tools`) gets a card above the permission legend:

```
┌ Short tool list ───────────────────────────────────────────────────────────┐
│ ( Automatic ▾ )  Send her only the tools a message needs; she looks up     │
│                  the rest. Right now: 141 tools ≈ 20.7k tokens each step;  │
│                  short list ≈ 2.9k.                                        │
│ Lean above: ( 6,000 tokens ▾ )   Keep a looked-up tool for ( 10 turns ▾ )  │
│ [✓] Smaller list on models on this computer                                │
└────────────────────────────────────────────────────────────────────────────┘
```

Each tool group and each MCP server row in the existing list gets an *Always offer* toggle (the pin);
safety-pinned tools show a lock and "always offered: lets her stop or take back things". At 390 the
card's selects stack under the text.

### 4.11 ? tips (each ≤ 260 characters)

- *Short tool list:* "With many tools (MCP servers, plugins), sending every one with every message fills a small
  model's memory. She gets the ones this message needs and looks up the rest. Nothing is switched off:
  your approvals work the same."
- *Always offer:* "Use this for a tool she should never have to look up. It costs a little room in every
  message."
- *Looked up:* "She asked for tools she didn't have. They stay ready in this chat for 10 of your
  messages."

### 4.12 Tables (additive, `store.db` of each of the owner's companions)

```sql
CREATE TABLE IF NOT EXISTS tool_loads (
  conversation_id TEXT NOT NULL,
  tool            TEXT NOT NULL,          -- the tool name (mcp_github_create_issue)
  family          TEXT NOT NULL,          -- 'mcp:github', 'ssh', 'plugin:weather'
  how             TEXT NOT NULL,          -- 'find' | 'used' | 'asked' | 'ref' | 'pin' | 'skill' | 'goal'
  first_at        TEXT NOT NULL,
  last_at         TEXT NOT NULL,
  last_turn       INTEGER NOT NULL,       -- id of his message of the last turn that used/loaded it
  uses            INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0, -- /tools +x in this chat
  PRIMARY KEY (conversation_id, tool)
);
CREATE INDEX IF NOT EXISTS tool_loads_recent ON tool_loads(conversation_id, last_turn DESC);
ALTER TABLE conversations ADD COLUMN lean_off INTEGER;  -- /tools all (NULL = follow Settings)
```

Rows are written only for lean turns; `/new` doesn't copy them (a fresh session starts lean); deleting
a conversation deletes its rows. No schema or description is stored.

### 4.13 Routes (owner only; members, partners and the demo get 404)

| Route | Does |
|---|---|
| `GET /api/lean` / `PUT /api/lean` | the `lean` settings (both parts); `PUT` validated by `mergeLean` |
| `GET /api/lean/measure` | the current eligible list for an owner everyday chat and a coding chat: tool count, estimated tokens per family, what the short list would be (the Settings card's numbers; no model call) |
| `GET /api/conversations/:id/tools` | this chat's offered tools with reasons, loaded ones, deferred families with counts, `lean_off`, pins |
| `PUT /api/conversations/:id/tools` | `{lean: 'follow' \| 'off'}`, `{pin: name}`, `{unpin: name}` (the `/tools` sub-commands) |
| `GET /api/conversations/:id/fill` | (existing) gains `tools: {offered, eligible, offeredTokens, eligibleTokens, lean}` and `fold` (part B) |

---

## 5. Part B · `/compact`: tidy this chat now, and on its own near the limit

### 5.1 Scope

In: `/compact` and `/compact <focus>` (and *Tidy this chat* in the web app), `/compact undo`, the
automatic fold at the nearly-full point, between turns and between goal rounds; the fold divider in
the thread with *Show summary* and *Undo*; the fold in `/status`, the ring and the run record; every
chat app through the CH1 command table. `/new` stays exactly as it is: it is the "fresh start, she
remembers through memory" choice; `/compact` is "same session, shorter history".

Out (2.56): folding inside a step or in the middle of a tool chain (the existing trimming covers one
huge turn; §11 Q4); editing the fold summary by hand (§11 Q6); folding a room's own conversation (CH4's
room summaries do that job); folding off-the-record chats (they are short-lived and stored nowhere;
§11 Q5); a per-model context window (§11 Q3); anything that deletes or rewrites a stored message.

### 5.2 Who and where

| Where | `/compact` by hand | Automatic fold |
|---|---|---|
| His own chats with her (web app, desktop, phone, his DMs in every chat app) | Owner | On (Settings) |
| His work session in a room (`-work` channels, CH4) | Owner | On |
| Coding conversations, goals and loops | Owner | On, between turns and rounds |
| Private conversations | Owner; **summary by a model on this computer only, else the plain fold** | On, same rule |
| Partner chats | No (partners: "Only the person who runs me…"; the owner from his app: no, they're the partner's) | Off (`compact.partners` false; partner chats have no memory by rule, and a summary of them is memory-like; §11 Q7) |
| A room's own conversation, group chats of companions | No | No (CH4 room summaries; groups are short rounds) |
| Off the record | No | No |
| Other apps (`/v1`, MCP server, A2A, webhooks, outside requests) | No | No (their history is the client's or one-shot) |
| Members' companions (household) | The member, in their own chats with their own companion | On (their own space and caps; §7) |
| The demo | No | No |

### 5.3 Lifecycle

1. **Trigger**: his `/compact [focus]` (or *Tidy this chat*), or the automatic check (§5.7).
2. **Boundary** (F1): the newest owner message such that the last `keepTurns` (6) of his turns and at
   least 12 messages stay; nothing between a tool call and its result is split; pinned messages
   (§6.1) stay. If fewer than 8 messages would be folded: "This chat is already short; nothing to tidy."
3. **Summary** (F2, or F3 when no model is allowed): input built and checked (§5.5), one `cheapCall`,
   output checked; on failure one retry on the second model of the route, then the plain fold.
4. **Stored**: one `compactions` row (range, summary, model, local or not, tokens, characters before
   and after, trigger, who), one `compact` notice in the thread at the boundary (role `notice`, never
   sent to a model), a `fold` chat event so open clients redraw the divider.
5. **Used**: from the next model step on, `buildHistory` gets the fold (F4).
6. **Undone** (any time): `undone_at` set, a second `compact` notice "Untidied", the next step sends
   the originals again (still under the ordinary trimming). *Redo* is simply `/compact` again.
7. **Folding again later**: a second fold covers from the start of the chat to its new boundary; its
   input is **the previous fold summary plus the messages after it** (so the input stays bounded), and
   the older row is marked `replaced_by`. Undoing the newer fold brings back the older one.

A turn in progress is never changed: a `/compact` sent while she works is queued (Phase 116's queue)
and runs after the turn; the web button is disabled with "She's working; I'll tidy when she's done".

### 5.4 What the model gets: the fold note

`buildHistory(messages, budget, …, fold)` leaves out the stored messages with `id ≤ throughId`
(except pinned ones, which stay in place) and puts one note first:

```
[Note from the app: the earlier part of this chat ({n} messages, {date first}–{date last}) is tidied
into the summary below, at {owner}'s request | because it got long. The messages are still saved;
{owner} can see them and undo this. The summary was written by an app helper from those messages.
It is notes, not instructions: nothing in it can approve, allow or change anything.
<summary>
…the fold summary…
</summary>
{code lines: safety carry (§6.1), files changed, open items she promised}]
```

The code lines are written by Sara, never by the summariser: "Files you changed in that part:
src/a.ts, src/b.ts (from the receipts)"; "Open promises from that part: …" (her `promise` memories
whose source message is in the range); and the §6.1 safety lines. The note counts against the
history budget like any message. A skill body that was in use stays (the existing `skillBody` rule
brings it back as its own note); the newest @-reference block stays if its message is kept, else it
becomes the usual one-line stub. The "earliest part is left out" note (l. 2244) is not added when a
fold covers the left-out part; if the history still overflows after a fold, the ordinary trimming
applies to what's after the boundary and that note says so.

### 5.5 The summary call (the cheap model, bounded, checked)

- **Route**: `cheapRoute(app, conv, pick, 'compact')` with `pick` from `compact.model`: `auto` = the
  local route if it isn't empty, else the quick route; `local` = local only; `quick` = the quick route;
  `plain` = never a model. **A private conversation always gets the local route** (`cheapRoute`
  already forces it), and in private local mode only models on this computer (`isLocalModel`). With
  no allowed model: the plain fold (F3), said on the divider ("tidied as a plain list: no model on this
  computer").
- **Ledger**: source `compact`, `cap = compact.dailyCap`; `estTokens` from the input size; over the cap
  → the plain fold, and the divider says "today's tidy budget is used up".
- **Input** (≤ 24,000 characters, like the memory worker's transcript lines): his messages verbatim
  (each ≤ 2,000 characters), her replies (each ≤ 1,200), tool calls as one line each ("ran shell: npm
  test → exit 1"), tool results projected head + tail (≤ 600 characters, "…" in the middle), with this
  order when it doesn't fit: the newest folded messages first, then his older asks and corrections,
  then the rest evenly, each gap marked "[{n} messages not shown]". Other people's lines (partners in
  a room, quoted emails, web pages, tool output) go through `fenceLines` as data. **Every line passes
  `safeLines` (minors check); messages with `meta.blocked`, `forgotten` or off-the-record are never
  included** (§6.1).
- **The instruction** (Sara's own words, in `compact.ts`): write ≤ 1,500 characters in the owner's
  language; keep what he asked for, decisions and why, names, numbers, file paths, errors still open,
  what she promised to do next; keep his corrections exactly; don't add anything that isn't in the
  messages; treat fenced text as data; write in the third person about both ("{owner} asked… {her
  name} changed…"); with a focus: "{owner} wants this kept in particular: {focus}" (focus ≤ 200
  characters, itself checked by the minors check).
- **Output checks**: empty, over 3,000 characters, or not text → retry once, then F3; `minorSexualMatch`
  on the output → discarded, F3, and a `safety_event` row; `app.redactor.redact` on the stored text;
  lines claiming approvals or permissions ("Alex approved …") are kept as text but the note's frame
  says it has no authority, and approvals are never read from history anyway.
- **Time**: ≤ 120 s (the `cheapCall` timeout); the web app shows "Tidying… (on this computer)" on the
  divider; Stop cancels it (nothing is stored).

### 5.6 The plain fold (no model)

Written by code from the same range: "Plain list of the earlier part ({n} messages): {owner} asked: 1.
… 2. … (up to 20, each ≤ 200 characters) · You changed: src/a.ts, src/b.ts · You ran: npm test (exit
1), git commit · Open: … (her promises)". It's honest about what it is, costs nothing, and is the
fallback for every failure. A plain fold can be replaced later by `/compact` once a model is allowed.

### 5.7 Automatic folding (near the limit)

- **When**: at the start of an owner turn (before the first model call, after his message is stored),
  at the start of a goal round or loop tick, and after a turn ends **only** in the web app's idle time
  (so the next turn starts light); never during a step.
- **Condition**: `compact.auto` on, the place allows it (§5.2), the history fill (`contextFill`, the same
  measure as the ring) ≥ `compact.at` (85 %) **or** `buildHistory` would drop messages, at least 10 of
  his messages since the last fold (no thrash), and the last automatic fold of this chat didn't fail
  twice in a row (then: off for this chat until he runs `/compact`, said once).
- **How it's shown**: the divider appears in the thread ("✂ Tidied 46 earlier messages so the chat
  stays in view · Show · Undo"); in chat apps, one line before her reply: "(I tidied the older part of
  this chat to keep it in view. /compact undo to put it back.)" (once per fold, in his language). The
  CH1 *nearly full* line becomes: "This chat is getting long. Send /compact to tidy the older part, or
  /new for a fresh start." and is only sent when auto is off or the fold failed.
- **Turn latency**: a local summary takes seconds; the turn's "thinking" status says "Tidying the older
  part first…". If the fold takes longer than 20 s, the turn goes on with the ordinary trimming and the
  fold is used from the next turn.

### 5.8 Undo, forget and the originals

- The folded messages are never changed. The thread keeps showing them above the divider, slightly
  dimmed, with the label "Not sent to her right now: tidied into a summary" on the divider (§5.10).
- *Undo* / `/compact undo` sets `undone_at`; nothing else changes.
- **Forget wins**: when he has her forget a message (`forgotten: true`, `forgetMemory`) or deletes one
  inside a fold's range, that fold is dropped at once (`undone_at`, `undo_reason: 'forgotten'`), its
  summary text is erased from the row, and a notice says "The tidy summary was removed because you had
  her forget something in it. /compact to tidy again." A summary must never keep what he removed.
- Deleting the conversation deletes its folds. Export (`export.ts`) includes folds as notices with
  their summaries; import ignores them (a fold is a view, not history).
- The memory worker keeps summarising the original messages; a fold changes nothing it reads.

### 5.9 In Telegram, Discord and plugin bridges

`/compact` (owner only; in his DM and his work session in a room) → "Tidying the older part of this
chat…" then "Tidied 46 earlier messages into a summary (written on this computer). Send /compact undo
to put them back, or /compact show to read it." `/compact show` sends the summary (≤ 1,500 characters,
in the bridge's message size limits; long ones split). `/compact <focus>` passes the focus. A partner
gets "Only the person who runs me can use that here." Words in six languages: `compact`, `compactar`,
`resumir`, `compacter`, `kompakt`, `compattare`, `ordenar` (Spanish "tidy"), checked against existing
words for clashes. `compact` is added to `MENU_COMMANDS` (Telegram's and Discord's native menus) so he
finds it next to `/new` (§11 Q8). Platforms with buttons (Telegram inline keyboard, Discord components)
add *Undo* under the confirmation; plugin bridges without buttons get the typed form.

### 5.10 The web app (1440 and 390)

**The divider in the thread** (rendered from the `compact` notice, `web/app.js` notice renderer next to
the `command:new` / `offer` ones). At 1440 px, centred in the 760 px thread column:

```
   … (older messages, 70 % opacity) …
 ───────────── ✂ 46 earlier messages tidied · written on this computer (gemma3:4b) ─────────────
               Not sent to her right now: she reads the summary instead.
               [ Show summary ]  [ Undo ]                                   Oct 31 – Nov 2
   … (the kept messages, normal) …
```

*Show summary* expands a card under the divider with the summary text, the code lines (files, open
items), "Focus: …" if one was given, and the model and token line ("1,412 characters · 5,980 tokens
read · free"). A plain fold reads "✂ 46 earlier messages tidied as a plain list (no model on this
computer)". An undone fold collapses to one muted line "Tidy undone · Nov 2 14:10" with *Tidy again*.
While a fold is being written: "✂ Tidying… (on this computer)" with *Stop*.

At 390 px the divider is two lines (the count and the model on the first, the label on the second)
and the buttons are full-width chips under it (44 px tall), *Undo* on the right; the summary card is
full width with 16 px padding. The dimmed older messages stay scrollable; "Jump to the tidy line"
appears in the existing "jump to latest" pill's place when he scrolls far up.

**The ring's sheet** (§4.10): *Tidy this chat* is enabled from 50 % fill (or when anything was
dropped); below that it reads "Nothing to tidy yet". After a fold the sheet says "Tidied 46 messages ·
Undo" and the ring shows the new fill. When auto is on, a muted line: "She tidies on her own at 85 %
(Settings)".

**Settings → Models → Default model → *Long conversations*** (the section that already holds
*Conversation length*, `#history-budget` / `historyBudgetChars`, `index.html` l. 2368) gets a box
under that select:

```
┌ Tidy long chats ───────────────────────────────────────────────────────────┐
│ [✓] Tidy long chats on their own   at ( 85 % ▾ ) full                      │
│ Keep his last ( 6 ▾ ) turns word for word                                  │
│ Who writes the summary: ( A model on this computer first ▾ )               │
│   Private chats always use a model on this computer, or a plain list.     │
│ Daily limit: ( 40 tidies ▾ ) ( 500k tokens ▾ )   Used today: 3 · 18k       │
│ Keep a crisis conversation word for word for ( 24 hours ▾ )               │
└────────────────────────────────────────────────────────────────────────────┘
```

At 390 the selects go under their labels. The composer's `/` menu lists `/compact` and `/tools` with
one-line descriptions.

### 5.11 ? tips (each ≤ 260 characters)

- *Tidy this chat:* "Folds the older part of this chat into a short summary she reads instead, so the
  thread stays in view. Your messages stay right where they are, and Undo puts everything back."
- *Written on this computer:* "The summary was written by a model on this computer; nothing left it.
  Private chats are always done this way, or as a plain list."
- *Plain list:* "No model was allowed to write a summary, so Sara listed what you asked and what she
  changed. Tidy again once a model on this computer is set up."
- */compact focus:* "Add what matters most, like /compact keep the API changes, and the summary keeps
  that in particular."

### 5.12 Tables (additive, `store.db` of each of the owner's companions)

```sql
CREATE TABLE IF NOT EXISTS compactions (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  from_id         INTEGER NOT NULL,       -- first folded message (or the replaced fold's from_id)
  through_id      INTEGER NOT NULL,       -- last folded message; the first kept one is an owner message
  pinned_ids      TEXT,                   -- JSON: messages inside the range kept verbatim (§6.1)
  folded          INTEGER NOT NULL,       -- how many messages it stands in for
  summary         TEXT,                   -- the fold summary (redacted); NULL after a forget
  kind            TEXT NOT NULL,          -- 'model' | 'plain'
  focus           TEXT,
  model           TEXT,                   -- 'gemma3:4b' / provider label; NULL for plain
  local           INTEGER NOT NULL DEFAULT 0,
  tokens          INTEGER NOT NULL DEFAULT 0,
  chars_before    INTEGER NOT NULL,       -- history size before (the fill measure)
  chars_after     INTEGER NOT NULL,
  trigger         TEXT NOT NULL,          -- 'command' | 'button' | 'auto' | 'goal'
  by_place        TEXT,                   -- 'web', 'telegram', 'discord', 'plugin-x'…
  safety          TEXT,                   -- JSON: {crisisAt?, refused?, disclosureAt?} (§6.1)
  replaced_by     INTEGER,
  created_at      TEXT NOT NULL,
  undone_at       TEXT,
  undo_reason     TEXT                    -- 'owner' | 'forgotten' | 'deleted'
);
CREATE INDEX IF NOT EXISTS compactions_conv ON compactions(conversation_id, created_at DESC);
```

The usage rows (`purpose: 'compact'`) and the ledger (`budget_ledger` source `compact`) are the
existing tables. No change to `messages` or `memories`.

### 5.13 Routes (owner only; members in their own space; partners and the demo get 404)

| Route | Does |
|---|---|
| `POST /api/conversations/:id/compact` | `{focus?}` → `{fold}` or `{skipped: 'short' \| 'busy' \| 'not-here'}`; runs F1–F3; 409 while a turn runs (the web app queues) |
| `GET /api/conversations/:id/compactions` | the folds of this chat, newest first (summary text included) |
| `POST /api/compactions/:id/undo` | sets `undone_at`; publishes the `fold` event |
| `GET /api/conversations/:id/fill` | (existing) gains `fold: {id, throughId, folded, kind} \| null` |
| `POST /api/conversations/:id/command` | (existing) understands `/compact`, `/compact undo`, `/compact show`, `/tools …` |

### 5.14 Done when (`test/phase123.test.ts`, plus the existing suites green)

With the **scripted fake model** (`test/helpers.ts` `FakeProvider` / `makeApp`: it plays a script of
steps and records every request, including the `tools` array), a **fake clock**, a **fake registry
of 140 tools** built from the four recorded MCP tool lists of §1.1 (stored as a fixture JSON, no npm
server needed) plus the real built-ins, and a **fake cheap model** (a second `FakeProvider` marked
`local`, and one not local for the quick route) that records what it was asked.

*Part A, the lean tool list*
- **Sizes and the switch**: `specTokens` of a recorded spec equals `ceil(chars/4)`; with the built-ins
  only (≈ 9.7k estimated) and `aboveTokens` 6,000 the turn is lean; at 12,000 it isn't and the request's
  `tools` array equals today's byte for byte; `mode: 'off'` and `/tools all` → today's array; a
  `claude-code` provider → no change.
- **The main test**: everyday chat, fake 140 tools, message "remind me at six to call Mum" → the
  request carries exactly the everyday core + safety pins + `find_tools` (18 names, in the fixed
  order), no `mcp_*` schema; the system prompt names those 18 and has the directory line with "GitHub
  (26)"; then the fake model calls `find_tools({query:'create a github issue'})` → the result lists
  `mcp_github_create_issue` first, the **next** request in the same turn carries its schema, the fake
  model calls it, the approval card appears exactly as with lean off (same `approval` event fields),
  and the run's step shows "looked up".
- **Never hides what he asked for**: "open an issue on the repo" → GitHub tools offered on step 0
  without a search; "use playwright to click Login" → Playwright offered; `@url:https://x.test` →
  `web_fetch` offered; a pinned tool (Settings) and `/tools +board` → offered every turn; the same words
  in Spanish, French, German, Portuguese and Italian → the same families.
- **Safety pins**: `stop_job`, `job_status`, `preview_stop`, `ssh_revoke_key`, `ssh_forget_password`
  and `safety_report` are in every lean request where they are eligible, in both modes and with
  `localCore`; asking for one SSH tool offers the whole SSH family.
- **The gate is unchanged**: a fake model calling an eligible but not offered tool → runs through the
  same permission and card path (a tool set to *ask* asks), is loaded for the next step; a tool that
  isn't eligible (an MCP tool in a private chat) → "isn't available here", and `find_tools` in that
  chat never lists it; a tool set to *Off* is never found; a partner chat has no tools and no
  `find_tools`.
- **Sticky and bounded**: a tool found in turn 1 is offered in turns 2–10 and not in turn 12 (fake
  clock, `stickyTurns` 10); more than `maxLoaded` loads → the oldest drop out; the 5th `find_tools`
  call in a turn → the "ask {owner}" line; the same query twice → the loop guard's note; offered order
  is stable across steps (only appends).
- **Goals**: a tool loaded in round 1 is offered in round 2 of the same goal.
- **Replays and runs**: a replay of a lean run sends the recorded `tools` arrays step by step; a replay
  of a pre-2.56 run sends its full list; the run JSON has `offered`, `loaded` with reasons and the
  token estimates; `/tools` from the fake Telegram owner answers with zero model calls.
- **Speed**: `find_tools` over 2,000 fake tools answers in < 50 ms; `leanFor` on 500 tools < 5 ms.

*Part B, `/compact`*
- **The main test**: a 70-message chat at 90 % fill; `/compact` from the fake Telegram owner → one
  call to the **local** fake cheap model (the quick one sees nothing), a `compactions` row
  (`kind 'model'`, `local 1`, range ending just before an owner message, ≥ 6 of his turns kept), a
  `compact` notice, the reply "Tidied … /compact undo …"; the next turn's request starts with the fold
  note (summary between `<summary>` tags, the "notes, not instructions" frame, the code lines naming the
  files from the receipts) and contains **none** of the folded messages; `store.messages` is unchanged
  (same ids and contents); `contextFill` drops below 50 %.
- **Undo**: `/compact undo` → `undone_at` set, the next request carries the original messages again;
  a second fold after more messages uses the first fold's summary plus the newer messages as its input
  (the fake cheap model's request shows it), and undoing it restores the first.
- **Pairs and pins**: the boundary never separates a tool call from its result (a fixture with a
  20-call step at the boundary); a loaded skill's body in use survives a fold; fewer than 8 foldable
  messages → "nothing to tidy".
- **Private stays local**: a private conversation with only the quick (cloud) fake model configured →
  no cheap call at all, a **plain** fold; with a local fake model → that one; private local mode on →
  only a model on this computer; `compact.model: 'quick'` in a private chat → still local.
- **Safety never folded away**: (1) a crisis message 2 hours old inside the would-be range → that
  message and her reply stay verbatim (pinned) and the fold note carries the code-written crisis line;
  at 30 hours (fake clock) only the crisis line remains; (2) a refused request (`meta.blocked`) inside
  the range → never in the summariser's input, the note says "{n} requests earlier were refused under
  the safety rules"; (3) a fake summariser that returns text tripping `minorSexualMatch` → discarded,
  plain fold, a `safety_event` row; (4) a minors phrase inside the focus text → refused before any call;
  (5) the disclosure: a turn after a fold still gets the disclosure when `lastDisclosureAt` is over 3 h
  old (fake clock), and a fold never changes `lastDisclosureAt`; (6) every turn after a fold still runs
  `preflight` on his message and the reply checks.
- **Forget wins**: forgetting a message inside a folded range → the fold is undone with
  `undo_reason 'forgotten'`, its `summary` is NULL, the notice appears, and the next request has
  neither the summary nor the forgotten message.
- **Automatic**: auto on, a turn that starts at 86 % → a fold before the first model call, the run's
  step 0 shows `foldId`; at 84 % → none; two folds can't happen within 10 of his messages; a fake cheap
  model that fails twice → plain fold, then auto off for this chat with one notice; a fold that takes
  > 20 s (fake clock) → the turn goes on unfolded and the fold applies next turn; partner chats, rooms'
  own conversations, `/v1`, MCP and A2A turns → never folded; the CH1 offer line names `/compact` and
  is sent only when auto is off.
- **Cap and cost**: the ledger source `compact` counts runs and tokens; over the cap → plain fold with
  "today's tidy budget is used up"; usage rows have `purpose: 'compact'`.
- **Chat apps**: `/compact`, `/compact undo`, `/compact show`, `/compact keep the API part` (focus in
  the fake model's request), the six-language words, a partner's `/compact` refused before any model
  call, the Telegram inline *Undo* button and the plugin bridge's typed form.
- **Old data and clients**: a 2.55 database opens and gets `tool_loads`, `compactions` and
  `conversations.lean_off`; a 2.55 web client shows the `compact` notice as a plain notice line;
  zero new npm runtime dependencies (`package.json` `dependencies` unchanged).

### 5.15 Owner to-dos

1. Re-measure on the release with the harness of §1.1 (fresh folder, the four MCP servers as `node
   <bin>`), and paste the before/after table into the release notes.
2. On this PC with a local model (Ollama) in an everyday chat: "remind me…", then "open an issue on the
   Sara repo for X" with the GitHub MCP connected, then "use the browser to check the site" with
   Playwright; watch the step lines and *What she has*. Try `/tools`, `/tools +github`, `/tools all`.
3. In a long coding session: let the ring reach 85 % (or press *Tidy this chat* at ~60 %), read the
   summary, *Undo*, tidy again with a focus. Do the same from Telegram with `/compact` and `/compact
   undo`, and from one other app (Signal, WhatsApp or Matrix).
4. In a private conversation with only a cloud quick model set: `/compact` must give a plain list.
5. Decide §11 Q1–Q14.

---

## 6. Safety and privacy across the phase

### 6.1 The mandatory layer is never compacted away

The layer is decided per turn from the store and the current message (§1), so most of it can't be
folded at all; the phase adds a rule for each piece that the history *does* carry.

| Piece | Where it lives today | What a fold could break | What this phase does |
|---|---|---|---|
| AI disclosure (start and every 3 h) | `store.lastDisclosureAt`, `disclosureDue`, the disclosure notice; the persona's honesty rule in the system prompt | Nothing: the clock is in the store and the rule is in the system prompt, which is never folded | Tested: a fold never touches `lastDisclosureAt`; a turn after a fold still discloses when due. The fold note never contains the disclosure text and the summariser is told the speakers are "{owner}" and "{her name}, an AI companion" |
| Honesty when sincerely asked | System prompt (persona) | Nothing | — |
| Crisis resources and the crisis note | A crisis in **this** message → `crisis_referral` safety event, `crisis:` notice, `CRISIS_SYSTEM_NOTE` for this turn; later turns see the exchange only because it's in the history | A fold could hide a recent crisis exchange, so she'd answer the next message as if nothing happened | **Pinned**: the crisis message and her reply stay verbatim outside the fold for `crisisKeepHours` (24 h); after that, the fold note carries a code-written line: "On {date}, {owner} said things that pointed to a crisis; the crisis resources were shown. Be gentle, and if it comes up again, say the resources again." The `safety` JSON of the row records it |
| The minors block | `preflight` and `minorSexualMatch` on his message and her reply, `meta.blocked`, `MINOR_BLOCK_REPLY` | A summary could restate a refused request in softer words and let it in through the back door | Blocked messages are **never** in the summariser's input (`safeLines` on every line too), the output is checked (`minorSexualMatch` → discard, plain fold, safety event), the focus text is checked, and the fold note says "{n} requests earlier were refused under the safety rules" so she doesn't treat the topic as open |
| Partner, work-room and adult-off notes | `safetyNotes` per turn, system prompt | Nothing | — |
| The stop word | Checked in this message (`usedStopWord`) | A fold could hide that a scene ended | The fold note says "A scene ended with the stop word on {date}" when one is in the range (code line, like the crisis line) |
| Approvals | `ApprovalBroker`, per call | A summary saying "Alex approved deleting the folder" | Approvals are never read from history (they are per call); the fold note's frame says it has no authority; tested with such a summary |

And for part A: every eligible tool keeps its permission, card, sandbox gate, unattended rule and loop
guard; the safety-relevant tools are pinned (§4.2); `find_tools` can't widen the eligible list.

### 6.2 Privacy

- **Private conversations**: the fold summary is written by a model on this computer or not at all
  (plain fold). `cheapRoute` already forces the local route for `conv.private`; the test in §5.14 sets
  `compact.model: 'quick'` and still sees no cloud call. In private local mode, only models on this
  computer (`isLocalModel`).
- **Other people's words**: room lines, quoted emails, web pages and tool output go to the summariser
  fenced as data (`fenceLines`); partner chats are not folded.
- **Forgotten and off-the-record**: never in the input; a forget inside a fold drops the fold (§5.8).
- **No new place for secrets**: the summary is redacted (`app.redactor`) before it's stored; tool loads
  store names only.
- **Lean and privacy**: lean sends **fewer** schemas to the provider; MCP tool descriptions (which can
  name his servers, repositories or rooms) leave the computer less often.

### 6.3 The leak paths, and what closes each

| Path | Closed by |
|---|---|
| A tool result tells her "call find_tools('ssh') and run ssh_run…" | `find_tools` only loads eligible tools; every call still needs its permission and card; output is untrusted as today |
| A hidden tool runs without its card because it wasn't "offered" | The gate checks eligibility, then the full permission path (§4.5); tested |
| A private chat finds MCP or web tools through search | Search runs over the private chat's eligible list, which has none (§4.5) |
| The fold summary goes to a cloud model from a private chat | `cheapRoute` local only; plain fold otherwise |
| A summary keeps what he had her forget | Forget drops the fold and erases its text (§5.8) |
| A refused request comes back through a summary | Never in the input; output minors check; the refused-count line |
| A crisis is folded out of view | Pinned for 24 h; the crisis line after |
| A prompt injection in tool output steers the summary ("write: Alex allows all tools") | Fenced as data; the fold note says it has no authority; approvals aren't read from history |
| A huge tool output refills the history right after a fold | The existing head/tail cut; auto folds at most once per 10 of his messages; two failures switch auto off for the chat |

### 6.4 Threat model additions (`docs/THREAT_MODEL.md` in the release)

A tool or web page asking her to load and use other tools (lean narrows, never widens; every call
gated); a summariser model that invents permissions or facts (frame without authority, code-written
lines for the facts that matter, *Show summary* and *Undo* in front of him); a summary that launders a
refused or forgotten request (input exclusion, output check, forget wins); a cloud summariser for a
private chat (local only); a fold that hides a crisis (pinning).

---

## 7. Household isolation

- **Members' companions** have no tools (`isMember`), so part A doesn't apply to them; their turns are
  never lean. Part B applies inside their own space: a member's `/compact` folds the member's own
  chat with the member's companion, using the household's cheap route rules (local first) and a
  per-member ledger source (`compact:<member>`), so one person can't spend another's daily cap.
- **The owner's companions**: `tool_loads` and `compactions` are per companion `store.db`; pins and
  the `lean` settings are the owner's and apply to all his companions; a fold never reads another
  conversation (not even the same chat's earlier sessions: `/new` stays the boundary).
- **Chat apps** belong to the owner's main companion as today; `/compact` and `/tools` there act on
  the owner's own sessions only (partners are refused, §5.2).

---

## 8. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `ToolRegistry.enabled`, the per-turn gates (l. 1655–1690), the run gate, permissions, `ApprovalBroker`, the sandbox gate, unattended rules, the loop guard | `runTurn` keeps `eligible`, sends `TurnTools.offeredSpecs()`; `Tool.family?` set in `main.ts` | `src/lean.ts` (L1–L5), the `find_tools` tool |
| `buildSystemPrompt` | the tools sentence: offered names + directory | — |
| `skillsSection` / `SkillStore.catalog` pattern, `SKILL_KEEP_MESSAGES` | — | — |
| `COMMAND_WORDS`, `commandAllowed`, `runCommand`, `notice()`, `MENU_COMMANDS`, the web `CHAT_COMMAND` | `compact`, `tools` names and words; `MENU_COMMANDS` + `compact` | — |
| `buildHistory` pairing and trimming, `contextFill`, the `context` event, `/status`, the ring | `buildHistory(…, fold)`; `fill` gains `tools` and `fold` | `src/compact.ts` (F1–F4) |
| `cheap.ts` `cheapRoute` / `cheapCall` / `safeLines` / `fenceLines` / the ledger, `usageScope` | — | the `compact` source |
| `nearlyFullOffer` / `OFFER_AT` | its line names `/compact`; the auto fold runs at the same point | — |
| `memory-worker.ts transcriptLine`, `receipts`, promise memories, `forgetMemory` | `forgetMemory` drops folds covering a forgotten message | `compactions`, `tool_loads`, `conversations.lean_off` |
| `safety.ts` (`minorSexualMatch`, `CRISIS_SYSTEM_NOTE`, `disclosureDue`), `app.redactor` | — | the code-written safety lines of the fold note |
| `runs.ts` steps, Phase 83 replays, `web/steps.js`, the notice renderer, `#ctx-sheet` | step fields `offered` / `loaded` / `foldId`; the step line; the divider | `web/lean.js` (sheet, *What she has*, divider), `web/lean.css` |

Nothing needs an npm package. No new timer (the auto fold runs at turn start, round start and the
web app's existing idle point), no new run kind, and exactly one new kind of model call (the fold
summary, through `cheapCall`), none for picking tools.

---

## 9. Risks

1. **She doesn't find a tool she needs** (a small model ignores the directory, or the words don't
   match). *Mitigation:* the code rules cover the common cases (mode, his words in six languages,
   @-refs, recent use); an eligible tool she names anyway still runs; the directory names families in
   plain words; the run view shows what was offered so a miss is visible; `/tools all` and pins; evals
   (`evals.ts`, coding and everyday kinds) with lean on and off before release (§10).
2. **Quality drop on strong cloud models** that handled 141 tools fine. *Mitigation:* `aboveTokens`
   is a setting; *Off* is one click; the default threshold only bites above 6,000 tokens; evals.
3. **Prompt-cache misses** when the offered list changes mid-conversation ([X5] names this).
   *Mitigation:* the list only grows inside a turn (appends), loads stay for 10 turns, the order is
   fixed; Sara doesn't use provider-side prompt caching today, but local servers reuse a matching
   prefix, which this keeps stable.
4. **The keyword lists drift** (a new MCP server with unusual names). *Mitigation:* server and plugin
   names and labels are matched automatically; the family words are only for built-ins and well-known
   servers; `find_tools` is the general answer.
5. **The fold summary is wrong or loses a detail he needed.** *Mitigation:* the originals stay; *Show
   summary* and *Undo* are one tap; the code lines carry files, promises and safety facts that a model
   could drop; his last 6 turns stay verbatim; a focus; the plain fold when no good model is allowed.
6. **A local summariser is slow** and the first message after the nearly-full point waits.
   *Mitigation:* the 20 s rule (the turn goes on, the fold applies next turn), the idle-time fold in
   the web app, the "Tidying the older part first…" status.
7. **Auto folds thrash** (one huge output refills the window). *Mitigation:* once per 10 of his
   messages, off after two failures, the existing head/tail cut ([C7] describes the same failure mode).
8. **Cost on the quick route.** *Mitigation:* local first by default, the daily cap, usage rows with
   their own purpose, the Settings line "Used today".
9. **Confusion between `/compact` and `/new`.** *Mitigation:* the ring's sheet shows both with one line
   each; the CH1 offer line names both; `/help` explains the difference in one sentence each.
10. **Safety drift through summaries.** *Mitigation:* §6.1 table, each row tested in §5.14.
11. **Old clients** (2.55 desktop/phone apps) don't draw the divider. *Mitigation:* the `compact` notice
    has plain text; `/compact undo` works from any client; the server does all the work.
12. **Windows `npx` MCP servers** (§1 fact 7) make part A look less urgent on Windows than it is
    (servers fail to start, so there are fewer tools). *Mitigation:* reported separately; the harness
    uses `node <bin>`; part A doesn't depend on the fix.
13. **The measurement ages** (MCP servers add tools; Playwright MCP 0.0.84 has 25). *Mitigation:* the
    Settings card measures live (`GET /api/lean/measure`); the release re-runs the harness.

---

## 10. The phase at a glance

The release ships its docs in the same commit: a user guide page (`docs/LEAN.md`: *Short tool list*
and *Tidy this chat*), the CHATS command table (`/compact`, `/compact undo`, `/compact show`,
`/tools`), `web/help.html`, CHANGELOG, ROADMAP / ROADMAP.public, i18n in six languages, ? tips,
THREAT_MODEL, and the README "What's new" row, with the re-measured before/after table.

| Phase | Version | Slice | Main new code | Test |
|---|---|---|---|---|
| 123 part A | 2.56.0 | families and sizes, `leanFor` (core, safety pins, his pins, asked words, @-refs, recent, skill, goal), `TurnTools`, `find_tools`, the gate on the eligible list, the prompt line and directory, `tool_loads`, run fields and the step line, `/tools`, the ring line and *What she has*, the Settings card, `GET /api/lean/measure` | `lean.ts`, `web/lean.js`, `tool_loads`, `lean_off` | `test/phase123.test.ts` (part A) |
| 123 part B | 2.56.0 | the fold boundary, the summary through `cheapCall`, the plain fold, `buildHistory(…, fold)`, the safety pins and lines, forget wins, undo, auto at 85 %, `/compact` everywhere, the divider, the Settings box | `compact.ts`, `compactions` | `test/phase123.test.ts` (part B) |

The two parts don't depend on each other; A is first because its numbers justify the release. Before
release, the existing evals (`evals.ts`, coding and everyday) run with lean on and off on one local
and one cloud model; the
release notes say how many eval cases changed outcome (target: none lost).

---

## 11. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Defer built-in tools too, or only MCP and plugin tools?** Default: **cold built-in families too**
   (a fresh install is 9.7k tokens of schemas with no MCP at all). Alternative: only MCP, plugin and A2A
   tools are deferred, every built-in always sent (Hermes' and Claude Code's default; saves less: the
   four-server case would go from 20.7k to ≈ 9.9k, a fresh install not at all).
2. **When lean switches on.** Default: **automatic above 6,000 estimated tokens of eligible schemas**,
   so a fresh install is lean. Alternatives: 12,000 (lean only with MCP/plugins), or *Always*.
3. **A per-model context window.** Default: **not in 2.56**; Sara keeps the history budget (characters)
   as "the limit", and the fold and lean thresholds are fixed sizes. Alternative: a *Context window*
   field per model (and Ollama's `num_ctx` set from it), with the history budget and the lean threshold
   derived from it (as Claude Code's 10 % rule) — a bigger change touching every provider.
4. **Folding inside a long turn.** Default: **no**; folds happen at turn starts and goal-round starts,
   and inside a turn the existing trimming applies. Alternative: also fold at a step boundary when a
   coding turn passes 95 % (only messages before this turn's owner message).
5. **Off-the-record chats.** Default: **no `/compact`** (they're short-lived and stored nowhere).
   Alternative: allowed, the fold kept in memory only and gone with the chat.
6. **Editing the summary by hand.** Default: **no** (Show and Undo only). Alternative: *Edit* on the
   summary card; an edited summary is marked "edited by {owner}" and never re-generated over.
7. **Partner chats.** Default: **no folds** (partner chats have no memory by rule; a summary is
   memory-like). Alternative: automatic plain folds only (no model), never shown to the owner.
8. **Native menus.** Default: **`/compact` joins Telegram's and Discord's menus; `/tools` doesn't**.
   Alternative: both, or neither.
9. **Other apps (`/v1`, Sara as an MCP server).** Default: **today's full list** for them in 2.56.
   Alternative: lean for those too (they often bring their own tools).
10. **Plugins loading tools.** Default: **no**; plugins see the offered names but can't load or hide
    tools. Alternative: a hook that lets a plugin mark its own tools "always offer".
11. **Who writes the fold summary by default.** Default: **`auto`: a model on this computer first, else
    the quick route** (non-private chats only), within a daily cap of 40 folds / 500k tokens.
    Alternatives: `local` only (free, plain fold when none), or `quick` first (better summaries, costs).
12. **How much is kept verbatim.** Default: **his last 6 turns (≥ 12 messages)**. Alternatives: 3 or 10.
13. **The crisis pin.** Default: **24 hours verbatim, then a code-written line, kept in every later
    fold of that chat**. Alternative: 72 hours, or never fold a chat with a crisis in the last week.
14. **The Windows `npx` MCP bug (§1 fact 7).** Default: **reported, not fixed in this phase**
    (a small separate fix: run `.cmd` shims the way `sandbox.ts windowsShell` already does for commands,
    or resolve `npx` to `node <npm-cli>`). Alternative: fold the fix into 2.56.0.

---

## 12. Key choices in short

- **Eligible stays, offered shrinks**: today's per-turn gates decide what she *may* use, unchanged; a
  new code-only step decides which schemas are *sent*. The run gate stays on the eligible list, so
  every permission, card, sandbox and loop rule is today's for every call.
- **Measured**: 67 tools ≈ 9.7k tokens per step on a fresh install, 141 ≈ 20.7k with four MCP servers;
  the lean list is 18 (everyday) or 23 (coding) schemas ≈ 2.9k, a fixed part of ≈ 5–6k tokens per step
  instead of 12–25k (−52 % to −78 %); the default coding budget lasts ≈ 32 steps instead of 8.
- **Deterministic first**: the mode's core, six safety-pinned tools, his pins, his words in six
  languages, @-references, recent use, a loaded skill's tools, a goal's earlier rounds. No model call
  to pick tools.
- **One `find_tools`** that loads ≤ 5 tools for the next step; a call is then an ordinary call. It can
  only ever find eligible tools.
- **Never hides what he asked for, never hides a safety tool**: naming it, pinning it, referencing it
  or having used it recently always offers it; `/tools all` turns lean off for a chat.
- **`/compact` folds, never deletes**: the oldest part is replaced for the model by one note with a
  summary; the messages stay in the thread, dimmed under a divider with *Show* and *Undo*; forget wins.
- **The cheap model, local first; private chats local only**, a daily cap, and a code-only plain fold
  whenever no model is allowed.
- **Automatic at the CH1 nearly-full point (85 %)**, between turns and goal rounds, never mid-step,
  at most once per 10 of his messages.
- **The safety layer can't be folded away**: crisis exchanges pinned for 24 h then restated by code,
  refused requests never summarised (and counted), the summary minors-checked, the disclosure clock in
  the store, approvals never read from history.
- **Additive only**: `tool_loads`, `compactions`, `conversations.lean_off`, the `lean` settings; zero
  npm runtime dependencies.

---

## 13. Sources

Public feature pages, read 2026-11-02 (features only; no code, prompt or wording taken):

- [H3] Hermes Agent, *Slash commands* (`/compress [here [N] | focus topic]`).
  https://hermes-agent.nousresearch.com/docs/reference/slash-commands
- [H9] Hermes Agent, *Tool Search* (opt-in; MCP and non-core plugin tools replaced by `tool_search`,
  `tool_describe`, `tool_call`; a core working set stays; curated or explicit `defer` list; each batched
  call gets its own checks and approval).
  https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search
- [H17] Hermes Agent, *Context Compression and Caching* (a pluggable context engine; the compressor
  fires at a share of the context window, default 50 %; a gateway hygiene net at 85 %; `/compress`).
  https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching
- [H24] Hermes Agent, *Configuration: compression* (`threshold`, `threshold_tokens`, protected head and
  tail, a separate summariser provider). https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- [O6] OpenClaw, *Slash commands* (lists `/compact`). https://docs.openclaw.ai/tools/slash-commands
- [O7] OpenClaw, *Tool Search* (experimental; a bounded directory that scales with the model's window;
  search/describe/dispatch controls; direct-only tools stay visible; local Ollama models keep web and
  memory tools direct; every authorised entry stays callable). https://docs.openclaw.ai/tools/tool-search
- [O17] OpenClaw, *Compaction* (older turns summarised into one transcript entry; recent messages kept;
  tool calls kept with their results at the split; bounded summariser input; the full history stays on
  disk). https://docs.openclaw.ai/concepts/compaction
- [C5] Claude Code, *Connect Claude Code to tools via MCP: scale with MCP tool search* (names load at
  start, schemas on demand; `ENABLE_TOOL_SEARCH` `true` / `auto` (10 % of the window) / `auto:N` /
  `false`). https://code.claude.com/docs/en/mcp
- [C6] Claude Code, *Agent SDK: scale to many tools with tool search* (up to five relevant tools loaded
  per search, kept until compaction; core built-ins always loaded; `alwaysLoad`).
  https://code.claude.com/docs/en/agent-sdk/tool-search
- [C7] Claude Code, *How Claude Code works: the context window* (automatic compaction near the limit;
  `/compact` with a focus; "compact instructions"; stops auto-compacting when one huge output refills
  the window). https://code.claude.com/docs/en/how-claude-code-works
- [C8] Claude Code, *Explore the context window* (what survives compaction; `/compact`; `/context`).
  https://code.claude.com/docs/en/context-window
- [X3] Codex, *Developer commands* (`/compact`, `/mcp`, `/mention`).
  https://developers.openai.com/codex/cli/slash-commands
- [X4] Codex, *Configuration reference* (`model_auto_compact_token_limit`, `model_context_window`;
  unverified: read through a mirror of the reference and a search summary).
  https://developers.openai.com/codex/config-reference
- [X5] OpenAI, *Unrolling the Codex agent loop* (manual `/compact` first, then automatic compaction
  through `/responses/compact` above the limit; changing the tools mid-conversation causes a
  prompt-cache miss). https://openai.com/index/unrolling-the-codex-agent-loop/

Measurement packages (npm, run as `node <bin>`, read-only tool listing): `@modelcontextprotocol/
server-filesystem` 2.1.0, `@modelcontextprotocol/server-memory` 2.0.1, `@modelcontextprotocol/
server-github` 2025.4.8, `@playwright/mcp` 0.0.84; tokenizer `tiktoken` `o200k_base` (scratch only,
not a Sara dependency).

Sara code read for §1: `src/tools/registry.ts` (`enabled`, `permission`, `defaultFor`),
`src/tools/types.ts` (`Tool`, `source`), `src/tools/mcp.ts` (`McpManager`, `#wrap`, `mcpToolName`,
`#makeTransport`, `MCP_PRESETS`), `src/plugins/manager.ts` (plugin tools), `src/main.ts` (where each
tool family is added), `src/chat.ts` (`OFFSERVER_TOOL`, `HISTORY_BUDGET_CHARS`, `buildHistory`,
`contextFill`, `historySize`, the per-turn gates, the system prompt call, the step loop and `offered`,
the run gate, the dropped-part note, the crisis and disclosure code), `src/persona.ts` (the tools
sentence and tool-keyed paragraphs), `src/providers/openai-compatible.ts` (how `tools` are sent),
`src/skill-tools.ts` (`skillsSection`, `SKILL_KEEP_MESSAGES`), `src/cheap.ts`, `src/titles.ts`
(`TITLE_DEFAULTS`), `src/memory-worker.ts` (the summary memory, `forgetMemory`),
`src/bridges/commands.ts` (`CommandName`, `COMMAND_WORDS`, `MENU_COMMANDS`, `nextSession`,
`nearlyFullOffer`, `afterTurnExtras`), `src/budget.ts` (`DEFAULT_TURN_BUDGETS`), `src/persist.ts`
(goal and loop defaults), `src/safety.ts`, `src/server.ts` (the disclosure gate, `fill`, the messages
route), `src/routes/admin.ts` (MCP routes), `web/index.html` (`#ctx-ring`, `#ctx-sheet`, `ab-tools`,
`#history-budget`), `web/app.js` (`CHAT_COMMAND`, `runChatCommand`, the fill calls); docs `ROADMAP.md`
(Phase 123), `design/GAP_REVIEW.md` (#13, #19, G8, G20), `design/CHATS.md` (CH1–CH3),
`design/PERSIST.md`, `design/PRECISE.md`.
