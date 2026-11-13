# Decision helper and comparisons

Sara helps you decide; she doesn't decide for you. Ask her things like "Should I take the job in
Denver?", "Which is better, the Civic or the Corolla?", "pros and cons of renting" or "compare these
three phone plans".

## How it works

1. **Options and what matters.** She gathers the options and the criteria that matter to you, each with
   a weight from 1 (matters a little) to 5 (matters most). If you didn't say what matters, she asks (at
   most two short questions).
2. **Scores, with where they came from.** Each option gets a score per criterion: either your own 1–10
   rating ("you said"), a fact with its source ("$24,000, from honda.com"), or her estimate, which is
   always flagged as "my estimate". She looks facts up instead of guessing; anything unknown is shown
   as missing (and counts as zero until it is filled in), never invented.
3. **The math, in code.** Raw values with units (prices, miles, minutes) are scaled 0–1 between the
   lowest and highest value of that criterion, turned around where lower is better (price, distance,
   risk). 1–10 ratings are scaled as they are. The total is the weighted average, out of 100. The same
   numbers always give the same result.
4. **How solid the result is.** She checks whether the winner changes if any one weight moves by one,
   or if the winner's narrowest lead over the runner-up were swapped. When the top two are within 5%
   she says it's a **close call**; equal totals are a **tie**. She names the deciding factors (where the
   leader gains and where the runner-up is better).
5. **Pre-mortem.** A short "what could go wrong" with the leading option and "how to undo it" (can it
   be reversed, what would switching cost). Then she asks which you choose.

The chat shows a card with the options ranked as bars, the Close call badge, an **I chose this**
button on each option and **Save as document** (a Word document in your Library with the table,
sources and your choice).

## Saved and revisited

Every decision is saved in your own space (a household member's decisions are theirs alone). When you
pick, she records your choice and why; give her a date ("in 3 months") and the planner reminds you:
"How did choosing X work out?". Tell her how it went (and rate it 1–5), and the next time you decide
something similar she recalls "last time you chose …, and it went …".

Ask her "what did I decide about …" or "list my decisions" to see them again.

## Side-by-side comparisons

"Compare" makes a plain table of items and their attributes (price, size, rating…) from the values
she was given or found, with sources. Missing values are marked "—" and counted; nothing is filled in.
For a weighted pick between them, she uses the decision helper.

## For developers

`src/decisions.ts` (math, store, tools `decide`, `decision_record`, `decision_review`,
`decision_list`, `compare`, card builders), `src/routes/decisions.ts` (`GET /api/decisions[/:id]`,
`POST /api/decisions/:id/choose`, `POST /api/decisions/:id/document`), `web/decision-card.js`,
`web/decision.css`. Table `decisions` in the space's own database. Tests: `test/decisions.test.ts`.
