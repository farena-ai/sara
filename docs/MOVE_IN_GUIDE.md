# Move in from another agent

Use this to bring a companion you already have in **Hermes Agent** or **OpenClaw** over to Sara.
It carries her personality, notes, what she knew about you, past conversations, skills, schedules
and board cards. The old agent is not changed. Everything comes in as one batch that **Undo**
removes for 30 days. (Design: [design/MOVE_IN.md](design/MOVE_IN.md).)

## The three steps

Open **Settings → Data & health → Move in from another agent**.

1. **Get the collector.** Copy the command shown on the page. It downloads `sara-movein.py` from
   your Sara and checks its SHA-256 before running it. The collector is one Python file with no
   installs. It needs Python 3.6 or newer. It only reads.
2. **Run it on the old agent's computer.** Open a terminal there, for example with
   `ssh you@old-computer`. Paste the command and press Enter. The collector finds the agent
   (`~/.hermes`, or `~/.openclaw` plus its workspace) and shows a **plan** of what it will pack
   and what it will skip, with reasons. It asks before writing anything. To only look, add
   `--plan-only` (or `--plan-only --json`) and nothing is written.
3. **Upload the file.** Choose the `.saramove` file it made. Big files upload in 8 MB pieces and
   carry on after a dropped connection. You can also send it straight from the old computer: click
   **Make a move-in code** and run
   `python3 sara-movein.py send FILE.saramove --to https://your-sara --code "six words"`.
   The code is valid for 30 minutes and opens only that upload.

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
- **Read in the next updates.** Custom databases, settings, hooks and plugins. They stay in the
  bundle. Sara reads them in 2.38 and 2.39.
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

## Undo

**Settings → Data & health → Move in → Past move-ins → Undo** (for 30 days). Sara shows how many
things will go first. Undo removes exactly what that move-in brought: notes, conversations, skills,
tasks, reminders, cards, its board and the notes she learned from those conversations. It puts her
old personality back. Notes you edited since are kept unless you untick that. Each move-in is its
own batch, so undoing one leaves the others.

The bundle is deleted from Sara 48 hours after the move-in, or at Undo, or with **Delete the
bundle now**. It is as private as a diary, so delete your own copy too.

## If something goes wrong

- **No Python on the old computer.** Install it from python.org, or run the collector on any
  computer that can read the agent's folder.
- **Permission denied.** The agent runs as another user. The collector prints the exact `sudo`
  line to use.
- **It found the wrong agent,** or there are several (Hermes profiles, OpenClaw agents). Point at
  the right one with `--hermes-home PATH`, `--openclaw-state PATH` and `--agent ID`.
- **An old system SQLite.** The plan lists a database as "couldn't be read" when the system SQLite
  is too old for STRICT tables. If Node is installed, as it is for OpenClaw, the collector reads
  those databases through Node instead.
- **The plan is huge.** Leave things out with `--exclude PATTERN` or `--since YYYY-MM-DD`, or cap
  the size with `--max-size 2G`.
