// V3 (docs/ops/V3_DESIGN.md): the navigation (sidebar rail, Settings home, breadcrumbs, the command
// bar), the refined Full decoration, the Appearance page and the owner's defaults. Static checks plus
// the pure helpers, and a tiny fake DOM where the order of nodes matters; no browser here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { cleanAppearance } from '../src/appearance.ts';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const v3 = web('v3.css');
const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'];
const i18n = (lang: string) => JSON.parse(web(`i18n/${lang}.json`));

/** A selector list split at its top-level commas (not the ones inside :is() / :where()). */
function splitTop(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  return [...out, cur.trim()].filter(Boolean);
}

test('V3 slice 1: the places lead the sidebar outside Sara Classic (DOM order = focus order), Classic keeps its order', () => {
  // The static page keeps the old order (Classic and the first paint), ids unchanged.
  const at = (s: string) => html.indexOf(s);
  assert.ok(at('<nav id="conversations">') < at('<nav id="side-nav"'), 'index.html keeps the Classic order');
  for (const id of ['open-today', 'open-planner', 'open-library', 'open-memory', 'open-settings', 'open-help', 'open-sara', 'side-more', 'open-addons', 'side-cmd', 'side-go-h']) assert.ok(html.includes(`id="${id}"`), id);
  const nav = web('nav.js');
  assert.match(nav, /export const DESTS = \[[^\]]*'addons'\]/, 'Add-ons is a place');
  assert.match(nav, /export const DEFAULT_PINS = \['today', 'planner', 'library', 'addons', 'moments'\]/);
  // placeRail moves the nodes (not CSS order) and puts everything back for Sara Classic.
  assert.match(nav, /export function placeRail\(on = document\.documentElement\.dataset\.palette !== 'classic'\)/);
  assert.match(nav, /if \(nav\.nextElementSibling !== convs\) convs\.before\(nav\);/);
  assert.match(nav, /if \(convs\.nextElementSibling !== nav\) convs\.after\(nav\);/);
  assert.match(web('app.js'), /placeRail\(pal !== 'classic'\);/, 'applied with the palette');
  assert.match(web('app.js'), /\$\('#open-addons'\)\.addEventListener\('click', \(\) => \{\n  closeSidebar\(\);\n  void openSettings\('ab-store'\);/);
  // The new rules never reach Sara Classic: every selector is scoped or a hidden-by-default new element.
  for (const rule of v3.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
    const sel = rule[1].trim();
    if (!sel || /^(from|to|\d+%)/.test(sel)) continue;
    for (const one of splitTop(sel)) assert.ok(one.startsWith(':where(:root:not([data-palette="classic"])') || /^\.(side-go-h|side-cmd|settings-crumbs|settings-nav-home|settings-home|ap-seg|ap-swatch-custom|ap-group-h)\b/.test(one) || /^#(settings-home|ap-preview|ap-reset)\b/.test(one) || /^html\[data-decor="off"\]|^:where\(:root\[data-palette="contrast"\]\)/.test(one), `unscoped: ${one}`);
  }
  assert.ok(html.indexOf('href="/v3.css"') > html.indexOf('href="/recall.css"'), 'v3.css loads last');
  for (const lang of LANGS) for (const k of ['Go to', 'Jump to anything', 'Jump to any page, setting, chat or project (Ctrl+K)', 'Add-ons: the store, skills, plugins and tools']) assert.ok(i18n(lang)[k], `${lang}: ${k}`);
});

/** Every Settings page in index.html: id, group, title. */
const PAGES = [...html.matchAll(/<section class="settings-page[^"]*" data-page="([\w-]+)" data-group="([^"]+)" data-title="([^"]+)"/g)].map((m) => ({ id: m[1], group: m[2].replace(/&amp;/g, '&'), title: m[3].replace(/&amp;/g, '&') }));

test('V3 slice 2: Settings home lists every page under its group (1 click), with breadcrumbs back (<= 2 clicks)', async () => {
  assert.ok(PAGES.length >= 60, `${PAGES.length} pages`);
  const nav = await import(pathToFileURL(join(ROOT, 'web', 'settings-home.js')).href);
  // Every group has a one-line purpose and an icon; the home model lists every page exactly once.
  for (const g of new Set(PAGES.map((p) => p.group))) assert.ok(nav.SETTINGS_GROUP_INFO.find((x: { name: string; desc: string }) => x.name === g)?.desc, `${g}: purpose line`);
  const model = nav.homeModel(PAGES.map((p) => ({ dataset: { page: p.id, group: p.group, title: p.title } })));
  const listed = model.flatMap((g: { pages: { dataset: { page: string } }[] }) => g.pages.map((p) => p.dataset.page));
  assert.deepEqual([...listed].sort(), PAGES.map((p) => p.id).sort(), 'every page once');
  assert.deepEqual(model.map((g: { group: string }) => g.group), ['Her', 'You', 'Models', 'Chat apps', 'Add-ons', 'Coding', 'Connections', 'Data & health', 'Household']);
  // Crumbs: Settings › group › page; Settings and the group are buttons back to the home.
  assert.deepEqual(nav.crumbsFor({ dataset: { page: 'you-appearance', group: 'You', title: 'Appearance' } }), [{ label: 'Settings', to: 'home' }, { label: 'You', to: 'home:You' }, { label: 'Appearance', to: '' }]);
  assert.match(html, /<nav id="settings-crumbs" class="settings-crumbs" aria-label="Breadcrumb"><\/nav>\s*<h2 id="settings-page-title" tabindex="-1"><\/h2>/);
  assert.match(html, /<section id="settings-home" class="settings-home" aria-labelledby="settings-page-title" hidden><\/section>/);
  const app = web('app.js');
  // Opening Settings without a page shows the home outside Sara Classic; Classic opens the last page, as before.
  assert.match(app, /const SETTINGS_START = \(\) => \(document\.documentElement\.dataset\.palette === 'classic' \? \(localStorage\.getItem\('sara\.settingsPage'\) \?\? 'her-character'\) : 'home'\);/);
  assert.match(app, /if \(page === 'home' \|\| page\?\.startsWith\('home:'\)\) return void showSettingsHome\(page\.slice\(5\), opts\);/);
  // The home is not a settings page: never searched, never counted.
  assert.doesNotMatch(html, /class="settings-page[^"]*" data-page="home"/);
  for (const lang of LANGS) for (const g of nav.SETTINGS_GROUP_INFO) assert.ok(i18n(lang)[g.desc], `${lang}: ${g.desc}`);
  for (const lang of LANGS) for (const k of ['All settings', 'Breadcrumb', 'Every page, by topic. Search finds any setting by its name, its tip or a word you would use.']) assert.ok(i18n(lang)[k], `${lang}: ${k}`);
});

test('V3 slice 2: Find a setting finds every page by its own name first, and by the new synonyms', async () => {
  const s = await import(pathToFileURL(join(ROOT, 'web', 'settings-search.js')).href);
  const rec = (p: { id: string; group: string; title: string }) => ({ p, id: p.id, title: s.foldText(p.title), group: s.foldText(p.group), keywords: (s.SETTINGS_KEYWORDS[p.id] ?? []).map(s.foldText), questions: [], head: '', body: '' });
  const recs = PAGES.map(rec);
  const miss = PAGES.filter((p) => s.rankPages(p.title, recs)[0]?.id !== p.id).map((p) => `${p.title} → ${s.rankPages(p.title, recs)[0]?.id}`);
  assert.deepEqual(miss, []);
  for (const [q, id] of [['add-on store', 'ab-store'], ['marketplace', 'ab-store'], ['projects', 'ab-projects'], ['documents', 'ab-library'], ['desktop app', 'desktop-app'], ['dark mode', 'you-appearance'], ['glass', 'you-appearance'], ['sessions shown', 'you-appearance']]) assert.equal(s.rankPages(q, recs)[0]?.id, id, q);
});

test('V3 slice 3: Ctrl+K is the universal launcher: pages, every Settings page, projects, chats and the new actions', () => {
  const bar = web('command-bar.js');
  assert.match(bar, /projects: \(c\.projects\?\.\(\) \?\? \[\]\)\.map\(\(x\) => \(\{ \.\.\.x, group: 'projects' \}\)\)/);
  assert.match(bar, /projects: t\('Projects'\)/);
  assert.match(bar, /\['projects', pick\(all\.projects, q\)\]/, 'projects are searched');
  const app = web('app.js');
  // Every Settings page is in the bar (the same list as the Settings nav), and every project.
  assert.match(app, /settings: \(\) => settingsPages\(\)\.map\(\(p\) => \(\{ key: `settings:\$\{p\.dataset\.page\}`/);
  assert.match(app, /projects: \(\) => \(state\.projects \?\? \[\]\)\.filter\(\(p\) => !p\.builtin && !p\.hidden\)/);
  for (const k of ["add('reset-look', 'undo', t('Reset the look to the defaults')", "add('settings-home', 'settings', t('All settings')", "add('appearance', 'sliders', t('Appearance')", "add('find-setting', 'search', t('Find a setting')"]) assert.ok(app.includes(k), k);
  for (const lang of LANGS) for (const k of ['Find a setting', 'Project', 'settings home index every page', 'theme palette colour dark light look']) assert.ok(i18n(lang)[k], `${lang}: ${k}`);
});

const theme = web('theme.css');
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h: string) => {
  const [r, g, b] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** a over b at weight w (0..1), as #rrggbb. */
const mix = (a: string, b: string, w: number) => '#' + hex(a).map((x, i) => Math.round((x * w + hex(b)[i] * (1 - w)) * 255).toString(16).padStart(2, '0')).join('');
function block(selector: string): Record<string, string> {
  const at = theme.indexOf(selector);
  assert.ok(at >= 0, selector);
  const body = theme.slice(theme.indexOf('{', at), theme.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const PALS = ['graphite', 'midnight', 'slate', 'nord', 'solarized', 'paper', 'ember'];

test('V3 slice 4: Full decoration outside Classic is refined: solid accent, glass only on chrome, faint light, no halo; fallbacks', () => {
  const full = block(':root:not([data-palette="classic"])[data-decor="on"] {');
  assert.equal(full['accent-grad'], 'linear-gradient(var(--accent-solid), var(--accent-solid))', 'no gradients');
  assert.equal(full['violet-glow'], 'transparent');
  assert.equal(full['aurora-3'], 'transparent');
  assert.equal(full['grain-opacity'], '0');
  assert.ok(Number(full['v3-light'].replace('%', '')) <= 10, 'the light stays faint');
  assert.ok(Number(block(':root:not([data-palette="classic"])[data-decor="on"][data-theme="light"] {')['v3-light'].replace('%', '')) <= 6);
  const hc = block(':root[data-palette="contrast"][data-decor="on"] {');
  assert.equal(hc['glass-filter'], 'none', 'High contrast stays solid');
  // Halo and sparkles off, glass only on the listed chrome, and solid fallbacks.
  assert.match(v3, /:is\(\.td-face-btn, \.hp-glow, \.head-face-btn\)::after,\n[^{]*\{ display: none; \}/);
  assert.match(v3, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(v3, /@media \(prefers-reduced-transparency: reduce\), \(forced-colors: active\)/);
  assert.match(v3, /@media \(prefers-reduced-motion: reduce\) \{[^@]*transition: none;/);
  // Micro-interactions stay under 150 ms.
  for (const m of v3.matchAll(/(\d+)ms/g)) assert.ok(Number(m[1]) <= 150, `${m[1]}ms`);
  // Sara Classic: the part of theme.css above V1 is unchanged (the V1 hash test) and V3 is appended after V1.
  assert.ok(theme.indexOf('/* ---------- V3 Full decoration') > theme.indexOf('/* ---------- V1'));
});

test('V3 contrast: text on every glass surface over the brightest point of the light stays at AA (every palette, both modes)', () => {
  const rows: string[] = [];
  for (const mode of ['dark', 'light']) {
    const full = { ...block(':root:not([data-palette="classic"])[data-decor="on"] {'), ...(mode === 'light' ? block(':root:not([data-palette="classic"])[data-decor="on"][data-theme="light"] {') : {}) };
    const pct = (k: string) => Number(full[k].replace('%', '')) / 100;
    for (const p of PALS) {
      const t = block(`:root[data-palette="${p}"][data-theme="${mode}"] {`);
      // Worst case behind the glass: the page with the accent light at full strength (au-1's centre).
      const behind = mix(t['accent-solid'], t['surface-0'], pct('v3-light'));
      for (const g of ['v3-glass', 'v3-glass-strong']) {
        const glass = mix(t['surface-1'], behind, pct(g));
        for (const k of ['text-1', 'text-2', 'text-3', 'accent-text']) {
          const c = contrast(t[k], glass);
          if (c < 4.5) rows.push(`${p} ${mode} ${k} on ${g}: ${c.toFixed(2)}`);
        }
      }
      // The reading surface (solid page) under the light, too.
      for (const k of ['text-1', 'text-2', 'text-3']) if (contrast(t[k], behind) < 4.5) rows.push(`${p} ${mode} ${k} on the lit page`);
    }
  }
  assert.deepEqual(rows, [], rows.join('\n'));
});

/** web/theme-boot.js against a fake page: stored values and which media queries match. */
function boot(store: Record<string, string>, media: Record<string, boolean> = {}) {
  const attrs: Record<string, string> = {};
  const root = { setAttribute: (k: string, v: string) => (attrs[k] = v), classList: { add: () => {}, contains: () => false }, style: { setProperty: () => {} } };
  const mm = (q: string) => ({ matches: Object.entries(media).some(([k, v]) => v && q.includes(k)) });
  runInNewContext(web('theme-boot.js'), { window: { matchMedia: mm }, document: { documentElement: root }, localStorage: { getItem: (k: string) => store[k] ?? null }, matchMedia: mm, location: { search: '' } });
  return attrs;
}

test('V3 defaults (owner image): Graphite, Follow the system, Blue, Full, small picture, Comfortable; picked values and Sara Classic keep theirs', () => {
  const pick = (a: Record<string, string>) => [a['data-palette'], a['data-theme'], a['data-accent'], a['data-decor'], a['data-portrait'], a['data-density']];
  assert.deepEqual(pick(boot({})), ['graphite', 'dark', 'blue', 'on', 'small', 'comfy'], 'a dark system');
  assert.deepEqual(pick(boot({}, { 'color-scheme: light': true })), ['graphite', 'light', 'blue', 'on', 'small', 'comfy'], 'follows a light system');
  // Explicit choices win, every one of them.
  assert.deepEqual(pick(boot({ 'sara.theme': 'dark', 'sara.accent': 'rose', 'sara.decor': 'off', 'sara.portrait': 'large', 'sara.density': 'compact' }, { 'color-scheme: light': true })), ['graphite', 'dark', 'rose', 'off', 'large', 'compact']);
  // Sara Classic keeps exactly its earlier defaults: Night, its rose, decoration on, the large picture.
  assert.deepEqual(pick(boot({ 'sara.palette': 'classic' }, { 'color-scheme: light': true })), ['classic', 'dark', 'rose', 'on', 'large', 'comfy']);
  // The system can still force decoration off; the Windows/Mac app's own theme still counts when nothing was picked.
  assert.equal(boot({}, { 'reduced-transparency': true })['data-decor'], 'off');
  const app = web('app.js');
  assert.match(app, /const themePick = \(pal = palettePick\(\)\) => \{\s*const v = localStorage\.getItem\('sara\.theme'\);\s*return v === 'light' \|\| v === 'system' \|\| v === 'dark' \? v : pal === 'classic' \? 'dark' : 'system';/);
  assert.match(app, /const accentPick = \(pal = palettePick\(\)\) => localStorage\.getItem\('sara\.accent'\) \?\? \(pal === 'classic' \? 'rose' : 'blue'\);/);
  assert.match(app, /return v === 'on' \|\| v === 'off' \? v : 'on';/, 'Full by default');
  // Text size Normal (15), replies as they arrive, 5 sessions shown.
  assert.match(app, /localStorage\.getItem\('sara\.textSize'\) \?\? '15'/);
  assert.match(app, /localStorage\.getItem\('sara\.typing'\) \?\? 'instant'/);
  assert.match(web('session-list.js'), /return PAGE_SIZES\.includes\(n\) \? n : 5;/);
  // The list says which choice is the default.
  assert.match(html, /<option value="system">Follow the system \(default\)<\/option>/);
  assert.match(html, /<option value="blue">Blue \(default\)<\/option>/);
  assert.match(html, /<option value="on">Full: glow, glass and moving light \(default\)<\/option>/);
  assert.match(html, /<option value="5" data-raw>5 \(the default\)<\/option>|<option value="5">5 \(the default\)<\/option>/);
  // The server: a synced look falls back to the same defaults.
  assert.deepEqual(cleanAppearance({}), { palette: 'graphite', theme: 'system', accent: 'blue', density: 'comfy', portrait: 'small' });
  // The one-time Switch back to Sara Classic notice is unchanged.
  assert.match(app, /if \(localStorage\.getItem\('sara\.palette'\) \|\| localStorage\.getItem\('sara\.v1Notice'\)\) return;/);
});

test('V3 slice 5: Appearance in three groups with a live preview, swatches in the Colour row, segments, Reset to defaults; same ids', () => {
  const page = /data-page="you-appearance"[\s\S]*?<p class="small ap-sync-row">/.exec(html)![0];
  const order = ['ap-g-theme', 'ap-palette', 'ap-pals', 'ap-theme', 'ap-accent', 'ap-swatches', 'ap-decor', 'ap-g-layout', 'ap-density', 'ap-size', 'ap-portrait', 'ap-g-chat', 'ap-typing', 'ap-sessions', 'ap-chatbg', 'ap-preview'];
  const at = order.map((id) => page.indexOf(`id="${id}"`));
  assert.ok(at.every((x) => x > 0), order.filter((_, i) => at[i] < 0).join(', '));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'Theme / Layout and text / Chat behaviour, then the preview');
  assert.match(page, /<div class="ap-colour-row">\n\s*<label>Colour\n\s*<select id="ap-accent">[\s\S]*?<\/select>\n\s*<\/label>\n\s*<div class="ap-swatches" id="ap-swatches" aria-hidden="true"><\/div>/, 'the swatches sit in the Colour row (outside its label, so the list keeps a clean name)');
  assert.doesNotMatch(page, /<section/, 'no nested sections (the page is one section)');
  assert.match(page, /<button id="ap-reset" type="button" class="ghost small">Reset to defaults<\/button>/);
  const app = web('app.js');
  assert.match(app, /apSegSync = \['ap-theme', 'ap-motion', 'ap-decor', 'ap-density', 'ap-size', 'ap-portrait', 'ap-sessions'\]\.map\(apSegment\);/);
  // A segment drives its list (same value, same change event), so saving, tips and tests are unchanged.
  assert.match(app, /sel\.value = o\.value;\n\s*sel\.dispatchEvent\(new Event\('change'\)\);/);
  // Reset forgets exactly the look's keys on this device, never the notice.
  assert.match(app, /const AP_KEYS = \['sara\.palette', 'sara\.theme', 'sara\.accent', 'sara\.accentCustom', 'sara\.decor', 'sara\.portrait', 'sara\.density', 'sara\.chatbg', 'sara\.textSize', 'sara\.typing', PAGE_KEY\];/);
  assert.match(app, /if \(!confirm\(t\('Reset how Sara looks on this device to the defaults\?'\)\)\) return;/);
  // Sara Classic keeps the plain list: the new pieces are hidden there by default.
  assert.match(v3, /#ap-preview, \.ap-seg, #ap-reset, \.ap-swatch-custom, \.ap-group-h \{ display: none; \}/);
  for (const lang of LANGS) for (const k of ['Theme', 'Layout and text', 'Chat behaviour', 'Reset to defaults', 'Preview', 'Reset how Sara looks on this device to the defaults?']) assert.ok(i18n(lang)[k], `${lang}: ${k}`);
});
