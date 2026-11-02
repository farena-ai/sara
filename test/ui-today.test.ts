// Phase 75 (stage 3, "Today and the rest"): Today as the home screen (tiles built from data), the
// phone's bottom bar, every screen on the tokens (no old pink or hard-coded colours left in the
// CSS), the quick-ask shortcut picker (only inside the Windows / Mac app) and the one small
// read-only route the weather tile needed (GET /api/today/weather). Static checks plus the pure
// helpers and the tile renderers run in Node against a tiny DOM stand-in.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { setNetTransport } from '../src/net-guard.ts';
import { clearWeatherCache } from '../src/routes/planner.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const app = web('app.js');
const todayJs = web('today.js');
const barJs = web('bottom-bar.js');
const todayCss = web('today.css');

// ---------- a tiny DOM, enough for the tile renderers ----------
class Node {
  tagName: string;
  children: Node[] = [];
  parentNode: Node | null = null;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  title = '';
  type = '';
  value = '';
  checked = false;
  max = 0;
  src = '';
  alt = '';
  tabIndex = -1;
  #text = '';
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get id() {
    return this.attrs.id ?? '';
  }
  set id(v: string) {
    this.attrs.id = v;
  }
  get classList() {
    const self = this;
    return {
      add: (...c: string[]) => (self.className = [...new Set([...self.className.split(' ').filter(Boolean), ...c])].join(' ')),
      remove: (...c: string[]) => (self.className = self.className.split(' ').filter((x) => x && !c.includes(x)).join(' ')),
      contains: (c: string) => self.className.split(' ').includes(c),
      toggle: (c: string, on?: boolean) => {
        const has = self.className.split(' ').includes(c);
        const want = on ?? !has;
        if (want && !has) self.className = `${self.className} ${c}`.trim();
        if (!want && has) self.className = self.className.split(' ').filter((x) => x !== c).join(' ');
        return want;
      },
    };
  }
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.#text = String(v);
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  addEventListener(k: string, f: (e?: unknown) => void) {
    (this.listeners[k] ??= []).push(f);
  }
  append(...n: Node[]) {
    for (const c of n) {
      c.parentNode = this;
      this.children.push(c);
    }
  }
  prepend(...n: Node[]) {
    for (const c of n) c.parentNode = this;
    this.children.unshift(...n);
  }
  replaceChildren(...n: Node[]) {
    this.#text = '';
    this.children = [];
    this.append(...n);
  }
  matches(sel: string): boolean {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  all(): Node[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelector(sel: string): Node | null {
    const parts = sel.trim().split(/\s+/);
    let scope: Node[] = [this];
    for (const p of parts) scope = scope.flatMap((s) => s.all().filter((n) => n.matches(p)));
    return scope[0] ?? null;
  }
  querySelectorAll(sel: string): Node[] {
    return this.all().filter((n) => n.matches(sel));
  }
}
/** The Today markup from index.html as Nodes (only the tile sections and their inner boxes). */
function todayDom() {
  const body = new Node('body');
  const at = html.indexOf('<div id="td-tiles"');
  const block = html.slice(at, html.indexOf('</div>\n          <p class="td-ask-row">', at));
  // Phase 111: tiles sit inside the five section blocks; only the tiles become nodes here.
  for (const m of block.matchAll(/<section class="([^"]*\btd-tile\b[^"]*)" id="([\w-]+)"( hidden)?[^>]*>([\s\S]*?)<\/section>/g)) {
    const s = new Node('section');
    s.className = m[1];
    s.id = m[2];
    s.hidden = Boolean(m[3]);
    const head = new Node('div');
    head.className = 'td-tile-head';
    const h3 = new Node('h3');
    head.append(h3);
    s.append(head);
    for (const box of m[4].matchAll(/<div class="(td-body|today-list|today-otd)"><\/div>/g)) {
      const d = new Node('div');
      d.className = box[1];
      s.append(d);
    }
    body.append(s);
  }
  const doc = {
    body,
    createElement: (t: string) => new Node(t),
    createElementNS: (_ns: string, t: string) => new Node(t),
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  };
  return doc;
}

/** A web module in Node: its naming.js import becomes a small stand-in. */
async function load(file: string) {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US';";
  const src = web(file).replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub)
    // 2.8: the icon set and the small charts are plain modules; a data: URL module imports them by their file URL.
    .replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// ---------- Today: markup ----------

test('Today: a view over the chat column (not a window), old ids and deep link kept, tiles focusable', () => {
  const chat = html.slice(html.indexOf('<main id="chat">'), html.indexOf('</main>', html.indexOf('<main id="chat">')));
  assert.match(chat, /<dialog id="today" class="today-dialog today-view" data-wired="1"/, 'inside #chat, wired by today.js (no ✕ window)');
  for (const id of ['td-greeting', 'td-date', 'td-start', 'td-start-count', 'td-start-hide', 'td-start-list', 'td-agenda', 'td-calendar', 'td-mail', 'td-her', 'td-her-name', 'td-otd', 'td-otd-title', 'td-otd-open', 'td-dates', 'td-models', 'td-jobs', 'td-ask', 'td-refresh', 'td-status']) {
    assert.ok(chat.includes(`id="${id}"`), `kept: #${id}`);
  }
  for (const id of ['td-tiles', 'td-weather', 'td-memories', 'td-home', 'td-setup', 'td-face', 'td-face-btn', 'td-back', 'td-ask-any']) assert.ok(chat.includes(`id="${id}"`), `new: #${id}`);
  // Every tile is a labelled, keyboard-focusable section.
  const tiles = [...chat.matchAll(/<section class="today-card td-tile[^"]*" id="([\w-]+)"[^>]*>/g)];
  assert.ok(tiles.length >= 11, 'eleven tiles');
  for (const m of tiles) assert.match(m[0], /tabindex="0" aria-labelledby="[\w-]+"/, m[1]);
  // The AI notice stays next to her face on the greeting.
  assert.match(chat, /<span class="ai-badge td-ai" title="Sara is an AI companion">AI companion<\/span>/);
  // Opened with show() over the chat; Alt+T, /#view=today and the place in the sidebar still open it.
  assert.doesNotMatch(app, /\$\('#today'\)\.showModal\(\)/);
  assert.match(todayJs, /if \(!d\.open\) d\.show\(\);/);
  assert.match(app, /const SHORTCUTS = \{ KeyT: openToday,/);
  assert.match(app, /const VIEWS = \{ today: openToday,/);
  assert.match(app, /\$\('#open-today'\)\.addEventListener\('click', openToday\);/);
  assert.match(app, /\$\('#brand-today'\)\.addEventListener\('click'/, 'her face and name at the top of the sidebar go to Today');
  assert.match(html, /<button id="brand-today" class="brand" type="button" title="Today \(Alt\+T\)">/);
  // 2.7.1: the last conversation is still opened underneath (Chat is one tap away), then Today on
  // top unless a link said where to go (web/start-view.js, test/ui-start-today.test.ts).
  assert.match(app, /if \(first\) await openConversation\(first\.id\);[\s\S]{0,200}if \(onToday\) void openToday\(\);/);
  // Shortcuts, Esc and the first tour offer treat Today as a view, not a window.
  assert.ok(app.includes("if (document.querySelector('dialog[open]:not(#today)')) return;"));
  assert.match(web('her-panel.js') + todayJs, /dialog\[open\]:not\(#today\)/);
  // Opening a conversation leaves Today.
  assert.match(app, /async function openConversation\(id\) \{\n {2}if \(todayOpen\(\)\) closeToday\(\{ focus: false \}\);/);
  assert.match(app, /async function newConversation\(projectId = null, offRecord = false\) \{\n {2}if \(todayOpen\(\)\) closeToday\(\{ focus: false \}\);/);
});

test('Today: five sections, each a 12-column grid (S/M/L spans by container width); reduced motion; title strip', () => {
  // Phase 111 (TD1): the old auto-fill grid became sections with a 12-column grid each.
  assert.match(todayCss, /\.td-grid \{[^}]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\);/);
  assert.match(todayCss, /@container today \(min-width: 1060px\)/);
  assert.match(todayCss, /@container today \(min-width: 840px\)/);
  assert.match(todayCss, /container: today \/ inline-size;/);
  // Motion only through the theme's durations (theme.css turns them off for reduced motion).
  assert.doesNotMatch(todayCss, /\d+ms|\d\.\d+s\b/, 'no fixed durations');
  assert.match(web('theme.css'), /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(todayCss, /html\.shell \.td-scroll \{ padding-top: calc\(var\(--titlebar\)/, 'below the native title strip');
  assert.match(todayCss, /@media \(pointer: coarse\) \{[^}]*\.td-link[^}]*min-height: 44px;/);
});

// ---------- Today: helpers ----------

test('Today helpers: weather words, your day in time order, newest notes, photos, work, home picks, set-up lines', async () => {
  const m = await load('today.js');
  assert.deepEqual(m.weatherKind(0), { icon: '☀️', kind: 'clear' });
  assert.equal(m.weatherKind(0, false).icon, '🌙', 'a clear night');
  assert.equal(m.weatherKind(63).kind, 'rain');
  assert.equal(m.weatherKind(95).kind, 'thunder');
  assert.equal(m.weatherKind(null).kind, 'unknown');
  assert.equal(m.weatherWords('drizzle'), 'Light drizzle');
  const now = Date.parse('2026-10-29T18:00:00-05:00');
  const at = (h: string) => `2026-10-29T${h}:00-05:00`;
  const day = m.dayTimeline({
    calendar: { events: [{ title: 'Dinner', start: at('19:00'), end: at('20:00') }, { title: 'Standup', start: at('09:00'), end: at('09:15') }, { title: 'Holiday', allDay: true, start: '2026-10-29' }] },
    agenda: { reminders: [{ text: 'Call Mom', dueAt: at('18:30') }], tasks: [{ title: 'Undated' }] },
  }, now);
  assert.deepEqual(day.map((x: { title: string }) => x.title), ['Holiday', 'Standup', 'Call Mom', 'Dinner'], 'all day first, then by time; to-dos are not on the timeline');
  assert.deepEqual(day.map((x: { past: boolean }) => x.past), [false, true, false, false]);
  assert.deepEqual(m.dayTimeline(null), []);
  const mems = m.recentMemories([
    { id: 1, kind: 'fact', content: 'old', createdAt: '2026-10-01T00:00:00Z' },
    { id: 2, kind: 'fact', content: 'new', createdAt: '2026-10-29T00:00:00Z' },
    { id: 3, kind: 'summary', content: 'a summary', createdAt: '2026-10-30T00:00:00Z' },
    { id: 4, kind: 'fact', content: 'replaced', createdAt: '2026-10-30T00:00:00Z', supersededBy: 2 },
  ], 3);
  assert.deepEqual(mems.map((x: { content: string }) => x.content), ['new', 'old'], 'newest facts; no summaries, nothing replaced');
  assert.deepEqual(m.recentMemories(null), []);
  assert.deepEqual(m.latestPhotos([{ id: 1, image: 'a.jpg' }, { id: 2, image: null }, { id: 3, image: 'b.jpg' }], 4).map((x: { id: number }) => x.id), [1, 3]);
  const w = m.workItems([{ id: 1, status: 'running' }, { id: 2, status: 'ok', endedAt: new Date(now - 3600_000).toISOString() }], { tasks: [{ id: 9, status: 'waiting' }, { id: 8, status: 'done' }] }, now);
  assert.deepEqual([w.jobs.map((j: { id: number }) => j.id), w.tasks.map((x: { id: number }) => x.id), w.recent], [[1], [9], null]);
  assert.equal(m.workItems([{ id: 2, status: 'ok', endedAt: new Date(now - 3600_000).toISOString() }], null, now).recent.id, 2, 'nothing running: the one that just ended');
  assert.equal(m.workItems([{ id: 2, status: 'ok', endedAt: new Date(now - 13 * 3600_000).toISOString() }], null, now).recent, null, 'older than 12 hours: no tile');
  const ents = [{ id: 'sensor.t', name: 'T' }, { id: 'lock.door', name: 'Door' }, { id: 'light.lamp', name: 'Lamp' }, { id: 'switch.fan', name: 'Fan' }, { id: 'climate.hall', name: 'Hall' }, { id: 'light.desk', name: 'Desk' }];
  assert.deepEqual(m.pickHome(ents).map((e: { id: string }) => e.id), ['light.lamp', 'light.desk', 'switch.fan', 'climate.hall'], 'lights first, four, no sensors');
  assert.deepEqual(m.pickHome(ents, ['lock.door', 'gone.x', 'light.lamp']).map((e: { id: string }) => e.id), ['lock.door', 'light.lamp'], 'the ones picked on this device, in order');
  assert.deepEqual(m.setupItems({ weather: { setUp: false }, calendar: undefined, home: 'not-connected' }).map((x: { key: string }) => x.key), ['weather', 'calendar', 'home']);
  assert.deepEqual(m.setupItems({ weather: { setUp: true }, calendar: { events: [] }, home: 'shown' }), [], 'all set up: no tile');
  assert.deepEqual(m.setupItems({ weather: { setUp: false }, member: true }), [], 'members do not set up the owner’s connections');
  assert.deepEqual(m.setupItems({ weather: { setUp: false }, demo: true }), []);
});

test('Today tiles render from the data (weather, your day, Planner) and stay away when empty', async () => {
  const doc = todayDom();
  (globalThis as Record<string, unknown>).document = doc;
  try {
    const m = await load('today.js');
    m.renderWeather({ setUp: false });
    assert.equal(doc.querySelector('#td-weather')!.hidden, true, 'no place set: no weather tile (never a made-up one)');
    m.renderWeather({ setUp: true, place: 'Chicago', units: 'F', now: 58, code: 0, day: false, high: 70, low: 49, rain: 10, hours: [{ time: '2026-10-29T20:00', temp: 56, code: 0, day: false }] });
    const wx = doc.querySelector('#td-weather')!;
    assert.equal(wx.hidden, false);
    assert.match(wx.textContent, /Weather.*Chicago/);
    assert.match(wx.textContent, /58°/);
    assert.match(wx.textContent, /Clear/);
    assert.match(wx.textContent, /High 70°, low 49° · Rain: 10%/);
    // 2.8: a clear night is drawn as the moon (web/viz.js weather art), not an emoji.
    assert.ok(wx.all().some((n) => /\bwx-moon\b/.test(n.getAttribute('class') ?? '')), 'the moon art');
    assert.doesNotMatch(wx.textContent, /🌙/);
    m.renderWeather({ setUp: true, place: 'Chicago', error: true });
    assert.match(wx.textContent, /Couldn’t get the weather right now/, 'a failed lookup says so');
    assert.doesNotMatch(wx.textContent, /°/);

    const now = Date.now();
    const iso = (min: number) => new Date(now + min * 60_000).toISOString();
    m.renderDay({ agenda: { reminders: [{ text: 'Call Mom', dueAt: iso(30) }], tasks: [] }, calendar: { events: [{ title: 'Dinner with Mia', start: iso(90), end: iso(150), location: 'Luigi’s' }] } });
    const dayT = doc.querySelector('#td-calendar')!;
    assert.match(dayT.textContent, /Your day/);
    assert.ok(dayT.textContent.indexOf('Call Mom') < dayT.textContent.indexOf('Dinner with Mia'), 'in time order');
    assert.match(dayT.textContent, /Luigi’s/);
    m.renderDay({ agenda: { reminders: [], tasks: [] } });
    assert.match(dayT.textContent, /Nothing planned\. Enjoy the space\./, 'no calendar connected and nothing due (Phase 111 words)');
    m.renderDay({ agenda: { reminders: [], tasks: [] }, calendar: { events: [], error: 'Google said no' } });
    assert.match(dayT.textContent, /Google said no/, 'the calendar’s own error stays visible');

    m.renderPlanner({ agenda: { tasks: [{ id: 4, title: 'Finish the slides', dueAt: iso(-60), overdue: true }, { id: 5, title: 'Book Lisbon', dueAt: null }] } }, () => 'Thu 5 PM');
    const pl = doc.querySelector('#td-agenda')!;
    assert.match(pl.textContent, /Planner.*To-dos: 2/);
    assert.match(pl.textContent, /Finish the slides.*overdue · Thu 5 PM/);
    assert.match(pl.textContent, /Book Lisbon.*important/);
    assert.match(pl.textContent, /Open the Planner/);
    const tick = pl.querySelector('.td-tick')!;
    assert.equal(tick.getAttribute('aria-label'), 'Mark “Finish the slides” done', 'each tick says what it does');
    m.renderPlanner({ agenda: { tasks: [] } }, () => '');
    assert.match(pl.textContent, /Nothing due today\./);
  } finally {
    delete (globalThis as Record<string, unknown>).document;
  }
});

test('Today tiles: everything comes from the one batched GET /api/today; home changes go through her or the switch rule', () => {
  // Phase 111 (TD1): no per-tile fetches any more; memories, moments, work and home are parts of /api/today.
  assert.doesNotMatch(todayJs, /ctx\.api\('\/(memories\?kind=fact|moments|jobs|team|today\/weather)'\)/);
  assert.match(app, /api\(`\/today\$\{fresh \? '\?fresh=1' : ''\}`\)/);
  assert.match(todayJs, /ctx\.api\(`\/today\?parts=\$\{/, 'live parts reload by name');
  // Home Assistant: switches and picked scenes go through the existing switch route (and its rule);
  // everything else keeps "Ask Sara", which fills the message box (the owner sends it).
  assert.doesNotMatch(todayJs, /\/home\/(services|call|control)/);
  assert.match(todayJs, /btn\('td-dev-ask ghost small', t\('Ask Sara'\), \(\) => askAbout\(e\)\)/);
  assert.match(app, /async function askInChat\(text\) \{[\s\S]*?\$\('#input'\)\.value = text;[\s\S]*?\$\('#input'\)\.focus\(\);\n\}/);
  assert.doesNotMatch(app.slice(app.indexOf('async function askInChat'), app.indexOf('initToday({')), /sendMessage|runStream|submit/, 'never sent for the owner');
  // Demo and members: no home tile (the server leaves the part out too).
  assert.match(todayJs, /if \(!h \|\| ctx\.demo\(\) \|\| ctx\.member\(\)\) \{\n {4}tile\.hidden = true;/);
  // The checklist, the briefing ask and refresh stay on Today.
  assert.match(app, /\$\('#td-ask'\)\.addEventListener\('click'/);
  assert.match(app, /\$\('#td-refresh'\)\.addEventListener\('click', \(\) => loadToday\(true\)\);/);
  assert.match(app, /async function openToday\(\) \{[\s\S]*?loadChecklist\(\)/);
});

// ---------- the phone's bottom bar ----------

test('bottom bar: Chat, Today, Planner, More at phone width, 44 px targets, safe area, away while typing', async () => {
  const main = html.slice(html.indexOf('<section id="main"'), html.indexOf('</section>', html.indexOf('<aside id="her-panel"')));
  const at = main.indexOf('<nav id="bottom-bar" class="bottom-bar" aria-label="Places">');
  assert.ok(at > main.indexOf('</main>'), 'after the chat column, inside the app');
  const bar = main.slice(at, main.indexOf('</nav>', at));
  assert.deepEqual([...bar.matchAll(/<button id="(bb-[a-z]+)" class="bb-btn" type="button" data-bb="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ['bb-chat:chat', 'bb-today:today', 'bb-planner:planner', 'bb-more:more']);
  assert.match(bar, /data-bb="more" aria-controls="sidebar" aria-expanded="false"/);
  // The drawer stays for conversations.
  assert.match(html, /<button id="toggle-sidebar" class="ghost" aria-label="Conversations"><i class="ic" data-icon="menu"><\/i><\/button>/);
  assert.match(todayCss, /\.bottom-bar \{ display: none; \}\n@media \(max-width: 720px\) \{/);
  const phone = todayCss.slice(todayCss.indexOf('@media (max-width: 720px) {'));
  assert.match(phone, /padding: 4px max\(6px, env\(safe-area-inset-left\)\) var\(--safe-b\) /, 'above the home indicator (2.7.1: through --safe-b, theme.css)');
  assert.match(phone, /\.bb-btn \{[^}]*min-height: 52px;/, 'taller than 44 px');
  assert.match(phone, /html\.kb-up \.bottom-bar \{ display: none; \}/);
  assert.match(phone, /#main \{ grid-template-rows: minmax\(0, 1fr\) auto; \}/, 'its own row: never over the composer');
  assert.match(phone, /\.bb-btn\[aria-current="page"\]/, 'the current place is lit');
  assert.match(phone, /dialog:modal:not\(\.ring, \.lightbox, \.cmdbar, \[data-required\]\)/, 'windows leave it visible; the call screen and required questions cover it');
  // The her-panel sheet (z 50), the call screen (z 60) and the tour (z 1000+) sit above it (z 8).
  assert.match(phone, /\.bottom-bar \{[^}]*z-index: 8;/);
  const m = await load('bottom-bar.js');
  assert.equal(m.currentPlace({}), 'chat');
  assert.equal(m.currentPlace({ today: true }), 'today');
  assert.equal(m.currentPlace({ today: true, planner: true }), 'planner', 'a window over Today wins');
  assert.equal(m.currentPlace({ otherWindow: true }), 'more');
  assert.equal(m.currentPlace({ drawer: true }), 'more');
  const field = (tag: string, type = '', extra: Record<string, unknown> = {}) => ({ matches: (s: string) => s === tag, type, readOnly: false, isContentEditable: false, ...extra });
  assert.equal(m.typesText(field('textarea')), true);
  assert.equal(m.typesText(field('input', 'text')), true);
  assert.equal(m.typesText(field('input', 'checkbox')), false);
  assert.equal(m.typesText(field('input', 'search')), true);
  assert.equal(m.typesText(field('button')), false);
  assert.equal(m.typesText(null), false);
  // A tap on the bar under a window closes it the normal way (its ✕, so unsaved changes ask first).
  assert.match(barJs, /const x = d\.querySelector\(':scope > \.dialog-top > \.dialog-x'\);/);
  assert.match(barJs, /d\.id !== 'setup' && !d\.dataset\.required && !d\.matches\('\.ring, \.lightbox, \.cmdbar'\)/);
});

test('tour: steps for Today’s tiles and the bottom bar (phones), the sidebar place (wider screens)', () => {
  const first = app.slice(app.indexOf('  first: ['), app.indexOf('  studio: ['));
  assert.match(first, /\{ when: \(\) => !phoneWidth\(\), before: navStep\('#open-today'\), sel: '#open-today'/);
  assert.match(first, /\{ when: \(\) => phoneWidth\(\), before: sidebar\(false\), sel: '#bottom-bar'/);
  assert.match(first, /sel: '#td-tiles', title: t\('Your day as tiles'\)/);
  assert.match(app, /const steps = TOURS\[name\]\?\.filter\(\(s\) => !s\.when \|\| s\.when\(\)\);/);
  assert.match(app, /const phoneWidth = \(\) => matchMedia\('\(max-width: 720px\)'\)\.matches;/);
});

// ---------- every screen on the tokens ----------

test('tokens everywhere: no old pinks, no hard-coded colours or shadows outside theme.css', () => {
  const css = readdirSync(join(ROOT, 'web')).filter((f) => f.endsWith('.css'));
  const OLD_PINKS = /#(c76b98|d47ba0|e0789a|c94f78|f3a6bf|a83d61|d6497f|ff5a6e|b3383d|121016|1b1820)\b/i;
  for (const f of css) {
    if (f === 'theme.css') continue;
    const src = web(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, OLD_PINKS, `${f}: old pinks / old surfaces`);
    // Apart from the stand-in window buttons of the ?shell=mac test mode, every colour is a token.
    const hits = [...src.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((m) => m[0]);
    const allowed = f === 'look.css' ? ['#ff5f57', '#febc2e', '#28c840'] : [];
    assert.deepEqual(hits.filter((h) => !allowed.includes(h.toLowerCase())), [], `${f}: colours outside theme.css`);
  }
  // The palettes that remain (accent picks, her glow by mood, the night-sky chat background) live in theme.css.
  const theme = web('theme.css');
  for (const s of [':root[data-accent="lavender"]', '.ap-swatch[data-accent="ocean"]', '.hp-glow[data-mood="happy"]', ':root[data-chatbg="stars"] #messages', '--scrim:', '--danger-fill:', '--call-bg:', '--btn-fill:']) assert.ok(theme.includes(s), s);
  // Every page that shows our UI loads the theme first (no flash, Night or Day).
  for (const f of ['index.html', 'offline.html', 'help.html', 'privacy.html', 'support.html', 'pair.html', 'device.html']) {
    const head = web(f).slice(0, web(f).indexOf('</head>'));
    const boot = head.indexOf('<script src="/theme-boot.js"></script>');
    assert.ok(boot > 0 && boot < head.indexOf('<link rel="stylesheet"'), `${f}: theme-boot before the stylesheets`);
    assert.match(head, /<link rel="stylesheet" href="\/theme.css">/, `${f}: the tokens`);
    assert.doesNotMatch(web(f), /\sstyle="|<style\b/, `${f}: no inline styles`);
  }
  assert.match(html, /<link rel="stylesheet" href="\/her-panel.css">\s*<link rel="stylesheet" href="\/today.css">\s*<link rel="stylesheet" href="\/screens.css">/);
  // Primary buttons: the deep rose → violet with white text (AA), or a picked accent with its own text colour.
  const screens = web('screens.css');
  assert.match(screens, /button \{[^}]*background: var\(--btn-fill\);[^}]*color: var\(--on-btn\);/);
  assert.match(theme, /:root \{ --btn-fill: var\(--mine-grad\); --on-btn: var\(--on-mine\); \}/);
  assert.match(screens, /\.settings-nav-item\[aria-current="true"\] \{ background: var\(--accent-soft\);/, 'the open Settings page is tinted, not a solid pink bar');
});

// ---------- the quick-ask shortcut picker ----------

test('quick ask picker: only inside the Windows / Mac app, from the bridge’s list, with a ? tip', () => {
  const page = html.slice(html.indexOf('data-page="desktop-app"'), html.indexOf('</section>', html.indexOf('data-page="desktop-app"')));
  assert.match(html, /<section class="settings-page desktop-only" data-page="desktop-app"/);
  assert.match(page, /<div id="dk-quick-row" class="add-row dk-quick" hidden>\s*<label>Quick ask shortcut <select id="dk-quick" data-noauto><\/select><\/label>\s*<button id="dk-quick-try" type="button" class="ghost">Try it<\/button>/);
  // The page is listed only with the bridge, and the controls are wired only then.
  assert.match(app, /!\(p\.dataset\.page === 'desktop-app' && !window\.SaraDesktop\)/);
  const wired = app.slice(app.indexOf('if (window.SaraDesktop) {\n  document.documentElement.classList.add(\'in-desktop\');'));
  assert.match(wired.slice(0, 2500), /\$\('#dk-quick'\)\.addEventListener\('change'[\s\S]*?call\('setPref', \{ key: 'quickAskShortcut', value: \$\('#dk-quick'\)\.value \}\)/);
  assert.match(wired.slice(0, 2500), /\$\('#dk-quick-try'\)\.addEventListener\('click', \(\) => void window\.SaraDesktop\.call\('quickAsk'\)/);
  // The list comes from getPrefs(); an older app without it keeps the row hidden.
  const fn = /function quickAskOptions\(p\) \{[\s\S]*?\n\}/.exec(app)![0];
  const quickAskOptions = new Function('t', `${fn}; return quickAskOptions;`)((s: string) => (s === 'Off' ? 'Aus' : s));
  assert.deepEqual(quickAskOptions({ quickAskShortcuts: [{ id: 'alt+shift+s', label: 'Alt+Shift+S' }, { id: 'off', label: 'Off' }] }), [{ id: 'alt+shift+s', label: 'Alt+Shift+S' }, { id: 'off', label: 'Aus' }], 'Off in the app’s language');
  assert.deepEqual(quickAskOptions({}), []);
  assert.deepEqual(quickAskOptions(null), []);
  assert.match(app, /\$\('#dk-quick-row'\)\.hidden = !opts\.length;/);
  assert.match(app, /p\.quickAskShortcutFree === false \? t\('\(used by another app\)'\) : ''/);
  const tips = JSON.parse(web('tips.json')).tips;
  assert.ok(tips['dk-quick'] && tips['dk-quick'][0].length <= 260 && tips['dk-quick'][1] === 'desktop');
});

// ---------- GET /api/today/weather ----------

test('GET /api/today/weather: from the briefing place, structured, cached, honest when it fails', async (t) => {
  const { dir, cleanup } = tempDir();
  const sara = makeApp(dir, { now: new Date('2026-10-29T23:00:00Z') });
  const auth = new OwnerAuth(sara.dataDir);
  const server = createSaraServer({ app: sara, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const asked: string[] = [];
  let fail = false;
  setNetTransport((async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (fail) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify({
      current: { time: '2026-10-29T18:00', temperature_2m: 57.6, weather_code: 0, is_day: 0 },
      hourly: { time: ['2026-10-29T18:00', '2026-10-29T19:00', '2026-10-29T20:00', '2026-10-29T21:00', '2026-10-29T22:00', '2026-10-29T23:00'], temperature_2m: [58, 56.4, 54, 52, 51, 50], weather_code: [0, 0, 1, 2, 3, 61], is_day: [0, 0, 0, 0, 0, 0] },
      daily: { temperature_2m_max: [70.2], temperature_2m_min: [48.8], precipitation_probability_max: [10], weather_code: [1] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  t.after(() => {
    setNetTransport();
    clearWeatherCache();
    server.close();
    sara.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (path: string, token = auth.newToken) => {
    const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  clearWeatherCache();
  assert.deepEqual((await get('/today/weather')).body, { setUp: false }, 'no place: nothing to show, nothing fetched');
  assert.equal(asked.length, 0);
  sara.settings.update({ briefing: { enabled: false, time: '07:30', units: 'F', place: { name: 'Chicago, Illinois, US', lat: 41.85, lon: -87.65 } } });
  const r = await get('/today/weather');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    setUp: true, place: 'Chicago', units: 'F', now: 58, code: 0, high: 70, low: 49, rain: 10, day: false,
    hours: [{ time: '2026-10-29T19:00', temp: 56, code: 0, day: false }, { time: '2026-10-29T20:00', temp: 54, code: 1, day: false }, { time: '2026-10-29T21:00', temp: 52, code: 2, day: false }, { time: '2026-10-29T22:00', temp: 51, code: 3, day: false }],
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=41\.85&longitude=-87\.65&/);
  assert.match(asked[0], /temperature_unit=fahrenheit/);
  await get('/today/weather');
  assert.equal(asked.length, 1, 'cached for a while');
  clearWeatherCache();
  fail = true;
  assert.deepEqual((await get('/today/weather')).body, { setUp: true, place: 'Chicago', units: 'F', error: true }, 'a failed lookup says so; no made-up weather');
  assert.equal((await get('/today/weather', '')).status, 401, 'signed-in only');
  // The plain Today route is unchanged.
  assert.equal((await get('/today')).status, 200);
});

// Phase 128 (PL2b, docs/design/POLISH2.md N27, Q6): Next steps on Today.
test('Today: Next steps shows exactly three cards per use path once Getting started is complete, never while it isn’t', async () => {
  const ns = await import(pathToFileURL(join(ROOT, 'web', 'next-steps.js')).href);
  const items = (done: boolean[]) => done.map((d, i) => ({ id: `s${i}`, label: 'x', hint: '', done: d, open: 'chat' }));
  const pages = new Set([...html.matchAll(/data-page="([\w-]+)"/g)].map((m) => m[1]));
  for (const path of ['company', 'coding', 'both']) {
    const cards = ns.nextSteps({ path, hidden: false, items: items([true, true, true, true, true, true, true]) });
    assert.equal(cards.length, 3, path);
    assert.equal(new Set(cards.map((c: { id: string }) => c.id)).size, 3, `${path}: three different cards`);
    for (const c of cards) {
      assert.ok(c.title && c.text && c.icon, `${path}/${c.id}`);
      assert.ok(c.open === 'slash' || pages.has(c.open.replace(/^settings:/, '')), `${path}/${c.id}: ${c.open}`);
    }
    // Never while a step is left, never when hidden on this device, never without the list.
    assert.deepEqual(ns.nextSteps({ path, hidden: false, items: items([true, true, false, true, true, true, true]) }), [], `${path}: a step left`);
    assert.deepEqual(ns.nextSteps({ path, items: items([true, true, true, true, true, true, true]) }, true), [], `${path}: hidden`);
  }
  assert.deepEqual(ns.nextSteps(null), []);
  // Company and both point at the chat apps, the Store and Hey Sara; coding at /, tool servers, chat apps.
  const opens = (path: string) => ns.nextSteps({ path, items: items([true]) }).map((c: { open: string }) => c.open);
  assert.deepEqual(opens('company'), ['settings:co-telegram', 'settings:ab-store', 'settings:her-hey']);
  assert.deepEqual(opens('coding'), ['slash', 'settings:ab-store', 'settings:co-telegram']);
  assert.deepEqual(opens('anything else'), opens('both'));
  // The card sits where Getting started is, with its ? and Hide; Getting started still opens the same steps.
  assert.match(html, /<section id="td-next" class="today-start today-next" aria-labelledby="td-next-title" hidden>/);
  assert.match(html, /<button id="td-next-hide" type="button" class="ghost small">Hide<\/button>/);
  assert.match(app, /paintNextSteps\(c\);\n\s*\$\('#td-start'\)\.hidden = !c \|\| c\.hidden \|\| !left\.length;/);
});
