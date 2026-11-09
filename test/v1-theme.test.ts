// V1 (docs/ops/V1_DESIGN.md): the professional look and the theme system. Static checks on the
// palettes (every token, every text/accent pair at WCAG AA), the no-flash boot attributes, the custom
// accent maths, the Appearance page, and the two bugs the design audit found. No browser here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { cleanAppearance } from '../src/appearance.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const SHEETS = [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)].map((m) => m[1]);
const FOLD = '/* ---------- V1 new look (docs/ops/V1_DESIGN.md §5), folded from the former pro.css';
/** Slice 7: the new-look rules, folded into the end of each screen's own sheet, in load order. */
const newLook = () => SHEETS.map((f) => { const css = web(f); const at = css.indexOf(FOLD); const end = css.indexOf('/* ---------- V2 ', at); return at < 0 ? '' : css.slice(at, end < 0 ? undefined : end); }).join('\n');
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
/** The custom properties of the block whose selector list contains `selector`. */
function vars(selector: string): Record<string, string> {
  const at = theme.indexOf(selector);
  assert.ok(at >= 0, selector);
  const open = theme.indexOf('{', at);
  const body = theme.slice(open, theme.indexOf('}', open));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
export const PALETTES = ['graphite', 'midnight', 'slate', 'nord', 'solarized', 'paper', 'ember', 'contrast'];
const PRESETS = ['blue', 'cyan', 'green', 'amber', 'red', 'pink', 'violet', 'grey', 'emerald'];
const COLOUR_TOKENS = ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'line', 'text-1', 'text-2', 'text-3', 'accent-solid', 'accent-text', 'on-accent', 'success', 'warn', 'danger', 'info', 'danger-fill', 'update-accent', 'btn-off-fill', 'btn-off-text', 'btn-off-line'];
const palette = (p: string, mode: string) => vars(`:root[data-palette="${p}"][data-theme="${mode}"] {`);

test('V1 tokens: 8 palettes x Night/Day, each block sets every colour token (specificity 0,3,0 over Classic)', () => {
  for (const p of PALETTES) for (const mode of ['dark', 'light']) {
    const t = palette(p, mode);
    for (const k of COLOUR_TOKENS) assert.match(t[k] ?? '', /^#[0-9a-f]{6}$/, `${p} ${mode}: --${k}`);
  }
  // The shared new-look tokens: shapes, sizes, type, focus; Classic keeps its own (r-card 14 etc.).
  const shared = vars(':root:not([data-palette="classic"]) {');
  for (const [k, v] of [['r-card', '8px'], ['r-control', '6px'], ['r-pill', '6px'], ['focus', 'var(--accent-text)'], ['btn-fill', 'var(--accent-solid)'], ['on-btn', 'var(--on-accent)']]) assert.equal(shared[k], v, k);
  assert.match(shared['font-ui'], /var\(--font-ui-v1\)/);
  const base = vars(':root {\n  /* V1 sizes');
  for (const [k, v] of [['r-1', '4px'], ['r-2', '6px'], ['r-3', '8px'], ['r-4', '12px'], ['h-control', '34px'], ['h-row', '34px'], ['pad-card', '16px']]) assert.equal(base[k], v, k);
  assert.match(base['font-ui-v1'], /^"Segoe UI Variable Text", "Segoe UI Variable", "SF Pro Text", -apple-system/);
  assert.match(base['font-mono-v1'], /^"JetBrains Mono", "Cascadia Code", "SF Mono"/);
  const compact = vars(':root[data-density="compact"] {');
  assert.deepEqual([compact['h-control'], compact['h-row'], compact['pad-card']], ['28px', '28px', '12px']);
  assert.match(theme, /@media \(pointer: coarse\) \{\s*:root, :root\[data-density="compact"\] \{ --h-control: 44px; --h-row: 44px; \}/, 'touch targets stay 44 px');
});

test('V1 contrast: every palette text/accent/state pair at WCAG AA, and every accent preset on every palette', () => {
  const rows: string[] = [];
  for (const p of PALETTES) for (const mode of ['dark', 'light']) {
    const t = palette(p, mode);
    const page = ['surface-0', 'surface-1', 'surface-2'];
    for (const s of page) {
      for (const k of ['text-1', 'text-2', 'text-3', 'accent-text', 'success', 'warn', 'danger', 'info']) {
        const c = contrast(t[k], t[s]);
        if (c < 4.5) rows.push(`${p} ${mode} ${k} on ${s}: ${c.toFixed(2)}`);
      }
    }
    if (contrast(t['text-2'], t['surface-3']) < 4.5) rows.push(`${p} ${mode} text-2 on surface-3`);
    if (contrast(t['accent-solid'], t['surface-0']) < 3) rows.push(`${p} ${mode} accent fill on the page`);
    if (contrast(t['on-accent'], t['accent-solid']) < 4.5) rows.push(`${p} ${mode} on-accent`);
    if (contrast(t['btn-off-text'], t['btn-off-fill']) < 4.5) rows.push(`${p} ${mode} disabled text`);
    for (const a of PRESETS) {
      const sel = a === 'amber' ? `:root:not([data-palette="classic"])[data-accent="amber"][data-theme="${mode}"]` : `:root[data-palette][data-accent="${a}"][data-theme="${mode}"]`;
      const x = vars(sel);
      for (const s of page) if (contrast(x['accent-text'], t[s]) < 4.5) rows.push(`${p} ${mode} preset ${a} text on ${s}`);
      if (contrast(x['accent-solid'], t['surface-0']) < 3) rows.push(`${p} ${mode} preset ${a} fill`);
      if (contrast(x['on-accent'], x['accent-solid']) < 4.5) rows.push(`${p} ${mode} preset ${a} on-accent`);
    }
  }
  // V2 surfaces: text on the soft accent tint (selected cards: 16% of the fill over surface-1), and
  // the context meter's fills against its surface-0 track (non-text, WCAG 1.4.11: 3:1).
  const mix = (a: string, b: string, w: number) => '#' + hex(a).map((x, i) => Math.round((x * w + hex(b)[i] * (1 - w)) * 255).toString(16).padStart(2, '0')).join('');
  for (const p of PALETTES) for (const mode of ['dark', 'light']) {
    const t = palette(p, mode);
    const soft = mix(t['accent-solid'], t['surface-1'], 0.16);
    for (const k of ['text-1', 'text-2']) if (contrast(t[k], soft) < 4.5) rows.push(`${p} ${mode} ${k} on accent-soft: ${contrast(t[k], soft).toFixed(2)}`);
    for (const k of ['accent-solid', 'warn', 'danger']) if (contrast(t[k], t['surface-0']) < 3) rows.push(`${p} ${mode} meter ${k} on its track: ${contrast(t[k], t['surface-0']).toFixed(2)}`);
  }
  assert.deepEqual(rows, [], rows.join('\n'));
  // High contrast is really high: body text at 15:1 or more, meta text 10:1.
  for (const mode of ['dark', 'light']) {
    const t = palette('contrast', mode);
    assert.ok(contrast(t['text-1'], t['surface-0']) >= 15 && contrast(t['text-3'], t['surface-0']) >= 10, mode);
  }
});

test('V1 Sara Classic is untouched: the Classic part of theme.css is byte-identical, the old accent names keep their rules', () => {
  const classic = theme.slice(0, theme.indexOf('/* ---------- V1'));
  assert.equal(createHash('sha256').update(classic).digest('hex').slice(0, 16), CLASSIC_HASH, 'theme.css above the V1 section changed');
  // Old stored names keep meaning in Classic and map onto presets elsewhere; Classic's Amber stays its own.
  for (const [old, now] of [['lavender', 'violet'], ['ocean', 'cyan'], ['forest', 'green'], ['mono', 'grey']]) {
    assert.ok(theme.includes(`:root[data-palette][data-accent="${now}"][data-theme="dark"],\n:root:not([data-palette="classic"])[data-accent="${old}"][data-theme="dark"] {`), old);
  }
  assert.doesNotMatch(theme, /:root\[data-palette\]\[data-accent="amber"\]/);
});
const CLASSIC_HASH = '3998104a54689cac';

test('V1 bug: a Settings page title gets no focus box when the page opens (programmatic focus on headings)', () => {
  // The title is focused for screen readers (tabindex="-1"); that focus must not draw a ring.
  assert.match(html, /<h2 id="settings-page-title" tabindex="-1"><\/h2>/);
  assert.match(web('app.js'), /if \(opts\.focus\) \$\('#settings-page-title'\)\.focus\(\{ preventScroll: true \}\);/);
  assert.match(web('screens.css'), /:is\(h1, h2, h3, h4\)\[tabindex="-1"\]:focus, :is\(h1, h2, h3, h4\)\[tabindex="-1"\]:focus-visible \{ outline: none; \}/);
});

/** Runs web/theme-boot.js against a fake page with the given stored values and media queries. */
function boot(store: Record<string, string>, media: Record<string, boolean> = {}) {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  const root = { setAttribute: (k: string, v: string) => (attrs[k] = v), classList: { add: () => {}, contains: () => false }, style: { setProperty: (k: string, v: string) => (props[k] = v) } };
  const mm = (q: string) => ({ matches: Object.entries(media).some(([k, v]) => v && q.includes(k)) });
  runInNewContext(web('theme-boot.js'), { window: { matchMedia: mm }, document: { documentElement: root }, localStorage: { getItem: (k: string) => store[k] ?? null }, matchMedia: mm, location: { search: '' } });
  return { attrs, props };
}

test('V1 boot: Graphite by default (and for unknown names), V3 defaults (Full, Blue, the system), small portrait, custom accent before paint', () => {
  const plain = boot({});
  // V3 (docs/ops/V3_DESIGN.md §5, the owner's defaults): Full decoration, Blue, Follow the system (a dark system here).
  assert.deepEqual([plain.attrs['data-palette'], plain.attrs['data-decor'], plain.attrs['data-portrait'], plain.attrs['data-accent'], plain.attrs['data-theme']], ['graphite', 'on', 'small', 'violet', 'dark']);
  assert.equal(boot({ 'sara.palette': 'nonsense' }).attrs['data-palette'], 'graphite');
  for (const p of [...PALETTES, 'classic']) assert.equal(boot({ 'sara.palette': p }).attrs['data-palette'], p);
  assert.equal(boot({ 'sara.palette': 'classic' }).attrs['data-decor'], 'on', 'Classic keeps its decoration');
  assert.equal(boot({ 'sara.palette': 'classic', 'sara.decor': 'off' }).attrs['data-decor'], 'off');
  assert.equal(boot({ 'sara.decor': 'off' }).attrs['data-decor'], 'off', 'a picked value wins');
  assert.equal(boot({ 'sara.palette': 'classic' }, { 'reduced-transparency': true }).attrs['data-decor'], 'off', 'the system can force it off');
  assert.equal(boot({ 'sara.portrait': 'large' }).attrs['data-portrait'], 'large');
  assert.equal(boot({ 'sara.portrait': 'weird' }).attrs['data-portrait'], 'small');
  assert.equal(boot({ 'sara.palette': 'classic' }).attrs['data-portrait'], 'large', 'Sara Classic keeps her large picture');
  assert.equal(boot({ 'sara.palette': 'classic', 'sara.portrait': 'small' }).attrs['data-portrait'], 'small');
  // Night/Day/System maps 1:1 onto every palette.
  assert.equal(boot({ 'sara.theme': 'system', 'sara.palette': 'paper' }, { 'color-scheme: light': true }).attrs['data-theme'], 'light');
  // Custom accent: the stored values for the current mode, nothing else (no maths at boot).
  const custom = JSON.stringify({ hex: '#ff8800', dark: { fill: '#ff8800', text: '#ffa040', on: '#0b0b0c' }, light: { fill: '#a85400', text: '#9a4d00', on: '#ffffff' } });
  const dark = boot({ 'sara.accent': 'custom', 'sara.accentCustom': custom });
  assert.equal(dark.props['--accent-solid'], '#ff8800');
  assert.equal(dark.props['--on-accent'], '#0b0b0c');
  assert.equal(boot({ 'sara.accent': 'custom', 'sara.accentCustom': custom, 'sara.theme': 'light' }).props['--accent-text'], '#9a4d00');
  assert.deepEqual(boot({ 'sara.accent': 'custom', 'sara.accentCustom': '{broken' }).props, {});
  assert.deepEqual(boot({ 'sara.accent': 'custom', 'sara.accentCustom': JSON.stringify({ dark: { fill: 'red;x', text: '#fff', on: '#000' } }) }).props, {}, 'only #rrggbb values');
  // Before any stylesheet, as before.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.indexOf('<script src="/theme-boot.js"></script>') < head.indexOf('<link rel="stylesheet"'));
});

test('V1 custom accent: any colour becomes a readable fill, text shade and on-colour in both modes', async () => {
  const a = await import(pathToFileURL(join(ROOT, 'web', 'accent.js')).href);
  // PAGE_SURFACES = surface-0/1/2 of every palette (and Classic) in theme.css.
  for (const mode of ['dark', 'light']) {
    const want = new Set<string>();
    for (const p of PALETTES) for (const k of ['surface-0', 'surface-1', 'surface-2']) want.add(palette(p, mode)[k]);
    for (const s of want) assert.ok(a.PAGE_SURFACES[mode].includes(s), `${mode} ${s} in PAGE_SURFACES`);
  }
  for (const hex of ['#ff0000', '#ffff00', '#00ff00', '#0000ff', '#000000', '#ffffff', '#808080', '#e0607e', '#7c3aed', '#14b8a6', '#fa0']) {
    const c = a.customAccent(hex);
    assert.ok(c, hex);
    for (const mode of ['dark', 'light'] as const) {
      const { fill, text, on } = c[mode];
      for (const s of a.PAGE_SURFACES[mode]) {
        assert.ok(a.contrast(text, s) >= 4.5, `${hex} ${mode} text ${text} on ${s}`);
        assert.ok(a.contrast(fill, s) >= 3, `${hex} ${mode} fill ${fill} on ${s}`);
      }
      assert.ok(a.contrast(on, fill) >= 4.5, `${hex} ${mode} on-accent`);
    }
  }
  assert.equal(a.customAccent('red; background: url(x)'), null);
  assert.equal(a.customAccent('#fa0').hex, '#ffaa00');
  // A colour that already passes is kept as the fill.
  assert.equal(a.accentFor('#2563eb', 'light').fill, '#2563eb');
  // OKLCH round trip.
  assert.equal(a.fromOklch(a.toOklch('#3b82f6')), '#3b82f6');
});

test('V1 "Use on all my devices": the owner settings keep one clean look; a new device starts from it', async (t) => {
  assert.equal(cleanAppearance(null), undefined, 'null clears it');
  assert.deepEqual(cleanAppearance({ palette: 'evil', theme: 'x', accent: 'custom', density: 'tiny', portrait: 'huge', decor: 'maybe' }), { palette: 'graphite', theme: 'system', accent: 'rose', density: 'comfy', portrait: 'small' }, 'unknown values fall back (V3: Follow the system); custom without its colours is the theme colour');
  const shade = { fill: '#ff8800', text: '#ffa040', on: '#0b0b0c' };
  assert.deepEqual(cleanAppearance({ palette: 'paper', theme: 'light', accent: 'custom', accentCustom: { hex: '#ff8800', dark: shade, light: shade, extra: 1 }, density: 'compact', portrait: 'hidden', decor: 'on' }), { palette: 'paper', theme: 'light', accent: 'custom', accentCustom: { hex: '#ff8800', dark: shade, light: shade }, density: 'compact', portrait: 'hidden', decor: 'on' });
  const temp = tempDir();
  const app = makeApp(temp.dir, { now: new Date() });
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); app.store.close(); temp.cleanup(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const j = async (method: string, body?: unknown) => (await fetch(`${base}/settings`, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  assert.equal((await j('GET')).appearance, null);
  await j('PUT', { appearance: { palette: 'nord', theme: 'system', accent: 'green', density: 'comfy', portrait: 'large', bad: '<x>' } });
  assert.deepEqual((await j('GET')).appearance, { palette: 'nord', theme: 'system', accent: 'green', density: 'comfy', portrait: 'large' });
  // The page side: adopted only on a device that never chose a palette (localStorage wins).
  const app2 = web('app.js');
  assert.match(app2, /function adoptAppearance\(a\) \{\s*if \(!a \|\| localStorage\.getItem\('sara\.palette'\)\) return false;/);
  assert.match(app2, /api\('\/settings', \{ method: 'PUT', body: \{ appearance: currentAppearance\(\) \} \}\)/);
});

test('V1 Appearance page: its own Settings page under You with the same ids, the new pickers, tips and the one-time notice', () => {
  const page = /<section class="settings-page" data-page="you-appearance" data-group="You" data-title="Appearance" hidden>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
  assert.ok(page, 'the page');
  for (const id of ['ap-palette', 'ap-pals', 'ap-theme', 'ap-accent', 'ap-swatches', 'ap-accent-custom', 'ap-accent-hex', 'ap-density', 'ap-decor', 'ap-portrait', 'ap-chatbg', 'ap-size', 'ap-typing', 'ap-sessions', 'ap-sync']) assert.ok(page.includes(`id="${id}"`), id);
  const about = /data-page="you-about"[\s\S]*?<\/section>/.exec(html)![0];
  assert.doesNotMatch(about, /id="ap-/, 'moved out of About you');
  assert.match(page, /<select id="ap-palette"><option value="graphite">Graphite \(default\)<\/option><option value="midnight">Midnight<\/option><option value="slate">Slate<\/option><option value="nord">Nord<\/option><option value="solarized">Solarized<\/option><option value="paper">Paper<\/option><option value="ember">Ember<\/option><option value="contrast">High contrast<\/option><option value="classic">Sara Classic<\/option><\/select>/);
  // V3 (docs/ops/V3_DESIGN.md §5): Blue is the default colour; Theme colour stays the first choice.
  assert.match(page, /<select id="ap-accent"><option value="rose">Theme color<\/option><option value="violet">Violet \(default\)<\/option>[\s\S]*?<option value="custom">Custom<\/option><\/select>/);
  assert.match(page, /<select id="ap-portrait"><option value="small">Small \(default\)<\/option><option value="large">Large<\/option><option value="hidden">Hidden<\/option><\/select>/);
  assert.match(page, /class="ap-classic-only"[^>]*>Chat background/, 'the chat background only for Sara Classic');
  const tips = JSON.parse(web('tips.json')).tips ?? JSON.parse(web('tips.json'));
  for (const id of ['ap-palette', 'ap-decor', 'ap-portrait', 'ap-accent-custom', 'ap-accent-hex', 'ap-sync']) assert.ok(tips[id]?.[0] && tips[id][0].length <= 260, `tip ${id}`);
  const nav = web('settings-nav.js');
  assert.match(nav, /'you-about', 'you-appearance', 'you-briefing'/);
  // Existing users get one notice with a way back; new installs never see it.
  assert.match(html, /<div id="v1-notice" class="v1-notice" role="status" hidden>/);
  assert.match(html, /<button id="v1-classic" type="button" class="ghost small">Switch back to Sara Classic<\/button>/);
  const app = web('app.js');
  assert.match(app, /localStorage\.setItem\('sara\.v1Notice', 'seen'\)/);
  assert.match(app, /\$\('#v1-classic'\)\.addEventListener\('click', \(\) => \{\s*localStorage\.setItem\('sara\.palette', 'classic'\);/);
  // The theme-color meta still follows --surface-0 (native title bars follow the palette).
  assert.match(app, /meta\[name="theme-color"\]'\)\?\.setAttribute\('content', getComputedStyle\(root\)\.getPropertyValue\('--surface-0'\)/);
});

test('V1 slice 2: Reduce decoration hides the aurora, halos, sparkles, blur and glows, and flattens the gradients', () => {
  const pro = newLook();
  // Slice 7: pro.css is gone; its rules live at the end of the screens' own sheets.
  assert.doesNotMatch(html, /pro\.css/);
  assert.equal(existsSync(join(ROOT, 'web', 'pro.css')), false);
  assert.match(pro, /html\[data-decor="off"\] \.aurora \{ display: none; \}/);
  assert.match(pro, /html\[data-decor="off"\] \*, html\[data-decor="off"\] \*::before, html\[data-decor="off"\] \*::after, html\[data-decor="off"\] dialog::backdrop \{ -webkit-backdrop-filter: none !important; backdrop-filter: none !important; \}/);
  assert.match(pro, /html\[data-decor="off"\] :is\(\.td-face-btn, \.hp-glow, \.head-face-btn\)::after,/);
  const off = vars(':root[data-decor="off"] {');
  for (const k of ['accent-glow', 'violet-glow']) assert.equal(off[k], 'transparent', k);
  for (const k of ['btn-glow', 'glow-edge', 'page-glow', 'glass-filter']) assert.equal(off[k], 'none', k);
  assert.equal(off['accent-to'], 'var(--accent-from)', 'every accent gradient becomes one colour');
  // Classic without decoration keeps white-on-accent readable (the deep first stop, solid).
  for (const [sel, c] of [[':root[data-palette="classic"][data-decor="off"] {', '#a8456d'], [':root[data-palette="classic"][data-decor="off"][data-theme="light"] {', '#b8436a']]) {
    assert.equal(vars(sel)['mine-grad'], `linear-gradient(${c}, ${c})`);
    assert.ok(contrast('#ffffff', c) >= 4.5);
  }
  // Every hand-written surface gradient in the component sheets has a flat override (or is functional).
  const FUNCTIONAL = /ctx-ring|ps-ring|bd-progress|td-skel|lb-top|call-panel|chatbg|aurora|::after$|hp-glow::before|td-face-btn::before|td-warm::after|hp-glow(:hover)?$|hp-name|rcard\.(ok|bad)::after/;
  for (const f of ['doc.css', 'first-run.css', 'her-panel.css', 'look.css', 'polish.css', 'screens.css', 'today.css']) {
    const css = web(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|;)\s*background(-image)?:[^;]*gradient\(/.test(m[2])) continue;
      for (const sel of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (FUNCTIONAL.test(sel)) continue;
        const bare = sel.replace(/^#today /, '');
        assert.ok(pro.includes(bare), `${f}: ${sel} has a flat override under data-decor="off"`);
      }
    }
  }
  // The system's reduced transparency forces it (theme-boot.js and app.js).
  assert.match(web('app.js'), /root\.dataset\.decor = matchMedia\('\(prefers-reduced-transparency: reduce\)'\)\.matches \? 'off' : decorPick\(pal\);/);
});

test('V1 slice 3: base components are scoped with :where() outside Sara Classic (no specificity bumps), Classic keeps its serif', () => {
  const pro = newLook();
  const s3 = pro;
  const base = /(?:^|\n)\s*(?:\/\*[\s\S]*?\*\/\s*)*([^{}@]+)\{[^{}]*\}/g;
  const rules = [...s3.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter((x) => x && !x.startsWith('@'));
  assert.ok(rules.length > 20);
  const top = (sel: string) => {
    const out: string[] = [];
    let depth = 0, cur = '';
    for (const c of sel) {
      if (c === ',' && !depth) { out.push(cur); cur = ''; continue; }
      depth += c === '(' ? 1 : c === ')' ? -1 : 0;
      cur += c;
    }
    return [...out, cur];
  };
  void base;
  // Every folded rule is scoped: :where() outside Classic, the decoration switch, or a :root attribute.
  for (const sel of rules) for (const part of top(sel)) assert.match(part.trim(), /^(:where\(:root:not\(\[data-palette="classic"\]\)\) |html\[data-decor="off"\] |:root\[data-portrait="(small|hidden)"\] |:root:not\(\[data-palette="classic"\]\)(\[data-chatbg\])? |:root:not\(\[data-palette="classic"\]\)$|\.ap-|\.v1-notice)/, part);
  for (const [what, re] of [['solid primary', /button \{[^}]*box-shadow: none; filter: none;/], ['secondary', /button\.ghost:where\([^{]*\) \{ background: var\(--surface-2\); border: 1px solid var\(--line\)/], ['focus ring', /:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/], ['field focus', /:focus \{ outline: none; border-color: var\(--accent-solid\); box-shadow: 0 0 0 3px var\(--accent-soft\); \}/], ['underline tabs', /\.tabs \.tab\.active[^{]*\{ background: transparent; color: var\(--text-1\); border-bottom-color: var\(--accent-solid\);/], ['flat cards', /\.cmp-card, \.start-item\) \{ background: var\(--surface-1\); border: 1px solid var\(--line\); border-radius: var\(--r-3\); box-shadow: none; \}/], ['dialogs', /dialog \{ border: 1px solid var\(--line\); border-radius: var\(--r-4\);/]] as const) assert.match(s3, re, what);
  // Fields grow to --h-control only with a mouse; touch keeps the 44 px rules of the other sheets.
  assert.match(s3, /@media \(pointer: fine\) \{\s*(\/\*[^*]*\*\/\s*)?:where\(:root:not\(\[data-palette="classic"\]\)\) :is\(select, input/);
  assert.equal(vars(':root:not([data-palette="classic"]) {')['font-display'], 'var(--font-ui-v1)');
});

test('V1 slice 4: shell without pink rails, the portrait setting, the flat phone bar', () => {
  const pro = newLook();
  const s4 = pro;
  for (const sel of ['#conversations a.active', '.settings-nav-item[aria-current="true"]', '.cmd-item[aria-selected="true"]']) {
    const rule = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{[^}]*background: var\\(--surface-3\\);[^}]*box-shadow: none;`);
    assert.match(s4, rule, `${sel}: selected = surface-3, no rail`);
  }
  assert.match(s4, /:root\[data-portrait="small"\] \.hp-glow \{ width: 72px; height: 72px;/);
  assert.match(s4, /:root\[data-portrait="hidden"\] \.hp-glow \{ display: none; \}/);
  assert.match(s4, /\.bottom-bar \{ margin: 0;[^}]*border-top: 1px solid var\(--line\); border-radius: 0; background: var\(--surface-1\); box-shadow: none; \}/);
  assert.match(s4, /\.bottom-bar::before \{ display: none; \}/);
  // Touch targets: the phone bar buttons keep their 44 px+ height (today.css), nothing here shrinks them.
  assert.doesNotMatch(s4, /\.bb-btn \{[^}]*(height|min-height):/);
});

test('V1 slice 5: chat is a transcript (no bubbles, no rails), flat composer; the markdown table is styled', () => {
  const pro = newLook();
  const s5 = pro;
  assert.match(s5, /\.msg\.user \{ align-self: stretch; max-width: 780px;[^}]*border-top: 1px solid var\(--hairline\); border-radius: 0; background: none; color: var\(--text-1\); box-shadow: none; \}/, 'your turns are not filled');
  assert.match(s5, /\.msg\.assistant\.her::before \{ display: none; \}/, 'no accent rail on her turns');
  assert.match(s5, /\.msg-face \{ left: -38px; top: 1px; width: 24px; height: 24px;/, 'a 24 px avatar');
  assert.match(s5, /#composer #send \{ border-radius: var\(--r-2\); box-shadow: none;/);
  // The ghost buttons whose own rule must keep winning are skipped (cascade-safe).
  assert.match(pro, /button\.ghost:where\(:not\(\.ag-src, \.td-ag-item, \.rt-setup-first, \.msg-more\)\) \{/);
  // Reading width and her line height for the transcript.
  assert.match(s5, /\.msg\.assistant\.her \{ max-width: 780px; margin-left: 44px; padding: 0; line-height: var\(--lh-read\); \}/);
});

test('V1 slice 6: Settings legend uses status dots, Today and window titles use the UI face', () => {
  const s6 = newLook();
  assert.match(s6, /\.perm-card \{ border-left-width: 1px;/, 'no coloured left rail');
  assert.match(s6, /\.perm-auto strong::before \{ background: var\(--success\); \}/);
  assert.match(s6, /#td-greeting \{ font-size: clamp\(24px, 2\.4vw, 30px\); font-weight: 600;/);
  // Sara Classic keeps the display serif (polish.css is unchanged).
  assert.match(web('polish.css'), /#td-greeting \{\s*font-family: var\(--font-display\);/);
});
