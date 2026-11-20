// P4 visual refresh (docs/design/P4_VISUAL.md): one appended stylesheet (web/refresh.css) on top of the
// theme tokens. Visual only: theme variables for every colour, scoped outside Sara Classic, high contrast
// kept solid, every transition and entrance off with reduced motion or the accessibility switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const css = web('refresh.css');
const theme = web('theme.css');
const html = web('index.html');
/** The CSS without comments and without url(...) (mask pictures are alpha only, never a colour). */
const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()');
const NAMED = /\b(?:white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;

test('P4: refresh.css uses theme variables only for colours (no hex, rgb(), hsl() or named colours)', () => {
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, 'no hex colour');
  assert.doesNotMatch(body, /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i, 'no colour functions');
  // Every colour-carrying declaration takes its colour from a variable (or transparent / currentColor / inherit).
  const COLOR_PROPS = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-decoration-color|caret-color|accent-color|fill|stroke|column-rule-color)$/;
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    const [, prop, value] = m;
    if (!COLOR_PROPS.test(prop)) continue;
    assert.doesNotMatch(value, NAMED, `${prop}: ${value} names a colour`);
  }
  // The new tokens live in theme.css, not here.
  assert.doesNotMatch(body, /^\s*--p4-[\w-]+\s*:/m, 'no --p4- token is defined in refresh.css');
});

test('P4: the tokens are in theme.css (type, space, radius, elevation, border, ring, motion), Classic untouched', () => {
  const at = theme.indexOf('/* ---------- P4 visual refresh');
  assert.ok(at > 0, 'a P4 block in theme.css');
  assert.ok(at > theme.indexOf('--v4-strip-h'), 'appended after the V4 block (Classic and V1-V4 blocks unchanged)');
  const p4 = theme.slice(at);
  for (const k of ['fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'fs-xl', 'lh-tight', 'lh-body', 'sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5', 'sp-6', 'r-sm', 'r-md', 'r-lg', 'r-xl', 'elev-1', 'elev-2', 'elev-3', 'border', 'border-strong', 'ring', 'control-h', 'dur', 'ease']) {
    assert.match(p4, new RegExp(`--p4-${k}:`), `--p4-${k}`);
  }
  // High contrast keeps full-strength borders and no soft shadows; reduced motion zeroes the durations.
  assert.match(p4, /:root\[data-palette="contrast"\] \{[^}]*--p4-border: var\(--line\);/);
  assert.match(p4, /prefers-reduced-motion: reduce\)[\s\S]*?--p4-dur: 0ms;/);
  assert.match(p4, /:root\.reduce-motion \{[^}]*--p4-dur: 0ms;/);
  // Every var(--p4-*) refresh.css uses is defined.
  for (const m of css.matchAll(/var\(--p4-([\w-]+)/g)) assert.match(theme, new RegExp(`--p4-${m[1]}:`), `--p4-${m[1]} is defined`);
});

test('P4: refresh.css is linked once, after every page sheet and right before settings3.css (which stays last)', () => {
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)].map((m) => m[1]);
  assert.equal(links.filter((l) => l === 'refresh.css').length, 1);
  assert.equal(links.at(-1), 'settings3.css');
  assert.equal(links.at(-2), 'refresh.css');
});

/** Splits a selector list at top-level commas (not inside :is()/:not()/:where()). */
function splitTop(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur];
}

test('P4: every rule is scoped outside Sara Classic (Classic stays the 2.x look)', () => {
  const rules = body.replace(/@media[^{]*\{/g, '').replace(/@keyframes[\s\S]*?\}\s*\}/g, '');
  for (const m of rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
    const sel = m[2].trim();
    if (!sel) continue;
    for (const one of splitTop(sel)) {
      assert.ok(one.trim().startsWith(':where(:root:not([data-palette="classic"])'), `unscoped: ${one.trim()}`);
    }
  }
});

test('P4: motion is opt-out (reduced motion, the a11y switch, Motion: Off) and focus stays visible', () => {
  // Entrances only run when nothing asks for less motion.
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  for (const m of css.matchAll(/animation:\s*([\w-]+)/g)) {
    if (m[1] === 'none') continue;
    const before = css.slice(0, m.index);
    assert.ok(before.lastIndexOf('@media (prefers-reduced-motion: no-preference)') > before.lastIndexOf('}\n}'), `${m[1]} runs only under no-preference`);
  }
  assert.match(css, /:not\(\.reduce-motion\)/, 'the accessibility switch also stops entrances');
  // A visible focus ring on every control (the two-tone ring token), never removed.
  assert.match(css, /:focus-visible[^{]*\{[^}]*(outline: 2px solid var\(--focus\)|box-shadow: var\(--p4-ring\))/);
  assert.doesNotMatch(body, /outline:\s*(none|0)\b/);
});

test('P4: skeleton loading lines keep the words for screen readers (class only, same text)', () => {
  assert.match(css, /\.sk-line/);
  assert.match(css, /\.sk-line[^{]*\{[^}]*color: transparent/);
  let n = 0;
  for (const f of ['her-panel.js', 'market.js', 'mcp-catalog.js', 'my-apps.js', 'hooks.js', 'learned-skills.js', 'workspace-view.js', 'codemap.js', 'gifts.js']) {
    const src = web(f);
    assert.match(src, /sk-line', t\('Loading…'\)\)/, `${f}: a skeleton line with the Loading… words`);
    n++;
  }
  assert.equal(n, 9);
});
