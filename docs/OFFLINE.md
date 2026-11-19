# Works offline: recent chats and notes without a connection

When her server can't be reached (no internet, the server is restarting, the computer she runs on is
asleep), the page shows what this device kept instead of a bare "Can't reach your Sara" card: the
recent chats and your notes, read-only, under a bar that says
**"Offline — showing what this device kept (as of 10:42)"**. Messages you write meanwhile wait in an
outbox and are sent, in order and exactly once, when the connection is back.

It is built into the page, so the browser, an installed web app, the Windows and Mac apps and the
phone apps all get it.

## What is kept

- The **30 newest chats** (the last **200 messages** of each: your words and hers, no tool output)
  and your **notes** (up to 200). A chat is kept as you open it, and the newest ones are refreshed in
  the background a few seconds after the page opens and every 10 minutes.
- **Never:** off-the-record chats, imported histories. **Private chats** only when *Also keep private
  chats* is on (off by default).
- Kept in the browser's IndexedDB for that server's address, **encrypted** with a key the browser
  makes and never lets out (WebCrypto AES-GCM, non-extractable): the files on disk hold no readable
  text. This protects the copy on the disk; anyone who can use your signed-in browser can still read
  it, as they could read the chats on the server.
- **One person per device:** when someone else (another household member) signs in on the same
  browser, or another server answers at the same address, the earlier copy and its outbox are deleted
  first. **Signing out** deletes the copy, the outbox and the key.

## Today, lists and shopping mode (R9)

- **Today** as it was last shown is kept too (the tiles and their lines, as text), and opens from the
  offline view: *Today, as it was at 9:12*.
- **Lists**: your boards and the household lists shared with you (the 12 newest, up to 300 items each)
  are kept and open in **shopping mode**: big rows to tick off, and *Add an item*. Each change waits
  in the outbox (*Will sync when online*) and is sent when the connection is back.
- **Last writer wins, per item.** When it syncs, Sara reads the list first. If that item was changed on
  another device after your change (ticked, unticked, renamed), the newer change stays and the
  back-online note says so: *Changed on another device after you: Bread (the newer change was kept)*.
  An item you added that is already on the list (same words, not done) is not added twice; an item
  deleted meanwhile is skipped.
- Messages written offline show *Waiting to send · Will send when online* until they go.
- Code: `web/offline-lists.js` (slim lists, the last-writer-wins plan, sending one change), kept in
  `web/offline-store.js` (`saveToday`, `saveLists`), drawn by `web/offline-view.js`. Tests:
  `test/r9-offline-lists.test.ts`.

## The setting

Settings → Connections → Devices and sign-in → **Offline on this device**:

- **Keep a copy on this device for offline:** on by default in Sara's own apps (Windows, Mac, phone)
  and in an installed web app, which are one person's device; off by default in a plain browser tab,
  which may be a shared or borrowed computer. It is this device's own choice; turning it off deletes
  the copy at once.
- **Also keep private chats:** off by default.

## Writing while offline

- In a kept chat, type as usual: the message shows as a **Waiting to send** bubble. You can **Edit**
  or **Delete** it until it is sent.
- In a note, *Add to this note* (or *New note*) queues an addition. When it is sent it is **added to
  the end** of the note under a heading like `— 2026-11-11 10:30 (written offline)` (the 3.4.2 `note
  add` rule), so it never overwrites what changed on the server meanwhile. A note deleted meanwhile
  gets a new note with the same title.
- **Back online:** the page notices by itself (the browser's online event, a failed request, and a
  check of `/api/health` every 30 seconds, every 5 seconds while offline). The outbox is sent in the
  order it was written and a note says **"Back online — sent 2 messages"**. Something the server
  refuses (a full note, a deleted chat) stays on the device with the reason, to copy or delete.

### Never twice

Each outbox item carries its own key (`clientKey`). The server stores it with the message
(`meta.clientKey`) and answers a second send with the same key with `{ duplicate: true, messageId }`
instead of storing and answering it again; the same key sent twice at the same moment gets a 409 for
the second. Notes remember their keys for 30 days. So a connection that drops after the server got
the message (the answer was lost on the way back) never makes a second message. Editing a waiting
message gives it a fresh key; one whose send was cut off on the way can only be deleted (it may
already be there).

## Answers while offline (V5.6, Android app)

In the Android app a small model **on the phone** can give a short answer while her server is away
(design: docs/design/V5_PHONE_MODEL.md).

- **Setting:** Settings → Connections → Devices and sign-in → Offline on this device → **Answers
  while offline**: the switch, the model's state and **Download the model (490 MB)** / **Remove the
  model**. In a browser, the Windows or Mac app it says *Only in the Android app* (messages written
  offline wait for her as before).
- **The model:** Qwen2.5 0.5B Instruct (Q4_K_M, Apache-2.0, 491 MB, speaks the six app languages).
  Nothing is downloaded until you tap Download. The file comes straight from Hugging Face (a public
  file, no account), a cut download resumes, and the whole file is checked against its pinned
  SHA-256 before it is ever used. Remove deletes it. Wi-Fi is best.
- **How it answers:** in a kept chat, your message waits as *Waiting to send* as before and the
  phone's model gets the newest kept messages of that chat (up to 6) and your question, with a short
  brief: answer in at most three sentences, no tools, internet or memory, and say when it needs her.
  While it thinks the view says *Thinking on this phone…*; the answer shows under your message as
  **Sara · Offline answer**. It is kept with the outbox item (encrypted like the rest of the copy).
  Editing the message drops that answer (it answered other words).
- **Synced once:** when the connection is back, the message goes with its answer
  (`offlineAnswer: {text, model, at}`). The server stores both (the answer with
  `meta.offlineAnswer`) and does **not** start a second turn, so nothing is answered twice; the same
  key sent again is a duplicate as before. In the chat the answer carries *Offline answer · from the
  small model on your phone* and, on the newest answer, **Ask Sara again** (the normal Regenerate:
  she answers it with her full model).
- **Never:** children's accounts (the page doesn't ask the model, and the server ignores an offline
  answer from a child's device: the message gets a normal turn), off-the-record chats (never kept),
  other people's chats. The model sees nothing the offline copy doesn't already keep, and nothing it
  sees leaves the phone.
- **Engine:** llama.cpp (MIT, pinned b12528) inside the signed app (`android/fetch-llm-libs.sh`,
  `android/app/src/main/cpp/llm.c`, `LocalModel.java`); a build without it says *This copy of the app
  has no model engine for this phone's processor*. Official arm64 phones only (and the x86_64
  emulator with `--emulator`); older 32-bit phones have none. Answers take a few seconds on a recent
  phone.
- Code: `web/offline-answer.js` (bridge, prompt, keep the answer, the chat chip),
  `src/offline-answer.ts` (check and store). Tests: `test/v5-phone-model.test.ts`.

## The offline page

The service worker serves its offline page when the page itself can't load (a reload or a fresh
start while the server is down). It hands over to the kept copy when there is one (the offline files
are cached with the page shell: `offline-page.js`, `offline-store.js`, `offline-sync.js`,
`offline-view.js`, `offline-view.css`) and shows it in the language the app last used. When the server
answers again it goes back to the app, in the chat you were reading, and the app sends the outbox.

Needs a secure page (https, or Sara on this computer): browsers only offer the encryption and the
service worker there. On a plain `http://` address from another device nothing is kept.

## Files

- `web/offline-store.js`: the encrypted copy and the outbox (storage passed in; tests use memory).
- `web/offline-sync.js`: the default, the connection watch, sending the outbox.
- `web/offline-view.js`, `web/offline-view.css`: the read-only view and the outbox bubbles.
- `web/offline-hook.js`: the app's hooks (web/app.js), Settings switches, the back-online note.
- `web/offline-page.js`: the service worker's offline page handing over.
- `src/offline-keys.ts`: outbox keys on the server (`POST /api/conversations/:id/messages` with
  `clientKey`; `POST /api/notes/add`), the per-server id in `/api/session` (`serverId`, `space`).
- Tests: `test/offline-copy.test.ts`, `test/offline-outbox.test.ts`.
