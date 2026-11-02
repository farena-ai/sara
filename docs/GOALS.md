# Keep going until it's done, and repeats

Two ways to let her carry on in a chat without you typing each step (Phase 118, 2.51.0). Both are
yours only, both start only when you press **Start**, and after a restart both come back **paused**.

| | Keep going until it's done (a goal) | Repeat this (a repeat) |
|---|---|---|
| What it is | She works in rounds until a check **you** picked passes | She does something again on a timer and tells you when it changes |
| How it ends | The check passes, she's stuck, a cap, or you stop it | Its end time, its check limit, *Stop when*, failures, or you |
| Start it | `+ → Keep going until it's done…` or `/goal make the tests pass` | `+ → Repeat this…` or `/loop every 10m for 2h: check the deploy` |
| See them | The strip above the chat box | The strip, and Planner → **Repeats** |
| Settings | Settings → Coding → **Keep going and repeats** | the same page |

### How far she may go (Sara 2.61.2)

The settings page offers three choices instead of a wall of numbers. Each card says its limits in words.

| | Careful | Normal (the default) | Long jobs |
|---|---|---|---|
| A goal stops after | 3 rounds or 30 minutes | 5 rounds or an hour | 20 rounds or 4 hours |
| Tokens per goal | 200,000 | 1,000,000 | 2,000,000 |
| Dollars per goal | at most $0.25 | no dollar cap | no dollar cap |
| Repeats check at most every | 15 min | 5 min | 5 min |
| Repeats at once | 1 | 3 | 5 |
| Tokens a day, all repeats | 100,000 | 300,000 | 1,000,000 |
| Dollars a day, all repeats | at most $0.1 | at most $0.5 | at most $2 |

**Normal** is exactly what Sara used before 2.61.2, so nobody's limits changed. Every number is still
there under **Fine-tune**; change one and the page shows **Custom**. Limits you set by hand in an older
version load unchanged and show as Custom. The two on/off switches, the reviewer model and *At night*
are not part of a choice.

## Goals

1. In a chat, press **+ → Keep going until it's done…** (or type `/goal` and what she should keep
   going at, e.g. `/goal make the tests pass done when tests`).
2. Under **Done when**, pick what has to pass:
   - **Tests pass** / **It builds** / **Lint is clean**: the project's own command (`npm test`,
     `npm run build`, …), offered first on a coding project.
   - **A command…**: one you type (`npm test -- test/a.test.js`). Commands that install, delete,
     change the system or use the network are refused.
   - **A reviewer model**: one call to the Reviewing model; it has to say APPROVE **and** quote the
     changed files, or it doesn't count. The end line says "Checked by a reviewer model, not by tests".
   - **I'll say**: after each round she asks you; your tap decides.
3. Press **Start**.

After every round **Sara runs the check, not she**. If it fails, the next round starts with a
*Note from the app* carrying the real failure (and the round number). Her own words never end a goal:
"all tests pass" with a red check is just another round.

How a goal ends:

- **✅ Done**: the check passed. The end line shows the check's own output (`npm test: 4 passed,
  0 failed`), rounds, time and tokens.
- **✅ Done, but review it** (amber): green, but she changed test files (or `scripts.test`) on the
  way. The files are listed; look before you trust it.
- **⛔ Stuck**: the check failed the same way again (*Stuck after*, default 2 rounds), a round
  changed nothing, or she kept retrying the same failing step (the loop guard, which carries across
  rounds). She tells you what the check still says. **Retry** gives it another go.
- **⏸ Paused**: a cap (rounds, minutes, tokens, dollars; summed from the run records and checked
  *before* each round), a round that hit its own reply budget (*Continue with more*), an approval
  waiting 30 minutes, a restart, or you. **Resume** (or *Resume with more*) carries on.
- **⏹ Stopped**: you pressed Stop (Stop always wins, even while the check runs), or `/reset`.

You can type in the chat any time: your message runs as the next round, with the goal note.

### On the board

A card's dialog has **Done when** too (default *Her receipts*, today's rule). With *Tests pass*,
*It builds* or *Lint is clean*, *Assign → Sara* works the card as a goal in the card's own chat: the
card is **Doing** while rounds run, moves to **Done** only when the check passed and her claims were
backed, and waits on you for *done, review it*, stuck or paused. A goal in a chat never makes a card.

## Repeats

1. In a chat, press **+ → Repeat this…** or type
   `/loop every 10m for 2h until the PR is merged: check the PR`.
2. Pick **Every** (default shortest 5 minutes), **Until** (an end is required; without one it ends
   after 4 hours, never more than 24), and optionally **Stop when**. A back-ticked command
   (`` `npm test` ``) is run by Sara and has to pass; words need her to have really looked (a tool ran
   and her claims were backed).
3. Press **Start**.

Each check is an ordinary reply with its own small budget (50,000 tokens, 10 steps by default). When
nothing changed it's folded into one small line (no push); a change is a message and one push.

Every limit:

- **Checks per repeat** (48), **Repeats at once** (3), **Tokens / Dollars per day, all repeats**
  (300,000 / $0.50: when today's share is used they pause until tomorrow).
- **At night** (your quiet hours from *Messages from her*): *Don't check* skips the tick; *Keep
  checking, tell me in the morning* holds a change until morning ("While you slept: …").
- **Stop after failures** (2 in a row), **Stop when nothing changes** (6 in a row, only for repeats
  with *Stop when*).
- **Nobody is watching**: anything that would need your OK pauses the repeat instead of asking
  (*Allow once and resume*, or Stop).
- A crisis line from you pauses that chat's repeats for 48 hours.

## Who can use them

The owner only, in his own chats. Never on the demo, never in a household member's space, never in
off-the-record, partner, group or other-app chats; `/v1`, MCP, A2A keys and webhooks can't reach
them. In Telegram and the other chat apps `/goal` and `/loop` work the same way (the card ends with
"Send /goal start to begin."); `/status` shows them, `/reset` stops the goal and pauses the repeats.

## Commands

| Command | What it does |
|---|---|
| `/goal <text> [done when tests\|build\|lint\|`cmd`\|reviewer\|me]` | A goal card with Start |
| `/goal start` · `/goal pause` · `/goal resume` · `/goal stop` | Drive this chat's goal |
| `/goal` | This chat's goal and its state |
| `/loop every 10m [for 2h] [until …]: <what>` | A repeat card with Start |
| `/loop start` · `/loop pause` · `/loop stop` · `/loop` | Drive this chat's repeats |

Design and every rule: [design/PERSIST.md](design/PERSIST.md).
