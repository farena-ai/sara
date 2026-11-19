# Her nudges: one polite daily budget (W1.2)

Everything Sara sends on her own now goes through one gate (`src/nudges.ts`). You get the few
things that matter most, at good times, and the smaller ones together once a day.

## For you

- **Daily budget.** Settings → You → Automations → *Her nudges* → *Nudges a day* (default 4; 0 = only
  urgent things come right away). The higher a nudge's value, the sooner it gets a slot: once half the
  budget is used, only the more important ones still go out.
- **Quiet hours.** The same hours as *Texting first* on her page (default 10 PM to 9 AM). Nudges
  that come up then wait.
- **Always on time.** Safety alerts (someone asked for legacy access, a monthly smoke-alarm test) and
  things you asked for (your briefing, your renewal reminders, "send the workforce report now")
  ignore quiet hours and never use up the budget. Your own reminders never go through the gate.
- **One roundup.** Whatever waited arrives in one message, most important first, at *Roundup of smaller
  things at* (default 5 PM, after quiet hours). Where it lands: Where alerts go → *Smaller things*.
- **Why did I get this?** Under each nudge: what kind it is and which of today's slots it used (or
  why it skipped the limit).
- **Fewer like this.** Under each normal nudge. That kind counts for less from now on, for you only
  (each tap again lowers it; Undo right there, or *Back to normal* in Settings).

## What goes through the gate

| Sender | Kind | Value | Notes |
| --- | --- | --- | --- |
| Money: budget limits near/over (`money/hub.ts`) | money | 0.65 | gentle mode lines |
| Money: free trial ends (mail + reminder 2 days before) | trials | 0.7 / 0.75 | reminder via `noteNudgeReminder` |
| Money: price change | money | 0.45 | |
| Maybe cancel monthly note (`money/trim.ts`) | money | 0.5 | |
| Workforce weekly report | workforce | 0.6 | "send now" = asked for |
| Legacy access alerts | legacy | safety | |
| Gift reminders she makes (`gifts.ts`) | gifts | 0.6 | Planner reminder |
| Car/house upkeep reminders (`upkeep.ts`) | upkeep | 0.55 | smoke alarms = safety |
| Renewal reminders (Remind me, accepted date facts) | renewals | asked for | explains only |
| Morning briefing | briefing | asked for | explains only |
| Texting first (`life.ts` maybeProactive) | checkin | 0.45 | dropped, never saved up |
| Home presence reactions (`presence.ts`) | presence | 0.6 | dropped, never saved up |

Not gated (they answer something you did or set up yourself): approvals, "Sara finished", your own
reminders and their follow-ups, event triggers and watches you made, automations, goal/errand
progress, inbox helper cards, travel alerts. They keep their own throttles (live watches and loops
already honor quiet hours; Calls from her has its own quiet hours). Moments and drift have no
proactive sender (Moments is a chat tool at most once a day; drift is a check).

## How it works

- `askNudge(app, {kind, value, urgency, text, digest})` → `{send, held, score, why}`. Score = value ×
  this person's weight for the kind. Held when quiet, when score < 0.3, or when the budget is used or
  the score is under the rising bar `0.3 + used/budget × 0.5`.
- `postAlert(..., reason: 'proactive' | nudge: {...})` asks the gate and returns `undefined` when held;
  sent messages carry `meta.nudge = {kind, why}` (the web draws the line from it).
- Reminders she makes are registered with `noteNudgeReminder(app, id, kind, value, urgency?)`;
  `ReminderScheduler.#deliver` asks `reminderMayGo` and marks held ones fired.
- `nudgeTick` runs on the reminders' tick and posts the roundup once a day (`nudges` feed).
- State per person: `<dataDir>/nudges.json` (prefs, today's count, waiting items, weights).
- Routes: `GET/PUT /api/automations/nudges`, `POST /api/automations/nudges/fewer|more {kind}`.
