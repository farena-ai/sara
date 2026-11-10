# Research a question

*Library → Research a question…* Sara researches a question on the web and writes a report where
every sentence links the page it came from. You see and change her plan before she reads anything,
you see every page she read and every page she couldn't read (with the reason), and you can cut the
run short at any time and still get a report.

**From a chat (3.1.2):** ask her to research something, look into it properly, find out everything
about it, compare options, make a guide, learn a topic or make a skill about it, and she starts a
research run instead of reading page after page in the chat. A card shows her plan in plain words
with **Start**; after that the run works in the background with its own budget and its own context,
and the same card shows how it goes and the report when it is done.

You need **web search** set up first (*Settings → Add-ons → Web search*: Brave, Tavily, Ollama
web search or your own SearXNG). Connecting Ollama Cloud with a key turns Ollama web search on with
the same key. Without web search she never promises to look things up: a message that asks her to
search shows *"I can't search the web yet"* with a **Turn on web search** button (one tap when an
Ollama Cloud key is there), and `/learn` answers in the chat with the same button. Only the owner can run research; household members and the demo
can't.

## How a run goes

1. **Ask.** Type your question and press **Draft a plan**. She writes 2 to 5 steps, each one part of
   your question with 1 to 3 web searches. Nothing is searched or read yet.
2. **Check the plan.** Reword a step, change its searches (separated by `;`), remove a step or add
   one (up to 5), and pick how many pages she may read (4, 8, 12 or 20; 8 by default). Press
   **Start**: this is your approval for the run. **Cancel** drops it.
3. **Reading.** She runs the searches in order and reads the pages they find, one at a time. Two
   lists grow as she goes:
   - **Pages read**: the page's title and site. These are the only pages the report may cite.
   - **Could not be read**, each with the reason: *not found (HTTP 404)*, another HTTP status,
     *blocked: a private or local address*, *paused by private local mode*, *timed out*, *not a
     text page* (a PDF or a download), *too little text on the page*, *the site asked to slow down*
     or *could not be reached*.
   - **Sites that block automated readers** (Cloudflare's "Just a moment…", captchas and other bot
     checks), listed apart: they are not failures of the run. She never tries to get around a
     check; when the search result already carried the page's text, that text stands in (marked
     *from the search result*).
   Pages are only found by her web searches and by links on pages she read: she never makes up
   page addresses.
4. **Pause** stops after the current page; **Resume** goes on from exactly where it stopped.
   **Write the report now** stops reading and writes the report from the pages read so far.
   **Stop** stops everything at once: she doesn't call the model again, and you still get a report.
5. **The report** is kept in her Library (a Markdown document named *Research - your question*),
   so she can look things up in it later, and downloads as **PDF**, **Word** or **Markdown**.

## Long runs (3.1.2)

- **Budget.** Each run has a page count, a time limit (20 minutes) and an estimated token limit.
  The card shows them (*Pages read: 3 of 8*, *4 of 20 min*); raise pages or time while it works.
  When the time or tokens run out she writes the report with what she has.
- **Every page is a checkpoint.** The pages found, the searches run and every page read are saved
  as she goes. After a restart of the server the run is paused and picks up again by itself a few
  seconds later; nothing already read is read again.
- **Patience with the web.** A page gets 15 seconds and 2 MB. A timeout, a dropped connection, a
  429 ("slow down") or a 5xx answer is tried again up to 3 times, waiting longer each time and
  honouring the site's *Retry-After* (up to 30 seconds).
- **When the model stops answering.** Each model call is tried 3 times. If writing still fails, the
  run pauses with *Paused: the model stopped answering*: press **Resume** to try again, or **Write
  with what she has** for a report without the model.
- **Partial, never blank.** A report written early, cut short by the budget, stopped or written
  without the model starts with **Partial report** and lists what is missing.
- **Small models.** Research uses the model you picked for *Web research* in *Settings → Models →
  Which model does what*. With none picked and a small talking model (14B or smaller by its name),
  she uses a bigger model you set for Planning, Coding or Writing; with none, the run takes short
  steps (a plan of up to 3 steps, fewer pages per search and a few notes per page kept with the
  run, never in the chat), so the model's context never overflows.

## Save as a skill, keep it fresh

When a run is done, **Save as a skill** turns what she read into a knowledge skill (see
[Learn a topic](LEARN.md)) without reading the pages again; **Keep it fresh** does the same and
refreshes it every week. A run started from a chat for a guide or a skill saves itself when it is
done. A skill made from a partial run is marked **Partial**.

## Why chats stopped failing (3.1.2)

Long research used to happen inside the chat: she guessed page addresses (`/class-warrior-guide`,
`/warrior-guide`, `/warrior` for every class), got dozens of "page not found" pages back as text,
hit Cloudflare bot checks with commands and the browser, and kept going until the conversation had
to be tidied up twice. Now, in a chat:

- a page that doesn't exist comes back as one line: *Not found … search for it instead* (with a
  `site:` search to use), never the 404 page's text;
- after 3 pages not found on one site in a reply, more guessed addresses on that site are refused
  (an address a search result or a page she read gave still works);
- a bot check (in her web reader, in a command's output or in a browser tool) comes back as *This
  site blocks automated readers*, and that site isn't asked again in the reply;
- from the 9th page in one reply, each page tells her to start a research run instead, and the chat
  shows **Turn this into a research run** once; after 24 pages she stops reading in that reply.

## What the report holds

- Sections written from the pages she read. Every sentence ends with a link like **1** to the page
  that says it.
- **What is missing**: the steps no page answered, the searches that never ran, pages that were not
  read because you wrote the report early or stopped, how many sentences were left out (below) and
  how many pages failed.
- **Sources** (numbered, linked), **Sites that block automated readers**, **Pages not found**,
  **Sources that failed** (with the reason) and **The plan**.

A stopped run (or one written without the model) gets a report without the model: a short quote
from each page read, each linked, plus *What is missing*.

## How "every sentence links a page" is kept

The model is told to cite the numbered pages, but the app does not take its word for it. After the
model writes, Sara's server checks every sentence: it stays only when it cites a page **read in
this run** and shares at least one real word (5 letters or more, or a number) with that page.
Anything else (no citation, a page that failed, a number that doesn't exist, a page that doesn't say
it) is left out, and *What is missing* says how many sentences went. If nothing survives, you get
the no-model report instead of an empty one.

The check compares words, so write the question in the language of the pages you expect: a report
in one language built from pages in another would lose most of its sentences.

## Safety

- She reads pages with the same guarded reader as her *web_fetch* tool: public addresses only (never
  your home network or this computer), each redirect checked again, 2 MB and 15 seconds per page.
- Page text is passed to the model as text written by others: information only, never instructions.
- If *web_search* or *web_fetch* is set to **Off** in her tool permissions (or pinned off by an
  admin policy), research is refused. In *Nothing leaves this computer* mode it is paused.
- Starting, writing early, stopping and deleting each write one row to the audit trail
  (*Settings → Household → Audit trail*), and every finished report writes a `research.report` row.

## Limits

One run works at a time; 20 runs are kept (older finished ones are forgotten, their Library
documents stay). 5 steps, 3 searches a step, 20 pages in the plan, raised up to 40 while it runs;
up to 60 minutes. The PDF uses the built-in Helvetica font, so
characters outside Western European languages show as `?` in the PDF; the Word and Markdown files
keep them.
