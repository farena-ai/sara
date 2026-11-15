# Errands: start to finish

Give Sara a goal that takes a few steps over a few days ("get this charge refunded", "book an oil
change this week", "find and book a plumber", "cancel my subscription", "get quotes from 3
contractors") and she plans it, works through it one step at a time, follows up, and shows her
progress on the **Errands** page (sidebar → Errands, and an **Errands** tile on Today while one is
open).

## How it starts

- **In chat:** she drafts the plan and shows it on a card: each step, and which ones will ask you.
  One **Allow** starts it.
- **On the Errands page:** write the goal (and pick a ready plan if you like), press **Plan it**,
  check the steps, then **Start**. Nothing runs before Start.

Ready plans: **refund a charge** (finds the receipt in your mail, finds their support address, drafts a
polite refund request, follows up after 5 days), **book a service** (three nearby places, compares their
hours and ratings, asks for a booking, fills their booking form, or gives you a call script),
**cancel a subscription** (finds the cancel page, fills it, stops before the final confirm), **a dispute or
complaint letter** (follows up after 7 days) and **quotes from 3 contractors** (asks each one, waits for
the answers, lines them up for you to pick). She can also write her own plan for anything else.

## Every step that commits or costs money asks you

- **Emails** wait for your **Approve and send**. Sending without asking can be turned on for one
  errand only, by you, on its **Edit** (never by her, never for payments). A tool set to *never* in
  Settings → Tools stops that step.
- **Forms** are filled from My details on your computer and she **stops before Submit**.
- **Payments are never made by her:** she shows the page and the amount, you pay, then tap Done.
- **Calls:** with phone calls set up and on ([PHONE_CALLS.md](PHONE_CALLS.md)), the step asks on a
  card (number, what she'll say, cost estimate) and she makes the call; its summary finishes the step.
  Otherwise she gives you the number and what to say; tap Done with a note of what happened.
- **Choices** (which place, which quote) are yours: she compares them first.
- A budget stops her before anything that would cost more; a deadline stops the errand when it
  passes. Either way you get a summary of what was done and what wasn't.

## Waiting for answers

A reply in the thread (or from the person she wrote to) advances the errand and is summarized; the
inbox helper reads new mail every 10 minutes. With no reply after the step's days (5 by default), she
drafts a follow-up and asks you (two at most). You can also tell her "they called back" and she notes it.

## What she needs from you

The page lists errands waiting on you first, with the question, an answer box when it needs one (a
choice, an address, a note) and **Approve step**, **Skip**, **Stop**, **Edit**. Each errand's
**Timeline** shows every step's result and its evidence: the tool's "Verified:" read-back, the reply's
mail id, or "your word" for what you did yourself. She only says a step is done when it shows there.
You get a notification when an errand needs you (not in quiet hours or private local mode).

## Rules

- Each person's errands live in their own space; a household member's are theirs alone.
- Errands can't be started from a private chat, and nothing runs while private local mode is on.
- The runner rides the reminder tick (no timer of its own).

## For Sara (chat tools)

`errand_start` (asks once; its card is the plan), `errand_status` (steps, evidence, what she needs),
`errand_list`, `errand_update` (a note, facts, deadline, budget, add or remove a step), `errand_stop`.
Code: `src/errands.ts`, `src/tools/errands.ts`, `src/routes/errands.ts`, `web/errands.js`. Table:
`errands` in each space's own store.
