# Write like a person (S11)

Sara can make what she writes read like a careful person wrote it: plain everyday words, sentences
of different lengths, the concrete details from the source instead of filler. Facts, quotes and
citations stay exactly as they were, and you see side by side what changed.

This is about clear, natural writing. It is not built or sold as a way around AI detectors or school
rules, and for children it coaches instead of writing their homework.

## Where you find it

- **Make it sound human** on every Word, PDF, Markdown or web-page document she made (the card in the
  chat) and on a finished research report (Library → Research). It opens a side-by-side view:
  *Before* with the removed words struck through, *After* with the new words marked, the "reads
  natural" score before and after, and whether every fact stayed the same. **Keep** makes a new version
  of the document (older versions stay) or replaces the report text (downloads then use it); **Undo**
  puts the words as written back.
- **In chat:** ask "make this sound more natural" or "rewrite this so it sounds like me". She uses the
  `humanize_text` tool and gives you the new text with the score.
- **Settings → You → About you → Writing style:** *Natural* or *As written* (the default). Natural makes
  `make_document` rewrite the prose of Word/PDF/Markdown/web documents first, gives her a short
  writing note for email drafts, summaries and letters in chat, and is used by research export with
  `?style=natural`. A document request can still say `style: as-written`.
- **Match my voice:** paste 1 to 5 things you wrote (a line with `---` between them) or pick documents
  you wrote from your Library, then *Make my style card*. She keeps only a short card: your usual
  sentence length, tone (casual, neutral or formal), how often you use contractions, a few favorite
  words and your punctuation habits. The *Match my voice* box in the side-by-side view and in chat
  (`voice: true`) applies it. *Forget my style card* deletes it.

## The rules she follows

Plain words; varied sentence length and rhythm; specifics from the source; no stock phrases and
patterns: delve, tapestry, testament, "in today's fast-paced world", "it's important to note", "in
conclusion", moreover/furthermore chains, rule-of-three lists, em-dash habits, stacked hedges ("may
potentially perhaps"), empty intensifiers ("truly, incredibly"), headings in short pieces. The length
stays within 15% of what you asked for (without a target, cutting filler may shorten it, never by more
than half).

## The facts lock

Every number, name, quote ("…", “…”, «…», „…“), citation like `[1]` and link must be identical before
and after, and no new ones may appear. If a rewrite breaks one, she tries once more, telling the model
which facts slipped. If the second try also breaks one, the original sentences come back for the
broken spans. If that still doesn't hold, or the rewrite doesn't read better, the text stays as
written and you're told why.

## The "reads natural" score

A check with no model (`src/humanize.ts` `checkText`), in English, Spanish, French, German,
Portuguese and Italian: stock phrases (counted), empty intensifiers, hedging stacks, em-dash rate per
1,000 words, rule-of-three lists, sentence-length variation (flat rhythm) and headings in short
pieces. 75 and up reads natural, 50-74 a little stiff, below 50 stiff. It proves a rewrite improved and
is shown before and after.

## Kids

For a child member (kid-safe mode), asking for a book report, essay or homework gets coaching: an
outline, guiding questions, and suggestions on their own draft. *Make it sound human* and
`humanize_text` on a child's own text give suggestions, never a rewrite, and there is no Keep. It's
enforced on the server: `make_document` refuses to write running prose for an assignment for a
child (an outline of headings, bullets and questions is fine), and her kid persona note says the
same.

## Privacy

The style card and the default live in each person's own space (`writing_prefs` in their store.db).
A household member's card is theirs; the owner doesn't see it. Rewrites use the *writing* model route
(falling back to the background model). In a private chat it follows that chat's model rules.

## One-page design

- **Module:** `src/humanize.ts`: `checkText`, `factsOf`/`factsLock`/`repairFacts`, `diffWords`,
  `extractStyleCard`/`styleCardNote`, `WritingPrefsStore` (`writingFor(app)`), `isAssignment`,
  `proseWords`, `coachFeedback`/`coachText`, `humanizePrompt`, `humanize(app, text, {voice, targetWords})`,
  `writingNote(app)`.
- **Flow:** check before → up to 2 model calls (`complete(…, 'writing')`) → each try must keep facts,
  fit the length and score ≥ before → else repair broken spans with original sentences → else as
  written. Result carries before/after checks, facts, length ratio and word-level changes.
- **Tool:** `humanize_text` (`src/tools/humanize.ts`; documents lean family; in `KID_TOOLS`, coaching
  only for a child). `make_document` gets `style` (`natural` | `as-written`).
- **Routes** (`src/routes/writing.ts`, member-usable, audited): `GET/PUT /api/writing`,
  `POST/DELETE /api/writing/voice`, `POST /api/writing/check`, `POST /api/writing/humanize`
  (`text` | `madeId` | `researchId`), `POST /api/writing/keep`. Research: `Research.replaceReport`,
  export `?style=natural`.
- **Chat:** `writingNote` is one system note at the provider boundary when the default is Natural.
- **Web:** `web/humanize.js` (side-by-side dialog `#hz-view`), buttons in `web/doc-card.js` and
  `web/research.js`, Settings section in About you (`web/writing-style.js`), CSS in `web/doc-card.css`.
- **Existed and reused:** make_document and made-document versions, research reports and export,
  the Library, model routing (`writing` route), kid-safe mode (KID_TOOLS, kid persona note),
  `detectDocLang` from N6/R9.
