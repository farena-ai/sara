# Her weekly check-in: "How am I doing?" (W1.5)

Once a week Sara tells you how she did for you, in plain words, with three ideas you can accept
with one tap. Ask any time in chat: **"How am I doing?"**

## For you

- **What I did.** Changes she made (from the action timeline: files, settings, mail, calendar,
  planner…), tool runs, and how many of your messages they came from.
- **What didn't work.** Failed tool runs (the ones that failed most, by name), sentences the receipts
  check couldn't back up, and replies that ended in an error.
- **What cost money.** About how much the paid models cost this week, paid calls and the free calls
  on this computer. Subscription and local use count as $0.
- **Three ideas.** Each has **Accept** (applies it at once) and **Not now** (not suggested again for
  eight weeks). Accepted ideas show **Done · Undo** on the card and on Settings → Privacy & system →
  Action timeline, so Undo works there too.
- **When.** Settings → You → Briefing and reminders → *Her weekly check-in*: on/off, day (default
  Sunday) and time (default 5 PM). *Show me now* sends one to your chat right away.
- **Where.** Where alerts go → *Weekly check-in* (default: your latest chat; Telegram/Discord too).

## What she may suggest

Only existing settings or automations from the gallery. Never anything that spends money, buys,
pays, or turns on Always allow.

| Id | Shown when | Accept does | Undo |
| --- | --- | --- | --- |
| `saver` | paid models cost ≥ $1 this week and the token saver is off | token saver → Auto | setting put back |
| `tidy` | a claim was flagged and the memory tidy is off | memory tidy on, model on this computer | setting put back |
| `review` | the planner's weekly review is off | weekly review on (keeps your day/time, else Sunday 6 PM) | setting put back |
| `briefing` | the morning briefing is off | briefing on (keeps your time, else 7:30 AM) | setting put back |
| `auto-birthdays` | no "Birthday reminders" automation | creates it from the gallery | automation removed |
| `auto-grocery` | no "Grocery reorder reminder" automation | creates it from the gallery | automation removed |
| `story` | the yearly look back is off | yearly look back on | setting put back |

Problems the week showed come first (cost, flagged claims), then helpful defaults. At most three.

## How it works

- `src/her-week.ts`: `herWeekFacts` (read-only SQL over `action_timeline`, `messages` tool results
  and `meta.unverified`, `runs` errors, `usage` without eval replays), the tip table, `herWeekAccept`
  / `herWeekSkip` (timeline row `her_week`, revert type `herweek`), `herWeekText` (owner's language via
  `trOwner`), `herWeekTick`, `sendHerWeek`. State in `<dataDir>/her-week.json` (per person).
- **Weekly:** `ReminderScheduler.tick` → `herWeekTick`. The first look only remembers this week's
  slot (a fresh install or a changed day never sends an old week); a later slot change sends once if
  it is less than 24 h late. It goes out through `postAlert(app, 'herweek', …)` as a scored W1.2
  nudge (`kind: 'herweek'`, value 0.7). *Show me now* is asked for (urgency `reminder`, exempt).
- **Chat:** `src/her-week-words.ts` matches the whole message in English, Spanish, French, German,
  Portuguese and Italian ("How am I doing?", "¿Cómo lo estoy haciendo?", "Comment je m'en sors ?",
  "Wie mache ich mich?", "Como estou indo?", "Come sto andando?"). chat.ts answers with the card and
  no model call (owner chats only).
- **Routes** (existing automations family): `GET|PUT /api/automations/her-week {on, day, time}`,
  `POST /api/automations/her-week/now`, `POST /api/automations/her-week/accept|skip {id, message?}`.
- **Web:** `web/her-week.js` (`herWeekCard` under her message when `meta.herWeek`; Settings loader
  from `showSettingsTab`).

## What existed before

The planner's weekly review (Phase 22, `src/review.ts`) and the life review (V2.4) look at your
to-dos and your life; N1's "How she did" counts ride on the planner review; EC25's trust report and
EC15's usage reports are detailed Settings pages. W1.5 reuses their records and adds the short
"how she did for you" card with one-tap ideas.
