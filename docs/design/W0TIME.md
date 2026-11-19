# W0.6 She always knows what time it is

Owner report (2026-11-19): "Chats that happen 10 minutes ago it says like yesterday." The model has to
know exactly how long ago each thing was: seconds, minutes, hours, days, weeks.

## What existed

- The system prompt's "## Right now: It is Thursday, November 19, 2026 at 2:17 PM" (no zone), near the
  top of a long prompt, once.
- The inner state's "You last talked 8 hours ago" (src/inner.ts, from 4 h), "Last time" with a date
  (src/recall.ts `lastTimeNote`), recall hits with a date, memories with their `happenedOn` date, the
  agenda with local due times, mail lists in **UTC** (`toUTCString`), and `agoWords` helpers for rooms
  (src/bridges/keepup.ts) and People (web/people.js, day-level).
- **History messages had no time at all**: a message from 10 minutes ago and one from last week looked
  the same, so the model guessed (the bug; reproduced by `test/w0time.test.ts` first test).

## What W0.6 adds (one module: `src/time-sense.ts`)

- `ageShort` / `spanShort` (compact, for the prompt: "40 s ago", "12 min ago", "3 h 20 min ago",
  "2 days ago", "3 weeks ago", "4 months ago"), `ageWords(ms, lang)` in en/es/fr/de/pt/it,
  `dayAge`, `untilShort` ("in 2 h 5 min"), `clockLabel`/`stampLabel` (owner's zone), `nowLine`.
- History (`buildHistory`, new optional `time` argument, main turn only): every earlier owner message
  starts with `[2:07 PM, 10 min ago]` (`[Tue 9:40 PM, 2 days ago, after 8 h quiet]` after a pause of
  30 min or more). The newest message is this turn's and carries none. A tidied fold says how old its
  end is. Messages younger than 30 s get no label (so fixed-clock tests and fast chats cost nothing).
- Every model step, the last line of her instructions (the system message) is
  `[Now: Thu, Nov 19, 2026, 2:17 PM CST (America/Chicago). 8 h since the last message. …]`
  (~45 tokens; not stored; kept in the step record's system text, so replays rebuild it byte for byte).
  The system prompt's "It is …" names the zone too. Why not a separate note after the history: the
  run recorder, steering and many chat paths rely on the history ending with his message or a tool
  result (tried; 19 suites broke); a suffix on his message broke the "byte for byte" replay rebuild.
- Memories `(2026-11-05, 2 weeks ago) …`; recall hits and Last time `…, 10 min ago`; mail lists in the
  owner's zone with the age (was UTC); agenda `(in 2 h 5 min)` / `(3 h ago)`.
- Time-claim check (receipts.ts style, code only, no model): a reply sentence that refers back ("you
  told me", "hablamos", "tu m'as dit", "hast du gesagt", "você disse", "mi hai detto") with a time
  phrase (yesterday, last night, earlier today, this morning, last week, N minutes/hours/days/weeks ago,
  in six languages) is matched to what it's about (shared word stems, else the owner's previous
  message). If nothing said at that time fits, the phrase is rewritten in place to the real age in the
  reply's language ("yesterday" → "10 minutes ago", "Gestern" → "Vor 10 Minuten"), the stored and
  shown reply are replaced (`replace` event) and `meta.timeFix` records what changed. A `[… ago]` label
  the model copied to the front of its reply is removed. Her own life ("Yesterday I baked bread") and
  things without a cue are left alone.

## Limits

- Only this conversation's messages back the claim check (not other chats or memories yet).
- Her own replies carry no labels (models copy them); the next owner message's label dates them.
- Labels and the time line are English (the prompt language); corrections use the reply's language.
