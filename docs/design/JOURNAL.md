# V2.9 One-minute voice journal (D5)

ROADMAP_V V2.9 · audit row D5 in [VAUDIT.md](VAUDIT.md). One page.

## What existed (reused, not rebuilt)

- `src/moments.ts` "On this day" (Our moments photos, Today card): the same rule (this day in earlier
  years, else this day last month) and its translated headings are reused; the photo album itself is
  untouched (a journal is words, not pictures).
- `src/voice.ts` `LocalVoiceEngine.transcribe` (Parakeet on this computer) and `web/voice.js` `Mic`
  (16 kHz mono WAV): the journal records and hears with them.
- `src/health-log.ts` (U4.22): the pattern for private per-person data (own folder, AES-256-GCM per
  space, members in their own space). Copied as a pattern, not shared: the health log has its own
  banner, terms and tools, and a journal is not health data.
- The Library sub-view pattern (Scan, Study): a button on Library home, a section with Back, routes
  inside `/api/library/*` (no new route family, no household-isolation churn).
- Not used on purpose: `src/story.ts` (Your story together, model-written look backs) and
  `/api/voice/transcribe` (`Speech.transcribe` may use OpenAI or Grok in the cloud).

## What it does

Library → **Journal…**: pick how today was (Great / Good / Okay / Low / Rough day, optional), press
**Record a minute** (stops itself at 1:00) or type, and the entry is saved. The words are kept; the
recording only when **Keep the recording** is ticked (remembered per person). Entries can be edited
(words and mood) or deleted. On top: a streak line ("4 days in a row. Today is done.") and **On this
day** (this day in earlier years, else this day last month). `#view=journal` opens it.

## Private by default

- Heard **only on this computer** (`app.voice`); with no local hearing (or a member whose voice the
  owner turned off) the page hides Record and says to type; a recording sent anyway gets 409
  `typeInstead` and is not kept. A cloud speech setting is never used.
- Stored in the person's own space: `<space>/journal/journal.db` + `journal.key` (0600); every entry
  and recording sealed with AES-256-GCM; only day and time in clear. A member's journal is in their
  own folder; the owner's is never reachable from a member's server.
- No model tool, not a chat, not memory, not an Ask source, not on Today: nothing in it reaches a
  model, another person or a report. Backups of the space include it, like the rest of the space.

## API (src/journal.ts, mounted in src/routes/library.ts)

`GET /api/library/journal` · `POST /api/library/journal?mood=&keep=1` (audio/wav, at most ~65 s) ·
`POST /api/library/journal {text, mood}` · `PATCH|DELETE /api/library/journal/:id` ·
`GET /api/library/journal/:id/audio` · `PUT /api/library/journal/prefs {keepAudio}`.

## Acceptance

`test/v2-journal.test.ts`: a fake hearing engine saves a spoken entry over HTTP (mood, words, no
recording unless asked; kept one plays back as WAV); typed, edited, deleted; refusals; files in the
journal folder hold no words and no WAV in clear; nothing in chats, memory or `sara.db`; a member's
server sees an empty journal and 404 for the owner's ids; no local hearing → 409 type instead.
Live: real Parakeet heard a SAPI recording played through a fake microphone by clicks (~1.5 s).

## Not yet

- A daily nudge ("Your minute for today?"): would ride the reminders tick; left out to keep it quiet.
- Streaming words while you speak (V0.2 streaming hearing) and a search over entries.
