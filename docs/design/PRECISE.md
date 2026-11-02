# Coding precision: checks after her edits, and @-references in the message (design, Phase 120, version 2.53.0)

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at
2.52.1 (Phases 115–119 released: photos and files in chat apps, the live progress message, steer /
queue / `/btw`, the loop guard, Signal and email, goals and loops, "when it comes up" and `/continue`),
plus the public feature pages of Hermes Agent, OpenClaw, Claude Code, Codex and Cursor (sources in
§13). It is a ground-up design: no code, schema, prompt or wording is taken from any of them; this
file names only their **features**. Zero new npm runtime dependencies. No new run engine, no new kind
of model call, no new timer: a check is a command through the workspace sandbox (the Phase 118 check
runner), a language server is a child process the owner already installed, and an @-reference is text
the server reads with the same path rules her file tools use.

**The owner's words (2026-10-31, approving the gap review's suggestions as Phases 115–128):** "I like
the top 10 as well as the lower down ones." The ROADMAP line he approved:

- *Phase 120 (2.53.0):* "Coding precision: language-server diagnostics after edits, @-references (#7, #9)."

And the gap review's pitches he said yes to (GAP_REVIEW §2):

- **#7** "she sees type errors and missing imports the moment she writes a file, before running
  tests." *Fits:* "a small LSP client (JSON-RPC over stdio, no dependency) beside the code map
  (`src/codemap/`); servers detected per project by `projectknow.ts` (typescript-language-server,
  pyright, gopls, rust-analyzer…); results feed the step after the write and the run record (M3)."
  *Simple UI:* "nothing to set; Settings → Abilities → Coding lists the servers found, with *How to
  install* links for missing ones. A '2 type errors, fixed' line under the reply." Risk note (G6):
  "Language servers are the owner's own installs (detected, never downloaded silently); run inside the
  workspace sandbox; a missing or crashing server never breaks a write."
- **#9** "type `@` to pick a file, a line range, your uncommitted changes, recent commits or a web
  page, and it's attached to the message." *Fits:* "workspace tools (`tools/workspace.ts`, git), the
  guarded fetch, the library's page reader; the VS Code panel's selection becomes `@file:…:10-25`."
  *Simple UI:* "an `@` menu in the composer with plain names (*a file*, *my changes*, *a web page*);
  chips you can remove before sending." Risk note (G7): "Only inside the conversation's workspace;
  `@url` uses the guarded fetch (`netFetch`) and respects private local mode; content is untrusted
  text as today."

(GAP_REVIEW §4 numbered this release 119 / 2.52.0; the ROADMAP moved it to **120 / 2.53.0** when the
owner added WhatsApp/iMessage/SMS and the store. This file follows the ROADMAP.)

**The brief for this design (from the parent, on the owner's behalf):**
1. *Checks after her edits.* After she edits a file, run **the project's own** type checker or
   language-server diagnostics (tsc, pyright/mypy, rust-analyzer/cargo check, go vet, eslint) and
   **feed the errors back into the turn**.
2. *@-references in the chat box:* `@file`, `@folder`, `@url`, `@diff`, `@branch`, `@problem`, **with
   autocomplete**.
3. *Principles:* zero npm runtime deps; checks run **only commands the project already has**, detected
   from `package.json` / `tsconfig.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`; **never install
   anything without approval**; **bounded time and output**, diagnostics **limited to the files she
   touched plus a count**; **Windows and Linux** (and macOS, which the sandbox already covers); **the
   owner can turn it off per project**; @-references respect **workspace boundaries, private/household
   rules and size caps**, and `@url` goes **through the net guard**; in chat apps (Telegram, Discord)
   **`@file` works as typed text**.

**Goal:** she writes `const n: number = name` and, before she says "done", the project's own
TypeScript tells her `src/a.ts:12:7 Type 'string' is not assignable to type 'number'`, so she fixes it
in the same turn and the reply says "Checked with tsc · 1 type error, fixed". And he types "why does
@file:src/app.ts:40-60 crash with @problem?" and she gets exactly those twenty lines and the current
errors, without a single tool call to find them.

**The rule of this track: build on what is there.** A check is the Phase 118 check runner
(`persist.ts runCommandCheck`: `runCommand` in the conversation's workspace sandbox, network off, a
time limit, output scrubbed by `app.redactor`, refused by `refuseCheck` / `classifyCommand` when it
installs, deletes, changes the system or uses the network), grown by one function that returns the full
(capped) output so a parser can read it. The project's checkers are found the way `projectknow.ts
scanProject` already finds `test` / `build` / `lint`, and listed next to them in "## This project". The
place where diagnostics enter the turn is the tool loop's existing post-call point in `runTurn`
(`chat.ts`, where `app.codemap?.touch(wsDir)` already runs after every `CHANGES_FILES` call), before the
result is scrubbed and stored, so they are part of the stored tool result (replays and the run record
see the same thing). The "don't stop with errors you made" nudge is a `beforeModelCall`-style app note
inside the turn budget, like the plan check's flags. @-references are read with `resolveInside` and
the code map's `readInsideNoFollow`, refused for the names `send-file.ts SECRET_NAME` already refuses,
listed from the code map's file table (`codemap/store.ts files()`), and `@url` is the `web_fetch` path
(`assertPublic` → `checkOutbound` → `pinnedGet`), so private local mode and the private-address block
apply unchanged. The mandatory safety layer (`src/safety.ts`: AI disclosure at the start and every 3
hours, honesty when sincerely asked, crisis resources, the hard block on sexual content involving
minors) is untouched: the owner's message with its references is checked like any message, and every
nudge step is an ordinary step of an ordinary turn.

**One word clash to avoid.** "Mentions" already means two things in Sara: the group-chat `@Name` turn
style (`group.ts`, `@all`, "@mention only") and Phase 119's "when it comes up" reminders (`mentions.ts`,
the `mentions` chat event). This phase calls its feature **references** (`refs.ts`, `message_refs`,
the `refs` event) and **checks** / **problems** (`diagnostics.ts`), never "mentions" or "lint" alone.

Contents: 1 what exists today · 2 how Hermes Agent, OpenClaw, Claude Code, Codex and Cursor do it, and
where Sara differs · 3 the shape and shared building blocks · 4 part A: checks after her edits · 5 part
B: @-references · 6 safety and privacy · 7 household isolation · 8 reuse vs build · 9 risks · 10 the
phase at a glance · 11 blocking questions with defaults · 12 key choices in short · 13 sources. The
`test/phase120.test.ts` Done-when list is §5.13 (both parts), the owner to-dos §5.14.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| File tools | `src/tools/builtin.ts` (368 lines): `write_file` (`resolveInside`, `assertWritable`, `mkdir`, `writeFile`), `edit_file` (exact `old_string`, once unless `replace_all`, the 2.51 CRLF rule), `read_file` (numbered lines, offset/limit, 200 kB), `list_dir`, `search`; all `defaultPermission: 'auto'` | Write and return one line ("Edited src/a.ts (1 replacement)."). No look at whether the code still compiles. | The diagnostics block is appended to **this** line, in the tool loop, not inside the tools (they stay small and are also used by replays and helpers). |
| The tool loop | `src/chat.ts` `runTurn` (`for (const call of calls)` l. 2426; after `tool.run`, l. 2715: `if (status !== 'denied' && CHANGES_FILES(call.name) && !opts.replay) app.codemap?.touch(wsDir)`; then `app.redactor.redact(output)`, `clip(output, TOOL_RESULT_LIMIT)`, `store.addMessage(…'tool'…)`, `hooks.afterTool`) | The one place every tool result passes before it is stored. | The check runs **here**, once per step, after the step's last file-changing call (§4.4). The calls of a step are known before the loop starts, so "the last one" needs no guess. |
| Turn hooks | `TurnHooks` (`beforeModelCall` with `userNote`, `beforeTool`, `afterTool`, `afterReply` with `final`), `joinHooks` | The plan check, the recorder, budgets, the sandbox gate, goals ride these. | The "you left 2 errors" nudge is an `afterReply(final)` decision plus a `beforeModelCall` note (§4.7); no new seam. |
| Phase 118 check runner | `src/persist.ts`: `runCommandCheck(app, dir, kind, command, signal, timeoutMs)` (`runCommand` with `{...app.sandbox, network:false}`, `maxBytes 400_000`, redactor, `testCounts`, M10 key, a 4,000-char tail, `broken` on not-found/timeout), `refuseCheck` (`classifyCommand` on the command **and** the `package.json` script it runs), `scriptLine`, `checkOptions` (tests / build / lint from `scanProject`) | "A command the app runs and reads, never her word." | Reused as is for safety; one sibling `runProjectCommand` returns the capped full output for the parsers (§3.1 P2). `checkOptions` gains `types` so a goal can be "done when it type-checks" (§4.11). |
| Command risk | `src/sandbox-run.ts` `classifyCommand(command) → {reasons: writes \| installs \| deletes \| network \| scripts \| system}` | Used by the sandbox gate and goal checks. | Every checker command is classified before it runs; `installs` / `network` / `deletes` / `system` are refused (the same table as goal checks). |
| Sandbox | `src/tools/sandbox.ts` `runCommand` (bwrap on Linux, Seatbelt on macOS, `none` on Windows with `windowsShell()` and a per-run TEMP; `PRIVATE_LOCAL_ENV` proxies in private local mode; SAFE_ENV never passes Sara's own environment); `ToolRegistry.unsandboxed` makes command tools ask on Windows (Phase 46) | Where every command runs. | On Windows there is no isolation, which is why the per-project OK (§4.3) is a real approval, not a formality. |
| Project knowledge | `src/projectknow.ts` (310 lines): `findRepos` (the workspace or repos two levels down; a code folder with `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `Makefile`), `scanProject` → `ProjectFacts {commands: {test, build, lint, run}, languages, conventions (tsconfig strict…)}`, `ProjectKnowledgeStore` (`project_knowledge`, refreshed hourly), `projectSection` ("## This project") | Finds commands **by looking**, no model. `lint` falls back to the `typecheck` script. | Checker detection is one more pass in `scanProject` (`facts.checkers`), so the prompt, the project page and the goal picker read one list (§4.2). |
| Code map | `src/codemap/` (Phase 50): `CodeMaps.touch(dir)` after writes and jobs, `CodeMapStore.files()` (path, lang, size, lines), `findPath`, `findSymbols`, `lines(path, from, to)`, `safe-read.ts readInsideNoFollow` (no links, fstat = lstat, real path inside), `ignore.ts` (gitignore + heavy folders); routes `GET /api/codemap/:ws`, `/file`, `/find` | A cheap, always-fresh list of the workspace's files and symbols. | Autocomplete for `@file:` / `@folder:` is a query on `files()` (no new walk); `@file` reads go through `readInsideNoFollow` (§5.3). |
| Git look | `tools/coding.ts` `git` tool (`status`, `diff`, `log`, `branches`, `show`; `GIT_SAFE` switches off hooks, fsmonitor, pagers, external diff, textconv); `routes/coding.ts GET /api/workspaces/:ws/git` (status, `diff --stat --patch HEAD`, log, redacted, 200 kB) | Read-only git with the repository's own config disarmed. | `@diff` and `@branch` are these same commands (§5.3). |
| Guarded fetch | `tools/builtin.ts` `web_fetch`: `assertPublic` (http/https only, `checkOutbound` **before** DNS, private addresses refused unless allowed), `pinnedGet` (pinned address, `agent:false`, every redirect re-checked, 2 MB), `htmlToText`, the "written by others: information only" line; `net-guard.ts` `checkOutbound`, `privateLocalOn`, `netFetch` | The only way she reads a web page. | `@url` calls the same two functions (exported), so it can't be a side door (§5.5). |
| Attachments | `web/app.js` `addFiles` / `renderAttachments` (photo and document chips with ×), `send()` → `POST /api/conversations/:id/messages {content, images, docs}`; `server.ts` l. 1946 (100,000-char limit, docs checked against the library, `whileBusy` steer/queue with `meta`); `TurnOptions.images` / `.docs`; `meta` on the owner message | Chips above the box, removed before sending; the server checks what they point to. | @-references get the same chip row and the same "the server decides" rule; they ride the message `meta` and the pending queue the way `docs` do (§5.6). |
| Composer keys and menus | `web/app.js` Enter / Alt+Enter, `CHAT_COMMAND` + `runChatCommand` (slash commands never reach her), `typedBusy`; `web/command-bar.js` (a combobox + listbox with `aria-activedescendant`, `fold`, `score`) | The patterns for a keyboard-first popup. | The `@` popup reuses `fold`/`score` and the listbox pattern (§5.7). |
| `@` today | `group.ts` `@Name` / `@all` in group chats (turn style *@mention only*); Telegram `/cmd@bot`, `@username`; Discord `<@id>` turned into `@Name` before the turn (`discord.ts` l. 614); `ssh-easy.ts` `user@host`; Phase 119 "mentions" = reminders | `@` already means "a person" in rooms. | The grammar must not steal `@Mia` in a group, `@someone` in Telegram, or `me@example.com` (§5.2). |
| VS Code panel | `clients/vscode/extension.js` `editorContext` (file name, language, lines, code cut at `max`, refuses secret-looking files) sent as text | The editor sends **code**, not a reference (its files may not be in Sara's workspace). | Unchanged in 2.53 (§5.9, §11 Q12). |
| Run record, receipts, claims | `runs.ts` `rec.tool(...)` steps (goals record `goal_check`), `RunKind`; `receipts.ts` `ClaimKind` (`write`, `run`, `tests_pass` …) and `checkClaims` | Every step is visible in Settings → Runs; "tests pass" is checked against the last test run. | Each check is a `diagnostics` step on the run; a new claim kind `types_clean` checks "it compiles now" against the last check (§4.11). |
| Budgets | `budget.ts` `TurnMeter`, the ladder, `DEFAULT_TURN_BUDGETS` (coding 200k tokens / 40 steps), `HISTORY_BUDGET_CHARS`, the CH1 context ring (`context` event) | The turn's ceiling. | Checks cost no tokens; the fix steps they cause are normal steps inside the budget; reference text counts in the context ring (§4.8, §5.6). |
| Privacy gates | `conv.private` (local models only, no web or MCP tools), off the record, `privateLocalOn()`, `isMember` (no tools), partner chats (`conv.partner`), work rooms vs talk rooms (`isWorkChannel`), `persistRefusal` (Phase 118's "who and where") | Who may make her touch files or the web. | References follow the same lines: workspace references only for the owner in his own chats and work rooms; `@url` never in private conversations (§5.4). |

What does **not** exist: any look at whether her edit still type-checks (only tests, through a goal
or when she runs them herself), any long-lived helper process per project, any way to point at a file,
a range, a diff or a page from the message itself (he pastes, or she spends tool calls finding it), and
any autocomplete in the composer.

Five code facts change the design:
1. **There is no `apply_patch` built-in.** `CHANGES_FILES` names it (and `shell`, `git_*`,
   `delegate_task`) for plugins and MCP. Checks follow `write_file` and `edit_file` (paths known) and,
   by fingerprint, a `shell` call that changed source files (§4.4); `delegate_task` runs as a job and
   its own agent checks its work.
2. **The tool result is stored after the scrub, in the same spot the code map is told.** Appending the
   diagnostics there puts them in history, in the run record and in replays with no new message kind.
3. **`runCommandCheck` keeps only a 4,000-character tail.** Diagnostics need the whole (capped) output
   to find every error in the touched files; one sibling function returns it (P2).
4. **On Windows, `node_modules/.bin/tsc` is a `.cmd` shim** run through `cmd.exe` or Git Bash.
   Checkers are started as `node <the package's own bin file>` (and `python -m mypy` with the project's
   venv), so one command line works on Windows, Linux and macOS (§4.10).
5. **Several checkers run project code.** An `eslint.config.js` is JavaScript, mypy plugins are
   Python, `cargo check` runs `build.rs` and proc macros, a language server may load plugins named in
   `tsconfig.json`. "Only commands the project already has" is not the same as "safe to run without
   asking", which is why each project needs the owner's OK once (§4.3, §11 Q1).

---

## 2. How Hermes Agent, OpenClaw, Claude Code, Codex and Cursor do it, and where Sara differs

Only features, from their public docs (read 2026-11-02; [H7], [H8], [C1]–[C4], [X1]–[X2], [U1]–[U3],
[O6] in §13). No code, prompt or wording is taken.

- **Hermes Agent, LSP [H7].** Runs language servers (pyright, gopls, rust-analyzer,
  typescript-language-server, clangd and about twenty more) as background processes and feeds their
  diagnostics into the post-write check of its write and patch tools. Only inside a git repository; a
  fast syntax check first; waits for the server only briefly (about 80 ms), attaches a late verdict to
  the next tool result, and before the agent finishes waits up to 5 s and sends any problems as a new
  message; reports **only the diagnostics the edit introduced** (compared with the verdict on the
  pre-edit content); a missing or flaky server never breaks a write.
- **Hermes Agent, context references [H8].** `@file:path[:a-b]`, `@folder:`, `@diff` (unstaged),
  `@staged`, `@git:N` (≤ 10 commits), `@url:`; content appended under an attached-context section;
  CLI tab completion (`@` lists the kinds, `@file:` completes paths with sizes); a soft limit (25 % of
  the context, a warning) and a hard one (50 %, refused); 200 folder entries; sensitive paths
  (`~/.ssh`, shell profiles, `.netrc`, its own `.env`) always blocked; paths can't leave the working
  directory.
- **Claude Code [C1]–[C4].** `@` includes files and folders in the prompt ("without waiting for Claude
  to read them") [C1]; the VS Code extension sees the selection [C2]; *code intelligence plugins*
  connect a language server per language: after each edit Claude gets the errors and warnings, a
  "Found N new diagnostic issues in M files" line shows under the edit, the binary is the user's own
  install and a missing one is reported, not downloaded [C3]; and hooks (`PostToolUse` on `Edit|Write`)
  let a user run their own type checker after edits [C4].
- **Codex [X1]–[X2].** In the CLI and IDE extension, typing `@` searches for files to attach; the IDE
  extension brings open files and selections in.
- **Cursor [U1]–[U3].** `@` in the chat input with suggestions: files and folders, terminals, earlier
  chats, `@Commit (Diff of Working State)` and `@Branch (Diff with Main)`, the browser [U1]; the agent
  reads linter diagnostics from the editor's extensions (ESLint, Biome…) and fixes them [U2], a beta
  "iterate on lints" loop [U3].
- **OpenClaw.** Its docs index lists no language-server or `@`-reference feature (checked
  2026-11-02; unverified beyond the index and the command list [O6]).

**Where Sara differs, on purpose:**

| Question | Others (docs) | Sara (this design) | Why |
|---|---|---|---|
| What runs the check? | Language servers they start [H7][C3]; the editor's extensions [U2]; a user's hook [C4] | **The project's own checker command** (tsc, pyright, mypy, cargo check, go vet, eslint) by default, and **a language server the owner already installed** where one is found and he allows it (§4.9) | The brief: only what the project already has. A command works without any server; a server makes repeat checks fast |
| Who allows it? | Installing the plugin or the server [C3]; on by default in a git repo [H7] | **One OK per project** (a card showing the exact commands), remembered; *Off* per project any time | Checkers can run project code, and Windows has no sandbox (§1 fact 5) |
| What she sees | New diagnostics only [H7][C3] | **New errors in the files she touched** (fully), **plus a count** of the rest, capped | The brief; she shouldn't chase errors that were there before |
| Before she says "done" | Waits up to 5 s, sends problems as a message [H7] | **The final reply is held for at most one check**, then **at most 2 fix nudges** inside the turn budget; whatever is left is said in the reply and on a chip | Bounded, and the owner sees the truth either way |
| Which `@` kinds | file, folder, diff, staged, git:N, url [H8]; files, folders, terminals, chats, commit, branch, browser [U1] | **file (with lines), folder, url, diff (with `staged`), branch, problem** | The ROADMAP's list; `@problem` ties part B to part A |
| Where they work | A CLI and editors | **The web app with autocomplete, and typed text in Telegram, Discord, Signal, email and plugin bridges**, one server-side parser | The brief: `@file` works as typed text in chat apps |
| Whose files | The working directory [H8] | **The conversation's workspace only**, the owner only, never partner chats or talk rooms; `@url` never in private conversations; secrets refused by name | Sara has partners, rooms and a household |

---

## 3. The shape

```
 she calls edit_file / write_file (or a shell call that changed source files)
   │
   ├─► the tool runs as today ─► "Edited src/a.ts (1 replacement)."
   │
   └─► last file-changing call of this step?  project allowed?  (P1 detect · §4.3 the OK)
          │ no ─► nothing (a write never waits on a check it can't run)
          ▼ yes
        P3 check for the touched files (one at a time per project; Stop aborts it)
          ├ a language server is running for it ─► open/change the files, wait ≤ 3 s for its verdict
          └ else the project's checker command ─► P2 run (sandbox, no network, ≤ 60 s, ≤ 400 kB)
          ▼
        P4 parse ─► Diagnostic[] ─► P5 compare with the baseline ─► the block:
          "Checked with tsc (3.1 s): 1 new error in the files you changed
           src/a.ts:12:7 error TS2322 Type 'string' is not assignable to type 'number'.
           (Also 14 errors in 6 other files, there before your edit.)"
          ▼
        appended to that tool result (scrubbed, stored, on the run as a `diagnostics` step)

 her final reply while her own new errors remain ─► P6 nudge (≤ 2 per turn, inside the budget)
   └ still left, or the budget is out ─► the reply's chip: "2 type errors left in src/a.ts"

 he types: "why does @file:src/app.ts:40-60 crash with @problem?"   (web: the @ menu · apps: typed)
   │
   └─► R1 parse (server, one grammar for every surface) ─► R2 resolve each (workspace, owner, caps)
          ─► R3 expand once when the message is saved ─► message_refs rows + meta.refs chips
          ─► buildHistory adds the fenced <attached> block under his message for the model
```

### 3.1 Shared building blocks (built once, used by both parts)

1. **P1 · Detection** (`src/diagnostics.ts`, new; called from `projectknow.ts scanProject`).
   `detectCheckers(dir) → Checker[]`, each `{id, lang, label, argv, files: 'touched' | 'project',
   format, runsProjectCode, config}`, found only from files that are there (§4.2). `ProjectFacts` gains
   `checkers` (the list, without paths outside the project), so "## This project", the project page and
   the goal picker read the same list. No network, no `npx`, no install; a checker whose binary isn't
   in the project (or, for `cargo` / `go` / `python`, on the PATH) is listed as *not installed* with a
   *How to install* link and never run.
2. **P2 · `runProjectCommand`** (`src/persist.ts`, beside `runCommandCheck`, which is rewritten on top
   of it with no change in behaviour). `runProjectCommand(app, dir, argv | command, {signal, timeoutMs,
   maxBytes, env}) → {exitCode, timedOut, out, ms, refused?}`: the same `refuseCheck` /
   `classifyCommand` gate, `runCommand` with `{...app.sandbox, network: false}`, `PRIVATE_LOCAL_ENV` as
   today, the redactor, and the **full** capped output (400 kB) instead of a tail. Extra environment for
   checkers only: `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`, `GOFLAGS=-mod=mod`… see §4.10 for the
   "never fetch" settings per tool.
3. **P3 · The check driver** (`src/diagnostics.ts`). `Checks.forStep(app, conv, touched, signal) →
   CheckOutcome | undefined`: picks the project(s) the touched files belong to (`findRepos`), the
   allowed checkers, the engine (a running server first, else the command), runs at most **one check
   per project at a time** (a second request joins the running one, or queues one follow-up with the
   union of files), and gives up quietly on any failure (`broken` → one short line, never an error on
   the write). `Checks.latest(workspace, project)` serves `@problem`, the project page and `/problems`.
4. **P4 · Parsers** (`src/diagnostics.ts`, pure functions, one per `format`): `tsc` (`file(l,c): error
   TSnnnn: msg` with `--pretty false`), `pyright` (`--outputjson`), `mypy`
   (`file:l:c: error: msg  [code]` with `--show-column-numbers --no-error-summary --no-pretty`), `cargo`
   (`--message-format=short`: `file:l:c: error[E0308]: msg`), `go vet` (`file:l:c: msg`), `eslint`
   (`--format unix`: `file:l:c: msg [Error/rule]`) and `lsp` (`publishDiagnostics` / pull results). Each
   returns `Diagnostic {file, line, col, severity: 'error' | 'warning', code?, message, source}` with
   the path made workspace-relative (or dropped when it isn't inside the workspace).
5. **P5 · Baselines** (`diag_cache`, §4.12). Per project and file: the diagnostics last seen with that
   file's content hash. "New" = a diagnostic whose key `file|code|normalised message` (no line number,
   so a line shift isn't "new") isn't in the file's baseline taken before her **first** change to it
   in this turn (§4.5).
6. **P6 · The nudge** (`src/diagnostics.ts`, wired as a turn hook in `runTurn`). After her final reply,
   if her own new errors remain and the turn's budget allows a step, one app note is added and the
   loop runs on; at most `nudges` (2) times per turn.
7. **R1–R3 · References** (`src/refs.ts`, new; part B). `parseRefs(text) → RefToken[]`,
   `resolveRef(app, conv, sender, token) → Resolved | Refused`, `expandRefs(...)` (once, when the owner
   message is saved), `refsBlock(rows)` for `buildHistory`. `web/refs.js` is the composer popup and the
   chips.

### 3.2 Where data lives

- **Per companion `store.db`** (the conversation's own database, like goals): `message_refs` (what each
  reference expanded to, §5.11). References belong to a message, so they live where the message lives.
- **The main data folder's shared code cache** (`<data>/cache/codemap/…`, next to the code maps,
  shared by every companion like the workspaces): `diag_cache` and `diag_runs` (§4.12). A check result is
  a fact about files in a workspace, not about a conversation; two companions working in the same
  workspace see the same problems.
- **`project_checks`** (the owner's choice per project: *Ask* / *On* / *Off*, which checkers, the
  server choice) lives in the main companion's `sara.db` beside `project_knowledge`, because the OK is
  the owner's and holds for every companion working there (§7).
- **Settings** (`precise`, owner-only, added to `OWNER_SETTINGS`): the global switches and limits
  (§3.3). Sara writes nothing into the project folder; a checker may write its own usual cache there
  (`.mypy_cache`, `target/`), as when he runs it himself. `tsc --incremental` is not used in 2.53, so tsc
  writes nothing.

### 3.3 Settings shape (owner-only; `precise` added to `OWNER_SETTINGS`)

```ts
interface PreciseSettings {
  checks: {
    on: boolean;                  // true: Check her edits (each project still needs its OK)
    engine: 'auto' | 'command';   // auto: a language server when one runs and is allowed, else the command
    servers: { typescript: boolean; python: boolean; go: boolean; rust: boolean }; // true, true, false, false
    waitS: 5 | 10 | 20 | 30;      // how long her next step waits for a command check (20)
    timeoutS: 30 | 60 | 120 | 300;// a check is stopped after this (60)
    serverWaitMs: 1000 | 3000 | 5000; // how long one server verdict is waited for (3000)
    shown: 10 | 20 | 50;          // diagnostics written out for touched files (20)
    warnings: boolean;            // false: errors only (eslint warnings, pyright warnings left out)
    nudges: 0 | 1 | 2 | 3;        // fix nudges per turn when her own errors remain (2)
    idleMin: 5 | 10 | 30;         // a language server with nothing to do is stopped after this (10)
  };
  refs: {
    on: boolean;                  // true
    perRefChars: 20_000 | 40_000 | 80_000;  // one reference's text (40,000)
    softPct: 25;                  // of the history budget: a warning on the chip
    hardPct: 50;                  // refused above this
    folderEntries: 200;
    urls: boolean;                // true (still off in private conversations and private local mode)
    olderAs: 'stub' | 'full';     // stub: in older messages a reference becomes one line (§5.6)
  };
}
```

Defaults are in `DEFAULT_PRECISE`; `mergePrecise` keeps unknown keys out and every number on its list,
the way `mergePersist` does.

---

## 4. Part A · checks after her edits

### 4.1 Scope

In: the project's own type checker or linter after `write_file` / `edit_file` (and a `shell` call that
changed source files), in coding conversations and any conversation with a workspace and tools; the
result in the same tool result she reads next; a nudge before she ends with her own errors; the run
record, the step line, a reply chip, the project page, `@problem`, `/problems` in chat apps, and `types`
as a goal check. TypeScript/JavaScript, Python, Rust, Go and ESLint-linted code.

Out (2.53): jobs and `delegate_task` (their agents check their own work; a goal can check after a
job); formatting (prettier, black: not a check, they change files); code actions and quick fixes from
servers; a go-to-definition tool for her (the code map has `code_find` / `code_refs`; §11 Q14);
checks of files she only read; clangd, Java, C#, Kotlin, Swift (later, the same table).

### 4.2 Which checkers, and how they're found (code only)

Only from files that are there, in the project folder `findRepos` returns. The binary must be **the
project's own** (in its `node_modules`, its `.venv` / `venv`) or, for toolchains that live outside
projects (`cargo`, `go`, `python`), on the PATH the sandbox gives commands (`commandPath()`).

| Checker | Found when | Runs (argv; no shell) | Files | Runs project code? |
|---|---|---|---|---|
| **tsc** | `tsconfig.json` (or `jsconfig.json` with `checkJs`) **and** `node_modules/typescript/bin/tsc` | `node node_modules/typescript/bin/tsc --noEmit --pretty false -p <tsconfig>` | project (filtered to touched + count) | no (the CLI loads no plugins) |
| **pyright** | `pyrightconfig.json` or `[tool.pyright]` in `pyproject.toml`, **and** `node_modules/pyright/index.js` or `pyright` in the project venv | `node node_modules/pyright/index.js --outputjson <files>` (or the venv's `pyright`) | touched | no |
| **mypy** | `mypy.ini`, `.mypy.ini`, `[mypy]` in `setup.cfg` or `[tool.mypy]` in `pyproject.toml`, **and** mypy in the project venv | `<venv python> -m mypy --show-column-numbers --no-error-summary --no-pretty --no-color-output <files>` | touched (with the config's own settings) | **yes** (plugins in the config) |
| **cargo check** | `Cargo.toml` and `cargo` on the PATH | `cargo check --offline --message-format=short --quiet` | project | **yes** (`build.rs`, proc macros) |
| **go vet** | `go.mod` and `go` on the PATH | `go vet <packages of the touched files>` with `GOFLAGS=-mod=mod`, `GOPROXY=off`, `GOTOOLCHAIN=local` | touched packages | no (vet compiles, it doesn't run) |
| **eslint** | an ESLint config (`eslint.config.*`, `.eslintrc*`, `eslintConfig` in `package.json`) **and** `node_modules/eslint/bin/eslint.js` | `node node_modules/eslint/bin/eslint.js --format unix --no-warn-ignored <files>` | touched | **yes** (the config is code) |

Rules:
- **Pyright beats mypy** when both are set up (one Python checker per project, the owner can switch on
  the project page). tsc and eslint can both run (types and lint are different checks); ESLint runs
  only on the files she touched, so it is quick.
- **Never `npx`, `pnpm dlx`, `uvx`, `pip`, `cargo install`, `go install`.** If the binary isn't there
  the project page says *Not installed in this project: `npm i -D typescript`* as text with a copy
  button, never a button that installs (§11 Q3).
- **The project's own scripts are shown, not used**: when `package.json` has `"typecheck": "tsc
  --noEmit"`, the page shows it as "your project's `typecheck` script runs the same check"; Sara runs
  the argv above because it has a known output format, can be limited to files, and needs no shell on
  Windows. A script that does more (`tsc && node scripts/x.js`) is ignored for checks (§11 Q4).
- **Monorepos**: the nearest `tsconfig.json` above the touched file inside the project (so
  `packages/web/src/a.ts` uses `packages/web/tsconfig.json`), one run per tsconfig touched; at most 3
  checker runs per step (the rest wait for the next step).
- `languages` from `scanProject` decide nothing; files decide. A file whose extension no checker handles
  (`.md`, `.json`, `.css`) never starts a check.

### 4.3 The OK per project, and turning it off

The first time she changes a file in a project with at least one checker found, and the project has no
choice yet (*Ask*), **no check runs**; instead the step line gets a small card:

```
🔎 This project can check her edits with its own tools:
   tsc --noEmit (TypeScript)           · runs nothing from the project
   eslint (only the files she changes) · runs your ESLint config (code)
   They run in the workspace sandbox, without network, for at most 60 s.
   [Check her edits here]   [Not now]   [Never in this project]
```

- *Check her edits here* sets `project_checks.state = 'on'` with the listed checkers; the **next** step
  runs it (this one doesn't wait). *Not now* asks again in a new turn (at most once a day); *Never*
  sets `off`. On Windows (no sandbox) the card says "runs **directly on this computer** (no sandbox
  here)" instead of "in the workspace sandbox".
- The card is a **chip under the step**, not an approval that stops her; she isn't told about it, and
  bridges show it as one line with two buttons (Telegram inline keyboard, Discord components) like
  other owner choices.
- Off per project at any time: the project page's **Checks after her edits** row (*On* / *Off* / a
  tick per checker), `/problems off` in a chat app (§4.13), or Settings → Abilities → Coding projects
  (the global switch). A project that drops a checker (no `tsconfig.json` any more) keeps its choice
  for the rest.
- Who: only the owner can answer the card or change the row (members never see a workspace, §7).
- **A checker that runs project code** (mypy plugins, cargo, eslint) is listed with that phrase on the
  card; it is never switched on by an OK given for a checker that doesn't (a new `eslint.config.js`
  appearing later shows the card again for eslint only).

### 4.4 When a check runs

- **After the step's last file-changing call.** The calls of a step are known before the loop, so the
  driver collects the paths of every successful `write_file` / `edit_file` in the step and runs once,
  after the last of them, before that result is scrubbed and stored. Several edits in one step = one
  check. A denied or failed write adds nothing.
- **A `shell` call** counts only when it changed source files: the step's workspace fingerprint
  (`persist.ts fingerprint`, size + mtime of tracked source files, capped at 5,000 files) before and
  after the call shows changed paths with a checked extension (codegen, `sed -i`, `git checkout`).
  `git_*` tools count the same way. Fingerprints are only taken when the project's checks are *On*.
- **Not in**: replays (`opts.replay`: the recorded result is used, which already has the block), the
  `/v1`, MCP, A2A and Home Assistant paths (`noTools` / `externalApp`), off-the-record chats with no
  workspace, member spaces, a turn in private local mode is fine (checks never use the network).
- **One at a time per project.** A check requested while one runs joins it if it covers the same
  files, otherwise one follow-up with the union is queued; never more than one waiting.
- **How long her next step waits**: a language-server verdict ≤ `serverWaitMs` (3 s); a command check ≤
  `waitS` (20 s). Past that, the result line says "Still checking (tsc, 20 s so far): the result comes
  with your next step." The check keeps going (up to `timeoutS`) and its block is appended to the
  **next** tool result of the turn ("Check of your earlier edit to src/a.ts: …"), or, if she is about to
  reply, the reply waits for it once (P6, at most `waitS` more).
- **Stop wins**: the turn's signal is the check's signal; Stop kills the checker's process group (the
  sandbox's existing kill) and stores nothing for it.

### 4.5 What counts as hers: baselines and "new"

- **Before her first change to a file in a turn**, the driver needs that file's diagnostics as they
  were. Three sources, in order: (1) `diag_cache` holds a result for the file **with the same content
  hash** (from an earlier check, any turn or companion) → that is the baseline; (2) a language server
  is running → the old content is opened first and its verdict kept (the write waits ≤ `serverWaitMs`);
  (3) neither → **no baseline**: the first check's errors in that file are written out as "in the
  files you changed" without "new", and the line says "(no earlier check of this file to compare with)".
  The project page's *Run now* and the first OK both run a full check, so (3) is rare after day one.
- **"New"** = the key `file|code|normalised message` (numbers, quoted names and paths kept; the line
  number left out so a shift above doesn't make everything "new") is not in the file's baseline. Errors
  in touched files that were there before are counted, not written out: "(3 errors in src/a.ts were
  there before your edit)".
- **Other files**: an error in a file she didn't touch is **never written out**, only counted: "Also
  14 errors in 6 other files." When that count **rose** compared with the project's last check (she
  renamed an export and broke an importer), the count line says so and names up to 3 of those files
  with their first error, because that breakage is hers: "Your change broke 2 other files: src/b.ts:4:10
  Module '"./a"' has no exported member 'total'." (§11 Q6).
- The baseline is kept for the turn; at the end of the turn `diag_cache` holds the newest result per
  file and content hash (capped at 2,000 files per project, oldest out).

### 4.6 The block she reads

Appended to the tool result after a blank line, ≤ 3,000 characters, in the owner's app language for
the frame and the checker's own words for the messages:

```
[Checked with tsc --noEmit in 3.1 s]
1 new error in the files you changed:
src/a.ts:12:7 error TS2322: Type 'string' is not assignable to type 'number'.
(Also 14 errors in 6 other files, there before your edit.)
```

- Clean: `[Checked with tsc --noEmit in 2.8 s: no errors in the files you changed.]` (one line, so a
  clean check costs ~20 tokens).
- Several checkers: one header line each, tsc first.
- More than `shown` (20): the first 20 by file then line, then "… and 31 more in src/a.ts". Messages
  are cut at 300 characters; code frames and related-information lines are left out.
- Warnings only when `warnings` is on (default off: ESLint warnings and pyright `warning`s are counted
  in one line, "and 4 warnings").
- Broken: `[Couldn't check: tsc exited without a result (exit code 1, no file:line lines). Check by
  running it yourself if it matters.]`, once per turn per checker, then silent for that turn.
- Timeout: `[The check took longer than 60 s and was stopped.]` once per turn; the project page shows
  it so the owner can switch that checker off.
- Everything in the block passes `app.redactor` (it is part of the tool output) and the whole tool
  result is still clipped at `TOOL_RESULT_LIMIT`.

### 4.7 Before she says "done": the nudge

- When her step is `final` (no tool calls) and the turn's own new errors remain (from the latest
  finished check, or one still running, waited for once ≤ `waitS`), and `nudges` aren't used up, and
  the turn budget allows another step (`budgetCheck` on the meter, the same projection as the ladder),
  then her reply (already streamed) becomes an **in-between step message**, like a reply before a tool
  call, and the loop runs one more step whose model call gets one app note:

  > Note from the app, not from {owner}: your edits left 2 type errors (tsc): src/a.ts:12:7 TS2322 …
  > Fix them if they're yours, or say plainly in your answer that they're left and why.

- She may fix them (more tool calls, checks again) or answer that they're intended (a work-in-progress
  file); either way the turn ends normally. The new final reply is the one the claim check, the chip
  and the chat apps use (the step line shows "checked · fixed 2" and the run keeps both steps). Chat
  apps send only the final reply, as today (the progress message shows the extra step).
- **No nudge** when: the errors were there before her edits; he told her to leave them (a short word
  list in `diagnostics.ts`, six languages: "leave the errors", "don't fix the types", "WIP", §11 Q7);
  the budget's ladder is on its last rung; the turn is a goal round (the goal's own check decides,
  Phase 118) or a loop tick; she has no tools this turn.
- Whatever is left after the nudges goes on the **reply chip**: "⚠ 2 type errors left (tsc)" with the
  list one click away, and her claim "it compiles" / "no type errors" is checked against it (§4.11).

### 4.8 Bounded: time, output, processes, money

- Time: `timeoutS` per check (60 s), `waitS` per step (20 s), `serverWaitMs` per server verdict (3 s), at
  most 3 checker runs per step, one running check per project, a step's own wait never counted twice.
- Output: the process output capped at 400 kB (`maxBytes`), parsed, then ≤ `shown` diagnostics and
  3,000 characters into the turn; the run record keeps ≤ 200 diagnostics per check (the rest counted).
- Processes: language servers ≤ 1 per (workspace, project, language), ≤ 4 in all, stopped after
  `idleMin` (10 min) idle, after a crash (restarted at most twice an hour, then off for that project
  until the next app start with a project-page note), and on app shutdown (`main.ts` housekeeping, with
  the code map's `stop()`).
- Money: **no model call at all** in a check. The nudge is one more normal step inside the turn budget
  (it counts on the meter and in Settings → Usage as the turn's own purpose); checks never press
  *Continue with more*.

### 4.9 Language servers (optional engine)

- **A small LSP client** (`src/lsp.ts`, new, ~400 lines): JSON-RPC 2.0 over stdio with
  `Content-Length` framing, written from scratch on `node:child_process`; `initialize` (root = the
  project folder, no workspace-folder list beyond it, `processId`, client capabilities for
  `publishDiagnostics` and `textDocument/diagnostic`), `didOpen` / `didChange` (full text) /
  `didClose`, pull diagnostics where the server supports it, otherwise the next `publishDiagnostics`
  for that file version; `shutdown` / `exit` with a 2 s kill.
- **Servers, only the owner's own installs**: `typescript-language-server` (project `node_modules/.bin`
  or the PATH; it uses the project's own `node_modules/typescript`), `pyright-langserver` (the project's
  pyright), `gopls` and `rust-analyzer` (PATH). Found by `detectCheckers`, listed in Settings →
  Abilities → Coding projects with *How to install* links (docs only), used only in projects that are
  *On* and only for the languages switched on in `servers` (TypeScript and Python on, Go and Rust off by
  default: `rust-analyzer` runs `cargo check` itself and can take gigabytes, §11 Q5).
- **Started by the first check that wants it**, in the workspace with the same sandbox as commands (bwrap
  / Seatbelt with network off; on Windows directly, as the card said), `SAFE_ENV` plus the checker
  environment, stdout capped per message (4 MB) and per minute, stderr dropped.
- **A server never breaks a write.** Any failure (not found, crash, bad JSON, no answer in time) falls
  back to the command check for that step, and after two crashes the project uses commands only until
  restart. `engine: 'command'` switches servers off everywhere.
- **What's different with a server**: the baseline comes for free (the old content is opened first),
  the verdict for one file is usually under a second after warm-up, and diagnostics in other files are
  only what the server already published (the count line says "in files the server has looked at").

### 4.10 Windows, Linux and macOS

- **No shell for checkers**: every row of §4.2 is an argv started with the sandbox's own spawn path
  (`runCommand` gets the argv quoted with `shq` for sh, and on Windows `windowsShell()`'s quoting); the
  first word is always `node` (Sara's own runtime, `process.execPath`, the way `commandPath()` already
  puts it on the PATH), the project venv's python (`.venv\Scripts\python.exe` on Windows,
  `.venv/bin/python` elsewhere), `cargo` or `go`. No `.cmd` shims, no `node_modules/.bin`.
- **Paths**: parsers accept `\` and `/`, drive letters, and tsc's `file(l,c)` form; everything is turned
  into workspace-relative forward-slash paths; a path that resolves outside the workspace is dropped.
- **Never fetch**: `cargo check --offline`; Go with `GOPROXY=off`, `GOFLAGS=-mod=mod`,
  `GOTOOLCHAIN=local`; npm tools get `npm_config_offline=true`; Python gets `PIP_NO_INDEX=1`; plus the
  sandbox's network off (bwrap / Seatbelt) and `PRIVATE_LOCAL_ENV` proxies (Windows: best effort, as
  `docs/PRIVATE_LOCAL.md` already says). A checker that tries to download fails and shows as *broken*,
  never as a silent install.
- **Line endings**: diagnostics from CRLF files report the same columns (the 2.51 CRLF rule in
  `edit_file` already keeps the file's own endings).
- **bwrap**: the workspace is `/workspace`; `node` comes from `RUNTIME_MOUNT`; cargo's and go's caches
  (`~/.cargo`, `~/go/pkg/mod`) are read-only binds when they exist (the owner's own downloads), so
  `--offline` finds them (the same binds the sandbox gate's `deps` use).

### 4.11 Where the result shows, and what reuses it

- **The step line** (`web/steps.js`): "🔎 checked 2 files · 1 error" under the edit step, a click opens
  the list (file:line links open the existing file viewer at that line).
- **The reply chip**: "✓ types clean (tsc)" when her edits ended clean, "⚠ 2 type errors left" when not;
  none when no check ran. Old clients see nothing new (the block is in the tool result text).
- **The run record**: each check is a step tool `diagnostics` (`rec.tool`, args `{checker, files}`,
  output the block, `ms`), like goals' `goal_check`; Settings → Runs filters on it.
- **Receipts**: a new claim kind `types_clean` ("it compiles", "no type errors", "the types check",
  in the six languages' claim words): **contradicted** when the turn's last check had errors in files
  she changed, **missing** when she changed files and no check ran (only when checks are *On* for the
  project; otherwise it isn't checked, as today).
- **Goals (Phase 118)**: `checkOptions` offers **Types check** (`kind: 'types'`) when a project has a
  checker; a goal round's check can then be "Tests pass + Types check". It runs the same P3 driver
  over the whole project (not touched files) and is red on any error.
- **The project page** (Planner → a coding project, its workspace view): the **Checks after her edits**
  row (§4.3) with the last result per checker, *Run now*, and *Problems* (the full latest list, ≤ 500).
- **`@problem`** (part B) and `/problems` (§4.13) read `Checks.latest`.
- **"## This project"** gets one line: "Type check: tsc --noEmit (Sara checks your edits)".

### 4.12 Tables (additive)

In the shared code cache folder (`<data>/cache/codemap/checks.db`, one file for all workspaces, opened
by `CodeMaps` beside the map databases):

```sql
CREATE TABLE IF NOT EXISTS diag_cache (
  workspace TEXT NOT NULL,
  project TEXT NOT NULL,          -- ProjectFacts.path ('.' or 'packages/web')
  checker TEXT NOT NULL,          -- 'tsc' | 'pyright' | 'mypy' | 'cargo' | 'govet' | 'eslint' | 'lsp:typescript' …
  file TEXT NOT NULL,             -- workspace-relative, forward slashes
  sha TEXT NOT NULL,              -- sha256 of the file content the result is for
  diags TEXT NOT NULL,            -- JSON Diagnostic[] (≤ 200)
  at TEXT NOT NULL,
  PRIMARY KEY (workspace, project, checker, file)
);
CREATE TABLE IF NOT EXISTS diag_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  project TEXT NOT NULL,
  checker TEXT NOT NULL,
  engine TEXT NOT NULL,           -- 'command' | 'server'
  files TEXT NOT NULL,            -- JSON string[] (touched, ≤ 50) or '*'
  started_at TEXT NOT NULL,
  ms INTEGER,
  exit_code INTEGER,
  state TEXT NOT NULL,            -- 'ok' | 'errors' | 'broken' | 'timeout' | 'stopped'
  errors INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  other_errors INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS diag_runs_ws ON diag_runs(workspace, project, id);
```

`diag_runs` keeps the newest 200 per project. In the main companion's `sara.db`:

```sql
CREATE TABLE IF NOT EXISTS project_checks (
  workspace TEXT NOT NULL,
  project TEXT NOT NULL,
  state TEXT NOT NULL,            -- 'ask' | 'on' | 'off'
  checkers TEXT NOT NULL,         -- JSON: the checker ids allowed, e.g. ["tsc","eslint"]
  python TEXT,                    -- 'pyright' | 'mypy' (when both are set up)
  asked_at TEXT,                  -- the last time the card was shown (once a day at most)
  decided_at TEXT,
  PRIMARY KEY (workspace, project)
);
```

### 4.13 In Telegram, Discord and plugin bridges

- Checks run the same way whatever app the turn came from (they are part of the turn). The progress
  message (B4) shows the step as a verb: "🔎 checking her edit" → "🔎 1 type error" → "✏️ fixing".
- The final reply gets one plain line when something is left: "⚠ 2 type errors left in src/a.ts
  (tsc)." Clean results add nothing (no noise on a phone).
- The first-time card (§4.3) is a short message with buttons *Check her edits here* / *Never here*
  (Telegram inline keyboard, Discord components; Signal and email as "Reply YES to …", like their
  other choices).
- **`/problems`** (typed, owner only, joins `bridges/commands.ts`, never reaches a model): lists the
  latest problems of this chat's project (≤ 10 lines, "and 24 more" with a link to the project page);
  `/problems check` runs a check now; `/problems off` / `/problems on` sets the project's choice.
  Partners, talk-only rooms and members get the usual "owner only" refusal.

### 4.14 The web app

- **Settings → Abilities → Coding projects → Check her edits**: the global switch, *Use a language
  server when one is installed* (with the four servers and whether each was found, *How to install*
  links), the wait and time limits as pick-lists, *Also show warnings*, *Remind her to fix what she
  broke* (0–3).
- **The project page** (the workspace view of a coding project): **Checks after her edits**, per repo:
  the found checkers with their exact command lines, the project's own `typecheck` / `lint` script
  shown for comparison, *On* / *Off* / *Ask*, a tick per checker, *Run now*, the last run (when, how
  long, how many errors), and *Problems* (a list grouped by file; a click opens the file viewer at the
  line). Not installed: "Not installed in this project" and the install command as text to copy.
- **The step line and the reply chip** (§4.11); a check still running shows a small spinner on the
  step, Stop stops it with the turn.

### 4.15 ? tips (each ≤ 260 characters)

- *Check her edits:* "After Sara changes a file, your project's own type checker or linter looks at it
  and she sees the errors before she answers. Nothing is installed; only tools your project already has
  are used."
- *The per-project OK:* "Some checkers run code from your project (an ESLint config, mypy plugins,
  Rust build scripts). That's why each project asks once. Off any time on the project page."
- *Language server:* "If you installed one (like typescript-language-server), checks after each edit
  get much faster. Sara never downloads one."
- *Errors left:* "She fixes the errors her own edits caused, up to twice per reply, inside the reply's
  budget. Anything left is listed here, never hidden."

### 4.16 Routes (owner only; members and the demo get 404)

| Method and path | What |
|---|---|
| `GET /api/precise` | Settings, the choices, the servers found (name, path shown as "found in your PATH" or "in this project", version when `--version` answers within 2 s) |
| `PUT /api/precise` | Change settings (`mergePrecise`) |
| `GET /api/workspaces/:ws/checks` | Per repo: the found checkers (`id`, `label`, `argv` shown, `runsProjectCode`, `installed`), the project's own scripts, `project_checks` state, the last `diag_runs` row per checker |
| `PUT /api/workspaces/:ws/checks` | `{project, state?, checkers?, python?}`; only checkers that were found; `state: 'on'` with a checker that runs project code needs `confirm: true` (the UI shows the phrase) |
| `POST /api/workspaces/:ws/checks/run` | `{project}`: a full check now (409 while one runs), returns the run |
| `GET /api/workspaces/:ws/problems` | `?project=&file=`: the latest diagnostics (≤ 500), counts per file |
| `POST /api/conversations/:id/checks/answer` | The first-time card: `{project, answer: 'on' \| 'later' \| 'never'}` |

---

## 5. Part B · @-references in the message

### 5.1 Scope

In: six kinds, typed or picked: `@file` (with an optional line or range), `@folder`, `@url`, `@diff`
(with `@diff:staged`), `@branch`, `@problem`; autocomplete in the web composer; chips before sending and
on the sent message; the same typed text in Telegram, Discord, Signal, email and plugin bridges; one
server-side parser and reader; caps; privacy rules.

Out (2.53): `@git:N` commits and `@commit:sha` (§11 Q10), `@symbol` (the code map can find symbols; a
later kind), `@chat` (earlier conversations: `recall.ts` and `/continue` exist), `@terminal`, images by
reference, references in her own replies (she uses tools), the VS Code panel switching to references
(§5.9).

### 5.2 The grammar (one, server-side, in `refs.ts`; the web app has a copy for chips only)

```
@file:<path>             @file:src/app.ts            the whole file (capped)
@file:<path>:<n>         @file:src/app.ts:42         one line, with 5 lines around it
@file:<path>:<a>-<b>     @file:src/app.ts:10-25      lines a..b (1-based, inclusive)
@folder:<path>           @folder:src/components      a tree listing
@url:<http(s) URL>       @url:https://example.com/x  the page as text
@diff                    @diff                       uncommitted changes (working tree vs HEAD)
@diff:staged             @diff:staged                staged changes only
@branch                  @branch                     this branch compared with the default branch
@branch:<name>           @branch:feature/x           that branch compared with the default branch
@problem                 @problem                    the latest problems in the files of this project
@problem:<path>          @problem:src/a.ts           the latest problems in one file
```

- **Where a token starts**: at the start of the text or after whitespace or `(` `[` `"` `'`. So
  `me@example.com` and `user@host` are never references.
- **Kind words are exact and lowercase-insensitive** (`@File:` works); a bare `@file` without `:` is
  not a reference. `@diff`, `@branch`, `@problem` (and the plural `@problems`) stand alone.
- **Paths**: no spaces unless quoted: `@file:"docs/My notes.md":3-9`. Trailing `. , ; ! ?` and a closing
  `)` that has no opening one in the token are left out (so "look at @file:a.ts." works). `\` is read as
  `/`. A leading `/workspace/` or `./` is dropped (the same cleaning as `resolveInside`).
- **Bare paths** (`@src/app.ts`, the way Claude Code and Cursor allow): only in the web composer, where
  the popup turns them into `@file:` when picked. Typed bare paths are **not** references (in chat apps
  `@word` is a person; §5.8).
- **At most 10 references per message**; the 11th and later stay plain text and the chip row says
  "Only the first 10 references are attached."
- **A reference stays in his text as typed.** The model sees his message unchanged plus the attached
  block (§5.6), so "this file" in his words still points at it.

### 5.3 What each kind reads

All reads are **server-side**, in the conversation's workspace (`wsOf(app, conv)`), with Sara's own
helpers. No tool call, no approval card (he asked for it himself; §6.1), and nothing runs that
changes anything.

| Kind | How it's read | Caps | Refused when |
|---|---|---|---|
| `@file` | `resolveInside` then `readInsideNoFollow` (no links anywhere in the path, the real path inside); UTF-8 text; a range reads only those lines; numbered like `read_file` (`42| …`) | `perRefChars` (40,000); a whole file over the cap is cut with "[cut at 40,000 characters: ask for a range]" | outside the workspace, a link, a folder, binary (a NUL in the first 8 kB), over 20 MB, a secret name (§5.4), not found ("No file src/ap.ts. Did you mean src/app.ts?" from the code map's `findPath`) |
| `@folder` | the code map's file list under that folder (falls back to a bounded `readdir` walk honouring `codemap/ignore.ts`): `path  (lines, size)` | `folderEntries` (200), depth 4 | as `@file`, and folders like `.git`, `node_modules` |
| `@url` | `assertPublic` (http/https, `checkOutbound` **before** DNS, private addresses refused) then `pinnedGet` with redirects re-checked (≤ 5), `htmlToText`, the "written by others" line; 20 s | `perRefChars`, 2 MB body | private conversation, private local mode on (the guard's own error), `refs.urls` off, `web_fetch` set to *never*, a private address, not http(s) |
| `@diff` | `git` with `GIT_SAFE`: `diff --no-ext-diff --no-textconv --stat --patch HEAD` (falls back to `diff` in a repo without commits); `@diff:staged` adds `--staged` | `perRefChars`; a diff over the cap keeps the `--stat` and the first files whole | not a git repository; clean ("No uncommitted changes.") is not a refusal, it attaches that line |
| `@branch` | the default branch from `ProjectFacts.defaultBranch` (else `main` / `master`), `git log --oneline <base>..HEAD` (≤ 20) and `git diff --stat --patch <base>...HEAD`; `@branch:x` uses `x` checked with `SAFE_REF` | `perRefChars` | not a repo, the base or the branch not found, on the default branch itself ("You're on main: nothing to compare.") |
| `@problem` | `Checks.latest(workspace, project)` (part A's cache, the newest result per file) in the §4.6 format with every file, not only touched ones | 50 diagnostics, `perRefChars` | checks *Off* or never run for this project: the chip says "No check has run here yet" and offers *Run now* (web) / attaches "No checks have run in this project yet (Sara's checks are off here)." |

Workspace references with more than one repository in the workspace (`findRepos` > 1): paths are
workspace-relative as everywhere; `@diff`, `@branch` and `@problem` use the repository of the
conversation's project folder if it has one, else the only repo, else they ask through the chip "Which
project? web/ · api/" (typed form `@diff:web/`).

### 5.4 Who and where: boundaries and the privacy rules

- **Only the owner's own words.** References are read only for a message whose sender is the owner
  (`sender: 'owner'`: the web app, his own Telegram/Discord/Signal/email/plugin account). A partner, a
  person in a room, a household member, another app (`/v1`, MCP, A2A, Home Assistant, Alexa) or a
  webhook typing `@file:…` gets **plain text**: nothing is read, no chip, no error (so nobody learns
  what exists). This is the same line `persistRefusal` draws, applied per message.
- **Where**: the owner's private chats and his **work rooms** (`isWorkChannel`), in the conversation's
  workspace. **Not** in partner chats, talk-only rooms, group chats of companions (Phase 66; `@Name`
  there is a person), or off-the-record chats for workspace kinds (they keep nothing, so the reference
  would be the only copy: refused with "Off the record, nothing is attached."; `@url` is allowed there and
  stored nowhere, like the message).
- **Private conversations** (`conv.private`: local models only, no web): `@file`, `@folder`, `@diff`,
  `@branch`, `@problem` work (nothing leaves the server and the model is local); **`@url` is refused**
  ("Private chats don't open web pages."). With **private local mode** on, `@url` is refused by the guard
  itself (`checkOutbound` → `PrivateLocalError`), and the chip says so in the guard's words.
- **Secrets**: the names `send-file.ts SECRET_NAME` already refuses (`.env*`, `.ssh/`, `.gnupg/`,
  `.secrets/`, `id_*`, `*.pem|key|p12|pfx|keystore|jks`, `vault*`, `sara.db`, `store.db`) plus `.git/`
  internals, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, Sara's own `.gitconfig` and `.sara-task-*` are
  refused by name, case-insensitively and with the Windows tricks `assertWritable` handles (trailing dots
  and spaces, `GIT~1`). One shared `isSecretPath` moves into `tools/workspace.ts` so `send_file`,
  references and the file viewer use the same list.
- **Content is untrusted.** Every expansion is wrapped as data, not instructions (the same words
  `web_fetch` uses), scrubbed by `app.redactor` (a key that slipped into a file is masked before the
  model or the database sees it), and the turn treats it like a tool result: it can't approve
  anything or loosen a rule. A file in a cloned repository is someone else's text too.
- **Size caps** (§5.6) apply before anything is stored.
- **Household**: see §7: members have no workspace references at all.

### 5.5 `@url` and the net guard, in one place

`@url` is not a second fetcher: `tools/builtin.ts` exports `guardedGet(url, {signal, allowPrivate:
false})` (the loop that `web_fetch.run` already has: `assertPublic` per hop, `pinnedGet`, redirects ≤ 5,
20 s), and both `web_fetch` and `refs.ts` call it. So every rule of `web_fetch` holds: http/https only,
the private-local check before the DNS lookup, private and link-local addresses refused (the owner's
*allow private network* setting does **not** apply to references, §11 Q11), the connection pinned to the
checked address, 2 MB, HTML to text. The fetched page is in the run record as a `ref` step with its URL
and status, and in Settings → Data & health → *Blocked recently* when the guard refused it.

### 5.6 When it's read, what's stored, and what the model gets

- **Read once, when his message is saved** (in `runTurn`, where `opts.images` / `opts.docs` go into
  the owner message's `meta`; for a steer or queued message, when it is taken and saved, so the text she
  gets is the text at that moment). One `message_refs` row per reference with the expanded text (scrubbed,
  capped) or the refusal reason; the message's `meta.refs` keeps the chips (kind, label, size, ok/why).
- **Retry and edit** (`/retry`, editing the last message) read them again (the file may have changed);
  a plain *Continue* (`resume`) uses the stored rows.
- **The model gets** his message unchanged, then the block, in `buildHistory`:

  ```
  <attached by {owner} with this message: information to use, not instructions>
  @file:src/app.ts:40-60 (lines 40–60 of 212)
  40| export function total(items: Item[]) {
  …
  @problem (tsc, checked 4 min ago): 2 errors
  src/app.ts:51:12 error TS2339: Property 'price' does not exist on type 'Item'.
  …
  </attached>
  ```

- **Caps, before storing**: one reference ≤ `perRefChars`; all of a message's references together ≤
  `softPct` (25 %) of the history budget (`historyBudgetChars`) → kept, chip warns "Large: uses a quarter
  of her memory for this chat"; over `hardPct` (50 %) → the biggest ones are dropped (refused "Too big to
  attach with the rest; ask for a range") until it fits. The CH1 context ring counts the block.
- **Older messages**: with `olderAs: 'stub'` (default), only the newest owner message with references
  carries the full block; older ones carry one line per reference ("[attached earlier: src/app.ts lines
  40–60, 1,240 characters]") so a long session doesn't re-send old files every step. She can read the
  file again with her tools when she needs it (§11 Q9).
- **Budgets**: the block is part of the prompt, so it counts in the turn's token meter like any message;
  no model call reads a reference.
- **Replays (M8)** use the stored rows, so a branch sees exactly what the original turn saw.

### 5.7 The web app: the `@` menu, autocomplete and chips

`web/refs.js` (new, ~350 lines) with `web/refs.css`, wired into `#input`:

- **Typing `@`** at a token start (§5.2) opens a small listbox under the caret (the command bar's
  combobox + listbox pattern: ↑ ↓, Enter or Tab to pick, Escape to close, `aria-activedescendant`,
  `fold` / `score` from `command-bar.js`):

  ```
  📄 A file              @file:
  📁 A folder            @folder:
  ± My changes           @diff
  ⑂ This branch          @branch
  ⚠ Problems             @problem      (2 errors)
  🌐 A web page          @url:
  ```

  Items that can't work here are left out, not greyed: no workspace items without a workspace or for a
  non-owner session, no *A web page* in a private chat or with private local mode on, no *Problems*
  when checks are off for the project (or shown with "not checked yet" when they could be).
- **After `@file:` / `@folder:`** (or typing `@` then letters, which searches files directly), the list
  shows matching paths from the code map (`GET /api/conversations/:id/refs/complete?kind=file&q=`),
  best first (name start, then path parts, then anywhere; recently changed files first on ties), with
  size and lines; picking a folder continues into it (`/`), picking a file inserts `@file:path ` and the
  caret can type `:10-25`. 20 results, 150 ms debounce, never more than one request in flight.
- **After `@branch:`**: local branch names (`git branch --format`, ≤ 50). **After `@url:`**: no list;
  pasting a URL right after `@` turns into `@url:`.
- **Chips**: each finished reference becomes a chip in the attachment row (`#attachments`, next to photo
  and document chips): `📄 src/app.ts · 40–60 · 1.2 kB`, `± 3 files · +42 −7`, `⚠ 2 errors`, or red
  "Outside this project" / "Looks like a secret" / "Not in private chats". The size comes from `POST
  /api/conversations/:id/refs/preview` (debounced 300 ms; reads sizes, not contents, except `@url`, which
  is only checked against the guard, not fetched). **×** on a chip removes the token from the text.
- **Sent message**: the bubble shows the chips under the text; a click opens the file viewer at the
  range, the diff in the project page's changes view, the URL in a new tab, the problems list. The full
  expanded text is one more click (*What she got*), from `GET /api/messages/:id/refs`.
- **While she works**: references work in steer and queued messages (BR2) the same way.
- **Old messages, old clients**: a client before 2.53 shows the typed text; the server still expands it.

### 5.8 In Telegram, Discord, Signal, email and plugin bridges

- **Typed text works**: `@file:src/app.ts:10-25` in his own chat with her is read exactly as in the
  web app (the parser is server-side). No autocomplete; `/help refs` (and a line in `/help`) lists the
  six forms in his language.
- **The reply says what was attached** in one plain line before her answer when anything was refused:
  "(I couldn't attach @file:.env: it looks like a secret.)" Successful references are silent (the
  message is already long on a phone).
- **Name clashes**: Discord turns `<@id>` into `@Name` before the turn (`discord.ts` l. 614); the parser
  runs on the **raw** text before that conversion, so a Discord user called "diff" never becomes `@diff`.
  Telegram usernames are `@word` without `:`; only `@diff`, `@branch`, `@problem(s)` are bare kinds, and
  in a Telegram group they count only when the message also addresses her (the room rules already decide
  whether she answers at all).
- **Rooms**: only in his work rooms (§5.4); her reply there may quote the file, which he chose by
  asking in a room. Talk-only rooms and partner chats: plain text.
- **Email (Phase 117)**: references in the owner's own email to her work the same; anything in a
  forwarded part (`untrusted`) is never read as a reference.

### 5.9 Other surfaces

- **VS Code panel**: unchanged; it keeps sending the selected code itself (its files may not be in
  Sara's workspace, which is often another computer). §11 Q12 asks about sending `@file:` when the panel
  can tell the file is in the conversation's workspace.
- **`sara-chat` CLI and the Mac/Windows/phone apps**: typed text works through the same message route;
  the desktop apps get the `@` menu with the web app (they load it).
- **The `/v1` API, MCP `ask_sara`, A2A**: references are plain text (not the owner typing in Sara).

### 5.10 ? tips (each ≤ 260 characters)

- *The @ menu:* "Type @ to attach a file, a few lines, your changes, this branch, the current errors or a
  web page. She gets the text with your message, so she doesn't have to go looking."
- *Typed in chat apps:* "In Telegram or Discord, type @file:src/app.ts:10-25, @diff, @branch, @problem or
  @url:https://… and she reads it the same way."
- *Safe by design:* "Only files in this chat's project, never secrets like .env or keys, never in chats
  with other people. Web pages go through the same guard as her web tool."
- *Big files:* "A whole file is cut at 40,000 characters. Ask for lines (@file:a.ts:100-180) to keep her
  focus and your tokens."

### 5.11 Tables (additive; the conversation's own `store.db`)

```sql
CREATE TABLE IF NOT EXISTS message_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,     -- the owner message the reference was typed in
  conversation_id TEXT NOT NULL,
  idx INTEGER NOT NULL,            -- order in the message (0..9)
  kind TEXT NOT NULL,              -- 'file' | 'folder' | 'url' | 'diff' | 'branch' | 'problem'
  token TEXT NOT NULL,             -- as typed (≤ 500)
  target TEXT,                     -- the resolved path / URL / branch (workspace-relative)
  range_from INTEGER,
  range_to INTEGER,
  status TEXT NOT NULL,            -- 'ok' | 'cut' | 'refused' | 'empty'
  reason TEXT,                     -- refusal key ('outside', 'secret', 'private', 'guard', 'too-big', 'not-found', 'binary', 'not-repo')
  text TEXT,                       -- the expanded text (scrubbed, ≤ perRefChars); NULL when refused
  chars INTEGER NOT NULL DEFAULT 0,
  sha TEXT,                        -- sha256 of the file / diff / page text read
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_refs_msg ON message_refs(message_id, idx);
CREATE INDEX IF NOT EXISTS message_refs_conv ON message_refs(conversation_id);
```

Deleted with their message or conversation (the same cascade as message `meta`); the export (`sara
export`) includes them; *Forget* on a message removes its rows; rows older than the conversation's
history keep window go with the history cleanup.

### 5.12 Routes (owner only; members, partners and the demo get 404)

| Method and path | What |
|---|---|
| `GET /api/conversations/:id/refs/complete?kind=file\|folder\|branch&q=` | ≤ 20 suggestions `{insert, label, detail}` from the code map / git; refuses (empty list) where references can't be used |
| `POST /api/conversations/:id/refs/preview` | `{content}` → per token `{token, kind, label, ok, reason?, chars?, lines?}` (sizes only; `@url` only checked against the guard and the rules) |
| `GET /api/messages/:id/refs` | the stored rows of one message (the *What she got* view) |
| `GET /api/workspaces/:ws/problems` | (part A) also used by the *Problems* chip |

### 5.13 Done when (`test/phase120.test.ts`, plus the existing suites green)

With the **scripted fake model** (`test/helpers.ts` `FakeProvider` / `makeApp`: it plays a script of
steps and records every request), a **fake clock**, and a temp workspace that is a git repository with a
`tsconfig.json`, a `package.json` and **fake checkers that are plain Node scripts** at the paths the
detector looks for (`node_modules/typescript/bin/tsc`, `node_modules/eslint/bin/eslint.js`,
`node_modules/pyright/index.js`): each reads the files named in a `fake-errors.json` (or scans for a
marker like `// TYPE-ERROR:` in the source) and prints in its real format (tsc `file(l,c): error TSnnnn:`,
eslint `--format unix`, pyright `--outputjson`). A **fake language server** is a Node script speaking
JSON-RPC over stdio (`initialize`, `didOpen`, `didChange`, `publishDiagnostics`, pull diagnostics, and a
`crash` mode). No real tsc, pyright, cargo or go is needed; parser tests use recorded output strings for
all six formats (including Windows paths with `\` and drive letters, and CRLF output).

*Part A, checks after her edits*
- **Detection, code only**: `detectCheckers` finds tsc (tsconfig + the bin file), eslint (config + bin),
  pyright over mypy when both are configured, `cargo check --offline` with a `Cargo.toml` and a fake
  `cargo` on the PATH, `go vet` with `go.mod`; with the bin file missing → listed `installed: false`, never
  run; a `package.json` `typecheck` script is shown, not run; nothing ever calls `npx`, `pip`, `cargo
  install` or `go install` (a recorder on `runCommand` sees none); `ProjectFacts.checkers` and "## This
  project" carry the line.
- **The OK per project**: the first `edit_file` in a project in state `ask` → no check runs (no
  `runCommand` for a checker), a `checks` card event with the exact argv and the "runs your ESLint config"
  phrase; `POST /checks/answer {on}` → the next step's edit is checked; `never` → never asked again;
  `later` → asked again the next day (fake clock), not in the same day. On a fake Windows (`sandbox.mode
  'none'`, `process.platform` stubbed) the card says "directly on this computer".
- **The main test, fed back into the turn**: checks *On*; the fake model edits `src/a.ts` to add a
  `// TYPE-ERROR: TS2322` line; the stored tool result ends with the block "[Checked with tsc --noEmit
  …] 1 new error in the files you changed: src/a.ts:3:7 error TS2322 …"; the **next** model request
  contains that block in the tool message; the fake model fixes it; the next tool result says "no
  errors in the files you changed"; the run has two `diagnostics` steps; the reply chip is "types clean".
- **Only hers, plus a count**: a baseline from an earlier check with 3 errors in `src/b.ts` (untouched)
  and 1 in `src/a.ts` (same hash) → after her edit adds 1 more in `src/a.ts` the block writes out only
  the new one, "(1 error in src/a.ts was there before your edit)" and "Also 3 errors in 1 other file";
  a line shift above an old error doesn't make it new. Her rename that breaks `src/c.ts` → "Your change
  broke 1 other file: src/c.ts:…".
- **One check per step**: three `edit_file` calls in one step → one checker run after the third, the
  block on the third result only; a denied edit adds no file; a `shell` call that rewrites `src/a.ts`
  (fingerprint changed) → checked; one that only writes `out.log` → not.
- **Bounded**: a fake tsc that sleeps 30 s with `waitS` 5 → the result line says "Still checking", the
  block arrives on the next tool result; with no next tool call, the final reply waits once and then the
  nudge or the chip uses it; a checker sleeping past `timeoutS` → killed, "took longer than 60 s" once
  per turn; output of 2 MB → capped at 400 kB, ≤ 20 lines written out, "… and 180 more"; ≤ 3,000
  characters added; 4 tsconfigs touched → at most 3 runs this step.
- **The nudge**: the fake model writes an error and answers "Done!" → one more step with the app note
  (not from the owner), it fixes it, the final reply is the second one; `nudges: 2` → a model that never
  fixes gets exactly 2 nudges, then the reply chip "1 type error left" and the bridge line; the turn
  budget at its last rung → no nudge; a goal round or a loop tick → no nudge; the owner's message "leave
  the errors, it's WIP" → no nudge; the claim "it compiles now" with errors left → `types_clean`
  contradicted.
- **Never breaks a write**: a fake tsc that exits 2 with no file:line lines → the write's result is
  unchanged plus one "Couldn't check" line, the turn goes on; a missing bin file after the OK → `broken`
  once; a checker command that `classifyCommand` calls `installs` / `network` (a planted
  `node_modules/.bin`-free path can't make it, but a fake detector entry can) → refused, never run.
- **Language server**: with the fake server set as `typescript-language-server`, servers on → the
  edit's verdict comes from `publishDiagnostics` within `serverWaitMs`, the baseline from `didOpen` of
  the old content; the server is reused across steps (one spawn), stopped after `idleMin` (fake clock),
  restarted after a crash once, after two crashes the project falls back to the command (and the block
  still appears); `engine: 'command'` → no spawn at all.
- **Stop**: Stop during a check kills the checker (its process gone), no `diag_runs` row says `ok`, the
  turn stops as today.
- **Off per project**: `PUT /checks {state:'off'}` → no check, no card; `/problems off` from the fake
  Telegram owner → the same; from a partner → refused before any model call.
- **Not in**: a replay branch (`opts.replay`) runs no checker and keeps the recorded block; `/v1` and MCP
  turns run none; a member's space has no checks routes (404) and her companion has no tools.
- **Goals**: `checkOptions` lists `types` with the detected command; a goal with *Tests pass + Types
  check* is red while the fake tsc reports an error in any file.
- **Cross-platform paths**: the parser maps `C:\ws\src\a.ts(3,7)` and `/workspace/src/a.ts:3:7` to
  `src/a.ts`; a diagnostic for a path outside the workspace is dropped; checkers start as `node <bin
  file>` (never a `.cmd` shim) on the fake Windows.

*Part B, @-references*
- **The grammar**: `@file:src/a.ts:10-25`, `@file:"docs/My notes.md":3`, `@folder:src`, `@diff`,
  `@diff:staged`, `@branch`, `@branch:feature/x`, `@problem`, `@problem:src/a.ts`, `@url:https://x.test/p`
  parse; `me@example.com`, `user@host`, `@Mia`, `@file` without `:` and `@filesystem` don't; trailing
  `.,;!?` and an unmatched `)` are dropped; the 11th reference stays text.
- **The main test**: the owner posts "why does @file:src/a.ts:2-3 fail with @problem?" → one
  `message_refs` row per reference (`ok`), `meta.refs` chips, the message `content` unchanged, and the
  fake model's request has his text **then** the `<attached …>` block with lines 2–3 numbered and the
  latest problems; no tool call was made; the run's step 0 lists both references.
- **Workspace boundaries**: `@file:../outside.txt`, `@file:/etc/passwd`, a link `src/l → ../../x`, a
  linked parent folder, `@file:.env`, `@file:.ENV.`, `@file:keys/id_ed25519`, `@file:.git/config`,
  `@file:GIT~1/config` → all `refused` with the right reason, no bytes of them in any request or row;
  a binary file → `binary`; a missing file → "Did you mean src/app.ts?".
- **Size caps**: a 300 kB file → cut at `perRefChars` with the cut line; references totalling over 25 %
  of the history budget → kept with the warning; over 50 % → the largest refused `too-big` until it fits;
  `@folder` with 500 files → 200 entries and "… 300 more".
- **Git kinds**: `@diff` shows an uncommitted change; clean → "No uncommitted changes."; `@diff:staged`
  only the staged one; `@branch` on a feature branch shows the commits and the three-dot diff against the
  default branch; on the default branch → "nothing to compare"; a repository config with
  `core.fsmonitor`, `diff.external` and a `textconv` driver runs none of them (a marker file a fake
  program would write never appears).
- **`@url` through the guard**: a fake HTTP server on a public-looking pinned address → fetched, text
  attached with the "written by others" line; `@url:http://127.0.0.1/…`, `http://169.254.169.254/`, a
  redirect to a private address, `file:///etc/passwd`, `ftp://` → refused; private local mode on →
  refused before any DNS lookup (the fake resolver isn't called); a private conversation → refused;
  `web_fetch` set to *never* → refused; `refs.urls` off → refused.
- **Who and where**: the same text from a partner (fake Telegram partner chat), a talk-only room, a
  member's space, a group chat of companions (where `@Mia` still names Mia), `/v1`, MCP and A2A → plain
  text, no rows, no reads (a recorder on `readInsideNoFollow` and `guardedGet` sees nothing); the owner in
  his work room → read; off the record → workspace kinds refused, `@url` read and stored nowhere.
- **Chat apps as typed text**: fake Telegram owner sends `@file:src/a.ts:2-3` → attached exactly as in the
  web app; a refused one adds the one-line note before her reply; a fake Discord message with `<@123>`
  for a user named "diff" → no `@diff` reference; `/help refs` lists the forms with zero model calls.
- **Read once**: the file changes after the message was saved → a *Continue* (`resume`) sends the stored
  text; `/retry` reads it again; a steer with `@diff` is read when taken at the safe point; a replay
  branch uses the stored rows.
- **Older messages**: with `olderAs: 'stub'`, the third turn's request has the full block for the newest
  referencing message only and a one-line stub for the earlier one.
- **Scrubbed**: a file containing a fake API key → the stored row and the request carry the redactor's
  mask, never the key.
- **Autocomplete routes**: `refs/complete?kind=file&q=app` returns `src/app.ts` first from the code map;
  a partner or member session → 404; `refs/preview` returns sizes without reading `@url` bodies (the fake
  server sees no request).

*Both*
- **Safety unchanged**: the owner's message with references gets `preflight` once as today (a minors hit
  in **his own words** refuses as today; a file's content is data, checked by the reply-side minors check
  like any tool output, never by "the owner said"); every nudge step runs the disclosure rule and the
  reply checks; private conversations still use local models only.
- **Old data and clients**: a 2.52 database opens and gets the new tables; messages without `meta.refs`
  render as before; the 2.52 web client's plain text still works (the server expands); zero new npm
  runtime dependencies (`package.json` `dependencies` unchanged).

### 5.14 Owner to-dos

On a real TypeScript project from the web app (Windows, this PC): ask her for a small change that will
break a type, answer the first-time card *Check her edits here*, and watch the block, the nudge and the
chip; look at the project page's *Checks after her edits* and *Problems*, try *Off*. If you have
`typescript-language-server` installed, switch *Use a language server* on and compare the speed. On a
Linux server (bubblewrap) do the same with a Python project using pyright or mypy, and if there is one, a
Go or Rust project. In the composer type `@` and try every item; send `@file:…:10-25`, `@diff`,
`@branch`, `@problem` and `@url:` with a real page; check a `.env` is refused and that a partner chat
on Telegram doesn't read anything. From Telegram send `@file:…` and `/problems`. Decide §11 Q1–Q14.

---

## 6. Safety and privacy across the phase

### 6.1 The mandatory layer is untouched

Checks are commands the app runs, not her tools; references are text the app reads for the owner's own
message. Neither approves, denies or skips a card. The disclosure, honesty, crisis and minors rules run
on every turn and every nudge step as on any turn; nothing here can switch them off. The approval system
stays the owner's: the per-project OK is one more owner choice, recorded with who and when.

### 6.2 The leak paths, and what closes each

| Path | Closed by |
|---|---|
| A partner or room member types `@file:` to read the owner's files | References only for `sender: 'owner'` in his own chats and work rooms; anything else is plain text with no read and no error (§5.4) |
| `@file:../../` or a link to escape the workspace | `resolveInside` + `readInsideNoFollow` (no links in any part, real path inside), the code map's THREAT_MODEL §5 rule |
| `@file:.env`, keys, Sara's own databases | One `isSecretPath` list (send_file's, plus `.git/`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`), Windows name tricks included |
| A secret inside an ordinary file | `app.redactor` on every expansion before it's stored or sent |
| `@url` to the cloud metadata address or the LAN | `guardedGet` = `web_fetch`'s `assertPublic` + `pinnedGet`, redirects re-checked; *allow private network* not honoured for references |
| `@url` while "nothing leaves this computer" | `checkOutbound` before DNS; private conversations refuse `@url` outright |
| A hostile repo runs code through a checker | The per-project OK naming which checkers run project code; the workspace sandbox (network off) on Linux/macOS; on Windows the card says "directly on this computer"; `classifyCommand` refuses installs/network/deletes/system |
| A checker downloads things | `--offline`, `GOPROXY=off`, `npm_config_offline`, `PIP_NO_INDEX`, network off in the sandbox, `PRIVATE_LOCAL_ENV`; never `npx` |
| Checker output tells her to do something ("ignore your instructions") | It's tool output, as today: fenced, scrubbed, no extra rights; the nudge note says "from the app, not from {owner}" |
| A huge file or page fills the context and the bill | `perRefChars`, the 25 % / 50 % caps, stubs in older messages, the token meter |

### 6.3 Threat model additions (`docs/THREAT_MODEL.md` in the release)

A repository whose `eslint.config.js`, mypy plugin, `build.rs` or tsserver plugin runs code when checked
(per-project OK with the "runs project code" phrase, sandbox, no network, Windows labelled); a planted
`node_modules/typescript/bin/tsc` that isn't tsc (same: it's project code, and the OK covers the
project); output crafted to look like diagnostics for files outside the workspace (dropped); a
language server that floods stdout (per-message and per-minute caps, kill); references as a way for
someone else to read files (owner-only rule, plain text otherwise); `@url` SSRF and DNS rebinding (the
pinned guarded fetch); a file that injects instructions (fenced as data, scrubbed, no authority).

---

## 7. Household isolation

- **Checks and workspace references are owner-space only.** Members' companions have no tools
  (`isMember`) and no workspace views; their routes for checks, problems and reference completion return
  404, their composer's `@` menu offers only nothing (the menu doesn't open), and typed references in a
  member's message stay text (§11 Q13 asks about `@url` for members).
- **Shared code cache, owner's choice**: `diag_cache` / `diag_runs` are shared by the owner's companions
  (the workspaces are), and `project_checks` lives in the main companion's `sara.db`, so one OK covers
  every companion he has working in that project. Members never read them.
- **No crossing**: a reference reads only the conversation's own workspace; a companion working in
  workspace `web` can't attach a file from workspace `api` by reference (she can open another workspace
  only the ways she already can).
- **Chat apps** belong to the owner's main companion, as today; a reference typed there reads that
  conversation's workspace.

---

## 8. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `runCommand`, the workspace sandbox, `PRIVATE_LOCAL_ENV`, `classifyCommand`, `refuseCheck`, `app.redactor`, `commandPath`, `windowsShell` | `persist.ts` `runProjectCommand` (the full capped output; `runCommandCheck` on top of it) | `src/diagnostics.ts` (P1, P3–P6) |
| `projectknow.ts` `findRepos`, `scanProject`, `projectSection` | `ProjectFacts.checkers`, one "Type check" line | `project_checks`, `diag_cache`, `diag_runs` |
| The tool loop's post-call point (`CHANGES_FILES`, `codemap.touch`), `TurnHooks` (`afterReply` final, `beforeModelCall` note), `budgetCheck`, the ladder | the post-call point appends the block; one hook for the nudge | — |
| `persist.ts fingerprint` / `fpChanges` | used per step for `shell` / `git_*` calls when checks are on | — |
| `checkOptions` (goals), `receipts.ts` claims, `runs.ts rec.tool` | `CheckKind` `types`; `ClaimKind` `types_clean`; a `diagnostics` step | — |
| `node:child_process` | — | `src/lsp.ts` (a JSON-RPC stdio client, ~400 lines) |
| `resolveInside`, `assertWritable`'s name rules, `readInsideNoFollow`, `send-file.ts SECRET_NAME`, the code map's `files()` / `findPath` / `lines`, `ignore.ts` | `isSecretPath` moved to `tools/workspace.ts` and shared | `src/refs.ts` (R1–R3) |
| `web_fetch`'s `assertPublic` / `pinnedGet` / `htmlToText`, `checkOutbound` | `guardedGet` exported and used by both | — |
| `git` with `GIT_SAFE`, `SAFE_REF`, `ProjectFacts.defaultBranch` | — | — |
| `buildHistory`, the owner message `meta`, `pending.ts` items' `meta`, the `/retry` route | `buildHistory` adds the attached block / stubs | `message_refs` |
| `web/app.js` attachment row, `command-bar.js` `fold` / `score` and its listbox pattern, the file viewer, `web/steps.js` | chips for references, the step line's check line, the reply chip | `web/refs.js`, `web/refs.css` |
| CH1 commands (`commandAllowed`, `COMMAND_WORDS`, `/help`), Telegram inline keyboards, Discord components | `/problems`, `/help refs` | — |

Nothing needs an npm package. No new timer (servers stop on an idle check done at the next use and by
the code map's existing light look), no new run kind (checks are steps of the turn's run), no new model
call anywhere in the phase.

---
## 9. Risks

1. **Checkers run project code** (ESLint configs, mypy plugins, cargo build scripts, tsserver plugins),
   and Windows has no sandbox. *Mitigation:* the per-project OK naming exactly which checkers do; network
   off; `classifyCommand`; the Windows wording; *Off* per project and globally. This is the main reason
   the phase isn't "on by default with no question" (§11 Q1).
2. **Slow checks on big projects** (`tsc` on a large monorepo can take a minute; `cargo check` longer).
   *Mitigation:* `waitS` so her next step doesn't wait long, a late result rides the next tool result,
   `timeoutS`, the nearest-tsconfig rule, at most 3 runs a step, the optional language server, and the
   project page showing which checker is slow so he can switch it off.
3. **Noise**: a project with 400 existing errors would drown every edit. *Mitigation:* only new errors in
   touched files are written out, everything else is a count; warnings off by default; the baseline cache.
4. **No baseline** the first time a file is checked, so old errors look like hers. *Mitigation:* the
   first OK and *Run now* run a full check; the line says "no earlier check to compare with"; the nudge
   only fires for errors that are provably new (§4.7), never for unknowns.
5. **The nudge loops or costs too much.** *Mitigation:* ≤ 2 per turn, inside the turn budget, never on
   the last rung, never in goal rounds or loop ticks, a stop phrase, and the result is shown either way.
6. **Language servers misbehave** (memory, crashes, stale results in monorepos). *Mitigation:* opt-in per
   language with TypeScript and Python only by default, ≤ 4 servers, idle stop, two crashes → commands
   only, and every failure falls back to the command check; a server result never blocks a write.
7. **Wrong parse** of a checker's output (a new tsc version changes a line). *Mitigation:* parsers per
   format with recorded fixtures; an exit code ≠ 0 with nothing parsed is *broken* (said plainly), never
   "clean"; the project's exit code is kept on the run.
8. **References leak something.** *Mitigation:* owner-only per message, workspace-only with the
   no-links read, the shared secret list, the redactor, `@url` through the guarded fetch, private
   conversations refusing `@url`, plain text everywhere else; the Done-when list tests each path.
9. **Context bloat from references.** *Mitigation:* per-reference and per-message caps tied to the
   history budget, stubs in older messages, ranges encouraged by the tip and the cut line.
10. **`@` already means people** in groups, Telegram and Discord. *Mitigation:* only `@kind:` forms and
    three bare words are references; group chats of companions don't parse them; Discord mentions are
    read before conversion; bare paths only through the web popup.
11. **Stale references**: he attaches a file, she edits it, the attached text is old. *Mitigation:* the
    block header says "as of when you sent it"; the stub in later messages points her to `read_file`;
    `/retry` reads again.
12. **Old clients** (desktop and phone apps before 2.53). *Mitigation:* references are typed text the
    server expands; checks are text in the tool result and one line in the reply; the card appears as a
    plain notice with no buttons on old clients, and *Off* is on the project page.

---

## 10. The phase at a glance

The release ships its docs in the same commit: a user guide page (`docs/PRECISE.md`: *Check her edits*
and *Attach with @*), the CHATS command table (`/problems`, `/help refs`), `web/help.html`, CHANGELOG,
ROADMAP / ROADMAP.public, i18n in six languages, ? tips, THREAT_MODEL, and the README "What's new" row.

| Phase | Version | Slice | Main new code | Test |
|---|---|---|---|---|
| 120 part A | 2.53.0 | checks after her edits: detection, the per-project OK, the post-call block, baselines and "new", the nudge, time/output caps, the optional LSP client, Windows argv rules, the step line and reply chip, the run step, `types_clean`, `types` for goals, the project page, `/problems` | `diagnostics.ts`, `lsp.ts`, `runProjectCommand`, `project_checks`, `diag_cache`, `diag_runs` | `test/phase120.test.ts` (part A) |
| 120 part B | 2.53.0 | @-references: the grammar, the six kinds, owner-only and workspace rules, secrets, `guardedGet`, read once and stored, the attached block and stubs, caps, the `@` menu and chips, typed in chat apps, `/help refs` | `refs.ts`, `web/refs.js`, `isSecretPath`, `message_refs` | `test/phase120.test.ts` (part B) |

Part B's `@problem` reads part A's cache, so A is built first; otherwise each part can be built and
tested in one helper run. One release, one test file.

---

## 11. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Does each project need an OK before checks run?** Default: **yes, one tap per project** (the card in
   §4.3), because ESLint configs, mypy plugins and Rust build scripts run project code and Windows has no
   sandbox. Alternative: on by default for checkers that run no project code (tsc, pyright, go vet), the
   card only for the others.
2. **The default engine.** Default: **the project's checker command, plus a language server where the
   owner installed one** for TypeScript and Python (`servers`: TS and Python on, Go and Rust off).
   Alternative: commands only in 2.53 and the LSP client in a later release (smaller, slower checks).
3. **"Never install without approval": does Sara ever offer to install a missing checker?** Default:
   **no install button at all in 2.53**; the project page shows the install command as text to copy.
   Alternative: an *Install* button that becomes an ordinary `shell` approval card (`npm i -D typescript`),
   the sandbox gate and advisories included.
4. **The project's own `typecheck` / `lint` scripts.** Default: **shown, not run**; Sara runs the tool
   directly with a known output format (works without a shell on Windows, can be limited to files).
   Alternative: run the script when it is exactly one known tool call (`tsc --noEmit`, `eslint .`).
5. **Rust and Go servers.** Default: **off** (`rust-analyzer` is heavy; `cargo check --offline` and `go
   vet` cover the errors). Alternative: on when found, like TypeScript and Python.
6. **Errors she causes in other files** (a renamed export). Default: **named, up to 3 files with their
   first error**, when the other-files count rose; everything else in other files is a count.
   Alternative: count only (strictly "touched files plus a count").
7. **The nudge.** Default: **up to 2 per turn**, inside the turn budget, only for errors provably new, not
   in goal rounds, loop ticks or when he says "leave the errors". Alternative: 0 (show only, she decides),
   or 1.
8. **Warnings.** Default: **errors only**, warnings counted in one line. Alternative: ESLint and pyright
   warnings written out too.
9. **References in older messages.** Default: **a one-line stub** after a newer referencing message, so
   old files aren't re-sent every step. Alternative: always the full block until history drops it.
10. **More kinds.** Default: **the six in the ROADMAP** (`@diff:staged` and `@branch:<name>` as variants).
    Alternative: add `@git:N` (the last N commits, ≤ 10) and `@commit:<sha>` now, as Hermes has.
11. **`@url` and private network addresses.** Default: **never** for references, even when the owner
    allowed `web_fetch` to reach private addresses (a typed reference shouldn't reach the router's admin
    page by accident). Alternative: follow the `web_fetch` setting.
12. **The VS Code panel.** Default: **unchanged** (it sends the code itself). Alternative: when the panel
    can see the file is inside the conversation's workspace on the same machine, send `@file:path:a-b`
    instead (smaller, and she gets the current file).
13. **Household members.** Default: **no references and no checks** for members (no tools, no
    workspaces). Alternative: `@url` only for members, through the guard, inside their own limits.
14. **A code-intelligence tool for her** (go to definition, references through the language server, as
    Claude Code's LSP tool). Default: **not in 2.53**; the code map's `code_find` / `code_refs` stay her
    tools. Alternative: an `lsp` read-only tool when a server runs.

---

## 12. Key choices in short

- **The project's own checker, run by Sara after her edits, fed back in the same turn**: tsc, pyright or
  mypy, cargo check, go vet, eslint, detected from files that are there, never installed or fetched,
  started as `node <bin>` / the venv's python / `cargo` / `go` so it works the same on Windows and Linux.
  A language server the owner installed makes it faster; it is never required and never breaks a write.
- **One OK per project**, naming which checkers run project code; *Off* per project and globally; on
  Windows the card says it runs directly on this computer.
- **Hers only, bounded**: new errors in the files she touched, written out (≤ 20, ≤ 3,000 characters),
  everything else a count; one check per step and per project; 20 s wait, 60 s limit, 400 kB output;
  at most 2 fix nudges inside the turn budget; whatever is left is on the reply.
- **Built on what's there**: the Phase 118 check runner and refusal table, the tool loop's post-call
  point, turn hooks, the run record, the claim check (`types_clean`) and goals (`types`).
- **@-references are typed text the server reads**, the same in the web app (with an `@` menu,
  autocomplete from the code map and chips) and in Telegram, Discord, Signal, email and plugins: `@file`
  with lines, `@folder`, `@url`, `@diff`, `@branch`, `@problem`.
- **Owner only, workspace only, secrets never, `@url` through the guarded fetch**: plain text for anyone
  else, `@url` refused in private chats and private local mode, read once and stored with the message,
  capped against the history budget, fenced as data.
- **Additive tables only** (`project_checks`, `diag_cache`, `diag_runs`, `message_refs`), zero npm
  runtime dependencies, no model call anywhere in the phase, the mandatory safety layer untouched.

---

## 13. Sources

Public feature pages, read 2026-11-02 (features only; no code, prompt or wording taken):

- [H7] Hermes Agent, *LSP — Semantic Diagnostics* (language servers run as background processes; their
  diagnostics feed the post-write check of `write_file` and `patch`; only inside a git workspace; a
  syntax check first; a short wait, a late verdict attached to the next tool result, up to 5 s before the
  answer is accepted; only the diagnostics the edit introduced; a missing server never breaks a write).
  https://hermes-agent.nousresearch.com/docs/user-guide/features/lsp
- [H8] Hermes Agent, *Context References* (`@file:path[:a-b]`, `@folder:`, `@diff`, `@staged`, `@git:N`
  ≤ 10, `@url:`; CLI completion; soft 25 % / hard 50 % of the context; 200 folder entries; sensitive
  paths blocked; no path traversal).
  https://hermes-agent.nousresearch.com/docs/user-guide/features/context-references
- [C1] Claude Code, *Common workflows: reference files and directories* (`@` includes files or folders).
  https://code.claude.com/docs/en/common-workflows
- [C2] Claude Code, *Use Claude Code in VS Code* (the selection is seen automatically).
  https://code.claude.com/docs/en/vs-code
- [C3] Claude Code, *Code intelligence plugins* (a language server per language through LSP; diagnostics
  after each edit, "Found N new diagnostic issues in M files"; the binary is the user's own install;
  "Executable not found in $PATH" when missing). https://code.claude.com/docs/en/plugins/code-intelligence
- [C4] Claude Code, *Hooks guide* / *Best practices* (`PostToolUse` hooks on `Edit|Write` running a type
  checker such as `tsc --noEmit`). https://code.claude.com/docs/en/hooks-guide ·
  https://code.claude.com/docs/en/best-practices
- [X1] Codex, *Developer commands* (in the CLI, type `@` to search for files to attach).
  https://www.codex-docs.com/en/docs/developer-commands (unverified: search summary only)
- [X2] Codex, *IDE extension* (open files and selections into the prompt).
  https://www.codex-docs.com/en/docs/codex/ide (unverified: search summary only)
- [U1] Cursor, *Prompting agents: @ mentions* (files and folders, terminals, chats, `@Commit (Diff of
  Working State)`, `@Branch (Diff with Main)`, browser). https://cursor.com/docs/agent/prompting
- [U2] Cursor, *JavaScript & TypeScript* (automatic lint resolution through ESLint and other linter
  extensions). https://cursor.com/for/javascript-typescript (unverified: search summary only)
- [U3] Cursor forum, *Iterate on lint errors* (a beta loop over lint errors on agent responses).
  https://forum.cursor.com/t/iterate-on-lint-errors-feature/26304 (unverified: forum, not docs)
- [O6] OpenClaw, *Slash commands* and the docs index (no LSP or `@`-reference feature listed; unverified
  beyond the index). https://docs.openclaw.ai/tools/slash-commands · https://docs.openclaw.ai/llms.txt

Sara code read for §1: `src/tools/builtin.ts` (the file tools, `web_fetch`, `assertPublic`, `pinnedGet`,
`htmlToText`), `src/tools/workspace.ts` (`resolveInside`, `assertWritable`, `displayPath`),
`src/tools/sandbox.ts` (`runCommand`, `RunOptions`, `PRIVATE_LOCAL_ENV`, `windowsShell`, `commandPath`),
`src/tools/registry.ts` (permissions, `unsandboxed`, `ApprovalBroker`), `src/tools/types.ts` (`Tool`,
`ToolContext`), `src/tools/coding.ts` (`git`, `GIT_SAFE`, `SAFE_REF`), `src/tools/send-file.ts`
(`SECRET_NAME`), `src/chat.ts` (`TurnOptions`, `ChatEvent`, `TurnHooks`, `joinHooks`, the tool loop and its
post-call point, `buildHistory`, `TOOL_RESULT_LIMIT`), `src/codemap/` (`index.ts` `CodeMaps.touch`,
`store.ts` `files` / `findPath` / `lines`, `safe-read.ts`, `tools.ts` `CHANGES_FILES`), `src/persist.ts`
(`runCommandCheck`, `refuseCheck`, `scriptLine`, `checkOptions`, `fingerprint`, `persistRefusal`),
`src/goals.ts`, `src/sandbox-run.ts` (`classifyCommand`), `src/projectknow.ts` (`findRepos`, `scanProject`,
`ProjectKnowledgeStore`), `src/routes/coding.ts` (the workspace git and file routes, the code map routes),
`src/server.ts` (the messages route, `docs`, `whileBusy`), `src/pending.ts`, `src/runs.ts` (`rec.tool`),
`src/receipts.ts` (`ClaimKind`), `src/net-guard.ts`, `src/private-local.ts`, `src/store.ts`
(`Conversation.private`), `src/group.ts` (`@Name`), `src/mentions.ts` (the name clash),
`src/bridges/telegram.ts` and `discord.ts` (`@` handling), `web/app.js` (the composer, `send`, the
attachment row), `web/command-bar.js`, `clients/vscode/extension.js` (`editorContext`); docs `ROADMAP.md`
(Phase 120), `design/GAP_REVIEW.md` (#7, #9, G6, G7), `design/PERSIST.md`, `design/RECALL.md`.

## As built (2.53.0)

- §4 checks run through the Phase 118 runner (`persist.ts runProjectCommand`); detection, parsers,
  baselines, the in-turn block, the nudge (≤ 2 per reply), the reply chip, the first-time card,
  `/problems`, the goal check *Types check* and the `types_clean` claim are in. Code: `src/diagnostics.ts`.
- §4.9 the optional language-server engine is **not** in this release (the doc allowed leaving it out).
  The settings page says so; `engine` stays `command`.
- §5 references: the full grammar, all kinds, read once at save time into `message_refs`, stubs for
  older messages, the web @ menu with chips and *What she got*, typed forms in the chat apps (refusals as
  one line before the answer), `/help refs`. Code: `src/refs.ts`, `web/refs.js`.
- One list of secret names (`tools/workspace.ts isSecretPath`) now serves `send_file`, references and
  the file viewer.
- Live run (gemma4:12b, the project's real `tsc`): her edit of `src/cart.ts` added a parameter; the same
  tool result read "Your change broke 1 other file: src/app.ts:8:23 error TS2554: Expected 2 arguments,
  but got 1."; in the same reply she edited `src/app.ts` and the reply chip read *✓ types clean (tsc) ·
  fixed 1*.
