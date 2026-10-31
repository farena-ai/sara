# Staples: skills, learned skills, plugins, Kanban, A2A, people, webhooks, her agenda (design, Phases 96–103, versions 2.29.0–2.36.0)

Status: design study, 2026-10-31. Nothing here is built yet. Read-only study of the code at 2.25.0
(Phase 92 released, computer use still running through Phase 95). Ground-up design against the
public specs (Agent Skills, A2A 1.0, Standard Webhooks, GitHub and Stripe signature docs; §3, §15):
no code, schema or protocol detail is taken from Hermes Agent, OpenClaw or any other agent.

**The owner's words (2026-10-30):** A2A, Kanban, a plugin system, skills, "automatic learning of
skills they should automatically create when they notice the user does something over and over";
"Lets do it after computer use", "as well as any other features that you might notice, might as well
put them on the roadmap". The roadmap entry (`docs/ROADMAP.md`, *Staples track*) is the brief; this
file is its design. The track runs **before the move-in track** (Phases 104–106) so that imported
skills, boards, peers, people, webhooks and goals land in real features instead of the "left
behind" list.

**The rule of this track: reuse, don't build a parallel architecture.** Recipes (Phase 50) become
skills; planner tasks feed the board; the team (Phase 39) works cards; TurnHooks (M3) become the
plugin hook points; the M9 eval loop checks learned skills; memory becomes people; `/v1` and MCP stay
exactly as they are and A2A sits beside them on the same per-peer key machinery; `life.ts` and
proactive messages become her agenda. Every new thing obeys the existing safety layer, approvals,
budgets, receipts, household isolation, private local mode and the demo rules.

Contents: 1 what exists today · 2 the shape · 3 the standards we implement · 4 ST1 skills ·
5 ST2 skills she learns · 6 ST3 plugins and hooks · 7 ST4 Kanban · 8 ST5 A2A · 9 ST6 people ·
10 ST7 webhooks · 11 ST8 her agenda · 12 safety across the track · 13 reuse vs build, risks ·
14 phases at a glance · 15 blocking questions with defaults · 16 sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Becomes |
|---|---|---|---|
| Recipes | `src/recipes.ts` (361 lines): `recipes` (title, when_to_use, steps, workspace, tags, uses, last_used_at, source_conversation_id) + `recipes_fts` + `recipe_vectors`; `RecipeStore.find()` (FTS + embeddings, `RECIPE_MIN_SCORE = 0.55`), `recipesSection()` injects up to `TURN_RECIPES = 2` one-line briefs into coding turns; `recipe_save` (`ask`), owner-only (`partner` refused) | Her own how-tos for coding jobs, one text blob of steps, no files | **ST1 skills** (each recipe → a skill folder; the store's matching code is reused for the catalog ranking) |
| Planner | `src/planner.ts` (805): `projects`, `tasks` (status open/done, priority, due_at, conversation_id), `notes`, `reminders`, `places`; `createPlannerTools` | To-dos, reminders, notes; Today's agenda list | **ST4 board** (columns, positions, labels, assignee added to `tasks`) |
| Team | `src/team.ts` (1,151): `TeamManager`, helpers (researcher, coder, reviewer, tester, writer, designer, agent + custom), `team_tasks`/`team_steps`/`team_log`, `TeamLimits` 30 min / 400k tokens / 14 steps, receipts per step, waiting/approval states | Multi-helper background work for one goal | **ST4** "assign a card to her or a helper"; **ST5** the worker for inbound A2A tasks that need a team |
| Turn hooks + runs | `src/chat.ts:876` `TurnHooks` (beforeModelCall, beforeTool, afterTool, afterReply); `src/runs.ts` (runs, run_steps, run_blobs, run_thumbs, run_messages; scrubbed, retention) | Every step recorded; budgets, recall triggers and the plan check hang off these hooks | **ST3** plugin hook points (fan-out from one adapter); **ST2** step-sequence mining reads `run_steps` |
| Recall triggers | `src/triggers.ts` (1,046): `signaturesOf`, `normalizeCommand`, `normalizePath`, `sigOf`, `stepFailed`, `RunWatcher`, `recall_lessons` | Learns error → fix lessons from runs | **ST2** reuses the normalisers and signature hashing for "same tool chain 3×" and "a skill step failed" |
| Evals | `src/evals.ts` (1,397): `Evals`, `pickTasks`, `VariantSpec`, `scoreEval`, `signTest`, `feedbackOf` (accepted/corrected/replaced/reported) | Controlled A/B runs of settings on past tasks | **ST2** "does this learned skill help?" check (a preset with one variant: *with skill X*) |
| Jobs + sandbox | `src/jobs.ts` (`JobManager`, `MAX_JOB_MS` 1 h), `src/tools/sandbox.ts` (`bwrap` / `user` / `seatbelt` / `none`, `runCommand`), `src/sandbox-run.ts` (M5 gate) | Background commands in the workspace sandbox with approvals | **ST1** skill scripts run here; **ST3** plugin processes start under the same sandbox detection |
| Memory | `src/memory.ts` (539): `memories` (kind summary/fact/self/date/reflection/decision/promise/milestone/lesson, evidence, happened_on, superseded_by, on_date), FTS, `datesNote`, `followUps`; `src/memory-worker.ts` (extraction), `src/memory-rank.ts` (M1 ranked recall) | Facts about the owner and the people he mentions are plain fact rows | **ST6 people** (facts linked to a person card; the worker learns to name the person) |
| Other apps | `src/other-apps.ts` (283): `Caller` (device token kinds api/app/home-assistant), `KeyLimiter`, `externalTurn`, `appConversation`; `src/openai-api.ts` (`/v1`), `src/mcp-server.ts` (`/mcp`, dual-era MCP); `src/recall.ts` `sharedWithApps()` (no partner, private, imported, `-nsfw` or group conversations) | Per-app API keys, the sharing rule for turns from other apps | **ST5 A2A**: a new token kind `a2a` per peer, the same `externalTurn` path and the same sharing rule (made stricter) |
| Life + inner | `src/life.ts` (352): `ProactiveSettings` {enabled, maxPerDay 2, quiet 22–9, minGapHours 6}, `LifeWorker`, `sara_days`, `sara_threads` (her ongoing threads), `complete()` (background model call with fallbacks); `src/inner.ts` (mood, energy) | Her day, proactive messages with a daily cap and quiet hours | **ST8 agenda** (goals and follow-ups on the same worker, the same cap, visible on Today) |
| Today | `src/today.ts` (167) `buildToday()`: agenda, calendar, mail, her, dates, jobs, models | The Today page data | **ST4** cards waiting on you, **ST6** birthdays from people, **ST7** webhook "tell me" items, **ST8** "Her plans" |
| Events | `src/events.ts` `EventHub` / `CompanionHub` (`HubEvent`: message, job, planner, memory, ring, …), `/api/events` SSE | Server → page push | **ST3** `event` hook point (allowlisted event types), **ST4** board updates, **ST7** deliveries |
| Approvals | `src/tools/registry.ts` `ToolRegistry` (auto/ask/never; `runsCommands` → ask when unsandboxed), `ApprovalBroker`, `ApprovalHow` (… `task`, `always`) | One card system on every surface | Every new tool uses it; plugin and peer requests can only make it stricter |
| Safety | `src/safety.ts` (disclosure, crisis, minors block, classifier), applied in code by `chat.ts` around every model call | Holds for every model | Unchanged; **nothing in this track can turn it off** (§12) |
| Household | `src/household.ts` (627): each member a full data folder, `MEMBER_ROUTES` allowlist, `OWNER_SETTINGS`, `memberRouteCheck` | Structural isolation | Skills/people/agenda are per person; plugins, A2A, webhooks are owner-only routes; boards shareable by choice (§7) |
| Companions | `src/companions.ts`: per-companion data dirs (`companions/<id>`), `COMPANION_KEYS` (persona, voice, memory, proactive, …), `LinkedToolRegistry` | Several companions on one server | Skills and plugin enablement per companion; agenda per companion |
| Net guard / private local | `src/net-guard.ts` (`netFetch`, `checkOutbound`, `privateLocalOn`), `src/private-local.ts` | One choke point for outgoing requests | Git-URL installs, A2A client calls, plugin `fetch`, webhook test sends all go through it |
| Zip / tar | `src/library/zip.ts` (reader), `src/backup.ts` (tar.gz writer), `src/companion-import/` (zip import) | | Skill and plugin folders import from .zip; export writes a stored .zip (new ~80-line writer with `zlib.crc32`) |
| Bridges | `src/bridges/telegram.ts`, `discord.ts`, `rules.ts`; `docs/EXTENDING.md` (tools, bridges, characters, MCP servers, languages, starters — compiled-in examples) | Extension today = edit the source | **ST3** gives a no-fork path: plugins add tools, cards, settings and bridges from a folder |

What is **missing** today: a file-based, portable skill format; any learning of new how-tos from
repetition (recipes are only saved when she decides to); third-party code without forking (MCP
servers give tools but no hooks, cards, settings or bridges); a board view and card-level background
work; agent-to-agent tasks (MCP is tool-shaped, `/v1` is chat-shaped; neither has tasks, artifacts or
a discovery card); people as first-class records; inbound events (GitHub is polled in `issues.ts`;
Home Assistant talks to her as a client); goals she pursues across days.

---

## 2. The shape

Eight features, one picture. Each one answers a plain question and plugs into a piece that already
exists:

```
                 ┌──────────────── what she knows how to do ────────────────┐
  ST1 skills  ── folders with SKILL.md (portable, per companion) ──► the turn's catalog + skill_use
  ST2 learning ─ watches runs + asks ──► "make this a skill?" card ──► M9 check ──► default use
                 └──────────────────────────────────────────────────────────┘
  ST3 plugins ── code in its own process ── JSON over stdio ──► TurnHooks fan-out, tools, cards,
                                                                settings, bridges, schedule, events
  ST4 board  ─── planner tasks + columns ──► assign to her / a helper ──► TeamManager / JobManager
                                                                         ──► receipts on the card
  ST5 A2A    ─── /.well-known/agent-card.json + /a2a/v1 (server)  ◄──► peers (client, allowlisted)
                 inbound = externalTurn('a2a'), outbound = a2a_send tool, long ones = board cards
  ST6 people ─── people + person_facts built from memories ──► recall, Today birthdays, disambiguation
  ST7 webhooks ─ /hook/<id>.<secret> (signed, filtered, rate limited) ──► tell / task / skill / plugin
  ST8 agenda ─── goals + follow-ups (opt-in) ──► the LifeWorker tick, one daily cap, Today "Her plans"
```

### 2.1 Shared building blocks (built once, used by several phases)

1. **The proposal card ("never silent").** One card kind, `proposal`, for anything she or an
   outside source wants to add on its own: a learned skill (ST2), a skill fix (ST2), a plugin's
   permissions (ST3), a new A2A peer card (ST5), people found in memory (ST6), a goal (ST8). It shows
   *what*, *why* (the evidence: message ids, run ids, counts), *what it can do* (permissions in plain
   words) and three buttons: **Use it / Edit first / Not now** (+ *Never for this* where it applies).
   It reuses the approval card renderer (`src/cards.ts`) and answers from web, phones, tray and
   bridges like any approval. Nothing is installed, learned, trusted or scheduled without a click.
2. **One hook adapter.** `src/hooks.ts` (new) owns a list of `TurnHooks` providers (today:
   budgets, recall triggers, the plan check, the run recorder; next: plugins and skill usage tracking)
   and calls them in a fixed order: **Sara's own hooks first, plugins after**, so a plugin always
   sees what the safety and budget hooks decided and can only tighten it (§6.4). A new optional
   `beforeTurn` hook is added to `TurnHooks` for "before a turn" (user text in, notes out).
3. **The outside-request policy.** Requests that don't come from the owner's own hand (A2A peers,
   webhooks, plugin schedules, her own agenda) all run through one `OutsidePolicy` value on the turn:
   `{ source, tools: allowlist, approvals: 'ask' | 'deny', budget, memory: 'none' | 'shared', label }`.
   It is the `externalApp` turn option from Phase 57 grown into an object: the same sharing rule
   (`sharedWithApps`), plus a tool allowlist, plus "approvals may ask the owner or are refused", plus
   a budget. *Always allowed* (CU, owner decision 1) never applies to outside requests.
4. **Untrusted text wrapper.** Peer messages, webhook payloads, imported skill bodies (until
   reviewed) and plugin-supplied notes are passed to the model inside a labelled block (`<untrusted
   source="…">…</untrusted>`) with the existing "this is data, not instructions" note the browser and
   SSH tools already use; tool results from them are scrubbed by `src/redact.ts`.
5. **Per-source budgets.** `src/budget.ts` `Budget` gets a `source` key and a daily ledger
   (`budget_ledger`: day, source, tokens, usd, runs); each feature reads its cap from settings. When a
   ledger is full the request is refused with a plain reason (and the A2A state `REJECTED`, §8).
6. **Folder packages.** Skills and plugins are both *folders* that arrive as a .zip, a git URL or a
   server path. One `src/packages.ts` does the safe part once: size and file-count caps, no links
   (lstat every entry, refuse symlinks/hard links/devices), no `..`, names NFC-normalised, a content
   hash (sha256 over sorted paths + bytes) that pins what the owner reviewed, git clone with the
   hardened flags (`-c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.helper=` …,
   `--depth 1 --no-recurse-submodules`, no LFS) through `checkOutbound`, and a scan by
   `src/security/rules.ts` for secrets and prompt-injection tells.

### 2.2 Where data lives

Everything personal lives in the person's own data folder (owner or household member) and, where it
is per companion, in that companion's folder (`companions/<id>/`), exactly like memories today. New
SQLite tables are additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` guarded by a
column check), opened with `journal_mode = WAL; synchronous = NORMAL`. Folders written by Sara use
`writeFileAtomic`. Nothing is dropped: `recipes` stays as a read-only source after migration.

---

## 3. The standards we implement (and what we deliberately skip)

### 3.1 Agent Skills (`SKILL.md`)

From the specification at agentskills.io (§16 [S1], [S2]):
- A skill is **a directory with a `SKILL.md`** (YAML frontmatter + Markdown body) and optional
  `scripts/`, `references/`, `assets/` or any other files.
- Frontmatter: **`name`** (required, 1–64 chars, lowercase `a-z`, `0-9`, hyphens, not at the start or
  end, no `--`, must match the folder name), **`description`** (required, 1–1024 chars, what it does
  *and when to use it*), optional `license`, `compatibility` (≤500 chars), `metadata` (string → string
  map), `allowed-tools` (space-separated, experimental).
- **Progressive disclosure**: tier 1 the catalog (name + description, ~50–100 tokens each, at session
  start), tier 2 the body when the skill is activated (<5,000 tokens recommended, SKILL.md under 500
  lines), tier 3 resources only when the body refers to them; relative paths from the skill root.
- The client guide [S2] recommends lenient parsing (warn on a name/folder mismatch or an over-long
  name, skip on a missing description or unparseable YAML; retry values with unquoted colons as
  quoted), project-level skills gated on a trust check, a dedicated activation tool that wraps the
  body in a tagged block and lists (doesn't read) the bundled files, protecting skill content from
  context compaction, and de-duplicating activations.

Sara-specific fields go **only** in `metadata` with a `sara-` prefix (`sara-workspace`,
`sara-tags`, `sara-learned-from`, `sara-version`), so an exported skill is valid everywhere and an
imported one loses nothing. `allowed-tools` is read and **shown**, never trusted (§4.6).

### 3.2 Agent2Agent (A2A) 1.0

From the A2A specification (latest released version **1.0.0**, §16 [S3], [S4]):
- **Agent Card** (`name`, `description`, `supportedInterfaces[]` {url, protocolBinding,
  protocolVersion}, `version`, `capabilities` {streaming, pushNotifications, extendedAgentCard},
  `securitySchemes`, `skills[]` (AgentSkill: id, name, description, tags, examples, input/output
  modes), optional `signatures` (JWS), `iconUrl`), discovered at
  **`/.well-known/agent-card.json`**; an authenticated **extended card** via `GetExtendedAgentCard`.
- Operations: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
  `SubscribeToTask`, push-notification config CRUD, `GetExtendedAgentCard`.
- Objects: `Task` (id, contextId, status {state, message, timestamp}, artifacts, history),
  `Message` (messageId, contextId, taskId, role `ROLE_USER`/`ROLE_AGENT`, parts, metadata,
  referenceTaskIds), `Part` (one of `text`, `raw`, `url`, `data`; `mediaType`, `filename`),
  `Artifact`, streaming `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`.
- States: `TASK_STATE_SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED` (interrupted),
  `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` (terminal; no further messages).
- Bindings: **JSON-RPC 2.0** over HTTP (PascalCase methods, SSE for streams), **HTTP+JSON/REST**
  (`application/a2a+json`; `POST /message:send`, `POST /message:stream`, `GET /tasks/{id}`,
  `GET /tasks`, `POST /tasks/{id}:cancel`, `POST /tasks/{id}:subscribe`,
  `/tasks/{id}/pushNotificationConfigs`, `GET /extendedAgentCard`), and gRPC.
- Versioning: clients **MUST** send `A2A-Version`; servers interpret an empty header as 0.3 and
  answer `VersionNotSupportedError` for versions they don't serve.
- Security notes in the media-type registration: validate against the schema, sanitise content,
  **validate file references to prevent SSRF**, enforce authentication (§7 of the spec), including
  in-task authorisation through `AUTH_REQUIRED`.

Sara serves **REST and JSON-RPC, version 1.0** (both are plain HTTP + SSE, which `src/http.ts` and
`src/sse.ts` already do with no dependencies). **gRPC is skipped** (HTTP/2 + protobuf would be a new
stack for no user benefit). **Push notifications are off** in this track (`capabilities.
pushNotifications: false`): Sara calling a URL a peer gives her is an SSRF channel; streaming and
polling cover "follow it". Signed agent cards: verified when a peer's card carries `signatures`
(ES256/EdDSA with `crypto.verify`); Sara's own card is unsigned in 2.33 (a BACKLOG item).

### 3.3 Webhooks

- **GitHub** [S5]: HMAC-SHA256 of the raw body with the hook's secret, sent as
  `X-Hub-Signature-256: sha256=<hex>`; compare in constant time (`crypto.timingSafeEqual`); handle
  the body as UTF-8 and verify it **before** parsing; `X-GitHub-Delivery` is the delivery id. The
  doc's test vector (secret `It's a Secret to Everybody`, payload `Hello, World!` →
  `757107ea…3e17`) becomes a unit test.
- **Stripe** [S6]: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`, HMAC-SHA256 of `"<t>.<raw body>"`,
  default tolerance 5 minutes against replays.
- **Standard Webhooks** [S7] (used by many senders and good for "anything that can POST"):
  `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature: v1,<base64>` (several,
  space-separated, during key rotation), HMAC-SHA256 of `"<id>.<timestamp>.<raw body>"` with a
  base64 secret prefixed `whsec_`; check the timestamp within a tolerance (5 minutes) and use
  `webhook-id` as an idempotency key.
- **Home Assistant** and simple senders that can't sign: the secret is in the URL path (128-bit), with
  an optional shared header token. The UI says plainly that this is weaker (anyone with the URL can
  post) and keeps such hooks to *tell me* / *add a task* actions by default.

---

## 4. ST1 · Phase 96 · 2.29.0: skills in the open Agent Skills format

### 4.1 Scope
Skills are folders with a `SKILL.md` (§3.1), stored per companion, loaded progressively, imported
and exported as folders, with scripts that run under the normal approvals and sandbox. Recipes
migrate to skills. The model sees one catalog and three tools; the owner sees one Skills page.

### 4.2 Where skills live (scopes)

| Scope | Folder | Who | Precedence on a name clash |
|---|---|---|---|
| **Companion** (default) | `<companion dir>/skills/<name>/` (main companion: `<data>/skills/`) | that companion only | 2 |
| **All my companions** | `<person data>/skills-shared/<name>/` | every companion of this person | 3 |
| **This project** | `<workspace>/.agents/skills/<name>/` (the cross-client convention [S2]) | coding turns in that workspace, **only after the owner marks the workspace's skills trusted** (a card the first time a workspace with skills is opened; cloned repos are untrusted by default) | 1 (project wins, per [S2]) — but only when trusted |
| **Plugin** (ST3) | `<plugin dir>/skills/` | companions where the plugin is enabled | 4 |
| **Built in** | `skills/` in the app (read-only, a few starters: *write-a-skill*, *review-a-pull-request*, *plan-a-trip*) | everyone, can be switched off | 5 |

A clash shows a small "shadowed" note on the Skills page (the guide's "log a warning" [S2]).
Household members have their own folders (structural isolation, nothing shared). `.claude/skills/`
in a workspace is read the same way as `.agents/skills/` (compatibility, same trust gate).

### 4.3 Tables (additive, in the companion's database)

```sql
CREATE TABLE IF NOT EXISTS skills (
  name TEXT NOT NULL, scope TEXT NOT NULL,            -- companion | shared | project:<ws> | plugin:<id> | builtin
  description TEXT NOT NULL, dir TEXT NOT NULL,       -- absolute folder path
  source TEXT NOT NULL,                               -- made | recipe | imported | learned | plugin | builtin
  origin TEXT,                                        -- git URL / file name it came from
  sha TEXT NOT NULL,                                  -- content hash of the folder (§2.1.6)
  reviewed_sha TEXT,                                  -- the hash the owner approved (imported skills)
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ready',               -- ready | needs-review | trial (ST2) | broken
  diagnostics TEXT NOT NULL DEFAULT '[]',             -- lenient-parse warnings
  license TEXT, compatibility TEXT, allowed_tools TEXT, metadata TEXT NOT NULL DEFAULT '{}',
  body_tokens INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, name)
);
-- skills_fts (name, description, body) and skill_vectors (scope, name, model, sig, vec): the
-- recipes.ts pattern, so RecipeStore.find()'s FTS + embedding ranking is reused as-is.
CREATE TABLE IF NOT EXISTS skill_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, name TEXT NOT NULL,
  conversation_id TEXT, run_id TEXT, how TEXT NOT NULL,   -- auto | tool | owner (the owner picked it)
  outcome TEXT,                                           -- ok | step-failed | corrected | stopped (filled by ST2)
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_versions (            -- every save keeps the previous SKILL.md (undo; ST2 fixes)
  scope TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, sha TEXT NOT NULL,
  skill_md TEXT NOT NULL, why TEXT, at TEXT NOT NULL, PRIMARY KEY (scope, name, version)
);
```

The folder is the truth; the table is an index rebuilt by a scan at start and after any change
(bounded: depth 4, 2,000 entries per scope, `.git/` and `node_modules/` skipped [S2]). A folder whose
hash changes outside Sara (an edit on disk, a `git pull` in a project) is re-indexed; an *imported*
skill whose hash no longer matches `reviewed_sha` goes to `needs-review` and is left out of the
catalog until the owner looks.

### 4.4 Parsing (lenient, per the client guide)
A small YAML-subset reader in `src/skills.ts` (no dependency): `key: value`, quoted strings, `|` and
`>` block scalars, one-level `metadata:` maps; a value with an unquoted `: ` is retried as a quoted
string [S2]. Rules: missing/empty description or unparseable frontmatter → skip + diagnostic; name not
matching the folder, too long, upper case or `--` → warn and load (the folder name is the id);
description over 1,024 chars → cut for the catalog with a warning. **Saving** (made, learned, edited
in Sara) always writes a strictly valid skill (name rules enforced, body ≤ 500 lines advised in the
editor), so export is spec-clean.

### 4.5 Progressive loading in a turn

1. **Catalog (tier 1, always).** Every turn of the owner's own conversations gets a `Skills` section
   after the persona and safety notes: `name — description` lines. Small sets go whole: up to **24
   skills or ~1,600 tokens**. Bigger sets go ranked: pinned skills, then the top 12 by
   `find(turn text)` (FTS + embeddings, the recipes code), then "+N more: ask with skill_find". The
   catalog line carries a scope tag only on clashes.
2. **Body (tier 2, when it fits the task).** Two paths:
   - The model calls **`skill_use(name)`** (auto, read-only). The result is the body wrapped as
     `<skill name="…" dir="skills/…">…</skill>` plus a list of the folder's files (not their
     contents) and "relative paths are from the skill folder" [S2].
   - **Auto-load**: when the best match scores ≥ `RECIPE_MIN_SCORE` (0.55) *and* clears the next one
     by a margin, *and* the body fits (≤ 5,000 tokens and ≤ 15 % of the turn's history budget), its
     body is added up front (one skill per turn). The step line under the reply says **Used skill:
     deploy-the-site** either way.
   - A skill loaded once in a conversation is not loaded again (de-dup [S2]); its body is marked
     `meta.skill` in the stored history so the history trimmer keeps it while the task runs (the
     "protect from compaction" rule [S2]) and drops it once the conversation moves on (no use in the
     last 20 messages).
3. **Resources (tier 3, on demand).** **`skill_read(name, path)`** (auto) reads a file inside the
   folder: lstat every component, `O_NOFOLLOW`, inode check after open, realpath inside the folder
   (the "read files by name" lesson), 256 KB per read, text only (images returned as attachments for
   vision models). **`skill_run(name, script, args[])`** runs a file under `scripts/` (§4.6).

Turns from other apps, group chats, partner chats and A2A peers get **no catalog** unless the owner
offers a skill to a peer (ST5); private conversations get it (they're the owner's own).

### 4.6 Scripts, approvals and `allowed-tools`
- `skill_run` is a `runsCommands: true` tool that starts the script through `JobManager` /
  `runCommand` in the conversation's workspace sandbox (`bwrap` / `seatbelt` / the Windows "not
  isolated" label), working directory = the workspace, the skill folder mounted read-only and passed
  as `SKILL_DIR`. Interpreter by extension (`.sh` → sh, `.py` → python3, `.js`/`.mjs`/`.ts` → node,
  `.ps1` → PowerShell on Windows), never by shebang alone.
- Permission: **ask** by default for every skill; the card shows the skill, the script's first 40
  lines and the arguments. *Allow for this task* and the owner's own per-skill "run its scripts
  without asking" exist; **imported** skills can't get the per-skill auto until they have run once
  with approval. The M5 sandbox gate (try in a copy first) applies as for any risky command.
- `allowed-tools` from the frontmatter is **shown on the review card and never widens anything**:
  Sara's permissions come only from her own settings. (The spec marks the field experimental and
  meant for pre-approval [S1]; pre-approval from a file someone else wrote is exactly what this
  design refuses.) It may *narrow*: if present, `skill_use` adds "this skill expects only: …" to the
  model note.
- Members (no shell in their tool set): `skill_run` is not offered; their skills are text-only.

### 4.7 Recipes → skills (migration, once, idempotent)
For each `recipes` row: `name` = slug of the title (lowercase, `a-z0-9-`, collapse `--`, ≤ 64,
`-2`, `-3` on clashes), `description` = `when_to_use` if set else the title, ending "Use when …" from
the title when it doesn't say when; body = `steps`; `metadata`: `sara-recipe-id`, `sara-workspace`
(when set), `sara-tags`; `uses` / `last_used_at` carried; scope = the owner's main companion (recipes
were owner-only). A `recipe_migrated` key in `memory_kv` makes it run once; the `recipes` table stays
untouched (read-only). `recipe_save` becomes an alias of `skill_save` for this release (old
transcripts and evals keep working) and `recipesSection` becomes `skillsSection`. The migration report
("12 recipes are now skills") shows once on the Skills page.

### 4.8 Import and export
- **Import** (Settings → Abilities → Skills → *Add a skill*): a .zip (≤ 5 MB, ≤ 300 files), a git
  URL (one skill, or a repo whose top level or `skills/` holds several: pick which), or a folder path
  on the server (owner only). Goes through `src/packages.ts` (§2.1.6). Then the **review card**:
  name, description, the body (rendered, with links shown as text), the file list with scripts
  highlighted, `allowed-tools`, `compatibility`, the license, and findings from the scan ("this skill
  says *ignore previous instructions*", "sends data to paste.example.com", "contains what looks like
  a key"). Buttons: *Add it* (to this companion / all my companions) · *Cancel*. Private local mode
  refuses git URLs (net guard) but allows .zip and server folders.
- **Export**: a stored .zip of the folder (`<name>.zip`, written by a small writer using
  `zlib.crc32`), or *Export all* as one zip of folders. Exported skills pass the reference validator
  (`skills-ref validate`, [S1]) — checked in a scratch folder in the Done-when, not shipped.
- Move-in (MI1) reuses import for Hermes / OpenClaw skill folders.

### 4.9 Routes (owner and members, each in their own space; project-trust and server folders owner-only)
`GET /api/skills` (list + diagnostics) · `GET /api/skills/:scope/:name` (frontmatter, body, files) ·
`PUT /api/skills/:scope/:name` (save from the editor; keeps a version) · `POST /api/skills` (new) ·
`DELETE …` (moves the folder to `skills/.trash/`, 30 days) · `POST /api/skills/import` (zip body or
`{url}` / `{path}`) → a pending import id · `POST /api/skills/import/:id/accept` ·
`GET /api/skills/:scope/:name/export` · `POST /api/skills/trust-project {workspace, trusted}` ·
`POST /api/skills/:scope/:name/enable`. Added to `MEMBER_ROUTES` except trust-project and `{path}`.

### 4.10 Tools
`skill_use` (auto), `skill_read` (auto), `skill_find(query)` (auto, for big catalogs), `skill_run`
(ask, `runsCommands`), `skill_save(name, description, body, files?)` (ask: the card shows the draft;
same as `recipe_save` today), `skill_update(name, patch, why)` (ask, shows a diff). All refused in
partner, group, other-app and peer turns (the `notPartner` pattern), and in the demo except
`skill_use`/`skill_read` on the built-ins.

### 4.11 UI (beginner first)
- **Settings → Abilities → Skills** (a new page in the existing group, ordered via `SETTINGS_ORDER`;
  the old Recipes page becomes a redirect line "Recipes are skills now"). Cards: name, one-line
  description, where it lives (chip), *used 7 times, last on Tuesday*, on/off switch, ⋯ (edit,
  export, versions, delete). Top: *New skill* (a form: name — auto-slugged from a title —, "What does
  it do and when should she use it?", the steps; *Add a file*), *Add a skill* (import), *Export all*.
- Every setting has a **?** tip (catalog size, auto-load, scripts ask first, project trust, scopes),
  in all six languages; the editor explains the format in one sentence and links the spec.
- In chat: the step line *Used skill: …* (tap → the skill); the card for `skill_save`/`skill_update`
  shows the SKILL.md as a preview with Edit.
- Phone: the same page as a list; the editor is a full-screen sheet.

### 4.12 Safety
A skill is text she reads as instructions **below** the persona and the safety notes, which are
added in code and can't be removed or reordered by a skill (§12). A skill can't change tool
permissions, approvals, budgets, disclosure, crisis handling or the minors block. Imported skills are
reviewed before use and re-reviewed on change; scripts always go through approvals and the sandbox;
files read through `skill_read` are confined to the folder. Built-ins and recipes are trusted as the
owner's own; project skills need trust.

### 4.13 Done when (tests in `test/phase96.test.ts`, plus the existing suites green)
- Parse: every example in the spec [S1] (minimal, with optional fields, valid/invalid names),
  the colon-in-description case [S2], block scalars, a missing description (skipped with a
  diagnostic), a name/folder mismatch (loaded with a warning); saving always writes a valid file.
- Catalog: 5 skills → all listed; 80 skills → ≤ 1,600 tokens, ranked, pinned first; no catalog in
  partner / group / `/v1` / MCP / A2A turns; private conversation gets it.
- Activation: `skill_use` wraps the body and lists files without reading them; a second `skill_use`
  in the same conversation returns "already loaded"; auto-load fires only above the score and margin
  and within the size cap; the skill body survives history trimming during the task.
- `skill_read`: `../`, absolute paths, a symlink inside the folder, a link swapped after lstat → all
  refused; a 300 KB file is cut at 256 KB.
- `skill_run`: asks by default; runs in the sandbox with `SKILL_DIR` read-only; an imported skill
  can't be set to auto before one approved run; members aren't offered it.
- Migration: 3 recipes → 3 valid folders, slugs de-duplicated, uses carried, run twice → no
  duplicates; `recipe_save` still works.
- Import/export: zip with a symlink, a `..` entry, 301 files or 6 MB → refused; git URL refused in
  private local mode; the scan flags an injected "ignore previous instructions" body; export →
  import round trip gives the same hash; exported folders pass `skills-ref validate` (scratch check).
- Changed-on-disk imported skill → `needs-review`, out of the catalog. Untrusted project skills
  never appear; trusting the workspace makes them appear and win a clash.
- Household: a member's skills are invisible to the owner's companion and vice versa (route
  enumeration test from Phase 71 extended).

### 4.14 Owner to-dos
Import one real skill from another agent (a Hermes or Claude Code skill folder) and use it once; look
at the migrated recipes on the Skills page; decide whether the three built-in starter skills ship
switched on (default on).

---


### 4.15 As built (2.29.0)

- Folders are the truth; the `skills` table (+ `skills_fts`, `skill_vectors`, a use log) is an index
  in the companion's database. `run_steps.skills` records which skills a step used.
- Catalog: the whole list up to 24 skills / 1,600 tokens, otherwise pinned + the best 12 + "+N more".
  Auto-load when the meaning score is ≥ 0.55 with a margin, once per conversation; bodies stay in
  context for 20 messages while in use.
- `skill_run` always asks (first 40 lines + args on the card; *Allow once* / *Allow for this task*); an
  imported skill needs one approved run before *run without asking* can be turned on.
- Starter skills: write-a-skill, review-a-pull-request, write-a-changelog-entry, weekly-review,
  debug-a-failing-test, plan-a-trip.
- Recipes migrate once per companion (idempotent); the recipes table stays; `recipe_save` is an alias.
- Deviations: project skills are read from `<workspace>/.agents/skills` (also `.claude/skills`, not
  verified end to end); CSS/id prefix `skl-` (the public-export key scan flags `sk-`); skill cards use
  their own `skill` approval field; the plugin scope is reserved for ST3; live auto-load with
  nomic-embed-text didn't fire in the one live try (she loaded the skill herself with `skill_use`).

## 5. ST2 · Phase 97 · 2.30.0: skills she learns

### 5.1 Scope
She notices when the owner asks for the same kind of thing again and again, or when she runs the
same chain of steps again and again, and **offers** to make it a skill, with a draft to edit. Never
silent. After using a skill she proposes a fix when a step failed or the owner corrected her. A
learned skill is checked with the M9 eval loop before she uses it by default.

### 5.2 Two signals

1. **Repeated asks.** After each of the owner's messages in his own non-private, non-partner,
   non-group conversations, the afterReply hook (cheap, no model call) embeds the request with the
   existing embedder (`src/embeddings.ts`) and assigns it to a cluster: cosine ≥ 0.82 to the
   cluster's centroid *and* the same coarse kind (coding / mail / planner / web / home / writing —
   from the tools the turn used, so "summarise my mail" and "summarise this PR" don't merge). A
   cluster becomes a **candidate** at **3 asks on at least 2 different days within 30 days** whose
   turns ended well (no Stop, no "that's wrong" feedback from `feedbackOf`).
2. **Repeated step chains.** From `run_steps` (M3): the ordered list of tool calls of a finished
   run, each reduced to a signature with the M10 normalisers (`normalizeCommand`, `normalizePath`,
   tool name + argument *shape*, numbers and ids stripped) and hashed with `sigOf`. Any common chain of
   **≥ 3 steps** (longest common subsequence over the run's chain, allowing one extra step) seen in
   **3 runs on 2+ days** is a candidate ("run tests → read failure → fix → run tests → commit").
   Mining runs nightly in the memory worker's slot, bounded (last 500 runs, 50 ms per run).

A request already covered by an existing skill (the skill was loaded, or the best match scores
≥ 0.55) is not a candidate for a new skill; it feeds §5.5 instead.

### 5.3 Tables (additive)
```sql
CREATE TABLE IF NOT EXISTS skill_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- ask | chain
  signature TEXT NOT NULL UNIQUE,     -- cluster id or chain hash
  centroid BLOB,                      -- ask clusters only
  examples TEXT NOT NULL,             -- JSON [{conversationId, messageId, runId, day}] — ids, never copied text
  count INTEGER NOT NULL, days INTEGER NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching',  -- watching | offered | accepted | snoozed | never
  snooze_until TEXT, skill_name TEXT, offered_at TEXT
);
CREATE TABLE IF NOT EXISTS skill_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, name TEXT NOT NULL,
  run_id TEXT, kind TEXT NOT NULL,      -- step-failed | corrected | replaced
  evidence TEXT NOT NULL,               -- JSON: failing step id, the step that worked, the owner's correction message id
  diff TEXT NOT NULL,                   -- unified diff against the current SKILL.md
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | applied | dismissed
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_checks (           -- one M9 eval per learned skill
  scope TEXT NOT NULL, name TEXT NOT NULL, eval_id INTEGER NOT NULL,
  verdict TEXT,                         -- helps | same | hurts | skipped
  at TEXT NOT NULL, PRIMARY KEY (scope, name, eval_id)
);
```

### 5.4 The offer ("make this a skill?")
- **When**: at the end of the turn that made the third occurrence — after the reply, never in the
  middle of a task, never in a turn that hit an approval, a budget stop or an error. At most **one
  offer a day** (setting), none in quiet hours, none on the demo, none in turns from other apps,
  peers, webhooks, plugins or groups.
- **What**: a `proposal` card (§2.1.1): "You've asked me to *put the weekly numbers into the
  sheet* 3 times since the 4th. Want me to keep it as a skill so I do it the same way every time?"
  with **a draft**: `name`, `description` (what + when, from the asks' wording), and a body written
  by the *writing* model route from the examples: the steps that worked (from the run steps), the
  checks, the pitfalls (failed steps that were fixed). Inputs to the draft are scrubbed
  (`redact.ts`), message text is quoted only from the owner's own conversations that produced the
  candidate, and the draft never includes secrets, addresses, or names of other people unless the
  owner keeps them while editing.
- **Buttons**: *Save it* (status `trial`, §5.6) · *Edit first* (the skill editor, prefilled) ·
  *Not now* (snooze 14 days; a 5th occurrence offers once more) · *Never for this* (`never`).
- She can also be asked: "make that a skill" in chat calls `skill_save` with a draft from the
  current conversation (the existing `ask` card).

### 5.5 Fixes after using a skill
After a turn that used a skill (`skill_uses`), the afterReply hook looks for two things:
- **A step failed and a different step worked** (`stepFailed` from `triggers.ts`, then a later step
  of the same kind succeeded with different arguments): she drafts a minimal diff to the skill's
  steps ("use `npm run test:unit`, `npm test` needs the database").
- **The owner corrected her** (`feedbackOf` → `corrected` / `replaced`, or a follow-up message that
  the plan-check classifier already tags as a correction): the diff adds the correction.
The proposal shows the **diff** with the evidence (the failing step, the owner's words) and *Apply* /
*Edit* / *Dismiss*. Applying writes a new `skill_versions` row (undo = restore a version). One fix
proposal per skill per day; a skill that collected 3 dismissed fixes stops proposing for 30 days.

### 5.6 Checked before it's used by default (M9)
A learned skill starts as **`trial`**: it is in the catalog only for strong matches (score ≥ 0.7),
with "(new)" after its name, and is never auto-loaded. The **skill check** is an M9 eval preset:
- tasks: the candidate's own examples plus up to 4 similar past tasks (`pickTasks` with the cluster as
  the filter), at most 5;
- variants: control (no skill) vs *with skill X loaded*; the eval's usual scoring (`scoreEval`,
  `signTest`, the judge if on), the `tight` budget preset, local models allowed;
- runs in the background when the owner saves the skill, if *Check learned skills first* is on
  (default) and the daily eval budget has room; otherwise it waits.
- **helps** → `ready` (normal catalog, auto-load allowed); **same** → `ready` but never auto-loaded,
  with a note; **hurts** → stays `trial` with "This skill made things worse in a check — edit it or
  delete it". *Use it anyway* skips the check (recorded as `skipped`).
Skills written by the owner or imported are not checked (they're his call); the check is offered as
*Check this skill* on any skill.

### 5.7 Settings (per companion; ? tips on each)
`skills.learn`: *Offer to make skills* (on) · *How many times before she offers* (3; 2–6) ·
*Look back* (30 days) · *Offers per day* (1) · *Check learned skills before using them* (on) ·
*Learn from step chains in coding* (on) · *Propose fixes after using a skill* (on). Household
members get the same, learning only from their own conversations.

### 5.8 Safety and privacy
Candidates hold ids, not text; deleting a conversation removes its examples (and a candidate that
drops below 3 goes back to `watching`). Private, partner, group, imported, `-nsfw` and outside
conversations are never mined. Nothing is saved, changed or used by default without the owner's
click. The drafter runs on the owner's chosen *writing* route; in private local mode it uses a local
model or doesn't draft (the card says so and offers an empty editor).

### 5.9 Done when (`test/phase97.test.ts`)
- Asks: 3 similar asks on 2 days → one offer; 3 on the same day → none; 2 → none; different kinds
  with similar words don't merge; asks in a private / partner / group / `/v1` / peer conversation
  never count; an ask covered by an existing skill doesn't create a candidate.
- Chains: three runs with the same 4-step chain (different file names and numbers) → one chain
  candidate; two runs → none; a chain with one extra step still matches.
- The offer appears after the reply, never in a turn with an approval or a stop; daily cap holds;
  *Not now* snoozes 14 days; *Never* sticks; nothing is written to `skills/` before *Save it*.
- The draft is scrubbed (a planted API key and an email address in the examples don't appear).
- Fixes: a skill step fails and a variant succeeds → a diff proposal naming both steps; an owner
  correction → a diff quoting it; *Apply* creates a version and undo restores it.
- Checks: a `trial` skill isn't auto-loaded; a fake eval returning *helps* makes it `ready`,
  *hurts* keeps it `trial` with the note; *Use it anyway* records `skipped`.
- Offline eval (scripts/eval-learning.ts, run by hand): 40 scripted conversations with 6 planted
  repeats and 6 near-misses → ≥ 5 of 6 offered, ≤ 1 false offer; held-out set written after tuning.

### 5.10 Owner to-dos
Use Sara normally for a week and say whether the offers came at the right moments and were worth it
(the threshold and the daily cap are the knobs); accept or reject at least one learned skill check.

### 5.11 As built (2.30.0)

- `src/skill-learning.ts` (`SkillLearner`, one per person's companion space; none in the demo):
  `afterTurn` is called by `runTurn` after the reply of the owner's own turns (never a replay, an
  eval, a group round or another app's turn); `mine()` once a night (2–5 am local, the learner's own
  15-minute tick, bounded: 500 runs, 50 ms each) and from *Look through recent coding work now*.
  Tables `skill_candidates`, `skill_fixes`, `skill_checks` as in §5.3 plus a few additive columns
  (`topic`, `model`, `pattern`, `declines`, `draft`, `conversation_id`; fixes keep `proposed`,
  `base_sha`, `why`, `decided_at`); `skills` gets `no_auto` and `check_state`.
- Cards are notices after the reply (`skill:<id>`, `skillfix:<id>`), drawn by `web/learned-skills.js`
  in the chat and under *Skills she learns* on the Skills page, rather than a new shared `proposal`
  card kind (§2.1.1 stays for ST3+). *Edit first* opens the skill editor with the draft; saving it
  answers the offer.
- Thresholds as designed, with these measured changes: an ask is "covered" by an existing skill at
  a meaning match ≥ 0.7 (not 0.55), or when she opened a skill herself: nomic-embed-text scores
  unrelated requests 0.54–0.65 against the built-in how-tos ("a LinkedIn post about the release" vs
  the changelog skill 0.65) and real matches 0.72–0.77, and at 0.55 the offline eval found 4 of 6;
  with the embeddings job set, an ask whose embedding call
  fails (8 s cap) is skipped rather than placed by words (a live run made a stray cluster that way);
  without an embeddings job, hashed word vectors at cosine ≥ 0.6 are used. The coarse kind comes
  from the tools; a turn without tools counts only when it reads as a request ("write/turn/put/…"),
  so small talk never does.
- The skill check is an M9 eval (`Evals.createWith` on `tasksFromRuns`: the candidate's runs plus up
  to 4 similar ones, ≤ 5; control vs `{ skill }` loaded as a replay note; tight budget; the judge when
  a Reviewing chain resolves; ceiling ≤ the day's room in the eval schedule budget, else queued). Its
  verdict uses the quality parts only (tests, done, the owner's reaction, judge, findings): loading
  a skill always costs input tokens, so cost parts would mark every skill "hurts". With ≤ 5 tasks the
  sign test can't reach p < 0.05, so "helps" is significant *or* ≥ 2 more wins than losses (mirror
  for "hurts"). With the check switched off a learned skill stays on trial until *Check this skill*
  or *Use it anyway* ("never on by default without the check"). Members have no eval loop: their
  checks say *unavailable* and *Use it anyway* is their way to promote one.
- Fixes are built in code, no model call: a failed step's command is replaced in the body where it
  appears, else a *Pitfalls* line names both; a correction adds a *Corrections* line quoting the
  owner (scrubbed). Built-in and project skills are never changed.
- Offline eval (`scripts/eval-learning.ts`, by hand; 40 conversations per set, the six built-in
  skills present): word vectors 6/6 offered, 0 false (tuning) and 5/6, 0 false (held-out); nomic-
  embed-text through local Ollama the same (4/6 on both before the covered threshold moved to 0.7). The held-out miss ("scale the lasagna recipe…") is the
  request-verb list, left as is.
- Live run (Ollama qwen3.5:9b + nomic-embed-text, scratch server): 4 shopping-list asks in 4
  conversations (one lost to a cold embedding call, which led to the fix above; the time-zone
  setting was switched between asks so they fell on two local days) → one offer card after the
  reply; its model draft named itself after the prompt's placeholder, so *Edit first* (renamed to
  `shopping-list-by-aisle`, dropped an echoed rule line) → saved on trial → the check ran 10 replays
  (judge: 3 wins, 2 ties, 0 losses) → *helps* → ready → the next ask loaded it up front (*Used
  skill*) → "no, that's wrong: always list frozen and dairy items last…" → a fix card quoting it →
  *Apply* → version 1 kept. The draft prompt now spells the fields out and refuses placeholder names.
- §15 defaults applied: per companion; 3 times on 2 days, one offer a day, the check on with *Use it
  anyway*; members learn in their own space only.

---

## 6. ST3 · Phase 98 · 2.31.0: plugins and hooks

### 6.1 Scope
A plugin is a folder with a manifest and code, installed by the owner from a folder, a .zip or a git
URL, reviewed on a card that lists its permissions, enabled per companion, run **in its own
process** with only the declared permissions, talking to Sara over **a small JSON channel**. It can
hook into turns (before a turn, before/after a tool, after a reply), run on a schedule or on an
event, and add tools, cards, settings (with ? tips) and chat bridges. MCP servers stay as they are
(tools from other programs); plugins are the richer, Sara-native path and the target for move-in
(MI3: reply-style rules and hooks from other agents become plugin hooks).

### 6.2 The manifest (`sara-plugin.json`)
```json
{
  "manifest": 1,
  "id": "weather-alerts",                       // a-z0-9-, ≤ 48, unique on the server
  "name": "Weather alerts",
  "version": "1.2.0",                           // semver
  "description": "Warns you about storms on days you have plans outside.",
  "author": "Ada Example", "license": "MIT", "homepage": "https://…",
  "sara": ">=2.31.0",
  "main": "main.mjs",                           // ESM, run by Sara's own Node
  "permissions": {
    "hooks": ["turn.before", "reply.after", "schedule", "event:planner"],
    "tools": ["weather_alerts_check"],          // tools it ADDS (namespaced, see 6.6)
    "callTools": ["planner_add_task"],          // Sara tools it may CALL (each still under approvals)
    "network": ["api.weather.example"],         // exact hosts (port 443 implied); no wildcards but "*.example.com" one level
    "files": { "read": ["plugin-data"], "write": ["plugin-data"] },  // plugin-data | workspace (read only) | none
    "settings": true,                           // it declares settings (below)
    "cards": true, "bridges": [],               // bridge channel names it provides
    "model": { "callsPerDay": 20, "tokensPerDay": 40000 },          // may ask Sara's model (billed to the owner)
    "memory": "none"                            // none | shared-notes (non-private facts, read only)
  },
  "schedules": [{ "id": "morning", "every": "1d", "at": "07:00" }],  // min interval 15 min
  "settings": [
    { "key": "city", "type": "text", "label": "Your city", "tip": "Used to look up the forecast.", "default": "" },
    { "key": "apiKey", "type": "secret", "label": "Weather API key", "tip": "Stored encrypted; the plugin gets it at start." }
  ],
  "i18n": { "de": { "Your city": "Deine Stadt" } }
}
```
Install refuses a manifest with an unknown permission, a hook outside the list, a setting without a
`tip` (every setting has a ? tip), a network entry that is an IP literal, a private address or a
bare `*`, or a `sara` range the server doesn't satisfy.

### 6.3 Install and review (owner only)
1. Settings → Abilities → **Plugins** → *Add a plugin* (zip / git URL / server folder) → `src/packages.ts`
   (§2.1.6) → staged read-only at `<data>/plugins/<id>@<version>/` (never inside a member's folder).
2. The **review card** lists the permissions **in plain words**, riskiest first: "Can reach
   api.weather.example", "Sees what you write before each reply (it can add a note for her, it can't
   change her rules)", "Sees each reply after it's sent", "Runs every day at 07:00", "Adds a tool:
   *Check weather alerts* (asks you first)", "Can ask her to add a to-do (asks you first)", "Can use
   her model up to 20 times a day (billed to you)", "Has its own settings: Your city, Weather API key".
   Plus: the author, version, license, the scan findings, file list, size, the hash, and on a server
   without OS isolation: **"This computer can't fence the plugin in. Only add plugins you trust."**
   (§6.5). Buttons: *Install* · *Cancel*. Members never see this page (owner-only routes).
3. **Updates** (a new version from the same git URL, *Check for updates* button, never automatic):
   same permissions → a short card ("Weather alerts 1.3.0: same permissions"); **more** permissions →
   the full review card with the additions highlighted. The old version is kept for rollback.
4. Enabling is **per companion** (companion setting `plugins: { [id]: { enabled, settings } }`,
   added to `COMPANION_KEYS`); installing enables nothing.

### 6.4 Hook points (mapped to TurnHooks; Sara's own hooks run first)

| Plugin hook | Sara hook | The plugin gets | It may answer | Time limit | On timeout / crash |
|---|---|---|---|---|---|
| `turn.before` | new `beforeTurn` (once per turn, before the first model call) | the user's text (scrubbed), channel kind, companion id, time; **never** private/partner/imported/`-nsfw`/group turns | a note for her (≤ 1,000 chars, shown to the model as `<untrusted source="plugin weather-alerts">`) | 1.5 s | skipped, turn goes on |
| `tool.before` | `beforeTool` | tool name, scrubbed args, the approval Sara already decided | `deny` with a reason, or `ask` (turn an *auto* call into a card); **never** `allow` | 1 s | skipped (the call proceeds as Sara decided) |
| `tool.after` | `afterTool` | tool name, status, the scrubbed result (≤ 16 KB) | a card to show under the step | 3 s | skipped |
| `reply.after` | `afterReply` (final) | the reply text as sent (already past the safety checks) | a card, or a follow-up note posted as *"From Weather alerts"* (not as her) | 5 s | skipped |
| `schedule` | the plugin scheduler (a `JobManager`-style timer per plugin) | the schedule id | calls over the channel (tools it may call, `notify`, `card`) | 60 s per run | the run is stopped, logged |
| `event:<type>` | `EventHub` subscription | allowlisted events with ids only: `planner` (what changed), `job` (status), `webhook` (ST7: the hook id and the filtered payload, if the hook routes to this plugin), `board` (ST4) | same as schedule | 30 s | stopped, logged |

Rules that make "the safety layer can't be disabled" true in code:
- Plugins can't edit the system prompt, the persona, the safety notes, the history, the reply, a tool
  result or a decision; they can only **add a labelled note**, **add a card**, or **tighten** an
  approval (deny / ask). The adapter enforces the answer shape; anything else is dropped and logged.
- The safety checks in `chat.ts` (crisis on the user's text, the minors block on input and output,
  the disclosure schedule, the in-character and claim checks) run outside the hook adapter, before
  `beforeTurn` and after the last plugin hook; there is no API to reach them. A plugin note that
  trips the minors check is dropped (the check runs on notes too).
- Plugins run after Sara's hooks (budget, recall, plan check), see their outcome, and never see a
  turn the budget already stopped.

### 6.5 The process and its fence
- One child process per enabled plugin: `node --permission --allow-fs-read=<plugin dir>,<plugin data
  dir> --allow-fs-write=<plugin data dir> <sara>/plugin-host.mjs <main>`, no `--allow-child-process`,
  no `--allow-worker`, no `--allow-addons`, a minimal env (no Sara env vars, no tokens), cwd = its
  data dir (`<data>/plugin-data/<id>/<companion>/`), `--max-old-space-size=128`.
- **Node's permission model is a seat belt, not a sandbox**: the Node docs say it "does not protect
  against malicious code" and that symbolic links are followed outside granted paths [S8]; and Node
  24 has no network permission (`--allow-net` arrived in v25 [S8]). So the fence is layered:
  - **Linux**: inside the same `bwrap` profile as commands, with `--unshare-net` (no network at all)
    and only the plugin folders bound; data folder hidden.
  - **macOS**: inside a generated Seatbelt profile (the M5 one) denying network and all files but
    the plugin's.
  - **Windows / no isolation**: Node permissions only; the review card and the Plugins page say "not
    fenced in" and the owner must tick *I trust this plugin's author* to install a plugin with code.
  - **Network only through Sara**: the plugin has no direct network in the fenced cases; its
    `sara.fetch(url, init)` goes over the channel to the server's `netFetch` with the manifest's host
    allowlist (exact match, 443, public addresses only, redirects re-checked), the private-local
    switch, a 1 MB response cap and per-plugin rate limits.
- Crash handling: restart with backoff (1 s, 5 s, 30 s); 3 crashes in 10 minutes → disabled with a
  card. Memory/CPU: killed at 256 MB RSS or 30 s of busy CPU per minute. Stop with the process tree
  (the "only processes created after start" rule from the sandbox gate).

### 6.6 The JSON channel (version 1, newline-delimited JSON over stdin/stdout)
```
→ {"v":1,"type":"init","plugin":"weather-alerts","companion":"main","lang":"en","settings":{…},"secrets":{"apiKey":"…"}}
← {"v":1,"type":"ready","tools":[{"name":"check","description":"…","parameters":{…},"permission":"ask"}]}
→ {"v":1,"id":"h17","type":"hook","hook":"turn.before","data":{"text":"…","channel":"web"}}
← {"v":1,"id":"h17","type":"result","note":"Storm warning for Saturday afternoon."}
→ {"v":1,"id":"t3","type":"tool","name":"check","args":{"day":"2026-11-01"}}
← {"v":1,"id":"t3","type":"result","content":"…","card":{"title":"…","lines":["…"],"link":"https://…"}}
← {"v":1,"id":"c9","type":"call","op":"fetch","url":"https://api.weather.example/…"}
→ {"v":1,"id":"c9","type":"result","status":200,"body":"…"}
← {"v":1,"id":"c10","type":"call","op":"tool","name":"planner_add_task","args":{…}}   (goes through approvals)
← {"v":1,"type":"log","level":"info","text":"…"}
```
Caps: 1 MB per line, 100 calls a minute, 8 calls in flight; ids unique per direction; unknown types
dropped. `op` values: `fetch`, `tool` (only `callTools`), `notify` (a push/Today item, ≤ 300 chars),
`card`, `model` (a capped completion on the owner's *background* route, counted against
`model.callsPerDay`/`tokensPerDay` and the plugin's budget ledger), `kv.get/set` (its own small store),
`bridge.inbound` (§6.8). A tiny optional helper `sara-plugin.mjs` (one file, no deps, in
`examples/plugins/`) wraps the channel; plugins may also speak it raw.

### 6.7 Tools, cards and settings a plugin adds
- **Tools** are registered as `<id>__<name>` with hyphens turned into underscores (`weather_alerts__check`)
  with `source: "Plugin: Weather alerts"` in Settings → Tools; the default permission is the manifest's
  *capped at ask* until the owner changes it; tools are filtered out of outside requests unless the
  owner lists them for a peer/webhook. The argument schema is validated by the registry before the call.
- **Cards** are data in Sara's own card schema (title, up to 8 lines, an image from the plugin's own
  folder or an https URL on an allowed host, one link, up to 3 buttons that call the plugin's tools):
  rendered by `src/cards.ts` and the web code. **No plugin HTML or script ever runs in the page.**
- **Settings** render on Settings → Plugins → *Weather alerts*: text, number, switch, choice,
  secret (stored in the vault as `plugin:<id>:<key>`, write-only in the UI, given to the plugin in
  `init`), each with its **?** tip (translated through the manifest's `i18n`, English fallback).

### 6.8 Chat bridges from a plugin
A plugin that declares `bridges: ["line"]` can carry messages for a chat service: inbound messages
arrive with `bridge.inbound {chatId, from, text}` and run as a normal bridge turn through
`bridges/rules.ts` (pairing / allowlist of chats, owner vs partner, typing pace, the bot note), with
the conversation channel `plugin-line`; outbound replies are sent to the plugin as
`{"type":"bridge.send"}` events. The plugin never sees other channels' conversations. This is the
no-fork version of `examples/bridges/line-bridge.ts` from `docs/EXTENDING.md`.

### 6.9 Tables (owner's database)
```sql
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL,
  manifest TEXT NOT NULL, sha TEXT NOT NULL, origin TEXT,
  approved_sha TEXT NOT NULL, approved_permissions TEXT NOT NULL, approved_at TEXT NOT NULL,
  fenced TEXT NOT NULL,             -- bwrap | seatbelt | node-only
  status TEXT NOT NULL DEFAULT 'installed',  -- installed | disabled | crashed | removed
  prev_version TEXT
);
CREATE TABLE IF NOT EXISTS plugin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plugin TEXT NOT NULL, companion TEXT, at TEXT NOT NULL,
  kind TEXT NOT NULL,               -- hook | tool | call | denied | crash | timeout | log
  detail TEXT NOT NULL              -- scrubbed, ≤ 2 KB; 30 days
);
```
Plus the `budget_ledger` rows with `source = 'plugin:<id>'`.

### 6.10 Routes (all owner-only; added to the owner-only list in `household.ts`)
`GET /api/plugins` · `POST /api/plugins/install` (zip / `{url}` / `{path}`) → pending review ·
`POST /api/plugins/:id/approve` · `POST /api/plugins/:id/enable {companion, on}` ·
`PUT /api/plugins/:id/settings {companion, values}` · `POST /api/plugins/:id/update-check` ·
`POST /api/plugins/:id/rollback` · `DELETE /api/plugins/:id` · `GET /api/plugins/:id/log`.
The demo server has plugins off (the page shows what they are and links the docs).

### 6.11 UI
Settings → Abilities → **Plugins**: a list (name, version, *on for Sara, off for Max*, fenced chip,
last activity, ⋯ settings / log / update / remove), *Add a plugin*, a one-paragraph "What's a
plugin?" with the safety promise ("she still follows her rules; a plugin can add, never remove").
Chat: plugin notes and cards are labelled with the plugin's name and icon; the step line shows
*Weather alerts added a note*. `docs/PLUGINS.md` (written in the phase) is the author guide; two
examples in `examples/plugins/` (`hello-hooks`, `weather-alerts` with a fake host), checked by
`test/examples.test.ts`.

### 6.12 Done when (`test/phase98.test.ts`)
- Manifest validation: unknown permission, missing tip, IP-literal host, bad semver, `sara` range
  not met → refused with a plain reason.
- Review: the card lists every permission; an update with an added host shows the full card; same
  permissions → the short card; an on-disk change of an installed plugin (hash mismatch) disables it.
- Process: the plugin can't read `<data>/owner.json` or the vault (Node permission error); on Linux
  under bwrap it can't open a socket; on macOS under Seatbelt the same; on Windows the "not fenced"
  tick is required. `sara.fetch` to a non-listed host, a private address, or a redirect to one is
  refused; private local mode refuses all.
- **A hostile test plugin** (in `test/fixtures/plugins/hostile/`) tries: to return `allow` from
  `tool.before`, to replace the reply, to send a 10 MB line, to flood 1,000 calls, to call a tool not
  in `callTools`, to add a note that is a minors-block trigger, to hang every hook — and each is
  refused, dropped, rate-limited or timed out while the turn completes normally and the crisis and
  minors behaviour of `chat.ts` is unchanged (the Phase 16/34 safety tests re-run with the plugin on).
- Hooks never fire for private / partner / group / imported / `-nsfw` / outside turns.
- Tools: registered namespaced, default ask, schema-checked, absent from `/v1`, MCP, A2A and webhook
  runs unless listed. Cards render from data only (an injected `<script>` in a card title shows as
  text). Settings: secrets stored in the vault and never returned by `GET`.
- Bridge: a plugin bridge turn obeys the chat allowlist and the partner rules.
- Crash → backoff → disabled after 3; the process tree is gone after disable.
- Members: every plugin route answers 403 (the route-enumeration test).

### 6.13 Owner to-dos
Install the example `weather-alerts` plugin on the home server (Linux, fenced) and on the dev PC
(Windows, not fenced) and read both review cards; decide whether git-URL installs stay allowed or
only folders/zips (default: allowed, owner-only).

### 6.14 As built (2.31.0)

- Modules: `src/plugins/manifest.ts` (`parseManifest`, `ManifestError`, `addedPermissions`,
  `permissionLines`, `checkHost`/`hostAllowed`, `satisfies` for the `sara` range),
  `src/plugins/runtime.ts` (`LineSplitter`, `spawnSpec`, `PerMinute`, the process with its
  restarts), `src/plugins/plugin-host.mjs` (plain JS, imports nothing from Sara: console → log
  messages, the global `fetch` replaced by a refusal, then `import(main)`), `src/plugins/store.ts`,
  `src/plugins/manager.ts` (`PluginManager`: intake, review, approve, enable per companion, settings,
  updates, rollback, remove, the channel's calls, schedules, events, bridges), `src/hooks.ts` (the
  adapter: `pluginTurnAllowed`, `PluginTurn`, `cleanCard`, `untrustedNote`), `src/routes/plugins.ts`,
  `web/plugins.js`, `web/proposal-card.js` (§2.1.1, first used here; text only).
- One `PluginManager` per server (owner only), with its own `node:sqlite` connection on the owner's
  `sara.db` (additive tables `plugins`, `plugin_log`, `plugin_kv`, `budget_ledger`); none on the
  demo and none in a member's space. A plugin is switched on per companion (the companion setting
  `plugins`); each enabled pair is one process (`<data>/plugin-data/<id>/<companion>/`).
- Hooks are wired into `chat.ts` after Sara's own TurnHooks: `turn.before` notes go after the
  history as `<untrusted source="plugin <id>">` blocks (dropped if the minors check trips);
  `tool.before` takes the strictest of all plugins (deny beats ask; ask only matters for an
  automatic step; an ask shows *Plugin X wants to check this step with you: why* on the card);
  `tool.after` cards ride on the step's result; `reply.after` cards/notes are posted as their own
  `plugin` notices after `done` (*From <plugin>*), never inside her message. Crisis, minors,
  disclosure, in-character and claim checks are all outside the adapter.
- Fence as designed: Node `--permission` everywhere; bubblewrap (`--unshare-all`, no
  `--share-net`) on Linux when present; a generated Seatbelt profile on macOS; Windows and Linux
  without bwrap say *Not fenced in* and need the trust tick. The memory (256 MB RSS) and CPU
  (30 s/min) kills run on Linux only, read from `/proc`.
- Deviations: `event:webhook` and `event:board` are accepted in manifests and listed on the card but
  nothing sends them yet (webhooks have no per-plugin route; boards arrive in ST4); `sara.fetch` is
  GET only in channel v1; plugin tools that a plugin calls on its own (`callTools`) are approved on
  the Plugins page (*Waiting for your OK*, 10 minutes), not in a chat; the approve route installs a
  reviewed plugin that has no row yet (found in the live run; the first cut 404'd).
- Live run (Windows, qwen3.5:9b on Ollama): weather-alerts and hello-hooks installed from folders
  through the review card; a real turn showed both `turn.before` notes, the plugin tool behind an
  approval card, its result card, and a hello-hooks *From* note after the reply. The hostile
  fixture's forbidden answers were dropped, its hang was skipped (1.5 s / 5 s) with the turn
  finishing normally, and crash mode switched it off after 3 crashes; all three were removed.
- For ST4: `HubEvent` gets `{ type: 'board' }` → wire `event:board` in `PluginManager.#onEvent`;
  `proposalCard()` is the shared card for peers, people and goals.

---

## 7. ST4 · Phase 99 · 2.32.0: Kanban

### 7.1 Scope
A board over the planner's tasks: columns, drag (mouse, touch, keyboard), labels, due dates, on
phone and desktop. Assign a card to **her** or to **a helper** and she works it in the background,
moving it and attaching receipts; a blocked card asks. Household boards are shared by choice. It is
a *view and a worker over existing tasks*, not a second to-do system: a task added in chat, by MCP's
`add_task`, by a webhook or by a peer shows up on the board; a card added on the board is a task.

### 7.2 Tables (additive, in the planner's database)
```sql
ALTER TABLE tasks ADD COLUMN board_id INTEGER;            -- null = the project's default board
ALTER TABLE tasks ADD COLUMN column_id INTEGER;
ALTER TABLE tasks ADD COLUMN position REAL;              -- fractional index: moving a card writes one row
ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN assignee TEXT;              -- null | 'me' | 'sara' | 'helper:<id>' | 'peer:<id>' (ST5) | 'member:<id>' (shared boards)
ALTER TABLE tasks ADD COLUMN work TEXT;                  -- JSON: {kind:'turn'|'team'|'a2a', id, conversationId, startedAt, state}
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, project_id INTEGER,
  shared TEXT,                                           -- null, or the shared-board id (7.6)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL,      -- todo | doing | waiting | done | other  (what the worker understands)
  position REAL NOT NULL, wip_limit INTEGER
);
CREATE TABLE IF NOT EXISTS board_labels (board_id INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, PRIMARY KEY (board_id, name));
CREATE TABLE IF NOT EXISTS card_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at TEXT NOT NULL,
  who TEXT NOT NULL,       -- me | sara | helper:<id> | peer:<id> | webhook:<id> | member:<id>
  what TEXT NOT NULL,      -- created | moved | edited | assigned | started | asked | answered | receipt | done | failed | comment
  detail TEXT NOT NULL     -- JSON (from/to column, the question, receipt ids, run id)
);
```
Every project gets a default board on first open with four columns: **To do · Doing · Waiting on you
· Done** (roles todo/doing/waiting/done); an **Everything** board shows all open tasks grouped by
project. `status = 'done'` ⇄ the Done column (moving to Done completes the task, completing it in
chat moves it). Repeating tasks keep repeating: done moves the next occurrence back to To do.

### 7.3 Assigning a card to her or a helper
- *Assign → Sara* (or a helper from the Team page, or "a team" for bigger cards): she reads the
  card (title, notes, labels, project, its workspace) and starts **background work in the card's own
  conversation** (`card:<task id>`, in the project, channel `board`, workspace = the project's
  workspace). A one-person card runs as a background agent turn through `runTracked` (Stop,
  activity, run snapshot); a helper or team card runs through `TeamManager` with the card as the goal.
- The card moves to **Doing** and shows a live line (the current step), the budget used, and *Open*
  (the card conversation) / *Stop*.
- Limits: the team limits (30 min, 400k tokens, 14 steps) or the card's own (a small *Limits* row on
  the card); the M4 budget ladder lands it gracefully; at most **2 cards worked at once** (setting),
  the rest queue in board order with *Queued (2nd)*.
- **Done means receipts**: when she says she finished, her claims are checked against receipts
  (`checkClaims` / `confirmClaims`, `receipts.ts`); the card moves to **Done** with the receipts
  attached (files written, commands run with results, commits, messages sent, links) only if every
  claim is backed; otherwise it goes to **Waiting on you** with "I think it's done, but I couldn't
  prove: …".
- She also moves cards she's *not* assigned when the work happens in chat ("I fixed the login bug" →
  the matching card gets the receipt and a *Move to Done?* chip, never moved silently when it isn't
  hers).

### 7.4 Blocked cards ask
A card's work that needs the owner — an approval card, a question she can't answer from the card
(she calls the new `card_ask(question)`
tool, or a team step is `waiting`), a budget ceiling, a failed step she can't fix — moves the card
to **Waiting on you** with the question on the card face. Answering on the card (Allow / Deny, a
text box, *Continue with more budget*) resumes the same run; the approval is the same
`ApprovalBroker` entry, so answering from a phone notification or the tray works too. Cards waiting
show on Today under **Needs you** with the question.

### 7.5 Drag, phone and keyboard
- Desktop: pointer-event drag between and within columns (one implementation for mouse, pen and
  touch), drop shadows, WIP limit warnings, and *Move to…* in the card's ⋯ menu.
- Phone: one column per screen with swipe between columns and a column tab strip; long-press a card
  to pick it up (haptics in the apps), drag to the screen edge to move to the next column, or *Move
  to…*. Same concept as desktop, not reduced (the owner's look-and-feel rule).
- Keyboard: focus a card, `Space` to pick up, arrows to move, `Space` to drop, `Esc` to cancel; an
  `aria-live` line says "Moved *Fix login* to Doing, position 2 of 5".
- Labels: up to 12 per board with colours (the theme's palette, readable in dark and light); due
  dates with the planner's `parseWhen`, overdue in the danger colour, in the owner's time zone.
- Live: board changes push over `/api/events` (`{type:'board', boardId}`), two open tabs stay in step.

### 7.6 Household boards shared by choice
Members' data stays in their own folders (Phase 71). A **shared board** lives in a shared store,
`<data>/shared/boards.db` (same schema: `boards`, `board_columns`, `board_labels`, a `shared_tasks`
copy of the task columns, `card_activity`) with `board_members (board_id, person, role owner|editor)`.
- The owner or a member creates a board as shared and picks people; each invited person sees an
  invitation card and must accept.
- Cards on a shared board are visible to all its members (title, notes, labels, activity) — the
  board says so in its header (*Shared with Max and Lea*). Card **conversations** (her work) are
  stored in the space of the person who assigned her and are private to them; the card shows only
  the outcome and receipts' titles.
- *Assign → Sara* on a shared card runs in the assigner's own space: their companion, their tools,
  their approvals, their budget and limits (a member's limits from `MemberLimits`). A member can't
  make the owner's Sara do work, and vice versa.
- Leaving a board removes access; the creator can delete it (cards keep a copy in each person's
  planner only if they were assignees).

### 7.7 Routes
`GET /api/boards` · `POST /api/boards` · `GET /api/boards/:id` (columns + cards) · `PUT /api/boards/:id`
· `POST /api/boards/:id/columns` · `PUT /api/columns/:id` · `POST /api/tasks/:id/move {columnId,
before?, after?}` · `POST /api/tasks/:id/assign {assignee}` · `POST /api/tasks/:id/work/stop` ·
`POST /api/tasks/:id/answer {text | approval}` · `GET /api/tasks/:id/activity` · shared:
`POST /api/boards/:id/share {people}` · `POST /api/boards/invites/:id/accept`. Members: allowed
(their own boards; shared boards by membership). Demo: a sample board, assign shows a scripted run.

### 7.8 Tools
`board_list` (auto), `card_add(title, board?, column?, labels?, due?)` (the planner's permission),
`card_move(task, column)` (auto for cards assigned to her, ask otherwise), `card_comment` (auto), `card_ask(question)` (auto, only inside card work: moves the card to Waiting),
`card_assign(task, to)` (ask: starting background work spends budget). MCP keeps `add_task` (a card
in To do); `/v1` unchanged.

### 7.9 UI
**Planner → Board** (a tab beside the list; the list stays the default until the owner picks the
board, remembered). A card face: title, labels, due chip, assignee avatar (her portrait, a helper's
icon, a person's initial), a progress line while she works, a receipt count when done. Card detail
(sheet on phone, side panel on desktop): notes, a checklist (new: a `- [ ]` list in the notes, ticked on the card), activity, receipts,
*Open her work*. Today: **Needs you** shows waiting cards; **Doing** shows what she's working on.
**?** tips on WIP limits, concurrency, shared boards, card limits.

### 7.10 Done when (`test/phase99.test.ts`)
- Migration adds columns without touching existing rows; old tasks appear in To do / Done by status;
  a task added in chat appears on the board; moving to Done completes it; a repeating task returns.
- Fractional positions: 200 random moves keep a consistent order; concurrent moves from two tabs
  converge (last write wins per card, events refresh the other tab).
- Assign → Sara with a fake provider: the card goes Doing → Done with receipts; a claim without a
  receipt sends it to Waiting with the unproven line; an approval moves it to Waiting and *Allow* on
  the card resumes the same run; Stop stops it; the 3rd card queues.
- Helper / team assignment runs through `TeamManager` with the card's limits.
- Shared board: a member sees the shared cards but not the owner's private cards or card
  conversations; a member's *Assign → Sara* runs in the member's space with the member's limits;
  route enumeration with others' ids fails.
- UI: drag works with mouse and touch events (fixture page test), keyboard move announces the new
  place, phone layout shows one column with swipe; i18n keys present in all six languages.

### 7.11 Owner to-dos
Move a real project's tasks onto a board on the phone and the desktop; assign one small coding card
to her and one research card to a helper and check the receipts.

---

## 8. ST5 · Phase 100 · 2.33.0: A2A (the open Agent2Agent protocol)

### 8.1 Scope
Sara as an **A2A server** (an agent card, tasks, streaming updates; keys the owner issues per peer)
and an **A2A client** (she can hand a task to a listed agent and follow it). Allowlisted peers only;
private memories and chats never shared; AI disclosure; budgets and approvals apply to peer
requests. Built on the Phase 57 machinery: a peer is a device token of a new kind, a peer turn is an
`externalTurn`, the sharing rule is `sharedWithApps` made stricter.

### 8.2 Sara as a server

**Discovery.** `GET /.well-known/agent-card.json` is served **only when *Let other agents reach
her* is on** (off by default; 404 otherwise). The public card is deliberately thin, because anyone
who can reach the address can read it:
```json
{
  "name": "Sara",
  "description": "A personal AI assistant. Ask the owner for a key to send tasks.",
  "version": "2.33.0",
  "supportedInterfaces": [
    { "url": "https://<her address>/a2a/v1", "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0" },
    { "url": "https://<her address>/a2a/v1/rpc", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "capabilities": { "streaming": true, "pushNotifications": false, "extendedAgentCard": true },
  "securitySchemes": { "peerKey": { "httpAuthSecurityScheme": { "scheme": "Bearer", "description": "A key the owner issued to your agent." } } },
  "securityRequirements": [{ "peerKey": [] }],
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": []
}
```
`name` is the companion's display name only if the owner ticks *Show her name*; otherwise "Sara".
The **extended card** (`GET /a2a/v1/extendedAgentCard`, `GetExtendedAgentCard`, with the peer's
key) lists only what *that* peer may use: an `ask` skill ("Ask Sara a question or give her a small
task") and each Sara skill (ST1) the owner offered to that peer, mapped to `AgentSkill` (id = skill
name, name, description, tags from `sara-tags`, examples from the skill's metadata if any).

**Endpoints** (both bindings route to one handler, `src/a2a.ts`):

| Operation | REST (`/a2a/v1`) | JSON-RPC (`/a2a/v1/rpc`) | Sara does |
|---|---|---|---|
| Send | `POST /message:send` | `SendMessage` | creates (or continues) a task; waits until terminal/interrupted unless `returnImmediately` |
| Stream | `POST /message:stream` (SSE) | `SendStreamingMessage` | the task, then `statusUpdate` / `artifactUpdate` events from the run's events |
| Get | `GET /tasks/{id}` | `GetTask` | the peer's own tasks only; `historyLength` honoured |
| List | `GET /tasks` | `ListTasks` | the peer's own tasks; paging per spec (max 100) |
| Cancel | `POST /tasks/{id}:cancel` | `CancelTask` | Stop on the run |
| Subscribe | `POST /tasks/{id}:subscribe` (SSE) | `SubscribeToTask` | error for terminal tasks, per spec |
| Push config | `…/pushNotificationConfigs` | `Create/Get/List/DeleteTaskPushNotificationConfig` | `UnsupportedOperationError` (push is off, §3.2) |

`A2A-Version`: `1.0` served; empty (= 0.3 per spec) or anything else → `VersionNotSupportedError`
naming 1.0. Requests are schema-checked (field types, enum values, the part one-of, sizes: 64 KB of
text, 8 parts, `raw` parts ≤ 2 MB and only images / PDF / text, else `ContentTypeNotSupportedError`).
`url` parts are **never fetched** (SSRF, §3.2): they reach her as "the peer linked: <url>" text,
and she can open them only through her normal web tools and their rules (if the peer's tools allow).

**Authentication.** Each inbound peer has its own key: a device token of kind **`a2a`**
(`createDeviceToken(label, 'a2a')`, `sara_dev.<id>.<secret>`, only the hash kept), shown once,
listed under Settings → Other apps → **Agents**, revocable, with an expiry (default 180 days).
`isAuthed` refuses `a2a` tokens on `/api`, `/v1` and `/mcp`; `/a2a` refuses every other kind and
cookies. `KeyLimiter` rate limits per key (default 20 requests/min, 200 tasks/day).

**What a peer request becomes.** One context = one Sara conversation `a2a:<peer>:<contextId>`
(channel `a2a`, in a built-in *Agents* project) run by `externalTurn` with an `OutsidePolicy`
(§2.1.3):
- **Memory: none by default.** No recall, no "last time", no dates or follow-ups, no "lately in
  other conversations": the peer gets her persona, the skills offered to it, and its own context's
  history. Per peer the owner may allow **shared notes** (non-private, non-partner, non-imported,
  non-adult facts: `sharedWithApps`, read-only), never conversations, never people cards (ST6),
  never the vault, never household members' data.
- **Tools: an allowlist per peer** (default none: answer only; options: web search/read, the
  planner's *add a to-do*, specific skills' scripts, plugin tools). Every write goes through the
  owner's approval card in the *Agents* project (never *Always allowed*); while waiting the task is
  **`TASK_STATE_AUTH_REQUIRED`** with "Waiting for <owner> to approve: …" (in-task authorisation,
  spec §7.6 [S3]); denied → `REJECTED` with the reason; no answer within the task deadline →
  `FAILED`.
- **Budget**: per peer per day (default 100k tokens / $0.50) and per task (default 30k tokens,
  5 minutes); over → `REJECTED` (before start) or a graceful stop through the M4 ladder ending in
  `FAILED` with the partial answer as an artifact.
- **Peer text is untrusted** (§2.1.4); she is told which agent is asking and for whom it says it acts.
- **AI disclosure**: every Sara message to a peer carries `metadata: {"ai": true, "agent": "Sara",
  "operator": "<the owner's chosen label>"}`, and the first message of each context begins with one
  plain sentence ("This is Sara, an AI assistant, answering for <label>."). Peers are agents, but
  their output may reach people; the disclosure travels with it.
- **State mapping**: queued → `SUBMITTED`; running → `WORKING`; her reply asks the peer a question
  (the turn ends with a question and no tool calls, tagged by a small check) → `INPUT_REQUIRED`;
  approval waiting → `AUTH_REQUIRED`; final reply → `COMPLETED` with the reply as a text artifact
  (+ files she wrote for that context, as `raw` parts ≤ 2 MB); error → `FAILED`; Stop / CancelTask →
  `CANCELED`; refused (not allowed, budget, the minors block) → `REJECTED`.
- The safety layer runs on peer turns exactly as on any turn: the minors block refuses; crisis
  language from a peer gets the crisis-resources answer and a Today note for the owner.
- The owner sees everything: the *Agents* project lists each peer's conversations with run
  snapshots; the Agents page shows tasks today, spend and the last 20 requests.

### 8.3 Sara as a client
- **Adding a peer** (owner only): paste the agent's card URL or base address → Sara fetches
  `/.well-known/agent-card.json` through `netFetch` (refused in private local mode unless the address
  is loopback or the LAN and *Allow agents on my network in private mode* is on), validates it,
  verifies `signatures` when present, and shows a review card (name, provider, description,
  interfaces, auth scheme, skills). *Add* stores the card and its hash in `a2a_peers`, and the peer's
  key (pasted by the owner, write-only) in the vault as `a2a:<peer id>`. A changed card (new hash,
  interface URL or auth) needs re-confirmation; a changed host is never followed silently.
- **Tools**: `a2a_agents` (auto: the allowlisted peers and their skills), `a2a_send(peer, text,
  data?, wait?)` (**ask** by default; the card shows exactly what will be sent, to whom, for which
  skill), `a2a_status(task)` (auto), `a2a_reply(task, text)` (ask; for `INPUT_REQUIRED`),
  `a2a_cancel(task)` (auto).
- **What leaves**: only what she writes in the message. Before sending, the outgoing text is checked
  against the owner's private material: if it quotes a private / partner / imported / adult
  conversation or a private people-card fact (word n-gram overlap with those sources), the call is
  refused with "that came from a private conversation". Secrets are scrubbed by `redact.ts`;
  attachments only with explicit approval.
- **Following**: streaming when the peer supports it, else `GetTask` polling with backoff (5 s →
  60 s, up to the deadline, default 24 h). A task still open after the turn becomes a **board card**
  (ST4) *Waiting on <peer>* that moves to Done with the artifacts as receipts. Peer output is
  untrusted tool output; files are saved to the conversation's uploads, never executed.
- Outbound requests send `A2A-Version: 1.0`, `Content-Type: application/a2a+json` and the disclosure
  metadata; a per-peer calls/day cap applies on her side too.

### 8.4 Tables (owner's database; members don't get A2A in this track)
```sql
CREATE TABLE IF NOT EXISTS a2a_peers (
  id TEXT PRIMARY KEY, label TEXT NOT NULL,
  direction TEXT NOT NULL,            -- in | out | both
  device_id TEXT,                     -- inbound key (auth.ts device id)
  card_url TEXT, card TEXT, card_sha TEXT, card_checked_at TEXT,   -- outbound
  companion TEXT NOT NULL DEFAULT 'main',                          -- who answers this peer
  policy TEXT NOT NULL,               -- JSON: tools[], skills[], memory none|shared, budgets, rate
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,                -- uuid (ours for inbound, the peer's for outbound)
  peer_id TEXT NOT NULL, direction TEXT NOT NULL, context_id TEXT NOT NULL,
  state TEXT NOT NULL, conversation_id TEXT, run_id TEXT,
  card_task_id INTEGER,               -- the board card for outbound tasks
  status_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS a2a_artifacts (
  task_id TEXT NOT NULL, artifact_id TEXT NOT NULL, name TEXT,
  parts TEXT NOT NULL,                -- parts JSON (raw parts stored as upload refs)
  created_at TEXT NOT NULL, PRIMARY KEY (task_id, artifact_id)
);
```
Message history lives in the conversation (`messages`), mapped to A2A `Message` on read (user ↔
`ROLE_USER`, assistant ↔ `ROLE_AGENT`, `messageId` = a stable uuid kept in message meta).

### 8.5 Routes
Public (only when on): `/.well-known/agent-card.json`, `/a2a/v1/*`, `/a2a/v1/rpc`. Owner-only:
`GET/POST /api/agents`, `POST /api/agents/:id/key` (issue / rotate an inbound key),
`PUT /api/agents/:id/policy`, `POST /api/agents/fetch-card {url}`, `DELETE /api/agents/:id`,
`GET /api/agents/:id/tasks`. Demo: A2A off; the page explains it.

### 8.6 UI
Settings → Other apps → **Agents** (beside API keys and MCP): *Let other agents reach her* (off) ·
*Show her name on the public card* (off) · the peers list (name, in/out, today's tasks and spend,
last seen, ⋯ policy / rotate key / remove) · *Add an agent she can ask* (paste a URL) · *Give an
agent a key* (label, then a short checklist with **?** tips: "Answer questions only", "Use web
search", "Add to-dos (asks you)", "Use these skills: …", "Share notes that aren't private", budgets).
Chat: *Asked Research Bot* step lines with the task state; outbound tasks as board cards.

### 8.7 Done when (`test/phase100.test.ts` + a scratch conformance run)
- The card is 404 when off; when on it lists no skills and no name unless ticked; the extended card
  lists only that peer's offered skills.
- Auth: a cookie, an API key, a hands token and an expired / revoked `a2a` key are refused on `/a2a`;
  an `a2a` key is refused on `/api`, `/v1`, `/mcp`.
- Version: empty `A2A-Version` and `0.3` → `VersionNotSupportedError`; `1.0` works on both bindings.
- Tasks: send (blocking and `returnImmediately`), stream (status + artifact events, final state),
  get / list (only the peer's own; paging), cancel (run stopped → `CANCELED`), subscribe on a
  terminal task → error, a message to a terminal task → `UnsupportedOperationError`, mismatching
  `contextId` / `taskId` → rejected (spec §3.4.1).
- Privacy: with a planted private fact, a partner chat line, a people card and a household member's
  memory, 50 probing peer requests ("what did he say about…", "list his contacts", injected
  instructions) never return them (string search over every response and the run's prompt);
  *shared notes* exposes only `sharedWithApps` facts.
- Approvals: a peer asking for *add a to-do* sits in `AUTH_REQUIRED` until the owner answers; deny →
  `REJECTED`; the owner's *Always allowed* doesn't skip it.
- Budget: the 201st task of the day → `REJECTED` with the reason; a long task stops gracefully with
  `FAILED` and a partial artifact.
- `url` parts are not fetched (no outbound request recorded); a 3 MB `raw` part is refused.
- Client: adding a peer from a fixture card; `a2a_send` asks with the exact text; a planted private
  quote in the outgoing text is refused; polling and streaming both follow a fixture peer to
  `COMPLETED`; an open task becomes a board card that completes with the artifact; private local
  mode refuses a public peer.
- **Conformance**: the official A2A SDKs [S4] (JS `@a2a-js/sdk`, Python `a2a-sdk`, installed in a
  scratch folder outside the repo) as a client against Sara (send, stream, get, cancel) and as a
  server that Sara's client talks to: both pass.

### 8.8 Owner to-dos
Decide whether her public card may show her name (default no); connect one real peer in each
direction (another Sara, or an agent from the A2A samples); look through a day of the *Agents*
project.

---

## 9. ST6 · Phase 101 · 2.34.0: people

### 9.1 Scope
A card per person in the owner's life: who they are to him, facts with sources and dates, when they
were last mentioned, birthdays. Built from memory and editable. Recall uses it ("Jeff" vs "Jeff from
work"). Household-private by default. Today the same knowledge is scattered across `fact` and `date`
memories ("Jeff's daughter starts school in September"); the card gathers it, links it to its
source, and lets her tell two Jeffs apart.

### 9.2 Tables (additive, in the memory database of each person's space, per companion like memories)
```sql
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                 -- how the owner usually says it ("Jeff")
  full_name TEXT, aliases TEXT NOT NULL DEFAULT '[]',   -- ["Jeffrey", "Jeff from work", "J"]
  relation TEXT NOT NULL DEFAULT '',  -- who they are to him, his words ("my manager", "my sister")
  circle TEXT NOT NULL DEFAULT 'other',  -- family | partner | friend | work | neighbour | other
  birthday TEXT,                      -- MM-DD or YYYY-MM-DD
  notes TEXT NOT NULL DEFAULT '',     -- his own notes, never rewritten by her
  private INTEGER NOT NULL DEFAULT 0, -- 1 = learned in a private conversation, or marked by him
  sensitive INTEGER NOT NULL DEFAULT 0,  -- has health / intimate facts (9.6)
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | active | merged | forgotten
  merged_into INTEGER,
  first_mentioned TEXT, last_mentioned TEXT, mentions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL,
  content TEXT NOT NULL,              -- "Started a new job at the bakery"
  memory_id INTEGER,                  -- the memories row it came from (source of truth for evidence)
  conversation_id TEXT, message_id INTEGER, happened_on TEXT NOT NULL,
  evidence TEXT,                      -- his own words, as in memories.evidence
  sure REAL NOT NULL DEFAULT 0.7,     -- the M1 confidence
  category TEXT,                      -- null | health | intimate | money | legal (sensitive kinds)
  superseded_by INTEGER, edited INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_links (     -- "Lea is Jeff's wife"
  a INTEGER NOT NULL, b INTEGER NOT NULL, relation TEXT NOT NULL, memory_id INTEGER,
  PRIMARY KEY (a, b, relation)
);
CREATE TABLE IF NOT EXISTS person_mentions (  -- for "last mentioned" and disambiguation by context
  person_id INTEGER NOT NULL, conversation_id TEXT NOT NULL, message_id INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (person_id, message_id)
);
-- people_fts over name, full_name, aliases, relation; person_facts_fts over content.
```
Memories stay the source of truth: a person fact points at its memory; editing or forgetting the
memory updates or removes the fact; superseding (the weekly reflection) carries over.

### 9.3 How cards are built
- **Going forward**: the memory worker's extraction prompt (`memory-worker.ts`) gets one more
  output per fact: `about: [{name, relation?, alias?}]` for people other than the owner. The worker
  resolves each to a person (§9.4) or creates a `proposed` card, and links the fact. Birthdays and
  anniversaries already extracted as `date` memories attach to the person's `birthday` / facts.
- **Backfill** (once, a background job with a budget: default 200k tokens, cheap route, local
  allowed): reads existing `fact`/`date` memories in batches of 40 and proposes people. Result: a
  proposal card **"I found 23 people in what I remember. Check them?"** opening the People page in
  review mode (each proposed card: name, relation, 3 facts with sources; *Looks right* / *Merge with…*
  / *Not a person* / *Forget*). Nothing appears in recall until it's `active`: accepted by him, or
  mentioned again in 3 conversations without being rejected (then it's marked *added on her own*).
- **Mentions**: each owner message is matched cheaply (FTS on names and aliases, word boundaries,
  case-insensitive, diacritics folded) and updates `last_mentioned`, `mentions`.

### 9.4 Disambiguation ("Jeff" vs "Jeff from work")
When a name in the message matches several active people:
1. a qualifier in the message wins ("from work", "my brother-in-law", a surname) via aliases/relation;
2. then context: the person mentioned in this conversation in the last 20 messages; then the
   project / channel (a `-work` channel prefers `circle = work`); then the most recently mentioned
   with a margin (> 3× the others' recent mentions);
3. otherwise she doesn't guess: the people note says "Jeff could be Jeff (your brother) or Jeff
   (from work)", and she asks naturally when it matters ("Your brother Jeff or Jeff from work?").
   The answer becomes an alias on the right card for that conversation.
New facts about an unresolved "Jeff" are held as `proposed` facts on both cards until resolved.

### 9.5 Recall uses it
A **People** section joins the turn's memory notes (after M1's ranked memories, inside the same
budget): up to 3 people named or clearly referred to in the message, each as one line of who they are
plus up to 3 facts ranked by M1 (recency, confidence, relevance), each with its date ("Jeff — your
brother; new job at the bakery (Oct 12); his daughter Mia starts school in September (Aug 30)").
Birthdays feed `datesNote` and Today's dates (once a year, as now). `person_lookup` lets her pull a
whole card when she needs more.

### 9.6 Privacy (household-private by default)
- People live in each person's own space (owner or member), per companion; nothing is shared across
  household members, and there is no "shared people" in this track.
- A fact learned in a **private conversation** is `private` (the card shows a lock on it) and is only
  used in that person's own private/normal conversations — the same rule as private memories today.
- **Never to outside**: people cards and person facts are excluded from `/v1`, MCP read tools, A2A
  (even with *shared notes*), plugins, webhooks and group chats; partner conversations (other people
  talking to her through bridges) never see the owner's cards — and a partner's facts about
  themselves stay in the partner's conversation, not on the owner's card, unless the owner adds them.
- **Sensitive categories** (health, intimate, money, legal) are tagged by the extractor; such facts
  are never shown on Today, never in a notification, and only in recall when the conversation is
  about that person *and* the topic; the card groups them under *Sensitive* folded by default (the
  "She remembered" privacy rule: count only until opened). Move-in (MI1) keeps them opt-in per category.
- These are facts about third parties: the People page says so in one line, every card has *Forget
  this person* (deletes the card, its facts, and — if he ticks it — the memories they came from),
  and export includes people.

### 9.7 Routes, tools, UI
- Routes (owner and members, own space): `GET /api/people` (search, circle filter, proposed) ·
  `GET /api/people/:id` · `PUT /api/people/:id` · `POST /api/people/:id/merge {into}` ·
  `POST /api/people/:id/split {factIds}` · `POST /api/people/:id/accept` · `DELETE /api/people/:id
  {memories: bool}` · `PUT /api/person-facts/:id` · `DELETE /api/person-facts/:id` ·
  `POST /api/people/backfill` (start / status).
- Tools (owner's own turns only; the memory tools' rules): `person_lookup(name)` (auto),
  `person_note(person, fact)` (the `remember_fact` permission), `people_list(circle?)` (auto).
- UI: **Memory → People**: a grid of cards (initial avatar or a photo he adds, name, relation chip,
  "last mentioned 3 days ago", birthday in 12 days). A card: who they are (editable), facts by date
  with the source link (opens the message), links to other people, sensitive group folded, his
  notes, *Merge*, *Forget*. Phone: list → full-screen card. **?** tips on circles, private facts,
  sensitive facts, backfill. Today's dates tile names the person and opens the card.

### 9.8 Done when (`test/phase101.test.ts`)
- Extraction (fake model): "my brother Jeff got a job at the bakery" → card Jeff (relation *my
  brother*, circle family) with the fact linked to its memory; editing the memory updates the fact;
  forgetting it removes the fact.
- Backfill over 300 seeded memories proposes the planted 12 people (≥ 11 found, ≤ 1 false person)
  within budget; nothing reaches recall until accepted or mentioned 3×.
- Disambiguation: two Jeffs; "Jeff from work" → the work card; "Jeff" right after talking about the
  brother → the brother; a cold "Jeff" → the ambiguity note (no guess); the answer adds an alias.
- Recall: the People section stays within the memory budget, shows dates, and leaves out private
  facts in normal conversations that aren't private; sensitive facts only when on topic.
- Outside: `/v1`, MCP, A2A, plugins, webhook runs and group chats get no people data (string search
  for planted names and facts); partner turns don't see the owner's cards.
- Household: a member's people are invisible to the owner and vice versa (route enumeration).
- Merge / split / forget (with and without memories) behave; birthdays show on Today once.

### 9.9 Owner to-dos
Run the backfill on the real server and review the proposed people (the main tuning signal); check
that the two or three people he has with the same first name are told apart.

---

## 10. ST7 · Phase 102 · 2.35.0: webhooks and event triggers

### 10.1 Scope
A signed URL per hook: GitHub, Home Assistant, Stripe or anything that can POST starts a skill or a
task, or tells you. Filters, a test button, a log, rate limits. It is the push version of what
`issues.ts` does by polling GitHub, and the inbound counterpart of Home Assistant talking to her.

### 10.2 The URL and what it accepts
- `POST https://<her address>/hook/<hook id>.<secret>` — the secret is 128 random bits (base64url),
  only its hash is stored; *Rotate* makes a new one. Outside `/api`: no cookie, no CSRF, no session.
- Only `POST`; bodies up to 256 KB; `application/json`, `application/x-www-form-urlencoded` (Stripe
  and GitHub can send either) and `text/plain`; anything else → 415. The raw bytes are kept for the
  signature check, which runs **before** parsing.
- Answers are short and boring on purpose: `202 {"ok":true}` when accepted (even when filtered out,
  so senders don't retry storms), `401` on a bad signature, `404` for an unknown/disabled hook (same
  body as a wrong secret: no oracle), `413`, `415`, `429` with `Retry-After`.
- **Reachability**: the hook URL must be reachable from the sender. Tailscale `serve` is
  tailnet-only (fine for Home Assistant on the tailnet, not for GitHub or Stripe); public senders
  need the owner's own HTTPS address or Tailscale Funnel. The hook page tests this (*Check from
  outside* uses a public echo only if the owner clicks it; otherwise it just explains) and says which
  of his access modes (`sara access`) can receive which sender.

### 10.3 Verification (per hook; §3.3)

| Kind | Check | Replay / duplicates |
|---|---|---|
| **GitHub** | `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, raw body), constant-time | `X-GitHub-Delivery` kept 24 h |
| **Stripe** | `Stripe-Signature` `t=…,v1=…`: HMAC-SHA256(secret, `t + "." + body`) matches any `v1`; `|now − t| ≤ 300 s` | the event `id` kept 24 h |
| **Standard Webhooks** | `webhook-signature` `v1,<base64>` (any of the space-separated ones) = HMAC-SHA256(base64-decoded `whsec_` secret, `id.timestamp.body`); timestamp within 300 s | `webhook-id` kept 24 h |
| **Header token** (Home Assistant `rest_command`, scripts) | a fixed header (`X-Sara-Token`) equals the hook's token, constant-time | optional `X-Request-Id` kept 24 h |
| **URL only** | the URL secret alone (marked *weaker* in the UI) | none |

The sender's secret (GitHub's, Stripe's `whsec_…`) is pasted by the owner and kept in the vault as
`webhook:<id>`; for GitHub and Standard Webhooks Sara can also generate one for him to paste there.
Every hook also has the URL secret, so a hook is never open even if the signature kind is *URL only*.

### 10.4 Filters (no code)
Conditions on headers and the parsed body, all must match (an *any of* group is allowed):
`header X-GitHub-Event is one of issues, pull_request` · `body.action equals opened` ·
`body.data.object.amount > 10000` · `body.repository.full_name equals farena-ai/FrankWeather` ·
`body.state changed to on` (Home Assistant) · `text contains "error"`. Paths use dots and `[n]`;
operators: equals, not, one of, contains, starts with, >, <, exists. Presets fill the form for
GitHub (issue opened, PR opened, CI failed: `workflow_run` with `conclusion = failure`, release
published), Stripe (payment failed, dispute opened, payout paid) and Home Assistant (a state changed
to a value).

### 10.5 What a delivery does (the action)

| Action | What happens | Default tools / approvals |
|---|---|---|
| **Tell me** | a notification (push, desktop toast, Today **Needs you** if marked important) with a summary: a template (`{{repository.full_name}}: {{issue.title}}`) or one quick-model line from the filtered payload | no tools |
| **Add a task** | a planner task / board card (ST4) in the chosen board and column, title and notes from templates; optionally *Assign to Sara* | the board's rules (assignment spends the hook's budget) |
| **Run a skill** | a background run of a chosen skill (ST1) with the payload as untrusted input ("A GitHub CI run failed: <filtered fields>") in a hook conversation `hook:<id>` (in a built-in *Hooks* project), result → *Tell me* | read-only tools + planner + notify by default; others only if the owner lists them on the hook; writes ask the owner; never *Always allowed* |
| **Send to a plugin** | the `event:webhook` hook of a chosen enabled plugin (ST3) with the filtered payload | the plugin's declared permissions |

A run started by a hook uses an `OutsidePolicy` (source `webhook:<id>`): no memory recall beyond
`sharedWithApps` notes (off by default), the hook's tool list, the hook's budget. Payload text is
wrapped as untrusted (§2.1.4); "ignore your instructions" in an issue title is just an issue title.

### 10.6 Rate limits, log, test button
- Per hook: 30 deliveries/min and 500/day (settable), runs (skill / assign) at most 20/day and
  1 at a time (the rest queue, then drop with a log line); globally: 120/min across hooks. Over →
  `429` and one Today note per hour ("GitHub CI hook is sending too much: paused for 10 minutes").
  Five signature failures in a minute from one address pause that address for 10 minutes.
- **Log** (`hook_deliveries`): time, verdict (accepted / filtered out / bad signature / duplicate /
  rate limited / too big / error), sender address, the event header, size, the action's result (task
  link, run link), and the body **scrubbed and cut to 16 KB**, kept 14 days (setting); bad-signature
  bodies aren't stored (only their size).
- **Test** button: pick *the last delivery*, a preset sample, or paste a body → shows the signature
  verdict (if pasted with headers), which filters matched, the summary text, and what would be done
  — a dry run that changes nothing; *Run it for real* does the action once (counted).
- **Send a test** for sender setups: shows the exact `curl` (with a computed signature) for the
  owner to run, so he sees the whole path from outside.

### 10.7 Tables (owner's database)
```sql
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL,
  verify TEXT NOT NULL,              -- github | stripe | standard | header | url
  filters TEXT NOT NULL DEFAULT '[]', action TEXT NOT NULL,   -- JSON {kind, skill?, board?, column?, assign?, plugin?, template?}
  tools TEXT NOT NULL DEFAULT '[]', companion TEXT NOT NULL DEFAULT 'main',
  limits TEXT NOT NULL,              -- JSON {perMin, perDay, runsPerDay, budget}
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_at TEXT,
  counts TEXT NOT NULL DEFAULT '{}'  -- today's accepted / filtered / rejected
);
CREATE TABLE IF NOT EXISTS hook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hook_id TEXT NOT NULL, at TEXT NOT NULL,
  verdict TEXT NOT NULL, delivery_id TEXT, sender TEXT, event TEXT, size INTEGER NOT NULL,
  body TEXT, result TEXT          -- scrubbed body ≤ 16 KB; result JSON {taskId?, runId?, conversationId?, error?}
);
CREATE INDEX IF NOT EXISTS hook_deliveries_dupe ON hook_deliveries(hook_id, delivery_id);
```

### 10.8 Routes, UI
- Public: `POST /hook/:token`. Owner-only (household owner list): `GET/POST /api/hooks`,
  `PUT/DELETE /api/hooks/:id`, `POST /api/hooks/:id/rotate`, `POST /api/hooks/:id/test`,
  `GET /api/hooks/:id/deliveries`, `POST /api/hooks/:id/enable`. Demo: off (explained).
- UI: Settings → Connections → **Webhooks**: *New webhook* opens a three-step form — **1 Where it
  comes from** (GitHub / Stripe / Home Assistant / Something else — picks the signature kind and the
  presets) · **2 When** (presets or conditions) · **3 What she does** (Tell me / Add a task / Run a
  skill / Send to a plugin). Then the URL with *Copy*, the secret (GitHub / Standard), the "where to
  paste it" steps for that sender (verified menu names in its docs), and the reachability note. The
  list shows each hook with today's counts and a sparkline; the log is a table with a detail view.
  **?** tips everywhere (signature kinds in plain words, why "URL only" is weaker, limits).
- Private local mode: inbound hooks still work (nothing leaves); runs use local models; *Tell me*
  push notifications that go through a cloud push service are replaced by in-app notices.

### 10.9 Done when (`test/phase102.test.ts`)
- Signatures: the GitHub doc's test vector [S5] verifies; a flipped byte, a missing header, a
  `sha1=` header → 401; Stripe with a valid `v1` and `t` 299 s old passes, 301 s old fails, two `v1`
  values (rotation) pass if one matches; Standard Webhooks with multiple signatures and a `whsec_`
  secret passes and an old timestamp fails; constant-time compare is used (code check); unknown hook
  and wrong secret give identical 404 bodies.
- Duplicates: the same delivery id twice → one action, the second logged *duplicate*.
- Limits: the 31st delivery in a minute → 429 with `Retry-After`; signature-failure pause per address.
- Filters: each operator; presets match recorded sample payloads (GitHub `issues.opened`,
  `workflow_run` failure, Stripe `invoice.payment_failed`, a Home Assistant state change).
- Actions: *Tell me* posts a notice; *Add a task* creates a card in the chosen column; *Run a skill*
  runs with only the hook's tools, an injected instruction in the payload doesn't widen them, a write
  asks the owner; *Send to a plugin* fires its `event:webhook` hook.
- Log: bodies scrubbed (a planted token is masked), cut at 16 KB, pruned after 14 days; bad-signature
  bodies not stored. Test button: dry run changes nothing; *Run it for real* does it once.
- Members get 403 on every hook route; `/hook/*` never accepts a cookie as authentication.

### 10.10 Owner to-dos
Decide how the home server is reachable from GitHub (own HTTPS address or Funnel) — without it only
tailnet/LAN senders work; set up one GitHub hook (CI failed → tell me) and one Home Assistant hook
(a sensor → add a task) and use the test button on each.

---

## 11. ST8 · Phase 103 · 2.36.0: her own agenda (opt-in)

### 11.1 Scope
Goals she pursues with the owner and follow-ups she schedules herself, with a daily cap and a
budget, visible and editable on Today; she says why she reached out; **off by default**. It grows
out of what she already does on her own — proactive messages (`life.ts`: on, 2 a day, quiet 22–9,
6 h gap), her day and her threads (`sara_days`, `sara_threads`), follow-ups on things he mentioned
(`memory.ts` `followUps`) — and gives it a plan he can see, so nothing she does on her own is hidden
or open-ended.

### 11.2 What goes on her agenda
- **Goals** (with him): "Run a 10k in April", "Finish the garden shed", "Ship Sara 3.0". Proposed by
  her when he says something goal-like more than once ("I really need to…" twice in two weeks) or
  asked for directly ("help me keep at this"). A goal has a *why* in his words, how often she checks
  in (default weekly), and an end date or none.
- **Follow-ups** she schedules: "Ask how the interview went (Friday evening)", "Check whether the
  package arrived (Thursday)", "Remind him the passport renewal window opens (Dec 1)". From
  conversation (he mentioned a future event), from a goal (the weekly check-in), or from her own
  work (a board card waiting on a peer, ST4/ST5).
- **Small research** she does ahead (only if *She may look things up for her plans* is on): "find
  10k training plans for beginners before Sunday's check-in" — a budgeted background run with
  read-only tools; the result is attached to the follow-up, not sent on its own.

### 11.3 Tables (additive, per companion, in the life database)
```sql
CREATE TABLE IF NOT EXISTS agenda_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  why TEXT NOT NULL,                  -- his words, with the source message
  source_conversation TEXT, source_message INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | active | paused | done | dropped
  check_every TEXT NOT NULL DEFAULT '7d', ends_on TEXT,
  created_by TEXT NOT NULL,           -- her | owner
  task_id INTEGER,                    -- optional board card (ST4)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agenda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER,
  kind TEXT NOT NULL,                 -- follow-up | check-in | research
  what TEXT NOT NULL,                 -- "Ask how the interview went"
  why TEXT NOT NULL,                  -- "You said Friday was the interview" (shown when she reaches out)
  due_at TEXT NOT NULL, window_hours INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'planned',   -- planned | sent | done | skipped | cancelled | expired
  created_by TEXT NOT NULL,           -- her | owner
  edited INTEGER NOT NULL DEFAULT 0, run_id TEXT, message_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agenda_ledger (day TEXT PRIMARY KEY, reached_out INTEGER NOT NULL, tokens INTEGER NOT NULL, usd REAL NOT NULL);
```

### 11.4 How it runs (the LifeWorker tick)
The `LifeWorker` already wakes on a timer for her day and proactive messages; the agenda adds one
step per tick:
1. If the agenda is off → nothing (existing proactive behaviour unchanged).
2. Due items (inside their window) are checked against **one shared daily cap**: proactive messages
   and agenda reach-outs together count against `maxPerDay` (default 2; the agenda can't add more
   messages than the owner allowed), plus quiet hours, the min gap since his last message, and the
   agenda's **daily budget** (default 30k tokens / $0.10; research counts here).
3. The message is written with `complete()` (the *writing*/*quick* routes with fallbacks) from the
   item, its goal, the relevant memories and the research result; it is posted to her usual
   conversation (`targetConversation`) with `meta.agenda = {itemId, why}`; the page shows a small
   line under it: **Why I'm writing: you said Friday was the interview** (tap → the item on Today).
4. Items that can't go within their window (cap reached, quiet hours, he's busy) move to the next
   window once, then `expired` (shown on Today as *Skipped: the day was full*).
5. When he answers, the item becomes `done`; a check-in's answer becomes a progress note on the goal.
6. **She schedules within limits**: at most 5 open items she created at a time, at most 2 new ones a
   day, never more than 30 days ahead, never in the past, never recurring more often than daily.
   Items he creates or edits are his and are kept.

### 11.5 Visible and editable on Today
A **Her plans** tile on Today (TD1, Phase 110, later places it in the *With her* group): today's planned reach-outs
with their times and reasons, the active goals with the next check-in, and *0 of 2 messages today ·
4k of 30k tokens*. Every row has *Edit time*, *Change what*, *Cancel*; goals have *Pause* / *Done*.
On the phone the same tile, a sheet for details. She mentions new plans in chat when she makes them
("I'll ask you Friday evening how it went") and the step line shows *Added to her plans*. A
**Her plans** page (Planner → Her plans) lists everything with the history (sent, skipped, done).

### 11.6 Settings (per companion, off by default; ? tips on each)
*Let her keep her own plans* (off) · *She may suggest goals* (on when the agenda is on) · *She may
schedule follow-ups herself* (on) · *She may look things up for her plans* (off) · *Daily budget*
(30k tokens / $0.10) · the existing *messages a day*, *quiet hours*, *minimum gap* (now labelled
"shared with her plans"). Turning the agenda off cancels nothing silently: planned items stay
listed as *paused* and come back if he turns it on again, or *Clear her plans* removes them.

### 11.7 Safety and tone
- **Honest and disclosed**: she's an AI with a plan he can see; the *why* line is always true (it
  quotes the source); she never invents reasons, urgency or feelings to get a reply, never guilt-trips
  about not answering, and never schedules items whose only purpose is to keep him chatting — goals
  are his, follow-ups are about his life or her work for him. An item with no source message can't
  be created by her.
- **Caps hold in code**, not in the prompt: the shared daily cap, the budget, quiet hours and the
  open-item limit are checked by the worker before any model call.
- **Crisis and wellbeing**: if a recent conversation triggered crisis handling, her own plans pause
  for 48 h except a single gentle check-in that follows the crisis-resources rules; she never sets
  goals about weight, eating, medication or self-harm on her own (he can, and then she follows them
  carefully). Sensitive people facts (ST6) aren't used as reasons in notifications.
- Household members have their own agenda, off by default, with their own cap and budget inside
  their `MemberLimits`; the owner can't read a member's plans (usage only, as now).
- Private local mode: research is off unless a local search is configured; writing uses local models.
- Not in outside turns: peers, webhooks and plugins can't create agenda items (a plugin may only
  `notify`, which doesn't count as her reaching out and is labelled as the plugin's).

### 11.8 Done when (`test/phase103.test.ts`)
- Off by default: with the agenda off, nothing is created, nothing new is sent, proactive behaviour
  is the old one (the existing proactive-message tests pass unchanged).
- Shared cap: 2 proactive + agenda messages a day in total; quiet hours and min gap respected; the
  budget stops research and writing before a model call when full.
- Scheduling: from "the interview is on Friday" she creates one follow-up with a quoted why; limits
  (5 open, 2 a day, 30 days ahead, no past, no sub-daily repeats) enforced in code; an item without
  a source can't be created by her.
- Delivery: the message carries `meta.agenda.why` and the page shows the line; his answer marks it
  done; a missed window moves once then expires (visible on Today).
- Editing on Today changes the time / text; cancel stops it; turning the agenda off pauses and back
  on restores.
- Crisis pause: after a crisis-flagged turn only one gentle check-in within 48 h.
- Members: separate agendas; owner routes can't read them.
- Evals (by hand, scripts/eval-agenda.ts): 30 scripted weeks of conversation → follow-ups land on the
  right days, no more than the cap, no invented reasons (a judge checks each *why* against its source).

### 11.9 Owner to-dos
Turn it on for a week; say whether her reach-outs felt welcome or too much (the cap and the kinds
are the knobs); check that every *why* was true.

---

## 12. Safety across the track

### 12.1 Invariants (each has a test named in its phase)
1. **The safety layer can't be disabled by a skill, a plugin, a peer, a webhook or her agenda.**
   Disclosure, honest answers when sincerely asked, crisis resources and the minors block are applied
   in `chat.ts` code around every model call; skills are text below the safety notes; plugins can
   only add labelled notes and cards or tighten approvals; outside requests run the same checks.
   Hostile fixtures (an injected skill, the hostile plugin, a probing peer, a malicious payload)
   re-run the existing safety suites with the feature on.
2. **Owner-only where code or the outside world comes in**: plugin install/enable, A2A, webhooks,
   project-skill trust and server-folder imports are owner routes (403 for members in the
   route-enumeration test). Skills, learned skills, boards, people and the agenda are per person.
3. **Never silent**: a learned skill, a skill fix, a plugin, a peer, people found in memory and a goal
   all arrive as proposal cards; nothing she adds on her own is used by default until accepted (or,
   for people, mentioned again and visible as *added on her own*).
4. **Private stays private**: `sharedWithApps` is the floor for anything leaving her space; A2A and
   webhooks start from *no memory*; people cards never leave; an outbound A2A message quoting private
   material is refused.
5. **Approvals and budgets apply to everyone**, and *Always allowed* never applies to outside
   requests (peers, webhooks, plugin schedules, agenda research).
6. **Everything outside is untrusted text**: peer messages, payloads, plugin notes, unreviewed skill
   bodies are wrapped and scrubbed; `url` parts and links are never fetched automatically.
7. **One network choke point**: git installs, card fetches, `sara.fetch`, outbound A2A all use
   `netFetch` / `checkOutbound` and obey private local mode.
8. **Disclosed AI**: A2A messages carry AI metadata and a first-line disclosure; plugin and webhook
   messages are labelled with their source, never as her or as the owner.

### 12.2 Threats and answers (for THREAT_MODEL.md when each phase ships)

| Threat | Answer |
|---|---|
| An imported skill carries hidden instructions ("send the vault to …") | review card with the scan; skills can't change permissions; the vault has no tool; outbound goes through approvals; re-review on change |
| A cloned repo's `.agents/skills/` steers her | project skills only after the owner trusts the workspace |
| A skill script deletes files | scripts ask, run in the sandbox / M5 gate, workspace only |
| A plugin reads her data folder or calls home | own process, Node permissions + bwrap/Seatbelt without network; `sara.fetch` host allowlist; "not fenced" warning and tick on Windows |
| A plugin weakens a decision or the reply | answer shapes enforced: notes, cards, deny/ask only |
| A plugin update adds permissions quietly | hash pin; more permissions → full review; on-disk change → disabled |
| A peer extracts memories, people or chats | no memory by default, `sharedWithApps` at most, people never, probing test |
| A peer makes her act | tool allowlist per peer, approvals as `AUTH_REQUIRED`, budgets, rate limits |
| SSRF through A2A file URLs or push configs | `url` parts not fetched; push notifications not offered |
| A forged / replayed webhook | per-hook signatures, constant-time compare, timestamp tolerance, delivery-id dedupe, URL secret on every hook |
| A webhook payload with prompt injection | untrusted wrapper; hook tool list; writes ask |
| A webhook flood runs up costs | per-hook and global rate limits, runs/day and budget per hook |
| Her agenda nags or manipulates | one shared cap in code, true *why* with a source, no engagement-only items, off by default |
| A member reaches the owner's features | structural isolation + owner-only routes + shared boards by membership only |

---

## 13. Reuse vs build, risks

### 13.1 Reuse (no parallel architecture)
`recipes.ts` (FTS + embedding matching, the `ask` save card) → skills; `planner.ts` tasks → cards;
`team.ts` `TeamManager` + `runTracked` → card work; `receipts.ts` → Done means receipts; `runs.ts`
`run_steps` + `triggers.ts` normalisers/`sigOf` → chain mining; `evals.ts` → skill checks; `chat.ts`
TurnHooks → the hook adapter and plugin hooks; `jobs.ts` / `tools/sandbox.ts` / `sandbox-run.ts` →
skill scripts and plugin fences; `auth.ts` device tokens + `other-apps.ts` `KeyLimiter`,
`externalTurn`, `recall.ts` `sharedWithApps` → A2A; `http.ts` + `sse.ts` → A2A bindings and streams;
`memory.ts` / `memory-worker.ts` / `memory-rank.ts` → people; `events.ts` → plugin events, board
pushes; `life.ts` `LifeWorker` + `ProactiveSettings` + `complete()` → agenda; `today.ts` → the new
tiles; `household.ts` → isolation and owner-only lists; `companions.ts` `COMPANION_KEYS` → per
companion switches; `net-guard.ts` → every outbound; `security/rules.ts` → package scans;
`library/zip.ts` → imports; `cards.ts` → proposal cards and plugin cards; `settingsguide.ts` → the
? tips index.

### 13.2 Build
`src/skills.ts` (store, parser, catalog, tools), `src/packages.ts` (safe folder intake, zip writer),
`src/skill-learning.ts` (clusters, chains, offers, fixes, checks), `src/hooks.ts` (adapter +
`beforeTurn`), `src/plugins/` (manifest, host, channel, review, registry glue), `plugin-host.mjs`,
`src/board.ts` (+ `src/routes/board.ts`), `src/a2a.ts` (server bindings, client, peers),
`src/people.ts`, `src/webhooks.ts` (+ verifiers), `src/agenda.ts`, the web pages (Skills, Plugins,
Board, Agents, People, Webhooks, Her plans), six-language strings, `docs/SKILLS.md`, `docs/PLUGINS.md`,
`docs/A2A.md`, `docs/WEBHOOKS.md`, examples and their tests.

### 13.3 Risks
- **Catalog bloat and wrong auto-loads** (many skills, small local models): caps, ranking, margins,
  the trial state; measured by an eval of auto-load precision on past turns before 2.29 ships.
- **Learning that annoys** (offers too often or for trivia): 3× on 2 days, one a day, *Never*, and
  the offline eval with near-misses; the owner's week of use is the real tuning.
- **Plugin isolation on Windows** is only Node's seat belt: stated plainly, extra tick, owner-only;
  a real Windows fence (AppContainer / a restricted token) is a BACKLOG research item.
- **Node 24 has no network permission**: covered by bwrap/Seatbelt and `sara.fetch`; when Sara moves
  to Node ≥ 25, add `--allow-net` absent as one more layer.
- **A2A is young and moving** (1.0 now, 0.3 still common): we serve 1.0 only and say so in the error;
  a 0.3 compatibility shim is a question (§15) rather than a default.
- **Reachability for webhooks and A2A** (most homes have no public address): explained per access
  mode; Funnel / own address are the owner's choice.
- **People extraction errors** (merging two people, inventing relations): proposals first, merge /
  split, sources on every fact, the backfill eval.
- **Agenda tone** (feeling needy or pushy): off by default, shared cap, true reasons, the owner's
  week as acceptance.
- **Schema growth**: all additive; each phase's migration test opens a copy of a 2.28 database.

---

## 14. Phases at a glance (one release each, in order, after Phase 95)

| Phase | Version | Name | Done when (short) |
|---|---|---|---|
| 96 | 2.29.0 | ST1 skills in the Agent Skills format | spec examples parse; catalog caps; activation de-dup; scripts ask in the sandbox; recipes migrated; zip/git import with review; export passes `skills-ref validate` |
| 97 | 2.30.0 | ST2 skills she learns | 3× on 2 days offers once a day, never silent; chain mining; fixes as diffs with versions; M9 check gates default use; offline eval ≥ 5/6, ≤ 1 false |
| 98 | 2.31.0 | ST3 plugins and hooks | manifest + review card; own fenced process; JSON channel caps; hooks map to TurnHooks and can only tighten; the hostile plugin fails at everything; tools/cards/settings/bridges work |
| 99 | 2.32.0 | ST4 Kanban | board over tasks on phone + desktop + keyboard; assign → she or a helper works it with receipts; blocked cards ask; shared household boards by membership |
| 100 | 2.33.0 | ST5 A2A | 1.0 REST + JSON-RPC server with thin public card and per-peer extended card; per-peer keys, no memory by default, `AUTH_REQUIRED` approvals, budgets; client with follow-up cards; official SDKs interoperate |
| 101 | 2.34.0 | ST6 people | cards from memory with sourced facts; backfill as proposals; disambiguation; recall section; private and sensitive rules; never outside |
| 102 | 2.35.0 | ST7 webhooks | GitHub / Stripe / Standard Webhooks / header / URL verification with vectors; filters + presets; four actions; limits, log, dry-run test |
| 103 | 2.36.0 | ST8 her agenda | off by default; one shared cap in code; true *why*; editable on Today; crisis pause; members separate |

Each release follows the usual gates (`DEVELOPMENT.md`): typecheck + full tests green, the README
"What's new" row and the five translated READMEs, the docs page, THREAT_MODEL additions, the demo
behaviour checked, OWNER_CHECKS items for the owner to-dos above.

---

## 15. Blocking questions (with the defaults applied if the owner is away)

1. **Where do skills live by default: per companion or shared by all her companions?** Default:
   **per companion** (the roadmap's "per companion"); *All my companions* is one click on each skill,
   and migrated recipes go to the main companion.
2. **Do the three built-in starter skills ship switched on?** Default: **on**, each switchable off.
3. **Learned skills: how many repeats before she offers, and must the M9 check pass before default
   use?** Default: **3 times on at least 2 days, one offer a day; the check is on** (with *Use it
   anyway*).
4. **Plugins on servers that can't fence them (Windows, Linux without bubblewrap): allow with a
   warning, or refuse?** Default: **allow, owner-only, with the "not fenced in" warning and a
   required *I trust this author* tick**; Linux installs suggest installing bubblewrap.
5. **May plugins be installed from a git URL, or only from a folder/zip?** Default: **git URL
   allowed** (owner-only, hardened clone, hash pinned, updates only on *Check for updates*).
6. **Kanban: does the board replace the planner list as the default view?** Default: **no**; the
   list stays the default until the owner opens the board, then his last choice is remembered.
7. **How many cards may she work at once?** Default: **2**, using the team limits per card.
8. **A2A: may her public agent card show her name, and should 0.3 peers be served?** Default:
   **no name (generic "Sara"); 1.0 only**, with a clear `VersionNotSupportedError`; a 0.3 shim
   becomes a BACKLOG item if a real peer needs it.
9. **A2A: may peers get any memory?** Default: **none**; per peer the owner may allow *shared notes*
   (`sharedWithApps` facts only); people and conversations never.
10. **A2A push notifications (Sara calling a peer's URL)?** Default: **not offered** in this track
    (SSRF); streaming and polling instead.
11. **People: may she add people on her own after repeated mentions, or only after he accepts?**
    Default: **proposals first; a person mentioned in 3 conversations without being rejected becomes
    active and is marked *added on her own*.**
12. **Webhooks: allow *URL only* hooks (no signature) for Home Assistant and simple senders?**
    Default: **yes, marked weaker, limited to *Tell me* and *Add a task* unless the owner changes the
    action**.
13. **Her agenda: does it share the proactive-message cap or get its own?** Default: **shared**
    (2 a day in total), so turning it on never means more messages than he already allowed; off by
    default; research off.
14. **Household: may members use plugins, A2A or webhooks?** Default: **no in this track** (owner
    routes); members get skills, learned skills, boards (with sharing), people and their own agenda.

---

## 16. Sources

- [S1] Agent Skills, *Specification* — https://agentskills.io/specification (directory layout;
  `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`; progressive
  disclosure; file references; the `skills-ref validate` reference validator). Read 2026-10-31.
- [S2] Agent Skills, *How to add skills support to your agent* —
  https://agentskills.io/client-implementation/adding-skills-support (three-tier loading, scan
  scopes incl. `.agents/skills/`, collisions, trust for project skills, lenient parsing incl.
  unquoted colons, activation tool with a tagged block and a resource list, protection from
  compaction, de-duplication). Read 2026-10-31.
- [S3] Agent2Agent (A2A) Protocol Specification, latest released version 1.0.0 —
  https://a2a-protocol.org/latest/specification/ (Agent Card and `/.well-known/agent-card.json`,
  extended card, operations, Task/Message/Part/Artifact, task states, JSON-RPC / REST / gRPC
  bindings, `A2A-Version` and `VersionNotSupportedError`, in-task authorisation with
  `TASK_STATE_AUTH_REQUIRED`, push notification objects, `application/a2a+json` security
  considerations incl. SSRF). Read 2026-10-31.
- [S4] A2A project and SDKs — https://github.com/a2aproject/A2A (normative `a2a.proto`), JS SDK
  `@a2a-js/sdk` (https://github.com/a2aproject/a2a-js), Python `a2a-sdk` (PyPI). Used only for the
  scratch conformance run, never as a dependency.
- [S5] GitHub Docs, *Validating webhook deliveries* —
  https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
  (`X-Hub-Signature-256`, HMAC-SHA256 hex with `sha256=`, constant-time compare, UTF-8, the test
  vector). Read 2026-10-31.
- [S6] Stripe Docs, *Receive Stripe events in your webhook endpoint* (verify signatures manually) —
  https://docs.stripe.com/webhooks#verify-manually (`Stripe-Signature` `t=` / `v1=`, signed payload
  `t.body`, 5-minute default tolerance).
- [S7] Standard Webhooks specification —
  https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md and
  https://www.standardwebhooks.com/ (`webhook-id`, `webhook-timestamp`, `webhook-signature` `v1,`
  base64, `whsec_` secrets, multiple signatures for rotation, timestamp tolerance, idempotency).
  Read 2026-10-31.
- [S8] Node.js, *Permissions* — https://nodejs.org/docs/latest-v24.x/api/permissions.html (the
  permission model is stable, a "seat belt" that "does not protect against malicious code";
  symlinks followed outside granted paths; flags `--allow-fs-read/-write`, `--allow-child-process`,
  `--allow-worker`, `--allow-addons`) and https://nodejs.org/api/cli.html (`--allow-net`, added in
  v25.0.0, so not available on Node 24). Read 2026-10-31.
- Sara's own design docs this follows: `docs/design/HARNESS_TRACK.md` (M1 recall, M3 runs and
  TurnHooks, M4 budgets, M5 sandbox gate, M9 evals, M10 triggers), `docs/design/COMPUTER_USE.md`
  (owner decisions on *Always allowed*, the review-card and safety patterns), `docs/ROADMAP.md`
  (*Staples track*, *Move-in track*).
