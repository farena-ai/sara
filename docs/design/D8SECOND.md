# D8 Second opinion

ROADMAP_V D8 (PARTIAL → DONE). One page.

## What existed

- `src/modelpicks.ts`: blind side-by-side test of two models on a job (Settings → Which model does what).
  It is a model-choosing tool, not something you can do on a reply.
- `src/auto-route.ts`: Auto's candidates (`autoCandidates`: every connected model, member limits,
  missing keys skipped), scoring (`autoChoose`, local-only for private chats / private local mode,
  no pay-per-use past the spend limit) and the cost autopilot's moves.
- `src/cheap.ts` `cheapCall`: a small model call with usage scope, the daily ledger and a cap.
- `src/usage.ts` price table (`priceTable`, `findPrice`, `costOf`), `billingOf`.
- Evals have a "Second opinion" judge (the Reviewing model grading answer pairs); unrelated, kept.

## What D8 adds

- `src/second-opinion.ts`
  - `secondOpinionPlan(app, conv, reply)`: ranks `autoCandidates` with `autoChoose(…, 'chat')`
    (so private chats, private local mode, member limits and the spend limit apply exactly as for
    Auto), drops the model that wrote the reply, double-checks `isLocalModel` in private chats,
    estimates each answer's dollars (question tokens in, about the reply's length out) and picks two
    from different providers first. No model is called.
  - `askSecondOpinion(app, conv, reply, models?)`: refuses a model outside the plan (400; private:
    "only models on this computer"), asks both in parallel through `cheapCall` (purpose and ledger
    source `second-opinion`, cap 40 a day, 1200 tokens, no tools, her reply not shown: an
    independent answer), diffs and stores the result in the reply's `meta.secondOpinion`.
  - `diffAnswers(texts)`: per sentence `same` (another answer says it: word-set Jaccard ≥ 0.5 or
    80 % overlap), `number` (a similar sentence elsewhere with other numbers), `only`. Parts join
    back to the exact text.
- `src/routes/second-opinion.ts`: `GET /api/conversations/:id/second-opinion?message=ID` (plan),
  `POST` `{message, models?}` (answers). Each person's own store, demo 404, one run per reply at a
  time (409). No new route family (rides `conversations`): no household-isolation churn.
- `web/second-opinion.js` + one line in `msgActions` (web/app.js): a "Get a second opinion" action
  on her replies (not off-the-record, partner or other companions' lines). The panel under the reply
  shows two pickers (every allowed model with "free, on this computer" / "≈ $0.002" / "price not
  known"), the total spend line, then Ask them / Not now. The result is three columns (her reply +
  two) with `mark.sop-only` / `mark.sop-num` highlights, a one-line verdict and a legend; it comes
  back folded after a reload. CSS: `.sop-*` in web/style.css, theme variables only.

## Not done / choices

- No Settings page: the pickers live in the panel (fewer steps); nothing to configure.
- Off-the-record chats get no button (their store is in memory and is not written to).
- The diff is sentence-level and language-neutral; "Six minutes" vs "6 minutes" counts as different.
- Estimates use the shipped/owner price table; real spend lands in Usage as purpose `second-opinion`.

## Tests

`test/d8-second-opinion.test.ts` (6): plan picks two other models and calls none; two fake models
answer with the diff against her reply and it is kept; private chats only local (cloud asked for →
refused, nothing sent); private local mode and the spend limit; `diffAnswers`; routes (GET/POST,
404 on a user message, 409 with nothing to ask).
