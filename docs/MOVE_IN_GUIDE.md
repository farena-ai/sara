# Move in from another agent

Use this to bring a companion you already have in **Hermes Agent** or **OpenClaw** over to Sara.
It carries her personality, notes, what she knew about you, past conversations, skills, schedules
and board cards. The old agent is not changed. Everything comes in as one batch that **Undo**
removes for 30 days. (Design: [design/MOVE_IN.md](design/MOVE_IN.md).)

## The easy way

Open **Settings → Data & health → Move in from another agent** (or press **Ctrl K** and type
*move in*, *import hermes* or *import openclaw*).

- **Old assistant on this computer.** Sara looks for it by herself and shows, for example,
  *Found Hermes Agent on this computer — Memories: 10 · Skills: 17 · Past chats: 107*. Press
  **Bring her over**. Sara packs a read-only copy (a few seconds; a progress line shows how far she
  is), then shows what comes over. Press **Import**. That's it.
- **Old assistant on another computer.** Choose **On another computer**. Sara shows one line for
  Windows, Mac or Linux. Copy it, paste it into a terminal on the old computer (PowerShell on
  Windows, Terminal on a Mac) and press Enter. This page waits and moves on by itself when her
  things arrive. The line works once, for 30 minutes. The old computer needs Python 3 or Node
  (OpenClaw machines always have Node). If Sara only answers on this computer, the page says so:
  use your https:// address there, or the file way below.
- **You already have a `.saramove` file.** Choose **I have a move-in file**.

Sara looks only where an assistant keeps her companion (memories, skills, chats, schedules,
settings) and names everything else she leaves alone (programs, caches, browser data, logs,
backups) without opening it. Passwords and keys are never copied.

## By hand (step by step)

**Step by step, by hand** on the first screen opens the five-step wizard: pick the agent, run the
packing program (`sara-movein.py`, or `sara-movein.mjs` with Node), bring the file, check, import.
Useful flags: `--plan-only` (only look), `--max-chats N` (newest N chats), `--include-large`
(bring a folder that was too big), `--send-to https://your-sara --code "six words"` (send straight
to Sara with a move-in code).

Sara then checks every file's hash and reads the bundle. She shows:

- **What the collector packed.** The plan you accepted on the old computer.
- **"Was this her?"** Choose *Yes* when the old agent was her. Its replies then become her own past
  words, and its personality can replace hers. Choose *Another assistant* when it was someone else
  you used. She stays herself and remembers it was them.
- **Her personality.** A draft of her character sheet, in three columns: what goes on the sheet,
  what is kept as her notes, and what is left out and why. You can change her name and age and use
  **Try her voice**. Then pick **Use this personality** or **Keep my current Sara**. Import stays
  off until you choose.
- **One card per kind.** Each card (memories, about you, past conversations, skills, schedules,
  board, reflections) shows the count, how many duplicates were merged, and three samples. Each one
  has an on/off switch.
- **Held for you.** Health and intimate items stay out until you say yes for that category.
  Intimate items also need Adult mode.
- **Settings, channels, hooks and plugins.** Cards you decide one by one (see below).
- **Also for you to look at.** Things Sara found but doesn't bring in by herself, each with what to
  do instead.
- **Left behind (why).** Every skipped thing, with a reason: secrets, logs, media, backups,
  telemetry and search indexes.

Press **Import**. When it is done you see a report with four lists: *Imported*, *Translated*,
*Needs you* and *Left behind*.

## What she does with it

| From | Becomes |
|---|---|
| `SOUL.md`, `agent.personalities` (Hermes); `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, other workspace persona files (OpenClaw) | Her character sheet (after you decide). Lines that don't fit become her notes. `AGENTS.md` becomes working-rule notes. Dated copies are older versions you can pick instead; they are never merged. |
| `memories/MEMORY.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md` | Notes (facts, decisions, promises…), with duplicates merged. Over 2,000 notes, the rest arrive archived: searchable, never brought up by themselves. |
| `USER.md` | What she knows about you. Replaced directives come along as old notes she doesn't use. |
| Hermes `state.db` sessions; OpenClaw session SQLite or JSONL | Past conversations with their dates (only the active branch). She learns from the last 90 days in the background. |
| Skill folders (`SKILL.md`) | Her skills. Skills with scripts stay off until you check them, and nothing runs during the move. |
| `cron/jobs.json`, OpenClaw automations | Planner tasks with the same repeat, or reminders. They never act by themselves. Odd schedules are listed under *Needs you*. |
| Hermes `kanban.db` | A board of its own, in matching columns. Running cards are not restarted. |

**Never:** keys, tokens or passwords (`.env`, `auth.json`, `credentials/` and others are not even
opened), lines that would switch off her safety rules (AI disclosure, crisis help, adults only),
or anything that sexualises minors (dropped and counted, never shown).

## Her old databases (custom stores)

If the old agent kept memories in its own database (SQLite, or Postgres with a read-only login or a
`pg_dump` file), the move-in page shows a box *Her old databases*. Logs and telemetry tables are
skipped for you. Press *Ask her* (or *Guess from names*) and she proposes, for each group of tables,
what it is and where it goes: notes, people and facts about them, past conversations, tasks, goals,
her diary, or skip. Nothing is imported from a card until you press *Looks right*; you can change any
field by hand. Confirmed mappings are saved, so the next move-in from the same kind of database needs
no new questions. Everything lands in the same batch, so Undo removes it too.

## Her old settings, channels, hooks and plugins

Each old setting is a card with **Confirm** and **Skip**. Nothing on a card changes anything until
you confirm it and press Import.

- **Model providers** are matched to Sara's own list; pick another from the list if the match is
  wrong. Keys never move: a confirmed provider arrives with an empty key, and the report says where
  to paste yours (*Settings → Models*). Subscription sign-ins (ChatGPT, Claude) become Sara's own
  sign-in; you sign in again. Models on the old computer are only added if Sara's server can reach
  them.
- **Voice** switches to the same service and voice when Sara has it (paste that service's key in
  *Settings → Voice*). **Time zone** is used only when Sara has none yet.
- **Telegram, Discord, other agents and webhooks** become *connect this* steps in your report. Sara
  never connects them by herself. Stop the old agent's bot first, or both of you will answer.
  Channels Sara doesn't speak yet are listed with the plugin-bridge route.
- **Approvals, sandboxes and allowlists** are shown, never copied: Sara asks in her own way.
- **Hooks and plugins** are read as text and never run. Each card says what it did, with quotes from
  its code. A reply-style hook can become a rule in *How she talks*; a guard makes her ask before a
  tool; things Sara already does are named with their page. Code that is unclear, hidden or reads
  keys is flagged for you. **Ask her to read it** lets her model read the code (your own hardware
  only, unless you allowed other models); every claim must quote the code.
- **Integrations** (a Spotify or calendar plugin, say) become a rebuild plan. After the move-in, the
  report has **Rebuild as a Sara plugin**: a coding conversation with the plan and the old code as
  text. Nothing starts until you say so, and the finished plugin goes through the plugin review.

If the old agent left copies or backups of the same database, Sara maps it once and lists the copies
under *Left behind*.

## The report

When the import is done, the page shows the report: *Imported*, *Translated*, *Needs you* and *Left
behind*, each with counts and links to the right page, a list of where each old feature lives in
Sara now, and her message about the move. **Download the report** saves it as a Markdown file.

## Undo

**Settings → Data & health → Move in → Past move-ins → Undo** (for 30 days). Sara shows how many
things will go first. Undo removes exactly what that move-in brought: notes, conversations, skills,
tasks, reminders, cards, its board and the notes she learned from those conversations. It puts her
old personality back and returns the settings it changed (providers it added are removed; a
setting you changed again since stays as you set it). Notes you edited since are kept unless you untick that. Each move-in is its
own batch, so undoing one leaves the others.

The bundle is deleted from Sara 48 hours after the move-in, or at Undo, or with **Delete the
bundle now**. It is as private as a diary, so delete your own copy too.

## If something goes wrong

- **No Python on the old computer.** The one line uses Node instead when Python is missing. With
  neither, install Python from python.org.
- **The page keeps waiting.** Check that the line ran without an error on the old computer and that
  the old computer can open your Sara's address in a browser. A line older than 30 minutes no
  longer works: press **Make a new line**.
- **A folder was too big.** The plan says *skipped because too large* and names it. Run by hand
  with `--include-large` to bring it.
- **Permission denied.** The agent runs as another user. The collector prints the exact `sudo`
  line to use.
- **It found the wrong agent,** or there are several (Hermes profiles, OpenClaw agents). Point at
  the right one with `--hermes-home PATH`, `--openclaw-state PATH` and `--agent ID`.
- **An old system SQLite.** The plan lists a database as "couldn't be read" when the system SQLite
  is too old for STRICT tables. If Node is installed, as it is for OpenClaw, the collector reads
  those databases through Node instead.
- **The plan is huge.** Leave things out with `--exclude PATTERN` or `--since YYYY-MM-DD`, or cap
  the size with `--max-size 2G`.
