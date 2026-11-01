// Phase 112 (TD2, 2.45.0): Today on phones and tablets (docs/design/TODAY.md §7, §12.2). The phone
// order (Now first, then Needs you, Your day, Weather, Mail, then the owner's sections), the
// form factors, collapsing remembered per companion and per form factor (and the "when Today
// opens" setting), pull to refresh, the return refresh, the tablet's two tracks, the Esc/back
// order, phone-app requests and adults-only photos, the optional away sentence in her voice (off by
// default) and Include rooms (off by default), and the static UI rules at phone and tablet widths.
// Everything runs against fakes: fake clocks, no real network, no real model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { logLine, setRoom } from '../src/bridges/keepup.ts';
import type { AppContext } from '../src/chat.ts';
import { createSaraServer } from '../src/server.ts';
import { buildToday } from '../src/today.ts';
import { defaultPrefs, getLayout, normalizePrefs, putLayout, resetLayout, setSeen } from '../src/today-layout.ts';
import { awayVoiceFor, todayLoaders } from '../src/today-parts.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const LOCAL: ProviderConfig = { id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'local-m' };

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const NOW = new Date('2026-10-31T15:00:00Z'); // 10:00 in Chicago

/** A web module in Node (its naming.js import becomes a small stand-in). */
async function load(file: string) {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US';";
  const fix = (src: string) => src.replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  let src = fix(web(file));
  if (file === 'today-layout.js') src = src.replace(/from '\.\/today\.js';/, `from 'data:text/javascript;base64,${Buffer.from(fix(web('today.js'))).toString('base64')}';`);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

function setup(t: { after: (fn: () => void) => void }, o: { member?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(NOW) };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  if (o.member) (app as AppContext).member = { today: () => ({ messages: 3, usd: 0.01 }) } as unknown as AppContext['member'];
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir, clock };
}
const allParts = () => todayLoaders({ approvals: () => [] });
type Group = { id: string; tiles: { id: string; shown: boolean }[]; single: boolean; swipe: boolean };
const visibleIds = (groups: Group[]) => groups.flatMap((g) => g.tiles.filter((x) => x.shown).map((x) => x.id));

// ------------------------------------------------------------------ 1 · the phone order

test('112.1 phoneOrder: Now first, then Needs you, Your day, Weather, Mail, then the owner’s sections; hidden stays hidden; DOM order is the visual order', async () => {
  const m = await load('today.js');
  const groups = m.phoneOrder(defaultPrefs()) as Group[];
  assert.deepEqual(groups.map((g) => g.id), ['now', 'needs', 'day', 'weather', 'mail', 'her', 'work', 'more']);
  assert.deepEqual(visibleIds(groups).slice(0, 5), ['td-now', 'td-needs', 'td-calendar', 'td-weather', 'td-mail']);
  // Coming up (the rest of Your day) goes with Home & more, first; With her and Work are swipe rows.
  assert.equal(groups.find((g) => g.id === 'more')!.tiles[0].id, 'td-dates');
  assert.deepEqual(groups.filter((g) => g.swipe).map((g) => g.id), ['her', 'work']);
  // The owner moved Work above With her and hid Usage today: both apply; Now can't be hidden.
  const p = normalizePrefs({ sections: ['work', 'day', 'needs', 'her', 'more'], tiles: { 'td-usage': { hidden: true }, 'td-weather': { hidden: true } } });
  const g2 = m.phoneOrder(p) as Group[];
  assert.deepEqual(g2.map((g) => g.id), ['now', 'needs', 'day', 'weather', 'mail', 'work', 'her', 'more'], 'a moved section moves');
  assert.ok(!visibleIds(g2).includes('td-usage') && !visibleIds(g2).includes('td-weather'), 'hidden stays hidden');
  assert.equal(visibleIds(g2)[0], 'td-now');
  // A member's phone has no owner-only tiles.
  assert.ok(!visibleIds(m.phoneOrder(defaultPrefs(), { member: true })).some((id: string) => ['td-usage', 'td-projects', 'td-home', 'td-setup'].includes(id)));
  // DOM order = visual order: Today's stylesheet never reorders with `order:`; the page is built by appending in phoneOrder.
  assert.doesNotMatch(web('today.css'), /[{;\s]order:\s*-?\d/);
  const js = web('today.js');
  assert.match(js, /for \(const g of phoneOrder\(prefs, \{ member: ctx\?\.member\?\.\(\) \}\)\) \{[\s\S]{0,200}root\.append\(node\)/);
});

// ------------------------------------------------------------------ 2 · 390 px: one column, compact header, swipe rows

test('112.2 at 390 px: a phone; one column; the compact header; With her and Work as swipe rows with snap and region labels; every card reachable by Tab', async () => {
  const m = await load('today.js');
  assert.equal(m.formFactor({ viewport: 390, container: 366, coarse: true }), 'phone');
  assert.equal(m.formFactor({ viewport: 320, container: 296, coarse: true }), 'phone');
  assert.equal(m.formFactor({ viewport: 430, container: 406, coarse: false }), 'phone', 'a narrow window gets the phone view too');
  const css = web('today.css');
  assert.match(css, /#today\.td-ff-phone \.td-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  // The compact header: her face, the greeting, Refresh and Customise as 44 px icons (the words stay for screen readers).
  assert.match(css, /#today\.td-ff-phone \.td-hero \{[^}]*grid-template-areas: "face greet ref cus" "face badge ref cus" "status status status status";/);
  assert.match(css, /#today\.td-ff-phone \.td-hbtn \{ width: 44px; min-width: 44px; min-height: 44px;/);
  assert.match(css, /#today\.td-ff-phone \.td-date, #today\.td-ff-phone \.td-her, #today\.td-ff-phone \.td-fresh \{ display: none; \}/);
  const html = web('index.html');
  assert.match(html, /<button id="td-refresh"[^>]*><i class="ic" data-icon="update"><\/i><span class="td-btn-text">Refresh<\/span><\/button>/);
  // Swipe rows: scroll-snap, the next card peeks (85%), overscroll kept in the row.
  assert.match(css, /#today\.td-ff-phone \.td-swipe > \.td-grid \{[^}]*overflow-x: auto;[^}]*overscroll-behavior-x: contain;[^}]*scroll-snap-type: x mandatory;/);
  assert.match(css, /\.td-swipe > \.td-grid > \.td-tile \{ flex: 0 0 85%; scroll-snap-align: start; \}/);
  const js = web('today.js');
  assert.match(js, /grid\.setAttribute\('role', 'region'\);\s*grid\.setAttribute\('aria-label', groupTitle\(g\.id\)\);/, 'the row is a region named after its section');
  // A visible way to move without swiping (and the dots are decorative).
  assert.match(js, /btn\('ghost icon td-swipe-prev', '‹'[\s\S]{0,120}t\('Previous card'\)/);
  assert.match(js, /btn\('ghost icon td-swipe-next', '›'[\s\S]{0,120}t\('Next card'\)/);
  assert.match(js, /dots\.setAttribute\('aria-hidden', 'true'\)/);
  // Every card is reachable by Tab: each tile keeps tabindex="0" (the row scrolls a focused card into view).
  for (const id of ['td-memories', 'td-otd', 'td-plans', 'td-jobs', 'td-board', 'td-projects', 'td-usage']) assert.match(html, new RegExp(`id="${id}"[^>]*tabindex="0"`), id);
  // No horizontal swipe on a row ever completes or deletes anything: the row has no swipe handlers of its own.
  assert.doesNotMatch(js, /\.td-swipe[^\n]*addEventListener\('touch/);
});

// ------------------------------------------------------------------ 3 · collapsing, per companion and per form factor

test('112.3 collapse: saved per companion and per form factor; the desktop never collapses; “when Today opens” overrides; Needs you keeps its count', async (t) => {
  const a = setup(t);
  const b = setup(t);
  const auth = new OwnerAuth(a.app.dataDir);
  const server = createSaraServer({ app: a.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  a.app.settings.update({ disclosureAcceptedAt: NOW.toISOString() });
  const put = async (body: unknown) => {
    const r = await fetch(`${base}/today/layout`, { method: 'PUT', headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json', origin: base.replace('/api', '') }, body: JSON.stringify(body) });
    return { status: r.status, prefs: ((await r.json()) as { prefs: ReturnType<typeof defaultPrefs> }).prefs };
  };
  const r1 = await put({ collapsed: { phone: ['work', 'mail', 'nope'] } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.prefs.collapsed, { phone: ['work', 'mail'], tablet: [] }, 'unknown groups dropped; the tablet untouched');
  const r2 = await put({ collapsed: { tablet: ['her'] } });
  assert.deepEqual(r2.prefs.collapsed, { phone: ['work', 'mail'], tablet: ['her'] }, 'one form factor at a time');
  assert.deepEqual(getLayout(b.app).prefs.collapsed, { phone: [], tablet: [] }, 'per companion');
  assert.deepEqual(resetLayout(a.app).collapsed, { phone: ['work', 'mail'], tablet: ['her'] }, 'Reset puts tiles back, not the open/closed sections');
  const m = await load('today.js');
  const p = getLayout(a.app).prefs;
  assert.deepEqual(m.collapsedAtOpen(p, 'phone'), ['work', 'mail']);
  assert.deepEqual(m.collapsedAtOpen(p, 'tablet'), ['her']);
  assert.deepEqual(m.collapsedAtOpen(p, 'desktop'), [], 'collapsing on a phone never collapses the desktop');
  assert.deepEqual(m.collapsedAtOpen({ ...p, phoneOpen: 'all' }, 'phone'), [], 'Everything open');
  assert.deepEqual(m.collapsedAtOpen({ ...p, phoneOpen: 'now' }, 'phone'), ['day', 'her', 'work', 'more', 'weather', 'mail'], 'Only Now open (Needs you never collapses by itself)');
  assert.deepEqual(m.collapsedAtOpen({ ...p, phoneOpen: 'now' }, 'tablet'), ['her'], 'the phone setting is for phones');
  // The heading is a 44 px disclosure button; Needs you's count shows open or shut; the rest summarise when shut.
  const js = web('today.js');
  assert.match(js, /b\.setAttribute\('aria-expanded', 'true'\);\s*b\.setAttribute\('aria-controls', grid\.id\);/);
  assert.match(js, /if \(d && id === 'needs'\) \{\s*const n = needsItems\(d\)\.length;/);
  assert.match(js, /\} else if \(d && shut\) words = groupSummary\(id, d, node\);/);
  assert.match(web('today.css'), /\.td-sec-toggle \{[^}]*min-height: 44px;/);
  assert.match(web('today-layout.js'), /export function saveCollapsed\(form, list\) \{\s*if \(!prefs \|\| \(form !== 'phone' && form !== 'tablet'\)\) return;/);
});

// ------------------------------------------------------------------ 4 · pull to refresh

test('112.4 pull to refresh: past 64 px at scrollTop 0 refreshes once; not when scrolled; a sideways swipe lets go; reduced motion shows only the spinner', async () => {
  const m = await load('today.js');
  let calls = 0;
  let release: () => void = () => {};
  const tr = m.pullTracker({ threshold: 64, onRefresh: () => new Promise<void>((r) => ((calls++), (release = r))) });
  tr.start(100, 100, 0);
  let v = tr.move(100, 150, 0);
  assert.equal(v.ready, false, '50 px is not enough');
  v = tr.move(100, 170, 0);
  assert.equal(v.ready, true);
  assert.ok(v.step > 0 && v.step <= 8, 'the spinner travels with the finger');
  assert.equal(tr.end().fired, true);
  assert.equal(tr.end().fired, false, 'a second release does nothing');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1, 'loadToday(true) once');
  // While it loads, a new pull doesn't start another one.
  tr.start(100, 100, 0);
  tr.move(100, 200, 0);
  assert.equal(tr.end().fired, false);
  release();
  await new Promise((r) => setTimeout(r, 0));
  // Scrolled down: never.
  tr.start(100, 100, 120);
  tr.move(100, 220, 120);
  assert.equal(tr.end().fired, false, 'not at scrollTop > 0');
  // The page started scrolling during the pull: let go.
  tr.start(100, 100, 0);
  tr.move(100, 140, 0);
  tr.move(100, 200, 30);
  assert.equal(tr.end().fired, false);
  // Sideways (a swipe row): let go.
  tr.start(100, 100, 0);
  tr.move(160, 110, 0);
  tr.move(160, 200, 0);
  assert.equal(tr.end().fired, false);
  assert.equal(calls, 1);
  // Reduced motion: no travel, the spinner only.
  const quiet = m.pullTracker({ onRefresh: () => {}, reduced: () => true });
  quiet.start(0, 0, 0);
  const q = quiet.move(0, 120, 0);
  assert.equal(q.step, 0);
  assert.equal(q.ready, true);
  const css = web('today.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.td-pull \.td-pull-spin, \.td-pull\[data-step\] \.td-pull-spin \{ transform: translateY\(8px\); transition: none; \}/);
  // One web gesture everywhere: passive touch listeners on Today's scroll area; the browser's own pull stays off.
  const js = web('today.js');
  assert.match(js, /sc\.addEventListener\('touchstart', [\s\S]{0,200}\{ passive: true \}\);/);
  assert.match(js, /onRefresh: async \(\) => \{[\s\S]{0,120}await ctx\.refresh\?\.\(\);/);
  assert.match(web('app.js'), /refresh: \(\) => loadToday\(true\),/);
  assert.match(css, /\.td-scroll \{[^}]*overscroll-behavior: contain;/);
  // Neither phone app wraps the web view in a native pull (it would reload the whole page).
  assert.doesNotMatch(readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'backstagecoding', 'sara', 'MainActivity.java'), 'utf8'), /SwipeRefreshLayout/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'ios', 'Sara', 'WebView.swift'), 'utf8'), /UIRefreshControl/);
});

// ------------------------------------------------------------------ 5 · back to Today

test('112.5 return refresh: visible again after more than 2 minutes reloads only the parts past their limits', async () => {
  const m = await load('today.js');
  const now = Date.parse('2026-10-31T15:10:00Z');
  const ago = (min: number) => ({ at: new Date(now - min * 60_000).toISOString() });
  const parts = { mail: ago(3), weather: ago(3), day: ago(1), home: ago(1), memories: ago(9), layout: ago(60) };
  assert.deepEqual(m.returnParts({ hiddenAt: now - 60_000, now, parts }), [], 'a short look away reloads nothing');
  assert.deepEqual(m.returnParts({ hiddenAt: now - 3 * 60_000, now, parts }).sort(), ['home', 'mail', 'memories'], 'weather (15 min) and day (1 min old) stay; layout is never reloaded this way');
  assert.deepEqual(m.returnParts({ hiddenAt: 0, now, parts }), []);
  assert.match(web('today.js'), /const parts = todayOpen\(\) && state\.d \? returnParts\(\{ hiddenAt, parts: state\.d\.parts \?\? \{\} \}\) : \[\];\s*hiddenAt = 0;\s*if \(parts\.length\) void reloadParts\(parts\);/);
});

// ------------------------------------------------------------------ 6 · tablets

test('112.6 at 768 px: a tablet; two tracks with L spanning both; the desktop section order; no swipe rows; collapsible headings', async () => {
  const m = await load('today.js');
  assert.equal(m.formFactor({ viewport: 768, container: 700, coarse: true }), 'tablet');
  assert.equal(m.formFactor({ viewport: 820, container: 512, coarse: true }), 'tablet', 'beside the sidebar too');
  assert.equal(m.formFactor({ viewport: 1024, container: 700, coarse: false }), 'desktop', 'a desktop window keeps the desktop Today');
  assert.equal(m.formFactor({ viewport: 1366, container: 1000, coarse: true }), 'desktop');
  // Two tracks: L spans both, S and M take one, and rows are full (fillRow at the md grid).
  const model = m.layoutModel(defaultPrefs());
  const shown = model.flatMap((s: { tiles: { shown: boolean }[] }) => s.tiles.filter((x) => x.shown));
  const classes = m.spanClasses(shown.filter((x: { id: string }) => ['td-calendar', 'td-weather', 'td-dates'].includes(x.id)));
  assert.ok(classes['td-calendar'].includes('td-md-12'), 'L spans both tracks');
  assert.ok(classes['td-weather'].includes('td-md-6') && classes['td-dates'].includes('td-md-6'));
  const css = web('today.css');
  assert.match(css, /#today\.td-ff-tablet \.td-grid \{ grid-template-columns: repeat\(12, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /#today\.td-ff-tablet \.td-grid > \.td-md-6 \{ grid-column: span 6; \}/);
  // The desktop order on a tablet, and no swipe rows (they only exist under .td-ff-phone).
  const js = web('today.js');
  assert.match(js, /\} else \{\s*for \(const node of document\.querySelectorAll\('#td-tiles > \.td-pg'\)\) node\.hidden = true;\s*for \(const sec of model\) \{/);
  assert.match(js, /sectionToggle\(node, sec\.id, form === 'tablet'\);/);
  for (const rule of css.match(/[^}]*\.td-swipe > \.td-grid[^{]*\{/g) ?? []) assert.match(rule, /td-ff-phone/, `swipe rows are phone-only: ${rule.trim()}`);
  // The Now card spans the top on tablets and phones; never on the desktop.
  assert.match(js, /card\.hidden = form === 'desktop';/);
});

// ------------------------------------------------------------------ 7 · the phone apps, Esc and back

test('112.7 phone-app requests never get adults-only photos; Esc/back closes an open menu or sheet before leaving Today', async (t) => {
  const { app } = setup(t);
  app.settings.update({ adult: { on: true, confirmedAt: NOW.toISOString() } } as never);
  const asked: boolean[] = [];
  (app as AppContext).moments = { list: ({ adultOk }: { adultOk: boolean }) => (asked.push(adultOk), [{ id: 1, image: '/m/1.jpg', adult: !adultOk ? false : true, addedAt: NOW.toISOString() }]) } as never;
  await buildToday(app, { parts: ['moments'], phoneApp: true, loaders: allParts() });
  await buildToday(app, { parts: ['moments'], phoneApp: false, loaders: allParts() });
  assert.equal(asked[0], false, 'in the phone apps: never adults-only photos');
  // The route reads the app's own marker for that (fromPhoneApp), as before.
  assert.match(readFileSync(join(ROOT, 'src', 'routes', 'planner.ts'), 'utf8'), /const phoneApp = fromPhoneApp\(req\);[\s\S]{0,400}phoneApp,/);
  const m = await load('today.js');
  assert.equal(m.escAction({ menu: true, sheet: true }), 'menu');
  assert.equal(m.escAction({ sheet: true }), 'sheet');
  assert.equal(m.escAction({ other: true }), 'none');
  assert.equal(m.escAction({}), 'leave');
  const js = web('today.js');
  assert.match(js, /if \(escAction\(\{ menu: Boolean\(document\.querySelector\('#today \.td-menu'\)\), sheet: !\$\('#td-custom'\)\?\.hidden, other \}\) !== 'leave'\) return;/);
  assert.match(web('today-layout.js'), /if \(e\.key === 'Escape' && editing\(\) && !e\.defaultPrevented\) \{\s*e\.preventDefault\(\);\s*void closeSheet\(\);/);
});

// ------------------------------------------------------------------ 8 · targets and styles at 390 and 768

test('112.8 44 px targets and no inline styles at 390 and 768; safe areas through the variables; a fresh app cache', async () => {
  const css = web('today.css');
  for (const sel of ['.td-swipe-nav > button', '.td-now-acts > button', '.td-sec-toggle']) assert.match(css, new RegExp(`${sel.replace(/[.>()[\]]/g, (c) => `\\${c}`)} \\{[^}]*min-height: 44px`), `${sel} is 44 px`);
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.td-link, \.td-foot \.td-link, [^}]*min-height: 44px; \}\s*\/\*[^*]*\*\/\s*\.td-ext, \.td-mail-row, \.td-mail-link, \.td-job-actions > button \{ min-height: 44px; \}/);
  assert.match(css, /#today\.td-ff-phone \.td-face-btn \{ grid-area: face; width: 44px; \}/);
  for (const f of ['today.js', 'today-layout.js']) assert.doesNotMatch(web(f), /\.style\.|setAttribute\('style'|cssText/, `${f}: classes and data attributes only`);
  const html = web('index.html');
  const today = html.slice(html.indexOf('<dialog id="today"'), html.indexOf('</dialog>', html.indexOf('<dialog id="today"')));
  assert.doesNotMatch(today, /\sstyle=/);
  assert.doesNotMatch(css, /env\(safe-area-inset-(top|bottom)/, 'through --safe-t / --safe-b');
  assert.match(css, /#today\.td-ff-tablet \.td-scroll \{ padding-bottom: calc\(28px \+ var\(--safe-b\)\); \}/);
  // The Now card is not the timeline's Now marker (.td-now): its own class.
  assert.match(today, /<section id="td-now" class="td-nowcard"/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v46'\)/);
});

// ------------------------------------------------------------------ the Now card

test('112.N the Now card: the next two things with how soon, rain from the first wet hour; finished things are left out', async () => {
  const m = await load('today.js');
  const now = Date.parse('2026-10-31T15:00:00Z');
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  const d = {
    day: '2026-10-31',
    calendar: { events: [{ id: 'e0', title: 'Gym', start: at(-120), end: at(-60) }, { id: 'e1', title: 'Standup', start: at(18), end: at(48) }, { id: 'e2', title: 'Dentist', start: at(240), end: at(300), location: '401 Main St' }], leaveBy: [{ eventId: 'e2', leaveAt: at(215), minutes: 25 }] },
    agenda: { reminders: [], tasks: [] },
  };
  const items = m.nowItems(d, now);
  assert.deepEqual(items.map((x: { kind: string; mins: number }) => `${x.kind}:${x.mins}`), ['event:18', 'leave:215']);
  const w = { hours: [{ time: at(60), code: 2 }, { time: at(120), code: 61 }, { time: at(180), code: 63 }] };
  assert.equal(m.rainFrom(w).time, at(120));
  assert.equal(m.rainFrom({ hours: [{ time: at(60), code: 0 }] }), null);
});

// ------------------------------------------------------------------ away: her sentence and Include rooms (both off by default)

test('112.A Since you were away: her sentence (off by default, a small model call, never memory) and Include rooms (off by default, count and titles only)', async (t) => {
  const { app } = setup(t);
  assert.equal(defaultPrefs().awayVoice, false);
  assert.equal(defaultPrefs().awayRooms, false);
  setSeen(app, '2026-10-31T01:00:00Z');
  app.memory!.add({ kind: 'fact', content: 'Alex likes rye', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-31', evidence: 'x' });
  app.roomKeeper = {} as never;
  const r = noteRoom(app, { bridge: 'discord', key: '700', kind: 'room', title: 'general', parentTitle: 'Dev Crew' });
  const room = setRoom(app, r.id, { keepUp: true, model: 'local' })!;
  logLine(app, room, { platformId: 'p1', authorId: 'u', author: 'Scott', who: 'person', text: 'ROOM-SECRET-LINE', at: '2026-10-31T09:00:00Z' });
  logLine(app, room, { platformId: 'p2', authorId: 'her', author: 'Sara', who: 'her', text: 'HER-ROOM-LINE', at: '2026-10-31T09:01:00Z' });
  type A = { away?: { lines: { kind: string; n: number; titles?: string[] }[]; voice?: string; since: string } };
  const calls = app.providerCalls;
  let d = (await buildToday(app, { loaders: allParts() })) as unknown as A;
  assert.deepEqual(d.away!.lines.map((l) => l.kind), ['memories'], 'rooms off by default');
  assert.equal(d.away!.voice, undefined);
  assert.equal(app.providerCalls, calls, 'no model call by default');
  putLayout(app, { awayRooms: true });
  d = (await buildToday(app, { loaders: allParts() })) as unknown as A;
  const rooms = d.away!.lines.find((l) => l.kind === 'rooms')!;
  assert.equal(rooms.n, 1);
  assert.deepEqual(rooms.titles, ['#general · Dev Crew'], 'the room title only');
  assert.doesNotMatch(JSON.stringify(d), /ROOM-SECRET-LINE|HER-ROOM-LINE|Scott/, 'never lines or names');
  // A member never gets the rooms line (and never sees the switch).
  const mem = setup(t, { member: true });
  setSeen(mem.app, '2026-10-31T01:00:00Z');
  mem.app.memory!.add({ kind: 'fact', content: 'Jo likes tea', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-31', evidence: 'x' });
  mem.app.roomKeeper = {} as never;
  putLayout(mem.app, { awayRooms: true });
  const md = (await buildToday(mem.app, { loaders: allParts() })) as unknown as A & { layout: Record<string, unknown> };
  assert.ok(!md.away!.lines.some((l) => l.kind === 'rooms'));
  assert.equal(md.layout.awayRooms, undefined);
  // Her sentence: on, it is made once in the background by a local model from the counts only
  // (no text from anywhere), the page hears SSE today {part:'away'}, and the next answer carries it.
  app.settings.update({ providers: [LOCAL], defaultProviderId: LOCAL.id, defaultModel: LOCAL.defaultModel } as never);
  app.script.push([{ type: 'text', text: '"While you were out I learned something new about you."' }, { type: 'usage', input: 90, output: 14 }]);
  const events: string[] = [];
  app.events!.subscribe((e) => void events.push(`${e.type}:${(e as { part?: string }).part ?? ''}`));
  putLayout(app, { awayVoice: true });
  const d1 = (await buildToday(app, { loaders: allParts() })) as unknown as A;
  assert.equal(d1.away!.voice, undefined, 'not made yet: the answer never waits for a model');
  for (let i = 0; i < 50 && !awayVoiceFor(app, d1.away!.since); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(awayVoiceFor(app, d1.away!.since), 'While you were out I learned something new about you.', 'one sentence, quotes trimmed');
  assert.ok(events.includes('today:away'), 'the page hears about it');
  const sent = JSON.stringify(app.requests.at(-1));
  assert.match(sent, /you learned 1 new thing/);
  assert.doesNotMatch(sent, /rye|ROOM-SECRET-LINE|HER-ROOM-LINE|general|Scott/, 'counts only: no memory text, no room lines or titles');
  const d2 = (await buildToday(app, { loaders: allParts() })) as unknown as A;
  assert.equal(d2.away!.voice, 'While you were out I learned something new about you.');
  const before = app.requests.length;
  await buildToday(app, { loaders: allParts() });
  assert.equal(app.requests.length, before, 'made once per absence');
  assert.equal(app.memory!.list({ kind: 'fact' }).filter((x) => /While you were out/.test(x.content)).length, 0, 'never memory');
  const src = readFileSync(join(ROOT, 'src', 'today-parts.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function startAwaySentence'), src.indexOf('function away()'));
  assert.match(fn, /cheapCall\(app, \{ source: 'today-away', purpose: 'today-away'/, 'a budgeted small call (the daily ledger)');
  assert.match(fn, /let r = await ask\('local'\);\s*if \(!r\.ok && r\.skipped === 'no-model'\) r = await ask\('quick'\);/, 'a local model first');
  assert.doesNotMatch(fn, /memory\.add|app\.memory/);
  assert.match(fn, /content: awayFacts\(lines, hours\)/, 'only the counted facts go to the model');
  // The page shows it first, then the counted lines.
  assert.match(web('today.js'), /\$\('#td-away-text'\)\.textContent = `\$\{away\.voice \? `\$\{away\.voice\} ` : ''\}/);
});
