# Today

Today is Sara's home screen. The app opens on it, unless a link (a notification, a shared link) takes
you straight to a conversation or a place. Open it from the sidebar, from her face and name at the top
of the sidebar, with **Alt+T**, or from the bar at the bottom of a phone. **← Chat** or **Esc** takes
you back to the conversation you were in.

The design and its reasons are in [design/TODAY.md](design/TODAY.md). This page is the user guide.

## What is on it

At the top is a greeting with her face and mood. Under it are **Plan my day with her**, **Refresh**,
**Customise** and a line saying when the page was last updated. Then come five sections, always in
this order unless you change it:

| Section | Tiles |
|---|---|
| **Your day** | *Your day*: one timeline of today's calendar events, reminders, to-dos with a time and leave-by times, with a *Now* marker and a ring for what you finished today. *Weather* for the place of your morning briefing. *Coming up*: the next 7 days of events, dates she remembered and birthdays from your People cards. |
| **Needs you** | *Needs you*: one list with approvals waiting for you, failed jobs and runs, overdue to-dos (oldest first), board cards waiting on you, important mail and webhooks. *Not today* puts an item off until midnight. *Mail* (see below). |
| **With her** | *She remembered* (the newest things she learned about you), *On this day* (a photo from this day, or your newest moments), *Her plans*, and *Rooms* if you switch it on (see below). |
| **Work** | *Running now* (or the last job), *On the board*, *Coding projects* (last change, last tests, open pull requests when GitHub is connected), *Usage today* (tokens and the estimated cost since midnight; local models and subscriptions are $0). |
| **Home & more** | *Home* (who is home, the scenes you picked, a few devices), *Model changes*, *Webhooks* (off at first), *Planner* (off at first), *Add to your day*. |

- A tile with nothing to show is left out, and a section with no tiles hides its heading. *Add to
  your day* lists what is not set up yet (weather, calendar, Gmail, Home Assistant, GitHub), each with
  its own *Hide*.
- Tiles that read from outside (calendar, mail, weather, Home Assistant, GitHub) have a small
  *Updated N min ago* line. If a source can't be reached, the tile says so and keeps its last answer,
  marked *May be out of date*.
- The page updates itself while it is open. An approval appears in *Needs you* as soon as she asks,
  a finished job shows under *Running now*, and the *Mail* tile catches up after every change she
  makes to your inbox.
- After you've been away for a while (8 hours by default), a short line at the top says what happened:
  messages from her, jobs that finished, new things she learned, new moments and emails she
  organised. It is built from her records, without a model call. Close it with ×. You can change how
  long counts as away (4–24 hours, or Off) in *Customise*.

## Mail

The *Mail* tile shows your Gmail inbox: the total, unread, the change since yesterday's first look,
what looks important, and **what she organised today** (for example *Labelled 3,300 as Receipts*,
*Archived 418*) with *Undo* on each line.

Since 2.44.0 the tile no longer shows old numbers after she tidies your inbox. When she runs an
organize (from a chat or a job), the tile reloads when the run finishes, every 500 messages during a
long run, and when you press *Undo*, whether on Today or in the chat. *Refresh* always reads Gmail
again. Each companion keeps its own *She organised today* list.

## Customise

**Customise** (or **Customise Today** in the command bar, Ctrl/⌘ K) opens a side sheet. The page stays
visible next to it, so you see each change as you make it.

- **Move** tiles and whole sections with the arrows, or drag the grip.
- **Resize** a tile: S, M or L, whichever sizes that tile allows. Every row is filled; the tiles in a
  row share any space left over.
- **Hide** or show any tile with its switch. Hiding from a tile's ⋯ menu gives you 8 seconds to undo.
- **Reset** brings back the designed layout after one confirmation.
- Settings at the bottom: *Since you were away after*, *Away note: a sentence from her*, *Away note:
  include rooms*, *Needs you: include mail*, *Usage today: show cost*, *Coming up: how far* (7, 14 or
  30 days), *Phone: when Today opens*, and *Show the Rooms tile*. Each has a **?** tip.

Every tile also has a **⋯** menu with *Smaller*, *Larger*, *Move up*, *Move down* and *Hide this tile*.
With the keyboard, focus a tile and press **Alt+↑/↓** to move it or **Alt+←/→** to resize it; a screen
reader announces each change.

Your layout is saved on the server **for this companion**, so it follows you to every computer and
phone you use her on. A second companion has her own Today, and household members arrange their own.

## Rooms (off by default)

The *Rooms* tile gives a short summary of the Discord channels and Telegram groups she **keeps up with**
(*Keep up with this room*): the current topic, who spoke in the last few hours, when the last message
came, and **Peek** to open the room's window.

- Switch it on in *Customise → Show the Rooms tile*, then pick which rooms show (all of them by
  default).
- Rooms where keep-up is off never appear, and a room you *Forget* disappears from the tile.
- It reuses her own rolling room summary, so it makes no model calls. A room without a summary yet
  shows its latest topic words.
- It is only for you on your main companion. It never shows for household members or in the demo,
  and nothing from it goes into her memory or into any other tile.

## Household members and the demo

A household member sees their own Today: their day, their reminders and to-dos, their memories and
moments. The server never sends them your mail, approvals, failed jobs, home, usage, coding projects,
webhooks or rooms. The demo shows sample tiles and can't be customised.

## Since you were away

After you have been away for a while (8 hours by default; *Customise → Since you were away after*,
Off to never show it), a short note above the sections says what happened: messages she sent on her
own, background jobs that finished (and how many failed), new things she learned, new moments and
emails she organised. It is counted from the records, with no model call. Dismiss it with ×; it never
shows twice for the same absence.

Two switches add to it, both **off** until you turn them on:

- **Away note: a sentence from her** starts the note with one sentence in her voice. A small model
  writes it (a model on your own hardware first, else your quick model), from the counts only; it is
  made once per absence, appears a moment after Today opens, counts in *Usage* and never goes into
  her memory.
- **Away note: include rooms** adds how many chat rooms she answered in, with their titles. Nothing
  anyone said there is shown. Only for you on your main companion; household members never get it.

## Phones and tablets

**On a phone** Today answers "what now, and anything for me?" first:

- A compact header: her face, the greeting, and **Refresh** and **Customise** as icons.
- The **Now** card: the next one or two things with how soon (*Standup in 18 min*, *Leave by 2:35 for
  Dentist*), the weather in one line (*rain from 4 pm*), her mood, today's date and *Plan my day with
  her*. When nothing needs you it says so here, and the Needs you section stays away.
- Then, in this order: **Needs you** (the top three, *See all* for the rest), **Your day**, **Weather**,
  **Mail**, then your other sections in your order. *With her* and *Work* are rows of cards you swipe
  sideways; the ‹ › buttons and dots under a row do the same without swiping, and Tab reaches every
  card.
- **Tap a heading** to fold or unfold a section. A folded section says what is in it (*Mail 1,204 in
  inbox · 37 unread*); Needs you always shows its count. Phones and tablets remember their own folded
  sections for this companion, so folding Work on your phone doesn't fold it on the computer.
  *Customise → Phone: when Today opens* picks *As I left it* (the default), *Everything open* or *Only
  Now open* (Needs you still opens when something needs you).
- **Pull down** at the very top to refresh everything. It is the same gesture in the browser, the
  installed web app and both phone apps. With *reduce motion* on, you only see the spinner.
- Coming back to Today after more than two minutes away reloads only what is out of date (mail,
  calendar, home…), quietly.

**On a tablet** Today keeps the desktop order in two columns with the Now card on top, and the section
headings fold the same way. Android's back button closes an open menu or the Customise sheet before
it leaves Today.
