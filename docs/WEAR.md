# Sara on a Wear OS watch

A tile on your watch: the rest of today's reminders, how many things wait on you, and a **Talk**
button to ask her something by voice. Anything that needs your OK (an order, a mail, a payment) is
answered on your phone or computer, never on the watch: the tile only tells you how many wait.

Wear OS only. An Apple Watch app needs Apple's paid developer program, so there is none.

## Set it up

1. Install Sara's watch app on the watch (see *Build it* below; it is not in an app store).
2. Open **Sara** on the watch. Type your server's address (the one you open in your browser, like
   `sara.example.com` or `192.168.1.20:7860`) and tap **Get a code**.
3. The watch shows a code like `K7P-42Q`. In Sara on your phone or computer, open
   **Settings → Connections → Phone and notifications → Wear OS watch**, type the code, optionally a
   name for the watch, and press **Pair the watch**.
4. A few seconds later the watch says *Paired*. Add the tile: swipe on the watch face, then tap
   **+** and pick **Sara today**.

A code works once, for 10 minutes. Only type a code that your own watch shows.

## What it does

- **Today**: the next three reminders left today (in your time zone), and "+N more".
- **Waiting on you**: approvals her running chats wait for, inbox cards and errands waiting for you
  (the same count as the app badge). "Answer on your phone."
- **Talk**: the watch's own speech input hears you; she answers in at most two sentences, in the
  watch's own chat (named *Watch* in your chat list). If what you asked needs your OK, she says so
  and the card waits on your phone.
- Offline, the tile keeps the last glance and shows when it was updated. It refreshes about every
  15 minutes and whenever you open the app or talk.

## Privacy and removing a watch

- The watch gets its own token (shown nowhere, kept only on the watch). It may only ask her and read
  the glance: no chats, files, settings or sharing. Sara keeps only a fingerprint of it.
- Remove a watch in the same Settings section (or under Devices and sign-in): it stops at once.
  Household members pair their own watches for their own space.
- Private local mode refuses new pairings and answers no watch until it is off.

## Build it

```sh
cd android
./gradlew :wear:assembleDebug        # Windows: gradlew.bat :wear:assembleDebug
# → wear/build/outputs/apk/debug/wear-debug.apk
adb install -r wear/build/outputs/apk/debug/wear-debug.apk   # with the watch in developer mode
```

The watch app is standalone (it talks to your server itself) and uses Jetpack's Wear tiles
libraries, nothing from Google Play services or Firebase. Its version follows the phone app's.

## How it works (for developers)

| Step | Route | Credential |
| --- | --- | --- |
| Watch asks for a code | `POST /api/shortcuts/wear/pair` → `{code, poll, expiresIn}` | none (rate limited per address, 5 open codes each) |
| Person types the code | `POST /api/shortcuts/wear/claim {code, label}` | signed-in web page only (no app bearer tokens) |
| Watch picks up its token | `GET /api/shortcuts/wear/pair/<poll>` → 202 waiting, 200 `{token, name}` once, 404 | the long poll secret |
| Tile | `GET /api/shortcuts/wear` → `{name, today[], more, waiting, lines, at}` | watch token |
| Talk | `POST /api/shortcuts/ask {text}` (JSON) → `{say, waiting?, later?}` | watch token |

The watch token is an R4 Shortcuts token (`sara_sc.…`, scope `ask`, `device: 'watch'`), so it gets
the Shortcuts rate limits, revocation and household routing for free. Pending codes live in the
server process (`src/wear.ts`); a restart drops them. Code: `src/wear.ts`, `src/routes/shortcuts.ts`,
`web/wear-page.js`, `android/wear/`. Tests: `test/d2-wear.test.ts`.
