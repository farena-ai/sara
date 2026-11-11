# Documents she makes

Ask Sara for a document and she makes a real file: a **Word document (.docx)**, **PDF**, **Excel
spreadsheet (.xlsx)**, **PowerPoint presentation (.pptx)**, **Markdown**, **CSV** or **web page
(.html)**. It works with every model, local or in the cloud, with nothing to install.

> "Make me a one-page PDF about the history of coffee."
> "Make a Word resume for Pat."
> "Put our monthly budget in a spreadsheet, with totals."
> "Turn these notes into five slides for the book club."

## In the chat

The file arrives as a card under her reply:

- **Download** saves the file.
- **Open** shows it: a PDF opens in your browser; Word, Excel, PowerPoint and the rest show a preview
  in a window (the preview is a picture of the content, not Office itself).
- **Make changes** puts "Change “…” (document #12):" in the message box. Say what to change and she
  makes **version 2**. Earlier versions are kept: **Other versions** on the card lists them.

In Telegram, Discord and other chat apps you get the file itself.

## Where documents are kept

Every document she makes is saved in your **Library** (it opens, searches and shares like anything
else there). In an off-the-record chat it is kept for that chat only. Household members' documents
are in their own space; nobody else sees them.

## Looks

She picks a look from what you ask for, or you can name one:

| Look | Used for |
|---|---|
| **Report** | reports, summaries, guides: a big title with a rule, headings, page numbers |
| **Letter** | letters: your lines kept as written (addresses), no title, page numbers only past page one |
| **Resume** | resumes and CVs: centered name and contact line, sections in capitals with a rule |
| **Plain** | everything else |

Word files use real styles (Title, Heading 1 and 2, Quote), so Word's navigation pane and table of
contents work. Tables get a shaded header row that repeats on every page. Spreadsheets get a bold
header row that stays in view and real formulas (`=SUM(B2:B5)`), worked out when the file opens.
Slides are 16:9 with an opening slide, bullets, speaker notes and slide numbers.

Pictures from your uploads or Library can go into Word, PDF, PowerPoint and web pages.

## Good to know

- **Languages:** Word, Excel, PowerPoint and web pages take any language. PDFs use the standard PDF
  fonts, which cover English, Spanish, French, German, Portuguese and Italian; letters outside those
  (for example Polish ł or Chinese) lose their accent or show as "?" in the PDF only. Ask for Word if
  you need them.
- **Size:** up to 200,000 characters of text, 12 sheets of 5,000 rows, 60 slides and 12 pictures per
  document; the file can be up to 25 MB.
- **Safe files:** no macros (never .docm, .xlsm or .pptm), nothing in a document is fetched from the
  internet, and a spreadsheet formula that reaches outside the file (web services, other workbooks,
  DDE) is refused. In a CSV, cells that a spreadsheet would run as a formula start with `'`.
- **Private local mode:** documents are made on your server, so they work offline too.

## Reading documents

She already reads Word, Excel, PowerPoint, PDF, EPUB, web pages, Markdown and CSV files you add to
the chat or the Library ("summarize this document"); see [LIBRARY.md](LIBRARY.md).

## For developers

The tool is `make_document` (`src/tools/make-document.ts`). Everything is written by Sara's own
code with no dependency (`src/documents/`): one Markdown dialect is parsed once (`markdown.ts`) and
laid out by each writer (`docx.ts`, `pdf.ts`, `xlsx.ts`, `pptx.ts`, `html.ts`). Made documents are
recorded in `made_docs` (the Markdown or sheets they came from, for versions). Routes:
`GET /api/library/made/:id` (versions), `…/file` (`?inline=1` for a PDF) and `…/preview` (a page with
no scripts, served with `default-src 'none'`).
