# Learn a topic

Point Sara at a topic or a website and she studies it for you: she reads public pages, keeps what she
learned as a **knowledge skill** with its sources and the date she read them, can **keep it fresh**
on a schedule, and answers your questions from it, citing the pages. Good for things that move: a
launch you follow, a team, prices, a product's docs, rules that change.

## Start one

- **In a chat:** `/learn heat pump rebates` or `/learn https://docs.example.com`. Add `quick`,
  `standard` or `deep`, and `daily`, `weekly` or `monthly` to keep it fresh:
  `/learn the Artemis program weekly`. `/learn` alone lists what she has learned.
- **Or just ask** in the app: "learn about the Artemis program", "keep up with heat pump rebates".
- **In the Library:** Library → **What she has learned…** has a form: the topic or website, how deep,
  how often to refresh, and the sources (the open web, or only this site).

Only you (the owner) can start one; household members can't yet. It needs web pages to be allowed
(Tools) and, for a topic, a web search setup (Settings → Add-ons → Web search). A single website
works without web search.

## What she does

- **A topic:** a few web searches (she plans them), then she reads the best pages: about 5 (quick),
  12 (standard) or 25 (deep).
- **A website:** only that site. She reads `robots.txt` first and skips what it disallows, follows
  links on the same site only, reads one page at a time with a pause between pages, and stops at the
  page cap: about 10, 40 or 80 pages.
- She never reads private or local addresses (your router, `localhost`, your network).
- She writes her notes from the pages only, and every sentence must cite a page she read in that run;
  anything else is left out. The notes are a skill (Settings → Skills, marked as a learned topic):
  a summary, key facts with dates, a glossary, how to answer questions on it, and the sources list
  with the date each page was fetched.
- Writing or refreshing that skill needs no approval card (3.0.3): it shows up in Settings → Skills
  with its versions, and you can delete it or go back to an earlier version there.

## Asking about it

When a question is about a topic she learned, she loads those notes for that reply, answers from them,
links the pages, and says how recent they are. If the last refresh failed she tells you it may be out
of date. If your question goes beyond what she read, she says so and offers to look it up.

## Keeping it fresh

Pick **Every day**, **Every week** or **Every month** (or *Refresh now*). Each refresh reads again,
keeps the previous notes as an older version (Settings → Skills → the skill → versions), and writes
**What changed since <date>**: new facts and facts no longer in the sources. With **Tell me when
something changes** on, she sends one message after a refresh that found something, never during
quiet hours (it waits until they end). A refresh that fails marks the topic **Out of date** and
keeps the last good notes; she tries again at the next refresh.

## Limits and safety

- **Budgets:** each run has a token cap by depth, and Settings → Budgets → *Learning a topic* sets a
  monthly learning budget (estimated tokens). When it is used up, new topics and refreshes wait.
- **Content:** the same rules as her chats: sexual content involving minors is always refused, and
  explicit topics need Adult mode.
- **Admin policy:** `"learning": false` (Settings → Policy → *Turn off Learn a topic*) stops new topics
  and refreshes on the server; what she already learned stays as skills.
- **Audit:** starting, changing, refreshing, each run's outcome and deleting are audit rows
  (`learn.create`, `learn.update`, `learn.refresh`, `learn.run`, `learn.delete`).
- **Forget this topic** deletes the topic, its notes, every older version and its run history.
