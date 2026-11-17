# Several accounts: every mailbox and calendar together

Many people have more than one mailbox: a personal Gmail, a work Gmail or Google Workspace, an
Outlook, an iCloud. Sara reads them all together. This page explains how; the basics of adding each
kind are in [EMAIL.md](EMAIL.md) (Outlook, IMAP providers) and [GMAIL.md](GMAIL.md) (the Google sign-in).

## Adding accounts

Settings → Connections → Apps and services → **Email and calendar** and **Gmail and Calendar** show
the same list: every account with what it is used for (**Mail ✓**, **Calendar ✓**, **Docs ✓**), and
one button, **+ Add an account**, with every kind behind it:

- **Google account**: Google sign-in through your own Google app (set up once on the Gmail and
  Calendar page; without it this choice opens those steps). Google shows its account picker; pick
  the account to add and allow Sara. Each Google account has its own sign-in and its own permissions
  (Gmail, Calendar, and Docs/Sheets if you allow them). Up to 10 Google accounts.
- **Gmail with an app password**: mail only, no Google app needed; once per address.
- **Outlook or Microsoft 365**: as many times as you like.
- **Another provider** (Yahoo, iCloud, Fastmail, Zoho, GMX…): with an app password.

Each Google row has **Reconnect** (sign in again, e.g. to allow more) and **Remove** (its sign-in is
revoked at Google; the others stay). Other rows have **Check it** and **Remove**.

**Nothing is ever replaced.** Whatever button you use, signing in to Google with an address that is
not listed yet ADDS it next to the others; signing in with an address that is listed renews that
account's sign-in in place. Up to 3.18.1 the Gmail and Calendar page's *Sign in again* re-signed
the first Google account, so picking another account in Google's picker swapped the first one out:
an account lost that way can't come back by itself, but adding it again is one click on
**+ Add an account → Google account**. Saving the same Google app again (for example with a new
client secret) keeps every sign-in; only a different app (another Client ID) starts over, because
Google's sign-ins belong to the app.

Asking in the chat works too: "add another email account" or "connect my other Gmail" gets a card
with the accounts already there and a **+ Add an account** button that opens the choices.

## Calendars from every account

- **Google**: each Google account's main calendar shows; under **Calendars** you can tick others
  (shared or family calendars) or untick an account entirely.
- **Outlook / Microsoft 365**: the account's main calendar (on or off).
- **iCloud, Fastmail, Yahoo**: press **Turn on calendar** on the account. The same app password opens
  the provider's calendar (CalDAV); every calendar with events is listed and can be ticked. For other
  providers Sara asks for the calendar (CalDAV) address from your provider's help pages.
- **Gmail with an app password** can't open Google Calendar (Google only allows that through its own
  sign-in): use *Add another Google account* for that calendar.

Today, the morning briefing, leave-by reminders, the weekly review, the booking page's free times
and the calendar tools read every chosen calendar. With more than one calendar each event says which
account it is from (a small coloured dot and the name, e.g. *alex@work*).

**New events**: when you don't say which calendar, she asks you. To skip the question, pick a default
under **Calendars → New events go to**. Saying it works too: "add it to my work calendar".

## The combined inbox

Today's Mail card, searches ("find the email about the lease") and "what's waiting for my answer?"
cover every mailbox by default. Each email is labeled with its mailbox. Under **Combined inbox and
Today** you can leave a mailbox out (it is still there when you name it: "search my Yahoo for…").
The inbox helper has its own choice of mailboxes (Inbox helper section on the same page).

## Which address a reply goes from

- **A reply** goes from the mailbox that received the email.
- **A new email** goes from your default mailbox, unless you name another ("from my work address")
  or only another mailbox has written with that person before; then that one.
- The approval card shows **From:** before anything is sent.

## Privacy

Each person's accounts are their own: a household member's mailboxes live in their own vault and
never mix with the owner's. Google sign-ins are the owner's (members add Gmail with an app password).
Addresses are shown on cards; tokens and app passwords stay encrypted in the vault and are never
shown. The combined-view choices are kept in `mail-view.json` in your data folder (no secrets).

## For developers

- `src/google-accounts.ts`: `GoogleAccounts` over `GoogleAccount` (first account `google`, vault
  `google:token`; later ones `google:<n>`, vault `google:token:<n>`, list `google:accounts` = `{n:[…]}`).
  `authUrl(redirect, {add})` opens a new slot; `finish` routes by the PKCE `state`; the same address
  renews its own sign-in; a different address than the row that asked is added as a new slot
  (`added: true`, callback `#google=added`) and that row's old sign-in is put back.
  `GoogleAccount.setClient` returns whether the Client ID changed (only then do sign-ins go).
- MAILMULTI web: `web/mail-accounts.js` `loadMailAccounts(where)` draws the one list into `#ma-page`
  (Email and calendar) or `#g-accounts` (Gmail and Calendar); `GET /api/mail/accounts` `googleApp.accounts`
  lists every Google sign-in with `gmail`/`calendar`/`docs`. The chat tool `mail_add_account` (always
  offered) returns the accounts and the page link; `src/cards.ts` turns it into an `open` card
  (web/result-cards.js `openCard`).
- `src/mail/caldav.ts`: CalDAV discovery (principal → calendar-home-set → calendars with VEVENT),
  REPORT with `expand`, ICS read/write, PUT/DELETE. Presets: iCloud, Fastmail, Yahoo.
- `src/mail/calendars.ts`: `calendarSources` / `allEvents` (labels only with more than one source).
- `src/mail/accounts.ts`: `googleAccounts()`, `googleOf(id)`, `view()/setView()` (mail-view.json:
  `off`, `calendars`, `calendarDefault`), `combined()`, `enableCalendar()`.
- `src/tools/mail.ts`: `googleFor` hands a later Google account to its own gmail_* tools; `mail_search`
  and `mail_needs_answer` read `combined()` without an account; ids seen in results remember their
  mailbox; `mail_send`/`mail_draft` `prepare` decides the From mailbox and writes it into `account`.
  Gmail organizer undo ids of later accounts are `g<n>_…`.
- Routes: `GET/PUT /api/mail/view`, `GET /api/mail/calendars`, `POST/DELETE /api/mail/accounts/:id/calendar`,
  `POST /api/google/connect {add:true}` or `{id}`, `DELETE /api/google/accounts/:id`.
- Tests: `test/multimail.test.ts` (fake Google with two people, fake CalDAV server, per-account Gmail
  stand-ins); `test/mailmulti.test.ts` (route level, real in-process server: different address adds,
  same address renews, the first slot, same app keeps sign-ins, both pages, the chat card).
