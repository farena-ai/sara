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
Lines like **EMPLOYEE NAME:** Kent around a table go on its sheet as two cells (label, value), and a
table row with more cells than its header is sent back to be fixed, so values never shift columns.
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

## Filling in your own forms

Give her your own form or template (a time sheet, an application, an order form) as an **Excel
(.xlsx)** or **Word (.docx)** file or a **fillable PDF form**, in the chat or the Library, and tell
her what goes in it:

> "Fill in this time sheet: week of 11/8, Kent Shelton, nights 2200 to 0600 Sunday to Wednesday."

She writes the values into **a copy of your file**, so it keeps its own layout, fonts, borders,
merged cells and formulas; your original is never changed. The copy arrives as the same card
(Download, Open, Save to PC) and is kept in the Library.

- **Where values go:** next to a label ("EMPLOYEE NAME:" fills the empty cell to its right, or the
  one below), at a cell (B3), or in a table by its column header and row ("DAY" → "SUNDAY" →
  "START TIME"). In Word, after a label (over a ____ line or a [placeholder]), in the table cell
  next to a label, in table rows, and in fill-in boxes (content controls).
- **Numbers stay numbers** (totals add them up); times and dates become real times and dates only
  where the cell is formatted for them, otherwise they are kept as typed ("0600" keeps its zero).
  Cells that work themselves out with a formula are left alone and are worked out again when the
  file opens.
- **Checked before she says it's done:** she reads the new copy back and checks every value is where
  it should be. She tells you "Filled 23 of 23 fields", or exactly which ones she couldn't fill and
  why (no such label, a label in two places, no empty space next to it), and asks for what's missing.
- **PDF forms:** a PDF with fillable fields (the boxes you can type into in a PDF reader) is filled
  field by field: text boxes (one line, several lines, boxes of single letters), check boxes ("yes"
  or "no"), radio buttons and drop-down lists (one of their choices). She finds each field by its
  name, its tooltip, or the words printed next to it on the page; when she reads a fillable PDF in
  the Library she also sees its list of fields and their current values. The filled copy is your
  original file with the values added at its end, so everything else in it stays exactly as it was.
  Read-only fields and signature fields are left for you, and she says so. A **password-protected**
  PDF, an **XFA** (LiveCycle) form, or a PDF with no fillable fields (a scan or a printed form) is not
  filled; she says why and can make a new document with your values, or fill an Excel or Word version
  of the form instead.

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

Filling forms is `fill_document` (`src/tools/fill-document.ts`, `src/documents/fill.ts`). It edits
the file's own XML as a tree (`src/documents/ooxml-edit.ts`: the Library's XML reader plus a small
writer) and copies every part it didn't change byte for byte. Excel: new text is an inline string,
existing style ids (`s=`) are kept (a new cell takes its row's or column's style), formula cells in a
changed sheet lose their cached answers and the workbook gets `fullCalcOnLoad`. The copy is checked
with the Library's reader (`readXlsxCells` / `readDocx` in `src/library/ooxml.ts`). The filled copy is
recorded in `made_docs` with `spec.filled` (its form), so make_document won't rebuild it from Markdown.
PDF forms (`src/documents/pdf-form.ts`) use the Library's PDF reader (`src/library/pdf.ts`) for the
AcroForm field tree (inherited `/FT /Ff /DA /V /Opt`, full names joined with dots, `/TU` tooltips) and
the page text positions (the words left of a box, right of a check box, or the label block above it).
The copy is an **incremental update**: the original bytes untouched, then the changed field and widget
objects, a simple appearance stream per text/combo widget (the `/DA` font from `/AcroForm /DR`, or
Helvetica added as `/Helv`; auto size, `/Q`, multi-line, comb; the `/MK` border and background), and a
new cross-reference section with `/Prev` (a classic table if the file had one, else an xref stream).
Values are PDF text strings (UTF-16BE with a byte-order mark beyond Latin-1); check boxes and radio
buttons set `/V` and each widget's `/AS`; choices must be one of `/Opt` unless an editable combo.
`/NeedAppearances true` asks viewers to redraw the fields, and an `/XFA` entry is removed so viewers
show the AcroForm values. Encrypted files (`/Encrypt`), XFA-only forms, flat PDFs and damaged
cross-reference tables are refused. The copy is parsed again and each field's `/V` (and `/AS`) is
checked before the report. `readDocument` adds a "form fields" part (`formFieldsText`) for fillable PDFs.
