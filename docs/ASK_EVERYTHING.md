# Ask your whole life (S5)

One question across your **emails, files, chats, calendars, notes, lists and contacts**, answered
with quotes. Every answer line carries a number like **[3]**; tap it to open that source at the
spot (the email with the quote marked, the document at its page, the chat at the message).

## Using it

- **In the app:** type in the search box above the conversations and pick the first row,
  **✦ Ask about anything in your life**. The ask box opens with your words already asked.
  - **What I found:** up to six lines, one per source fact, best first, each ending in its number.
  - Under it the matches **grouped by source** (Emails, Files, Chats, Calendar, Notes, Lists,
    Contacts) with who/where, the date and the quote.
  - Untick a source to leave it out. *Ask Sara about it in a chat* starts a new chat with the
    question so she can write the answer in her own words (she uses the same search and cites [n]).
- **In a chat:** just ask ("when is my lease renewal due?", "what did Dan say about the trip?").
  She uses the `ask_everything` tool and cites the numbered sources.

Opening a hit: an email opens in full inside the ask box with the quoted words marked; a library
document opens at the page; a workspace file opens at the line; a chat opens at the message; an
event shows its time and place; notes, to-dos and lists open in the Planner; a contact opens their
People card.

## What is searched, and what never is

| Source | How it is searched | Opens at |
|---|---|---|
| Emails | every mailbox in the combined inbox (MULTIMAIL): Gmail search, Outlook (Graph) and IMAP search with the question's words; nothing found → the longest word alone | the email, quote marked |
| Files | the Library's word + meaning search (N6, page numbers) and the workspace files (owner only) | the page / the line |
| Chats | your past conversations (your and her messages) | the message |
| Calendar | every calendar of every account, a year back and a year ahead | the event |
| Notes, lists | Planner notes, to-dos, and household lists shared with you | the Planner |
| Contacts | People cards (not the ones marked private) | the card |

- **Never:** private chats, messages you asked her to forget, chats with other companions or
  agents, adult-channel chats, private People cards. **Off the record** nothing is searched.
- **Household members** ask their own space only: their own chats, notes, library, mailboxes and
  calendars. The owner never sees theirs and they never see the owner's; workspace files (the
  server's own folder) are the owner's only.
- **Kid mode:** a child gets only the sources their tool allowlist already covers (chats, Library,
  notes, lists); mail, calendars and contacts are skipped.
- **In a private chat or Private local mode** mail and calendars (on other servers) are skipped;
  local sources still answer.
- Other apps (the OpenAI-compatible API, MCP) never get the tool.

## Design (one page)

- **Federated, no new index.** `src/ask-everything.ts` asks each source with the search it already
  has, in parallel (`Promise.allSettled`; one failing source shows its error and the others still
  answer), scores each hit by the share of the question's words it holds (longer words weigh more;
  newer first on a tie), and keeps the best 5 per source.
- **Words:** `askWords` drops the filler words of a question (six languages) and keeps up to 8.
- **Quotes:** `bestQuote` picks the sentence holding most of the words.
- **Answer:** the best hit of each source that holds at least 40 % of the words (then strong
  second hits), deduplicated, max 6 lines, each with its citation number. Written by code, so it is
  instant, free and never invents anything; the chat route adds her own wording.
- **Who may ask what:** `askAllowed(app, {conversationId})` (off the record, kid allowlist via
  `KID_TOOLS`, private chat / Private local mode). Everything runs on the asking person's own
  `AppContext`, so isolation is the space's own database, not a filter.
- **Routes** (in the existing `find` family, so members reach their own): `GET /api/find/ask?q=…
  [&sources=mail,files]` → `{query, words, groups[{source, items[{title, quote, where, when, open,
  score, cite}], error?}], skipped[{source, why}], answer[{text, cite, source}]}`;
  `GET /api/find/ask/mail?account=&id=` → one email in full (this person's own mailbox).
- **Tool:** `ask_everything {question, sources?}` (read-only, auto, interruptible, in the core chat
  set; numbered quotes with the untrusted-content note).
- **UI:** `web/ask-everything.js` + `web/ask-everything.css` (theme variables), the `#ask-all`
  dialog in `web/index.html`, the ✦ row in the sidebar search (`web/app.js` `runSearch`).
- **Tests:** `test/s5-ask-everything.test.ts` (fixtures for all seven sources, private/forgotten/
  off-the-record, member and kid isolation, a failing source, the tool, the routes, the web strings).

## Limits

- Mail search uses the providers' own word search (all words, then the longest word), so a hit
  needs the words, not just the meaning. Library files also match by meaning when Meaning search
  is set up.
- Calendar: a year back and a year ahead; non-Google calendars are read for that window and ranked
  here.
- Notes and lists open the Planner tab, not the single note or card.
