# Polish fixes: small functional paper cuts (P3FIXES, 2026-11-20)

Owner (2026-11-20): *"Next is some polish passing. Things for minor and better functional things, like
when you hit enter when typing to the harness it sends instead of gives another line … see anything
else little like that."* Enter-to-send, Today stock tiles and the visual restyle are other builders'
items; this pass is the rest of the "little like that".

## How the list was made

A throwaway in-process Sara (port 8673, scripted fake model, `makeApp` + `createSaraServer`) seeded as a
returning owner (4 chats with code blocks, a long chat name, to-dos, a reminder, Library documents) and
as a new owner, driven by headless Chrome at 1440 and 390 with DOM probes: focus after send and after
opening a chat, the unsent text across chat switches and reloads, Esc on every main place and on the
chat ⋯ menu, keyboard use of that menu, copy buttons, tap-target sizes, overflow, shortcuts, message
times, lingering toasts and scroll position while she writes. Code reading covered double submit,
confirmations and helpers that already existed. Script: `<scratch>/p3fixes/audit.ts`; screenshots
`<scratch>/p3fixes/shots.ts` (light/dark × 1440/390).

What already existed (kept, not rebuilt): paste a picture or file into the message box, drop files
anywhere (web/drop.js), Copy on code blocks and on her replies, Ctrl+K command bar, Ctrl+, Settings,
Alt+T/P/N… places, Esc closes every place (native `<dialog>`), Enter adds a tag / a to-do, the
"Saved ✓" tag that fades, `nearBottom` (web/smooth.js) and `busyButton` (app.js, a "Checking…" label).

## Design (one page)

One small module, `web/paper-cuts.js` (no imports, unit-tested): `Drafts` (unsent text per chat in
sessionStorage, 40 newest, never for off-the-record chats), `msgWhen` (time, plus the day when it
isn't today, words from `Intl`, so no new translations), `menuKeys` (Esc/arrows/Home/End in a pop-up
menu), `extraShortcut`, `busy` (one run at a time, `aria-busy`). app.js only wires them at the
places that switch chats, send, open menus and save; the Enter keydown handler and `SHORTCUTS` stay
untouched. CSS: two rules next to the existing `.conv-more` rules in style.css.

## Fixed (25)

| # | Paper cut (found) | Fix |
|---|---|---|
| 1 | Unsent text leaked into the next chat on phones, and was wiped on computers when switching chats | Each chat keeps its own draft; switching gives each chat its own text back |
| 2 | A reload lost what you were typing | Drafts live in this tab (sessionStorage) and come back after a reload |
| 3 | Re-opening the same chat (deep link, reload) didn't restore its draft | Same-chat redraw fills an empty box with its draft |
| 4 | Drafts of off-the-record chats would have been stored | Never stored; the box is emptied when leaving one |
| 5 | After clicking Send the focus stayed on the button | The cursor goes back to the message box (computers; phones keep the keyboard down) |
| 6 | Opening a chat from the sidebar left the focus nowhere | The cursor lands in the message box (computers) |
| 7 | Esc didn't close the chat's ⋯ menu (it stayed open over the page) | Esc closes it (not the window under it) and gives focus back to ⋯ |
| 8 | The ⋯ menu had no keyboard use | Opened with Enter, the first item takes focus; ↑ ↓ Home End move |
| 9 | The ⋯ menu stayed floating at the old place after a window resize | Menus close on resize |
| 10 | The ⋯ button was invisible while it had keyboard focus | It shows whenever its row has focus |
| 11 | The ⋯ tap target was 25×20 px on phones | 40×40 px on touch screens (row height unchanged) |
| 12 | The code-block Copy button was 46×25 px on phones | At least 44×40 px on touch screens |
| 13 | Long chat names were cut with … and had no way to read them | The full name shows on hover |
| 14 | Renaming the open chat needed the sidebar's ⋯ | Double-click the chat's title to rename it |
| 15 | Delete conversation: a double click sent two deletes; the second failed out of sight | One delete at a time; an error shows in the window; its draft is dropped |
| 16 | New project: Enter in the name did nothing | Enter saves |
| 17 | New project: a double click made two projects | Save runs once at a time |
| 18 | Your own messages had no Copy | Copy this message on your messages |
| 19 | The Copy icon disappeared after "Copied" (icon buttons came back empty) | The button's own icon comes back |
| 20 | Message times showed only the hour, so last week's message read like today's | "Yesterday, 9:30 PM", "Nov 12, 8:00 AM", the year when it isn't this year |
| 21 | Scrolling up to read while she types pulled you back down on every word | The text keeps coming without moving your view unless you're at the bottom |
| 22 | Her step lines and cards also yanked the view down | Same rule |
| 23 | The redraw when she finished jumped to the bottom | It keeps your reading place |
| 24 | No keyboard way to a new chat besides Alt+N (taken by some keyboards) | Ctrl/⌘+Shift+O starts a new chat |
| 25 | No keyboard way back to the message box | Shift+Esc puts the cursor there (from Today too); a second Esc in the search box goes back too |

Help: one new line under *Finding things* in web/help.html (translated).

## Left as they are (and why)

- Enter sends / Shift+Enter new line: another builder's item.
- Stock graphs and trackers on Today: another builder's item.
- Colours, spacing, card looks: the visual builder's item.
- Rename uses the browser's `prompt()`: works everywhere, keyboard and Esc included; a custom dialog is a
  visual change.
- A reload lands on Today, not the last chat: designed (Today is home); the chat and its draft are
  one tap away.
- Toasts: none found that stay; "Saved ✓" fades by itself.
- Paste a picture, drop files, Copy on code and on her replies, Esc on places: already there.
- Confirmations: Delete conversation has its own window with Archive instead; Delete/Archive project
  confirm (they move chats); nothing harmless asks. Left as is.
- The one-time Get started guide pops up after her first reply over whatever is open: by design
  (offered once per person).
- Message times use the browser's time zone, not the owner's Settings time zone: same as every other
  time in the web app; changing one place alone would make them disagree.
- `/` to jump to the message box: `/` opens the command menu inside the box, so a global `/` would
  surprise; Shift+Esc covers it.
- Tap targets under 40 px that remain at 390 (header model chip 93×24, "+ Project" 100×26, "Off the
  record" 148×26, her status line 149×18): part of the visual pass (they need layout changes).
