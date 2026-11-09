# Sara for iPhone and iPad

A small native app (Swift, no libraries) around Sara's web app, like the Android app. It adds:

- **Sign in with a code**: scan the QR code from Settings → Connections → Devices and sign-in →
  *Add a phone or computer* with the Camera and choose *Open in the Sara app*, or type your server's address and
  the short code. (Without a code you sign in with the owner token.)
- **Instant notifications** through Apple's push service, sent by your own server (set up once in
  Settings → Connections → Phone and notifications → *iPhone app notifications*).
- **Several Saras** (Phase 68): each server keeps its sign-in in a WebKit data store of its own;
  switch from **⇄** at the top; pushes say which server sent them, so a tap (or Reply) goes to the
  right one. See [docs/SERVERS.md](../docs/SERVERS.md).
- **Widgets** for the Home Screen (small, medium) and Lock Screen: her face, mood and latest
  message. Tap to open that conversation.
- **Reply from a notification**, and **Send to Sara** from any app's Share button (text, a link or
  up to 4 photos with a note; it goes to your latest conversation and her answer comes back as a
  notification).
- **Live calls keep going with the screen locked**: the call runs natively (background audio),
  with echo cancellation, as a **CallKit** call: it shows on the lock screen and in the green call
  pill, and can be muted or ended there (ending it hangs up on the server too). While the app is
  open, her rings ("Sara is calling") show as an incoming call. Calls stay out of the Phone app's
  Recents; no VoIP pushes (PushKit). A real phone call coming in offers *End & Accept*. CallKit
  doesn't work in the Simulator (calls there fail to start; Debug test runs with
  `-SaraTestNoMic YES` connect without it). Apps with CallKit can't be offered in China mainland
  (docs/store/CHECKLIST.md).
- **App lock** with Face ID (or the passcode) after 30 seconds away; the app is covered in the app
  switcher. To hide message text on the lock screen: iPhone Settings → Notifications → Sara → Show
  Previews → When Unlocked.
- Microphone, camera and photos for voice notes, calls and pictures; links to other sites open in
  Safari; **Try the demo** for people without a server yet.
- Adult mode can't be switched on in the app (store rules); it's a web-browser setting.

## Build (on a Mac with Xcode 26 or later)

```sh
open ios/Sara.xcodeproj          # then pick a simulator or your iPhone and press Run
```

Command line, simulator (no signing needed):

```sh
cd ios
xcodebuild -project Sara.xcodeproj -target Sara -sdk iphonesimulator -configuration Debug \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= SYMROOT=$PWD/build build
xcrun simctl install booted build/Debug-iphonesimulator/Sara.app
xcrun simctl launch booted com.backstagecoding.sara
# Test runs (Debug builds only) can connect straight away:
#   … launch booted com.backstagecoding.sara -SaraTestServer http://<server> -SaraTestCode <pairing code>
```

On a real iPhone, Xcode's automatic signing uses the team in the `SARA_TEAM_ID` build setting:
pass `SARA_TEAM_ID=<your Apple Team ID>` to `xcodebuild`, or pick your team under Signing & Capabilities. The app ID `com.backstagecoding.sara`, the widget
`com.backstagecoding.sara.widget` and the app group `group.com.backstagecoding.sara` are created
on first run with your Apple developer account.

## Notifications

Apple only delivers a notification when it's signed with an **APNs key** from the team that
signed the app. Create one at developer.apple.com → Keys (tick *Apple Push Notifications
service*), then in Sara on your computer: Settings → Connections → Phone and notifications →
*iPhone app notifications*: choose the `.p8` file and enter the Team ID. Debug builds use Apple's
sandbox; App Store / TestFlight builds use production (the app tells the server which).

Test runs (Debug builds) also take `-SaraTestCall <conversation id>` (start a call once signed in)
and `-SaraTestNoMic YES` (no audio, for simulators on a Mac without audio devices; the call log
is written to the app's `tmp/call.log`). `-SaraTestCallKit call|ring` exercises CallKit without
a signed-in page (an outgoing call to a made-up conversation, or a 20-second incoming ring); watch
`xcrun simctl spawn booted log stream --predicate 'process == "Sara"'` for `Sara CallKit:` lines.

The app's own screens: **Connect to your Sara** (or **Add a Sara** with one already saved; the
address, an optional pairing code, *Try the demo*) and **Can't reach your Sara** (*Try again*, *Add
a Sara*), in the new look's Night (default) or Day colours, whichever the page showed last; the
launch screen is her picture on Night. The page draws under the status bar and home indicator
itself (`contentInsetAdjustmentBehavior = .never`, so `env(safe-area-inset-*)` reaches it once and
nothing is padded twice); the keyboard still resizes it. A small script of the app's own reads the
page's theme and the colour at its top edge, so the status bar text stays readable (the call screen
is dark in Day too); the web view keeps the phone's own light/dark setting, so the page's *Follow
the system* theme works. Debug builds also take `-SaraTestJS '"<script>"'` (run once in the first
page loaded; quote it, launch arguments are read as property lists). Permission prompts: microphone (calls and voice messages),
camera (photos you share, and video calls only when you turn your camera on), photos (choose /
save her pictures), location (place reminders; it stays on the iPhone), Face ID (the app lock).

Layout: `Sara/` (app), `SaraWidget/` (widget extension), `SaraShare/` (share extension), `Shared/` (used by both: server, sign-in
cookie and last widget data in the app group), `Config/` (Info.plist additions, entitlements).
