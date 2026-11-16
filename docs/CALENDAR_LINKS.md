# Calendars the easy way

Two ways to give Sara a calendar without the long Google setup by hand.

## Add a calendar by link (read only)

Settings → Connections → Apps and services → Email and calendar → **Add a calendar by link**. Paste the
calendar's private iCal address and give it a name ("Family", "Work").

Where the link is:

- **Google Calendar:** on a computer, calendar.google.com → Settings (gear) → under "Settings for my
  calendars" pick the calendar → **Integrate calendar** → copy **Secret address in iCal format**.
- **Outlook:** outlook.com or Outlook on the web → Settings → Calendar → Shared calendars → **Publish a
  calendar** → pick it, "Can view all details" → Publish → copy the **ICS** link.
- **iCloud:** iCloud.com → Calendar → the share icon next to the calendar → **Public Calendar** on → copy the
  link (it starts with `webcal://`).

What she does with it:

- Read only: the events show on Today, in the briefing, in leave-by and the weekly review, to her calendar
  tools and for the booking page's free/busy, each labeled with the name you gave it. She never changes
  them.
- She reads it again when it is older than 15 minutes (when asked, and on the reminder tick). A failed read
  keeps the last good copy and the list says what went wrong.
- Repeating events (daily, weekly with days, monthly, yearly, with count, until and interval), skipped
  dates and moved occurrences are worked out by Sara, since a published calendar doesn't do that.
- The address is a secret (anyone with it can read the calendar): it is kept in the vault and never shown
  again; the list shows only its host. Up to 10 links per person; each household member has their own.
- Gmail added with an app password says "Calendar: use Add a calendar by link, or Google sign-in".

Code: `src/calendar-links.ts` (store, refresh, RRULE expansion), `src/mail/calendars.ts` (one source per
link), routes `GET/POST /api/mail/calendar-links`, `DELETE /api/mail/calendar-links/<id>`, page
`web/calendar-links.js`. Tests: `test/calendar-links.test.ts`.

## "Let her set it up for me" (Google sign-in)

Full Google sign-in (reading and adding events, Gmail) needs a small Google app the person owns. Settings →
Gmail and Calendar → Set it up → **Let her set it up for me** opens a new chat that asks her, hands-free
(docs/desktop.md → Hands-free), to make it in her own browser on the person's computer:

1. a Google Cloud project, 2. the Google Calendar API and the Gmail API turned on, 3. the Google Auth Platform
(app name, support email, External), 4. **Publish app** (else Google signs her out every 7 days), 5. a Web
client with Sara's redirect address (the chat message carries it), 6. the person copies the Client ID and
secret into Sara and presses Sign in with Google.

`pc_google_setup` (src/google-setup.ts) reads the page in her browser and says which checkpoints are done and
what to do next. Google's sign-in pages are the person's turn (`pc_browser_your_turn`): she never types a
password or code, and she never reads the client secret into her model. Payment or phone-number requests
stop her.

Tested against fake Google pages only (`test/calendar-links.test.ts`); the real Google console can't be
tested here and changes its layout now and then, so each step names its goal in plain words.
