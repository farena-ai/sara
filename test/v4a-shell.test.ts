// V4a (docs/ops/V4_DESIGN.md): the "living system" shell. Static and pure checks, no browser:
// the graphite V4 surfaces and the one accent (presets + any colour at WCAG AA, its hue tokens),
// her chosen name everywhere, the live status strip's data (real API shapes, hidden when empty),
// the at-a-glance panel, the background field (throttled, paused, off with reduced motion or the
// setting) and the command bar's previews.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { EventTriggers } from '../src/event-triggers.ts';
import { createSaraServer } from '../src/server.ts';
import { spendHours } from '../src/spend.ts';
import { TeamManager } from '../src/team.ts';
import { UsageStore } from '../src/usage.ts';
import { Workers } from '../src/workers.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
import { registerHooks } from 'node:module';

// web/naming.js imports /identity.js, which the server builds from src/identity.ts: the same here.
registerHooks({
  resolve: (spec, context, next) => (spec === './identity.js' && String(context.parentURL).endsWith('/web/naming.js') ? next(pathToFileURL(join(ROOT, 'src', 'identity.ts')).href, context) : next(spec, context)),
});

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
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
const hue = (h: string) => {
  const [r, g, b] = hex(h);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const x = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return x * 60;
};
function vars(selector: string): Record<string, string> {
  const at = theme.indexOf(selector);
  assert.ok(at >= 0, selector);
  const open = theme.indexOf('{', at);
  const body = theme.slice(open, theme.indexOf('}', open));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const palette = (p: string, mode: string) => vars(`:root[data-palette="${p}"][data-theme="${mode}"] {`);
const preset = (a: string, mode: string) => vars(a === 'amber' ? `:root:not([data-palette="classic"])[data-accent="amber"][data-theme="${mode}"]` : `:root[data-palette][data-accent="${a}"][data-theme="${mode}"]`);
const PALETTES = ['graphite', 'midnight', 'slate', 'nord', 'solarized', 'paper', 'ember', 'contrast'];
/** The six V4 presets, in the order the Appearance page shows them (Blue is the default). */
const V4_PRESETS = ['blue', 'pink', 'violet', 'emerald', 'amber', 'cyan'];

test('V4a tokens: graphite carries the V4 surfaces in Night and Day, every text and state colour stays AA on them', () => {
  const d = palette('graphite', 'dark');
  assert.deepEqual([d['surface-0'], d['surface-1'], d['surface-2'], d['surface-3'], d.line], ['#0b0c0e', '#121316', '#17181c', '#1f2025', '#2a2b31']);
  const l = palette('graphite', 'light');
  assert.deepEqual([l['surface-0'], l['surface-1'], l['surface-2'], l['surface-3'], l.line], ['#f3f4f6', '#ffffff', '#f6f7f9', '#eceef2', '#e1e3e8']);
  const rows: string[] = [];
  for (const [mode, t] of [['dark', d], ['light', l]] as const) {
    // surface-3 is the hovered and selected row in V4: text and the accent's text stay readable there too.
    for (const s of ['surface-0', 'surface-1', 'surface-2', 'surface-3']) {
      for (const k of s === 'surface-3' ? ['text-1', 'text-2', 'accent-text'] : ['text-1', 'text-2', 'accent-text', 'success', 'warn', 'danger', 'info']) if (contrast(t[k], t[s]) < 4.5) rows.push(`${mode} ${k} on ${s}: ${contrast(t[k], t[s]).toFixed(2)}`);
    }
    for (const s of ['surface-0', 'surface-1', 'surface-2']) if (contrast(t['text-3'], t[s]) < 4.5) rows.push(`${mode} text-3 on ${s}`);
  }
  assert.deepEqual(rows, [], rows.join('\n'));
});

test('V4a accent: six presets (Blue default, Rose, Violet, Emerald, Amber, Cyan) at AA on every palette, with matching hue tokens', () => {
  const rows: string[] = [];
  for (const a of V4_PRESETS) for (const mode of ['dark', 'light']) {
    const x = preset(a, mode);
    for (const p of PALETTES) {
      const t = palette(p, mode);
      for (const s of ['surface-0', 'surface-1', 'surface-2']) if (contrast(x['accent-text'], t[s]) < 4.5) rows.push(`${a} ${mode} text on ${p} ${s}`);
      if (contrast(x['accent-solid'], t['surface-0']) < 3) rows.push(`${a} ${mode} fill on ${p}`);
    }
    if (contrast(x['on-accent'], x['accent-solid']) < 4.5) rows.push(`${a} ${mode} on-accent`);
  }
  assert.deepEqual(rows, [], rows.join('\n'));
  // The hue the glows, the field and the dots use is the preset's own (within 15 degrees of its fill).
  for (const a of V4_PRESETS) {
    const h = Number(vars(a === 'amber' ? ':root:not([data-palette="classic"])[data-accent="amber"] {' : `:root[data-palette][data-accent="${a}"] {`)['acc-h']);
    const fill = hue(preset(a, 'dark')['accent-solid']);
    const diff = Math.min(Math.abs(h - fill), 360 - Math.abs(h - fill));
    assert.ok(diff <= 15, `${a}: --acc-h ${h} vs fill hue ${fill.toFixed(0)}`);
  }
  // Appearance: the six first (after Theme colour), Emerald is a real stored value on the server too.
  assert.match(html, /<select id="ap-accent"><option value="rose">Theme color<\/option><option value="violet">Violet \(default\)<\/option><option value="blue">Blue<\/option><option value="pink">Rose<\/option><option value="emerald">Emerald<\/option><option value="amber">Amber<\/option><option value="cyan">Cyan<\/option>/);
  assert.match(readFileSync(join(ROOT, 'src', 'appearance.ts'), 'utf8'), /'emerald'/);
  assert.match(theme, /\.ap-swatch\[data-accent="emerald"\] \{ background: #10b981; \}/);
  // Nothing readable is drawn from the hue tokens: they only feed glows, haze and the second accent.
  for (const f of ['v4.css', 'theme.css']) {
    for (const m of web(f).matchAll(/(?:^|[;{\s])(color|border-color|outline(?:-color)?):\s*([^;}]+)/g)) assert.doesNotMatch(m[2], /--acc-(h|s|l|glow|haze|second)\b/, `${f}: ${m[0].trim()}`);
  }
});

test('V4a any colour: a picked colour is clamped to AA fills and text on every surface, both modes, and its hue is set before paint', async () => {
  const a = await import(pathToFileURL(join(ROOT, 'web', 'accent.js')).href);
  for (const mode of ['dark', 'light']) for (const k of ['surface-0', 'surface-1', 'surface-2']) assert.ok(a.PAGE_SURFACES[mode].includes(palette('graphite', mode)[k]), `${mode} ${k}`);
  const bad: string[] = [];
  for (let h = 0; h < 360; h += 15) for (const [s, l] of [[100, 50], [60, 30], [80, 75], [20, 50]]) {
    const c = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l / 100 - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const pick = '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
    const out = a.customAccent(pick);
    for (const mode of ['dark', 'light'] as const) {
      const { fill, text, on } = out[mode];
      for (const sf of a.PAGE_SURFACES[mode]) {
        if (a.contrast(text, sf) < 4.5) bad.push(`${pick} ${mode} text on ${sf}`);
        if (a.contrast(fill, sf) < 3) bad.push(`${pick} ${mode} fill on ${sf}`);
      }
      if (a.contrast(on, fill) < 4.5) bad.push(`${pick} ${mode} on`);
    }
  }
  assert.deepEqual(bad, [], bad.slice(0, 20).join('\n'));
  // theme-boot.js: the custom colour's hue lands in --acc-h/s/l, and data-motion follows the setting.
  const boot = (store: Record<string, string>) => {
    const attrs: Record<string, string> = {};
    const props: Record<string, string> = {};
    const root = { setAttribute: (k: string, v: string) => (attrs[k] = v), classList: { add: () => {}, contains: () => false }, style: { setProperty: (k: string, v: string) => (props[k] = v) } };
    const mm = () => ({ matches: false });
    runInNewContext(web('theme-boot.js'), { window: { matchMedia: mm }, document: { documentElement: root }, localStorage: { getItem: (k: string) => store[k] ?? null }, matchMedia: mm, location: { search: '' } });
    return { attrs, props };
  };
  const custom = JSON.stringify({ hex: '#e11d48', dark: { fill: '#e11d48', text: '#fb7185', on: '#ffffff' }, light: { fill: '#be123c', text: '#9f1239', on: '#ffffff' } });
  const b = boot({ 'sara.accent': 'custom', 'sara.accentCustom': custom });
  assert.equal(b.props['--acc-h'], '347');
  assert.match(b.props['--acc-s'], /^\d+%$/);
  assert.equal(boot({}).attrs['data-motion'], 'on');
  assert.equal(boot({ 'sara.motion': 'off' }).attrs['data-motion'], 'off');
});

const v4 = () => import(pathToFileURL(join(ROOT, 'web', 'v4.js')).href);

test('V4a name: her chosen name everywhere she is named (header, sidebar, composer, status strip, page title), product names kept', () => {
  const naming = web('naming.js');
  const raw = /const RAW = \[([\s\S]*?)\]\.join/.exec(naming)![1];
  // The places that show her name are rewritten by naming.js (not in its RAW list), live: setIdentity()
  // re-walks the page and a MutationObserver follows every later change, attributes included.
  for (const sel of ['#sidebar', '.brand-name', '.side-her', '#chat-head', '#composer', '#input', '#v4-strip', '.v4-word-name', '#v4-glance', '#cmdbar']) assert.ok(!raw.includes(`'${sel}'`), `${sel} is not raw`);
  assert.match(naming, /const ATTRS = \['placeholder', 'title', 'aria-label'/, 'the composer placeholder and tooltips follow');
  assert.match(naming, /document\.title = identity\.name;/, 'the page title');
  assert.ok(naming.includes("document.dispatchEvent?.(new CustomEvent('sara-identity'"), 'a rename tells the parts that build her name in code');
  assert.match(web('her-panel.js'), /addEventListener\('sara-identity', \(\) => \{\s*renderHer\(\);\s*renderConv\(\);/, 'her panel title (and its conversation facts) follow a rename');
  assert.match(naming, /observer\.observe\(document\.body, \{ childList: true, subtree: true, characterData: true, attributes: true/);
  // The header's title is raw (conversation titles are the owner's) but its default is her name through t().
  assert.match(web('app.js'), /\$\('#chat-title'\)\.textContent = t\('Sara'\);/);
  // The markup says "Sara" where her name goes, so the plumbing can swap it.
  assert.match(html, /<span class="v4-word-name">Sara<\/span>/);
  assert.match(html, /<span class="brand-name">Sara<\/span>/);
  assert.match(html, /<textarea id="input" rows="1" placeholder="Message Sara…"/);
  // No code writes her name around the plumbing (a literal "Sara" straight into visible text).
  const bad: string[] = [];
  for (const f of ['app.js', 'v4.js', 'command-bar.js', 'her-panel.js', 'today.js', 'sidebar.js', 'nav.js', 'bottom-bar.js']) {
    for (const m of web(f).matchAll(/\.(textContent|placeholder|title|innerText|ariaLabel)\s*=\s*(['"`])[^'"`]*\bSara\b[^'"`]*\2/g)) if (!/Sara \$\{h\.version\}/.test(m[0])) bad.push(`${f}: ${m[0]}`); // the product's version line is the product's name
    for (const m of web(f).matchAll(/setAttribute\('(placeholder|title|aria-label)',\s*(['"`])[^'"`]*\bSara\b/g)) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
  // V4a's own wording names her through t() (or says "she"), never a fixed name.
  assert.doesNotMatch(web('v4.js').replace(/^\s*\/\/.*$/gm, ''), /'[^'\n]*\bSara\b[^'\n]*'/);
  // The product's palette name "Sara Classic" is not her name: a renamed companion keeps it.
  assert.ok(raw.includes(`'#ap-palette option[value="classic"]'`) && raw.includes(`'.ap-pal[data-pal="classic"] .ap-pal-name'`) && raw.includes(`'#v1-classic'`));
  // V4b's mount points for her orb exist, empty, where the name and her face are.
  // The strip wordmark keeps V4a's mount; the sidebar brand and the header face use V4b's (merged in V4c).
  assert.match(html, /<span class="v4-orb" data-orb-size="18"><\/span>/);
  for (const size of ['30', '38']) assert.match(html, new RegExp(`<span class="v4-orb v4-orb-face" data-orb-size="${size}"></span>`));
  assert.match(html, /<div id="v4-mem-slot" class="v4-mem-slot"><\/div>/);
});

test('V4a status strip: chips come from the real routes (workers, triggers, spend, model), hidden when empty, each opens its page', async (t) => {
  const { stripChips, glanceToday, sparkPath } = await v4();
  assert.deepEqual(stripChips({}), [], 'nothing to show: no chips');
  assert.deepEqual(stripChips({ workers: { workers: [{ name: 'A', running: null, queued: 3 }] }, triggers: { triggers: [{ name: 'x', state: 'paused' }] }, spend: { spent: { day: 0 }, spend: { dayUsd: 0 } } }), [], 'queued, paused and zero spend are not chips');
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T18:00:00Z') };
  const app = makeApp(dir, clock);
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), spend: { dayUsd: 5 } } as never);
  app.team = new TeamManager(app, app.store.db);
  app.workers = new Workers(app, app.store.db, { runner: () => ({ done: new Promise(() => {}), stop: () => {}, waiting: () => false }), alert: async () => true, quiet: () => false } as never);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.eventTriggers = new EventTriggers(app, app.store.db, { runPrompt: async () => ({ reply: 'ok', tokens: 1 }), notify: async () => {}, quiet: () => false });
  const w = app.workers.create({ name: 'Inbox triage', character: 'Brisk.', helper: 'writer', toolGroups: ['read'], dailyTokens: 50000, timeLimitMin: 10 });
  app.workers.enqueue(w.id, { title: 'Sort the mail', input: 'Sort it.' });
  app.workers.tick();
  app.eventTriggers.create({ name: 'Ops alert', source: 'slack', filter: { channel: 'ops', words: 'down' }, action: { kind: 'prompt', prompt: 'Check it.' } });
  const ins = app.store.db.prepare('INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, input, output, cached, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [h, usd] of [[2, 0.1], [9, 0.2], [17, 0.12]] as const) ins.run(`2026-11-08T${String(h).padStart(2, '0')}:10:00.000Z`, 'p', 'P', 'm', 'api', 'chat', 10, 10, 0, usd);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (p: string) => {
    const r = await fetch(base + p, { headers: { authorization: `Bearer ${auth.newToken}` } });
    return r.ok ? r.json() : null;
  };
  // The same five calls web/v4.js makes.
  const d = { workers: await get('/workers'), runs: await get('/runs?limit=20'), research: await get('/research'), triggers: await get('/triggers'), spend: await get('/spend'), model: { name: 'claude-opus-4', provider: 'P', live: true } };
  const chips = stripChips(d);
  assert.deepEqual(chips.map((c: { key: string }) => c.key), ['workers', 'triggers', 'model', 'spend']);
  const by = Object.fromEntries(chips.map((c: { key: string }) => [c.key, c]));
  assert.equal(by.workers.text, 'One worker running');
  assert.equal(by.workers.live, true);
  assert.equal(by.triggers.text, 'One trigger armed');
  assert.equal(by.model.text, 'claude-opus-4 · answering');
  assert.equal(by.spend.text, '$0.42 of $5.00 today');
  assert.deepEqual(Object.fromEntries(chips.map((c: { key: string; go: string }) => [c.key, c.go])), { workers: 'team', triggers: 'triggers', model: 'model', spend: 'spend' });
  // Spend's line: one point per hour of today, rising to what was spent so far.
  assert.equal(d.spend.hours.length, 19);
  assert.equal(d.spend.hours[0], 0);
  assert.equal(d.spend.hours.at(-1), 0.42);
  for (let i = 1; i < d.spend.hours.length; i++) assert.ok(d.spend.hours[i] >= d.spend.hours[i - 1]);
  assert.deepEqual(spendHours(undefined, clock.now, 'UTC'), []);
  assert.ok(sparkPath(d.spend.hours)!.line.startsWith('M0.0 42.0'));
  assert.equal(sparkPath([1]), null);
  // Today's card: tasks done, waiting on you, what a trigger watches for.
  const today = await get('/today?parts=day,board,needs');
  assert.deepEqual(glanceToday(today, d.triggers), { done: 0, waiting: 0, watching: 'Ops alert' });
  // Wiring: every chip opens its page; web/v4.js asks only these routes and polls only while visible.
  const js = web('v4.js');
  for (const p of ["'/workers'", "'/runs?limit=20'", "'/research'", "'/triggers'", "'/spend'", "'/today?parts=day,board,needs'"]) assert.ok(js.includes(p), p);
  assert.match(js, /if \(!ui\.ctx \|\| document\.hidden\) return;/);
  assert.match(js, /c\.openSettings\('co-hooks'\)/);
  assert.match(js, /c\.openSettings\('models-routes'\)/);
  assert.match(js, /c\.openSettings\('dh-usage'\)/);
  const appJs = web('app.js');
  assert.match(appJs, /initV4\(\{/);
  assert.match(appJs, /state\.streaming = controller;\n  v4Kick\(\);/, 'a reply starting refreshes the strip');
  // Household members: the owner-only routes are not even asked.
  assert.match(js, /if \(c\.isMember\?\.\(\) \|\| c\.demo\?\.\(\)\) return \{\};/);
  // At a glance: in her panel, 1180 px and wider, folds and is remembered on this device.
  assert.match(web('v4.css'), /@media \(min-width: 1180px\) \{\s*:where\(:root:not\(\[data-palette="classic"\]\)\) \.her-panel\.mode-side \.v4-glance \{ display: grid;/);
  assert.match(js, /const GLANCE_KEY = 'sara\.glance';/);
});

test('V4a field and motion: at most 30 fps, paused while hidden, still with reduced motion or the setting, gone in Classic', async () => {
  const { fieldPlan, frameDue } = await v4();
  const base = { hidden: false, reduced: false, motion: 'on', classic: false, decor: 'on' };
  assert.deepEqual(fieldPlan({ ...base, hidden: true, busy: 1 }), { run: false, still: false, fps: 0, speed: 0 });
  assert.equal(fieldPlan({ ...base, reduced: true, busy: 1 }).run, false);
  assert.equal(fieldPlan({ ...base, reduced: true, busy: 1 }).still, true);
  assert.equal(fieldPlan({ ...base, motion: 'off', busy: 1 }).run, false);
  assert.equal(fieldPlan({ ...base, decor: 'off', busy: 1 }).run, false);
  assert.equal(fieldPlan({ ...base, classic: true, busy: 1 }).still, false);
  const busy = fieldPlan({ ...base, busy: 1 });
  const idle = fieldPlan({ ...base, busy: 0 });
  assert.ok(busy.run && busy.fps <= 15 && busy.speed > idle.speed && idle.fps < busy.fps, 'docs/PERFORMANCE.md: busy speeds the drift, at most 15 frames a second');
  assert.equal(frameDue(0, 20, 30), false);
  assert.equal(frameDue(0, 34, 30), true);
  assert.equal(frameDue(0, 20, 120), false, 'never more than 30 a second');
  const js = web('v4.js');
  assert.match(js, /cv\.width = Math\.max\(1, Math\.round\(innerWidth \/ 4\)\)/, 'a quarter-size canvas');
  assert.match(js, /document\.addEventListener\('visibilitychange', wake\)/);
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  const css = web('v4.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none !important; \}\s*\.v4-field \{ display: none !important; \}/);
  assert.match(css, /:root\[data-motion="off"\] \.v4-chip \.v4-dot::after, :root\[data-motion="off"\] \.v4-bar i \{ animation: none; \}/);
  // The setting: Settings → Appearance → Background motion, with its tip.
  assert.match(html, /<select id="ap-motion"><option value="on">On: a faint light that moves with how busy she is \(default\)<\/option><option value="off">Off: still<\/option><\/select>/);
  const tips = JSON.parse(web('tips.json')).tips;
  assert.ok(tips['ap-motion']?.[0]);
  // No new framework: plain modules only.
  assert.doesNotMatch(js, /^import .* from '(?!\.\/)/m);
});

test('V4a command bar: a live preview of the highlighted row (setting before → after, place counts, ask in this chat)', async () => {
  const cb = await import(pathToFileURL(join(ROOT, 'web', 'command-bar.js')).href);
  const conv = cb.previewSpec({ group: 'convs', label: 'Trip plan', raw: true });
  assert.equal(conv.kind, 'Conversation');
  assert.deepEqual(conv.lines, ['Opens this conversation.']);
  const theme = cb.previewSpec({ group: 'actions', label: 'Switch to Day' }, { change: { from: 'Night', to: 'Day' } });
  assert.deepEqual([theme.kind, theme.change], ['Action', { from: 'Night', to: 'Day' }]);
  const place = cb.previewSpec({ group: 'places', label: 'Planner', sub: 'to-dos' }, { kv: [['To-dos open', 3]] });
  assert.deepEqual(place.kv, [['To-dos open', 3]]);
  assert.deepEqual(place.lines, ['to-dos'], 'its own line stays');
  assert.match(html, /<div id="cmd-pv" class="cmd-pv" aria-live="polite"><\/div>/);
  const appJs = web('app.js');
  assert.match(appJs, /ask: \(q\) => \(q && !state\.conv\?\.readOnly \? \{ key: 'ask', icon: 'chat', label: t\('Ask \{name\}: “\{q\}”', \{ name: currentIdentity\(\)\.name, q \}\)/);
  assert.match(appJs, /preview: \(\) => \(\{ lines: \[t\('She answers in this chat\.'\)\] \}\)/);
  assert.match(appJs, /preview: \(\) => placePreview\(row\.dataset\.dest\)/);
  assert.match(appJs, /preview: \(\) => settingPreview\(n\)/);
  assert.match(appJs, /change: \{ from: light \? t\('Day'\) : t\('Night'\), to: light \? t\('Night'\) : t\('Day'\) \}/);
  // The preview pane only outside Sara Classic, and not on phones (no room).
  const css = web('v4.css');
  assert.match(css, /^\.v4-strip, \.v4-glance, \.v4-field, \.cmd-pv \{ display: none; \}/m);
  assert.match(css, /\.cmd-pv \{ display: none; \}\n\}/);
});
