# Sara on an iPhone (without the App Store)

The Sara iPhone app is not in the App Store and isn't submitted. An iPhone gets Sara two ways
that need no store at all:

1. **The installed web app.** In Safari, open your Sara address, tap **Share** → **Add to Home
   Screen** → **Add**, and open Sara from the new icon. There (iOS 16.4 and later) she can send
   notifications and show a badge on her icon. Sara shows this guide on an iPhone that has her
   open in a Safari tab (Settings → Connections → Phone and notifications, and iPhone Shortcuts).
2. **Apple Shortcuts** for what a web app on an iPhone can't do: **Share to Sara** in the share
   sheet, **Ask Sara** with Siri, and a widget.

## What works where

| | Installed web app on iPhone | Shortcuts |
|---|---|---|
| Notifications | Yes, after *Turn on for this device* (tap it in the Home Screen app) | — |
| Badge on the icon | Yes: approvals, inbox cards and errands waiting for you, plus unread Messages | — |
| Buttons on notifications (Approve, Snooze) | No (iOS doesn't show them): a tap opens the item in Sara | — |
| Share sheet | No (iOS has no share target for web apps) | **Share to Sara** |
| Siri | No | **Ask Sara** ("Hey Siri, Ask Sara") |
| Widget | No | A Shortcuts widget: one tap shows the lines |

## Shortcuts tokens

Settings → Connections → **iPhone Shortcuts** → *Make a token*. Each iPhone gets its own token:

- shown once (as text and a QR code), only its hash is kept; listed under Devices and sign-in too;
- scoped: **Share** and/or **Ask** (Ask also allows the widget); it works only on the three
  routes below, never on the rest of Sara's API, your chats, settings or files;
- per person: household members make their own, and a token only reaches its own space;
- removed from the page (or Devices), it stops at once; up to 10 per person;
- sent only as a header (`Authorization: Bearer sara_sc.…`), never in an address;
- rate limited per token (share 10 a minute, ask 6 a minute, widget 20 a minute; and an hourly cap),
  and wrong tokens count against the sender's address;
- in private local mode ("Nothing leaves this computer") the routes refuse: nothing reaches Sara
  from other devices.

## The routes

| Route | Body | Answer |
|---|---|---|
| `POST /api/shortcuts/share` | a form (`file`/`files`, `text`, `url`, `title`) or JSON (`files: [{name, type, data}]` in base64) | "Saved to Sara: receipt.png. Open Sara to go on." (`x-sara-url` header: the chat) |
| `POST /api/shortcuts/ask` | JSON `{text}`, a form field `text` or plain text | her answer, at most two sentences; a task that takes longer than 20 seconds answers "I'm on it. I'll notify you when it's done." and goes on in the iPhone's own **Siri** chat |
| `GET /api/shortcuts/widget` | — | plain lines: the next reminder, watches on, what waits for you |

Send `Accept: application/json` for JSON (`say`, `url`, …). A shared photo or file goes to the
Library and opens a new chat "Shared with Sara" with a ready message, like Android's share.
A link or a bit of text that Shortcuts turned into a small text file is read as the link or text.

## Building the shortcuts

The page lists the exact steps with your address and the new token filled in, ready to copy.
In short:

- **Share to Sara**: Show in Share Sheet (Images, Files, URLs, Text) → *Get Contents of URL*
  (`…/api/shortcuts/share`, POST, header `Authorization: Bearer <token>`, Form: File `file` =
  Shortcut Input) → *Show Result*.
- **Ask Sara**: *Ask for Input* → *Get Contents of URL* (`…/api/shortcuts/ask`, POST, the header,
  JSON: Text `text` = Provided Input) → *Speak Text*. Siri runs it by its name.
- **Sara today** (widget): *Get Contents of URL* (`…/api/shortcuts/widget`, GET, the header) →
  *Show Result*; add a Shortcuts widget to the Home Screen (iOS 18: a Lock Screen or Control
  Center control too). A Shortcuts widget is a button: it shows the lines when tapped, not live.

## Ready-made shortcuts (optional, for the owner)

Shortcut files can't be imported on today's iOS unless Apple signed them, so Sara doesn't ship
`.shortcut` files. What works is an **iCloud link** with **import questions**. Once, on your iPhone:

1. Build *Share to Sara* and *Ask Sara* from the steps (with your own token, to test them).
2. In each shortcut: ⓘ → **Setup** → *Add New Question* for the URL of *Get Contents of URL*
   ("Your Sara address + /api/shortcuts/share") and for the Authorization header value
   ("Bearer and your token from Settings → Connections → Phone and notifications → iPhone Shortcuts"). Import questions
   clear those fields when shared, so your token doesn't go with it.
3. Share → **Copy iCloud Link**. Open the link once to check it says *Set Up Shortcut*.
4. Paste both links in Settings → Connections → Phone and notifications → iPhone Shortcuts → *Ready-made links for
   everyone* (owner only; one set for the whole server). Everyone then sees *Get* buttons, and
   each person answers the two questions with their own token.

To stop sharing: open the link in Shortcuts → the shortcut → Stop Sharing, and clear the field.

## The native iPhone app

`ios/` holds the native app's source (Swift, no libraries; see `ios/README.md`). It stays as
source: it is not submitted to the App Store or TestFlight (owner decision: the app was denied
before; ship what works without the store). Building it needs a Mac with Xcode; it can't be built
on the Windows development PC.

## On the phone itself (3.19+, U2.10)

- **Connect the Sara phone app** (Settings → Connections → Phone and notifications) speaks to the
  device it is shown on: on an iPhone it says to add Sara to the Home Screen (or that she is already
  there), never "Get the Sara app on your Android phone"; its code button says *Show a code for another
  phone*. On a computer it shows Google Play for Android and one line for iPhone.
- The newer screens (goals, errands, trips, meetings, Messages, research, the document studio, Ask
  everything, Make it sound human, People, Team, Try these and Settings) give every button and field at
  least 44 px to tap on a touch screen. Ask everything and Make it sound human fill the screen and keep
  clear of the notch and the home indicator. Email and calendar fits a 375 px iPhone (SE/mini).

## Not verified on a real iPhone

The routes, tokens and page were tested with curl the way a Shortcut sends them, and the page at
iPhone size in a browser. Real Shortcuts runs, Siri, the share sheet, web push and the badge on a
real iPhone are owner checks (docs/OWNER_CHECKS.md).
