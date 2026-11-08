# Her library: documents she knows

Give her documents to keep (PDFs, Word, Excel, PowerPoint, EPUB e-books, web pages, Markdown,
text and CSV files, photos of pages). She reads each one, remembers the key points (each with the
exact words they came from), finds things in them by their words and by meaning, and says where an
answer came from. Everything stays on your server.

This page covers how it works, with the details of big documents (Phase 74, release 2.3). The short
version for everyday use is in the in-app guide (Help → Her library).

## Adding documents

- **Library** in the sidebar → **Add documents** (or drop files there), or 📎 in a chat (*Keep in
  her library* or *Just read this once*), or send the file to her on Telegram or Discord.
- **How big:** PDFs up to the owner's limit (**Settings → Add-ons → Library → Largest document**,
  default 1 GB; choices 100 MB to 2 GB). Every other kind of file is read whole in memory and stays
  at 100 MB; save a bigger one as a PDF. Files sent through Telegram or Discord stay at 100 MB too
  (the bridges download into memory).
- **Household members** have their own library in their own space. Their largest document is the
  owner's **Largest document for household members** (default 100 MB, never more than the owner's
  own limit). Members can't change the library settings.
- **The demo** has no library (visitors can't read or upload).

### Uploads stream to disk

A file is never held in memory on the way in:

- **One request** (`POST /api/library?name=…`): the body is piped to a temporary file in
  `<data>/library/incoming/`, stopped at the size limit.
- **Resumable pieces** (the app uses these for files over 8 MB):
  1. `POST /api/library/uploads` `{name, size, keep, learn, conversation?}` → `{id, received: 0, chunkBytes}`
     (refused with 413 before any byte if `size` is over the limit, 507 if the disk is too full);
  2. `PUT /api/library/uploads/<id>?offset=N` with up to 16 MB of the file (the app sends 8 MB);
     a piece for the wrong offset gets **409 `{received}`** and the app sends again from there;
     a piece that breaks off is cut back to where it started;
  3. `GET /api/library/uploads/<id>` → `{received, size}` (where to go on after a dropped connection);
  4. `POST /api/library/uploads/<id>/done` → the file is checked (PDF by its first bytes; other
     kinds by their content), hashed, and moved into `<data>/library/` (`DELETE` cancels).
  Unfinished uploads are removed after a day.

**Reverse proxies.** Pieces are 8 MB, so a proxy's request-size limit of 10 MB or more is enough
(nginx's `client_max_body_size 20m` from [INSTALL.md](INSTALL.md) works; Apache and Caddy have no
small default limit). Nothing else needs changing for big files.

## Reading a long document

PDFs are read **page by page, from the file on disk**, in a background job that keeps its state in
the database (`library_jobs`), so it can be paused, cancelled, and carries on after a restart from
the page it reached (anything stored past the last finished page is dropped first, so no page is
stored twice). The Library shows the progress: *Reading page 412 of 980 · about 6 minutes left*,
with **Pause**, **Resume** and **Cancel reading** (she stops; what she read so far stays searchable,
with a note saying where she stopped).

The phases:

| Phase | What happens |
|---|---|
| text | Each page's text, one page at a time, in a reader thread with its own memory limit (768 MB, `SARA_LIBRARY_MEMORY_MB` to change) and a time limit per page. A page that fails is skipped with a warning; the rest goes on. |
| ocr | **Every scanned page** (a page that is only a picture) is read by her picture model (*Which model does what → Looking at pictures*). See below for when she asks first. |
| structure | The contents: the PDF's own bookmarks when it has them; else the headings found while reading (bigger type, `#`/`##` by size), without running heads repeated on most pages; else parts of 25 pages. Each entry runs to the page before the next one at the same level. |
| summaries | For documents of 30 pages or more that are kept: a short summary of each top-level chapter (and the level below when there are fewer than three), with page numbers, then a summary of the whole document and a one-line "what it is". |
| learn | Key points into her memory, with the exact-words rule. Ordinary documents keep up to 30; long ones more (30 + one per 10,000 characters beyond 200,000, up to 400), read in more windows spread over the text. |
| vectors | Meaning-search vectors for every passage (when *Meaning search* is set). |

**Speed.** **Settings → Add-ons → Library → Background reading**: *Gentle* (chat always first:
short slices of work and a pause after every page), *Normal* (default) or *Fast*. The reader works
in its own thread, so chats keep answering while a book is read; measured numbers are in
[RESULTS.md](RESULTS.md#big-documents-phase-74).

### Scanned pages and cost

Every scanned page is read (the old limit of 40 is gone). **Settings → Add-ons → Library →
Scanned pages**:

- **Read them; ask me first when a cloud model would** (default): with a picture model on this
  computer she starts by herself. With a cloud model she first shows how many scanned pages there
  are, which model would read them, about how long it takes and about what it costs (from the price
  table in *Usage and costs*; "not known" when the model has no price), and waits for **Read them
  with this model** or **Skip the scanned pages**.
- **Read them only with a model on this computer:** never a cloud model; she waits until a local
  picture model is set.
- **Don't read scanned pages.**

With **Nothing leaves this computer** (private local mode) on, only a model on this computer reads
scanned pages and makes meaning-search vectors, whatever was approved before.

## Finding things and citing pages

- **Word search:** SQLite FTS5 over every passage (about 1,400 characters, never across pages).
- **Meaning search:** vectors are stored exactly (Float32) in SQLite and searched in memory as
  8-bit numbers (int8 with a scale per vector, a quarter of the size): a brute-force pass over the
  whole block finds the best 48, which are then scored again exactly. New vectors join the block as
  they are made. Measured at 100,000 and 300,000 passages in [RESULTS.md](RESULTS.md#big-documents-phase-74).
- **Both** are merged by rank, and each passage she is given carries its page and a link:
  `[p. 412](/#view=library:<document>:412)`. She is told to say the page and add that link; pressing
  it opens the document in the Library at that page, and **Open the PDF at this page** opens the PDF
  itself in the browser's viewer (`/api/library/<id>/file?inline=1#page=412`, with byte ranges).
- The **library tool** gives her `search`, `read` (from a place, e.g. `page 412`, looked up
  directly), `contents` (chapters and sections with their pages and summaries) and `list`.

## Read together

Open a text or Markdown document she keeps and press **Read together**. It opens above your chat.

- **Share this passage:** select some text (up to about a page: 4,000 characters over at most 3
  passages) and press it. Your next message comes with that passage; she comments on that text only.
- **Follow my place** (off by default, **?** tip): the passage at the top of the view is sent after
  1.5 s still, at most once every 5 s (the server allows 12 a minute). Moving never starts a reply.
- **Stop** ends sharing at once (so does your stop word, and opening another chat). A reply already
  sent can't be unsent. A restart ends sharing too (it is kept in memory only).
- The browser sends only positions and hashes. Each turn the server reads the passage from her
  library again and checks the document's revision (its SHA-256) and the passage's hash; if either
  changed, or the document is gone, she gets no text, only a note to ask you to share it again.
- Owner only: not for household members, the demo, off-record, partner, room, API/MCP or other-app
  chats, replays or evals. With *Nothing leaves this computer* on (or in a private chat), only a model
  on this computer gets the passage. Nothing of it is stored in the chat, memory or exports.
- Code: `src/read-together.ts` (the share, the checks, the `[SARA-READ-TOGETHER]` section, never
  replayed), `src/routes/read-together.ts` (`GET`/`PUT`/`DELETE /api/read-together/<chat>`),
  `web/read-together.js`.

### A feed together

In the Library press **Read a feed together** (or use the **Feed** tab of an open Read together
view). Paste the address of a public RSS or Atom feed (a blog, a news site, a podcast's show notes)
and press **Open**.

- Sara's server fetches that one feed **once**, only when you press **Open** or **Reload**: never in
  the background, never while she writes a reply. Nothing is remembered: not the address, not the
  items (closing the view, **Stop** or a restart drops them).
- The list shows each item's title, date and site as plain text, with a link that opens only when you
  click it. No pictures, no embedded pages. Press **Share** on one item and your next message comes
  with that item's text (at most 4,000 characters; a longer one ends in a visible *(cut)*). She never
  sees the linked page.
- If you **Reload** and the shared item changed or is gone, she gets no text, only a note to ask you
  to share it again.
- Limits: https only, public addresses only (not this computer, the home network or Tailscale; every
  redirect is checked again, at most 3), 10 seconds, 2 MB, 50 items. With *Nothing leaves this
  computer* on, or in a private chat, a feed can't be opened.
- Feed text is written by strangers: she gets it as quoted data with a note to ignore any
  instructions in it, and on a turn with a shared feed item her tools that reach outside (web,
  mail, calendar, GitHub, home, MCP, sending files) are off.
- Code: `src/feed-together.ts` (the guarded fetch and the RSS/Atom/RDF reader),
  `POST /api/read-together/<chat>/feed`; the share and section as above.

## Research a question

*Research a question…* in the Library window plans web searches with you, reads public pages and
writes a report where every sentence links a page she read; the report is kept here and downloads
as PDF or Word. See [Research a question](RESEARCH.md).

## Meetings

*Meetings…* in the Library window listens in a meeting room you start (everyone is told first) or
reads a recorded meeting, and writes notes with a summary, decisions and action items; the notes are
kept here and action items go to the Planner when you add them. See [Meetings](MEETINGS.md).

## Where things are

| What | Where |
|---|---|
| Originals | `<data>/library/<sha>.<ext>` (uploads in progress in `<data>/library/incoming/`) |
| Documents, passages, FTS, vectors | `library_docs`, `library_passages` (with `page`), `library_fts`, `library_vectors` in her database |
| Reading jobs, scanned pages, contents | `library_jobs`, `library_ocr`, `library_sections` |
| Code | `src/library/source.ts` (reading a file in pieces), `pdf.ts` (the reader: cross-reference tables and streams read from the end, objects by offset, object streams; a scan of the file only when the table is damaged), `pager.ts` (the reader thread), `bigread.ts` (the job), `uploads.ts`, `vectors.ts`, `store.ts`, `worker.ts`, `use.ts` |
| Test book | `node scripts/make-big-pdf.ts out.pdf --pages 1000 [--scanned 50] [--objstm] [--bulk-mb 900]` (written from scratch; facts on known pages in `out.pdf.facts.json`) |
| Measurements | `node scripts/bench-big-doc.ts --label NAME …` (a throwaway server on ports 7880-7899) |

Exports carry each kept document's text, contents, summaries and page numbers (not the original
file); importing brings citations back.

## Not yet

- EPUB and Word books get passages and key points but no contents or section summaries yet (the
  structure phase is for paged documents).
- Measured on the development PC only; the "small server" numbers are this PC with a 256 MB reader
  limit and the gentle speed (see RESULTS.md), not a real small server.
