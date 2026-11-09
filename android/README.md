# The Android app

A small phone app for your Sara server. It isn't required: Sara also installs from the browser
as a home-screen app. The Android app adds:

- **A home-screen widget**: her face for her current mood, how she's feeling, and her last
  message. Tap it to open the conversation.
- **Notifications from the app itself**: about every 15 minutes Android lets the app check for
  messages she sent on her own (texting first, reminders, finished jobs, the morning briefing).
  While the app is open, messages show up instantly in the chat.
- Microphone, camera and photo picker inside the app.

It works with any Sara server: on first start you type your server's address (the one you open
in your browser). It uses only Android itself, with no extra libraries and no Google services.
The whole app is about 100 KB.

## Install it on your phone

1. Get the APK file: build it (below), or download it from wherever your server's owner shares it.
2. Open it on the phone. Android asks to allow installs from that app (your browser or Files):
   allow it once.
3. Open **Sara**. Easiest: on your computer open Settings → Data & health → Devices and sign-in →
   **Add a phone or computer**, then scan the code with the phone's camera and choose **Open in the Sara app**.
   Or type your server's address and the short code, and press **Connect**. (Without a code you
   sign in with the owner token.) No server yet? Press **Try the demo**.
4. In Settings → Connections → **Phone app**, press **Add her to your home screen**.

## Build it

You need Android Studio (or just the Android SDK) and Java 17 or newer.

```sh
cd android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

To make a release build for sharing, create `android/keystore.properties` (never committed):

```properties
storeFile=../.secrets/sara-release.jks
storePassword=…
keyAlias=sara
keyPassword=…
```

then run `./gradlew assembleRelease` (or `bundleRelease` for Google Play). Without
`keystore.properties` the build uses the publisher's upload key from
`../.secrets/sara-android-upload.properties` if present. Version: `versionName` is Sara's version and
`versionCode` is major × 10000 + minor × 100 + patch (`test/c18-android-release.test.ts`). Play
release steps: [docs/ops/C18_PLAY_RELEASE.md](../docs/ops/C18_PLAY_RELEASE.md).

## What it does besides the web app

- **Reply from a notification**: type into her notification; her answer comes back as one.
- **Send to Sara**: share text, links or photos from any app; they land in the message box.
- **Live calls keep going with the screen off**: the call runs in the app itself (with a call
  notification and a Hang Up button), not in the web page.
- **Instant notifications** (Settings → Phone and notifications, optional): the app keeps one quiet
  connection to your server and shows her messages the moment they arrive. Android shows a small
  "Instant notifications are on" note for this (in the Silent section, category *Instant
  notifications*). Off: she's checked about
  every 15 minutes. No Google Firebase or other outside service is involved either way.
- **Several Saras** (Phase 68): add another server by scanning its QR code (**Add this Sara?**) or
  from **⇄** at the top; each keeps its sign-in (the ones not in use are kept encrypted with a key in
  the Android Keystore), notifications come from all of them and open the right one. See
  [docs/SERVERS.md](../docs/SERVERS.md).
- **Phone as a helper location** (C18, 2.87.0): after *Allow once* the app takes one location fix
  itself and hands it to the page (`SaraPhone.helperLocate` → `window.saraHelperLocated`), so it
  works with http servers at home too (the web view's own geolocation is https-only).
- **App lock**: fingerprint, face or your screen lock after 30 seconds away; the app is hidden in
  the recent-apps view while the lock is on. **Hide the message text on the lock screen** is
  there too.

## The app's own screens and text

Almost everything you see is the web app. The app itself only draws:

- **Connect to your Sara** (first start) / **Add a Sara** (from ⇄ or a pairing link): the address,
  an optional pairing code (`XXXX-XXXX-XXXX`), *Connect*, and *Try the demo*. In the new look's
  Night (default) or Day colours, whichever the page showed last (`Look.java`, `res/values/colors.xml`).
- **Can't reach your Sara**: when a saved server doesn't answer: *Try again*, *Add a Sara*, and
  your other Saras one tap away.
- Dialogs (*Add this Sara?*, *Sign in with a code*, place reminders), the app lock, toasts and
  notifications.
- The splash (Android 12+): her picture on the Night background, or Day once the page has shown
  Day (Android 13+ remembers it).

**Bars and safe areas (2.7):** the status and navigation bars are see-through. The app reads the
page's theme and the colours at its top and bottom edge (its own small script; the page needs no
bridge call) and picks light or dark bar icons to match; the call screen stays dark in Day too.
Whether the page draws under the bars itself depends on the phone's web view: once per web view
version the app checks if `env(safe-area-inset-*)` reaches a page (`viewport-fit=cover`); if it
does, the page runs edge to edge, otherwise the app keeps it clear of the bars and paints them in
the page's colours, so nothing is padded twice. The check result is in logcat (`Sara: Safe-area
check …`). "Follow the system" in the page follows the phone's dark mode.
- **Notification categories** (phone Settings → Apps → Sara → Notifications): *Messages from
  her*, *Calls from <her name>* (ringing), *Call in progress*, *Instant notifications* (the quiet
  note while they're on).

That text is in `res/values/strings.xml` and translated in `values-de`, `-es`, `-fr`, `-it` and
`-pt-rBR` (the app follows the phone's language); `test/android-strings.test.ts` checks all six
have the same strings and placeholders and that each one is used. The launcher icon is an adaptive
icon (`res/mipmap-anydpi-v26/ic_launcher.xml`, picture from `scripts/make-app-icons.py`), so it takes
the launcher's shape.

## Notes

- **Notification timing** without instant notifications: Android decides when background checks
  run (usually every 15–30 minutes, longer when the battery is low).
- **Google sign-in** (Gmail/Calendar) opens in the phone's browser, because Google doesn't allow
  signing in inside apps' web views. It still connects your server; sign in again in the app
  afterwards if it asks.
- The app's name on the home screen is "Sara"; inside the app and on the widget she uses the name
  you gave her.
- Google Play: the app uses two kinds of foreground service, which the Play Console asks about
  (Phase 19): *microphone* (live calls and Hey Sara) and *remote messaging* (instant notifications).
  Place reminders need *Allow all the time*: before any location prompt the app shows its own
  disclosure (*Place reminders use your location*, Play's prominent-disclosure rule; tested in
  `test/c18-android-release.test.ts`). Play answers and videos: `docs/ops/PLAY_SUBMIT_2880.md`.
- iPhone: see `ios/README.md`.
