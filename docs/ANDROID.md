# The Android app build (U2.9)

The Android app ([android/README.md](../android/README.md)) shows your server's web page, so every new
screen since 3.1 (Messages, communities, errands, the Library, Settings 3, ...) is in the app as soon
as the server has it. The app itself only adds what a web page can't do on a phone. This page lists
what the newer screens need from the app, what U2.9 added, and how to build and try it.
The Google Play release stays on hold: nothing here is uploaded anywhere.

## What the newer screens need from the app

| Need | Status |
| --- | --- |
| **Open in browser** (Adult mode is turned on in the phone's browser) | Already there (ADULTAPPS): `SaraPhone.openInBrowser(url)` opens only this server's own pages. Checked on the emulator: another site's address is ignored, this server's opens Chrome. |
| **Messages from people** as phone notifications | **New.** Before, the app only showed *her* messages; a friend's message reached the phone only while the page was open. |
| One-to-one messages vs quiet communities | **New.** Two notification categories: *Messages from people* (one-to-one; pops up) and *Community messages* (an @mention of you, or a community you set to *Everything*; no pop-up). A plain community post never makes a phone notification, the same rules as the page (T4). Each category can be turned off in the phone's settings. |
| App badge number | **New.** Messages notifications carry the badge number (one-to-one unread + mentions + things waiting for your OK; the same count as `/api/phone/badge`), for launchers that show numbers. Android shows a dot otherwise. |
| The new-message card (MSGPOP) | Works as is: it's part of the page. When the app is closed the notification takes its place; tapping it opens Messages, where the card shows. |
| Share to Sara | Already there (N5b). |
| Saving files (Messages attachments, exports, backups) | **New.** The phone's web view ignores download links, so these saved nothing. Now they go to **Download/Sara** (Android 10+), with a short "Saved" note. |

## How it works (lean)

- **Server** (`src/routes/her.ts`, `src/messages.ts`): `GET /api/phone/inbox` (the app's own check) also
  takes `pmAfter` (a row-number cursor) and returns `people` (up to 5 incoming Messages that notify in
  full: unread, not muted or blocked, routed by `notifyRoute`), `pmLatest` (the new cursor) and `badge`.
  Older apps don't send `pmAfter` and see no change. With *Show message text* off in notifications the
  text is replaced with "Open the app to see it."
- **App**: `InboxJob` sends the cursor per saved server (the first check only sets it, so old messages
  never replay) and posts `Notify.person(...)` on the *people* or *community* channel, skipping the
  server on screen while the app is open (the page shows the card). With *Instant notifications* on,
  `LiveInbox` runs the same check when the server's event stream says `pm` with `notice` (seconds,
  not minutes). Tapping opens `/#view=messages` on the right server.
- **Saving files**: `web/phone-save.js` (loaded only when `SaraPhone.saveFile` exists) sends links with
  a `download` attribute to the app: this server's addresses to `SaraPhone.saveFile(url, name)` (the
  app downloads with its own sign-in), `blob:`/`data:` exports to `SaraPhone.saveData(base64, name,
  type)` (25 MB cap; bigger shows "Open Sara in your browser to save it"). It covers links in the
  page and links the page clicks without adding them (`a.click()` exports). The app also catches a
  download the page didn't route (a server reply sent as an attachment). Other sites are left alone.
  The picture viewer keeps its own *Save* (Pictures/Sara).

Tests: `test/u2-android.test.ts` (server notices and cursor, the file-save routing, the Java contract),
`test/android-strings.test.ts` (the 7 new app strings in all six languages).

## Build it on this PC

This PC has JDK 21, the Android SDK (`C:\Android\Sdk`, platforms 34-37, build-tools 35-37, NDK) and the
Gradle wrapper (8.14.3):

```sh
cd android
./gradlew assembleDebug    # → app/build/outputs/apk/debug/app-debug.apk
```

A release build uses `android/keystore.properties` or `../.secrets/sara-android-upload.properties`
(the publisher's upload key). The U2.9 worktree has no `.secrets`, so only the debug APK was built
(`outputs/android/sara-3.18.2-u2android-debug.apk`, not committed). A debug APK can't update an app
installed from Google Play or a release APK (different signature): uninstall that first, or build
`assembleRelease` from the main checkout, which has the signing files. Versions are not bumped here
(`versionName` 3.18.2); the release does that.

## Emulator check (done headless)

An own AVD `sara-u2android` (Android 15, google_apis x86_64) ran with `-no-window`; two throwaway
in-process servers (Alex and Bo, linked, with a community) on 127.0.0.1, the app connected to Bo at
`10.0.2.2:7992`, and the page was driven over the web view's debug port. Seen:

- Bridges present in the app page: `saveFile`, `saveData`, `openInBrowser`; `in-app` class set.
- A blob export clicked from a detached link (blob revoked right after) and a link to this server's
  file: both in `/sdcard/Download/Sara/` with the right bytes; the page didn't navigate away.
- App in the background, scheduled check: Alex's one-to-one message → *Messages from people*
  (importance high, title "Alex"), the @mention → *Community messages* ("You were mentioned in Trail
  runners", default importance), the plain community post → nothing; number 2 on both.
- Tapping the notification → the app opens Messages, with the page's new-message card.
- *Instant notifications* on: a new one-to-one message showed within about a second, without the
  scheduled check.
- `openInBrowser` with another site: ignored; with this server's page: Chrome opened.
- Dark mode (phone in night mode): Messages and the card read well.

Screenshots: `outputs/android/emulator/` (not committed).

## Limits

- Android only shows badge numbers on some launchers; elsewhere it's a dot.
- Saving files needs Android 10 or newer (the app supports 8+; older phones get a short note).
- A notification stays in the shade after the chat is read on another device: notifications are not
  withdrawn when read elsewhere (the same as her messages). A message read before the check never shows.
- The page's new-message card sits over the top of the Messages panel on a phone until Later or Open
  (MSGPOP behavior, unchanged here).
