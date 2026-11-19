# W4.6 Public-records report (personal use only)

Owner request 2026-11-19: "An OSINT style background check where you can put in a name, address,
whatever and it will do a check on all public information style sites returning cited references
and creating a very nice PDF of the report", with the header "NOT FCRA COMPLIANT - This information
can not be used in housing, loan, employment, or other life altering decisions" on every page.
Personal research only: not a product, never paid brokers.

## What existed (reused, not rebuilt)
- Web search (`src/tools/search.ts` `runSearch`, the owner's backend; DuckDuckGo HTML fallback
  `freeSearch` in `src/tools/shopping.ts`), the guarded page reader (`fetchPageRetrying` in
  `src/research.ts`: SSRF rules, private local mode, bot-wall detection, 404s, retries) and
  `robotsAllows` from `src/learn.ts` (C6 site learning).
- The PDF writer `src/documents/pdf.ts` (`makePdf`, links, page numbers). It gains one optional
  `pageHeader` so every page carries the exact notice.
- The audit trail (`src/audit-trail.ts` `audit()`), redacted content hidden unless asked.
- Research runs (EC6) stay the tool for questions; this is a fixed, code-driven pipeline for a person.

## What is new
- `src/records.ts`: the engine (one per owner space; members, kids and the demo get none).
  - Input: name, address, phone, email, username, optional city/state (region) and age.
  - Refusals before any search: no identifier; under-18 signals (age < 18, child/teen/school words);
    private local mode; and during the run: a matched page that says the person is under 18 ends
    the report with nothing kept.
  - Queries from the input plus the "places to search" list (per record type and region).
  - Results from paid data brokers (`PAID_BROKERS`, tested) are skipped and listed as skipped;
    sign-in-only sites (LinkedIn, Facebook, Instagram, X) are never opened: only the public preview
    the search engine showed is cited ("search preview"). robots.txt is honoured; bot checks and
    paywalls are never worked around (the place is marked failing / paid).
  - Matching by code: the full name (or the identifier searched) must appear; each corroborating
    identifier (city, state, phone, email, username, street address) raises confidence
    (low / medium / high); the same identifier on two independent sites cross-checks a match.
  - Every fact keeps its link, the date seen and a short quote; every section that found nothing
    says "Not found" plainly.
  - "Find more sources" runs another round: untried queries, unread results, places learned.
  - The places list (`<data>/records/places.json`) grows: a new site with a matched page is added
    with what it held and how it was searched; failing sites (3 fails, no hit) and paid ones are
    marked and skipped; the next report starts with the places that worked. The owner can view,
    edit, switch off, add and remove places.
  - Every web search is one audit row (`records.search`, the query as redacted content); refusals
    are `records.refused`.
- Tool `records_report` (asks first; owner only; off in private chats and private local mode):
  starts a report or continues one (`more_of`), and answers with the counts and the top facts.
- Routes `/api/records` (owner only): list/start, get, more, stop, delete, PDF, places CRUD.
- Library → Public records (`#lib-records`, `web/records.js`): form, progress, report by section
  with confidence chips, Find more sources, Download PDF, and the places list with edit controls.
- PDF: cover (subject, date, what was searched, the notice), one page per group of sections,
  sources appendix and the searches run; the header on every page.

## Not done (by design)
- No paid sources, no sign-ins, no CAPTCHA solving, no scraping in tests (fake search/pages only).
