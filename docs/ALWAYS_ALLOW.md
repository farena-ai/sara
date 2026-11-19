# Always allow everything (W0.7)

One switch per person: while it is on, Sara runs every command, desktop, browser and computer-use
action she takes **for you** without an approval card, including the kinds that otherwise always ask
(payments and purchases, account and security settings, saved logins, destructive commands, the
browser's own settings pages, form-fill review cards, the plan check, advisory and ship-gate cards).

Where: **Settings → Connections → Computer use → Always allow everything** (top of the page).

## Turning it on

1. Pick how long: **1 hour**, **1 day** or **Until I turn it off**.
2. Press **Turn on…** and read the one-time warning.
3. Confirm it's you: your owner token, the current two-step code, or a passkey (the same step-up as
   making an API key). From a remote device the owner approves it first (new-device approval).
4. On your computer, the Sara app shows its own card once with **Always allow everything**: press it
   there. A phone can never relax what a computer allows; after that one press the computer asks
   nothing until the switch ends (it ends with its time, or the next time the switch is turned on it
   is a new stretch and the computer asks once again).

While it is on, a red **Always allow is on** bar with **Turn off** sits above the chat box. Turning it
off (there or in Settings) takes effect at once; nothing asks for a password to turn it off.

## What it never changes

- She never types into password fields and never types text shaped like a key or a sign-in token
  (she hands those over with "your turn"). These are limits, not approvals.
- Hidden windows and tabs, banking and password managers stay off limits; administrator prompts are
  your click; the browser's own password, payment and sync pages stay blocked.
- Requests from other people still ask: other apps, outside requests, forwarded mail or messages,
  answers from a linked server, group chats. The switch covers what **you** ask her to do.
- A tool you set to **Never** stays off. Spend limits still stop paid calls.
- Household members never press Pay, Buy or Place order (R7).
- Everything still goes to the **Action timeline** (with Undo where there is one) and to the
  **audit trail** (`approval.always_allow` per action, `always_allow.on` / `always_allow.off`).

## Who may use it

- The owner.
- Household adults only when the owner ticks **May turn on Always allow everything** on their card in
  Settings → Household. Taking it back turns theirs off at once.
- Never kids (kid-safe members), demo or off-the-record spaces, and never when an organization policy
  forbids Always allowed (`pins.alwaysAllow: false`).

## For developers

- State: `src/always-allow.ts` (`<dataDir>/always-allow.json`, per person; expiry checked on read).
- Route: `GET/PUT/DELETE /api/computer/always` (`PUT {on:true, for:'1h'|'1d'|'off', warned:true, token|code|passkey}`).
- Server cards: `src/chat.ts` (ask → auto for the person's own turns), `src/computer-policy.ts`
  (`allowAll` on every verdict), `src/tools/computer.ts` and `src/tools/pc-run.ts` send
  `allowAll` + `allowAllMs` to the computer.
- Windows app: `hands.cpp` (desktop ops) and `hands-run.cpp` (commands) keep a confirmed key per
  stretch (capped at 7 days); `src/hands-desktop-consent.ts` is the reference device.
- Tests: `test/w0-always.test.ts`.
