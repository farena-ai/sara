# Handle it (W4.1)

One button on life-admin items that runs the errand end to end and stops only where the person must
act. Built on R3 errands (docs/ERRANDS.md); no second engine.

## Where the button is

| Source | Place | Starter it reuses |
| --- | --- | --- |
| Renewal | Settings → You → What Sara knows → Renewals and paperwork | `renewalAction(app, 'errand')` (src/renewals.ts) |
| Return | Money → Purchases (open item with a return window) | `startReturn` (src/money/purchases.ts) |
| Bill | Money → Bills due | new: an errand with `handleKind: bill` |
| Cancel suggestion | Money → Maybe cancel | `trimAction(app, key, 'cancel')` (src/money/trim.ts) |
| Form | Library → a PDF, Word or Excel document | new: an errand with `handleKind: form` |

The source rows keep pointing at the same errand, so the older buttons (Start a return, Open the
errand) still work, and the errand also shows on the Errands page (with **Open progress**) and in
Waiting on you.

## Flow

1. **Handle it** → `POST /api/errands/handle {kind, ref}`: makes or reuses the source's errand in
   `planning` and gives it the plan for that kind (`PLANS` in src/handle-it.ts). The window shows the
   plan as a numbered list with each stop marked. Nothing runs yet.
2. **Start** → the errand runs step by step in the background (`advance` until she needs the person).
3. She stops for:
   - **sign-in** (`Step.signIn`): always the person's own; she never types passwords. OK = "I signed in".
   - **payment** (`purchase` step): always the person's own; she never pays. They press Pay on the
     site; "I paid" (with the amount) records it. For a bill this also marks the bill paid in Money
     (tracking only).
   - **sending** (email steps, a form's send/upload) and other steps that change something (fill a
     form, the final confirm): "Send it" / "Go ahead".
4. **Pause** holds the run (the tick and Next skip it; a waiting step can't be answered until
   **Resume**). **Stop** ends it; what was done stays done.
5. The end report lists what was done, what you paid and **Receipts**: each finished step's proof line
   (a tool's read-back, "Read only", or "Your word" for what the person did).

## Plans

| Kind | Steps (stops in bold) |
| --- | --- |
| Renewal | find the official way · **sign in** · **fill the form** (stops before Submit) · **submit** · **pay the fee** |
| Return | find the receipt · how they take returns · **send the return request** · wait (follow-up) |
| Bill | find the bill in mail · find the pay page · **sign in** · **pay** · find the payment receipt |
| Cancel | find how to cancel · **sign in** · **fill the cancel page** · **final confirm** |
| Form | fill a copy with My details (a turn in the errand's chat) · **send or upload** |

## Rules

- Money is tracking only. A payment step never calls a tool; it is the person's word.
- Always allow (W0.7) may skip tool cards and email-send cards in a Handle it run (logged in the audit
  trail), never the sign-in, the submit/confirm or the payment.
- Every finished step, start, pause, resume and end is a row on the action timeline (`handle_it`).
  Undo on the "started" row stops a run that is still going.
- Routes ride the errands family (`/api/errands/handle`, `/api/errands/:id/handle[/start|ok|skip|pause|resume|stop]`):
  members get their own, the demo gets none.

## Files

`src/handle-it.ts` (plans, view, run, hooks), `src/routes/handle-it.ts`, `src/errands.ts` (pause/resume,
replan, sign-in stop, `errandHooks`, receipts in the summary), `web/handle-it.js` (window), buttons in
`web/{renewals,purchases,money,trim,library,errands}.js`, `test/w4-handle.test.ts`.
