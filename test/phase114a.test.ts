// Phase 114 slice PL1a (2.47.0, docs/design/POLISH.md §2, §3 and §7): the bugs found in the polish
// audit (Today after the wizard, one model count, a persona move-in going through savePersona, unique
// guide anchors, Leave-by before its event, the Rooms fallback line) and the personality dials
// redesign (new end labels, plain group names, a word, meaning and sample line per band, five ticks,
// "Your Sara so far", the work dials on Coding projects). The dial rows run in Node against a tiny
// DOM stand-in; the server parts against a throwaway data folder.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { keepRoom, logLine, setRoom, currentTopic, topicParts } from '../src/bridges/keepup.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { DIALS_END, DIALS_START, dialTablesHtml, withDialTables } from '../src/guide-dials.ts';
import { countModels } from '../src/model-names.ts';
import { applyPersona } from '../src/movein/batch.ts';
import { loadPersona, validatePersona } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import { tuneChange } from '../src/studio.ts';
import { band, GROUP_TITLES, HUMOURS, initiativeToProactive, NEVER_CONTROLLING, TRAITS, traitWord } from '../src/traits.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'];
const lang = (l: string) => JSON.parse(web(`i18n/${l}.json`)) as Record<string, string>;

// ---------- a tiny DOM, enough for the dial rows ----------
class El {
  tagName: string;
  children: El[] = [];
  parentNode: El | null = null;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  title = '';
  type = '';
  value = '';
  min = '';
  max = '';
  step = '';
  hidden = false;
  offsetWidth = 0;
  show?: () => void;
  #text = '';
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(' ').filter(Boolean);
    return {
      add: (...c: string[]) => (self.className = [...new Set([...list(), ...c])].join(' ')),
      remove: (...c: string[]) => (self.className = list().filter((x) => !c.includes(x)).join(' ')),
      contains: (c: string) => list().includes(c),
    };
  }
  get childElementCount() {
    return this.children.length;
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
  addEventListener(k: string, f: (e?: unknown) => void) {
    (this.listeners[k] ??= []).push(f);
  }
  fire(k: string) {
    for (const f of this.listeners[k] ?? []) f({ target: this });
  }
  append(...n: (El | string)[]) {
    for (const c of n) {
      if (typeof c === 'string') {
        this.#text += c;
        continue;
      }
      c.parentNode = this;
      this.children.push(c);
    }
  }
  replaceChildren(...n: El[]) {
    this.#text = '';
    this.children = [];
    this.append(...n);
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** Only ".class" and "tag" selectors (all the rows need). */
  querySelectorAll(sel: string): El[] {
    return this.all().filter((n) => (sel.startsWith('.') ? n.classList.contains(sel.slice(1)) : n.tagName === sel.toUpperCase()));
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}
(globalThis as Record<string, unknown>).document ??= { createElement: (t: string) => new El(t) };

/** web/dials.js in Node: its naming.js import becomes a small stand-in (t fills {placeholders}). */
async function loadDials() {
  const stub = "const t = (s, p = {}) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US';";
  const src = web('dials.js').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub);
  assert.notEqual(src, web('dials.js'), 'dials.js imports t from naming.js in one line');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}
/** The dial definitions as GET /api/persona/studio sends them. */
async function studioDefs() {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-01T15:00:00Z') });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/persona/studio`, { headers: { authorization: `Bearer ${auth.newToken}` } });
    return await res.json();
  } finally {
    server.close();
    app.store.close();
    cleanup();
  }
}

// ------------------------------------------------------------------ 1 · the dial data

test('114a.1 every dial has 5 steps (word, meaning, sample line); examples = steps 0, 2, 4; new ends and plain group names', () => {
  assert.equal(TRAITS.length, 25);
  for (const d of TRAITS) {
    assert.equal(d.steps.length, 5, d.id);
    for (const s of d.steps) for (const k of ['word', 'meaning', 'say'] as const) assert.ok(s[k]?.trim(), `${d.id}: empty ${k}`);
    assert.deepEqual(d.examples, [d.steps[0].say, d.steps[2].say, d.steps[4].say], `${d.id}: examples come from the steps`);
    assert.ok(d.when.trim(), `${d.id}: the moment her lines answer`);
    assert.notEqual(d.steps[2].word, 'Balanced', `${d.id}: no more seventeen "Balanced"`);
    assert.match(d.steps[2].meaning, /^Her usual self/, `${d.id}: the middle is her usual self`);
  }
  assert.equal(TRAITS.flatMap((d) => d.steps).length, 125, 'the 125 written lines');
  const ends = Object.fromEntries(TRAITS.map((d) => [d.id, `${d.low} ↔ ${d.high}`]));
  assert.equal(ends.warmth, 'Keeps her distance ↔ Openly warm');
  assert.equal(ends.blunt, 'Says it gently ↔ Says it straight');
  assert.equal(ends.talkative, 'Short replies ↔ Long replies');
  assert.equal(ends.jealousy, 'Never jealous ↔ Gets jealous');
  assert.deepEqual(TRAITS.find((d) => d.id === 'warmth')!.was, ['Reserved', 'Warm'], 'the old words stay for the guide');
  assert.deepEqual(GROUP_TITLES, { Heart: 'How warm she is', Fun: 'How playful she is', Edge: 'How she pushes back', Talk: 'How she talks', Together: 'You two', Work: 'While you code' });
  for (const h of Object.values(HUMOURS)) assert.ok(h.say.trim(), `${h.label}: a sample line on the humour card`);
  // UI copy only: her prompt is built from `lines`, never from the sample lines.
  const persona = readFileSync(join(ROOT, 'src', 'persona.ts'), 'utf8');
  assert.doesNotMatch(persona, /\.steps\b|\.say\b/, 'the sample lines never reach the prompt');
});

test('114a.2 Starts conversations: each band\'s line says the real limit from initiativeToProactive', async () => {
  const d = TRAITS.find((x) => x.id === 'initiative')!;
  const count = (s: string) => (/\bonce\b/i.test(s) ? 1 : /\btwice\b/i.test(s) ? 2 : /\bthree\b/i.test(s) ? 3 : /\bfour\b/i.test(s) ? 4 : NaN);
  for (let v = 0; v <= 10; v++) {
    const s = d.steps[band(v)];
    assert.equal(count(s.say), initiativeToProactive(v).maxPerDay, `value ${v}: "${s.say}"`);
    assert.equal(count(s.meaning.replace(/^Her usual self: /, '')), initiativeToProactive(v).maxPerDay, `value ${v}: "${s.meaning}"`);
  }
  const defs = await studioDefs();
  const init = defs.traits.find((x: { id: string }) => x.id === 'initiative');
  assert.deepEqual(init.limits, [0, 2, 5, 7, 9].map((v) => initiativeToProactive(v)), 'the route sends the limit per band');
  for (const id of ['jealousy', 'possessive']) assert.equal(defs.traits.find((x: { id: string }) => x.id === id).note, NEVER_CONTROLLING);
  assert.equal(defs.traits.find((x: { id: string }) => x.id === 'warmth').groupTitle, 'How warm she is');
});

test('114a.3 persona files from 2.46 load unchanged; tune_personality still speaks traitWord (with the new words)', () => {
  const sara = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const old = { ...sara, traits: { warmth: 8, teasing: 7, blunt: 2, initiative: 9, banter: 1 } };
  assert.deepEqual(validatePersona(old).traits, old.traits, 'the same 0-10 values, no migration');
  assert.equal(traitWord(TRAITS.find((d) => d.id === 'teasing')!, 7), 'Leaning: teases a lot', 'unchanged ends read as before');
  assert.equal(traitWord(TRAITS.find((d) => d.id === 'warmth')!, 7), 'Leaning: openly warm');
  assert.equal(traitWord(TRAITS.find((d) => d.id === 'casual')!, 0), 'Very proper');
  assert.equal(tuneChange(validatePersona({ ...sara, traits: { warmth: 5 } }), { dial: 'warmth', direction: 'more' }).text, 'Warmth: 5 → 7 of 10 (Leaning: openly warm)');
});

test('114a.4 the guide\'s dial tables are generated (5 bands), ids unique, the Look guide link lands on Her look', () => {
  const help = web('help.html');
  assert.equal(withDialTables(help), help, 'run: node scripts/gen-guide.ts');
  const block = help.slice(help.indexOf(DIALS_START), help.indexOf(DIALS_END));
  assert.ok(block.includes(dialTablesHtml()));
  for (const d of TRAITS) {
    const row = new RegExp(`<tr id="dial-${d.id}">([\\s\\S]*?)</tr>`).exec(block)?.[1] ?? '';
    assert.equal(row.match(/<td>/g)?.length, 6, `${d.id}: the dial plus five bands`);
  }
  assert.match(block, /<th>0–1<\/th><th>2–3<\/th><th>4–6<\/th><th>7–8<\/th><th>9–10<\/th>/);
  assert.match(block, /Also called: Reserved ↔ Warm/);
  // B4: no id twice; the guide test fails on a duplicate.
  const ids = [...help.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const twice = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(twice, [], `duplicate ids in help.html: ${twice.join(', ')}`);
  assert.match(help, /<h2 id="showing-work">How she shows her work<\/h2>/);
  assert.match(help, /<h2 id="look">Her look and character<\/h2>/);
  assert.match(['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n'), /'look-studio': 'look'/);
});

test('114a.5 all 125 sample lines, the words and meanings are translated in the 5 other languages', () => {
  const need = new Set(TRAITS.flatMap((d) => [d.low, d.high, d.when, ...d.steps.flatMap((s) => [s.word, s.meaning, s.say])]).concat(Object.values(GROUP_TITLES), Object.values(HUMOURS).map((h) => h.say), [NEVER_CONTROLLING]));
  for (const l of LANGS) {
    const d = lang(l);
    const missing = [...need].filter((k) => !d[k]?.trim() && !/^(Cool|Romance)$/.test(k));
    assert.deepEqual(missing.slice(0, 5), [], `${l}: ${missing.length} dial strings not translated`);
    for (const s of TRAITS.flatMap((x) => x.steps)) assert.equal((d[s.say].match(/\p{Extended_Pictographic}/gu) ?? []).join(''), (s.say.match(/\p{Extended_Pictographic}/gu) ?? []).join(''), `${l}: keeps the emoji of ${s.say}`);
  }
});

// ------------------------------------------------------------------ 2 · the dial rows (web/dials.js)

test('114a.6 for every dial and every value 0-10 the row shows the band\'s word, line and number; dragging never calls a model', async () => {
  const m = await loadDials();
  const defs = (await studioDefs()).traits;
  const g = globalThis as Record<string, unknown>;
  const realFetch = g.fetch;
  let calls = 0;
  g.fetch = async () => {
    calls++;
    throw new Error('no network while dragging a dial');
  };
  try {
    const draft: { traits: Record<string, number> } = { traits: {} };
    const box = new El('div');
    let changed = 0;
    m.dialRows(box, defs, null, () => draft, () => changed++, { grouped: true, vars: () => ({ you: 'Alex', name: 'Sara' }) });
    const groups = box.querySelectorAll('.dial-group-name').map((n) => n.textContent);
    assert.deepEqual(groups, ['How warm she is', 'How playful she is', 'How she pushes back', 'How she talks', 'You two', 'While you code']);
    const rows = box.querySelectorAll('.dial');
    assert.equal(rows.length, 25);
    for (const row of rows) {
      const d = defs.find((x: { id: string }) => x.id === row.dataset.dialRow);
      const range = row.querySelector('input')!;
      assert.equal(row.querySelector('.dial-ends')!.children.map((c) => c.textContent).join(' ↔ '), `${d.low} ↔ ${d.high}`, 'the ends sit under the track');
      assert.equal(row.querySelectorAll('.dial-tick').length, 5, 'five soft ticks');
      assert.ok(row.querySelector('.dial-zone'), 'the shaded middle');
      assert.equal(row.querySelector('.tip')!.dataset.tip, d.tip, 'the ? tip keeps only its one line');
      // Shown from the draft (Undo, a starting point) …
      for (let v = 0; v <= 10; v++) {
        draft.traits[d.id] = v;
        row.show!();
        const s = d.steps[m.bandOf(v)];
        assert.equal(range.value, String(v));
        assert.equal(row.querySelector('.dial-word')!.textContent, s.word, `${d.id} ${v}: word`);
        assert.equal(row.querySelector('.dial-say')!.textContent, s.say, `${d.id} ${v}: line`);
        assert.equal(row.querySelector('.dial-num')!.textContent, String(v), `${d.id} ${v}: number`);
        assert.match(row.querySelector('.dial-when')!.textContent, new RegExp(`^${s.word}: `));
      }
      // … and dragged (the slider's input event).
      for (let v = 10; v >= 0; v--) {
        range.value = String(v);
        range.fire('input');
        assert.equal(draft.traits[d.id], v);
        assert.equal(row.querySelector('.dial-say')!.textContent, d.steps[m.bandOf(v)].say);
        assert.equal(range.getAttribute('aria-valuetext'), `${v} · ${d.steps[m.bandOf(v)].word}`);
      }
    }
    assert.equal(changed, 25 * 11, 'every move marks the page changed (it saves by itself)');
    assert.equal(calls, 0, 'no model call (or any fetch) while dragging');
    // The UI module itself has no route to the model: Try it stays in app.js behind its button.
    assert.doesNotMatch(web('dials.js'), /fetch\(|api\(|\/try|\/chat/);
    // The Starts conversations row links to Her plans; jealousy and possessiveness carry the note.
    const init = rows.find((r) => r.dataset.dialRow === 'initiative')!;
    assert.match(init.textContent, /Shared with her plans · quiet hours apply/);
    for (const id of ['jealousy', 'possessive']) assert.match(rows.find((r) => r.dataset.dialRow === id)!.textContent, /never controlling/);
    // "Your Sara so far": the dials off the middle, in their end words.
    assert.equal(m.soFarText(defs, {}), 'Her usual self on every dial');
    assert.equal(m.soFarText(defs, { warmth: 9, teasing: 8, talkative: 1, blunt: 5 }), 'Openly warm · Leaning: teases a lot · Short replies');
  } finally {
    g.fetch = realFetch;
  }
});

test('114a.7 the app uses the dial module; work dials on Coding projects; humour and Quiet focus sample lines; layout rules', () => {
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  const html = web('index.html');
  const css = web('style.css');
  assert.match(app, /import \{ dialRows as dialRowsOf, refreshDials, soFarText \} from '\.\/dials\.js';/);
  assert.doesNotMatch(app, /TIP_EXAMPLES|Low: \$\{d\.examples\[0\]\}/, 'the Low/Middle/High wall left the ? tip');
  assert.match(html, /<div id="pj-work-dials" class="dials"><\/div>/, 'P10: the work dials on Coding projects');
  assert.match(html, /<input id="pj-work-quiet" type="checkbox"> Quiet when I'm focused/);
  assert.match(app, /if \(pick === 'ab-projects'\) void Promise\.all\(\[[^\]]*loadProjectDials\(\)\]\)/);
  assert.match(html, /<p class="dial-sofar"><span class="dial-sofar-title">Your Sara so far<\/span> <span id="st-sofar"/);
  for (const id of ['st-humour-say', 'wz-humour-say', 'work-quiet-say', 'pj-work-quiet-say']) assert.match(html, new RegExp(`id="${id}"`));
  // P2: 13 px ends right under the track and a 16 px gap before the next dial; reduced motion respected.
  assert.match(css, /\.dial-ends \{[^}]*font-size: 13px/);
  assert.match(css, /\.dial-group \{[^}]*gap: var\(--s-4\) var\(--s-6\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.dial-say\.swap \{ animation: none; \} \}/);
  assert.match(css, /\.dial-track \{ padding-inline: var\(--s-6\); \}/, 'M5: room for the thumb on phones');
  assert.doesNotMatch(web('dials.js'), /style=|\.style\./, 'no inline styles');
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v48'\)/);
});

// ------------------------------------------------------------------ 3 · the bugs

async function loadToday() {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US';";
  const src = web('today.js').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/from '\.\/device-approval\.js';/, `from 'data:text/javascript,${encodeURIComponent('export const checkPrompts = async () => {}; export const requestLine = () => "";')}';`).replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

test('114a.8 B1: a leave-by row comes before its event; the repeated hour when summer time ends reads (1st)/(2nd)', async () => {
  const m = await loadToday();
  const at = (h: string) => new Date(`2026-10-30T${h}:00`).toISOString();
  const items = m.dayItems({
    day: '2026-10-30',
    calendar: { events: [{ id: 'e1', title: 'Dentist', start: at('15:00'), end: at('15:45'), location: '12 Oak Ave' }], leaveBy: [{ eventId: 'e1', leaveAt: at('14:35'), minutes: 15, mode: 'car' }] },
    agenda: { reminders: [{ id: 1, text: 'Pick up the parcel', dueAt: at('14:50') }], tasks: [] },
  }, Date.parse(at('09:00')));
  assert.deepEqual(items.map((x: { kind: string }) => x.kind), ['leave', 'reminder', 'event'], 'sorted by time: the leave row first');
  assert.equal(items[0].mode, 'car');
  assert.equal(items[0].past, false);
  // A fake zone that falls back at 07:00 UTC (02:00 summer time → 01:00): 01:30 happens twice.
  const FALL = Date.parse('2026-11-01T07:00:00Z');
  const offset = (ms: number) => (ms < FALL ? 300 : 360);
  assert.equal(m.repeatedHour(Date.parse('2026-11-01T06:30:00Z'), offset), '1st');
  assert.equal(m.repeatedHour(Date.parse('2026-11-01T07:30:00Z'), offset), '2nd');
  assert.equal(m.repeatedHour(Date.parse('2026-11-01T05:30:00Z'), offset), '');
  assert.equal(m.repeatedHour(Date.parse('2026-11-01T08:30:00Z'), offset), '');
  // The same with the real clock rules of America/Chicago (TZ set for this test process only).
  const tz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    assert.equal(m.repeatedHour(Date.parse('2026-11-01T06:30:00Z')), '1st');
    assert.equal(m.repeatedHour(Date.parse('2026-11-01T07:30:00Z')), '2nd');
    assert.equal(m.repeatedHour(Date.parse('2026-10-31T15:00:00Z')), '');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  const js = web('today.js');
  assert.match(js, /t\('Leave by \{time\} for \{what\}', \{ time: time\(x\.at\), what: x\.title \}\)\} \$\{how\}/, 'the row reads "Leave by 2:35 for Dentist (15 min by car)"');
  assert.match(js, /rep === '1st' \? t\('\(1st\)'\) : t\('\(2nd\)'\)/);
});

function roomApp(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-01T15:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}

test('114a.9 B2: with no summary the Rooms line is readable (frequent words + the latest line and who said it); an empty room is "Quiet lately"', async (t) => {
  const app = roomApp(t);
  const r0 = noteRoom(app, { bridge: 'discord', key: '900', kind: 'room', title: 'flat-hunt', parentTitle: 'Friends' });
  const r = setRoom(app, r0.id, { keepUp: true, model: 'local' }) ?? keepRoom(app, r0.id)!;
  assert.equal(currentTopic(app, r.id), 'Quiet lately');
  assert.equal(topicParts(app, r.id).quiet, true);
  let n = 0;
  const say = (author: string, text: string) => logLine(app, r, { platformId: `p${++n}`, authorId: `u-${author}`, author, who: 'person', text, at: app.now().toISOString() });
  say('Ben', 'any luck with the flat search in alfama?');
  say('Ana', 'the alfama flat viewing was great');
  say('Ana', 'found a flat in alfama! two bedrooms, a tiny balcony and the landlord seems lovely, signing on friday');
  const line = currentTopic(app, r.id);
  assert.match(line, /^Lately: [^·]*\bflat\b/, line);
  assert.match(line, /^Lately: [^·]*\balfama\b/, line);
  assert.match(line, / · last from Ana: “found a flat in alfama! [^”]*…”$/, line);
  const quoted = /“(.*)”/.exec(line)![1];
  assert.ok(quoted.length <= 80, `the latest line is cut to 80 characters (${quoted.length})`);
  const p = topicParts(app, r.id);
  assert.equal(p.last?.who, 'Ana');
  assert.ok(p.words.includes('alfama'));
  // Today writes the same line in the app's language from the parts.
  const m = await loadToday();
  assert.equal(m.roomTopicLine({ topicParts: p }), line);
  assert.equal(m.roomTopicLine({ topicParts: { words: [], quiet: true } }), 'Quiet lately');
  assert.equal(m.roomTopicLine({ topic: 'old answer' }), 'old answer', 'an older server answer still shows');
});

test('114a.10 B3: a moved-in persona goes through savePersona: name, memories renamed, her first-message limits, the page re-loads her', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-01T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: new Date().toISOString() });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p, { headers: { authorization: `Bearer ${auth.newToken}` } })).json();
  const was = app.persona.name;
  const note = app.memory!.add({ content: `${was} loves rainy mornings`, kind: 'fact', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  applyPersona(app, validatePersona({ ...app.persona, name: 'Mira', traits: { ...app.persona.traits, initiative: 9 } }));
  assert.equal((await get('/api/persona')).persona.name, 'Mira');
  assert.equal(JSON.parse(readFileSync(join(dir, 'persona.json'), 'utf8')).name, 'Mira');
  assert.equal(app.memory!.get(note.id)?.content, 'Mira loves rainy mornings', 'her old notes use her new name');
  assert.deepEqual({ maxPerDay: app.settings.get().proactive?.maxPerDay, minGapHours: app.settings.get().proactive?.minGapHours }, initiativeToProactive(9), 'Starts conversations sets the limits');
  // (The companions list reads app.persona, checked on the live server: it needs the companions manager.)
  // The page: the move-in runs in the background, so her name is re-loaded when the batch is done.
  const mv = web('movein.js');
  assert.match(mv, /if \(pv\.state === 'imported'\) \{\n[^]*?if \(state\.watching\) \{\n\s*state\.watching = false;\n\s*document\.dispatchEvent\(new CustomEvent\('sara:persona-changed'\)\);/);
  assert.match(['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n'), /document\.addEventListener\('sara:persona-changed', \(\) => \{[^]*?setIdentity\(pe\.persona\);[^]*?setChatTitle\(\);/, 'the sidebar label follows without a reload');
});

test('114a.11 F1 and F4: Today refreshes when the wizard closes; one model count everywhere', async () => {
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /async function suFinish\(\) \{[^]*?if \(todayOpen\(\)\) await Promise\.all\(\[loadToday\(true\), loadChecklist\(\)\]\)/, 'F1: the same call Refresh makes');
  // F4: the browser's counting rule and the server's give the same answer on a real mixed tag list.
  const tags = ['nomic-embed-text:latest', 'gemma4:12b', 'qwen3.5:9b', 'hf.co/x/Omega-27B-GGUF:Q4_K_M', 'glm-5.3:cloud', 'gpt-oss:120b-cloud', 'gemma4:31b-cloud', 'mistral-small-24b-ablit-q4ks:latest', 'cloudy:7b', 'all-minilm:latest', 'kimi-k3:cloud'];
  const mc = await import(pathToFileURL(join(ROOT, 'web', 'model-count.js')).href);
  assert.deepEqual(mc.modelCounts(tags), countModels(tags));
  assert.deepEqual(countModels(tags), { here: 5, cloud: 4 });
  const t = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(p[k]));
  assert.equal(mc.countWords(countModels(tags), true, t), '5 on this computer · 4 on Ollama Cloud');
  assert.equal(mc.countWords({ here: 12, cloud: 0 }, false, t), '12 models', 'a cloud API: just models');
  const groups = mc.modelGroups(tags);
  assert.deepEqual(groups.cloud, ['glm-5.3:cloud', 'gpt-oss:120b-cloud', 'gemma4:31b-cloud', 'kimi-k3:cloud']);
  // The three places use it: the wizard (found + connected, grouped picker), Default model, On this computer.
  assert.match(app, /fillModelOptions\(\$\('#su-model'\), view, '', \{ pick \}\)/);
  assert.match(app, /const counted = countWords\(modelCounts\(models\), Boolean\(config\.local\), t\);/);
  assert.match(app, /status\.textContent = \[modelCountWords\(view, id\)/);
  assert.match(web('local-models.js'), /m\.ollama\.models\.filter\(\(x\) => !x\.cloud && !EMBED_TAG\.test\(x\.name\)\)/);
  assert.match(readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8'), /const n = countModels\(\(j\.models \?\? \[\]\)\.map\(\(m\) => m\.name\)\);\n\s*ollama\.push\(\{ url: `http:\/\/\$\{h\}:11434\/v1`, models: n\.here, cloud: n\.cloud \}\);/);
});
