# Pick-an-answer cards (S10)

When Sara offers options or asks you a decision question, the choices show up in the chat as buttons.
Tap one (or several, when she says more than one may be picked) and it is sent as **your own message**,
just as if you had typed it. Her recommended option comes first and says "(recommended)". The last
button is always **Other, type it out**: it puts the cursor in the message box so you can answer in
your own words.

- **The app (phone and desktop):** buttons under her question. They work with the keyboard (Tab,
  then Enter or Space) and screen readers (the card is a labelled group; multi-select buttons say
  whether they are pressed). For several picks, tap them, then **Send**.
- **Telegram:** inline buttons on the message, one per line. Several picks: tap to tick (✓), then Send.
- **Discord:** buttons under the message (five to a row).
- **Everywhere else** (other chat apps, emails, other assistants over A2A, the plain-text history):
  a numbered list with "Reply with a number or type your own." Reply `2`, `1, 3`, or the option's words.

A card closes as soon as you answer, or when you send anything else instead; old cards keep their
buttons greyed out with your pick ticked. Only you (the owner, or the household member in their own
chat) can press them; on Telegram and Discord the buttons show only in your own direct chat with her.
They are never used for approvals: anything she wants to *do* that needs your OK keeps its own
Allow/Deny card.

## Design (one page)

**What existed and is reused.** E5 decisions (`decide`/`compare`: ranked options, "I chose this") help
weigh options; S10 only asks. Phase 119's chat-app button rows (`afterTurnExtras` + `chatButton` in
`src/bridges/commands.ts`) are the path the cards take to Telegram/Discord. Errand `decide` steps keep
their own "Pick one" wait. Approval cards are untouched.

**Decisions.**
1. *An explicit model tool, no parser.* `ask_choice {question, options[{label, detail?}], multi?,
   recommended?}` (2–8 options, labels up to 80 characters). There is no guessing of buttons from
   numbered lists in ordinary replies: false positives on recipes, steps and rankings would put buttons
   where nobody asked anything. The tool is in the lean core list (small schema) and the persona says
   to use it sparingly, only at real decision points, never for approvals (`src/persona.ts`).
2. *It ends her turn.* After a good `ask_choice` call (and the step's other calls), `runTurn` stores her
   final message with `meta.choice` and stops without another model call. The message *text* is the
   numbered list, so the model, memory, search, A2A and plain bridges read it naturally; the web shows
   only the question plus buttons.
3. *A pick is a normal message.* The web sends the label through the usual send path; Telegram and
   Discord run the same handler as a typed message from that person. `settleChoice` (at the start of
   every turn) closes the open card: a label or number becomes the answer, anything else marks it
   typed (expired).
4. *Bridge buttons:* `ch:<message id>:<n|o|s>` (Telegram callback data stays under 64 bytes). Owner
   checked by the bridge; a stale or second press says "No longer waiting" and runs nothing.

**Risks.** A model that calls it too often (prompt says sparingly; it is one card per turn). A
multi-select label containing ", " reads as two on reload (labels are short; cosmetic only).

**Tests** (`test/s10-choices.test.ts`): tool schema and core/kids lists; parsing (recommended first,
limits, duplicates); the turn ends with one model call and the fallback text; pick → message, number →
label, typed → expired; web card (order, marks, aria, Other, multi Send, closed); persona guidance;
chat-app extras; Telegram inline keyboard + callback → turn (others refused, stale press); Telegram
multi toggles; Discord components + interaction → turn.
