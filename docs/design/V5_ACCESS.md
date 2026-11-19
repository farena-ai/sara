# V5.5 Accessibility switch

ROADMAP_V item 35 (PARTIAL, S). One place for the things that make Sara easier to read and use, one
switch that turns them on together, and a screen-reader pass over the pages added since R9.

## What existed (kept, not duplicated)

- docs/ACCESSIBILITY.md (R9): skip link, `aria-live` messages, named approval cards, labels, AA theme
  colors, `:focus-visible` ring, 200% zoom and 320 px reflow checks.
- `web/a11y-check.js` (R9): `checkHtml` (static) and `fromDom` + `checkTree` (live) — our axe-style checker.
- Settings → You → Appearance: *Text size in chat* (`sara.textSize`), *Background motion* (`sara.motion`),
  *Decoration*, *Layout* (comfy/compact), the *High contrast* palette, "Use on all my devices" sync
  (`src/appearance.ts`), the system's `prefers-reduced-motion` / `prefers-reduced-transparency`.
- `web/orb.js` and `web/avatar.js` already stop when `<html>` has the class `reduce-motion`; nothing set it.

## What V5.5 adds

A new first group on Appearance, **Accessibility** (no new page, no page-count churn):

| Control | Key (localStorage, per device) | Effect on `<html>` |
|---|---|---|
| `#ap-a11y` Accessibility mode (checkbox) | `sara.a11y` | turns the three below on together, text size at least Large |
| `#ap-read` Reading | `sara.read` = `easy` | `data-read="easy"`: a plainer, more legible font stack (Atkinson Hyperlegible / Lexend / OpenDyslexic when installed, else Verdana), wider letter, word and line spacing, no italics, shorter lines |
| `#ap-linefocus` Line focus | `sara.lineFocus` = `on` | `data-line-focus="on"`: a reading band follows the pointer, a tap or the keyboard focus and dims the rest |
| `#ap-reduce` Motion | `sara.reduceMotion` = `on` | class `reduce-motion` + `data-motion="off"`: no animations or transitions anywhere, not only the background |
| `#ap-large` Large layout | `sara.large` = `on` | `data-large="on"`: bigger UI text and 48 px controls everywhere (not only the chat) |

- The switch writes the sub-settings (and remembers what they were in `sara.a11yPrev`); turning it off
  puts them back. Each sub-setting can still be changed on its own. Line focus is not part of the switch
  (it follows the pointer, which not everyone wants); it is one tap below it.
- **Survives reload:** `web/theme-boot.js` applies the keys before the first paint (same rules as
  `web/a11y-mode.js`, a test keeps them equal). "Use on all my devices" carries them (`Appearance.access`).
- *Reset to defaults* (the look) keeps the Accessibility choices on purpose: resetting colors must
  never take away what someone needs to read the app.
- Easy to find: Settings home quick settings (`QUICK`), Settings search words (accessibility, dyslexia,
  reduce motion, large layout, line focus, screen reader), Ctrl K "Accessibility".
- CSS is one block in `web/style.css` using theme variables only.

## Screen-reader pass

The R9 checker over the views added since R9 (Ask everything, Errands, Goals, Trips, Family, Health,
Money, Messages, Waiting on you, What's new, Try these, Talk, Business pack and the newer Settings
sections): statically per dialog in `test/v5-access.test.ts`, and live (visible DOM) on a throwaway
server at 1440/390 light/dark. Findings fixed in the markup; what remains is listed in the handoff.

## Not doing

No downloaded font (free system faces only, offline-safe), no new page, no server-side per-person
setting (looks are per device, like the rest of Appearance).
