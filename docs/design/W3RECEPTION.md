# W3.5 Receptionist version 2 (design, one page)

**Spec** (docs/design/ROADMAP_W.md W3.5): multi-language, payment links the owner provides, follow-up by
email after the owner's OK, learns from the owner's corrections.

## What existed (reused, not duplicated)
- V3.5 website receptionist: `src/reception.ts` (settings, code topic gate, fenced tool-less
  `cheapCall`, log), public routes `src/routes/reception.ts`, chat page `web/reception-chat.js`, owner
  section `web/receptionist.js` on Settings → Business details, owner routes in the `booking` family.
- W1.4 persona style (`personaStyle`: greet tone, email sign-off) for replies and drafts.
- Booking page mailbox (`Booking.#sendMail`: Gmail or the first working mail account), now exposed as
  `Booking.sendEmail` so follow-ups go out from the same mailbox as booking confirmations.
- `src/lang-text.ts` (`clearLang`/`detectLang`, six languages) for reading the visitor's language.
- No payment-link feature existed; Business details' "How to pay you" is invoice text, not links.

## Build
- `replyLang(question, browser, earlier)`: clear signs in the question → earlier visitor lines →
  browser language. Code replies use `tr(…, lang)`; the model is told the language by name.
- `payLinks` setting (`cleanPayLinks`: https only, label, 10 max). `PAY` word list (six languages) in
  the topic gate → a code reply with the links (no model). The chat page draws only `https:` links as
  text anchors (`rel=noopener noreferrer`).
- Contact: `contactOf` finds an email (and an explicit "my name is"). A `reception_followups` row with a
  draft (quick model on the chat's log rows with `noEmails`, else a translated template) and the
  persona sign-off; owner notice; send/dismiss only through owner routes. Caps: one pending per visitor
  page or address, 50 pending.
- Conversations: log rows gain `reply`, `chat` (hash of the page token, which now carries a random page
  id; old two-part tokens still verify) and `lang`; `chats()` groups them.
- Corrections: `reception_approved` (question, answer, lang, uses, log_id). `matchApproved` (shared key
  words ≥ 2 and ≥ 60%) answers in code when the language matches; otherwise the five closest approved
  answers go into the prompt. Approved questions also count as known words for the topic gate.

## Safety
Visitor text stays fenced data; email addresses never reach a model; payments are never processed;
every email waits for the owner's Send; links are the owner's own https links only.

## Acceptance
`test/w3-reception.test.ts` (language ×6, links, follow-up only after OK, corrections used next time,
web wiring) + live check on a throwaway in-process server, Settings and chat page light/dark 1440/390.
