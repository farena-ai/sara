# Gmail: reading, drafting and organizing

Sara works with your Gmail through Google's own APIs, signed in with a small Google app (OAuth
client) that **you** own. Nothing goes through anyone else's servers. Set it up once in
**Settings → Add-ons → Gmail and Calendar** (the steps are on that page, about 10 minutes).

## What she can do

| Ask her… | Tool | Asks you first? |
|---|---|---|
| "Anything from Ana this week?" | `gmail_search`, `gmail_read`, `gmail_thread` | No (reading) |
| "What needs an answer?" | `gmail_needs_answer` | No |
| "Draft a reply" / "send it" | `gmail_draft` / `gmail_send` | Yes |
| "Archive all my email from Oct 1st, 2026 or older" | `gmail_organize` | **Yes, every time, with the count** |
| "Mark them all as read", "star everything from my boss", "label these Receipts", "move the promotions older than a year to trash", "this is spam" | `gmail_organize` | **Yes** (trash and spam always ask, even if you allow the tool) |
| "Undo that" | `gmail_undo` (or the **Undo** button on the result card) | Yes (the button is your own click) |
| "What are my labels?" | `gmail_labels` | No |
| "Who fills up my inbox?" (a clean-up summary: top senders and categories with counts) | `gmail_senders` | No (sender headers only, never the text) |
| "How do I unsubscribe from this?" | `gmail_unsubscribe_info` | No: she shows the List-Unsubscribe link or address; **she never opens it or sends it herself** |

### Organizing (`gmail_organize`)

Actions: archive, read, unread, star, unstar, important, not important, add / remove a label (she can
make a new label), move to trash / take out of trash, spam / not spam. **There is no permanent
delete**: trash is as far as she goes (Gmail empties its trash after 30 days).

She picks the emails with a Gmail search (`from:`, `to:`, `subject:`, `label:`,
`category:promotions`, `is:unread`, `has:attachment`, `larger:10M`, `older_than:1y` …), with plain
date words, or with exact email ids.

**Dates are read in your time zone** (Settings → You → About you → Time zone). "Oct 1st, 2026 or older" becomes
`before:2026/10/02`: Gmail's `before:` leaves the day itself out, so the day after is the right
boundary; "before Oct 1" is `before:2026/10/01`, "last week" is Monday to Sunday of last week,
"before September" is `before:2026/09/01`. The search sent to Gmail uses the exact midnight in your
time zone (Gmail would otherwise read the date as Pacific time).

**Count first.** Before anything changes, the approval card says exactly what will happen, e.g.
*"Archive 4,213 emails?"*, with the search, a few of the emails (sender and subject) and what to
expect. Only emails the change really changes are counted (archive counts only what is still in the
inbox; "read" only unread ones), so the count is honest and Undo is exact.

**Any size.** Up to 50,000 emails per approved change (more needs another OK for the next batch).
Changes over 2,000 emails run as a background task: progress shows above the chat, **Stop** stops
it, and the result card arrives in the chat when it ends. Google's rate limits are handled by
waiting and trying again.

**Undo for 30 days.** Every change is recorded (which emails, which labels). The result card has an
**Undo** button and an **Open in Gmail** link to the same search; "undo that" in the chat does the
same. Undo reverses exactly the emails that change touched (archive → back in the inbox, read →
unread again, trash → out of the trash …).

## Setting up the permission for organizing

Organizing needs one more Google permission than reading and drafting:
`https://www.googleapis.com/auth/gmail.modify` (change labels, archive, trash, spam; it **cannot**
delete for good). Sara asks for it when you sign in.

- **New setup:** follow the steps in Settings. If your Google app lists its permissions (scopes)
  under *Google Auth Platform → Data access*, add `.../auth/gmail.modify` there next to
  `gmail.readonly`, `gmail.compose` and `calendar.events`.
- **Already connected before this version:** Settings → Add-ons → Gmail and Calendar shows
  **Reconnect to allow organizing**. Press it, sign in again and leave all the boxes ticked. Until
  then, Sara answers organizing requests with "Reconnect Google in Settings … to let me organize
  your mail" and changes nothing.

`gmail.modify` is one of Google's *restricted* scopes, like `gmail.readonly` that Sara already
uses. That is fine for a self-hosted, personal OAuth client: Google's verification and security
assessment are only required to offer an app to the public. Keep the app either in **Testing** with
yourself added as a test user (Google then signs you out every 7 days), or **published but
unverified** for your own use (the setup steps' choice; you see the "Google hasn't verified this
app" page once and choose *Advanced → Go to Sara*).

## Who can use it

- **The owner only.** Household members don't have Google tools at all (and never the owner's
  mailbox).
- **Private local mode** ("Nothing leaves this computer") and private conversations switch all
  Gmail tools off: they need the internet.
- **The public demo** never has them.
- **Other apps** (the `/v1` API, MCP): no Gmail tools of their own. When "her tools" are allowed for
  another app, a change still waits for your OK in Sara.
- Email content is from other people: she reads it as information, never as instructions.

## For developers

`src/gmail-organize.ts` (paging, `batchModify` in chunks of 1,000, per-message trash with four at a
time, back-off on 429/5xx, the `gmail_actions` undo table), `src/gmail-dates.ts` (date words → Gmail
search words), `src/tools/gmail-organize.ts` (the tools; `prepare` counts before the approval card),
`web/gmail-view.js` (the approval section and the result card). Tests run against a local fake
Gmail API (`test/gmail-organize.test.ts`). `SARA_GOOGLE_API_BASE=http://127.0.0.1:<port>` (loopback
only, test use) points the Google APIs at such a fake.
