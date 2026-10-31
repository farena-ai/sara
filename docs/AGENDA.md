# Her own plans (the agenda)

Since 2.36.0 (Phase 103, staples ST8; design: [STAPLES.md §11](design/STAPLES.md)) Sara can keep
plans of her own: **follow-ups** on things you tell her ("ask how the interview went on Friday
evening") and **goals** you keep at together ("Run a 10k in April"). It is **off by default**, per
companion, and everything she does on her own is listed, capped, budgeted and stoppable.

## Turning it on

*Planner → Her plans* → **Let her keep her own plans** (the big switch at the top). The same switch
turns everything off at once: a message she is writing right then is stopped and not sent, and her
planned items stay listed as *paused*. Switch it on again and they come back (a time that passed
while she was off moves to the same time on the next day). **Clear her plans** removes them.

Household members have their own plans in their own space, off by default; the owner can't read
them. The demo never has plans.

## What she plans, and why

- **Follow-ups (code, no model).** When you mention something coming up in one of your own chats
  ("the interview is on Friday", "I have a dentist appointment tomorrow", "the renewal window opens
  Dec 1"), she plans to ask how it went (that evening, 7 pm) or to remind you (that morning, 10 am).
  The chat shows **Added to her plans** under her reply. She can also add one with her `agenda_add`
  tool when she says "I'll ask you Friday how it went".
- **Goals (proposal cards).** When you say something goal-like twice in two weeks ("I really need to
  finish the garden shed") or ask her to help you keep at it, she suggests a goal on a card:
  **Use it / Edit first / Not now / Never for this**. Nothing starts until you say Use it. A goal's
  check-in comes back as often as you pick (every day at most); your answer to a check-in becomes a
  progress note on the goal. You can add your own goals and plans on the page.
- **Every plan quotes you.** The reason is stored with the message it came from, and her message
  shows **Why I'm writing: you said "…"** (tap it to see the plan). A plan without a source message
  can't be made by her. She never invents reasons, urgency or feelings, never guilt-trips about not
  answering, never plans anything just to keep you chatting, and never sets goals about weight,
  eating, medication or self-harm on her own (you can; she then follows them carefully). A reason
  that would put a sensitive note about someone on a people card into a notification is not used.
- **Only your own chats feed it.** Private, partner, group, imported, work-channel, webhook,
  agent (A2A), other apps' and voice-assistant conversations never become plans, and her plan tools
  exist only in your own chats (never for other apps, agents, webhooks or plugins).

## Limits (all checked in code before any model call)

| Limit | Default |
|---|---|
| Messages a day | **2, shared** with her own first messages (her page: Texting first). Her plans never add more. |
| Quiet hours | 22:00–9:00, shared |
| Quiet gap | 6 hours since your last message (and since her last first message), shared |
| Daily budget | 30k tokens / $0.10 for writing and look-ups (a member's dollars stay inside their limits) |
| Her own plans | at most 5 open, 2 new a day, never more than 30 days ahead, never in the past |
| Repeats | a goal's check-in at most daily |
| Missed window | each plan has a 6-hour window; if the day is full it moves once to the next day, then shows *Skipped: the day was full* |
| After a hard conversation | her plans pause for 48 hours except one gentle check-in (with the crisis resources) |

She never double-texts: while her last first message is unanswered, nothing more is sent.

## Look-ups (off by default)

*She may look things up for her plans* lets her ask, on the page, for one web search before a
follow-up ("find beginner 10k plans before Sunday's check-in"). Each one waits for **Allow once**,
counts in her budget, uses only the web search you set up, and its result is attached to the
follow-up (never sent on its own). In private local mode only a local SearXNG is used.

## Where to see it

- **Today → Her plans**: today's planned messages with their times and reasons, your goals with the
  next check-in, and *0 of 2 messages today · 4k of 30k tokens*. Each row has *Edit time*,
  *Change what* and *Cancel it*; goals have *Pause* and *Done*.
- **Planner → Her plans**: everything above, proposals waiting for you, *What she did on her own*
  (sent, answered, skipped with why, cancelled, the day was full) and the settings (sliders for the
  messages a day, quiet hours, the quiet gap and the budget). **Check now** runs her planning tick at
  once with the same limits.

## For developers

- Code: `src/agenda.ts` (`AgendaStore`, `Agenda`, `createAgendaTools`, the code planners
  `futureMentions` / `goalMentions`, `feedsAgenda`), `src/routes/agenda.ts`, `web/agenda.js`,
  `web/agenda.css`; the `LifeWorker` tick (`src/life.ts`) runs one agenda step before her
  spontaneous message when the agenda is on; `chat.ts` calls `Agenda.afterTurn` after your own turns.
- Tables (the companion's database, additive): `agenda_goals`, `agenda_items`, `agenda_ledger`,
  `agenda_state`.
- Routes: `GET|PUT /api/agenda`, `POST /api/agenda/off|tick|clear`, `POST /api/agenda/items`,
  `PUT /api/agenda/items/:id`, `POST /api/agenda/goals`, `PUT /api/agenda/goals/:id`,
  `POST /api/agenda/goals/:id/decide`. A member route family; not on the demo.
- Tests: `test/phase103.test.ts`. Eval by hand: `node scripts/eval-agenda.ts` (30 scripted weeks on a
  fake clock; follow-ups on the right day, never over the cap, every reason found in his own words).
