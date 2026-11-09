// V4d (docs/ops/V4_DESIGN.md → V4d): every page in the 3.0 look. Today's hero uses her presence orb
// (her portrait stays where it was chosen), the cards, the places under More and Settings share one
// stylesheet scoped outside Sara Classic, and leaving Classic no longer carries its rose along.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const SCOPE = ':where(:root:not([data-palette="classic"]))';

/** A selector list split at its top-level commas. */
function splitSel(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  return [...out, cur.trim()].filter(Boolean);
}

/** Top-level rules of a stylesheet (selectors inside @media/@container/@supports flattened). */
function rules(css: string): { sel: string; body: string }[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out: { sel: string; body: string }[] = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/^[\s\S]*@(media|container|supports)[^{]*$/, '').trim();
    if (sel && !sel.startsWith('@')) out.push({ sel, body: m[2] });
  }
  return out;
}

test('V4e (replaces the V4d migration): a palette is a full preset; picking one resets the colour to its default', async () => {
  const a = await import(pathToFileURL(join(ROOT, 'web', 'accent.js')).href);
  const def = a.paletteDefaultAccent as (pal: string) => string;
  // Violet everywhere but Sara Classic, whose own rose is the stored value "rose" (Theme colour).
  for (const p of ['graphite', 'midnight', 'slate', 'nord', 'solarized', 'paper', 'ember', 'contrast']) assert.equal(def(p), 'violet', p);
  assert.equal(def('classic'), 'rose');
  // What a palette pick clears: the stored colour (a preset or Custom) and where it was picked. The
  // custom colour itself (sara.accentCustom) stays, so the colour field still offers it.
  assert.deepEqual(a.PALETTE_RESETS, ['sara.accent', 'sara.accentPicked']);
  assert.equal(a.accentOnPaletteChange, undefined, 'the V4d Classic-rose migration is folded into the reset');

  const app = read('web', 'app.js');
  // The default comes from the same function, before the first paint too (theme-boot.js mirrors it).
  assert.match(app, /const accentPick = \(pal = palettePick\(\)\) => localStorage\.getItem\('sara\.accent'\) \?\? paletteDefaultAccent\(pal\);/);
  // Wired into the palette change, before the look is applied; the person can then change the colour.
  assert.match(app, /localStorage\.setItem\('sara\.palette', to\);\s*(?:\/\/[^\n]*\s*)*for \(const k of PALETTE_RESETS\) localStorage\.removeItem\(k\);\s*applyAppearance\(\);\s*showAppearance\(\);/);
  // An explicit pick still remembers the palette it was made in; Reset to defaults clears it too.
  assert.match(app, /if \(k === 'accent'\) localStorage\.setItem\('sara\.accentPicked', palettePick\(\)\);/);
  assert.match(app, /const AP_KEYS = \[[^\]]*'sara\.accentPicked'/);
});

test('V4d: one stylesheet, linked once after the other V4 sheets, scoped outside Sara Classic', () => {
  const html = read('web', 'index.html');
  assert.equal((html.match(/href="\/v4-pages\.css"/g) ?? []).length, 1);
  assert.ok(html.indexOf('href="/v4-pages.css"') > html.indexOf('href="/v4-living.css"'), 'loads last');
  const css = read('web', 'v4-pages.css');
  const bad: string[] = [];
  for (const { sel } of rules(css)) {
    for (const s of splitSel(sel)) {
      // Scoped to the new look, or hiding a new element in Classic (Classic stays exactly as before).
      if (s.startsWith(SCOPE) || /^:where\(:root(\.[\w-]+)?:not\(\[data-palette="classic"\]\)/.test(s)) continue;
      if (s.startsWith(':root[data-palette="classic"]')) continue;
      if (/^\.td-orb\b/.test(s)) continue; // the new mount: hidden until the new look shows it
      bad.push(s);
    }
  }
  assert.deepEqual(bad, [], 'every rule is scoped outside Sara Classic');
  // Classic: only hides the new orb, nothing else.
  for (const { sel, body } of rules(css)) if (sel.startsWith(':root[data-palette="classic"]')) assert.match(body.trim(), /^display: none;?$/, sel);
  // No colours of its own: theme tokens only; the hue tokens never colour text, borders or outlines.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgb\(|rgba\(/i);
  for (const m of css.matchAll(/(?:^|[;{\s])(color|border-color|outline(?:-color)?):\s*([^;}]+)/g)) assert.doesNotMatch(m[2], /--acc-(h|s|l|glow|haze|second)\b/, m[0].trim());
  // Reduced motion and the Motion: Off setting stop what it animates.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-motion="off"\]/);
  // Focus rings stay visible on the restyled controls.
  assert.match(css, /:focus-visible/);
});

test('V4d Today: every card type is still on the page, rendered and restyled', () => {
  const html = read('web', 'index.html');
  const today = read('web', 'today.js');
  const css = read('web', 'v4-pages.css');
  const tiles = [...today.matchAll(/\{ id: '(td-[a-z]+)', section:/g)].map((m) => m[1]);
  assert.equal(tiles.length, 18, 'the 18 Today tiles');
  for (const id of tiles) {
    assert.match(html, new RegExp(`<section class="today-card td-tile[^"]*" id="${id}"`), `${id} is on the page`);
    assert.match(today, new RegExp(`draw\\('${id}', `), `${id} is drawn by renderToday`);
  }
  // The tile look covers every tile (one rule for .td-tile), the sections, the hero and the extras.
  for (const sel of ['#today .td-tile', '#today .td-sec-h', '.td-hero', '#td-ask', '.td-mood', '.td-wx-spark .spark-line', '.td-nowcard', '#today .today-start', '.td-away', '.td-custom', '.td-ask-any', '.td-toast']) assert.ok(css.includes(sel), `styled: ${sel}`);
  // The hero: her orb (live state) next to her portrait; the portrait setting still means something.
  assert.match(html, /<button id="td-face-btn"[^>]*><img id="td-face" class="td-face" src="\/sara-portrait\.jpg" alt=""><span class="v4-orb td-orb" data-orb-size="112"><\/span><\/button>/);
  for (const p of ['large', 'small', 'hidden']) assert.ok(css.includes(`[data-portrait="${p}"]`), `portrait ${p}`);
  assert.match(css, /\.v4-own-face/, 'her own picture stays the face, the orb a badge');
  // Nothing removed: Customise, Refresh, the away note, the toast and every setting stay.
  for (const id of ['td-ask', 'td-refresh', 'td-custom-open', 'td-custom', 'td-custom-reset', 'td-away-x', 'td-toast-undo', 'td-away-hours', 'td-coming-days', 'td-phone-open', 'td-rooms-on', 'td-needs-mail', 'td-usage-cost']) assert.ok(html.includes(`id="${id}"`), id);
});

test('V4d places: Planner, Library, Evals, every place under More and Settings get the V4 page look', async () => {
  const css = read('web', 'v4-pages.css');
  const nav = read('web', 'nav.js');
  const dests = JSON.parse(nav.match(/export const DESTS = (\[[^\]]*\])/)![1].replace(/'/g, '"')) as string[];
  const pages = dests.filter((d) => d !== 'today' && d !== 'addons');
  assert.ok(pages.length >= 9);
  const html = read('web', 'index.html');
  for (const p of pages) {
    assert.match(html, new RegExp(`<dialog id="${p}"`), `${p} is a page`);
    assert.ok(new RegExp(`#${p}\\b`).test(css), `${p} is styled`);
  }
  // Add-ons opens Settings; Settings is styled too.
  assert.ok(css.includes('#settings'));
  for (const part of ['.tabs', '.tab', 'h2', 'input', 'select', 'textarea', '.ghost', '.empty']) assert.ok(css.includes(part), part);
});
