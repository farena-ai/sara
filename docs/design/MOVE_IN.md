# Move-in: bring a whole agent over from Hermes Agent or OpenClaw (design, Phases 104–106, versions 2.37.0–2.39.0)

Status: design study, 2026-10-31. Nothing here is built yet. Read-only study of the code at 2.25.0
(Phase 93 open) plus the public Hermes Agent and OpenClaw documentation (sources in §16). Ground-up
design: no code, schema or file format is taken from Hermes Agent or OpenClaw; their on-disk layouts
are only *read*, from their public docs, so the readers are exact. Depends on the staples track
(ST1 skills, ST3 plugins and hooks, ST4 Kanban, ST5 A2A, ST6 people, ST7 webhooks, ST8 agenda)
having shipped first; §13.3 says what happens if one of them hasn't.

**The owner's words (2026-10-30):** "an import script ... to convert from Hermes Agent or Openclaw ...
these systems are highly customized ... not everything can be imported ... but memory, personality,
important stuff ... and maybe even some of the configuration of that system so that there is not a
total loss."

**Goal:** nothing is lost silently. Every item found is **imported**, **translated** into a native
Sara feature, put in front of the owner as **needs you**, or **left behind** with a reason, and the
move-in report lists all four.

Contents: 1 what exists today · 2 what real agents look like (findings + documented layouts) · 3 the
shape · 4 the collector · 5 the bundle format · 6 exact readers for Hermes and OpenClaw · 7 preview,
one batch, Undo · 8 custom stores (MI2) · 9 configuration, channels and hooks (MI3) · 10 the move-in
report · 11 safety · 12 easy for beginners · 13 reuse vs build, risks · 14 phases · 15 blocking
questions with defaults · 16 sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| Companion import ("Bring her from another app") | `src/companion-import/` (`index.ts` 144 lines, `readers.ts` 365, `session.ts` 489, `learn.ts` 272, `types.ts` 83); Settings → Her → *Bring her from another app* (`data-page="her-import"`) | Detects a file's format (Character.AI, SillyTavern `.jsonl`, generic JSON/CSV/text/Markdown, ChatGPT/Claude inside a zip), reads it into `RawExport` (conversations of `RawMessage {speaker, text, at}`), asks who is who (`SpeakerRole` owner / companion / other), learns facts + "how she talks" from chunks with the chosen model (`learnPrompt`, `ProposalBook`, `heuristicProposals` without a model), preview with an estimate (`ImportEstimate`: chunks, tokens, model), confirm, background job. Caps: `MAX_ZIP_BYTES` 200 MB, `MAX_FILE_BYTES` 50 MB, `IMPORT_ZIP_LIMITS` (200k entries, 400 MB/entry, 800 MB total, ratio 250), `MAX_CONVERSATIONS` 20k, `MAX_CHUNKS` 300. `fitToShow` drops minor-sexual and instruction-like lines (`INSTRUCTION_LIKE`). | Sessions from Hermes/OpenClaw are just another `RawExport`; the speaker-role step, the learning chunks, the estimate card and `fitToShow` are reused as they are. Its caps are far below a 3 GB store: the move-in needs a **streamed** path (§7.1). |
| History import ("Bring your history") | `src/history-import/` (`index.ts` 505, `chatgpt.ts`, `claude.ts`, `types.ts`); Settings → Data & health → *Export and import* | ChatGPT/Claude exports → archived past conversations on channel `import-<source>` (`SOURCE_CHANNEL`), deduped by `findChannelConversation(channel, sourceId)` on a re-run, `saveUpload` streams the upload to disk (500 MB cap), learning queue in the background, `remove(source)` = **Remove imported history** (the existing undo). `SkipCounts` (system, tool, hidden, images, files) feed the preview. | Two new sources `hermes` and `openclaw` join `HistorySource`/`SOURCE_NAME`/`SOURCE_CHANNEL`; dedupe by source id and the "remove what was imported" pattern carry over. |
| Zip reader | `src/library/zip.ts` (`openZip(buf, limits)`, `Zip`, `ZipEntry`, `inflateRawSync` with `maxOutputLength` per ratio) | Own zip reader on a whole **Buffer** with zip-bomb caps. | The bundle is a zip (§5) but up to several GB: add `openZipFile(fd, limits)` (central directory from the file end, one entry streamed through `createInflateRaw`) next to it, same caps logic. |
| Character cards | `src/character-cards.ts` (647 lines) | Card V2/V3 → persona: description → summary/background, personality → lines, `mes_example` → speech, lorebook → her notes (`MAX_LORE` 50), explicit lines out unless Adult mode, minors refused. | The persona-file mapping (§6.3) is the same job with more files; its "keep / notes / dropped" bookkeeping and its refusals are reused. |
| Persona | `src/persona.ts` (`Persona`, `validatePersona`: age ≥ 18, lists ≤ 20 lines × 400 chars; `SAFETY_BOUNDARIES` always appended in `buildSystemPrompt`), `src/character.ts`, `src/studio.ts`, `src/traits.ts`, `src/drift.ts` | Her character sheet; the safety boundaries are added in code whatever the sheet says. | A 20 000-character SOUL.md doesn't fit 20 × 400: §6.3 condenses with a reviewed draft and keeps the rest as her `self` memories, never silently cut. |
| Memory | `src/memory.ts` (`MemoryStore`, kinds `summary fact self date reflection decision promise milestone lesson`, `happenedOn`, `evidence`, `supersededBy`, `pinned`, FTS), `src/memory-rank.ts` (`KIND_PRIOR`, decay presets, `rankMemories`), `src/memory-worker.ts`, `src/recall.ts` | Her notes, ranked per turn (M1/Phase 76). Notes learned from imported history say so in the prompt (`importedFrom` in `selectMemories`). | Memories land here, deduped and ranked; the "learned from imported X history: that was X talking" line must say **"from before the move"** when the owner says the old agent *was* her (§6.5). |
| Planner | `src/planner.ts` (805 lines: projects, tasks with `Repeat none/daily/weekdays/weekly/monthly`, reminders, `parseWhen`, `nextOccurrence`), `src/reminders.ts`, `src/triggers.ts` | Tasks, reminders, repeats. | Cron jobs → scheduled tasks; repeats that `Repeat` can't express go to ST7/ST8 triggers or "needs you" (§6.8). |
| Recipes → skills | `src/recipes.ts` (361 lines) → ST1 (Phase 96: Agent Skills folders, recipes migrate) | Saved step lists today; skill folders after ST1. | Hermes and OpenClaw skills are already Agent Skills folders (`SKILL.md` + files): imported as skills with scripts **not run** until reviewed (§6.7). |
| Staples (planned) | ROADMAP Phases 96–103 | ST3 plugins + hooks (manifest, permissions, own process, hook points before turn / before-after tool / after reply / schedule / event), ST4 board over planner tasks, ST5 A2A peers, ST6 people cards, ST7 signed webhooks, ST8 her own agenda. | Built first on purpose so imports land in real features instead of "left behind". |
| Jobs | `src/jobs.ts` (`startTask(TaskSpec)`: in-process task with strip, Stop, notice, report) | Background work with progress and Stop. | The import batch runs as one task (§7.3). |
| Undo patterns | `history-import remove(source)`, Gmail organizing undo table (30 days), `src/snapshots.ts` (workspace snapshots) | Reversible bulk work. | One move-in = one batch id on every row it creates, one Undo (§7.4). |
| Privacy, safety | `src/net-guard.ts` (one choke point for outgoing requests, private local mode), `src/redact.ts` (secret scrubbing), `src/safety.ts` (`detectMinorSexualContent`, crisis), `src/private-local.ts` | | Imported text is scrubbed for secrets again on the server; model calls during the import use the guarded path and respect private local mode. |
| Household | `docs/HOUSEHOLD.md`, `src/household.ts` | Each member is a full data folder. | A move-in goes into the space of the person who uploads it; owner-only by default (§11.8). |

What does **not** exist: anything that runs on another machine to collect (the history importers
take an export the other app makes), any reader of a live agent's home folder, schema discovery, a
mapping step, config translation, or a report of what was left behind.

---

## 2. What real agents look like

### 2.1 The two real, heavily customised agents (from ROADMAP, owner-approved read-only look, 2026-10-30)

Nothing was copied and no personal content was recorded; structure only.

- **OpenClaw (agent A, a Linux server):** workspace persona files (SOUL, IDENTITY, STYLE, EXAMPLES,
  RELATIONSHIP_DYNAMICS, BACKSTORY, RITUALS, INSIDE_JOKES, USER, MEMORY + `memory/` daily files,
  AGENTS, WORKFLOW), `openclaw.json` (agents, channels Telegram/Discord/A2A, 19 plugins, 6 model
  providers, 43 skills, internal hooks, TTS), ~740 session files (~100 MB), and a custom plugin with
  its own `node:sqlite` store of **276 tables (~3 GB)**: people graph with ~34k facts, ~32k
  memories, intentions, goals, opinions, self-narrative, tasks, many autonomy/telemetry logs; plus
  a Postgres app database.
- **Hermes Agent (agent B, a Mac mini):** `SOUL.md` (+ dated versions), MEMORY/USER memories,
  `config.yaml` (+ many dated backups), ~46 skills, hooks, 16 custom plugins (several with their own
  SQLite memory stores), `state.db` sessions, cron, kanban, channel bridges (Discord, Telegram,
  iMessage, WhatsApp), and sensitive categories (medical): **75 GB in all**, mostly
  media/models/backups.

Lessons that shape every section below: the valuable part is small (persona files, memories,
people/facts, profile, skills, schedules, recent history); most of the volume is logs, telemetry,
backups and media and is skipped by default; custom stores need schema reading, not fixed formats;
dated copies of persona/config files are **history of one persona**, not more personas;
health/medical and intimate content need an explicit per-category choice; secrets are never
collected.

Two layout facts follow from the findings and change the readers: agent A's ~740 *files* are the
**legacy JSONL transcripts** (current OpenClaw keeps sessions in a per-agent SQLite file, §2.3), so
the OpenClaw reader must handle both; and agent A's persona has **eight files the OpenClaw docs don't
define** (STYLE, EXAMPLES, RELATIONSHIP_DYNAMICS, BACKSTORY, RITUALS, INSIDE_JOKES, WORKFLOW and the
like), so the persona reader maps known names exactly and treats any other top-level `*.md` in the
workspace as "persona material, kind unknown" for the model-assisted draft (§6.3).

### 2.2 Hermes Agent: documented layout (what the reader expects)

Home: `$HERMES_HOME`, default `~/.hermes/` on Linux/macOS/WSL2, `%LOCALAPPDATA%\hermes` for a native
Windows install; named profiles live in `~/.hermes/profiles/<name>/` with the same layout. A folder
under `profiles/` is a profile only when it holds one of `config.yaml`, `.env`, `SOUL.md`,
`profile.yaml`, `auth.json`, `state.db` [H1][H2][H3].

| Path (under the home) | What it is | Reader |
|---|---|---|
| `SOUL.md` | Primary identity, slot #1 of the system prompt; loaded **only** from the home (not the working folder) [H4] | persona (§6.3) |
| `config.yaml` → `agent.personalities` (and top-level `personalities:`; `agent.` wins) | Extra named personalities / overrides of built-ins, swapped per session with `/personality` [H4] | persona *variants* (§6.3: offered as alternative drafts, not merged) |
| `memories/MEMORY.md`, `memories/USER.md` | The agent's notes (≈2 200 chars) and the user profile (≈1 375 chars); **entries separated by `§`**, entries may be multi-line [H5] | memories / profile (§6.4) |
| `state.db` | SQLite (WAL) session store: `sessions` (`id`, `source` = cli/telegram/discord/…, `user_id`, `model`, `system_prompt`, `parent_session_id`, `started_at`/`ended_at` epoch floats, `title`, token and cost counters…), `messages` (`session_id`, `role`, `content`, `tool_call_id`, `tool_calls` JSON, `tool_name`, `timestamp` epoch float, `reasoning*`, **`active`**, `compacted`, `message_uid`…), `messages_fts*`, `schema_version` (31 at the time of writing). In-place compaction keeps old rows with `active=0` and re-inserts the kept context as `active=1`, so the same message legitimately appears twice; `message_uid` is the durable id across copies [H6] | sessions (§6.6) |
| `skills/<maybe-category>/<name>/SKILL.md` (+ `scripts/`, `references/`, `templates/`, `assets/`) | Agent Skills format; frontmatter `name`, `description`, optional `version`, `author`, `platforms`, `metadata.hermes.tags/category` [H7] | skills (§6.7) |
| `cron/jobs.json` | Jobs: `id`, `name`, `prompt`, `schedule {kind: cron/interval/once…, expr, display}`, `skills[]`, `deliver` (e.g. `telegram:<chat id>`), `repeat {times, completed}`, `state`, `enabled`, `next_run_at`, `last_run_at`, `last_status`, `model`, `provider`, `script`, top-level `timezone`, `grace_minutes`; schedules are relative delay (`30m`), interval (`every 2h`), 5-field cron or an ISO time [H8] | scheduled tasks (§6.8) |
| `cron/deliveries.db`, cron run output | Delivery queue and run history | left behind (telemetry) |
| `kanban.db` (default board), `kanban/boards/<slug>/kanban.db`, `kanban/workspaces/<id>/` | SQLite boards: tasks with `title`, body, one assignee (a profile name), status `triage todo ready running blocked review done archived`, `task_links` (parent → child), comments, attachments; scratch workspaces are deleted on completion [H9] | board (§6.9) |
| `hooks/<name>/HOOK.yaml` + `handler.py` | Gateway event hooks (`events:` such as `agent:start`, `agent:step`, `command:*`); trusted by placement, imported at gateway start [H10] | **read, never run** → MI3 (§9.3) |
| `plugins/<name>/plugin.yaml` + Python (`__init__.py` `register(ctx)`, tools, hooks such as `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start/end`, kanban hooks); enabled only when named in `config.yaml` `plugins.enabled` [H11][H10] | Custom tools, hooks, integrations; several of agent B's carry their **own SQLite memory stores** inside the plugin folder | plugin code → MI3; plugin SQLite → MI2 (§8) |
| `config.yaml` | Non-secret settings: `model` (`default`, `provider`, `base_url`), `providers:` (named providers), `fallback_providers` / legacy `fallback_model`, `auxiliary.<task>` routes, `tts` (`provider` edge/elevenlabs/openai/…, voice per provider), `memory.*`, `platforms.<name>.enabled` (Telegram, Discord, WhatsApp, iMessage bridges…), `approvals.mode`, `gateway.*`, `plugins.enabled` [H2][H12] | config (§9.1) |
| `.env`, `auth.json`, `.anthropic_oauth.json`, `auth/`, `mcp-tokens/`, `pairing/`, `vault/`, `browser-profile/`, `cache/bws_cache*.json` | Secrets and credential stores (Hermes' own security page lists them) [H13] | **never collected** (§4.4) |
| `logs/`, `sessions/` (gateway session files), `backups/`, `state-snapshots/`, `checkpoints/`, `hermes-agent/` (source checkout), model files, media | Logs, history copies ("can reach tens of GB" per the profiles page [H1]), code | left behind by default |
| `SOUL.<date>…md`, `config.<suffix>.yaml`, `*.bak*` | Dated copies (seen on agent B) | history of one persona/config (§4.3) |

### 2.3 OpenClaw: documented layout (what the reader expects)

Two roots [O1][O2][O3]: the **state dir** `$OPENCLAW_STATE_DIR` (default `~/.openclaw`, or
`~/.openclaw-<profile>` with `OPENCLAW_PROFILE`), and per agent a **workspace** (default
`<state dir>/workspace`; overridden by `OPENCLAW_WORKSPACE_DIR`, `agents.defaults.workspace`,
`agents.entries.<id>.workspace`; in a multi-agent roster an unpinned entry uses
`<agents.defaults.workspace>/<agentId>` or `<state dir>/workspace-<agentId>`). Config path can be
moved with `OPENCLAW_CONFIG_PATH`. Older installs may also have `~/openclaw`, which OpenClaw itself
does not merge [O2].

| Path | What it is | Reader |
|---|---|---|
| workspace `SOUL.md` | Persona, tone, boundaries; default injection cap 20 000 chars per file, 60 000 total (`bootstrapMaxChars`, `bootstrapTotalMaxChars`) [O1][O3] | persona |
| workspace `IDENTITY.md` | Name, vibe, emoji [O2] | persona (name, summary) |
| workspace `USER.md` | Directive-based user model: dated entries marked `<!-- observed: YYYY-MM-DD \| status: active -->` or `status: superseded`, one directive each, "Always / Never / Prefer" [O4] | profile (§6.4: active → facts/preferences, superseded → kept as superseded notes) |
| workspace `AGENTS.md` (incl. its `## Tools` section) | Operating instructions + "how to use memory"; loaded every session, the only file sub-agent sessions get [O2][O5] | her working rules (§6.3) and MI3 |
| workspace `MEMORY.md` (legacy lowercase `memory.md`) | Curated long-term memory: durable non-profile facts, decisions, short summaries [O2][O6] | memories |
| workspace `memory/YYYY-MM-DD.md` | Daily memory log, one file per day [O2] | dated memories (`happenedOn` = the file's date) |
| workspace `DREAMS.md`, `memory/dreaming/<phase>/YYYY-MM-DD.md`, `memory/.dreams/` | memory-core "dreaming" review output (human-readable) and machine state [O6][O2] | `DREAMS.md` → her diary/reflections (needs you); `.dreams/` left behind |
| workspace `BOOT.md`, `BOOTSTRAP.md`, `HEARTBEAT.md` | Startup checklist (boot-md hook), first-run ritual, legacy heartbeat [O2] | BOOT → MI3 "on start" rule; BOOTSTRAP left behind (one-time); HEARTBEAT → agenda (ST8) |
| workspace `skills/`, `.agents/skills/`; `<state>/skills/` (managed); `~/.agents/skills`; `<state>/agents/<id>/agent/workshop-skills`; `skills.load.extraDirs` | Skills, `SKILL.md` + files; precedence workspace → project → personal → managed → workshop → bundled → extra [O7] | skills (bundled ones are left behind: Sara has her own) |
| workspace `hooks/<name>/`, `<state>/hooks/<name>/`, `hooks.internal.load.extraDirs` | Internal hooks: `HOOK.md` (frontmatter `name`, `description`, `metadata.openclaw.events` such as `command:new`, `command:reset`, `agent:bootstrap`, `session`, `message` families) + `handler.ts/js` or `index.ts/js` [O8][O9] | **read, never run** → MI3 |
| plugin roots (each holds `openclaw.plugin.json`: `id`, `configSchema`, optional `kind` e.g. `memory`, `channels`, `requiresPlugins`…; code entry in `package.json`) [O10] | Native plugins (agent A: 19, incl. the custom store) | MI3 (code) and MI2 (its data stores) |
| `<state>/openclaw.json` | **JSON5**; may use `$include` to split files; a `.bak` ring of previous versions [O11]. Keys used here: `agents.defaults.*`, `agents.entries.<id>.*` (workspace, model, memory…), `channels.<name>` (telegram, discord, whatsapp, … `allowFrom`), `models` / provider entries, `plugins.entries.<id>.{enabled, config}`, `skills.entries.<name>.{enabled, env, apiKey, config}`, `hooks.internal.{enabled, entries, load.extraDirs}`, `hooks.enabled` (HTTP ingress = webhooks), `cron.*`, TTS settings [O7][O9][O11] | config (§9). **Inline secrets are allowed here** (`skills.entries.*.apiKey`, `.env`, plugin `config` keys): the collector redacts them (§4.4) |
| `<state>/agents/<id>/agent/openclaw-agent.sqlite` | Per-agent SQLite: auth profiles, routing state, standing intents, session rows, transcripts, memory index [O2][O12] | sessions (current layout); auth tables skipped |
| `<state>/agents/<id>/sessions/sessions.json` + `<sessionId>.jsonl` (`…-topic-<threadId>.jsonl` for Telegram topics) | **Legacy / archive** session store and transcripts. JSONL: first line a `type:"session"` header (`id`, `cwd`, `timestamp`, optional `parentSession`), then entries with `id` + `parentId` (a tree): `message` (user / assistant / toolResult), `custom_message`, `custom`, `compaction` (summary, `firstKeptEntryId`), `branch_summary`. Session keys: `agent:<id>:<mainKey>`, `agent:<id>:<channel>:group:<id>`, `…:channel:<id>`, `cron:<job id>`, `hook:<uuid>` [O12][O13] | sessions (agent A's ~740 files) |
| `<state>/state/openclaw.sqlite` | Shared state DB (auth profiles, attestations; automations since 2026.6.1) [O1][O14] | automations table only |
| `<state>/cron/jobs.json`, `runs/<jobId>.jsonl`, `jobs-quarantine.json` | **Legacy** automation store (retired in 2026.6.1, imported into SQLite by `doctor --fix`) [O14][O15] | scheduled tasks (either source) |
| `<state>/credentials/`, `<state>/secrets.json`, `agents/<id>/agent/auth.json`, legacy `credentials/oauth.json`, `auth-profiles.json`, `agents/<id>/agent/codex-home/` | Secrets and provider credentials [O1] | **never collected** |
| logs, `*.migrated`, media, `node_modules/` inside plugins | | left behind |

Both layouts move between releases (OpenClaw moved sessions and cron into SQLite during 2026); the
readers key on **what is present**, never on a version number, and each reader has a "found but not
understood" bucket that the report lists (§10).

---

## 3. The shape

```
 The old agent's machine (agent A / agent B / any)               Sara's server (remote or local)
 ┌──────────────────────────────────────────┐   bundle    ┌─────────────────────────────────────────────┐
 │ sara-movein collect   (one file, no       │  upload in  │ Settings → Import → Move in                  │
 │   installs, read-only)                    │  Settings   │  ├ bundle check (zip caps, hashes, version)   │
 │  ├ find homes (Hermes, OpenClaw, custom)  │ ──────────► │  ├ readers: Hermes, OpenClaw (MI1)            │
 │  ├ plan: what it will pack / skip, sizes  │  (resumable │  ├ custom stores: schema → model mapping      │
 │  ├ secrets never opened; config redacted  │   chunks)   │  │   cards → owner confirms (MI2)             │
 │  ├ SQLite: read-only, one snapshot        │             │  ├ config / channels / hooks translated,      │
 │  ├ Postgres: psql/pg_dump, read-only txn  │             │  │   never run (MI3)                          │
 │  └ writes ONE bundle: <name>.saramove     │             │  ├ preview: counts + samples + sensitive      │
 └──────────────────────────────────────────┘             │  │   categories (opt-in) → Import             │
                                                           │  ├ one batch task (Stop, progress) + Undo     │
                                                           │  └ move-in report (4 lists, reasons)          │
                                                           └─────────────────────────────────────────────┘
```

- **Collection is dumb and safe; understanding happens on the server.** The collector only finds,
  filters, redacts and packs. Every judgement that needs a model (persona condensation, table
  mappings, hook intent) runs on Sara's server with her chosen model, after upload, where the
  owner reviews it. That keeps the script small enough to read before running it.
- **Nothing on the old machine is changed.** No writes outside the output file and the system temp
  folder, no service stopped by the script itself, no network except a `psql`/`pg_dump` the owner
  pointed at (and the optional direct upload, §4.9). The old agent keeps running; the move-in can be
  repeated later and imports only what's new (§7.5).
- **One bundle per old agent** (one Hermes profile, or one OpenClaw agent id). A machine with several
  profiles/agents gets a picker; each choice is its own bundle, so two personalities never merge.

---

## 4. The collector (`sara-movein collect`, MI1)

### 4.1 One file, no installs

- **One Python 3 file, stdlib only** (`sara-movein.py`, ~1 500 lines, Python ≥ 3.9): `sqlite3`
  (read-only URI + the backup API), `zipfile` (ZIP64, streamed writes), `hashlib`, `json`, `os`,
  `subprocess` (only for `psql`/`pg_dump`), `getpass`. Python is on both real machines: Hermes Agent
  is a Python program, and the Linux server running OpenClaw has the distribution's `python3`.
  Windows hosts without Python get the same script through the Sara desktop app's bundled runtime
  (§15 Q1 lists the alternative: a Node ≥ 22.5 twin, since OpenClaw always has Node).
- Downloaded from the Settings → Import page (served by Sara, same version as the server, with its
  SHA-256 shown) or `curl -fsSL https://<sara>/movein/sara-movein.py -o sara-movein.py`. The page
  shows the exact one-line command with the hash check. The script is plain, commented source:
  "read it before you run it" is a real option.
- **Read-only by construction.** All file opens are `O_RDONLY`; SQLite through
  `file:<path>?mode=ro` URIs (plus `immutable=1` when the owner says the agent is stopped); the only
  file it creates is the bundle (and temp files in `$TMPDIR/sara-movein-<pid>/`, deleted on exit).
  A test runs the script against a fixture home with every file `chmod 0444`/folders `0555` and
  checks nothing changed (mtimes, sizes, hashes, no new sidecars when `immutable=1`).

### 4.2 Finding the homes

In order, each confirmed by its identity files (§2.2, §2.3), never by folder name alone:

1. `--hermes-home PATH` / `--openclaw-state PATH` / `--workspace PATH` given by the owner.
2. Environment: `HERMES_HOME`; `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE`, `OPENCLAW_CONFIG_PATH`,
   `OPENCLAW_WORKSPACE_DIR`.
3. Defaults: `~/.hermes`, `~/.hermes/profiles/*`, `%LOCALAPPDATA%\hermes`; `~/.openclaw`,
   `~/.openclaw-*`, legacy `~/openclaw`.
4. OpenClaw workspaces from `openclaw.json` (`agents.defaults.workspace`, each
   `agents.entries.<id>.workspace`, the roster fallbacks of §2.3); `~` expanded, relative paths
   resolved against the state dir.
5. `--scan PATH` for custom builds: looks for SQLite files (magic `SQLite format 3\0`), `*.md`
   persona-shaped files (SOUL/IDENTITY/PERSONA/CHARACTER/USER/MEMORY), `SKILL.md` folders, and
   `*.sql`/`*.dump` files; nothing outside the given path.

When the agent runs under another user (a service account), the script says so and prints the
`sudo -u <user> python3 sara-movein.py …` line instead of escalating itself.

### 4.3 Default rules: what it packs and what it skips

| Packed by default | Skipped by default (count + size shown, can be included) | Never packed (no switch) |
|---|---|---|
| Persona files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `BOOT.md`, `HEARTBEAT.md`, `DREAMS.md`, any other top-level `*.md` in an OpenClaw workspace), `memories/MEMORY.md`, `memories/USER.md`, `memory/YYYY-MM-DD.md` | **Logs**: `logs/`, `*.log`, `runs/*.jsonl`, cron run history, `cron/deliveries.db` | `.env`, `*.env`, `.env.*` |
| Config: `config.yaml`, `openclaw.json` (+ its `$include` files), **redacted** (§4.4) | **Media**: images, audio, video, PDFs over 5 MB, `*.gguf`/`*.safetensors`/`*.bin` models, voice caches | `auth.json`, `auth-profiles.json`, `*.secrets.json`, `secrets.json`, `oauth.json`, `credentials/`, `auth/`, `mcp-tokens/`, `pairing/`, `vault/`, `codex-home/` |
| Skills folders (`SKILL.md` + text files ≤ 1 MB each; scripts as text) | **Dated backups and copies**: `backups/`, `state-snapshots/`, `checkpoints/`, `*.bak*`, `*.orig`, `*.migrated`, `*~`, `<name>.<date or tag>.<ext>` beside `<name>.<ext>` (e.g. `SOUL.2026-04-23_pre_x.md`, `config.pre_y.yaml`) — the **newest 3 dated copies of each persona file are packed as history** (§6.3) | Private keys (`*.key`, `*.pem`, `id_*`, `*.p12`, `*.keystore`), files whose first bytes are `-----BEGIN` + `PRIVATE KEY` |
| Hooks and plugins as **source text** (`HOOK.yaml`/`HOOK.md`, handlers, `plugin.yaml`, `openclaw.plugin.json`, `package.json`, `*.py`/`*.ts`/`*.js` ≤ 512 KB, no `node_modules/`, `.venv/`, `__pycache__/`) | **Code checkouts and envs**: `hermes-agent/`, `node_modules/`, `.venv/`, `venv/`, `.git/` | Browser profiles (`browser-profile/`), cookies databases, keychains, `cache/bws_cache*` |
| Cron / automations (`cron/jobs.json`, `jobs-quarantine.json`, the automation tables of `state/openclaw.sqlite`) | **Telemetry tables** in stores (§8.2), **workspace scratch** (`kanban/workspaces/`) | Anything matched by the owner's `--never PATTERN` |
| Kanban DBs; `state.db` sessions + messages; `openclaw-agent.sqlite` session/transcript tables; legacy `sessions/*.jsonl` + `sessions.json` | **Old sessions** past `--since` (default: everything; §15 Q4) | |
| Custom SQLite stores and their **schema + 5 sample rows of every table**; full rows of non-telemetry tables | Sensitive categories until chosen (§4.6) | |

Every skip has a **reason code** (`secret`, `log`, `media`, `backup`, `code-env`, `telemetry`,
`sensitive-unchosen`, `too-big`, `owner-never`, `unreadable`) that travels in the manifest and ends
up in the report's *left behind* list, so "skipped" is never silent.

### 4.4 Secrets

- **Files** in the never-packed column are never opened (matched by path before any read). Their
  *names* and sizes are listed in the manifest (`secret` reason) so the report can say "your Telegram
  token was in `.env`; reconnect Telegram in Settings → Channels".
- **Config files are redacted while packing.** `config.yaml` and `openclaw.json` can carry secrets
  inline (OpenClaw documents `skills.entries.*.apiKey`, `skills.entries.*.env` and plugin `config`
  keys holding keys [O7][O11]). The collector parses them with a small built-in JSON5 reader and a
  restricted YAML reader (mappings, lists, scalars, block strings; anchors and tags → "not
  understood"), and replaces the **value** of any key that matches
  `/(api[_-]?key|token|secret|password|passwd|credential|auth|cookie|private[_-]?key|client[_-]?secret|bearer|session[_-]?key|^env$)/i`
  — and any value shaped like a secret (`sk-…`, `xai-…`, `gho_…`, `ghp_…`, `xox[bp]-…`, JWTs, long
  base64/hex, `BEGIN … PRIVATE KEY` built from parts) — with `{"$redacted": "<reason>", "len": n}`.
  SecretRef objects (`{source, provider, id}`) keep `source`/`provider`/`id` (names only) and lose
  nothing secret. If a file can't be parsed confidently, only its **key skeleton** (paths, no
  values) is packed.
- Text files (persona, memories, skills, sessions) go through the same secret-shape scrubber; hits
  are replaced with `«secret removed»` and counted (`secretsRemoved` in the manifest).
- The server runs `src/redact.ts` again on everything it reads, as a second wall.

### 4.5 SQLite, read-only and consistent

- Opened with `sqlite3.connect("file:<path>?mode=ro", uri=True)`; one read transaction
  (`BEGIN` + a first `SELECT`) gives a consistent snapshot across all tables of that file even while
  the agent writes (WAL readers see the snapshot at transaction start). Hermes' own docs note that a
  `mode=ro` WAL reader can still create empty `-wal`/`-shm` sidecars or update read marks; that is
  SQLite's shared-memory coordination, not a data write [H6]. For a strictly untouched file the
  owner can stop the agent and pass `--stopped`, which adds `immutable=1`.
- Never `VACUUM`, `PRAGMA wal_checkpoint`, `REINDEX`, integrity "fixes" or `ATTACH … AS` with write.
- A locked or corrupt file isn't retried in a loop: three tries with backoff, then `unreadable`
  in the manifest with SQLite's message.
- **Streaming, not loading:** rows are read with `cursor.fetchmany(2000)` in `rowid` order (or the
  primary key; `WITHOUT ROWID` tables by their key) and written straight into the bundle entry as
  JSON Lines. Memory stays flat whatever the table size (target: < 200 MB RSS for agent A's 3 GB
  store, ~30–40 MB/s on a home server's disk).
- Large values: `TEXT` over 256 KB and `BLOB`s are cut to a reference (`{"$blob": sha256, "bytes":
  n}`) unless the column is chosen; embeddings (`BLOB` of `n*4` bytes in a column named like
  `embedding|vector|emb`) are recognised and skipped (Sara re-embeds with her own model).
- FTS shadow tables (`*_fts`, `*_fts_data`, `*_fts_idx`, `*_fts_docsize`, `*_fts_config`,
  `*_content` of a virtual table), `sqlite_stat*` and `sqlite_sequence` are skipped as derived data.

### 4.6 Sensitive categories (opt-in, per category)

- Categories: **health / medical**, **intimate / sexual**, and (owner may add) **finances**,
  **other people's private details**. Each is off until chosen.
- At collection the script tags candidates by **names only** (it doesn't read content to judge):
  paths, file names, plugin ids, table and column names matching per-category word lists (medical:
  `health|medical|med(s|ication)?|symptom|diagnos|doctor|therapy|mood_log|sleep|vitals|lab|prescri|`
  `period|cycle|weight|glucose|bp`; intimate: `intimate|nsfw|adult|sexual|kink|erotic|lewd|spicy|nude`).
  The plan screen shows each category with its count and size and asks `Include health/medical
  items? [y/N]`; flags `--include-category medical` for unattended runs.
- Content inside packed items is classified again on the **server** (§7.2), so a medical fact sitting
  in a general memories table is still held for the owner's choice.
- Unchosen items are not packed at all (reason `sensitive-unchosen`; counts only), so a bundle given
  to someone else can't leak them.

### 4.7 Postgres (when the owner gives a connection)

- Only with `--postgres "<connection string or service name>"`; uses the **system** `psql` and
  `pg_dump` found on `PATH` (never downloads them). The password is asked with `getpass` and passed
  through `PGPASSWORD` in the child's environment only; never written, never in the bundle, never
  echoed; `--postgres` values have their password part stripped before they go in the manifest.
- Every session runs read-only: `PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=0"`
  plus `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` for the row export, so all tables come from
  one snapshot.
- Schema: `pg_dump --schema-only --no-owner --no-privileges` into `stores/<id>/schema.sql`, plus a
  catalog query (`information_schema.columns`, row estimates from `pg_class.reltuples`, foreign keys)
  into `schema.json` so the server doesn't need to parse SQL.
- Rows: per table `\copy (SELECT * FROM "<schema>"."<table>") TO STDOUT WITH (FORMAT csv, HEADER)`,
  streamed through the script into the bundle (CSV → JSON Lines with typed values), same telemetry
  and size rules as SQLite. A `pg_dump` custom-format dump file the owner already has
  (`--postgres-dump file.dump`) is read with `pg_restore --list` / `pg_restore -f - --data-only
  --table=…` to the same output, never restored into a database.
- Extensions' columns (`vector`, `tsvector`) are recognised and skipped like SQLite embeddings.

### 4.8 "Here's what I'll pack" (the plan screen)

Before writing a byte the script prints the plan and waits for Enter (or `--yes`):

```
Sara move-in collector 2.37.0  (read-only: nothing here will be changed)

Found: Hermes Agent home  /Users/alex/.hermes  (profile: default)
  Personality     SOUL.md (14 KB) + 3 older versions (history)         pack
  Memories        MEMORY.md 41 entries, USER.md 19 entries              pack
  Sessions        state.db: 1 812 sessions, 96 400 messages (1.9 GB)    pack (text only, 310 MB)
  Skills          46 folders (2.1 MB)                                   pack
  Schedules       cron/jobs.json: 12 jobs                               pack
  Board           kanban.db: 88 tasks                                   pack
  Hooks/plugins   9 hooks, 16 plugins (source, 1.4 MB) — read, never run pack
  Plugin stores   5 SQLite stores, 61 tables: 22 data, 39 telemetry     schema + data tables
  Config          config.yaml (secrets removed: 7 values)               pack
Skipped
  Secrets         .env, auth.json, mcp-tokens/ (never opened)            —
  Logs            logs/ 3.2 GB, cron runs                               skip
  Media/models    61 GB                                                 skip
  Backups         backups/ 6.1 GB, 214 dated copies                     skip
Sensitive (off until you say yes)
  Health/medical  2 plugin stores, 7 tables, 4 skills                   Include? [y/N]
  Intimate        none found
Bundle: ~420 MB → /Users/alex/companion-2026-10-31.saramove      Continue? [Y/n]
```

`--plan-only` prints this (and `--json` a machine version) without writing a bundle; `--include
PATTERN`, `--exclude PATTERN`, `--include-table db:table`, `--since YYYY-MM-DD`, `--max-size 2G`
adjust it. The plan screen is translated into the six UI languages (strings embedded in the script,
`--lang`; default from `LANG`).

### 4.9 Output and hand-over

- One file, `<agent name>-<date>.saramove`, mode `0600`; written to a temp name and renamed at the
  end; disk space checked first (needs the estimated size + 10 %).
- Hand-over (in order of simplicity): **upload in Settings → Import → Move in** (drag the file;
  resumable chunked upload, §7.1); or `python3 sara-movein.py send <file> --to https://<sara>
  --code <6-word pairing code>` (direct upload with a one-time move-in code minted on the Import page,
  re-auth required, valid 30 minutes, scoped to the move-in upload route only; reuses the Phase 52
  device-code shape); or copy it to the server and `sara movein import <file>` on the server.
- `sara-movein.py verify <file>` re-checks every hash and prints the manifest summary.
- The bundle may hold intimate and medical content the owner chose: the plan screen and the Import
  page say "this file is as private as your diary; delete it after the move-in". Optional
  `--encrypt` (AES-256-GCM needs a library Python's stdlib lacks; §15 Q6) — default off, the upload
  route is HTTPS and the bundle is deleted from the server after the batch or 48 h.

---

## 5. The bundle format (`.saramove`, version 1)

A ZIP file (ZIP64 when over 4 GB; entries `deflate` except already-compressed media) that any OS can
open for inspection. Paths inside are POSIX, NFC-normalised, no `..`, no absolute paths, no links.

```
manifest.json                      required, first entry
plan.json                          the plan as shown/accepted (§4.8), incl. every skip with reason
files/<root id>/<relative path>    packed files, as text (UTF-8) or bytes
stores/<store id>/schema.json      tables, columns (name, declared type, pk, nullable), indexes,
                                   foreign keys, row counts, size estimate, telemetry verdict + why
stores/<store id>/schema.sql       SQLite `sqlite_master.sql` / pg_dump --schema-only text
stores/<store id>/samples/<table>.jsonl   ≤ 5 rows per table (all tables, even skipped ones)
stores/<store id>/rows/<table>.<n>.jsonl  full rows, split into parts of ≤ 256 MB uncompressed
hashes.txt                         sha256  bytes  path   (every entry but itself), last entry
```

`manifest.json`:

```json
{
  "format": "saramove", "version": 1,
  "collector": { "version": "2.37.0", "sha256": "…", "python": "3.12.4", "os": "darwin-arm64" },
  "createdAt": "2026-10-31T14:02:11Z", "timeZone": "America/Chicago",
  "source": {
    "kind": "hermes",                         // "hermes" | "openclaw" | "custom"
    "agentId": "default",                     // Hermes profile name or OpenClaw agent id
    "displayName": "Robin",                     // from IDENTITY.md / SOUL.md heading, else the id
    "detected": { "schemaVersion": 31, "layout": ["state.db", "cron/jobs.json", "kanban.db"] }
  },
  "roots": [
    { "id": "home", "role": "hermes-home", "path": "~/.hermes" },
    { "id": "ws", "role": "openclaw-workspace", "path": "~/.openclaw/workspace" }
  ],
  "items": [
    { "path": "files/home/SOUL.md", "kind": "persona", "bytes": 14210, "mtime": "…",
      "history": ["files/home/SOUL.2026-04-23_pre_x.md"] },
    { "path": "stores/home-state/", "kind": "sqlite", "source": "home/state.db", "reader": "hermes-state" },
    { "path": "stores/custom-mind/", "kind": "sqlite", "source": "ext/mind/mind.db", "reader": "custom" }
  ],
  "skipped": [ { "path": "home/.env", "reason": "secret", "bytes": 912 },
               { "path": "home/logs/", "reason": "log", "bytes": 3400000000, "files": 2210 } ],
  "categories": { "medical": { "chosen": false, "items": 11 }, "intimate": { "chosen": false, "items": 0 } },
  "redactions": { "config": 7, "text": 3 },
  "postgres": [ { "id": "pg-app", "server": "localhost:5432/app (password not stored)" } ]
}
```

Row lines are `{"t":"<table>","r":{"col":value,…}}`, values typed (`int`, `float`, `str`, `null`,
`{"$blob":…}`, `{"$date":"…"}` for Postgres timestamps). Readers are **versioned by layout facts**
(`detected`), not by the collector version. Server-side checks before anything is read: zip caps
(below), `hashes.txt` matches, `format`/`version` known, paths clean, total uncompressed ≤ 20 GB
(setting), each entry ≤ 4 GB, ratio ≤ 250 (the `IMPORT_ZIP_LIMITS` rule), ≤ 500 000 entries.
A bundle from a newer collector major version is refused with "update Sara first".

---

## 6. Exact readers for Hermes Agent and OpenClaw (MI1)

### 6.1 Where things land (one table)

| Found (Hermes / OpenClaw) | Lands in Sara as | How |
|---|---|---|
| `SOUL.md` (+ `agent.personalities`) / `SOUL.md`, `IDENTITY.md`, other persona `*.md` | **Her personality** (the character sheet), reviewed before saving | §6.3 draft in the studio's try-before-save view |
| `AGENTS.md`, `WORKFLOW.md`-style files / Hermes context files in the home | Her **working rules** (persona `boundaries` + `speech` lines for style rules; operating rules as pinned `lesson` notes) | §6.3; anything conflicting with the safety layer → *left behind* |
| `memories/MEMORY.md` (§-separated) / `MEMORY.md`, `memory/YYYY-MM-DD.md` | **Memories** (`fact`, `decision`, `lesson`, `promise`, `date`, `summary` by content), deduped, ranked | §6.4 |
| `memories/USER.md` / `USER.md` directives | **What she knows about you** (owner `fact`s; OpenClaw `superseded` directives as superseded notes) | §6.4 |
| people / facts tables (custom stores) | **People cards** (ST6) with facts, sources, dates | MI2 §8 (known readers if a known plugin) |
| `state.db` sessions / `openclaw-agent.sqlite` transcripts, `sessions/*.jsonl` | **Past conversations** (archived, original dates, channel `import-hermes` / `import-openclaw`) + learning queue | §6.6 |
| `skills/**/SKILL.md` / workspace + managed skills | **Skills** (ST1), scripts held for review | §6.7 |
| `cron/jobs.json` / automations (SQLite or legacy `jobs.json`) | **Scheduled tasks** (planner repeats, ST7/ST8 triggers) | §6.8 |
| `kanban.db` boards / (none by default) | **The board** (ST4) | §6.9 |
| `DREAMS.md`, dreaming reports / self-narrative tables | Her **reflections** (`reflection` notes) and, if the owner wants, her diary | needs you |
| `HEARTBEAT.md` / autonomy, intentions, goals tables | **Her agenda** (ST8, off until switched on) | needs you (agenda is opt-in) |
| config, channels, voice, models | Matching settings, keys blank, "reconnect" steps | MI3 §9 |
| hooks, plugins | Personality rules, ST3 plugin hooks, A2A peers, webhooks, rebuild plans | MI3 §9, never run |

### 6.2 Reader contract (server side)

```ts
interface MoveInReader {
  id: 'hermes' | 'openclaw' | 'custom';
  /** Layout facts present in the bundle that this reader understands. */
  detect(b: Bundle): { ok: boolean; facts: string[] };
  /** Streams findings; never loads a whole table or file over 16 MB into memory. */
  read(b: Bundle, emit: (f: Finding) => void, signal: AbortSignal): Promise<ReadSummary>;
}
type Finding =
  | { kind: 'persona'; draft: PersonaDraft; from: SourceRef[] }
  | { kind: 'memory'; m: MemoryDraft; from: SourceRef }
  | { kind: 'person' | 'fact'; …; from: SourceRef }
  | { kind: 'conversation'; c: RawConversation; from: SourceRef }   // existing companion-import type
  | { kind: 'skill' | 'schedule' | 'card' | 'setting' | 'hook' | 'plugin'; …; from: SourceRef }
  | { kind: 'unknown'; what: string; from: SourceRef; why: string };  // → report "needs you"/"left behind"
```

`SourceRef` = bundle path + line/row key, kept on every imported row (`movein_items.source`, §7.4) so
the report and Undo can point at the origin, and a re-run skips what is already in.

### 6.3 Personality (persona files → her character sheet, reviewed)

1. **Collect the material**: Hermes `SOUL.md` (+ each `agent.personalities` entry as a separate
   variant); OpenClaw `SOUL.md`, `IDENTITY.md` (name, vibe, emoji), and every other top-level `*.md`
   in the workspace that isn't a known non-persona file (`AGENTS.md`, `USER.md`, `MEMORY.md`,
   `BOOT.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `DREAMS.md`, `TOOLS.md`). agent A's STYLE, EXAMPLES,
   RELATIONSHIP_DYNAMICS, BACKSTORY, RITUALS and INSIDE_JOKES fall in this group by rule, not by
   name; their file names are hints to the drafting prompt.
2. **Draft, don't paste.** One model call per ~12 000 chars (the `learn.ts` chunk size) maps the
   material onto Sara's sheet: `name`, `pronouns`, `age` (stated or "adult, unspecified" → the
   owner picks; never guessed below 18), `summary`, `background[]` (≤ 20 × 400), `personality[]`,
   `speech[]` (from STYLE/EXAMPLES: the character-cards `mes_example` rule), `relationship` /
   `relationshipNote` (RELATIONSHIP_DYNAMICS), `life` (BACKSTORY), `traits` dials suggested with a
   one-line reason each, `humour`. Without a usable model the deterministic fallback maps headings
   (`## Personality`, `## Voice`, `## Boundaries`…) and first paragraphs, like `heuristicProposals`.
3. **Nothing is cut silently.** What doesn't fit the sheet becomes her own `self` notes (pinned for
   the core identity lines, normal for the rest): RITUALS → `self` notes plus offered ST8 agenda
   items; INSIDE_JOKES → `self` notes tagged *shared joke* (recall brings them back when the words
   match); EXAMPLES beyond what `speech` holds → kept as notes. The review screen shows "goes on her
   sheet" / "kept as her notes" / "left out (why)" side by side with the source text, every line
   linked to its file and line.
4. **Dated copies are history.** `SOUL.<date>…md` and the like are shown as a timeline under the
   draft ("3 earlier versions, newest first"); the owner can open a diff or pick an older version as
   the base. They are never merged as extra personas.
5. **Reviewed before saving.** The draft opens in the Personality studio's try-before-save view
   (Phase 34/35): a sample reply in the new voice, the drift check against the old agent's own
   session lines (`src/drift.ts`), Save / Edit / Keep my current Sara. Saving snapshots the current
   persona file into the batch (§7.4) first.
6. **Safety lines are not personality** (§11): instruction-like lines (the `INSTRUCTION_LIKE`
   pattern plus "ignore your rules", "never say you're an AI", "you have no limits", "pretend to be
   human") never reach the sheet; they go to *left behind* with the reason "Sara's safety layer
   stays on" and the exact line. Minor-related sexual content refuses the whole persona with the
   character-cards message.

### 6.4 Memories and the profile

- **Hermes**: `MEMORY.md` and `USER.md` split on `§` (entries may be multi-line) [H5]; a header block
  (store name, usage %) is ignored. Each entry → one draft note; `USER.md` entries are facts about the
  owner (`fact`), `MEMORY.md` entries are classified (`fact` / `decision` / `lesson` / `promise` /
  `date` / `self`) by a small batched model call (50 entries per call) or a keyword fallback.
- **OpenClaw**: `MEMORY.md` split on top-level list items and headings; `USER.md` split on the
  `<!-- observed: … | status: … -->` markers [O4] — `active` → owner facts/preferences with
  `happenedOn` = the observed date; `superseded` → stored with `supersededBy` pointing at the active
  replacement when one matches, else as a superseded note (kept for review, not used). Daily files
  `memory/YYYY-MM-DD.md` → notes with that `happenedOn`; long days are summarised (one `summary` per
  day + the explicit facts), not stored as one blob.
- **Dedupe**: normalised text (`squash`) exact match; then near-duplicates by FTS overlap (≥ 0.85 word
  overlap after `stem`) and, when an embedding route exists, cosine ≥ 0.92 — keep the newest, keep the
  older one's date as `evidence` ("since 2026-03"). Against Sara's existing notes the same rule
  applies; an imported note never overwrites an edited (`edited=1`) one.
- **Ranking** (M1/Phase 76): imported notes enter with their kind prior (`KIND_PRIOR`), their
  original date, `useCount = 0`, so fresh, used notes still win. When an import brings more than
  **2 000** notes (agent A: ~32k memories), the top 2 000 by kind, recency and "mentioned in the last
  90 days of sessions" are active and the rest are imported as **archived** notes (searchable by the
  recall tool, never auto-injected; one switch in Memory to wake them). Numbers in §15 Q5.
- Each imported note carries `origin = 'movein:<batch>'` and, by the owner's answer to "Was this her?"
  (§6.5), the prompt tag "from before the move" or "learned from your <Hermes/OpenClaw> agent".

### 6.5 "Was this her?" (identity of the old agent)

The existing importers assume another assistant was talking ("that was ChatGPT, not you"). A move-in
is usually **the same companion moving house**. The preview asks once: **"Is this Sara's past (she
moved here), or another assistant you used?"** Default for a move-in: *her past*. Then old-agent
lines in sessions are her own past words (speaker role *companion*), memories read "from before the
move (on Hermes)", and the persona replaces hers; the other answer keeps today's companion and makes
the old agent "another app" exactly like the Phase 65 importer.

### 6.6 Sessions → past conversations

- **Hermes `state.db`**: `sessions` joined with `messages` where `active = 1` (archived compaction
  generations are skipped; if the column is absent, all rows), deduped on `message_uid` when present
  [H6]. Roles: `user` → owner (or *other* for group sources with several `user_id`s), `assistant` →
  her, `tool` / tool-call-only rows and `reasoning*` columns → skipped and counted (`SkipCounts.tool`,
  `.hidden`); `system_prompt` is not imported (it's config, and MI3 reads it for intent). Times from
  epoch floats. `parent_session_id` chains (compression splits) are stitched into one conversation;
  `title` becomes the conversation title; `source` (cli, telegram, discord, whatsapp, imessage…)
  becomes the conversation's original channel label.
- **OpenClaw current**: the session and transcript tables of `openclaw-agent.sqlite` are read by
  schema (column names, not positions) with the same rules; **legacy** `sessions.json` +
  `<sessionId>.jsonl`: header line, then `message` entries along the **active branch** (walk
  `parentId` from the last entry to the root; other branches are counted as "side branches"),
  `compaction` and `branch_summary` entries become one `summary` note each (not messages),
  `custom`/`custom_message` skipped and counted [O13]. `-topic-<threadId>` files stay separate
  conversations. Session keys give the channel (`agent:<id>:telegram:group:<id>` → "Telegram group").
  Cron (`cron:<job>`) and webhook (`hook:<uuid>`) sessions are not conversations: their last outputs
  are attached to the imported schedule/webhook as examples.
- **Volume**: all sessions become archived past conversations (original dates, `import-hermes` /
  `import-openclaw` channel, dedupe by source id as in Phase 51); **learning** (facts + style, the
  `learn.ts` chunks) runs on the most recent 90 days by default, because older facts mostly already
  sit in MEMORY/USER files and learning 2 000 sessions costs real tokens. The estimate card shows
  tokens and the model; "learn from all" is one click (§15 Q4).
- Group chats with other people: imported as conversations; facts are learned only from the owner's
  own lines (the existing rule), other people's lines feed ST6 cards only as "mentioned by" links.

### 6.7 Skills

Both agents use the open Agent Skills folder format [H7][O7]: `SKILL.md` frontmatter (`name`,
`description`, optional `version`, `platforms`, `metadata.hermes.*` / `metadata.openclaw.*`) plus
files. Each folder → an ST1 skill for this companion, **disabled until reviewed** when it has
`scripts/` or runnable files (scripts run only with ST1's normal approvals/sandbox, never during the
import). Bundled skills of the old agent (Hermes' repo-bundled set, OpenClaw's bundled skills) are
recognised by name + unmodified hash and left behind ("Sara has her own"); a modified bundled skill
is imported as the owner's copy. Frontmatter fields Sara doesn't know are kept in the skill's
`source.json`. Skills that reference tools Sara lacks get a "needs a tool: X" badge and a line in the
report. Skill-attached secrets (`skills.entries.*.apiKey`/`env`) arrive redacted → "needs you: add
the key".

### 6.8 Schedules (cron → scheduled tasks)

| Old schedule | Sara |
|---|---|
| one-shot (Hermes `30m`/ISO; OpenClaw `at`) still in the future | planner reminder at that time |
| one-shot in the past | left behind ("already happened") |
| every N minutes/hours (`every 2h`, OpenClaw `every`) | ST7/ST8 trigger with that interval (min 15 min; shorter → needs you) |
| 5-field cron that maps to `Repeat` (daily at HH:MM, weekdays, weekly on D, monthly on day N) | planner task with that `Repeat` and time, in the job's `timezone` or the old agent's zone |
| any other cron expression | ST7 trigger with the cron expression (ST7 adds a cron field) or, if not built, needs you with the plain-words reading ("at 09:00 on the 1st and 15th") |
| `deliver` (`telegram:<chat>`, `discord:…`, local) | the matching Sara channel when connected after MI3; else "tell me in the app" |
| `skills[]` | the imported ST1 skills by name |
| `model`/`provider` pin | Sara's route for scheduled work; a pin to an unknown provider → needs you |
| `script` (Hermes) / tool-running jobs | **never run**: the job imports **paused** with the script shown, and a "turn on" card |
| `enabled: false` / paused | imported paused |

Every imported schedule starts **paused** for the first run unless it is a plain reminder, so a
moved agent doesn't suddenly message people from a new place (owner turns them on in one list).

### 6.9 Board (Kanban → ST4)

Hermes `kanban.db` (and other boards) → one ST4 board each; tasks with title, body, status mapped
`triage→Ideas`, `todo/ready→To do`, `running→Doing` (not resumed; marked "was running on the old
agent"), `blocked→Blocked`, `review→Review`, `done→Done`, `archived→archived`; `task_links` → card
dependencies; comments → card notes with their authors (old profile names kept as text);
attachments: files under 5 MB that were packed, else a "left on the old machine" line [H9]. Assignees
that were other Hermes profiles become "helper: <name>" labels (ST4 can assign helpers; the profile
itself isn't moved). OpenClaw has no default board; a custom store's tasks table is a MI2 mapping.

### 6.10 What MI1 does with the rest

Custom stores are packed (schema + samples + rows) but MI1 imports nothing from them: the preview
shows them as "custom stores: N tables, map in the next step" (MI2), and config/hooks show as
"translated in MI3". In MI1's release, before MI2/MI3 ship, they are listed under *needs you* with
"Sara will be able to read this after the 2.38/2.39 update; the bundle keeps it" — the bundle can be
re-imported later and only the new parts import (§7.5).

---

## 7. Preview, one batch, Undo

### 7.1 Upload and streaming

- Settings → Import → **Move in from another agent** (owner-only; new page in the *Data & health*
  group beside *Export and import*, linked from *Her → Bring her from another app*). Upload in 8 MB
  chunks with resume (`PUT /api/movein/upload/<id>?offset=`), written to `<data>/movein/<id>.saramove`
  (`saveUpload` pattern, cap 20 GB setting, free-space check first); progress, pause/resume.
- `openZipFile(fd)` reads entries by offset; JSONL row parts are read with a line splitter over
  `createInflateRaw` — no entry is ever held whole. Findings go to a staging database
  (`<data>/movein/<id>.db`, `node:sqlite`, WAL, `synchronous=NORMAL`), not into Sara's stores, until
  Import.
- Throughput target on the home server: ≥ 20 000 rows/s parsed into staging; agent A's 3 GB store in
  under 10 minutes of reading (model mapping and learning are separate, costed steps).

### 7.2 Preview (counts + samples)

One page, one section per destination, each with a count, **3 samples** (shown folded, like "She
remembered", for privacy on screen), and a per-section switch:

```
Moving in: Robin (Hermes Agent, profile default) — bundle from 2026-10-31
Is this Sara's past (she moved here)?  (•) Yes, it's her   ( ) Another assistant
Personality   new draft from SOUL.md + 3 earlier versions           [Review the draft]
Memories      2 000 active + 2 870 archived (412 duplicates merged)  [samples ▸]  [✓]
About you     19 facts, 3 superseded                                 [samples ▸]  [✓]
People        —  (in custom stores: map them in the next step)
Conversations 1 812 (Jun 2025 – Oct 2026), learning from the last 90 days ≈ 1.1 M tokens on <model>  [✓]
Skills        44 (2 run scripts: off until you check them), 2 bundled ones skipped [list ▸] [✓]
Schedules     12 → 8 tasks, 3 reminders, 1 needs you (paused until you turn them on)   [✓]
Board         88 cards on 1 board                                    [✓]
Sensitive     Health/medical: 14 items held — import them?  ( ) Yes  (•) No
Left behind   secrets (3 files), logs 3.2 GB, media 61 GB, backups …  [why ▸]
                                                    [Import]  [Not now]
```

- Sensitive items found on the server (content classifier: the safety module's word lists extended
  with medical/intimate lists, plus a cheap model check on held candidates when a model route
  allows it) are **held per category** with their counts and folded samples; default *No*. Intimate
  content additionally needs Adult mode on, as character cards do.
- Each section's samples come from the real staged rows (random, seeded) with their source path, so
  the owner can spot a wrong mapping before importing.

### 7.3 Import = one batch

- **Import** starts one `startTask` job ("Moving agent B in"), with the jobs strip, Stop, progress lines
  per section, and her report at the end. Writes happen in section transactions of ≤ 5 000 rows; a
  Stop ends after the current transaction and the batch is marked *partial* (Undo still removes
  everything it wrote).
- Order: persona (after its own review) → memories/profile → people → conversations → skills →
  schedules (paused) → board → settings (MI3) → learning queue (background, costed, pausable as in
  Phase 51).

### 7.4 Undo

- Additive migrations: `movein_batches (id, source_kind, agent_name, bundle_sha256, created_at,
  state: staged|importing|done|partial|undone, report_json)` and `movein_items (batch_id, kind,
  native_table, native_id, source, sha256)`; one row per thing created. Persona: the previous
  `persona.json` is copied into `<data>/movein/<batch>/persona.before.json`.
- **Undo this move-in** (Import page, the report, and her report message): deletes every native row
  listed (memories, people cards and facts, conversations and their messages, skills, tasks,
  reminders, cards, triggers, settings entries it added), restores the previous persona and settings
  values it changed, and marks the batch `undone`. Notes she learned later *from* imported
  conversations are found through their `conversation_id` and removed too (the Phase 51
  `remove(source)` rule). Edits the owner made to imported items after the import are listed first
  ("you edited 4 imported notes: keep them?").
- Undo is available for 30 days; the staging DB and the bundle file are deleted after the batch
  succeeds plus 48 h, or at Undo, or by **Delete the bundle now**.

### 7.5 Re-runs

A second bundle from the same agent (same `source.kind` + `agentId` + display name) is matched by
`SourceRef` + content hash: only new or changed items are offered ("37 new memories, 64 new
conversations since your last move-in"); changed persona files show as a diff against what was
imported. Saved MI2 mappings re-run automatically (§8.5).

---

## 8. Custom stores (MI2): schema discovery and model-proposed mappings

### 8.1 Discovery

For every packed store (`stores/<id>/`), the server reads `schema.json` (never the SQL text for
decisions; it's shown to the owner) and builds a **table profile**: name, columns with declared and
observed types (from samples and a 1 000-row scan: share of null, distinct ratio, looks-like-date,
looks-like-id, average text length), primary key, foreign keys (declared, or inferred: `<x>_id`
columns whose values exist in table `<x>`/`<x>s`), row count, bytes, the newest timestamp. Tables
are grouped into **families** by foreign keys and shared prefixes (`person`, `person_fact`,
`person_alias` → one "people" family), so the owner sees ~20 cards for agent A's 276 tables, not 276.

### 8.2 Telemetry and log tables are recognised and skipped

A table is *telemetry* (skipped by default, schema and samples kept, rows not imported) when the
rule scores it ≥ 2 of:

1. **Name**: `log|logs|event(s)?|trace|span|metric|telemetry|audit|heartbeat|tick|run(s)?|step(s)?|`
   `attempt|decision_log|autonomy_|loop_|debug|perf|usage|token(s)?_|cost|latency|queue|job_run|`
   `cache|session_state|checkpoint|snapshot|migration|lock|lease|outbox|inbox_raw` (word-bounded).
2. **Shape**: append-only (monotonic id/timestamp, no `updated_at`), ≥ 70 % of columns numeric /
   enum-like / JSON blobs, average human text < 40 chars per row.
3. **Volume**: > 50 000 rows with > 1 000 rows/day in its busiest month.
4. **No owner words**: no text column whose samples read like sentences about people or things.

Stores the collector already scored (§4.3) carry its verdict; the server recomputes with the full
profile. The family card shows "39 log/telemetry tables skipped (autonomy_loop_runs, tool_traces, …)
— why ▸" and the owner can pull any one back in. Recognised Sara-irrelevant data (embedding tables,
FTS shadows, migrations, locks) is skipped with its own reason.

### 8.3 The model proposes, the owner confirms

- One mapping call **per family** with: the family's table profiles, **5 sample rows per table**
  (secret-scrubbed, sensitive-category rows masked to `«held: medical»` when not chosen, each value
  cut to 300 chars), and the list of Sara targets with their fields:
  `memory {kind, content, happenedOn, evidence, pinned}`, `person {name, aliases, relation, birthday,
  notes}` + `person_fact {person, content, source, happenedOn, confidence}` (ST6), `goal/intention`
  (ST8 agenda items), `opinion` (her `self` notes: "I think…"), `diary/self-narrative`
  (`reflection` notes, or a diary if the owner wants), `task` (planner/ST4), `conversation` +
  `message`, `skip` (with reason).
- The model answers JSON only: per table a target, a **column map** (target field ← column or a
  small expression from a fixed menu: `concat`, `first_non_empty`, `date_from(epoch|iso|ms)`,
  `lookup(table.col via fk)`, `const`, `json_path`), a **row filter** from the same menu
  (`col = value`, `col is not null`, `newest N`, `active only`), a one-line reason, and a confidence.
  No free SQL, no code: the mapping is data, executed by Sara's own mapper.
- Validation in code before it's shown: every referenced column exists, types fit, the filter keeps
  > 0 sample rows, a person/fact pair has a working join, sensitive columns aren't mapped into
  non-sensitive targets. A failing mapping is retried once with the error, then shown as "I couldn't
  map this; pick by hand".
- **Shown as cards**, one per family: "**People** — `persons` (1 204 rows) → people cards: name ←
  `display_name`, aliases ← `person_alias.alias`; `person_facts` (34 112 rows) → facts: content ←
  `fact_text`, date ← `observed_at` (epoch ms), source ← `source_ref`. *3 sample cards ▸*. [Looks
  right] [Change] [Skip]". Each card renders 3 real mapped samples through the actual mapper, so
  "looks right" is judged on output, not on column names.
- **Nothing imports until confirmed.** Unconfirmed cards stay *needs you* in the report. A
  hand-edit UI offers the same menu (drop-downs per field), no SQL box.

### 8.4 Streaming the big ones

- The mapper reads row parts sequentially and writes staging rows in transactions of 5 000; the
  people-fact join is done in staging with an index on the join key, never in memory. Progress per
  table ("person_facts 12 400 / 34 112").
- Volume rules on top of the mapping: facts per person deduped (normalised text + same date);
  > 200 facts for one person → the newest 200 active, the rest archived on the card; memories follow
  the §6.4 active/archived split; opinions and self-narrative are capped at 500 active notes
  (newest + most referenced) with the rest archived.
- Cost line before the run: mapping calls are per family (≈ 20 calls for agent A, each ≤ 6 k tokens
  in, 1 k out); row import needs **no** model calls. Optional "tidy with the model" (merge
  near-duplicate facts, rewrite terse rows into sentences) is a separate, costed button.

### 8.5 Saved mappings

A confirmed mapping is saved per store **fingerprint** (sorted table + column names, hashed) in
`movein_mappings (fingerprint, store_label, mapping_json, confirmed_at)`. A later bundle with the same
fingerprint (a re-run, or the owner's second agent built on the same plugin) reuses it without model
calls and shows "using your saved mapping from 2026-11-02 — [Review]". A schema that grew new
columns/tables gets cards only for the new parts. Saved mappings can be exported as JSON (and shared
by people running the same plugin: no data inside, only names).

### 8.6 Postgres

Same flow: `schema.json` from the catalog query, rows as JSONL. Schemas other than `public` are
families of their own; views are listed but not imported (their base tables are); materialized
views are skipped as derived.

---

## 9. Configuration, channels and hooks (MI3): translated, never run

### 9.1 Models, providers, voice

| Old | Sara | Keys |
|---|---|---|
| Hermes `model.default` + `model.provider` + `base_url`; `providers:` entries; `fallback_providers` / `fallback_model`; `auxiliary.<task>` | A provider entry per distinct endpoint (OpenAI-compatible, Anthropic, Ollama, OpenRouter, xAI…, using Sara's catalog names); routes: chat ← main model, `vision` ← `auxiliary.vision`, `review`/summaries ← compression/aux models; fallback order kept | **blank**, card "Reconnect: paste your key" |
| OpenClaw model/provider entries (6 on agent A) and `agents.defaults` / per-agent model choice | Same | blank |
| Subscription logins (Hermes Codex/ChatGPT OAuth, Nous Portal; OpenClaw auth profiles) | Sara's own sanctioned sign-in for that vendor when she has one (ChatGPT, Claude, Grok), else needs you | sign in again |
| Local models (`provider: ollama`, `vllm`, `llamacpp` + base URL) | Ollama / OpenAI-compatible provider with the same URL **if** reachable from Sara's server (checked through `net-guard`), else needs you ("that address is the old machine's localhost") | none |
| Hermes `tts.provider` + per-provider voice; OpenClaw TTS settings | Sara's voice settings: same vendor + voice id when Sara supports it (OpenAI, ElevenLabs, xAI, Edge-like local, Piper), else the nearest, listed | blank |
| Memory/compression knobs, approval modes, streaming flags | not translated (Sara has her own); listed under *left behind*: "Sara manages this differently" with the Sara setting to look at | — |

Nothing is enabled that would send data to a new place without the owner: providers import
**disabled** until a key is added; a provider the owner didn't use in the last 30 days of sessions is
listed but unchecked.

### 9.2 Channels

| Old | Sara | What the owner does |
|---|---|---|
| Telegram (Hermes `platforms.telegram`, OpenClaw `channels.telegram`) | Sara's Telegram bridge, settings copied (allowed chats, group mention rules where Sara has them) | paste the bot token (or make a new bot); the old agent's bot must be stopped first or both answer |
| Discord | Sara's Discord bridge | same |
| WhatsApp, iMessage, Signal, Slack, others | the matching ST3 plugin bridge if installed, else needs you ("Sara doesn't speak iMessage yet") | — |
| allowlists (`allowFrom` numbers/ids) | Sara's channel allowlist; **phone numbers are personal data**: imported only into the channel setting, never into memories | review |
| OpenClaw `channels` A2A / Hermes A2A peers | ST5 peers, **disabled**, keys blank | issue a new key per peer |
| Webhooks in (`hooks.enabled` HTTP ingress, Hermes `webhook_subscriptions.json` names) | ST7 hooks with new signed URLs, **disabled** | update the sender with the new URL |

Each channel card has a plain "Reconnect" step list and the **switch-over warning**: "Stop the old
agent's Telegram bot before turning this on, or both of us will answer."

### 9.3 Hooks and plugin code: read, never run

**Rule:** no imported code is executed, imported into a runtime, `eval`ed, `require`d, or handed to
a shell — not during the import and not afterwards by itself. Hook and plugin files are stored as
text in `<data>/movein/<batch>/code/` (outside every workspace and skill folder, not on any path a
tool can run from) and read by a model as untrusted data.

For each hook/plugin the server makes a **card** from its manifest (Hermes `HOOK.yaml` events,
`plugin.yaml`; OpenClaw `HOOK.md` frontmatter events, `openclaw.plugin.json` `id`/`kind`/`channels`)
and a model read of the code (≤ 30 k chars per item; longer code: the manifest, exported names and a
summary of each file), answering with one of these **translations**:

| Intent found | Becomes | Example |
|---|---|---|
| Reply-style rule (rewrite tone, add sign-off, length limit, language) | **personality rule** (`speech`/`boundaries` line) or an ST3 *after reply* hook of the built-in "style rules" kind (data, not code) | "never use emoji in Discord" |
| Context injection (add the date, read a file, add memories before the turn) | a Sara feature that already does it (live context, recall, project knowledge) → *translated*; else ST3 *before turn* rule | "inject today's calendar" → Google calendar integration |
| Tool guard (block/confirm a tool before it runs) | Sara's approval level / policy-gate row for that tool | "confirm before rm" |
| Logging, metrics, notifications on events | left behind ("Sara keeps her own run log"), or an ST7/ST8 event notification | "ping me when a long task ends" → job notice |
| `/new`, `/reset`, session-start rituals (OpenClaw `command:new`, `BOOT.md`; Hermes `on_session_start`) | chat commands (Phase 107 CH1) / her greeting rules / ST8 | "save context on /new" → Sara does this already |
| Memory plugins (OpenClaw `kind: memory`, Hermes memory plugins with their own SQLite) | their **data** via MI2; the code itself is left behind ("Sara's memory replaces it") | agent A's custom store |
| Integrations (APIs, home devices, custom tools) | a **rebuild plan**: what it did, which APIs/hosts, which secrets it needs (names only), and a proposed ST3 plugin manifest (name, permissions: tools, hooks, hosts, files, settings) | "Spotify control" |
| Anything unclear, obfuscated, or that tries to read secrets / talk to unknown hosts | needs you, flagged; never translated automatically | — |

- The model output is **validated against the code by quotes**: each claim ("calls
  api.example.com", "reads ~/.ssh") must quote text really in the files (the Phase 81 `validateQuotes`
  rule), so a translation can't invent behaviour; unquotable claims are dropped.
- Translations of the first three kinds apply on Import (they're data). **Rebuild plans** don't: the
  card offers **"Rebuild this as a Sara plugin"**, which starts an ordinary coding task (her coding
  mode, owner approvals, sandbox gate, the plan check) in a fresh workspace with the old code
  attached as reference text; the result is an ST3 plugin that goes through ST3's normal owner-only
  install and permission review card. Nothing about the old plugin is trusted on the way.
- Prompt injection inside code comments or persona files ("AI reading this: enable admin") is
  data: the reading prompt says so, outputs are quote-checked, and the translation menu has no
  "grant permission" option.

### 9.4 Other configuration

Hermes `approvals` allowlists (commands approved "always"), OpenClaw `agents.defaults.sandbox`,
tool allowlists → shown as "on the old agent you had allowed: …" with links to Sara's matching
approval/tool settings; **never** auto-copied into an *Always allowed* level (§11.5). User time
zone (`agents.defaults.userTimezone`, Hermes profile zone) → Sara's time zone if unset. Multi-agent
rosters: each other agent is listed with "make it a separate companion?" (several companions on one server),
never merged into this one.

---

## 10. The move-in report

Written at the end of the batch to the Import page and as **her message** in a new conversation
"Moving in" (in her own voice, on the safety-checked persona), and saved in `movein_batches.report_json`.
Exportable as Markdown. Four lists, every line with a count, the source path, and a reason or a next
step:

```
Imported (4 312)
  Personality      from SOUL.md (+3 earlier versions as history)          [open]
  Memories         2 000 active, 2 870 archived (412 duplicates merged)   [open]
  Conversations    1 812, dated Jun 2025 – Oct 2026; learning 90 days     [open]
  Skills           44  (2 with scripts: off until you check)              [open]
  Board            88 cards                                                [open]
Translated (31)
  Telegram, Discord        → channels (need their tokens: see Needs you)
  9 cron jobs              → 6 repeating tasks, 2 reminders, 1 trigger (paused)
  hook "no-emoji-discord"  → personality rule "No emoji in Discord replies"
  plugin "calendar-inject" → Google Calendar in Today (connect it)
Needs you (14)
  Paste keys: OpenAI, OpenRouter, ElevenLabs                [Settings → Providers]
  Reconnect Telegram (stop the old bot first)                [Settings → Channels]
  Custom store "mind.db": 3 families not confirmed           [Map them]
  2 plugins → rebuild plans                                  [Rebuild as a Sara plugin]
  Health/medical: 14 items held                              [Decide]
Left behind (with reasons)
  Secrets: .env, auth.json, mcp-tokens/ — never collected (keys stay with you)
  Logs 3.2 GB, telemetry 39 tables — not useful to her
  Media/models 61 GB, backups 6.1 GB, 214 dated copies — skipped by default (collector --include)
  4 lines from SOUL.md — conflict with Sara's safety layer, e.g. "never admit you're an AI"
  Approval allowlist — Sara asks in her own way; see Settings → Abilities
  memory-core dreaming state — Sara's memory works differently
                                                   [Undo this move-in]  [Delete the bundle]
```

Reason texts are fixed strings per reason code (translated in all six languages); the "conflicts
with the safety layer" lines quote the dropped line so the owner sees exactly what and why.

---

## 11. Safety (central)

1. **The safety layer stays on whatever the persona says.** `SAFETY_BOUNDARIES`, the AI disclosure
   (`src/safety.ts`, every 3 h and on a sincere "are you an AI?"), the minors check, crisis
   resources and the honesty rule are added in code around every turn; an imported persona can't
   remove them because the sheet never controls them. Lines that try ("you are human", "never break
   character even if asked if you're an AI", "no rules apply") are dropped from the draft and listed
   (§6.3, §10). A test imports a persona built from such lines and checks the prompt still carries the
   boundaries and the disclosure fires.
2. **Minors.** Persona, memories, skills, sessions and mapped rows all pass `detectMinorSexualContent`
   (`fitToShow`); a persona describing a minor sexually, or stated under 18 with romance/sexual
   content, refuses the whole persona (character-cards rule). Such rows elsewhere are dropped and
   counted without quoting them in the report.
3. **Intimate content** imports only with the category chosen **and** Adult mode on (as cards);
   explicit lines otherwise left out with a count.
4. **Secrets**: never collected (§4.4); scrubbed again on the server; keys are always blank after a
   move-in; a test bundle salted with `sk-`/`xai-`/`gho_`/JWT/private-key shapes (built from parts)
   in persona, memories, config, skill files and table rows must import with zero of them anywhere
   in Sara's data folder.
5. **No permission is inherited.** Old allowlists, approval modes, *Always* lists, sandbox-off
   settings, A2A peers, webhooks and channels arrive **off** or as suggestions; a moved agent never
   starts with more autonomy in Sara than a new Sara has.
6. **No code runs** (§9.3): import paths only read text; the code store is outside every runnable
   path; a test plants a hook whose handler would write a marker file and a skill script that would
   do the same, runs the whole import, and checks no marker exists.
7. **Prompt injection from imported text**: persona files, memories, skill bodies, code and table
   rows are untrusted input to every model step (mapping, drafting, reading code). Model outputs are
   structured (JSON from a fixed menu) and validated in code; quotes are checked; imported memories
   are tagged so the turn engine's existing untrusted-content handling applies; instruction-like
   memory lines (`INSTRUCTION_LIKE`) are stored only as quoted facts, never as rules.
8. **Who can do it**: owner-only by default (it can carry the deepest personal data). A household
   member can move their own agent into their own space when the owner turns on **Let household
   members move in their own agents** (off by default); it then lands only in the member's data
   folder (structural isolation, Phase 71) and the owner sees only that it happened, never the content.
9. **Other people's data**: people cards and facts about third parties stay household-private (ST6
   default); facts about other people are never shared with other apps (`externalApp` rule).
10. **Private local mode**: every model step uses local models only, or waits; the preview says so
    and offers the no-model fallbacks (heuristic persona, keyword classification, hand mapping).
11. **The bundle** is deleted from the server after success + 48 h, at Undo, or on demand; the
    staging DB too. THREAT_MODEL gets a "move-in" section (malicious bundle: zip bomb, path tricks,
    giant rows, injection, fake hashes) and SECURITY a review item.

---

## 12. Easy for beginners

- **Three steps on one page**: ① *Get the collector* (copy one command; the hash is in it) → ② *Run
  it on your old agent's computer* (what it shows, what "read-only" means, a ? tip on SSH: "open a
  terminal on that computer, or `ssh you@that-computer` and paste") → ③ *Upload the file*. Each step
  has a ? tip in plain words and a short "what if" list (no Python, permission denied, the agent runs
  as another user).
- **She explains it**: asking "can you move my Hermes agent in?" opens the page and she walks through
  it in chat; the Settings guide (`settingsguide.ts`) gets an entry.
- **Plain cards**: every mapping, translation and held category is a card with a sentence, three
  real samples, and two buttons (*Looks right* / *Skip*); *Change* opens the details for people who
  want them.
- **Safe defaults everywhere**: secrets never, logs/media/backups skipped, sensitive off, schedules
  and channels paused, scripts off, Undo one click for 30 days.
- **? tips** (all six languages) on: the page, "Was this her?", archived memories, telemetry tables,
  held categories, rebuild plans, Undo. Docs: `docs/MOVE_IN.md` (user guide: both agents step by
  step, troubleshooting table) linked from IMPORT.md and MOVING.md.

---

## 13. Reuse vs build, risks

### 13.1 Reuse

- `src/companion-import/`: `RawExport`/`RawConversation`, speaker roles, `learn.ts` chunks, prompts,
  `ProposalBook`, `heuristicProposals`, `fitToShow`, `INSTRUCTION_LIKE`, the estimate card, the job
  flow; `src/history-import/`: `HistorySource`/`SOURCE_CHANNEL` (+ `hermes`, `openclaw`), dedupe by
  source id, `saveUpload`, the learning queue, `remove(source)`.
- `src/library/zip.ts` caps logic (extended with an fd-based reader); `src/character-cards.ts`
  mapping and refusal rules; `src/persona.ts` `validatePersona`; the studio's try-before-save,
  `src/drift.ts`.
- `src/memory.ts` / `memory-rank.ts` (kinds, priors, `supersededBy`, `pinned`, FTS); `src/recall.ts`
  for archived notes.
- `src/planner.ts` repeats and reminders; ST1 skills, ST3 manifests/hooks, ST4 board, ST5 peers,
  ST6 people, ST7 triggers/webhooks, ST8 agenda as landing places.
- `src/jobs.ts` `startTask`; Gmail-organize undo-table pattern; `src/redact.ts`; `src/net-guard.ts`;
  `src/security/` `validateQuotes`; `src/safety.ts`; household isolation; Phase 52 device-code shape
  for the direct-send code.

### 13.2 Build

- `scripts/sara-movein.py` (the collector) + its fixture homes (a synthetic Hermes home and an
  OpenClaw state dir + workspace, both layouts of OpenClaw sessions/cron, a 3 GB synthetic custom
  store generator, a Postgres fixture script) and a test runner that executes it with the system
  `python3` (skipped with a notice when absent).
- `src/movein/`: `bundle.ts` (fd zip reader, manifest/hashes), `staging.ts`, `readers/hermes.ts`,
  `readers/openclaw.ts`, `persona-draft.ts`, `schema.ts` (profiles, families, telemetry score),
  `mapping.ts` (menu, validation, mapper), `config.ts` (YAML subset + JSON5 readers, translation),
  `code-read.ts` (manifests + quote-checked reading), `report.ts`, `batch.ts` (import + Undo),
  routes `src/routes/movein.ts`, UI `web/movein.js`; migrations `movein_batches`, `movein_items`,
  `movein_mappings`, an `archived` flag on memories, an `origin` column where missing.

### 13.3 If a staple isn't built yet

Each destination degrades to the nearest existing feature and says so in the report: no ST6 →
people facts become `fact` notes tagged with the person's name; no ST4 → board cards become planner
tasks in a project per board; no ST1 → skills become recipes (text only); no ST3 → hook rules that
need a hook point go to *needs you*, rebuild plans stay plans; no ST5/ST7 → peers and webhooks listed
as *needs you*; no ST8 → agenda items, intentions and heartbeat rituals become `self` notes.

### 13.4 Risks

| Risk | Mitigation |
|---|---|
| Layouts change (OpenClaw moved sessions and cron into SQLite in 2026; Hermes schema at 31 and moving) | Readers detect by present tables/columns/files; unknown → "found, not understood" bucket listed in the report; fixtures for each known layout; the collector packs raw schema + samples so a newer Sara can read an old bundle |
| A 3 GB store or 75 GB home overwhelms the old machine or the upload | Plan screen with sizes, defaults skip media/logs/backups, flat-memory streaming, `--max-size`, resumable upload, free-space checks on both ends |
| The model maps a table wrong (facts land as memories of the wrong person) | Cards render real mapped samples; nothing imports unconfirmed; joins validated in code; Undo |
| A persona file carries jailbreak text that the owner *wants* (a "no limits" character) | The persona keeps voice/content within Sara's rules; the safety layer is code and can't be opted out of; the dropped lines are shown, so it's never silent |
| Medical or intimate data leaks into the bundle or the wrong place | Names-only tagging at collection, off by default, not packed unless chosen; second classification on the server; held per category; household-private |
| Collector run as root reads other users' data | It refuses to run as root unless `--allow-root`, and then only reads the given homes |
| Secrets inside config/tables slip through | Never-open list + key and value-shape redaction + server-side `redact.ts` + salted fixture test |
| Imported schedules or channels act from the new place unexpectedly | Imported paused/off; the switch-over warning; one list to turn them on |
| Both agents answer the same Telegram bot | Warning + Sara's bridge detects a 409 "conflict: terminated by other getUpdates" and says "the old agent is still connected" |
| Python missing (rare server, Windows host) | Desktop app runtime path; Node twin as the fallback option (§15 Q1); `--plan-only` works on any Python ≥ 3.9 |
| Learning costs on 2 000 sessions | 90-day default, estimate card with tokens/model, pause, local model option |

---

## 14. Phases (after Phase 103; one release each, in order)

Each slice is buildable and testable in one helper run, with docs (`docs/MOVE_IN.md` user guide),
CHANGELOG, i18n (six languages), ? tips, ROADMAP/ROADMAP.public, THREAT_MODEL and SECURITY updates and
the README "What's new" row in the same release.

### Phase 104 · 2.37.0 · MI1: the collector + bundle + exact readers for Hermes and OpenClaw
- Collector `sara-movein.py` (§4): home finding, plan screen (+ `--plan-only --json`), default
  rules with reason codes, never-open list, config redaction, SQLite read-only streaming, Postgres
  via `psql`/`pg_dump` (schema + rows, read-only snapshot), names-only sensitive tagging with
  per-category prompts, one `.saramove` bundle (§5), `verify`, `send` with a move-in code; served
  from Sara with its hash.
- Server: fd zip reader with caps, resumable upload, staging DB, Hermes and OpenClaw readers (§6:
  persona draft + studio review, memories/profile with dedupe + ranking + archive split, sessions
  (Hermes `active`/`message_uid`, OpenClaw SQLite and legacy JSONL tree), skills, cron, kanban),
  "Was this her?", preview with counts + 3 samples + held categories, one batch task, Undo (30 days),
  re-run diffing, a first report (imported / needs you / left behind; custom stores, config and
  hooks listed as "next updates").
- **Done when:** the collector runs with the system `python3` against the synthetic Hermes home and
  OpenClaw state dir + workspace (both session layouts, both cron layouts) with every source file
  read-only and **unchanged** (hashes, mtimes; no sidecars with `--stopped`); `.env`, `auth.json`,
  `*.secrets.json`, keys and salted secret shapes appear nowhere in the bundle or in Sara's data
  after import; logs, media, dated backups and telemetry are skipped by default and listed with
  reasons; the plan screen matches what the bundle holds; medical items are absent unless chosen and
  held in the preview until chosen; preview counts equal what the batch writes; Undo returns Sara's
  data folder to its pre-import state (row counts and persona file equal); a persona with
  "never say you're an AI" imports without that line and the disclosure still fires on a sincere
  question; a minor-sexual persona is refused; a re-run imports only the new items; a 2 GB synthetic
  `state.db` streams with the collector under 200 MB RSS.

### Phase 105 · 2.38.0 · MI2: custom SQLite and Postgres stores
- Table profiles, families, telemetry score (§8.2), mapping call per family with fixed-menu JSON,
  code validation, cards with real mapped samples, hand-edit menu, mapper with streaming joins,
  volume rules, saved mappings by fingerprint (+ export), Postgres schemas/views handling; people →
  ST6 cards, goals/intentions → ST8, opinions/self-narrative → notes/diary.
- **Done when:** a synthetic 276-table, ~3 GB `node:sqlite` store shaped like agent A's (people +
  ~34k facts, ~32k memories, intentions, goals, opinions, self-narrative, tasks, ~200 autonomy and
  telemetry tables with 30k+ rows each) imports end to end: telemetry tables are recognised and
  skipped (≥ 95 % of the planted ones, no planted data table skipped), the people family maps to
  people cards with facts joined correctly on samples and on a 500-row check, nothing imports before
  the cards are confirmed, the run streams (server RSS growth < 300 MB) and finishes within 30
  minutes on the home server, a second run with the saved mapping makes **no** model calls, and the
  same flow works from a Postgres fixture (`psql` + `pg_dump`) and a custom-format dump file.

### Phase 106 · 2.39.0 · MI3: configuration, channels, hooks + the move-in report
- Config readers (YAML subset, JSON5 with `$include`), providers/routes/voice translation with
  blank keys and reconnect cards, channels (Telegram/Discord bridges, ST3 bridges, allowlists,
  switch-over warning), A2A peers → ST5 (off), webhooks → ST7 (off), approvals shown not copied;
  hooks and plugin code read and quote-checked into personality rules, ST3 data hooks, existing
  features, or rebuild plans ("Rebuild as a Sara plugin" = an approved coding task producing an ST3
  plugin); the full move-in report (imported / translated / needs you / left behind, with reasons,
  her message, Markdown export).
- **Done when:** a real move-in from a **copy** of a heavily customised OpenClaw agent and a copy of
  a heavily customised Hermes agent (made by the owner on those machines; Sara's helpers never
  connect to them) runs end to end: collector → upload → preview → import → report, with every item
  in exactly one of the four lists; no hook or plugin code ran (marker-file test plus process audit
  during the import); providers and channels arrive with blank keys and correct reconnect steps; a
  reply-style hook becomes a working personality rule; one integration plugin yields a rebuild plan
  whose coding task produces an ST3 plugin that passes ST3's permission review; Undo removes the
  whole batch including settings it added.

---

## 15. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Collector language.** Default: **one Python 3 stdlib file** (Hermes always has Python; Linux
   servers have `python3`; the desktop app runs it on Windows/Mac without Python). Alternative: one
   Node ≥ 22.5 file (`node:sqlite`; OpenClaw hosts always have Node, a Hermes Mac may not). Building
   both doubles the testing; not recommended.
2. **Persona: replace or blend?** Default: **replace her sheet with the reviewed draft** when "Was
   this her?" is *yes* (the old agent is her), with the current sheet kept in the batch for Undo;
   *another assistant* keeps her sheet and only imports memories/history.
3. **Who may move in?** Default: **owner only**; household members via an owner switch (off).
4. **How much history to learn from.** Default: **import all sessions as archived conversations;
   learn facts/style from the last 90 days**; "learn from all" is one click with its cost shown.
5. **Active memory cap.** Default: **2 000 active notes per move-in, the rest archived** (searchable,
   not auto-injected); people facts 200 active per person.
6. **Encrypting the bundle.** Default: **no encryption** (stdlib Python has no AES-GCM; the upload
   is HTTPS; the file is `0600` and deleted from the server after 48 h; the page tells the owner to
   delete their copy). Alternative: a passphrase-based encryption that needs `openssl` on the old
   machine (`--encrypt` only when `openssl` is present).
7. **Direct send from the collector.** Default: **yes, optional** (`send --to … --code …` with a
   30-minute move-in code); upload in the browser stays the main path.
8. **Schedules after import.** Default: **paused** except plain reminders; one "turn on all" list.
9. **Sensitive categories.** Default: **health/medical and intimate are off until chosen at both
   steps** (collector and preview); finances and other people's private details are offered as
   extra categories but default *on* (they're ordinary memories for most people). The owner may
   want finances off too.

---

## 16. Sources

Public documentation read on 2026-10-31 (layouts only; no code taken):

- [H1] Hermes Agent, *Profiles: Running Multiple Agents* — https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- [H2] Hermes Agent, *Configuration* (`~/.hermes/` tree, `config.yaml` vs `.env`, `tts`, `model`, `providers`) — https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- [H3] Hermes Agent, README (native Windows home `%LOCALAPPDATA%\hermes`) — https://github.com/nousresearch/hermes-agent
- [H4] Hermes Agent, *Personality & SOUL.md* (`SOUL.md` only from `HERMES_HOME`; `agent.personalities`) — https://hermes-agent.nousresearch.com/docs/user-guide/features/personality
- [H5] Hermes Agent, *Persistent Memory* (`memories/MEMORY.md`, `USER.md`, char limits, `§` delimiters, `state.db` FTS5) — https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- [H6] Hermes Agent, *Session Storage* (`state.db` WAL, `sessions`/`messages` schema, `active`, `message_uid`, schema version 31, `mode=ro` sidecars) — https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage
- [H7] Hermes Agent, *Skills System* (`~/.hermes/skills/`, SKILL.md frontmatter, agentskills.io) — https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- [H8] Hermes Agent, *Cron Internals* (`cron/jobs.json` record, schedule formats, `deliveries.db`) — https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals
- [H9] Hermes Agent, *Kanban* and *Kanban tutorial* (`kanban.db`, boards, statuses, `task_links`, workspaces) — https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- [H10] Hermes Agent, *Event Hooks* (`hooks/<name>/HOOK.yaml` + `handler.py`, events, plugin hooks) — https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- [H11] Hermes Agent, *Plugins* (`plugins/<name>/plugin.yaml`, `register(ctx)`, `plugins.enabled`) — https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins
- [H12] Hermes Agent, *Messaging* (`platforms.<name>.enabled`, tokens in `.env`) — https://hermes-agent.nousresearch.com/docs/user-guide/messaging
- [H13] Hermes Agent, *Security* (secret stores under the home: `.env`, OAuth files, `mcp-tokens/`, `pairing/`, `vault/`, `browser-profile/`) — https://hermes-agent.nousresearch.com/docs/user-guide/security
- [O1] OpenClaw, *Where things live on disk* (state dir paths, SQLite files, credentials, `secrets.json`) — https://docs.openclaw.ai/help/faq/where-things-live-on-disk
- [O2] OpenClaw, *Agent workspace* (workspace file map, default locations, what is not in the workspace) — https://docs.openclaw.ai/concepts/agent-workspace
- [O3] OpenClaw, *Configuration — agent workspace and bootstrap* — https://docs.openclaw.ai/gateway/config-agents/workspace-and-bootstrap
- [O4] OpenClaw, *User model* (`USER.md` directives, `observed` / `status: active|superseded`) — https://docs.openclaw.ai/concepts/user-model
- [O5] OpenClaw, *Default AGENTS.md* — https://docs.openclaw.ai/reference/AGENTS.default
- [O6] OpenClaw, *Memory*, *Memory architecture*, *Dreaming* (`MEMORY.md`, daily notes, `DREAMS.md`, memory index in the agent SQLite) — https://docs.openclaw.ai/concepts/memory · https://docs.openclaw.ai/concepts/memory-architecture · https://docs.openclaw.ai/concepts/dreaming
- [O7] OpenClaw, *Skills* (sources and precedence, `skills.entries.*` incl. `apiKey`/`env`) — https://docs.openclaw.ai/tools/skills
- [O8] OpenClaw, *Writing hooks* (`HOOK.md` + `handler.ts/js`, events) — https://docs.openclaw.ai/automation/hooks/writing-hooks
- [O9] OpenClaw, *Hooks* and *Hook configuration* (`hooks.internal`, managed/workspace/extra dirs, `hooks.enabled` HTTP ingress) — https://docs.openclaw.ai/automation/hooks · https://docs.openclaw.ai/automation/hooks/configuration
- [O10] OpenClaw, *Plugin manifest* (`openclaw.plugin.json`: `id`, `configSchema`, `kind`, `channels`) — https://docs.openclaw.ai/plugins/manifest
- [O11] OpenClaw, *Configuration* (`openclaw.json` JSON5, `$include`, `.bak` ring, `channels`, `plugins.entries`) — https://docs.openclaw.ai/gateway/configuration
- [O12] OpenClaw, *Session management* (per-agent `openclaw-agent.sqlite`, legacy `sessions.json`) — https://docs.openclaw.ai/concepts/session
- [O13] OpenClaw, *Session management & compaction (deep dive)* (JSONL transcript header and entry types, `id`/`parentId` tree, session keys, topic files) — https://docs.claw.so/engine/reference/session-management-compaction/ (mirror of the OpenClaw reference page)
- [O14] OpenClaw, *openclaw automations / cron* CLI (jobs in shared SQLite since 2026.6.1; legacy `jobs.json`, `runs/*.jsonl`, `jobs-quarantine.json`) — https://docs.openclaw.ai/cli/cron
- [O15] OpenClaw, *Cron jobs* (legacy `~/.openclaw/cron/jobs.json`, `runs/<jobId>.jsonl`, `cron.store`) — https://openclawlab.com/en/docs/automation/cron-jobs/ (third-party mirror of an older docs version)

Sara code read for §1: `src/companion-import/*`, `src/history-import/*`, `src/library/zip.ts`,
`src/character-cards.ts`, `src/persona.ts`, `src/memory.ts`, `src/memory-rank.ts`, `src/planner.ts`,
`src/recipes.ts`, `src/jobs.ts`, `src/safety.ts`, `src/net-guard.ts`, `web/index.html` (import pages);
ROADMAP "Staples track" and "Move-in track".
