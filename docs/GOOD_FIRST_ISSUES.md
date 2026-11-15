# Good first issues

Small, real tasks that are a good way into the code. Each one says where to look and how to know
you're done. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first (no runtime dependencies, tests
required, plain words), and say in an issue which one you're picking up so two people don't do the
same one.

Sizes: **S** = an evening, **M** = a weekend.

## Code

1. **Code map: understand `!` lines in `.gitignore`** (S)
   The map follows ordered negation lines such as `!keep.log`, so an explicitly re-included source
   file can be found without descending into an excluded parent folder.
   *Where:* [`src/codemap/ignore.ts`](../src/codemap/ignore.ts) (rule parsing and decision order),
   tests in [`test/codemap.test.ts`](../test/codemap.test.ts).
   *Done when:* `!` lines re-include files in the same order git applies them, with tests for a
   re-included file and for a folder that stays ignored.

2. **`sara doctor`: a line for the testing browser** (S)
   The doctor checks the database, models and backups, but not whether the headless browser she
   tests web apps in can start.
   *Where:* `runDoctor()` in [`src/doctor.ts`](../src/doctor.ts); how the browser is found and
   started in [`src/browser.ts`](../src/browser.ts); tests in [`test/doctor.test.ts`](../test/doctor.test.ts).
   *Done when:* the doctor says "found / not found (how to install)" without starting a real browser
   in the tests (inject the lookup).

3. **Weather example: all the weather codes** (S)
   The example tool knows the common WMO weather codes; add the rest (freezing drizzle, freezing
   rain, snow grains, snow showers) so it never says "weather code 66".
   *Where:* `CODES` in [`examples/tools/weather-tool.ts`](../examples/tools/weather-tool.ts), test in
   [`test/examples.test.ts`](../test/examples.test.ts).

4. **Receipt check: one more language** (M)
   The check that compares what she *says* she did with what really ran reads English, Spanish,
   French, German, Portuguese and Italian (Phase 62). Add another language you know well (Dutch,
   Polish, Swedish…): its verb forms for "I created / saved / sent / ran / deleted / scheduled",
   its negations, and 40 labelled replies (half real claims) in `evals/claims-multilingual.json`.
   *Where:* [`src/receipts.ts`](../src/receipts.ts) (`MORE`, `SEND_VERB`, `SCHEDULE_VERB`), tests in
   [`test/phase62.test.ts`](../test/phase62.test.ts), eval `node scripts/eval-claims.ts`.
   *Done when:* the eval shows your language with precision ≥ 0.9 on replies you wrote *before*
   writing the patterns.

5. **Coding benchmark: an MBPP option** (M)
   `scripts/bench-coding.ts` runs OpenAI's HumanEval. Add `--set mbpp` for the sanitized MBPP
   problems from Google Research's public repository (downloaded at run time, like HumanEval; check
   and credit its license).
   *Where:* [`scripts/bench-coding.ts`](../scripts/bench-coding.ts), [docs/RESULTS.md](RESULTS.md),
   [docs/CREDITS.md](CREDITS.md); helper tests in [`test/examples.test.ts`](../test/examples.test.ts).

6. **Code map eval: harder questions** (M)
   With a capable model, plain search already answers every "which file…?" question, so the eval
   can't show what the code tools add. Write 6–8 multi-step questions about Sara's own code
   ("what runs between the owner's message arriving and the safety check?") with answers that need
   two or more files.
   *Where:* `QUESTIONS` in [`scripts/eval-codemap.ts`](../scripts/eval-codemap.ts).

## Web app

7. **Character gallery: check it at phone width** (S)
   Open Settings → Sara → Name and personality → gallery on a 390-pixel-wide window and fix cards
   that overflow or wrap badly (long tags, the "Try a line" row).
   *Where:* the `gallery-*` rules in [`web/style.css`](../web/style.css), cards built around
   `gallery-tags` in [`web/app.js`](../web/app.js).
   *Done when:* before/after screenshots at 390 and 1440 pixels wide in the pull request.

8. **Translate the gallery pitches and tags** (S)
   The seven gallery characters' one-line pitches and tags show in English in every language.
   *Where:* [`persona/gallery/*.json`](../persona/gallery/), how cards are built in
   [`web/app.js`](../web/app.js) (search `gallery-pitch`), the language files in `web/i18n/` and
   [docs/TRANSLATING.md](TRANSLATING.md).
   *Done when:* `node scripts/i18n-extract.ts` reports no gaps and `test/i18n.test.ts` passes.

9. **Say what Undo can't bring back** (S)
   Workspace snapshots (her Undo after file changes) skip `node_modules`, `.venv` and similar
   folders and files over 50 MB, so Undo leaves those alone. The app doesn't say so.
   *Where:* the skip rules in [`src/snapshots.ts`](../src/snapshots.ts), and the help guide
   [`web/help.html`](../web/help.html) (search "undo").
   *Done when:* the guide says it in one plain sentence, and `test/i18n.test.ts` passes
   (new text needs translations).

## Content

10. **A new gallery character** (S)
    Write an original character (adult, not romantic by default, no pictures) with a pitch and three
    tags.
    *Where:* [`persona/gallery/`](../persona/gallery/); the format is in
    [docs/EXTENDING.md](EXTENDING.md#add-a-character).
    *Done when:* `test/gallery-workmode.test.ts` passes with your file in the folder.

11. **A new starter template: Python command-line tool** (M)
    The four starters (Telegram bot, landing page, REST API, Node CLI) are all JavaScript. Add a
    Python CLI starter with `argparse`, a function module and `unittest` tests (standard library
    only).
    *Where:* [`templates/starters/`](../templates/starters/), the example in
    [`examples/starters/word-counter/`](../examples/starters/word-counter/), the guide in
    [docs/EXTENDING.md](EXTENDING.md#add-a-starter-template); `test/phase52.test.ts` lists starters.

12. **A new language** (M)
    Add a language to the app, or review an existing one as a native speaker.
    *Where:* [docs/TRANSLATING.md](TRANSLATING.md), `web/i18n/`, the AI disclosure in
    [`src/i18n.ts`](../src/i18n.ts) (it must be translated accurately; it is legally required).

## Docs

13. **Log files in the install guide** (S)
    Sara keeps her own log at `<data>/logs/sara.log`, one JSON object per line, rotated at 5 MB
    with five old files kept. The install guide doesn't mention it.
    *Where:* [`src/log.ts`](../src/log.ts) (the facts), [docs/INSTALL.md](INSTALL.md) (where to add
    a short "Logs" section next to the systemd `journalctl` hints).

14. **Docs site: previous / next links** (S)
    `node scripts/build-docs.ts` builds the docs site into `outputs/site/`. Add previous/next links at
    the bottom of each page in sidebar order.
    *Where:* [`scripts/build-docs.ts`](../scripts/build-docs.ts); keep it dependency-free.
