// SETTINGS3 S1 (docs/design/SETTINGS3.md): the calm Settings look. Static checks on web/settings3.css
// (scoped outside Sara Classic, theme variables only), the save chip and the card grouping helper.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const css = web('settings3.css');
const html = web('index.html');

/** Every selector of every rule, @media blocks unwrapped. */
function selectors(src: string): string[] {
  const out: string[] = [];
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    let depth = 0;
    let cur = '';
    for (const ch of sel.replace(/^@media[^{]*\{/, '')) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

test('S1: every settings3.css rule is scoped outside Sara Classic and inside the Settings window', () => {
  const sels = selectors(css);
  assert.ok(sels.length > 60, `${sels.length} selectors`);
  for (const s of sels) assert.match(s, /^:root:not\(\[data-palette="classic"\]\) (dialog)?#settings\b/, s);
});

test('S1: theme variables only (no colour literals), the one control width is a theme token', () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  assert.match(web('theme.css'), /--s3-control-w: 232px;/);
  assert.match(css, /width: var\(--s3-control-w\)/);
});

test('S1: settings3.css loads last; the header has the save chip and "On this page"', () => {
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)].map((m) => m[1]);
  assert.equal(links.at(-1), 'settings3.css');
  assert.match(html, /<span id="settings-state" class="s3-chip" role="status"><span class="s3-chip-text">All changes saved<\/span><\/span>/);
  assert.match(html, /<nav id="settings-toc" class="s3-toc" aria-label="On this page" hidden><\/nav>/);
  // dialogs.js tells the chip about saves and failed saves.
  const dialogs = web('dialogs.js');
  assert.equal((dialogs.match(/new CustomEvent\('sara-saved'/g) ?? []).length, 2);
});

test('S1: cards open at the first child and at every top-level heading', async () => {
  const look = await import(pathToFileURL(join(ROOT, 'web', 'settings-look.js')).href);
  assert.deepEqual(look.cardStarts([{ tag: 'LABEL' }, { tag: 'P' }, { tag: 'H3' }, { tag: 'LABEL' }, { tag: 'H3' }]), [0, 2, 4]);
  assert.deepEqual(look.cardStarts([{ tag: 'H3' }, { tag: 'P' }]), [0]);
  assert.deepEqual(look.cardStarts([]), []);
  // cardify only wraps (no control leaves its page): it never touches a nested section.
  assert.match(web('settings-look.js'), /filter\(\(n\) => !n\.matches\('section, \.s3-card, \.s3-section-head'\)\)/);
});

test('S3: Advanced folds sit on real pages and start at a real control; Show me and search jumps open them', async () => {
  const look = await import(pathToFileURL(join(ROOT, 'web', 'settings-look.js')).href);
  const pages = Object.keys(look.ADVANCED);
  assert.ok(pages.length >= 11, `${pages.length} pages fold`);
  for (const [page, id] of Object.entries(look.ADVANCED) as [string, string][]) {
    const sec = new RegExp(`<section class="settings-page[^"]*" data-page="${page}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
    assert.ok(sec, `${page} is a page`);
    if (id) assert.ok(sec![1].includes(`id="${id}"`), `${page}: #${id} is on the page`);
  }
  // Closed by default, remembered per device (one key), never a global switch.
  const src = web('settings-look.js');
  assert.match(src, /fold\.open = advOpen\(\)\.has\(page\);/);
  assert.match(src, /const ADV_KEY = 'sara\.settingsAdvanced';/);
  assert.match(web('howto.js'), /for \(let d = hit\.closest\('details:not\(\[open\]\)'\); d; d = d\.parentElement\?\.closest\('details:not\(\[open\]\)'\)\) d\.open = true;/);
});
