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
  fonts, which cover English, Spanish, French, German, Portuguese and Italian; letters with an accent
  they lack (for example Polish ł) lose the accent. A PDF with letters they can't show at all (Greek,
  Cyrillic, Chinese, Arabic, ...) isn't made: she names those letters and makes it as Word instead,
  which takes every language (Word or LibreOffice can save it as a PDF).
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

## Contracts, proposals and letters

Draft contracts, proposals, letters, NDAs, statements of work and invoice covers from **your own
templates and past documents**, revise them with **tracked changes in Word**, check them against a
**clause checklist**, and make a **PDF ready to sign**. This is information, not legal advice: for
anything important, have a lawyer read it.

> "Draft the consulting agreement for Acme from my template."
> "Make the payment 15 days, as tracked changes."
> "Check the clauses in the Acme agreement."
> "Make it ready to sign for Pat Doe at Acme and me."

**Templates.** Open any document in the **Library** and tick **Use as a template** (pick its kind:
contract, proposal, letter, NDA, statement of work or invoice cover). She finds its blanks:
`{{Client}}`, `[CLIENT NAME]` or `[insert date]`, `<<Project>>` or `«Project»`, and a label with a line
(`Date: ______`). Signature lines (`Signature: ____`, `By: ____`) are left for signing. A Word template
shows a form with one box per blank; **Make the document** fills a copy in place, so every value keeps
the blank's own font and formatting. The template itself never changes.

**Drafting in chat.** She lists the blanks and asks only for the facts she doesn't know (with tap-to-pick
answers where there are a few set options). She can reuse clauses from your **past documents** of the
same kind, word for word, and says which document each one came from; a clause that isn't really in
that document is refused.

**Tracked changes.** When she revises a Word file, each change is a real Word revision by "Sara" with
the date, word by word (only the words that change are marked). Open it in Word → **Review** to accept
or reject each one; Track Changes is switched on in the file so your own edits are tracked too. The
Library shows the same list (*Changed 30 → 15*, *Added*, *Removed*, who and when), with **Accept all**
and **Reject all**. Every revision is a new version; the earlier ones are kept.

**Clause checklist.** For each kind of document, the usual clauses, each marked **present** (with the
sentence quoted and where it is), **missing**, or **unusual** (with why):

| Kind | Clauses |
|---|---|
| Contract | parties, term, payment, termination, liability cap, indemnity, confidentiality, intellectual property, governing law, signatures |
| NDA | parties, term, confidentiality, what is not confidential, termination, governing law, signatures |
| Statement of work | parties, scope, timeline, payment, acceptance, termination, signatures |
| Proposal | scope, timeline, price, assumptions |
| Letter | date, greeting, closing |
| Invoice cover | invoice number, date, amount due, due date, how to pay |

Unusual: automatic renewal, unlimited liability, a late fee above 1.5% a month. Non-compete,
exclusivity, one-sided changes and arbitration are listed as worth a second look.

**Ready to sign.** From the final Word file she makes a PDF with page numbers and, for each signer, a
**signature field**, a **name field** (filled when she knows the name) and a **date field**: real form
fields any PDF reader that signs forms can use. First the check: no blanks left and no tracked
changes left. If either fails, no PDF is made and she says what to fix (or makes a draft PDF if you ask).

### How it works (for developers)

| Piece | What it does |
|---|---|
| `src/documents/placeholders.ts` | Finds blanks in text (`detectPlaceholders`), fills text (`fillText`) and Word files in place (`fillDocxPlaceholders`: body, headers, footers). |
| `src/documents/tracked.ts` | The paragraph model shared with filling: plain runs become characters that remember their run; edits keep each run's formatting; fields, links and earlier revisions are never cut. `reviseDocx` (find/replace word by word with an LCS diff, insert a paragraph, delete a paragraph; `w:ins`/`w:del` with `w:author`, `w:date`, unique `w:id`; paragraph marks too; `w:trackRevisions` in settings), `listRevisions`, `resolveAll` (accept/reject all), `addClauses`. |
| `src/documents/clauses.ts` | `clauseChecklist(text, type)` per kind, reusing the E6 contract reader's sentences, places and flags (`src/biz/contracts.ts`); `guessDocType`. |
| `src/documents/sign.ts` | `docxToMarkdown` (changes accepted) and `makeSignPdf`: the Ready to sign check, then the existing PDF maker with `spec.sign` (signature blocks: `/FT /Sig` and `/FT /Tx` widgets, an `/AcroForm`, appearance streams for filled names), read back with `readPdfForm`. |
| `src/documents/templates.ts` | `doc_templates` table (per space), `pastClauses` (the person's own clause wording by kind, with its document), `quoteIn` (word-for-word check). |
| `src/tools/doc-studio.ts` | Tools `doc_from_template`, `doc_revise`, `doc_checklist` (read-only), `doc_to_sign`; a document named in words means its newest version. Files are kept as made documents with `spec.edited` (never remade by `make_document`). |
| `src/routes/doc-studio.ts`, `web/doc-studio.js` | `/api/doc-studio/…` (member route group `doc-studio`) and the Library panel. |

Not done: comments (`w:comment`) and moved text, revising headers/footers and text boxes with tracked
changes, real digital signatures (the fields are empty for the signer's own tool), legal-language
checks beyond wording.

## Reading documents

She already reads Word, Excel, PowerPoint, PDF, EPUB, web pages, Markdown and CSV files you add to
the chat or the Library ("summarize this document"); see [LIBRARY.md](LIBRARY.md).

Invoices and quotes (from your own template too), contracts, receipts and action items have their own
tools: see [BUSINESS_TOOLS.md](BUSINESS_TOOLS.md).

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
