# Morning briefing as audio, and the weekly life review (V2.4)

## For you

**Listen to your briefing.** Settings → You → Briefing and reminders → *Listen to your briefing*.

- Turn on **Also make each briefing as audio**. After each morning briefing, Sara reads it aloud
  into an audio file. **Play briefing** shows up on Today once this morning's file is ready. Every
  recording is also in Library → Briefings, with its text, and you can play it there. Sara keeps the
  last two weeks and deletes older recordings.
- **Voice**: *On this computer (private)* is the default. It uses the voice installed on your server
  (Kokoro or Piper, Settings → Voice), so nothing leaves the server. *My chosen voice* uses whichever
  engine you picked in Settings → Voice. That can be a cloud service you pay for (OpenAI,
  ElevenLabs, Grok voice). Sara never switches to a cloud voice on her own. If the local voice
  isn't installed, you get a clear message and no recording.
- **Make audio of the last briefing** records the newest briefing right away.
- **Private podcast link** (server owner only): *Make a private podcast link* shows a feed address
  once. Copy it into a podcast app that accepts a feed URL. Anyone with the link can listen, so keep it
  to yourself. *Make a new link* stops the old one, and *Turn the link off* stops all of them. Sara
  stores only a fingerprint (hash) of the link, never the link itself.

**Weekly life review.** In the same page, under *Weekly review*, turn on **Also send a life review**,
or press **Life review now**. It arrives right after the planner review and covers the people you
were in touch with this week, birthdays and promises coming up (from People; private cards are left
out), your health log as counts only (no values, no advice), what you spent (Money imports), and
the moments you kept. Your health counts go to a cloud model only if your health log allows cloud
models. Otherwise Sara adds that line to the message herself. A message with health counts is kept
out of her memory.

## Design (one page)

- **Existed:** `src/briefing.ts` (facts in code, model writes, plain fallback, ALERTDEST delivery),
  `src/review.ts` (weekly planner review), `src/voice.ts` (local Kokoro/Piper, `speechChunks`),
  `src/speech.ts` (chosen engine), the Library (`src/library/store.ts`: `add`, `setRead`,
  collections), People ties, the health log, Money, and Moments.
- **New:** `src/briefing-audio.ts` does the following:
  - It speaks the text chunk by chunk and joins the WAVs into one file, with a 350 ms pause between
    chunks. A cloud voice gives MP3 parts, which it joins by concatenation.
  - It keeps one Library doc per day (`Morning briefing YYYY-MM-DD.wav`, collection `Briefings`,
    kind `audio`, `learn: off`) and keeps 14 of them.
  - It adds `lastBriefing()` and the feed: a token-hash file `<dataDir>/briefing-feed.json` and an
    RSS 2.0 feed whose enclosure URLs carry the token, because podcast apps send no cookies.

  `src/life-review.ts` gathers the facts and sends the life review, with a plain fallback.
- **Wiring (small edits):** `BriefingWorker#write` starts the recording in the background when
  `briefing.audio` is on (`audioDone` for tests). `ReviewWorker.tick` also sends the life review when
  `weeklyReview.life` is on. The routes in `src/routes/planner.ts` are:
  - `GET/PUT /api/briefing/audio`
  - `POST /api/briefing/audio/make`
  - `GET /api/briefing/audio/:id` (audio type, signed-in)
  - `POST /api/briefing/feed {on}` (owner only)
  - `POST /api/review/life`
  - `PUT /api/review {life}`

  `src/server.ts` serves the public `/feed/briefing/<token>[/<id>.wav]` route next to `/book/`. It
  answers 404 unless the token matches and is off for the demo and members.
- **Web:** `web/briefing-audio.js` holds the Settings section, the Today play button (refreshed when
  Today opens) and the Library player in the doc view (`#lib-doc-audio`).
- **Tests:** `test/v2-brief.test.ts` uses a fake voice engine. It covers the WAV join, the Library doc
  and its text, keeping 14, no cloud fallback, the worker hook, the routes, and the feed token
  (wrong, rotated, off, hash only). The life review test checks that private people are left out and
  that health counts don't go to a cloud note.
- **Gaps:** household members get recordings and Today/Library playback but no podcast link (the front
  server routes cookie-less requests to the owner's space). The feed serves WAV, which most podcast
  apps play but which is large (about 2.5 MB a minute). An MP3 encoder would need a new dependency.
  The life review is not spoken.
