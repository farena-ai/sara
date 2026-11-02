# Matrix (2.55.1)

Talk to her in **Element** (or any Matrix app) through a Matrix account of **her own**, for example
`@sara-frank:matrix.org`. It's free and takes about 15 minutes. There is no Sara account, relay or hub
in between: the Matrix plugin talks to her homeserver directly, through connections Sara holds for it.
The design is [design/BRIDGES4.md](design/BRIDGES4.md) §6–§7.

Matrix comes with Sara as a plugin and stays **off until you add it**.

## Before you start: rooms with her are not end-to-end encrypted

Sara can only read rooms with **encryption off**. Reading encrypted rooms needs a whole cryptography
library (Olm/Megolm), which Sara doesn't have. So whoever runs the homeservers (matrix.org, or yours)
can read your room with her. For private chats use [Signal](SIGNAL.md). The card asks you to tick
*I understand and want to continue* first.

Element makes new rooms and direct messages **encrypted by default**, and encryption can never be
switched off later. That's why step 3 makes a fresh room with encryption off.

## What you need

- An email address for her new account (matrix.org asks for one).
- Your own Matrix account, in Element.
- About 15 minutes at a computer (Element's phone app may not let you switch encryption off).

## The five steps

*Settings → Connections → Matrix*, tick the box and press **Start**. It comes with Sara, so after **Start** there is one short step: what it can reach, and **Add Matrix** (the full plugin card is under *Details*; Sara proves it is her own plugin herself, and the files' fingerprint is checked as for every plugin). Each step
turns ✓ only when Sara has checked it.

1. **Make her a Matrix account.**
   1. Open app.element.io in a private browser window.
   2. Create account → server matrix.org (or *Edit* for your own server).
   3. A username like *sara-frank* and a password; accept the terms and the CAPTCHA.
   4. Sign out afterwards. Use a separate account for her, never your own.
2. **Log her in to Sara.** Type her Matrix ID and password and press **Log her in**. Sara finds her
   server from the part after the colon (and its `.well-known` address), logs in once as the device
   *Sara (bot)*, keeps the login key in the vault and **forgets the password**: it is never stored or
   logged. ✓ shows *Logged in as @sara-frank:matrix.org*.
   - *Advanced: paste an access token* (from Element as her: Settings → Help & About → Advanced →
     Access Token) works too; logging out of that Element session ends the token.
3. **Make a room for the two of you, without encryption.** In Element on the web or desktop, as
   yourself:
   1. **+** next to *Rooms* → **New room**.
   2. Name it *Sara*, keep *Private room*.
   3. Switch **Enable end-to-end encryption** off.
   4. **Create room** → **Invite** → her Matrix ID.

   She joins by herself while this step is open (✓ *She joined Sara*).
4. **Say hello.** Press **Link my Matrix** and send `/link 123456` in that room. Element asks
   *Unknown command*: press **Send as message**, or type `Sara link 123456` instead.
5. **Test.** Checks her server, her login, the sync, your room (and that it isn't encrypted) and the
   link. It sends nothing to anyone.

## What she does there

- **In your room:** everything your other chats do: commands (`/new`, `/model` …, or with her name
  first: `Sara new`), typing while she works, a read receipt on your message, a progress message she
  edits as she goes (react **⏹** on it to stop her), then her answer as a new message. A message you
  send while she works steers her; she reacts 👀. Pictures and files go both ways; voice messages are
  heard when speech-to-text is set up.
- **Encrypted rooms:** she says once *I can't read encrypted rooms yet…* and leaves (or stays quiet if
  encryption was switched on later). The card lists them under *Rooms she can't read*.
- **Invites:** she joins only yours (and, with *Let other people talk to her*, those of the Matrix IDs
  or whole servers like `@family.example` on your list). Anyone else's invite is declined.
- **Rooms with other people:** she answers when mentioned or replied to, never with tools for them.
  With *Owners can use her tools in groups* your own requests there can use her tools.
- **Other people** you allow are partners: the AI notice first, no tools, nothing private.

## Your own homeserver

Switch on **My homeserver runs on my network** and type its address with the port in *Her homeserver*
(for example `192.168.1.20:8008`). Tailscale addresses work too when this computer is on Tailscale.
Port 443 or 8448 means an encrypted connection; other ports are plain HTTP on your own network.

## When something is wrong

The card says it in one sentence with the fix: *Couldn't find a Matrix server*, *Her server doesn't
take passwords from apps* (paste a token instead), *Wrong Matrix ID or password*, *Her login ended*
(log her in again), *That room is encrypted*, *She hasn't been invited yet*, *Her server asked her to
slow down*, *That file is bigger than her server allows*.

**Log her out** on the card ends her login at her server (a real revoke) and removes the key from Sara.

## Private local mode

With *Nothing leaves this computer* on, Matrix pauses (even a home server federates the room off this
computer). Her server keeps your messages; she reads them when it's off.

## Testing with a stand-in homeserver

`test/fixtures/matrix/hs.mjs` is a stand-in Matrix homeserver (HTTPS on a test certificate) used by
`test/phase122b.test.ts`. For a live check:
`node test/fixtures/matrix/hs.mjs --port 7894 --control 7895 --dir <folder>`, then run Sara with
`SARA_TEST_ALLOW_LOOPBACK_MAIL=1 SARA_TEST_MAIL_CA=<folder>/ca.pem` and *Her homeserver* set to
`localhost:7894`. The control port takes `POST /invite`, `/say`, `/image`, `/encrypt` and `/state`.
