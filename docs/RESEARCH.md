# Research a question

*Library → Research a question…* Sara researches a question on the web and writes a report where
every sentence links the page it came from. You see and change her plan before she reads anything,
you see every page she read and every page she couldn't read (with the reason), and you can cut the
run short at any time and still get a report.

You need **web search** set up first (*Settings → Add-ons → Web search*: Brave, Tavily, Ollama
web search or your own SearXNG). Only the owner can run research; household members and the demo
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
   - **Could not be read**, each with the reason: *HTTP 404* (or another status), *blocked: a private
     or local address*, *paused by private local mode*, *timed out*, *not a text page* (a PDF or a
     download), *too little text on the page*, or *could not be reached*.
4. **Write the report now** stops reading and writes the report from the pages read so far.
   **Stop** stops everything at once: she doesn't call the model again, and you still get a report.
5. **The report** is kept in her Library (a Markdown document named *Research - your question*),
   so she can look things up in it later, and downloads as **PDF**, **Word** or **Markdown**.

## What the report holds

- Sections written from the pages she read. Every sentence ends with a link like **1** to the page
  that says it.
- **What is missing**: the steps no page answered, the searches that never ran, pages that were not
  read because you wrote the report early or stopped, how many sentences were left out (below) and
  how many pages failed.
- **Sources** (numbered, linked), **Sources that failed** (with the reason) and **The plan**.

A stopped run (or one cut off by a restart of the server) gets a report without the model: a short
quote from each page read, each linked, plus *What is missing*.

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
  your home network or this computer), each redirect checked again, 2 MB and 20 seconds per page.
- Page text is passed to the model as text written by others: information only, never instructions.
- If *web_search* or *web_fetch* is set to **Off** in her tool permissions (or pinned off by an
  admin policy), research is refused. In *Nothing leaves this computer* mode it is paused.
- Starting, writing early, stopping and deleting each write one row to the audit trail
  (*Settings → Household → Audit trail*), and every finished report writes a `research.report` row.

## Limits

One run works at a time; 20 runs are kept (older finished ones are forgotten, their Library
documents stay). 5 steps, 3 searches a step, 20 pages. The PDF uses the built-in Helvetica font, so
characters outside Western European languages show as `?` in the PDF; the Word and Markdown files
keep them.
