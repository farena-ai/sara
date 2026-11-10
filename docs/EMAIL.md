# Your email and calendar: Gmail, Outlook and the rest

Sara reads, searches, answers and tidies **your own** mailboxes, whichever provider they are at, and
works with your calendar. Everything is set up in **Settings → Add-ons → Email and calendar**.
(Her *own* mailbox, the one you write to, is a different feature: [EMAIL_BRIDGE.md](EMAIL_BRIDGE.md).)

## Which providers

| Provider | How Sara signs in | Mail | Calendar |
|---|---|---|---|
| **Gmail** (the **Add Gmail** button) | App password (2-Step Verification on; IMAP + SMTP), 3 steps below | ✓ (folders; Gmail labels show as folders) | — |
| **Gmail / Google Workspace, advanced** | Your own Google app (OAuth). Steps: [GMAIL.md](GMAIL.md) | ✓ (labels, stars, categories) | ✓ |
| **Outlook.com, Hotmail, Live, MSN, Microsoft 365** | Your own Microsoft app (OAuth, Microsoft Graph). Steps below | ✓ (folders, categories, flags) | ✓ |
| **Yahoo Mail, AOL** | App password (IMAP + SMTP) | ✓ (folders, flags) | — |
| **iCloud Mail** | App-specific password | ✓ | — |
| **Fastmail** | App password | ✓ | — |
| **Zoho Mail** (.com / .eu) | App password; IMAP access switched on | ✓ | — |
| **GMX, WEB.DE** | IMAP switched on in their settings; an application-specific password with two-step sign-in | ✓ | — |
| **Proton Mail** | Proton Mail Bridge on the same computer (paid Proton plans) and the password Bridge shows | ✓ | — |
| **Other** | Type the IMAP and SMTP servers and the app password | ✓ | — |

Outlook.com no longer lets programs in with a password over IMAP (Microsoft switched it off in
September 2024): Microsoft requires its own sign-in, which is why Outlook goes through Microsoft Graph
with an app you own. Nothing goes through anyone else's servers.

You can connect **several mailboxes** (for example Gmail and Outlook). One is the **default**: she
uses it unless you name another ("search my Outlook for the invoice", "what needs an answer in all my
mail?"). Today's Mail card and the morning briefing show the default mailbox (and its calendar).

## Adding Gmail (3 steps, about 3 minutes)

**Add Gmail** opens the simple route: an app password (3.3.0; before that it opened the Google Cloud
setup). An app password is a separate password just for Sara, made by Google; it is not your normal
password and you can delete it at Google any time.

1. Press **Where to make an app password** and sign in at Google. 2-Step Verification must be on
   (Google Account → Security → 2-Step Verification).
2. Under App passwords, name it *Sara*, press **Create** and copy the 16 letters.
3. Back in Sara: your Gmail address, paste the app password, **Add and check**.

The server names are under *Server details (you can ignore these)*. **Advanced: full Gmail organizing
(Google Cloud)** under the form is the older route with your own Google app ([GMAIL.md](GMAIL.md),
about 10 minutes): only needed for Gmail labels and Google Calendar.

### When a check fails

**Add and check** and **Check it** on a connected mailbox say why in plain words:

| What you see | What it means |
|---|---|
| *didn't accept that app password* | The password was wrong (or it was your normal password). Make a new app password and paste all of it. |
| *wants an app password … 2-Step Verification on first* | Two-step sign-in is off at the provider, so it has no app passwords yet. |
| *IMAP is switched off* / *Mail apps are switched off* | Switch IMAP on in the mailbox's web settings (Gmail: Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP). |
| *couldn't reach the mail server* | No internet on Sara's computer, or a mistyped server name. |

The server's own words are under *What the server said*.

## Connecting Outlook or Microsoft 365 (3 steps, about 5 minutes, once)

Outlook.com, Hotmail and Live **no longer accept app passwords for mail apps**: Microsoft switched
Basic Authentication off for personal accounts on 16 September 2024 and requires its own sign-in
(OAuth). So Outlook stays on the Microsoft sign-in (Microsoft Graph). Microsoft wants a sign-in app
registered by someone for that; Sara can't ship a shared one without a publisher account and
Microsoft's review, so you register your own, free. Since 3.3.0 it is a *public client* app: **no
client secret** to make, copy or renew.

Settings → Add-ons → Email and calendar → **Add Outlook or Microsoft 365** shows:

1. **Make a free sign-in app at Microsoft (once).** Press *Open Microsoft app registrations*, sign
   in with the same Microsoft account as the mailbox (a personal Outlook.com account gets its own
   free space the first time), press **New registration**, name it *Sara*, pick *"Accounts in any
   organizational directory and personal Microsoft accounts"*. Under **Redirect URI** pick
   **Public client/native (mobile & desktop)** and paste the address Sara shows (Copy button), then
   **Register**.
2. **Copy its ID into Sara.** The app's Overview page shows the *Application (client) ID*
   (`1a2b3c4d-…`): paste it and **Save**.
3. **Sign in with Microsoft**, pick the account, **Accept**. Sara asks for mail and calendar access
   at sign-in, so no API permissions need ticking.

An app registered as **Web** before 3.3.0 keeps working: its client secret is under *Only if you
picked "Web" instead*. A Web app's secret expires (24 months at most); the account then shows
*Signed out*: make a new secret, save it and sign in again. Removing Sara's access on Microsoft's
side: account.live.com/consent/Manage (personal) or My Apps (work accounts). Microsoft accepts
`http://` only for `localhost`/`127.0.0.1`: sign in from the server's own computer, or use Sara over https.

## Connecting another provider

**Add another provider** → pick it → the card says where that provider makes an app password, with
the link → type your address and the app password → **Add and check**. Sara signs in to both servers
(IMAP and SMTP) before anything is saved and sends nothing. Your normal password won't work.

- **iCloud**: Sara tries the whole address, then the name before the @, as Apple asks.
- **Proton Mail**: Bridge must be running on the same computer as Sara. Its certificate is
  remembered the first time; if you reinstall Bridge, remove and add the account again.
- **Other**: IMAP on 993 (or 143 with STARTTLS), SMTP on 465 (or 587 with STARTTLS). Sara always
  encrypts and checks the server's certificate; she connects only to public mail servers.

## What she can do

| Ask her… | Tool | Asks you first? |
|---|---|---|
| "Anything from Ana this week?", "find the invoice in my Outlook" | `mail_search`, `mail_read`, `mail_thread` | No (reading) |
| "What needs an answer?" (one mailbox, or "all") | `mail_needs_answer` | No |
| "Draft a reply" / "send it" | `mail_draft` / `mail_send` | **Yes** |
| "Archive everything from the shop older than a year", "flag these", "put them in Receipts", "move to the Taxes folder", "this is spam" | `mail_organize` | **Yes, with the count** (trash and spam ask every time) |
| "Undo that" (or the Undo button) | `mail_undo` | Yes |
| "What folders do I have?" | `mail_folders` | No |
| "Who fills up my inbox?" | `mail_senders` | No (sender headers only) |
| "How do I unsubscribe from this?" | `mail_unsubscribe_info` | No: she shows the link, never opens it |
| "What's on my calendar?", "add lunch Friday at noon", "move it to 1", "delete it" | `calendar_events`, `calendar_add`, `calendar_update`, `calendar_remove` | Adding, changing and removing ask |
| "Which mailboxes do you see?" | `mail_accounts` | No |

The `gmail_*` tools keep working exactly as before; for a Gmail mailbox the `mail_*` tools hand the
request to them.

### How organizing maps to each provider

| You say | Gmail | Outlook (Graph) | IMAP providers |
|---|---|---|---|
| archive | out of the inbox | **Archive** folder | the **Archive** folder (special-use, or one named Archive) |
| read / unread | ✓ | ✓ | ✓ (\Seen) |
| star / unstar | star | **flag** | **flag** (\Flagged) |
| important | ✓ | high importance | not available |
| label | label | **category** (she can make one) | a keyword, where the server allows it |
| move to a folder | use a label | ✓ | ✓ |
| trash | Trash (Gmail empties it after 30 days) | **Deleted Items** | the **Trash** folder |
| spam | Spam | **Junk Email** | the **Junk / Spam / Bulk** folder |

**Never a permanent delete.** Trash is as far as she goes, on every provider. Each change shows the
count and a few examples first, is limited to 50,000 emails per OK, runs in the background when it is
big, and can be **undone for 30 days** (Outlook keeps each message's id when it moves; for IMAP Sara
finds each message again by its Message-ID).

### Search words

The same words as Gmail, where the provider can do them: `from:` `to:` `subject:` `is:unread`
`is:read` `is:starred` `has:attachment` `in:inbox|sent|trash|spam|archive|"Folder"` `label:`
(category in Outlook) `before:` `after:` `older_than:` `newer_than:` `larger:` (not Outlook), plain
words and `-word`. Date words ("last week", "Oct 1st or older") are read in your time zone. Gmail-only
words (`category:promotions`, `OR`, groups) get a plain "only works in Gmail" instead of a wrong
result. Without `in:`, an IMAP search looks in the inbox and the archive; Outlook searches every
folder except Deleted Items and Junk Email.

## Who can use it

**Everyone in the household, each with their own mailboxes.** The owner connects theirs as above.
A household member opens the same page (Settings → Add-ons → Email and calendar) in their own
space and adds their own:

- **Outlook / Microsoft 365**: *Sign in with Microsoft* with their own Microsoft account. It uses the
  Microsoft app the owner registered once (members can't change it; until the owner adds it, the page
  says to ask them).
- **Gmail**: with a Google app password (the *Gmail (app password)* provider). The Google sign-in
  with Gmail's labels, categories and Google Calendar stays the **owner's only**: Sara has one Google
  connection per server, made with the owner's own Google Cloud app, and Google only lets an app in
  testing sign in the people its owner lists by hand (Gmail's full access needs Google's paid
  security review before anyone else can use it). An app password needs no app of the owner's.
- **Yahoo, iCloud, Fastmail and the rest**: an app password, the same as for the owner.

Each person's mailboxes are theirs alone. A member's list, sign-ins and app passwords are kept in
their own encrypted vault inside their space (`members/<id>/mail`); only their own companions'
tools, their Today card, their morning briefing, leave-by reminders and weekly review use them.
Nobody else on the server sees them, **the owner included**: the owner's Sara never lists, reads or
changes a member's mail, and a member never sees the owner's. Sending, drafting and tidying ask the
member first, on their own approval cards. Removing a member deletes their mailboxes with their space.

An admin can switch members' mail off for the whole server with the policy pin *Turn off household
members' own mailboxes* (`"memberMail": false`, [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)): members
then can't add or use mailboxes (they can still remove them); the owner's mail is not affected.

The public demo has no mail. Private conversations get no mail tools, and private local mode
("Nothing leaves this computer") pauses every mailbox, for the owner and members alike. Email text is
someone else's words: she treats it as information, never as instructions. Tokens, client secrets
and app passwords live only in Sara's encrypted vault; they are never shown again, logged or
exported, and the account list holds no secrets.

## For developers

`src/mail/` (types, `search.ts` translator, `graph.ts` Microsoft sign-in and Graph, `imap.ts` on the
email bridge's IMAP/SMTP/MIME code, `socket.ts`, `presets.ts`, `accounts.ts`, `organize.ts` with the
`mail_actions` undo table), `src/tools/mail.ts` (the `mail_*` tools and the calendar routing),
`web/mail-accounts.js` (the Settings page). Design: [ops/MAIL_PROVIDERS_DESIGN.md](ops/MAIL_PROVIDERS_DESIGN.md).
Tests run against stand-ins only: `test/mail-graph-fake.ts` (Microsoft sign-in + Graph) and
`test/mail-imap-fake.ts` (IMAP with folders, TLS) with `test/mail-fake.ts` (SMTP). Test-only:
`SARA_MS_GRAPH_BASE` / `SARA_MS_LOGIN_BASE` (loopback only) point Sara at a fake Microsoft.
