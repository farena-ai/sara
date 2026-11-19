# V3.5 Website receptionist (design, one page)

ROADMAP_V V3.5: an embeddable widget for the owner's site, answering only from chosen Library docs and
business details under business rules, offering free slots and creating a booking request the owner
approves; rate limits, no tools, AI disclosure. User doc: [docs/RECEPTION.md](../RECEPTION.md).

## What existed (reused, not rebuilt)

- **Booking page** (R6, `src/workapps/booking.ts`, `src/routes/booking.ts`): weekly windows, free time
  from every calendar + planner, buffer/notice/max per day, requests with notice, Confirm/Decline that
  create the event and send the email, honeypot + signed time token. The receptionist uses its
  `slots()` and `request()`; one change: `request(v, { ask: true, via })` keeps a request pending even
  when the page confirms on its own.
- **Business details** (`src/biz/store.ts`): name, address, email, phone (tax id and payment details are
  never shown to visitors).
- **Library** word search (`LibraryStore.searchWords` with `docIds`), kept docs only.
- **`cheapCall`** (`src/cheap.ts`): a tool-less model call on the quick route with usage rows and a
  daily ledger cap; `fenceLines`/`safeLines` for untrusted lines.
- **Other apps** (`src/other-apps.ts`): `cleanOrigins` for the site list, `KeyLimiter` for page views.
- Owner UI lives on the Business details page next to the booking page (You group is at its 10-page cap:
  a section, not a page).

## Shape

```
owner's site ── <script src=/reception.js data-sara=ID> ── button + <iframe src=/reception/ID>
                                                              │ same-origin fetch (no cookies, no CORS)
                         POST /reception/ID/ask ── topicOf() ─┬─ greeting / off-topic → fixed text
                                                              ├─ booking → bookingFor().slots()
                                                              └─ topic → cheapCall(system: rules+facts+
                                                                 fenced passages; user: fenced turns)
                         POST /reception/ID/book ── Booking.request({ask:true}) → pending + owner notice
```

The chat runs in an iframe served by Sara: the host page never touches visitor text, Sara needs no
CORS or third-party cookies, and `frame-ancestors 'self' <sites>` keeps other sites from framing it.

## Threat model (visitor text is untrusted, docs/SECURITY_REVIEW_U5.md)

| Risk | Control |
|---|---|
| Prompt injection makes it act | No tools at all (`cheapCall`, no tool list); booking is a form, not a model action |
| It leaks private data | The model sees only the business details, the picked docs' passages and the visitor's turns; no memory, chats, notes, persona or owner facts |
| Off-topic use (free chatbot, cost) | Code gate `topicOf` refuses without a model call; daily cap; per-address limits; 500-char questions; 8 history turns |
| Bot bookings / spam | Honeypot, signed page token (≥ 3 s, ≤ 12 h), 5 tries/hour/address, booking page's 20 open requests a day; every request waits for the owner |
| XSS in the chat or host page | Replies drawn with `textContent`; loader uses DOM APIs only; page CSP without inline script |
| Clickjacking / embedding elsewhere | `frame-ancestors` from the owner's site list; widget id rotatable (New code) |
| Model says it is a person | Prompt rule + always-visible AI notice in the page header |

## Not in this step

- Answers with vector search (word search is enough for small FAQ sets; `library/vectors.ts` can be
  added behind the same `passages()` later).
- Hand-off to a person (live chat) and a visitor email transcript.
