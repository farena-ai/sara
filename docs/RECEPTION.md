# Website receptionist

A small chat for your own website. It answers visitors' questions **only** from the Library documents
and business details you pick, follows your business rules, offers free times from your booking page,
and leaves booking requests that wait for your OK. It always says it is an AI assistant.

## Set it up

Settings → You → Business details → **Website receptionist**. Off by default.

1. Fill in **Business name** at the top of Business details (visitors see it), plus the email and
   phone you want visitors to have.
2. Keep a few documents in your Library (prices, opening hours, the questions people ask) and tick them
   under **Documents it may answer from**. Only ticked, kept documents are used.
3. Write **Your business rules** in your own words ("Never quote a price for roofs; say we visit
   first"). Optional: a **First line visitors see**.
4. Add **Your websites** (one address per line, like `https://www.example.com`). Only those sites can
   show the chat.
5. Turn it on, then copy the line under **Paste this line into your website** into every page that
   should show the chat button:

   ```html
   <script src="https://<your Sara address>/reception.js" data-sara="<your code>" async></script>
   ```

   Optional attributes: `data-label="Ask us"`, `data-theme="light|dark|auto"`, `data-side="left"`.
   Colors: set `--sara-reception-bg` / `--sara-reception-fg` in your site's CSS. **Try it** opens the
   chat page on its own. **New code** makes a new code (the old line stops working at once).

Your Sara must be reachable from the internet at the address in the line (Settings → Access).

## What visitors get

- A "Chat with us" button that opens the chat. The top says it is an AI assistant for your business,
  that it answers only from your information and can be wrong, and that you confirm every booking.
- Answers from your picked documents and business details (name, address, email, phone, the meeting
  name and length). Never your tax id, payment details, other documents, chats, notes or memory.
- Questions about anything else are refused in code, without asking a model.
- **Book a time** (when *Offer free times* is on): the next free times from your booking page
  (calendars, planner, windows, buffer and notice as set there). The visitor picks one and leaves a name,
  email and note. The request **always waits for your OK** in Booking page → Requests, even when the
  booking page itself is set to confirm on its own. You get a notice; Confirm creates the calendar event
  and sends the confirmation email, as for booking-page requests.

## Limits and safety

- No tools, no memory, no web: one small model call per question on your quick model route, with a
  daily cap (**Questions a day**, default 200). Greetings, booking requests and off-topic questions use
  no model at all.
- Visitor words and document passages are passed to the model as fenced data, never instructions.
- Per address: 60 page loads a minute, 20 questions per 10 minutes, 5 booking tries an hour. Questions
  are at most 500 characters. Booking forms have a hidden honeypot box and a signed page token (a form
  sent within 3 seconds of the page counts as a bot).
- The chat page sends a `frame-ancestors` rule listing only your sites, no inline script, and is never
  indexed. The loader adds a button and an iframe to your page; it never reads or writes your page's
  content. It is served from your own Sara (not a CDN), so it carries no integrity hash: an update to
  Sara updates it.
- **What visitors asked lately** lists the last questions (kept 30 days, 200 at most) so you can improve
  your documents and rules; **Clear the list** deletes them.
- Each person's own (a household member's receptionist is theirs). Never on the demo.

## Version 2 (W3.5)

- **Their language.** Each reply is in the language the visitor writes in (English, Spanish, French,
  German, Brazilian Portuguese, Italian), read from their words in code; a one-word "ok" keeps the
  language of their earlier lines, and only then the browser's language counts. The quick replies made
  without a model (greeting, free times, refusals, payment links, thanks) are translated too.
- **Payment links.** Paste links from your own payment page under **Payment links** (one per line,
  name first: `Deposit https://…`; https only, up to 10). A visitor who asks how to pay (in any of the
  six languages) gets those links as buttons, without a model call. It never takes a payment, never asks
  for card numbers and never makes up a link.
- **Follow-up emails after your OK.** When a visitor types an email address, it thanks them and writes a
  follow-up draft in their language from that conversation (the quick model, with the address hidden
  from it; a plain draft listing their questions when no model answers). One draft per visitor, at most
  50 waiting. You get a notice; the draft waits in **Receptionist conversations → Follow-up emails
  waiting for your OK**, where you edit it and press **Send** (from the same mailbox as booking
  confirmations) or **Dismiss**. Nothing is sent before you press Send.
- **It learns from your corrections.** **Receptionist conversations** shows each visitor's questions
  and the answers it gave. **Wrong? Write the right answer** keeps your answer as an *approved answer*:
  the next visitor who asks the same thing in the same language gets your answer word for word (no model
  call); in another language the model gets your answer to translate. Approved answers are listed with
  how often they were used, and **Delete** removes one. Up to 100.
- Owner routes (same family): `POST /api/booking/reception/correct {log, question?, answer}`,
  `DELETE /api/booking/reception/approved/<id>`, `POST /api/booking/reception/followups/<id>/send
  {subject, body}` and `/dismiss`. The view adds `chats`, `approved` and `followups`. Tests:
  `test/w3-reception.test.ts`; design: [docs/design/W3RECEPTION.md](design/W3RECEPTION.md).

## For developers

`src/reception.ts` (settings, topic gate, prompt, ask, book), `src/routes/reception.ts` (public
`/reception.js`, `/reception/<id>`, `/ask`, `/slots`, `/book`), owner routes `/api/booking/reception`
(GET, PUT, `POST new-id`, `POST clear-log`) in `src/routes/booking.ts`, `web/reception-embed.js`,
`web/reception-chat.js`, `web/reception.css`, `web/receptionist.js` (Settings section; `/reception.js` is the public loader). Tests: `test/v3-reception.test.ts`.
Design: [docs/design/V3RECEPTION.md](design/V3RECEPTION.md).
