# Public records report (personal use only)

**NOT FCRA COMPLIANT - This information can not be used in housing, loan, employment, or other life
altering decisions.** This is for your own personal research about an adult. It is not a background
check service and must not be used for tenant, credit, hiring or similar decisions.

## Start one
- Library → **Public records report…** (owner only; household members and kids never see it), or
  ask in a chat: "make a public records report on Jane Doe in Springfield, IL" (she asks before it
  runs).
- Give a name, street address, phone, email or username. City and state tell people with the same
  name apart and raise confidence; age is optional.
- She refuses anyone under 18: before any search (an age under 18 or words like "my son", "teen",
  "middle school"), and during the search if a matching page says the person is under 18. Then
  nothing is kept.

## What she searches
- Your web search (Settings → Connections → Web search), or the free DuckDuckGo page when none is set.
- Free public places: court records (CourtListener, Justia dockets), business registries
  (OpenCorporates, SEC EDGAR, state registries), obituaries and local news, county property sites,
  public profiles (GitHub, Reddit, Keybase) and political donations (FEC).
- **Never**: paid data brokers (a fixed blocklist: Spokeo, BeenVerified, Intelius, TruthFinder,
  Whitepages and more), sites that need a sign-in (LinkedIn, Facebook, Instagram, X: only the public
  preview a search engine shows is cited, marked "search preview only"), pages a site's robots.txt
  asks robots not to read, bot checks or paywalls (never worked around; the site is marked).
- "Nothing leaves this computer" mode turns it off.

## The report
- Sections: profiles and social media, news, court records, property records, business
  registrations, other public pages. A section with nothing says **Not found** plainly.
- Every fact has its link, the date it was seen, a short quote and a confidence:
  **high** = the name and two or more other details match (city, state, phone, email, username,
  address); **medium** = one other detail; **low** = the name only (may be someone else). A phone,
  email, username or address seen on two different sites raises a match one step.
- **Find more sources** runs another round: searches not run yet, places learned since, results not
  read yet. It never repeats a search.
- **Download PDF**: a cover (what was searched, a summary), the sections, a sources appendix (every
  result looked at and what happened to it) and the searches run, with the notice at the top of
  every page.
- Every web search is a row in your audit log (Settings → Household → Audit trail,
  `records.search`; the query is kept as hidden content). Refusals are `records.refused`.

## Places she searches (her growing list)
- Under the report: each place has its record type, region (anywhere, US or a state like US-IL),
  what it holds, how she searches it (`site:example.com "{name}"`) and its hits.
- A new site that gave a matching page is added by itself ("learned") with what it held; a site that
  failed 3 times without a hit becomes **Failing**, one that asked for payment **Wants payment**;
  both are skipped. The next report starts with the places that worked.
- You can turn places off and on, edit what they hold and how to search them, add your own, and
  remove them. Paid brokers can't be added.
