// Phase 114 slice PL1c (2.47.2, docs/design/POLISH.md §4, §7 and §8): one look across every page. The
// "How do I…?" block from web/howto.json on every Settings page and view, the one empty state, the
// style rules (spacing tokens, three radii, reduced motion), the settings accordion and Recipes out of
// the list, the phone rules, the PL1b leftovers (claim screen, wizard choice cards, one "make her"
// flow, no ✕ beside "Set up later") and the coding pick that prefers a capable local model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CHECKLIST_ORDER } from '../src/checklist.ts';
import { localCoderOk, recommend } from '../src/modelpicks.ts';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
type Q = { id: string; q: string; steps: string[]; show?: string; start?: string };
const howto = () => JSON.parse(web('howto.json')) as Record<string, Q[]>;
const howtoMod = () => import(pathToFileURL(join(ROOT, 'web', 'howto.js')).href);

// ---------- a tiny stand-in DOM, enough for howtoBlock ----------
class El {
  tagName: string;
  className = '';
  textContent = '';
  type = '';
  open = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: El[] = [];
  listeners: Record<string, (() => void)[]> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...xs: El[]) {
    this.children.push(...xs);
  }
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}
const doc = { createElement: (tag: string) => new El(tag) };

test('114c.1 S3: every Settings page and every view has 2–4 questions with ≤5 steps, and every Show me control exists', async () => {
  const html = web('index.html');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const pages = [...html.matchAll(/data-page="([^"]+)" data-group=/g)].map((m) => m[1]).filter((p) => p !== 'ab-recipes');
  const { VIEW_HOWTO } = await howtoMod();
  const views = [...Object.keys(VIEW_HOWTO), 'chat'];
  const h = howto();
  assert.ok(pages.length >= 48, `found ${pages.length} pages`);
  for (const id of [...pages, ...views]) {
    const list = h[id];
    assert.ok(list, `${id} has a How do I…? entry`);
    assert.ok(list.length >= 2 && list.length <= 4, `${id}: 2–4 questions`);
    assert.equal(new Set(list.map((x) => x.id)).size, list.length, `${id}: question ids are unique`);
    for (const x of list) {
      assert.match(x.q, /\?$/, `${id}/${x.id} is a question`);
      assert.ok(x.steps.length >= 1 && x.steps.length <= 5, `${id}/${x.id}: 1–5 steps`);
      if (x.show) assert.ok(ids.has(x.show.replace(/^#/, '')), `${id}/${x.id}: Show me ${x.show} exists in index.html`);
    }
  }
  assert.deepEqual(Object.keys(h).filter((k) => !pages.includes(k) && !views.includes(k)), [], 'no entry for a page that does not exist');
  // Every view's block has a place to go (a window id or Today's hero) in index.html.
  for (const sel of Object.values(VIEW_HOWTO) as string[]) assert.ok(ids.has(sel.split(' ')[0].slice(1)), sel);
});

test('114c.2 §5.2 step 6: each Getting started card opens its page with the matching question expanded', async () => {
  const h = howto();
  const starts = new Map(Object.entries(h).flatMap(([page, list]) => list.filter((x) => x.start).map((x) => [x.start!, page])));
  const steps = new Set([...CHECKLIST_ORDER.company, ...CHECKLIST_ORDER.coding, ...CHECKLIST_ORDER.both]);
  for (const s of steps) if (s !== 'talk') assert.ok(starts.has(s), `Getting started step ${s} has a How do I…? answer`);
  const { setHowto, howtoForStep } = await howtoMod();
  setHowto(h);
  assert.deepEqual(howtoForStep('github'), { page: 'ab-github', q: 'token' });
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /await openSettings\(i\.open\.split\(':'\)\[1\], \{ howto: \(await loadHowto\(\), howtoForStep\(i\.id\)\)\?\.q \?\? '' \}\)/);
  assert.match(app, /showSettingsHelp\(pick, opts\.howto \?\? ''\)/);
});

test('114c.3 howtoBlock: folded, numbered steps, Show me, and the asked question open', async () => {
  const { setHowto, howtoBlock } = await howtoMod();
  setHowto({ 'co-telegram': [{ id: 'connect', q: 'How do I get her on Telegram?', steps: ['a', 'b', 'c'], show: '#tg-link' }, { id: 'groups', q: 'How do I add her to a group?', steps: ['x'] }] });
  const t = (s: string) => `T:${s}`;
  const closed = howtoBlock('co-telegram', { t, doc }) as El;
  assert.equal(closed.tagName, 'DETAILS');
  assert.equal(closed.open, false);
  const all = closed.all();
  assert.ok(all.some((n) => n.textContent === 'T:How do I…?'), 'translated title');
  const qs = all.filter((n) => n.className === 'howto-q');
  assert.equal(qs.length, 2);
  assert.equal(qs[0].all().filter((n) => n.tagName === 'LI').length, 3, 'numbered steps');
  assert.ok(qs[0].all().some((n) => n.className.includes('howto-show')), 'Show me');
  assert.ok(!qs[1].all().some((n) => n.className.includes('howto-show')), 'no Show me without a control');
  const opened = howtoBlock('co-telegram', { t, doc, open: 'groups' }) as El;
  assert.equal(opened.open, true);
  assert.equal(opened.all().find((n) => n.dataset.q === 'groups')!.open, true);
  assert.equal(howtoBlock('nope', { t, doc }), null);
});

test('114c.4 V2/S4: one empty state everywhere; no bare "None yet." left in web/', () => {
  const files = ['index.html', 'app.js', 'agenda.js', 'agents.js', 'evals-view.js', 'hooks.js', 'movein.js', 'plugins.js', 'skills.js', 'ssh.js', 'findings-view.js', 'library.js', 'moments.js', 'people.js', 'board.js'];
  for (const f of files) assert.ok(!/None yet\./.test(web(f)), `${f}: no "None yet."`);
  for (const f of files.slice(2)) assert.match(web(f), /emptyState\(/, `${f} uses emptyState`);
  const tidy = web('tidy.js');
  assert.match(tidy, /export function emptyState\(icon, text, tag = 'div', hint = ''\) \{\n {2}const o = icon && typeof icon === 'object' \? icon : \{ icon, text, tag, why: hint \};/);
  assert.match(tidy, /h\.className = 'linkish small empty-howto';/);
  // The views use outline icons from icons.js, not emoji (§4.3).
  for (const f of ['app.js', 'library.js', 'moments.js', 'people.js', 'board.js']) assert.ok(!/emptyState\('[^a-z]/u.test(web(f)), `${f}: icon names, not emoji`);
  const css = web('kit.css');
  assert.match(css, /\.empty-state \.empty-icon \{ display: grid; place-items: center; width: 48px; height: 48px; border-radius: var\(--r-pill\);/);
  assert.match(css, /\.empty-state \.empty-text \{ max-width: 44ch;/);
});

test('114c.5 style lint: kit.css uses only spacing tokens and the three designed radii; reduced motion stops every animation', () => {
  const css = web('kit.css');
  for (const m of css.matchAll(/(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?:\s*([^;}]+)/g)) {
    const rest = m[2].replace(/var\(--(?:s-\d|safe-[tb])\)/g, '').replace(/calc|auto|[()+*\s-]/g, '').replace(/0/g, '');
    assert.equal(rest, '', `raw spacing "${m[0].trim()}"`);
  }
  for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) assert.match(m[1].trim(), /^(0|var\(--r-(card|control|pill)\))$/, `radius ${m[1]}`);
  const theme = web('theme.css');
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root \{ --dur-fast: 0ms; --dur: 0ms; --dur-slow: 0ms; \}\n {2}\*, \*::before, \*::after \{\n {4}animation-duration: \.001ms !important;\n {4}animation-iteration-count: 1 !important;\n {4}transition-duration: \.001ms !important;/);
  assert.ok(!/style="/.test(web('howto.js') + web('kit.js')), 'no inline styles');
  assert.ok(web('index.html').includes('<link rel="stylesheet" href="/kit.css">'), 'kit.css is loaded');
});

test('114c.6 S1/S5/S15: an accordion nav, Recipes out of the list (its link lands on Skills), the save note only where something can change', () => {
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /if \(open && remember\) for \(const g of document\.querySelectorAll\('#settings-nav-list \.settings-nav-group\.open'\)\) if \(g !== box\) setGroupOpen\(g, false, false\);/);
  assert.match(app, /setGroupOpen\(box, false, false\);\n {6}return box;/, 'all groups start closed; the page on screen opens its own');
  assert.match(app, /'ab-recipes': 'ab-skills' \};/);
  assert.match(app, /p\.dataset\.page !== 'ab-recipes',/);
  assert.match(app, /\$\('\.settings-actions'\)\.toggleAttribute\('data-quiet', !sec\.querySelector\(/);
  assert.match(web('index.html'), /<div id="settings-howto" class="settings-howto"><\/div>/);
});

test('114c.7 S2: one intro per page: the longer paragraph moves into the How do I…? block (27 pages), search still finds it', () => {
  const html = web('index.html');
  const leads = [...html.matchAll(/data-page="([^"]+)"[^>]*>\s*<p class="muted small page-lead">/g)].map((m) => m[1]);
  assert.ok(leads.length >= 25, `${leads.length} pages`);
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /for \(const p of document\.querySelectorAll\('#settings \.settings-page > p\.page-lead'\)\) \{/);
  assert.match(app, /howtoBlock\(page, \{ t, open, about: pageLead\(page\) \}\)/);
  assert.match(app, /pageLead\(p\.dataset\?\.page\)\?\.textContent/);
});

test('114c.8 settings fixes: segments (S6, banter), search cards (S7), usage words (S8), household picker (S9), routes line (S10), bot status chips (S11), warn callout (S12), What\'s new (S13)', () => {
  const html = web('index.html');
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(web('library.js'), /speedSeg \?\?= choices\(\$\('#lib-speed'\), \[/);
  assert.match(web('group.js'), /banterSeg = choices\(\$\('#gc-banter'\), \[/);
  assert.match(app, /searchCards \?\?= choices\(\$\('#search-provider'\), \[\n {4}\{ value: 'searxng', label: 'SearXNG', tag: t\('Free · no key'\)/);
  assert.match(app, /titles: 'Naming chats'/);
  assert.match(app, /const purposeWord = \(p\) => t\(PURPOSE_WORDS\[p\] \?\? /);
  assert.match(html, /<p id="usage-lead" class="usage-lead"><\/p>/);
  const hh = web('household.js');
  assert.match(hh, /\[\['all', t\('All my models'\)\], \['only', t\('Only these…'\)\]\]/);
  assert.equal((hh.match(/Ollama Cloud: uses your subscription/g) ?? []).length, 1, 'the note once per group');
  assert.match(html, /<p id="jobs-default-line" class="jobs-default-line" data-raw><\/p>/);
  assert.ok(!/t\('Uses the default'\)/.test(app), 'not repeated under every row');
  for (const p of ['tg', 'dc']) {
    assert.match(html, new RegExp(`<span id="${p}-chip" class="status-chip" role="status">Not set up</span>`));
    assert.match(html, new RegExp(`<input id="${p}-enabled" type="checkbox"> Switched on</label>`), 'not "Connected" on a tick box');
  }
  assert.match(app, /function botChip\(chip, b, name\)/);
  assert.match(app, /line\.classList\.toggle\('callout-warn', !iso\.isolated\);/);
  assert.match(html, /id="up-whatsnew"/);
  // kit.js keeps the real control (id, tip, listeners) and sends the same events.
  const kit = web('kit.js');
  assert.match(kit, /control\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);\n {6}changedByHand\(control\);/);
  assert.match(web('dialogs.js'), /export function changedByHand\(node\)/);
});

test('114c.9 views: pin vs keep words (V3), Today hero row (V4/V5), coder subtitles (V8), icon-only message actions (V9), the usage line (V10), phone Today (M4)', () => {
  const html = web('index.html');
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(html, /data-sb="moments">Pins and jokes<\/button>/);
  assert.ok(!/Press 📌 under a message to keep a moment/.test(app), '📌 pins, ♡ keeps');
  assert.match(html, /<div class="td-dateline"><button id="td-back"/);
  const css = web('kit.css');
  assert.match(css, /#today \.td-actions > button, #today \.td-actions \.td-hbtn \{ min-height: 44px; border-radius: var\(--r-pill\); \}/);
  assert.match(css, /body:has\(#today\[open\]\) #hp-open-her \{ display: none; \}/);
  assert.match(html, /<p id="fnd-tab-sub" class="muted small tab-sub">/);
  assert.match(web('findings-view.js'), /redteam: t\('She tries to break it before you ship\.'\)/);
  for (const name of ['copy', 'update', 'flag', 'pin', 'heart', 'edit']) assert.match(app, new RegExp(`act\\('${name}', `), name);
  assert.ok(!/t\('↻ Regenerate'\)/.test(app), 'no symbol-and-word buttons in the row');
  // 3.4.1: the usage line is built by convLead() (also used when the context ring changes).
  assert.match(app, /return \[pct \? t\('\{n\}% full', \{ n: pct \}\) : '', cost\]\.filter\(Boolean\)\.join\(' · '\);/);
  assert.match(web('today.js'), /classList\?\.toggle\('td-day-empty', !items\.length && !d\.calendar\?\.error\)/);
  assert.match(css, /#today\.td-ff-phone \.td-day-empty \{ display: none; \}/);
});

test('114c.10 phone: header on two rows (M1), no inner scroll boxes (M2), the Moments row wraps (M3), the wizard covers the screen', () => {
  const css = web('kit.css');
  const phone = css.slice(css.indexOf('@media (max-width: 720px) {'));
  assert.match(phone, /\.settings-page-head \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(phone, /\.settings-dialog \.settings-pages :is\(\.hh-models, [^)]*\) \{ max-height: none; overflow: visible; \}/);
  assert.match(phone, /\.mo-albums \{ flex-wrap: wrap; overflow-x: visible; \}/);
  assert.match(phone, /dialog#setup \{ width: 100vw; max-width: 100vw; height: 100dvh; max-height: 100dvh; margin: 0; border-radius: 0; padding-top: var\(--safe-t\); padding-bottom: var\(--safe-b\); \}/);
});

test('114c.11 PL1b leftovers: claim screen (F10), step 2 cards (F7), one make-her flow (F8), step 3 cards, no ✕ beside Set up later', () => {
  const html = web('index.html');
  const claim = html.slice(html.indexOf('<div id="claim"'), html.indexOf('<p class="muted" id="login-intro"'));
  assert.match(claim, /placeholder="ABCD-1234"/);
  assert.match(claim, /<button id="claim-token-show" type="button" class="linkish small" aria-expanded="false">I already have a token<\/button>/);
  assert.match(claim, /Started in a terminal[^]*Desktop app[^]*docker compose logs sara/);
  assert.ok(!/from her log/.test(claim));
  assert.match(web('kit.css'), /#login-form\.claiming > button\[type="submit"\] \{ display: none; \}/, 'one main button while setting up');
  assert.match(['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n'), /\$\('#login-form'\)\.classList\.toggle\('claiming', Boolean\(c\.open\) && /);
  const setup = html.slice(html.indexOf('<dialog id="setup"'), html.indexOf('<dialog id="plan-welcome"'));
  assert.match(setup, /<dialog id="setup" class="setup" data-nox>/);
  assert.ok(!/type="radio"/.test(setup), 'no radios');
  assert.ok(!/<details/.test(setup), 'no folding details: choice cards');
  assert.ok(!/id="su-talk"|id="su-vibe"|id="su-rel"/.test(setup), 'no second make-her form');
  assert.match(setup, /<div id="su-who" class="pick-cards su-who" role="radiogroup"/);
  assert.equal((setup.match(/class="pick-card su-way"/g) ?? []).length, 4);
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /else if \(su\.who === 'new'\) await openWizard\(\)/);
  assert.match(web('dialogs.js'), /if \(!dialog\.dataset\.required && !\('nox' in dialog\.dataset\)\) top\(dialog\)\.append\(x\);/);
});

test('114c.12 the coding pick prefers a capable model on this computer; cloud only as the fallback (owner rule: local by default)', () => {
  const c = (model: string, local: boolean, providerId = 'ollama-local') => ({ providerId, provider: 'Ollama', model, local });
  const cloudCoder = c('kimi-k2.7-code:cloud', false);
  assert.equal(recommend([cloudCoder, c('qwen3:30b', true), c('gemma4:12b', true)], {}).coding?.model, 'qwen3:30b');
  assert.equal(recommend([cloudCoder, c('qwen2.5-coder:14b', true), c('qwen3:30b', true)], {}).coding?.model, 'qwen2.5-coder:14b', 'a coding family first');
  assert.equal(recommend([cloudCoder, c('remix-thing-31b:latest', true), c('qwen3:32b', true)], {}).coding?.model, 'qwen3:32b');
  assert.equal(recommend([cloudCoder, c('gemma4:12b', true), c('qwen2.5-coder:1.5b', true)], {}).coding?.model, 'kimi-k2.7-code:cloud', 'small local ones are not enough: cloud fallback');
  assert.equal(recommend([cloudCoder, c('qwen3:30b', true)], {}).coding?.why, 'Good with code and tools, on your own hardware.');
  for (const m of ['qwen3-coder:30b', 'devstral:latest', 'gpt-oss:20b', 'deepseek-coder-v2:16b', 'qwen3.8:27b-mtp-q4_K_M']) assert.ok(localCoderOk(m), m);
  for (const m of ['gemma4:12b', 'qwen2.5-coder:1.5b', 'nomic-embed-text', 'mistral-small-24b-ablit-q4ks:latest', 'hf.co/x/y-GGUF:Q4_K_M']) assert.ok(!localCoderOk(m), m);
});

test('114c.13 the new strings are translated in all five languages; sw.js keeps only the new cache', () => {
  const keys = ['How do I…?', 'Show me', 'I already have a token', 'All my models', 'Only these…', 'Pins and jokes', 'Everything uses {model} unless you change a row.', 'How do I get her on Telegram?'];
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${l}.json`)) as Record<string, string>;
    for (const k of keys) assert.ok(d[k]?.trim(), `${l}: ${k}`);
  }
  const sw = web('sw.js');
  // Phase 115: later phases bump the cache, so the check is that activate keeps exactly the cache that
  // install opens (v50 or newer), which is what this test guarded.
  const opened = sw.match(/waitUntil\(caches\.open\('sara-shell-v(\d+)'\)/);
  assert.ok(opened && Number(opened[1]) >= 50);
  assert.match(sw, new RegExp(`keys\\.filter\\(\\(k\\) => k !== 'sara-shell-v${opened[1]}'\\)`), 'activate keeps the cache install just opened');
});
