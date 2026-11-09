# Sara on your phone

You can talk to Sara from your phone anywhere: same companion, same conversations. This page goes
from nothing to a working phone, step by step.

## What you need first

**A secure (HTTPS) address for your Sara.** Phones need HTTPS for sign-in to stay private on the
way, and browsers only allow notifications, the microphone and "Add to Home Screen" on HTTPS
pages. You have two easy choices:

- **Tailscale** (recommended): a free app that makes a private network of your own devices. Sara
  gets an address like `https://my-server.tail1234.ts.net` that only your own devices can open,
  from anywhere, with nothing to open on your router. Install Tailscale on the server and on your
  phone, sign in to the same account on both, then on the server run `sudo sara access tailscale`
  (Windows: `sara access tailscale`; Mac: menu bar → *Sara on this Mac → Change how you reach her…*). If it says
  HTTPS certificates are off, press **Enable HTTPS** once at https://login.tailscale.com/admin/dns.
- **Your own web address** (like `sara.example.com`): point it at your server, open ports 80 and
  443, and run `sudo sara access domain --domain sara.example.com --email you@example.com` on a
  Linux server. See [INSTALL.md, section 2](INSTALL.md#2-reach-her-securely-https).

("My home network" works on your home Wi-Fi without HTTPS, but sign-in travels as plain text,
notifications won't work, and it doesn't work away from home.)

## Step 1: get Sara on the phone

- **The web app (works now, iPhone and Android):** open your Sara address in the phone's browser
  (Safari on iPhone, Chrome on Android). Then *Share → Add to Home Screen* (iPhone) or *menu → Add
  to Home screen / Install app* (Android). It opens like an app. (An iPhone icon added before 2.7.1
  leaves an empty strip at the bottom: remove it and add it again.)
- **The Sara app:** for Android it's on [Google Play](https://play.google.com/store/apps/details?id=com.backstagecoding.sara); the iPhone app is coming to the
  App Store as soon as Apple approves it (until then, use the web app on iPhone). The app adds a
  home-screen widget, notifications from the app itself, and calls from her. The Android app can
  also be built from source ([android/README.md](../android/README.md)).

## Step 2: sign in without typing the token

1. On your computer, signed in to Sara, open **Settings → Connections → Devices and sign-in**
   and press **Add a phone or computer**. A QR code and a short code appear (they last 10 minutes
   and work once).
2. On the phone, point the camera at the QR code and open the link. On Android, tap **Open in the
   Sara app**: the app opens with the address and code filled in. (Without the app, the page offers
   Google Play, or **Sign in this browser**.) You can also type the server's address and the short
   code in the app.
3. That's it: the phone is signed in and shows up in the list on Devices and sign-in, where you
   can sign it out any time.

(You can also sign in on the phone with the owner token, but the long token is easy to mistype.)

## Step 3: notifications

1. In Sara on the phone, open **Settings → Connections → Phone and notifications** and turn
   notifications on. Allow them when the phone asks.
2. On iPhone, notifications only work from the Home Screen web app (iOS 16.4 or newer), not from
   a Safari tab.
3. To hide message text on the lock screen, use the phone's own settings (iPhone: Settings →
   Notifications → Sara → Show Previews → When Unlocked).

## Several Saras (Phase 68)

The Sara app keeps more than one server, each signed in: scan the QR code of another server's
*Add a phone or computer* and choose **Add** (or **⇄** at the top → **Add a server**). Switch from
**⇄**; notifications come from all of them and tapping one opens the right server. Removing one
signs the phone out of that server only. [SERVERS.md](SERVERS.md)

## Optional

- **Place reminders** ("remind me when I get to the store"): save places in *Planner → Reminders
  → Places*, then switch on *Place reminders* in *Settings → Connections → Phone and
  notifications* on your phone and allow location "all the time". The phone only tells your server
  "arrived at" or "left" a saved place, never your live location.
- **Voice:** the microphone button and live calls work on the phone too (Settings → Her → Voice).
- **Video calls** (🎥): her moving picture full screen while you talk, and your camera if you turn it
  on (off by default; the phone asks for the camera the first time). A video call runs inside the
  app, so keep it open; voice calls keep going with the screen off. [VIDEO_CALLS.md](VIDEO_CALLS.md)

## Sara as your phone's assistant (Android, 2.1)

Phone settings → **Apps → Default apps → Digital assistant app → Default digital assistant app →
Sara**. Then a long press on the home button (or the assistant gesture or key) opens her ready to
listen (with voice set up) or with the cursor in the message box. "Hey Google" can't be replaced by
another app, so it opens by press or gesture, not by voice. [VOICE_ASSISTANTS.md](VOICE_ASSISTANTS.md)

## Siri on iPhone (2.1)

Say **"Ask Sara"** (or use the *Ask Sara* action in Shortcuts), say your message, and Siri speaks her
reply. It uses the server the app is on now. It comes with the next iPhone app update.
[VOICE_ASSISTANTS.md](VOICE_ASSISTANTS.md)

## When something doesn't work

- **The address doesn't open on the phone:** with Tailscale, the Tailscale app must be on and
  signed in to the same account as the server. Check `sudo sara access` on the server for the
  address.
- **The QR code says it expired:** codes last 10 minutes. Press *Add a phone or computer* again.
- **No notifications:** check that notifications are allowed for Sara (or the browser) in the
  phone's settings, and on iPhone that you opened Sara from the Home Screen.

More: [INSTALL.md](INSTALL.md), [FAQ.md](FAQ.md).

## Lend Sara your phone

Sara can ask your phone for one picture, your location or a screen picture, approved on the phone
each time. See [PHONE_HELPER.md](PHONE_HELPER.md).
