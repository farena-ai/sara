# Accessibility: screen readers, keyboard and large text

Sara should work for everyone: with a screen reader, with only a keyboard, and with big text or a
zoomed page. This page says what is in place, how it is checked and what to keep doing.

## What is in place

- **Skip link.** The first Tab on the page is *Skip to main content* (it jumps to the chat).
- **Screen reader names.** Each chat message says who wrote it (*You said* / *Sara said*, with her
  own name). New messages are announced politely (`#messages` is `aria-live="polite"`), so a reply is
  read when it arrives without cutting off what is being read. An approval card is a named group
  (*Approval needed*), so its question and its Allow / Deny buttons are read together. Today's tiles
  are labelled sections you can Tab to; rows that open something (a person's birthday) work with Enter
  and Space. The automation template card is a named region and its preview is read out when it
  appears.
- **Every control has a name.** Buttons, links and inputs carry visible text, a `<label>` or an
  `aria-label`; images have `alt`. Thirteen inputs that only had a placeholder got a label in R9.
- **Colors.** The theme's text and accent colors meet WCAG AA (4.5:1 for text, 3:1 for the focus ring
  and warnings) in light and dark. Change colors only through the theme variables in `web/theme.css`.
- **Focus you can see.** Keyboard focus shows a ring (`:focus-visible`, the theme's `--focus`).
- **Large text.** Settings → You → Appearance → *Text size in chat* (up to *Larger*) and the
  browser's own zoom (200%) were checked at phone (390 px, and the 320 px reflow width) and desktop
  (1440 px) widths: no sideways scrolling and no clipped text in the chat, Today, Settings →
  Automations and the offline view.

## How it is checked

`web/a11y-check.js` is Sara's own small checker (axe-core is not a dependency). Rules: images
without alt, buttons and links without a name, inputs without a label, headings that skip a level,
theme color contrast (computed from `web/theme.css`, light and dark) and a visible focus ring.

- **Without a browser** (`test/r9-a11y.test.ts`, part of the normal test run): every rule on small
  examples, then `index.html`, `offline.html`, `pair.html`, `download.html` and `device.html` must
  have no findings, the theme must meet AA, and the skip link must be the first thing a keyboard
  reaches. A new unlabelled input fails the test.
- **In a browser** (a throwaway server and Playwright): the same checker runs over the live page
  (`fromDom` + `checkTree`, only what is visible), plus a sideways-overflow and clipped-text scan at
  200% zoom and the largest text size. Run it before a release that changes layout.

## When you add UI

- Give every new button text or an `aria-label`, every input a `<label>` (a placeholder is not a
  label), every image an `alt` (`alt=""` for decoration).
- Use theme variables for colors; never hard-code a color outside `web/theme.css`.
- Something that announces itself (a status line, a new card) goes in `role="status"` or an
  `aria-live="polite"` region.
- A clickable `div` needs `role="button"`, `tabindex="0"` and Enter/Space; prefer a real `<button>`.

## Known gaps

- Below 320 CSS px (a 390 px phone at 200% zoom) the chat header's last buttons run past the edge;
  WCAG reflow asks for 320 px, which works.
- The checker does not compute accessible names the full ARIA way and does not test focus order
  beyond the skip link; a real screen reader pass (NVDA, VoiceOver) is still worth doing.
