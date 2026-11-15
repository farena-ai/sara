# What Sara knows: your world, with sources (N6)

Settings → You → **What Sara knows** (`web/facts.js`, `src/facts.ts`, routes `src/routes/facts.ts`) shows what
Sara keeps about the person's world, grouped: people and family, home, vehicles, health, work, money, dates
(and other). Each fact has:

- its text;
- its source: a chat (the person said it; the link opens the message) or a Library document (file and page);
- when she learned it, and how: **said** directly or **read** in a document;
- Edit, Delete and **Not true**.

## Where facts come from

Nothing is stored twice.

- **Memory (adapter).** Memory facts and dates (`src/memory.ts`, kinds `fact` and `date`) are shown as they are.
  Edit changes the memory itself, Delete deletes it (and its meaning vector), and Not true runs Forget
  (`forgetMemory`): the memory goes and its source message is hidden from her. Facts from a private chat are
  marked private. Memory facts never keep a full card number or SSN (`maskCardsAndSsn` in the memory worker).
- **Documents (rules, no model).** Every kept, read Library document is read once for facts
  (`world_doc_facts`, `world_doc_scans`). Rules find:
  - renewal, expiry and due dates, the end of a lease, warranty end, passport and license expiry;
  - policy, account, member, passport, license, serial numbers and VINs, **last 4 only** (`••••8831`);
  - deductibles, premiums, rent, deposits, copays;
  - names on a lease or a policy (insured, tenant, landlord).

  The exact line a fact came from is kept with long numbers masked. Card numbers and SSNs are never kept.
  Health documents and passports are private. A deleted document takes its facts with it. A fact deleted or
  marked not true does not come back when the document is read again.

My details (`docs/MY_DETAILS.md`) stays the person's typed form data. A policy number or VIN fact offers
**Add to My details**, which opens that page; the person types the full number there.

## Documents in other languages

The document rules also read Spanish, French, German, Brazilian Portuguese and Italian papers. Sara
picks the document's language from its common short words (English when unsure), then:

- reads its own labels for renewal, expiry, due dates, lease end and warranty end (*fecha de
  renovación*, *date d'échéance*, *Mietverhältnis endet am*, *vencimento*, *scadenza*…), deductibles,
  premiums, rent and deposits (*franquicia*, *cotisation*, *Kaution*, *franquia*, *canone*…), policy,
  account and serial numbers (last 4 only, as always) and the names on a lease or a policy;
- reads dates in that language's order: **03/04/2027 is 3 April** in those documents (and still
  March 4 in an English one), plus month names (*31 de mayo de 2027*, *1er mars 2027*, *1. März 2027*);
- keeps money as the document writes it (**1.234,56 €**, **R$ 2.450,00**, **1 024,50 €**).

The labels shown are the same as for English papers (in your app's language). Code: `src/facts-lang.ts`.

## Ask your documents

`library` tool action `ask` (and the box on the page, `POST /api/facts/ask`) answers questions about the
person's own papers ("what's my deductible?", "when does my lease end?"):

1. It searches every Library file by words and meaning.
2. It picks the sentences that answer.
3. It keeps only quotes found word for word in the file (`verifyQuotes` from E6 contract review).
4. It returns each with the file, the page and a cite link.

When nothing answers, it says **not found in your documents**, and she says so instead of guessing.

## Dates to reminders

Future dates found in documents become cards: "From your documents" on the page and on Today (inside the
inbox tile). **Accept** adds a planner reminder at 9:00, N days before the date:

| Kind of date | Days before |
| --- | --- |
| Renewal, expiry, lease end, warranty end, passport or license expiry | 30 |
| Due date | 3 |

Nothing is added by itself.

## In chat

- `facts_list` ("what do you know about me?") lists facts with sources. Private facts are listed only in a
  private chat or when the person asks for them.
- `fact_forget` ("forget that…", asks first) removes the fact and its memory.
- The persona section tells her to name a fact's source, to ask before keeping something sensitive, and to
  keep numbers to the last 4.
- Lean family `facts` has words in six languages.

## Isolation

Each household member has their own facts (their space's own store.db). The route group `facts` is a member
route. The demo has none. Nothing here calls a model, so private local mode changes nothing.
