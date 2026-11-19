# V5.3 Legacy and emergency access (design, one page)

**Goal.** The owner names one trusted person and picks what they get. If the owner stops using
Sara for N days, Sara reminds the owner, waits, and only then opens an expiring page for that
person. The owner can cancel at any moment; any sign-in or chat cancels at once.

**What existed (reused, not duplicated).** EC11 public share pages (`src/routes/share.ts`: page
shell, escaping, no-index headers, `LoginLimiter`), owner sign-in through `createDeviceGate`
(`src/device-gate.ts`), "the owner really typed this" evidence in `runTurn`
(`ownerEvidenceConversation`), alerts with a chosen destination (`postAlert` + `FEEDS`,
`src/destinations.ts`) and phone pushes (`app.push.notifyOwner`), the per-minute
`ReminderScheduler.tick`, owner re-auth (`confirmIdentity`, web `confirmProof`), the Library, the
vault, My details (emergency contact), the redactor. Nothing like a trusted contact or an
inactivity switch existed (VAUDIT item 33: NEW).

**Engine.** `src/legacy.ts`, one JSON file per owner space (`<data>/legacy.json`, 0600). Pure
`legacyStage(state, now)`:

| stage | when | what happens |
|---|---|---|
| off | not set up | nothing |
| watching | active within N days (default 60, 14-365) | nothing |
| reminding | N to N+3 days idle | owner alert + push every day: "sign in or press I'm here" |
| waiting | next W days (default 14, 3-60) | owner alert every 2 days with the opening date |
| open | after N+3+W days | page opens for L days (default 30, 1-90); owner told; optional email to them |
| closed | after the L days | page answers "closed" until the owner sets it up again |

An early **emergency request** from the trusted person (button on their page, off-switchable)
skips the N days but still waits W days, alerts the owner at once, and is limited to one per 7 days.

**Activity** = an owner sign-in (token, passkey, SSO, via the device gate's 200 path), a chat
message the owner typed (same evidence rule as memory, so automations, workers, other apps and
members never count), or "I'm here" in Settings. Background polling never counts. Any activity
in a stage after watching cancels: request cleared, page closed again, alert "cancelled".

**What they get.** A letter, short notes, picked Library documents, picked chats (none by
default), My details (off by default) and vault entries only when the owner ticks each one and
confirms (server secrets such as model keys are never offered). Content is built when the page is
viewed, chat text passes the redactor, every value is HTML-escaped.

**Link.** `/legacy/<token>`: 32 random bytes, only the SHA-256 is stored; shown once when made,
"Make a new link" rotates it. Before opening the page shows nothing about the owner's state
(only the request button); a wrong token is counted by a `LoginLimiter` (429 after 20 misses).
Documents download only while open and only if picked. Every page is no-store/no-index.

**Safety.** Turning it on or changing the person, contact or contents needs owner proof
(passkey/two-step/owner token); turning off, cancelling and I'm here never do. Every change is
audited and the owner gets an alert when it is set up, when a request arrives, when it opens and
when it is cancelled. Owner only (403 for members/demo), device API keys are refused
(`data-rights` family). Routes: `GET/PUT/DELETE /api/data-rights/legacy`, `POST …/legacy/here`,
`POST …/legacy/link`; public `GET /legacy/<t>`, `GET /legacy/<t>/doc/<id>`, `POST /legacy/<t>/ask`.

**UI.** Settings → Privacy & system → Privacy → "Legacy and emergency access" section (SETTINGS3,
tips on every control, 5 languages). User doc: `docs/LEGACY.md`.
