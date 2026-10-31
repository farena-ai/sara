# The board (Planner → Board)

Your to-dos as cards in columns. The board is a **view over the planner's to-dos**, not a second
list: a to-do you add in chat, by MCP's `add_task`, by a webhook or in the list shows up on the
board, and a card you add on the board is a to-do in the list.

## Columns

Every project has its own board, plus **To-dos without a project** and **Everything** (all open
to-dos, every project). A new board has four columns:

| Column | What it means |
| --- | --- |
| **To do** | Not started. |
| **Doing** | Someone (you, Sara, a helper) is on it. |
| **Waiting on you** | Sara needs something: an OK, an answer, more budget, or she couldn't prove she finished. |
| **Done** | Checked off. Moving a card here completes the to-do; completing it in chat moves it here. |

*Board settings* adds columns (before Done) and a **limit** per column: the column warns when it
holds more cards than that, so work keeps flowing. Cards still move; it only warns.

## Moving cards

- **Mouse or pen:** drag a card. Drop it between two cards or at the end of a column.
- **Touch (phone):** one column per screen. Swipe between columns or tap the column tabs. Press
  and hold a card to pick it up, then drag. To move it to the next or previous column, hold it at
  the screen edge: the column's name appears there; let go and the card lands at the bottom of that
  column.
- **Keyboard:** focus a card (Tab), press **Space** to pick it up, the **arrow keys** to move it
  (up/down in the column, left/right between columns), **Space** to drop, **Escape** to cancel.
  A screen reader hears each step, e.g. "Moved Fix login to Doing, position 2 of 5".
- **Move to** in the card's detail moves it to the bottom of another column.

## A card

Click a card to open it (a side panel on a computer, a sheet on a phone):

- **Title, notes, due date, repeat.** Lines starting with `- [ ]` in the notes become a
  **checklist** you tick on the card (the face shows 2/5). A repeating card goes back to To do with
  its next due date when you mark it done.
- **Labels:** up to 12 per board, each with a colour (Board settings → Labels). Pick them on a card.
- **Who works on it:** you, Sara, a helper, or a team of helpers.
- **Limits:** how far she may go on this card on her own: minutes, tokens, steps. Default: the team
  limits (Settings → Team).
- **Activity:** who added, moved, assigned, asked, answered, commented, with times. Add comments.

## Asking Sara to work a card

Pick **Sara** (or a helper, or a team) under *Who works on it* and press *Ask Sara to work on it*.

1. She reads the card (title, notes, labels, project) and works on it in the background, in **the
   card's own conversation** (in the project, with its workspace). The card moves to **Doing** and
   shows what she's doing right now; *Open her work* opens that conversation; *Stop* stops it.
2. **Done means receipts.** When she says she finished, each claim is checked against what she
   actually did (files written, commands run, messages sent). Only if every claim is backed does
   the card move to **Done**, with the receipts attached. Otherwise it moves to **Waiting on you**:
   "I think it's done, but I couldn't prove: …". Look, then *Continue* (she carries on), answer her, or move the card to Done yourself.
3. **A blocked card asks.** An approval she needs, a question for you, a limit reached or a step
   that failed moves the card to **Waiting on you** with the question on the card. Answer right
   there (Allow / Deny, a text box, *Continue with more budget*) and the same run carries on. The
   approval is the same one as in chat, so answering from a phone notification works too.
4. At most **2 cards** are worked at once (Board settings → *Work at once*, 1 to 4). The others
   wait in board order and show *Queued (2nd)*.

Cards waiting on you show on **Today** under *Needs you*; the cards she's working on show under
*Doing*.

She can use the board from chat too: "put the trip planning on my board", "move the login bug to
Doing", "what's blocked?". Moving a card that isn't hers asks you first (an approval card), and so
does starting work on a card. When she did the work in chat ("I fixed the login bug"), the matching
card shows *Move to Done?* instead of moving by itself.

## Shared household boards

In a household (Settings → Household) anyone can make a **shared board** and pick people. Each
person accepts an invitation first.

- Everyone on a shared board sees its cards, labels and activity. The board says who it's shared
  with.
- When you ask Sara to work a shared card, she works **in your own space**: your companion, your
  tools, your approvals, your budget and limits. Her conversation stays private to you; the others
  see the outcome and the receipts' titles.
- *Leave this board* removes your access. The creator can delete it; people assigned to a card keep
  a copy in their own planner.
- Your own boards are never visible to the others, and a shared board you're not on doesn't exist
  for you.

## Demo

The demo has a sample board (*Garden party*). *Ask Sara to work on it* shows a scripted run that
ends in Done with receipts; nothing is saved.

## For developers

- Tables (additive, in the planner database): `boards`, `board_columns` (with a `role` the worker
  understands: todo / doing / waiting / done / other), `board_labels`, `card_activity`, and new
  columns on `tasks` (`board_id`, `column_id`, `position` as a fractional index, `labels`,
  `assignee`, `work`, `repeat`). Shared boards: `<data>/shared/boards.db`.
- Code: `src/board.ts` (store), `src/board-work.ts` (the card worker and her tools),
  `src/shared-boards.ts`, `src/routes/board.ts`, `web/board.js`, `web/board.css`.
- Changes push `{type:'board', boardId, taskId?, what?}` on `/api/events` (ids only, never card
  text). Plugins with `event:board` get the same.
- Tests: `test/phase99.test.ts`, the boards case in `test/household-isolation.test.ts`.
