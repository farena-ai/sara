# Memory lane (W4.2)

Stories she writes from your own life: **My year 2026**, or one trip, with picked photos, a narrated
version, a PDF and, only if you ask, a share link. It lives in **Your story** (sidebar → More → Your
story, Alt+Y), above Look back.

## How to use it

1. Open Your story. Under **Memory lane**, pick a story: a year that has something in it, or a trip.
2. Press **Write it**. She writes in the background; you can close the window.
3. On the story card:
   - **✕** on a photo leaves it out of the story (and the PDF and any later share link).
   - **Narrate it** records the story with the voice on this computer; then a player shows.
   - **Save as PDF** downloads the story with its photos between the paragraphs.
   - **Share link…** asks first, then makes a read-only copy that works for 7 days. Stop it any time
     in Settings → Household → Shared links (the same list as shared chats).
   - **Delete** removes the story. Your photos and journal stay.

## Where the story comes from

| Source | What is used |
| --- | --- |
| Photo library (V4.1) | Photos in the date range: date, place, the caption the local picture model wrote |
| Our moments (Phase 70) | Photos and kept moments from your chats (never adults-only ones) |
| Journal (V2.9) | Your entries in the range, word for word, and their mood |
| Trips (S6) | Trips from booking mail, and the photo library's made-for-you trip albums |
| Your story (Phase 53) | Milestones, promises, projects and scrapbook moments in the range |

Trips: a trip from your bookings wins over a photo album on the same days.

## Privacy rules

- **Only a model on this computer writes it** (a loopback local model, the same rule as the photo
  library's picture model). Photos and journal words never go to a cloud model. With no local
  model, the story is put together in code from the same facts (places, dates, counts, captions);
  nothing is invented and the card says "Put together from your facts".
- **Exact words**: a quote that is not word for word in your journal or captions is dropped with its
  sentence (the Look back rule).
- **Narration uses only the voice on this computer**, never a cloud voice, because the story can
  hold journal words.
- **Kept sealed in your own space**: `<space>/memory-lane/lane.db`, every story and recording
  encrypted with AES-256-GCM under the space's own key (`lane.key`, mode 0600). A household member's
  stories live in their own space; nobody else sees them. Stories are not memory, not an Ask source,
  not a chat, and no model tool reads them.
- **Sharing is a deliberate act**: a share link is a frozen, scrubbed (e-mail addresses and phone
  numbers hidden) copy of the story text and its picked photos. It needs sharing to be allowed (the
  policy), is refused in private local mode unless private sharing is allowed, and kids can't make
  one.

## For developers

- Engine: `src/memory-lane.ts` (`laneOptions`, `writeLaneStory`, `pickPhotos`, `makeLaneAudio`,
  `lanePdf`, `laneShare`, `LaneBook`). Routes: `src/routes/memory-lane.ts` inside the `story` family
  (`/api/story/lane...`, member-usable per space). Share: `POST /api/shares {lane, expires}` in
  `src/routes/share.ts`. Web: `web/memory-lane.js`, loaded from `loadStory` in app.js.
- Tests: `test/w4-lane.test.ts`.
