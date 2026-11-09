// V1 design, the remaining items (docs/ops/V1_DESIGN.md §5): turn heads in the chat, the one model ·
// workspace header chip with its context meter, Settings as a full-height sheet with flat group
// headings, real tables for runs and usage, a Projects section in the sidebar, and the styling pass
// on add-ons/store, first-run and offline. Static checks plus the pure helpers; no browser here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'];
const i18n = (lang: string) => JSON.parse(web(`i18n/${lang}.json`));
const tr = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_m, k) => String(p[k]));

test('V2 chat turns: name, time and how long she took, from the message rows only', async () => {
  const m = await import(pathToFileURL(join(ROOT, 'web', 'turn-meta.js')).href);
  assert.equal(m.durationWords(4200, tr), '4 s');
  assert.equal(m.durationWords(61_000, tr), '1 min');
  assert.equal(m.durationWords(400, tr), '', 'instant replies say nothing');
  assert.equal(m.durationWords(NaN, tr), '');
  assert.equal(m.durationWords(5_000_000, tr), '', 'over an hour is not a duration');
  const rows = [
    { role: 'user', content: 'hi', createdAt: '2026-11-06 15:20:00' },
    { role: 'assistant', content: '', createdAt: '2026-11-06 15:20:03', meta: { toolCalls: [{}] } },
    { role: 'tool', content: 'x', createdAt: '2026-11-06 15:20:20' },
    { role: 'assistant', content: 'done', createdAt: '2026-11-06 15:21:01' },
    { role: 'notice', content: 'n', createdAt: '2026-11-06 15:21:02' },
    { role: 'assistant', content: 'from Mia', createdAt: '2026-11-06 15:21:03', meta: { speaker: { id: 'mia' } } },
  ];
  const before = JSON.stringify(rows);
  const heads = m.turnHeads(rows, { herName: 'Sara', youName: 'You' });
  assert.deepEqual([...heads.keys()], [0, 1], 'your message and the first part of her reply');
  assert.deepEqual(heads.get(0), { who: 'you', name: 'You', iso: '2026-11-06 15:20:00', ms: NaN });
  assert.equal(heads.get(1).ms, 3000);
  assert.equal(JSON.stringify(rows), before, 'the rows are never rewritten');
  // app.js puts the head into each turn as real text with a machine-readable time.
  const app = web('app.js');
  assert.match(app, /import \{ durationWords, turnHeads \} from '\.\/turn-meta\.js';/);
  assert.match(app, /function turnHead\(h\) \{[\s\S]*?el\('div', 'msg-head'\)[\s\S]*?document\.createElement\('time'\)[\s\S]*?setAttribute\('datetime'/);
  assert.match(app, /const heads = turnHeads\(messages, \{ herName: currentIdentity\(\)\.name \|\| t\('Sara'\), youName: t\('You'\) \}\);/);
  // Sara Classic keeps its bubbles without the head line; elsewhere the hover row drops its copy.
  const look = web('look.css');
  assert.match(look, /:root\[data-palette="classic"\] \.msg-head \{ display: none; \}/);
  assert.match(look, /:where\(:root:not\(\[data-palette="classic"\]\)\) \.msg-actions \.msg-meta \{ display: none; \}/);
  for (const l of LANGS) for (const k of ['{n} s', '{n} min', 'You']) assert.ok(i18n(l)[k], `${l}: ${k}`);
});

test('V2 header: one model · workspace chip, and the context ring as a small meter with its percentage', () => {
  const app = web('app.js');
  assert.match(app, /function setConvSummary\(full, chip\) \{\s*\$\('#conv-summary'\)\.replaceChildren\(el\('span', 'cs-full', full\), el\('span', 'cs-chip', chip \?\? full\)\);/);
  assert.match(app, /setConvSummary\(`\$\{c\.mode === 'coding' \? `\$\{t\('Coding'\)\} · ` : ''\}\$\{folder\}\$\{model \|\| label\}\$\{plan\}`, \[model \|\| label, isMember\(\) \? '' : ws\]\.filter\(Boolean\)\.join\(' · '\)\);/);
  assert.doesNotMatch(app, /\$\('#conv-summary'\)\.textContent =/, 'one place builds the chip');
  const look = web('look.css');
  const v2 = look.slice(look.indexOf('/* ---------- V2 '));
  assert.match(v2, /:root\[data-palette="classic"\] #conv-summary \.cs-chip \{ display: none; \}/, 'Sara Classic keeps the long summary');
  assert.match(v2, /:where\(:root:not\(\[data-palette="classic"\]\)\) #conv-summary \.cs-full \{ display: none; \}/);
  // The meter: 64 px, a bar and the percentage; the same button, ids and label (her panel keeps its ring).
  assert.match(v2, /:where\(:root:not\(\[data-palette="classic"\]\)\) #chat-head \.ctx-ring \{[^}]*width: 64px;/);
  assert.match(v2, /#chat-head \.ctx-ring \.ctx-dial \{[^}]*display: block;[^}]*linear-gradient\(90deg, var\(--ctx-fill\) calc\(var\(--ctx\) \* 1%\), var\(--surface-0\) 0\)/);
  assert.match(v2, /#chat-head \.ctx-ring\.full \{ --ctx-fill: var\(--danger\); \}/);
  assert.match(web('index.html'), /<button id="ctx-ring" class="ctx-ring" type="button" aria-label="How full this conversation is" aria-expanded="false" aria-controls="ctx-sheet" hidden><span class="ctx-dial" aria-hidden="true"><\/span><span id="ctx-pct" class="ctx-pct"><\/span><\/button>/);
});

test('V2 Settings: a full-height sheet on desktop with flat group headings (Classic and phones keep the accordion)', () => {
  const nav = web('settings-nav.js');
  // A caps heading per group next to the accordion button; CSS picks one, so keyboard and screen
  // readers only meet what is on screen.
  assert.match(nav, /const cap = el\('h3', 'settings-nav-cap', t\(g\)\);[\s\S]*?box\.append\(cap, head, items\);/);
  const css = web('screens.css');
  const v2 = css.slice(css.indexOf('/* ---------- V2 '));
  assert.ok(v2.length > 100, 'the V2 section');
  assert.match(v2, /@media \(min-width: 721px\) \{[\s\S]*?:where\(:root:not\(\[data-palette="classic"\]\)\) dialog\.settings-dialog \{[^}]*height: min\(1000px, calc\(100dvh - 48px\)\);[^}]*max-height: calc\(100dvh - 48px\);[^}]*margin: auto;[^}]*border-radius: 18px;/);
  assert.match(v2, /:where\(:root:not\(\[data-palette="classic"\]\)\) \.settings-nav \.settings-nav-head \{ display: none; \}/);
  assert.match(nav, /export const flatNav = \(\) => typeof matchMedia === 'function' && document\.documentElement\.dataset\.palette !== 'classic' && matchMedia\('\(min-width: 721px\)'\)\.matches;/);
  assert.match(nav, /export function setGroupOpen\(box, open, remember = true\) \{\s*if \(flatNav\(\)\) open = true;/, 'flat: every group stays open');
  assert.match(v2, /\.settings-nav-cap \{[^}]*text-transform: uppercase;[^}]*color: var\(--text-3\);/);
  assert.match(css, /^\.settings-nav-cap \{ display: none; \}/m, 'hidden by default (Classic, phones)');
});

test('V2 tables: usage and a run\'s model calls as real tables (scoped header cells, numbers right-aligned), jobs aligned', () => {
  const app = web('app.js');
  assert.match(app, /function usageTable\(list, first, rows\) \{[\s\S]*?el\('table', 'usage-table'\)[\s\S]*?th\.scope = 'col';[\s\S]*?who\.scope = 'row';[\s\S]*?if \(!table\.isConnected\) list\.after\(table\);/);
  for (const id of ['usage-companions', 'usage-models', 'usage-purposes']) assert.match(app, new RegExp(`usageTable\\(\\$\\('#${id}'\\)`), id);
  // The list text is unchanged (Sara Classic keeps it): the same words, now from two helpers.
  assert.match(app, /function usageWords\(x\) \{\s*if \(!x\?\.calls\) return t\('No model usage recorded yet\.'\);\s*const k = kTokens;\s*const cost = usageCost\(x\);/);
  const run = web('run-view.js');
  assert.match(run, /const table = el\('table', 'run-calls-table'\);[\s\S]*?body\.append\(section\(t\('Model calls'\), ul, table\)\);/);
  const css = web('screens.css');
  const v2 = css.slice(css.indexOf('/* ---------- V2 · tables'));
  assert.match(v2, /:root\[data-palette="classic"\] :is\(\.usage-table, \.run-calls-table\) \{ display: none; \}/);
  assert.match(v2, /\.num \{ text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; \}/);
  assert.match(v2, /\.jobs-strip \.job-row \{ display: grid;/);
  for (const l of LANGS) for (const k of ['Calls', 'Tokens in', 'Tokens out', 'Cost', 'Model', 'Provider', 'Time', 'For', 'Companion']) assert.ok(i18n(l)[k], `${l}: ${k}`);
});

test('V2 sidebar (V4d): one project list; the V2 Projects section was folded into the groups (test/v4d-sidebar.test.ts)', () => {
  const app = web('app.js');
  assert.doesNotMatch(app, /parts\.unshift\(projectsSection\(/, 'no second list of the same projects');
  for (const l of LANGS) for (const k of ['Projects']) assert.ok(i18n(l)[k], `${l}: ${k}`);
});

test('V2 styling pass: add-ons and the store (underline tabs, quiet notes), first run (no emoji tiles), offline (flat card)', () => {
  const store = web('store.css');
  const s = store.slice(store.indexOf('/* ---------- V2 '));
  // 3.0.3 (owner): the store's tabs became the V4 segmented control (test/store-buttons.test.ts).
  assert.match(s, /\.sto-seg button\[aria-selected="true"\] \{ border-color: var\(--acc-line\); background: var\(--accent-soft\);/);
  assert.match(s, /@media \(pointer: fine\) \{\s*:where\(:root:not\(\[data-palette="classic"\]\)\) \.sto-seg button \{ height: 30px; min-height: 0; \}/, 'touch keeps 44 px');
  assert.match(web('screens.css'), /:where\(:root:not\(\[data-palette="classic"\]\)\) \.skl-note \{ border-color: var\(--line\);/);
  const fr = web('first-run.css');
  const f = fr.slice(fr.indexOf('/* ---------- V2 '));
  assert.match(f, /:where\(:root:not\(\[data-palette="classic"\]\)\) #setup \.su-path-icon \{ display: none; \}/, 'no emoji tiles outside Classic');
  assert.match(f, /#setup \.su-path-card\[aria-checked="true"\]/);
  const off = web('offline.css');
  const o = off.slice(off.indexOf('/* ---------- V2 '));
  assert.match(o, /:where\(:root:not\(\[data-palette="classic"\]\)\) \.card \{[^}]*border-radius: var\(--r-4\);[^}]*background: var\(--surface-1\);[^}]*box-shadow: var\(--elev-2\);/);
  assert.match(o, /:where\(:root:not\(\[data-palette="classic"\]\)\) body \{ background: var\(--surface-0\); \}/, 'no page glow');
  // Every rule of these passes is scoped, so Sara Classic keeps its look.
  for (const part of [s, f, o]) for (const m of part.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
    const sel = m[1].trim();
    if (sel) assert.match(sel, /^:where\(:root:not\(\[data-palette="classic"\]\)\) /, sel);
  }
});
