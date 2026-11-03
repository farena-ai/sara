# iMessage (2.55.2)

Text her from **Messages on your iPhone**, iPad or Mac, in blue bubbles, to an **Apple ID of her own**
(for example `sara.frank@icloud.com`). It works through **BlueBubbles**, a free, open-source app that
runs on **a Mac of yours** and works the Messages app for Sara. There is no Sara account, relay or hub
in between: the iMessage plugin talks to BlueBubbles directly, on this computer, your home network or
your Tailscale network. The design is [design/BRIDGES4.md](design/BRIDGES4.md) §4 and §7.1.

iMessage comes with Sara as a plugin and stays **off until you add it**.

## Before you start

- **No Mac, no iMessage.** BlueBubbles needs macOS with iMessage signed in. Apple's licence allows macOS
  only on Apple computers, so this guide doesn't cover virtual machines or "Hackintosh" setups. Without
  a Mac, use [Signal](SIGNAL.md) or Telegram instead. A used Mac mini that stays on is the honest answer.
- **Her own Apple ID, never yours.** On your Apple ID she would see all your chats and her answers would
  go out as you. Sara checks this and **refuses to run** on your own Apple ID (`OWN_APPLE_ID`).
- **About Apple and BlueBubbles.** BlueBubbles is not made or approved by Apple. Use it on your own Mac,
  with a separate Apple ID for her, and keep her to you and people you choose. Apple's software licence
  forbids spam and harassment, and Apple can lock an Apple ID that misbehaves. The card asks you to tick
  *I understand and want to continue* first.

## What you need

- A Mac that can stay on (macOS 11 or newer is easiest).
- An email address for her new Apple ID.
- About 40 minutes at that Mac.

## The eight steps

*Settings → Chat apps → iMessage*, tick the box and press **Start**. It comes with Sara, so after **Start** there is one short step: what it can reach, and **Add iMessage** (the full plugin card is under *Details*; Sara proves it is her own plugin herself, and the files' fingerprint is checked as for every plugin). Each step
turns ✓ only when Sara has checked it.

1. **Give her an Apple ID**: on any browser, account.apple.com → *Create Your Apple Account* → name
   *Sara*, a birthday, a new email address for her, a password, your own phone number for the codes.
2. **Give her a place on the Mac**: on your own Mac, *System Settings → Users & Groups → Add User…* →
   *Standard*, name *Sara*, then log in as her. On a spare Mac, skip this.
3. **Sign her in to Messages and keep the Mac awake**: as Sara, *Messages → Settings… → iMessage* →
   sign in with her Apple ID; then *System Settings → Energy* → *Prevent automatic sleeping when the
   display is off*.
4. **Install BlueBubbles** from its GitHub releases page (right-click → *Open*, it's unsigned), give it
   *Full Disk Access*, continue without notifications, type a **server password** and press the
   floppy-disk icon. Paste the password into the card: it goes to Sara's encrypted vault and is never
   shown again.
5. **Tell Sara where BlueBubbles is**: `127.0.0.1:1234` when Sara runs on the same Mac; otherwise the
   Mac's address on your home network (switch on *BlueBubbles runs on another computer on my
   network*) or its Tailscale name. The check shows the BlueBubbles version, macOS, the Apple ID it is
   signed in with and whether the Private API is on.
6. **Let BlueBubbles ring Sara**: press **Ring**. Sara adds her address to BlueBubbles as a webhook and
   waits for its hello. If BlueBubbles can't reach Sara (for example Sara on a cloud server, the Mac at
   home, no Tailscale), press **Use polling**: she then checks every 5 seconds while you chat and every
   30 seconds otherwise.
7. **Say hello from your iPhone**: *Link my iMessage* gives a code for 10 minutes; send `/link 123456`
   to her address from Messages.
8. **Test**: checks BlueBubbles, the password, Messages, the Apple ID, the doorbell or polling and the
   link. It sends nothing to anyone.

## How messages reach her (the doorbell)

BlueBubbles' webhooks are **not signed**, so Sara never trusts what they say. When BlueBubbles rings
Sara's `/hook/` address, Sara passes the plugin only the event name and the message ids; the plugin
then fetches each message from BlueBubbles with the server password before anything reaches her. A
forged ring costs one question to BlueBubbles and is dropped. BlueBubbles doesn't retry webhooks, so
the plugin also **catches up** at start, every minute while idle and after any gap: what you sent while
the Mac or Sara was off is answered once, in order; anything older than a day is filed, not answered,
and something several hours old gets a "Sorry, I was offline" start.

## While she works

- **Basic mode** (the default): her answer, pictures and files; a long job gets one *Working on it: …
  Send /stop to stop.* line after 20 seconds. A message you send while she works steers her, and she
  says so in a line.
- **With the Private API**, only if you already turned it on in BlueBubbles: typing dots, a ‼ tapback
  when you steer her, one progress message she edits (at most 4 times, only within Apple's 15 minutes),
  quoted replies in groups, and read receipts if you switch them on. The Private API needs a Mac
  security feature (SIP) turned off, which BlueBubbles compares to jailbreaking; **Sara works without it
  and never asks you to turn SIP off**.

## Other people and groups

- **Strangers** who find her address get one line ("I only chat with the person who runs me here"),
  then nothing.
- **Partners**: with *Let other people talk to her*, the handles (numbers or emails) on your list get
  partner chats: no tools, nothing private, the AI notice first and every 3 hours.
- **Group chats**: she answers only when a message starts with her name; with *Owners can use her
  tools in groups* your own calls there can use her tools.

## Pictures, files and voice

Pictures and files both ways (yours up to 20 MB). iPhone **HEIC** photos: if BlueBubbles doesn't turn
them into JPEG, she says once how to switch the iPhone to *Settings → Camera → Formats → Most
Compatible*. Voice messages are transcribed when speech-to-text can read their format.

## Privacy and safety

- The BlueBubbles password is the only key; it lives in the vault (`plugin:imessage:password`) and
  travels in the URL query (BlueBubbles' only way), so Sara cuts every `?guid=`/`password=` value out of
  logs, errors and diagnoses. On a home network that's plain HTTP: Tailscale or Sara on the same Mac
  avoids that, or switch on *BlueBubbles uses HTTPS* if you gave it a certificate.
- iMessage goes through Apple's servers, so *Nothing leaves this computer* pauses it; messages wait on
  the Mac and she catches up when it's off.
- iMessage chats stay out of MCP, `/v1` and A2A, like every chat app.

## If something goes wrong

The card names the problem in one line: Sara can't reach BlueBubbles, the password was refused,
Messages is signed out, it's your own Apple ID, the address is on your network (switch needed), a
Tailscale address while this computer isn't on Tailscale, no doorbell (polling instead), the Mac
asleep, a message that didn't send (it stays in the app), a green-bubble number, a HEIC photo.

## Not in this release

SMS through the Mac, FaceTime, her voice out, message effects, leaving groups (do it from Messages on
the Mac), *Reply yes or no* approvals by text, and iMessage through the Sara Mac app (a later slice
with its own design note).
