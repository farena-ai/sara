# P4 visual refresh (2026-11-20)

Owner ask (polish pass): "any visual improvements you can make to just bring this forward to where we
are now". Visual only: no behaviour, no ids, no page changes. Not touched here: Today's stock tiles and
the composer's Enter key (other P4 builders).

## What existed (studied first)
- Tokens in `web/theme.css`: Sara Classic (frozen, test/v1-theme), the V1 palettes and sizes
  (`--r-*`, `--h-control`, `--fs-*`, `--dur-*`), V3 Full decoration (glass), V4 accent hue tokens.
- Look layers per screen: `style.css`, `look.css` (V1 new look folded per sheet), `v3.css`, `v4.css`,
  `v4-pages.css`, `polish.css`, `kit.css` (`.empty-state` with icon), `settings3.css` (must load last).
- Accessibility switch (V5, `web/a11y-mode.js`): `html.reduce-motion`, `data-large`, `data-read`;
  the High contrast palette (`data-palette="contrast"`).

## What changed
- `web/theme.css`: one appended block `P4 visual refresh` with `--p4-*` tokens: type scale
  (12/13/14/16/20/26) and line heights, 4-px spacing scale, radii (8/12/16/20), three elevations
  (Night from `--surface-0`, Day from `--text-1`), softer `--p4-border`, `--p4-border-strong`, a two-tone
  focus ring `--p4-ring` and field ring, chat fills, skeleton colours, motion (160/240 ms). High contrast
  resets borders to full `--line`, no soft shadows; reduced motion and `html.reduce-motion` zero the durations.
- `web/refresh.css` (new, linked right before `settings3.css`): every selector starts with
  `:where(:root:not([data-palette="classic"]))`, so Classic keeps its look and specificity stays as before.
  1. Type: font smoothing, balanced headings, selection colour, thin scrollbars on the main scroll areas.
  2. Focus: one visible ring on every control (`--focus` outline; fields add the soft accent ring).
  3. Controls: inputs and selects at `--h-control`, 8-px corners, hover edge, smooth transitions, a 1-px press.
  4. Cards: `.v4-card`, `.kit-card`, Today tiles share a 12-px corner, a softer edge and a faint lift by day.
  5. Chat: your turns sit in a soft rounded bubble (no more hairline rows), more air between turns,
     code blocks wider (up to 720 px) with a header bar, monospace label, rounded Copy, inline code chips,
     rounder tables, hover actions with a hover fill.
  6. Sidebar and header: softer dividers, rounded rows, a steadier chat title.
  7. Small dialogs: 16-px corners; modal windows (not Today, not Settings) rise in over 240 ms.
  8. Empty states: a chat-bubble picture (inline SVG mask, painted with `--accent-text`) above
     "Say hi to Sara." and in Ctrl+K's no-match line.
  9. Skeletons: `.sk-line` shimmer bars where nine panels showed a bare "Loading…" (her panel, Get more
     shared items, MCP catalog, My apps, hooks, learned skills, workspace view, code map, gift ideas).
     The words stay in the DOM (transparent), so screen readers still hear "Loading…".

## Rules (test/p4-visual.test.ts)
- refresh.css has no hex, `rgb()`/`hsl()` or named colours (mask pictures inside `url()` are alpha only);
  every `var(--p4-*)` it uses is defined in theme.css; no tokens defined in refresh.css.
- Every selector is Classic-scoped; entrances/shimmer only under `prefers-reduced-motion: no-preference`
  and `:not(.reduce-motion)`; no `outline: none`.
- Linked once, right before `settings3.css` (settings3-look pins settings3.css last).

## Proof
BEFORE/AFTER screenshots of 12 screens (chat, empty chat, Today, sidebar, Ctrl+K, Library, Planner,
What Sara remembers, Settings home, Appearance, Providers, sign-in) at light/dark x 1440/390, plus High
contrast with the accessibility switch on: `outputs/p4visual/{before,after1,after2,hc}` (gitignored).
