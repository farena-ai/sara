# Waiting on you: one queue

Everything that needs your answer is in one list. Open it with **Today → Needs you → Everything waiting
on you**, or go to `/#view=waiting`.

## What is in the list

| Row | Comes from | One-tap yes? |
|---|---|---|
| Approval | Sara's approval card in a chat that is still running | Yes, unless it is about money, a password, your computer or a spending limit |
| Team step | A team task's step that needs your OK | No, open it |
| Device | Another device asking to sign in (owner only) | No: the code is on that device |
| Her question | A board card she parked with a question | No, open it and answer |
| Errand | An errand step that waits on you | Yes for a draft email (**Send the draft**); no for payments, choices, addresses |
| From your inbox | An inbox helper card (package, trip, appointment, school…) | Yes (**Accept**), except bills, receipts and paid invoices |
| Overdue | An open to-do past its due time | No, open the Planner |
| Failed | A chat whose last run failed and that you haven't opened since | No, open the chat |
| Mail to answer | A real person's email still waiting for your reply (with a mailbox connected) | No: **Open** asks Sara to draft a reply |

Urgent rows come first (something is blocked until you answer, or a due date is close), then the
oldest. Each row's **Open** goes to its own card: the chat, the board card, the errand, Today's inbox
card or the Planner.

## Buttons and swipes

- **Approve / Send the draft / Accept**: the same answer as the card itself. Shown only where one tap
  is enough.
- **Later**: hides the row until tomorrow. It is the same list as Today's **Not today**, so putting
  something off in one place puts it off in both.
- **On a phone**: swipe a row right for the one-tap yes, left for Later. A right swipe on a row that
  has no one-tap yes bounces back and says why. Money and passwords never go by a swipe or one tap.

## Household

Each person sees only their own list: their chats, errands, inbox cards, board and to-dos. Device
sign-in requests are only on the owner's list.

## Design (one page)

- `src/waiting.ts`: a read-only aggregator. It reads each place that already holds a waiting thing
  (the server's running turns, the team manager, device approvals, `BoardStore.today()`, errands,
  the inbox helper, the planner, `RunStore.failedUnseen`, and mail follow-ups from
  `src/biz/followups.ts`). There is no second store. Row keys are Today's Needs you keys, so Later =
  Today's "Not today" (`addNotToday`, cleared at local midnight).
- One-tap rule: approvals use `voiceMayApprove` (src/phone-actions.ts: no money, password, computer,
  spend, price, sandbox or untrusted cards); inbox money kinds (`bill`, `receipt`, `invoice_paid`)
  and errand purchases are excluded. The server refuses one-tap answers for any other row (409).
- `src/routes/waiting.ts`: `GET /api/waiting` (`{items, counts}`) and `POST /api/waiting/act`
  (`{key, action: 'approve' | 'later'}`), a member route (each space's own stores). Mail follow-ups
  are read at most every 30 minutes and only with a mailbox connected.
- `web/waiting.js`: the `#waiting` dialog, the Today link (`ctx.openWaiting`) and touch swipes
  (pointer events, mouse ignored). Tests: `test/v1-waiting.test.ts`.
