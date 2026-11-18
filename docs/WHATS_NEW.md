# What's new after each update (U5.32)

ROADMAP_U U5.32 ("what changed" page). After the server (or an app) updates, the first time each person
opens Sara a **What's new in 3.x** page shows the releases since the last version they saw, in plain
words, with a link to the place each change lives.

## What existed (reused, not duplicated)

- `CHANGELOG.md` `## x.y.z (date): title` sections with `New:` / `Fixed:` lines: the only source.
- The updater and `web/update-check.js` ("Sara was updated to X" note, per device): unchanged.
- Try these (`src/owner-checks.ts`, Help → Try these): What's new links to its items; `openTryThese(id)`
  now scrolls to and marks the item.
- Help menu pick-cards, the first-run queue (`web/first-run.js`: never a window over another), the
  normal i18n files and `scripts/i18n-extract.ts`.
- Settings → Updates still links to the full CHANGELOG on GitHub (`#up-whatsnew`).

## How it works

- **Build time:** `node scripts/whats-new.ts` reads CHANGELOG.md and writes `web/whats-new.json`:
  the newest 8 releases (Unreleased never), up to 6 highlights each (New before Fixed, at most 3 fixes,
  one per place first). Each highlight is the line's first sentence with markdown and roadmap/doc
  references removed (a very short one takes the next sentence; at most 170 characters, never cut
  inside a parenthesis or quote). `LINK_RULES` in `src/whats-new.ts` give it a link (`#view=money`,
  `#view=settings:dh-health`, ...) and mark owner-only places; the CHANGELOG's "Owner only" also does.
  `matchChecks` adds the matching Try these ids (same release and same place, or 3 shared words).
- **Translations:** every highlight and release title is an i18n key; `i18n-extract` reads the file,
  so the usual "0 missing" gate fails until the 5 languages have it, and
  `node scripts/whats-new.ts --check` fails when the file is stale or a highlight has no translation
  (test/u5-whats-new.test.ts runs both). At release: rename Unreleased, run the script, translate what
  `i18n-extract --missing es` lists.
- **Run time:** `GET /api/whats-new` per person (`<data>/whats-new.json`: `seen`, `auto`). The first
  look on a new install only remembers the version. After an update `show` is true once with the
  releases since `seen`; closing the page (Got it, ✕, Esc) posts `/api/whats-new/seen`. "Show this after
  each update" (on by default) is `PUT {auto}`. Help → What's new (`?all=1`) shows it again any time;
  `#view=whats-new` too.
- **Who sees what:** members get the members' subset (no owner-only items, no Try it); kid mode gets
  nothing (no page, no Help entry); the demo has none. `whats-new` is a member route.
- A source checkout reporting version `dev` counts as the newest release in the file.

## Files

`src/whats-new.ts`, `src/routes/whats-new.ts`, `scripts/whats-new.ts`, `web/whats-new.json`,
`web/whats-new.js`, `#whats-new` + `#help-whatsnew` in web/index.html, CSS in web/hub.css,
`test/u5-whats-new.test.ts`.
