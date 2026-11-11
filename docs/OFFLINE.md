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
