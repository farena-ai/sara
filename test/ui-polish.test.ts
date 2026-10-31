// 2.8 polish pass (docs/design/NEW_LOOK.md → "Polish pass"): the aurora behind the glass, layered glass
// and one elevation scale, the display serif, her mood halo, one line-icon set instead of emoji in the
// chrome (web/icons.js), weather art, sparklines and progress rings (web/viz.js), the phone's floating
// bar, and motion that reduced motion switches off. Static checks on the files plus the pure helpers.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const polish = web('polish.css');
const theme = web('theme.css');
const EMOJI = /\p{Extended_Pictographic}/u;

const icons = async () => (await import(pathToFileURL(join(ROOT, 'web', 'icons.js')).href)) as { ICONS: Record<string, string>; TOOL_ICONS: Record<string, string> };
const viz = async () => (await import(pathToFileURL(join(ROOT, 'web', 'viz.js')).href)) as Record<string, (...a: unknown[]) => unknown>;

/** Every icon name the app asks for: data-icon in the markup and the names passed to the helpers. */
function usedIconNames(): Map<string, string> {
  const used = new Map<string, string>();
  for (const m of html.matchAll(/data-icon="([\w-]+)"/g)) used.set(m[1], 'index.html');
  const calls = [
    /\b(?:icon|lineIcon|stepIcon)\(\s*'([\w-]+)'/g, // icon('mic'), stepIcon('memory')
    /\b(?:setIcon|iconSpan|rowIcon)\([^,()]+,\s*'([\w-]+)'/g, // setIcon(btn, 'speaker')
    /\bshell\('[\w-]+',\s*'([\w-]+)'/g, // result cards
    /\bpair\([^;]*?,\s*'([\w-]+)'\)/g, // step words
  ];
  // Command bar actions, places and conversations (app.js, command-bar.js).
  const cmd = [/\badd\(\s*(?:'[\w-]+'|`[^`]*`),\s*'([\w-]+)'/g, /\bicon:\s*'([\w-]+)'/g];
  for (const f of readdirSync(join(ROOT, 'web')).filter((x) => x.endsWith('.js') && x !== 'sw.js')) {
    const src = web(f);
    for (const re of [...calls, ...(f === 'app.js' || f === 'command-bar.js' ? cmd : [])]) for (const m of src.matchAll(re)) used.set(m[1], f);
    // Ternaries inside those calls: icon(x ? 'a' : 'b'), shell('test', ok ? 'flask' : 'warn', …)
    for (const m of src.matchAll(/\b(?:icon|lineIcon|setIcon|shell|iconSpan|rowIcon)\([^;\n]*?\?\s*'([\w-]+)'\s*:\s*'([\w-]+)'/g)) {
      used.set(m[1], f);
      used.set(m[2], f);
    }
  }
  // Name maps (values are icon names).
  const app = web('app.js');
  for (const map of ['PLACE_ICON', 'TOOL_GROUP_ICON']) {
    const body = new RegExp(`const ${map} = \\{([^\\n]*)\\};`).exec(app)?.[1] ?? '';
    assert.ok(body, `${map} in app.js`);
    for (const m of body.matchAll(/:\s*'([\w-]+)'/g)) used.set(m[1], `app.js ${map}`);
  }
  const tile = /const TILE_ICON = \{([^\n]*)\};/.exec(web('today.js'))?.[1] ?? '';
  assert.ok(tile, 'TILE_ICON in today.js');
  for (const m of tile.matchAll(/:\s*'([\w-]+)'/g)) used.set(m[1], 'today.js TILE_ICON');
  for (const m of web('her-panel.js').matchAll(/\{ event: '([\w-]+)', reminder: '([\w-]+)', task: '([\w-]+)' \}/g)) for (const n of m.slice(1)) used.set(n, 'her-panel.js');
  return used;
}

test('icons.js: one line-icon set (24 grid, 1.75 px round strokes, currentColor) with every icon the app uses', async () => {
  const { ICONS, TOOL_ICONS } = await icons();
  const src = web('icons.js');
  assert.match(src, /setAttribute\('stroke-width', '1\.75'\)/);
  assert.match(src, /setAttribute\('stroke-linecap', 'round'\)/);
  assert.match(src, /setAttribute\('stroke', 'currentColor'\)/);
  assert.match(src, /setAttribute\('aria-hidden', 'true'\)/, 'decorative: the buttons keep their own labels');
  for (const [name, inner] of Object.entries(ICONS)) {
    assert.match(name, /^[a-z][a-z-]*$/, name);
    assert.doesNotMatch(inner, /fill="(?!none)|stroke="|style=|#[0-9a-f]{3}|<script|on\w+=/i, `${name}: shapes only, coloured by currentColor`);
    assert.match(inner, /^(<(path|circle|rect|line|polyline|ellipse)\b[^<>]*\/>)+$/, `${name}: simple shapes`);
  }
  const used = usedIconNames();
  assert.ok(used.size > 60, `found ${used.size} icon names; the scan lost some`);
  for (const [name, where] of used) assert.ok(name in ICONS, `${where} uses icon "${name}", which icons.js doesn't draw`);
  for (const [tool, name] of Object.entries(TOOL_ICONS)) assert.ok(name in ICONS, `TOOL_ICONS.${tool} → ${name}`);
  // Every placeholder is filled before the page is used, and no old inline chrome SVGs are left over.
  assert.match(web('app.js'), /^paintIcons\(document\);$/m);
  assert.doesNotMatch(html, /<svg\b/, 'the chrome icons come from icons.js');
});

test('no emoji left in the converted chrome (sidebar, header, composer, calls, bottom bar, command bar, steps, cards)', () => {
  const ids = ['companion-switch', 'close-sidebar', 'new-offrecord', 'new-group', 'toggle-sidebar', 'speak-toggle', 'server-btn', 'pl-badge', 'cmd-open', 'panel-toggle', 'ring-video', 'call-to-video', 'vc-minimize', 'vc-mute', 'vc-camera', 'vc-look', 'vc-sound', 'vc-cc', 'vc-end', 'pins-toggle', 'composer-plus', 'attach', 'attach-photo', 'together', 'call', 'video-call-btn', 'mic', 'send', 'td-back', 'cmd-close', 'review-now', 'side-more', 'open-help', 'open-settings', 'hp-close', 'bb-chat', 'bb-today', 'bb-planner', 'bb-more', 'open-today', 'open-planner', 'open-memory', 'open-library', 'open-scrapbook', 'open-moments', 'open-story', 'open-team', 'conv-settings-btn'];
  for (const id of ids) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, id);
    const start = html.lastIndexOf('<', at);
    const tag = /^<(\w+)/.exec(html.slice(start))![1];
    const end = html.indexOf(`</${tag}>`, at);
    const inner = html.slice(html.indexOf('>', at) + 1, end);
    assert.doesNotMatch(inner, EMOJI, `#${id} has an emoji in it`);
    assert.match(inner, /data-icon="[\w-]+"/, `#${id} draws a line icon`);
  }
  // Their names stay (icon-only buttons are named by aria-label or title).
  for (const id of ['toggle-sidebar', 'close-sidebar', 'cmd-close', 'composer-plus', 'send', 'vc-minimize']) assert.match(html, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`), id);
  for (const id of ['call', 'video-call-btn', 'mic', 'speak-toggle', 'companion-switch']) assert.match(html, new RegExp(`id="${id}"[^>]*title="[^"]+"`), id);
  // The JS that draws chrome: step lines, result cards, the command bar, her panel, Today's tiles.
  const strip = (s: string) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(strip(web('steps.js')), EMOJI, 'steps.js');
  assert.doesNotMatch(strip(web('command-bar.js')), EMOJI, 'command-bar.js');
  assert.doesNotMatch(strip(web('bottom-bar.js')), EMOJI, 'bottom-bar.js');
  assert.doesNotMatch(strip(web('nav.js')), EMOJI, 'nav.js');
  // result-cards.js only reads wttr.in's sky symbols (to name the weather), it never shows them.
  const cards = strip(web('result-cards.js')).replace(/const SKY = [^\n]*/, '').replace(/\/[^/\n]*\/u\.test/g, '');
  assert.doesNotMatch(cards, EMOJI, 'result-cards.js');
  const panel = strip(web('her-panel.js'));
  assert.doesNotMatch(panel, /'(📅|⏰|☐|🤝|🗒|🧠|⏳)'/u, 'her panel rows');
  const today = strip(web('today.js')).replace(/export function weatherKind[\s\S]*?\n\}/, '');
  assert.doesNotMatch(today, EMOJI, 'today.js (weatherKind keeps its symbols as data only)');
  const app = web('app.js');
  const cmd = app.slice(app.indexOf('initCommandBar({'), app.indexOf('\n});', app.indexOf('initCommandBar({')));
  assert.doesNotMatch(cmd, EMOJI, 'command bar entries in app.js');
  assert.doesNotMatch(app, /const TOOL_ICON = /, 'tool icons come from icons.js TOOL_ICONS');
  assert.doesNotMatch(app, /\$\('#speak-toggle'\)\.textContent =/, 'the speaker button keeps its icon');
  assert.doesNotMatch(web('dialogs.js'), /x\.textContent = '✕'/, 'the window close button is the close icon');
});

test('the aurora: one fixed layer, transform-only drift, paused when hidden, still with reduced motion, lighter in Day', () => {
  assert.match(html, /<body>\s*<!--[^>]*-->\s*<div id="aurora" class="aurora" aria-hidden="true"><i class="au-1"><\/i><i class="au-2"><\/i><i class="au-3"><\/i><i class="au-grain"><\/i><\/div>/);
  assert.match(html, /<link rel="stylesheet" href="\/screens.css">\s*<link rel="stylesheet" href="\/polish.css">/, 'polish.css loads last');
  assert.match(polish, /\.aurora \{[^}]*position: fixed;[^}]*z-index: -1;[^}]*pointer-events: none;[^}]*contain: strict;/);
  // Only transform moves (on the compositor): no filter, no layout or paint properties in the keyframes.
  const frames = [...polish.matchAll(/@keyframes (au-drift-\d) \{([^\n]*)\}/g)];
  assert.equal(frames.length, 3);
  for (const [, name, body] of frames) {
    const props = [...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
    assert.ok(props.length && props.every((p) => p === 'transform'), `${name}: transform only (${props})`);
  }
  for (const n of [1, 2, 3]) assert.match(polish, new RegExp(`\\.aurora > \\.au-${n} \\{[^}]*animation: au-drift-${n} calc\\((4[0-9]|5[0-9]|60)s \\* var\\(--aurora-speed\\)\\)`), `blob ${n}: 40-60 s`);
  assert.doesNotMatch(polish.slice(polish.indexOf('/* ---------- 1.'), polish.indexOf('/* ---------- 2.')), /filter:\s*blur/, 'no blur filters on the aurora');
  assert.match(polish, /html\.page-hidden \.aurora > i, html:has\(dialog:modal\) \.aurora > i \{ animation-play-state: paused; \}/);
  assert.match(web('app.js'), /document\.addEventListener\('visibilitychange', markHidden\);/);
  assert.match(web('app.js'), /classList\.toggle\('page-hidden', document\.visibilityState === 'hidden'\)/);
  assert.match(polish, /@media \(prefers-reduced-motion: reduce\) \{\s*\.aurora > i \{ animation: none !important; \}/);
  assert.match(polish, /@media \(prefers-reduced-transparency: reduce\) \{\s*\.aurora > \.au-1, \.aurora > \.au-2, \.aurora > \.au-3 \{ display: none; \}/);
  // The colours are tokens; Day's are lighter than Night's.
  const alpha = (block: string, k: string) => Number(new RegExp(`--${k}: rgb\\([^/]+/ ([.\\d]+)\\)`).exec(block)?.[1]);
  const night = theme.slice(theme.indexOf(':root,\n:root[data-theme="dark"] {\n  /* The aurora'), theme.indexOf(':root[data-theme="light"] {\n  --aurora-base'));
  const day = theme.slice(theme.indexOf(':root[data-theme="light"] {\n  --aurora-base'));
  for (const k of ['aurora-1', 'aurora-2', 'aurora-3']) assert.ok(alpha(day, k) < alpha(night, k), `${k}: lighter in Day`);
  // The page paint is on <html> only, so the layer behind shows through the app.
  assert.match(polish, /html \{ background: var\(--surface-0\); \}\nbody \{ background: transparent; \}/);
});

test('reduced motion switches the new motion off: halo, rings, tile entrances, lifts, the sliding indicator', () => {
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: \.001ms !important;[\s\S]*?transition-duration: \.001ms !important;/, 'the global switch in theme.css');
  const reduced = [...polish.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  for (const sel of ['.aurora > i', '.td-face-btn::after, .hp-glow::after, .head-face-btn::after', '.pring-moving > svg', '#today .td-tile, #today .today-start, .rcard, .hp-sec', '.bottom-bar::before']) assert.ok(reduced.includes(sel), `reduced motion covers ${sel}`);
  assert.match(reduced, /#today \.td-tile:hover, \.rcard:hover, \.td-ask-any:hover \{ transform: none; \}/);
  // Hover lifts only with a real pointer; pressed states only on touch.
  assert.match(polish, /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?#today \.td-tile:hover, \.rcard:hover, \.td-ask-any:hover \{ transform: translateY\(-2px\);/);
  assert.match(polish, /@media \(pointer: coarse\) \{\s*button:active:not\(:disabled\)/);
  // Entrances: 200 ms, eased out, 30 ms apart; fill backwards so a finished entrance leaves no transform behind.
  assert.match(polish, /#today \.td-tile, #today \.today-start \{ animation: polish-in var\(--dur\) var\(--ease-out\) backwards; \}/);
  assert.match(polish, /#today \.td-tile:nth-child\(2\) \{ animation-delay: 60ms; \}/);
});

test('glass, elevation and type: tokens in theme.css, the display serif is a system stack, no web fonts', () => {
  for (const k of ['--elev-1:', '--elev-2:', '--elev-3:', '--glass-edge:', '--glass-hi:', '--glass-fill:', '--font-display:', '--aurora-1:', '--grain:']) assert.ok(theme.includes(k), k);
  assert.match(theme, /--font-display: "New York", "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;/);
  for (const f of readdirSync(join(ROOT, 'web')).filter((x) => x.endsWith('.css'))) assert.doesNotMatch(web(f), /@import|@font-face|url\(["']?https?:/, `${f}: no outside fonts or files`);
  assert.match(polish, /#td-greeting \{\s*font-family: var\(--font-display\);/);
  assert.match(polish, /\.td-wx-temp, \.rc-temp \{\s*font-family: var\(--font-display\);[^}]*font-variant-numeric: lining-nums tabular-nums;/, 'big numbers in the serif, tabular');
  // The gradient edge is a masked ring, so the glass fill stays clear; Night and Day both define it.
  assert.match(polish, /mask: var\(--mask-solid\) content-box exclude, var\(--mask-solid\);/);
  const day = theme.slice(theme.indexOf(':root[data-theme="light"] {\n  --aurora-base'));
  for (const k of ['--glass-edge:', '--elev-1:', '--elev-3:', '--bbar-fill:', '--wx-cloud-a:']) assert.ok(day.includes(k), `Day ${k}`);
  // backdrop-filter stays on the few surfaces with moving text behind them; the phone keeps the cheap path.
  assert.match(polish, /@media \(max-width: 720px\) \{\s*dialog::backdrop \{ -webkit-backdrop-filter: none; backdrop-filter: none; \}/);
  assert.match(polish, /\.bottom-bar \{[^}]*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/);
  assert.match(theme, /@media \(prefers-reduced-transparency: reduce\) \{\s*:root \{ --glass-filter: none;/);
});

test('her halo: a ring in her mood colours on Today, her panel and the chat header; breathing / pulsing on the existing states', () => {
  assert.match(polish, /\.td-face-btn::after, \.hp-glow::after, \.head-face-btn::after \{[^}]*conic-gradient\(from 210deg, var\(--mood-a\), var\(--mood-b\)/);
  assert.match(polish, /html\.sara-busy \.td-face-btn::after, html\.sara-busy \.hp-glow::after, html\.sara-busy \.head-face-btn::after \{ animation: halo-turn 9s linear infinite, halo-breathe/);
  assert.match(polish, /html\.sara-speaking \.td-face-btn::after, html\.sara-speaking \.hp-glow::after, html\.sara-speaking \.head-face-btn::after \{ animation: halo-turn 6s linear infinite, halo-pulse/);
  for (const mood of ['happy', 'caring', 'playful', 'sleepy', 'hurt']) assert.ok(theme.includes(`.hp-glow[data-mood="${mood}"], .td-face-btn[data-mood="${mood}"], .head-face-btn[data-mood="${mood}"]`), mood);
  assert.match(web('her-panel.js'), /for \(const n of \[\$\('#her-face'\), \$\('#td-face-btn'\)\]\) n\?\.setAttribute\('data-mood', glow\.dataset\.mood\);/);
});

test('the phone bar floats: a glass pill above --safe-b with a glow that slides to the lit place; the drawer and windows clear it', () => {
  const phone = polish.slice(polish.indexOf('/* ---------- 8.'), polish.indexOf('/* ---------- 9.'));
  assert.match(phone, /:root \{ --bbar-h: calc\(76px \+ var\(--safe-b\)\); \}/, 'the room the drawer, windows and the sheet leave for it');
  assert.match(phone, /\.bottom-bar \{[^}]*margin: 0 12px calc\(10px \+ var\(--safe-b\)\);[^}]*border-radius: 26px;/);
  assert.match(phone, /\.bottom-bar::before \{[^}]*transform: translateX\(calc\(var\(--bb-i\) \* 100%\)\);[^}]*transition: transform 320ms/);
  assert.doesNotMatch(phone, /env\(safe-area-inset-(top|bottom)/, 'through --safe-b');
  assert.match(web('bottom-bar.js'), /bar\.style\.setProperty\('--bb-i', String\(Math\.max\(0, i\)\)\);/);
  // 76 px = 5 + 52 (the button) + 5 + 2 (the edge) + 10 below, and the bar keeps its own grid row.
  assert.match(web('today.css'), /#main \{ grid-template-rows: minmax\(0, 1fr\) auto; \}/);
});

test('viz.js: weather art from the codes, sparklines and rings from real numbers only', async () => {
  const v = await viz();
  assert.equal(v.artKind('clear', true), 'sun');
  assert.equal(v.artKind('clear', false), 'moon');
  assert.equal(v.artKind('partly', false), 'partly-night');
  assert.equal(v.artKind('thunder', true), 'storm');
  assert.equal(v.artKind('snow-showers', true), 'snow');
  assert.equal(v.artKind('unknown', true), 'cloud');
  assert.equal(v.kindFromSky('⛅', ''), 'partly');
  assert.equal(v.kindFromSky('', 'Light rain shower'), 'rain');
  assert.equal(v.kindFromSky('☀️', ''), 'clear');
  assert.equal(v.kindFromSky('', 'Mist'), 'fog');
  assert.equal(v.kindFromSky('', ''), 'unknown');
  assert.deepEqual(v.sparkPoints([null, 5]), [], 'one number is not a line');
  const pts = v.sparkPoints([50, 49, 48, 47], 100, 24) as number[][];
  assert.equal(pts.length, 4);
  assert.ok(pts[0][1] < pts[3][1], 'warmer is higher');
  assert.deepEqual((v.sparkPoints([5, null, 7], 100, 24) as number[][]).map((p) => p[0]), [3, 97], 'gaps are skipped, not invented');
  assert.equal(v.share(2, 0), null, 'nothing to count: no ring share');
  assert.equal(v.share(3, 4), 0.75);
  assert.equal(v.share(9, 4), 1);
  // A ring without a known share moves instead of showing a made-up percentage.
  assert.match(web('viz.js'), /arc\.setAttribute\('stroke-dasharray', known \? `\$\{\(value \* 100\)\.toFixed\(1\)\} 100` : '28 100'\);/);
  assert.match(web('today.js'), /w\.jobs\.map\(\(j\) => card\(j\.label, since\(j\.startedAt\), lastLine\(j\.tail\), j, null\)\)/, 'running jobs: a moving ring');
  assert.match(web('today.js'), /export function countDoneToday\(tasks, now = Date\.now\(\)\)/);
  (globalThis as Record<string, unknown>).matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const t = await import(`data:text/javascript;base64,${Buffer.from(web('today.js').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, "const t = (s) => s; const locale = () => 'en-US';").replace(/from '\.\/(icons|viz)\.js';/g, (_m, n: string) => `from '${pathToFileURL(join(ROOT, 'web', `${n}.js`)).href}';`)).toString('base64')}`);
  const now = Date.parse('2026-10-29T15:00:00');
  assert.equal(t.countDoneToday([{ status: 'done', doneAt: '2026-10-29T09:00:00' }, { status: 'done', doneAt: '2026-10-28T09:00:00' }, { status: 'open', doneAt: null }], now), 1);
  assert.equal(t.countDoneToday(null, now), null);
});

test('the offline cache was bumped for the new files (sw.js v8)', () => {
  assert.ok(Number(/sara-shell-v(\d+)/.exec(web('sw.js'))?.[1]) >= 8);
});

test('Import: a Sara character file (her own export, with pictures) is recognised before the 2 MB card limit', () => {
  const src = readFileSync(join(ROOT, 'web', 'cards.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function preview('), src.indexOf('async function isSaraFile('));
  const sara = fn.indexOf('isSaraFile(file)');
  const cap = fn.indexOf('file.size > (png ? MAX_PNG : MAX_JSON)');
  assert.ok(sara > 0 && cap > 0 && sara < cap, 'the Sara-file check comes before the card size limit');
  assert.match(src, /const MAX_SARA_FILE = 60 \* 1024 \* 1024;/);
  assert.match(readFileSync(join(ROOT, 'src', 'http.ts'), 'utf8'), /export const MAX_CHARACTER = 60 \* 1024 \* 1024;/);
});
