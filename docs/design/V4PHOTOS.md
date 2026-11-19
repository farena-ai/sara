# V4.1 Photo library search — design (one page)

ROADMAP_V V4.1 / VAUDIT item 26. User doc: docs/PHOTO_LIBRARY.md.

## What existed (extended, not duplicated)
- `src/moments.ts` + `web/moments.js`: "Our moments", the album of photos shared **in chats**, with her
  captions, auto albums (Us/Places/Her looks), On this day. No folder of photos on disk.
- `src/picture-reader.ts`: which models may look at a picture (`modelSees`, `pictureAllowedHere`).
- `src/private-local.ts` `onThisComputer`, `resolveChain(app, conv, 'vision')`: the owner's
  Looking at pictures chain.
- `src/library/vectors.ts`, `src/find.ts`: documents/chats search (not photos).

## What V4.1 adds
- `src/photo-library.ts`: per-space index `<dataDir>/photo-library/photos.db` (own SQLite + FTS5
  `porter unicode61`), one instance per folder (`photoLibraryOf`). A dependency-free EXIF reader
  (date, camera, GPS, both byte orders, never throws); offline places `placeName` (named places
  first, else nearest city ≤ 40 km, country ≤ 150 km); `scan()` (new/changed/gone by size+mtime,
  hidden/cache/system folders skipped, ≤ 50k files, yields every 200); `describeNext` (picture
  model on this computer only: `onThisComputer` + sees; JSON caption/text/things, 3 tries, > 15 MB
  skipped); search (every word, prefix, month names in 6 languages + year); people by hand;
  `madeAlbums` (trips, people, writing).
- `src/photo-places.ts`: generated table, GeoNames cities15000 (CC BY 4.0), 100k+ people and
  capitals (6,368 rows). Rebuild: download `cities15000.zip` + `countryInfo.txt` from
  download.geonames.org and run `python scripts/photo-places.py <folder>`.
- `src/routes/photo-library.ts`: `/api/moments/folder…` inside the existing `moments` family
  (no AUDITED / household-isolation churn); owner only (403 for members, kids, demo); the page sees
  ids, never paths; files are served only from inside the chosen folder.
- Tick: `photoLibraryTick` on `ReminderScheduler.tick` (no timer): rescan every 6 h, describe 2
  photos per tick; never creates the index by itself.
- Web: `web/photo-folder.js`; a "Your photo folder" section in the Moments dialog; a "Photo
  folder" card on Settings → Library (`ab-library`, no new page).

## Rules
- Nothing leaves: no network code in the module (test greps it); cloud models (incl. `:cloud`
  names behind a local Ollama) are never sent a photo; without a local seeing model the index
  still has places/dates/names/people.
- No chat tool on purpose: a cloud talking model would see captions and places. A later tool must
  be offered only when the talking model is on this computer.
- No face matching (no free local face model wired in); people are named by hand.
