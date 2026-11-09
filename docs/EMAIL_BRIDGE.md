# Email: give her a mailbox of her own

Sara can have **her own email address**. You write to it (or forward a mail to it) and she answers
**in the same thread**, with pictures and files as attachments. It is a plugin that comes with Sara
(`plugins/email`), installed from Settings through the normal review card. Design and reasons:
`docs/design/BRIDGES3.md` §5 and its *As built (2.50.0), part B* note.

This is **her** mailbox, not yours. Reading and organising **your** inbox (Gmail, Outlook, Yahoo,
iCloud and more) is a different feature: Settings → Add-ons → Email and calendar
([EMAIL.md](EMAIL.md)). The email bridge adds no inbox tools.

## What you need

1. **An address only she uses**: an alias on your own domain, or a new account at a provider that
   allows app passwords. Not your own address: Sara refuses it ("That's your own mailbox…").
2. **Two-step sign-in** on that account and an **app password** for it (below).
3. IMAP switched on for that account (most providers have it on).

### Making an app password

| Provider | Where | Servers Sara fills in |
|---|---|---|
| **Gmail / Google Workspace** | Google Account → Security → 2-Step Verification (turn on) → **App passwords** (myaccount.google.com/apppasswords). Google shows a 16-letter code once. | IMAP `imap.gmail.com` 993, SMTP `smtp.gmail.com` 465 |
| **iCloud Mail** | account.apple.com → Sign-In and Security → **App-Specific Passwords** → Generate. | IMAP `imap.mail.me.com` 993, SMTP `smtp.mail.me.com` 587 |
| **Fastmail** | Settings → Privacy & Security → **Manage app passwords** → New app password (access: IMAP and SMTP). | IMAP `imap.fastmail.com` 993, SMTP `smtp.fastmail.com` 465 |
| **Your host / a self-hosted server** | Your host's control panel (often called *app password*, *application password* or *device password*). | Type them yourself (*Mail provider*: Other) |
| **Outlook.com / Hotmail** | Not for her own mailbox: Microsoft switched app passwords off for IMAP/SMTP. (Your own Outlook mailbox works through the Microsoft sign-in: [EMAIL.md](EMAIL.md).) | — |
| **More providers** | Yahoo, AOL, Zoho, GMX, WEB.DE and Proton Mail Bridge servers and app-password steps: the table in [EMAIL.md](EMAIL.md) and `src/mail/presets.ts`. | Type them yourself (*Other*) |

Your normal password won't work. The app password goes **only into Sara's encrypted vault**
(`plugin:email:password`): it is never shown again, never in settings, logs or exports.

## Setting it up

Since 2.61.0 the page is a guided setup card: *Settings → Chat apps → Email → Start*. Each step
turns ✓ only when Sara has checked it.

1. **Pick her mail provider** (Gmail, iCloud, Fastmail or Other). The card shows where that
   provider makes an app password, with the link.
2. **Add Email to Sara**: it comes with Sara, so this is one short step ("It can reach her mail
   servers (IMAP and SMTP, always encrypted); nothing else.") and *Add email*. The full plugin card
   is under *Details*; the fingerprint check is the same as for every plugin.
3. **Her address and app password**: type both and press *Save and check*. The server names fill
   themselves from the provider (Other: type them in *Email settings*). ✓ when she has signed in.
4. **Link your address**: you get a 6-digit code for 10 minutes. Send her an email **from your own
   address** with the subject `Link 123456`. She answers "Linked." That mail must pass your
   provider's sender check (below); Sara learns your provider's id from it.
5. **Test** checks the sign-in to both servers and sends nothing to anyone.

Mail that was already in her mailbox when you set her up is never answered.

## Using it

- **Email her** a question: she answers in the thread, with your mail quoted below her reply.
- **Reply** to her reply: it continues the same conversation. **A new subject** starts a new
  session. Every email thread is one session, filed in the *Email* project in the app.
- **Forward** her a mail ("what should I answer?"): she reads it as someone else's words, fenced
  off, and **every tool asks you first** in that turn (the card says "This email had someone else's
  text in it").
- **Attach** a picture or a document: pictures go to the turn, documents into her library. She can
  send files back (one mail per turn, attachments up to 20 MB in total).
- **Long mails**: the first 8,000 characters reach her. Write **"keep this"** in your mail and the
  whole mail is kept in her library as a document.
- **Commands** work in the subject or the first line: `/status`, `/new`, `/stop`, `/btw …`.
- She sends **one plain-text mail per turn**, no progress mails. A long job gets its answer when it
  ends; the app shows the run live.

## Who can reach her

- **You**: your linked address, and only when the mail passes **your provider's sender check**
  (DMARC, or DKIM/SPF aligned with your address, recorded by your provider in an
  `Authentication-Results` header). A mail from your address that fails it gets **no turn** and one
  notice a day ("…didn't pass your mail provider's sender check…"); Settings shows a banner.
- **Check my sender** (in Email settings): send her any mail from your address; Sara shows which
  provider id signed the checks, and **Use this** makes it the one that counts (after a provider
  move). If your provider records no checks at all, mail from you can't be trusted for tools.
- **Other people**: off by default. With *Let other people email her* on, only the addresses and
  `@domains` in **People who may email her** (one per line) get her, as an AI with no tools and no
  memory, the AI notice first, and their mail must pass their provider's sender check too. An empty
  list means nobody.
- **Everyone else** is ignored: never answered (no replies to forged senders), and their mail is
  never downloaded past its headers, so it never reaches a model. *Today* counts what was ignored.

## What she never answers (anti-loop)

Automatic replies (`Auto-Submitted`, `X-Autoreply`, `Precedence: bulk`), mailing lists and
newsletters (`List-Id`, `List-Unsubscribe`), bounces (`Return-Path: <>`, `multipart/report`,
`mailer-daemon@`), her own mail, mail not sent to her address, and a Message-ID she already
handled. More than 6 mails from one sender in an hour, or 20 in one thread in a day (40 and 100 for you), are ignored
and you are told once; three identical mails in a thread within 10 minutes mute that thread for an
hour. Her own mail carries `Auto-Submitted: auto-replied` so other responders stay quiet. She
writes at most *Most emails she sends a day* (50), at most 6 to one address an hour, only to the
person she answers (never reply-all), and only to people whose checked mail she has had.

## When something goes wrong

- *Password refused*: make a new app password and type it again; Sara retries at most every 15
  minutes so your provider doesn't lock the account.
- *Can't reach …*: check the server names and ports; she reconnects by herself.
- *Paused (Nothing leaves this computer)*: private local mode is on.
- A reply that can't be sent is tried again after 1, 5 and 30 minutes; a refusal tells you.

## Testing with a stand-in server (developers only)

The tests (`test/phase117b.test.ts`) use a stand-in IMAP + SMTP server written in
`test/mail-fake.ts` (TLS on a self-signed test certificate). Sara's socket broker only connects to
public addresses for mail, so a loopback stand-in needs a **test-only override**:

- `SARA_TEST_ALLOW_LOOPBACK_MAIL=1` in Sara's environment (never set by default; no setting turns
  it on): a mail endpoint may then be a loopback address (127.0.0.0/8, ::1, nothing else private),
  the port typed in the host setting (`localhost:7891`) is the one connected to, and
  `SARA_TEST_MAIL_CA=<file.pem>` is trusted for TLS. Certificates are still checked against the
  host name, and every such connection is logged as `TEST OVERRIDE`.
- Tests pass `netTestLoopback: true` to `PluginManager`, honoured only under `node --test`
  (`NODE_TEST_CONTEXT`).

```
node test/mail-fake.ts --imap 7891 --smtp 7892 --control 7893 --host ::1 --dir <scratch>
SARA_TEST_ALLOW_LOOPBACK_MAIL=1 SARA_TEST_MAIL_CA=<scratch>/ca.pem SARA_DATA=<scratch>/data node src/main.ts
```
Then use `localhost:7891` / `localhost:7892`, the address `sara@her.test` and the password
`app-pass-1234`; post raw mails to `http://127.0.0.1:7893/mail` and read what she sent at `/sent`.
Never point it at a real mailbox.
