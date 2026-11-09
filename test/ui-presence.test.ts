// Phase 75 (stage 2, "her presence"): her panel (a column on wide screens, an overlay below 1100 px,
// a bottom sheet on phones) and the Ctrl+K / ⌘K command bar. Static checks on the markup, styles
// and wiring (no browser here), the pure helpers of web/her-panel.js and web/command-bar.js run in
// Node, and the one small read-only route the panel added (GET /api/memories?ids=).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
const panelJs = web('her-panel.js');
const cmdJs = web('command-bar.js');
const css = web('her-panel.css');

/**
 * A web module in Node: its naming.js import (which needs the server's /identity.js) becomes a small
 * stand-in, and the media queries it reads at import time say "not wide, not a phone".
 */
async function load(file: string) {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const stub = "const t = (s, p = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)); const locale = () => 'en-US'; const currentIdentity = () => ({ name: 'Sara' });";
  const src = web(file).replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub)
    // 2.8: the icon set and the small charts are plain modules; a data: URL module imports them by their file URL.
    .replace(/from '\.\/(icons|viz)\.js';/g, (_m, name: string) => `from '${pathToFileURL(join(ROOT, 'web', `${name}.js`)).href}';`);
  assert.ok(src.includes(stub), `${file} imports naming.js`);
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

test('panel markup: her face opens it, sections in order, placed after the chat, AI notice untouched', () => {
  const head = html.slice(html.indexOf('<header id="chat-head">'), html.indexOf('</header>', html.indexOf('<header id="chat-head">')));
  assert.match(head, /<button id="her-face"[^>]*aria-controls="her-panel"[^>]*aria-expanded="false"[^>]*><img class="avatar head-face"/, 'her face is a real button that opens the panel');
  assert.match(head, /<button id="panel-toggle"[^>]*aria-controls="her-panel"/);
  assert.match(head, /<button id="cmd-open"[^>]*aria-haspopup="dialog"/, 'the search button (phones) opens the command bar');
  assert.match(head, /<span class="ai-badge"[^>]*>AI companion<\/span>/, 'the AI disclosure badge stays in the header');
  const at = html.indexOf('<aside id="her-panel"');
  assert.ok(at > html.indexOf('</main>') && at < html.indexOf('<aside id="preview-pane"'), 'the panel is the column after the chat');
  const panel = html.slice(at, html.indexOf('</aside>', at));
  const order = ['hp-handle', 'hp-name', 'hp-portrait', 'hp-mood-text', 'hp-status', 'hp-who', 'hp-now', 'hp-now-line', 'hp-approvals', 'hp-jobs', 'hp-today', 'hp-planner', 'hp-mem', 'hp-conv', 'hp-ctx'].map((id) => panel.indexOf(`id="${id}"`));
  for (const [i, n] of order.entries()) assert.ok(n > 0, `section ${i} present`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'portrait, Now, Today, She remembered, This conversation, in that order');
  assert.match(panel, /aria-labelledby="hp-name"/);
  assert.match(html, /<button id="her-scrim"[^>]*type="button"[^>]*aria-label="Close her panel" hidden>/, 'the dimmed area beside the overlay is a real button');
  assert.match(html, /<link rel="stylesheet" href="\/look\.css">\n {2}<link rel="stylesheet" href="\/her-panel\.css">/, 'loaded after look.css');
  assert.doesNotMatch(panel, /style="/, 'no inline style');
});

test('command bar markup: a combobox over a listbox in its own window', () => {
  const at = html.indexOf('<dialog id="cmdbar"');
  assert.ok(at > 0);
  const box = html.slice(at, html.indexOf('</dialog>', at));
  assert.match(box, /<input id="search-cmd-q"[^>]*role="combobox"[^>]*aria-expanded="true"[^>]*aria-controls="cmd-list"[^>]*aria-autocomplete="list"/);
  assert.match(box, /<div id="cmd-list"[^>]*role="listbox"/);
  assert.match(box, /id="cmd-status"[^>]*role="status"[^>]*aria-live="polite"/, 'the result count is read out');
  assert.match(box, /data-wired="1"/, 'its own close button and Escape (no extra ✕ from dialogs.js)');
  // Every option row is an option with an id the input points at.
  assert.match(cmdJs, /setAttribute\('role', 'option'\)/);
  assert.match(cmdJs, /aria-activedescendant/);
  assert.match(cmdJs, /setAttribute\('aria-selected'/);
});

test('panel styles: 320 px column from 1100 px, an overlay below, a sheet on phones, 44 px targets, below the title strip', () => {
  assert.match(css, /@media \(min-width: 1100px\) \{\s*#main\.panel-open:not\(\.has-preview\) \{ grid-template-columns: 260px minmax\(0, 1fr\) 320px; \}/);
  assert.match(css, /\.her-panel\.mode-overlay \{[^}]*position: fixed;[^}]*width: min\(340px, 92vw\)/);
  assert.match(css, /\.her-panel\.mode-sheet \{[^}]*position: fixed;[^}]*bottom: 0;[^}]*transform: translateY\(var\(--sheet-y, 100%\)\)/);
  assert.match(css, /\.her-panel\.mode-sheet\.dragging \{ transition: none; \}/);
  const phone = css.slice(css.indexOf('@media (max-width: 720px) {\n  .her-scrim'));
  assert.match(phone, /min-height: 44px/, '44 px touch targets in the sheet');
  assert.match(css, /html\.shell \.her-panel\.mode-side, html\.shell \.her-panel\.mode-overlay \{ padding-top: var\(--titlebar\); \}/, 'the panel starts below the native title strip');
  assert.match(css, /html\.shell #chat-head \.head-icon, html\.shell #chat-head \.head-face-btn \{ app-region: no-drag;/);
  // Motion is breathing / pulsing only while she works or writes; theme.css turns all of it off for reduced motion.
  assert.match(css, /html\.sara-busy \.hp-glow \{ animation: hp-breathe/);
  assert.match(css, /html\.sara-speaking \.hp-glow \{ animation: hp-pulse/);
  assert.match(web('theme.css'), /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: \.001ms !important/);
  // Colours come from the tokens (no new literal palette outside the mood tints).
  const literals = [...css.replace(/\.hp-glow\[data-mood="\w+"\] \{[^}]*\}/g, '').matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
  assert.deepEqual(literals.filter((x) => !/^#fff$/i.test(x)), [], 'colours from theme.css tokens');
});

test('panel behaviour: approvals reuse the chat card, memories never in private chats, 403 hides a part quietly', () => {
  // Allow / Deny press the chat card's own buttons: the panel never decides an approval itself.
  // 3.0.3: the card's marked Allow / Deny (else the row's first and last button).
  assert.match(panelJs, /const all = \[\.\.\.card\.querySelectorAll\(':scope > \.row > button'\)\]/);
  assert.match(panelJs, /const no = card\.querySelector\(':scope > \.row > button\[data-answer="no"\]'\) \?\? \(all\.length > 1 \? all\.at\(-1\) : undefined\)/);
  assert.match(panelJs, /src\?\.click\(\)/);
  assert.doesNotMatch(panelJs, /\/approvals/, 'no approval requests of its own');
  assert.match(panelJs, /if \(!conv \|\| conv\.offRecord \|\| conv\.private\) \{\s*sec\.hidden = true;/, 'no memories in off-the-record or private conversations');
  assert.match(panelJs, /\/memories\?ids=/);
  assert.match(panelJs, /err\?\.status === 403\) sec\.hidden = true/);
  assert.match(panelJs, /history\.pushState\(\{ \.\.\.\(history\.state \?\? \{\}\), herSheet: 1 \}/, 'Back closes the sheet');
  assert.match(panelJs, /localStorage\.setItem\(KEY, 'closed'\)/, 'folded away is remembered per device');
  assert.match(panelJs, /\$\('#input'\)\?\.addEventListener\('focus'/, 'the sheet steps aside for the keyboard');
  // app.js feeds it: activity, jobs, the conversation, messages, face and mood.
  for (const call of ['panelNow(null)', 'panelNow(activity.status', 'panelJobs([', 'panelConv()', 'panelMessages()', 'panelFace({', 'panelMood(st)']) assert.ok(app.includes(call), call);
  assert.match(app, /window\.dispatchEvent\(new Event\('sara:planner'\)\)/);
});

test('panel helpers: the next three things today, the memories of the last turn, the saved choice', async () => {
  const m = await load('her-panel.js');
  const now = Date.parse('2026-10-29T18:00:00-05:00');
  const at = (h: string) => `2026-10-29T${h}:00-05:00`;
  const d = {
    calendar: { events: [{ title: 'Standup', start: at('09:00'), end: at('09:15') }, { title: 'Dinner', start: at('19:00'), end: at('20:00') }, { title: 'Holiday', allDay: true, start: '2026-10-29' }] },
    agenda: { reminders: [{ text: 'Call Mom', dueAt: at('18:30') }], tasks: [{ title: 'Late report', dueAt: at('12:00'), overdue: true }, { title: 'Someday', dueAt: null }] },
  };
  const next = m.nextThings(d, now);
  assert.equal(next.length, 3, 'top 3');
  assert.deepEqual(next.map((x: { title: string }) => x.title), ['Late report', 'Holiday', 'Call Mom'], 'overdue first, then all day, then by time; past events left out');
  assert.deepEqual(m.nextThings(null), []);
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'old', meta: { memoryIds: [9] } },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: '', meta: { memoryIds: [3, 4], toolCalls: [{}] } },
    { role: 'tool', content: 'x' },
    { role: 'assistant', content: 'done', meta: { memoryIds: [4, 5] } },
  ];
  assert.deepEqual(m.memoryIdsOfLastTurn(msgs), [3, 4, 5], 'every reply of the last turn, no repeats, not the turn before');
  assert.equal(m.savedOpen(null), true, 'open by default on wide screens');
  assert.equal(m.savedOpen('closed'), false);
  assert.equal(m.panelMode(), 'overlay', 'neither wide nor phone (stubbed media queries) is the overlay');
});

test('command bar helpers: word matching, recent items, the shortcut', async () => {
  const c = await load('command-bar.js');
  assert.equal(c.score('', 'Planner'), 0);
  assert.equal(c.score('plan', 'Planner'), 4, 'starts with it');
  assert.equal(c.score('back', 'Copy backups to'), 3, 'a word starts with it');
  assert.equal(c.score('cafe', 'Café notes'), 4, 'accents folded');
  assert.equal(c.score('ups cop', 'Copy backups to'), 2, 'every word somewhere');
  assert.equal(c.score('call mom', 'Start a call'), 0, 'every word must be there');
  assert.equal(c.score('theme', 'Switch to Day', 'switch theme dark light'), 1, 'extra search words count, ranked last');
  assert.deepEqual(c.pushRecent('["a","b","c"]', 'b'), ['b', 'a', 'c']);
  assert.deepEqual(c.pushRecent('not json', 'x'), ['x']);
  assert.equal(c.pushRecent(JSON.stringify(['1', '2', '3', '4', '5', '6']), 'n').length, 6);
  const key = (o: Record<string, unknown>) => c.isCommandKey({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: 'k', code: 'KeyK', ...o });
  assert.equal(key({ ctrlKey: true }), true);
  assert.equal(key({ metaKey: true }), true, '⌘K on a Mac');
  assert.equal(key({}), false, 'a plain k is typing');
  assert.equal(key({ ctrlKey: true, shiftKey: true }), false);
  assert.equal(key({ ctrlKey: true, key: 'л', code: 'KeyK' }), true, 'other keyboard layouts');
});

test('command bar wiring: every group, the settings search reused, shortcuts kept', () => {
  for (const g of ["recent: t('Recent')", "places: t('Places')", "convs: t('Conversations')", "settings: t('Settings')", "actions: t('Actions')"]) assert.ok(cmdJs.includes(g), g);
  const init = app.slice(app.indexOf('initCommandBar({'), app.indexOf('// On a phone the list slides over the chat'));
  assert.match(init, /document\.querySelectorAll\('#side-nav \.side-dest'\)/, 'every sidebar place, pinned or under More');
  assert.match(init, /matchSettings\(q, pages\)/, 'the Settings window tiered search');
  assert.match(init, /querySelectorAll\('label, h3, h4, legend'\)/, 'and every setting label');
  for (const a of ["add('new'", "add('project'", "add('offrecord'", "add('call'", 'add(`companion:', "add('theme'", "add('servers'"]) assert.ok(init.includes(a), a);
  assert.match(cmdJs, /\/find\?q=\$\{encodeURIComponent/, 'words inside messages through the search API');
  // Ctrl+K moved from the sidebar search to the command bar; the other shortcuts are unchanged.
  assert.doesNotMatch(app, /e\.key\.toLowerCase\(\) === 'k'/);
  assert.match(app, /const SHORTCUTS = \{ KeyT: openToday, KeyP: .*KeyN: \(\) => \$\('#new-chat'\)\.click\(\) \};/);
  assert.match(app, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key === ','/, 'Ctrl+, still opens Settings');
  assert.match(app, /e\.code === 'Backslash'[\s\S]{0,60}togglePanel\(\)/, 'Ctrl+\\ folds her panel');
  // The tour introduces both.
  const first = app.slice(app.indexOf('  first: ['), app.indexOf('  studio: ['));
  assert.match(first, /sel: '#her-face', title: t\('Her panel'\)/);
  assert.match(first, /sel: '#cmd-open', title: t\('Search and go'\)/);
  // The help guide and the offline cache.
  const help = web('help.html');
  assert.match(help, /<strong>Her panel<\/strong>/);
  assert.match(help, /<strong>Search and go:<\/strong> press <em>Ctrl\+K<\/em>/);
  assert.ok(Number(/sara-shell-v(\d+)/.exec(web('sw.js'))?.[1]) >= 5, 'the offline cache was bumped (stage 2: v5)');
});

test('GET /api/memories?ids=: just the notes asked for, in that order, capped, nothing else', async (t) => {
  const { dir, cleanup } = tempDir();
  const sara = makeApp(dir, { now: new Date('2026-10-29T20:00:00Z') });
  const auth = new OwnerAuth(sara.dataDir);
  const server = createSaraServer({ app: sara, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    sara.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = async (path: string, token = auth.newToken) => {
    const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  const mem = sara.memory!;
  const add = (content: string) => mem.add({ kind: 'fact', content, onDate: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-29', evidence: 'test' }).id;
  const a = add('Alex has a beagle called Biscuit.');
  const b = add('Alex prefers oat milk.');
  add('Alex is training for a half marathon.');
  const r = await get(`/memories?ids=${b},${a},${b},999999,x,-1`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((m: { id: number }) => m.id), [b, a], 'asked order, repeats and unknown ids left out');
  assert.equal(r.body[0].content, 'Alex prefers oat milk.');
  assert.ok('source' in r.body[0], 'the same view as the list (source link)');
  assert.deepEqual((await get('/memories?ids=')).body, []);
  const many = Array.from({ length: 80 }, () => a).concat(Array.from({ length: 80 }, (_, i) => i + 1000));
  assert.ok((await get(`/memories?ids=${many.join(',')}`)).body.length <= 50, 'at most 50 asked');
  assert.equal((await get('/memories')).body.length, 3, 'the plain list is unchanged');
  assert.equal((await get(`/memories?ids=${a}`, '')).status, 401, 'signed-in only');
});

test('"She remembered" is folded by default and not fetched until opened (privacy)', () => {
  const root = join(import.meta.dirname, '..', 'web');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const js = readFileSync(join(root, 'her-panel.js'), 'utf8');
  assert.match(html, /id="hp-mem-h"[^>]*aria-expanded="false"[^>]*aria-controls="hp-mem-list"/, 'a closed toggle button');
  assert.match(html, /<ul id="hp-mem-list" class="hp-list" hidden>/, 'the list starts hidden');
  const load = js.slice(js.indexOf('async function loadMemories'), js.indexOf('function memOpen'));
  assert.ok(load.indexOf('if (!memOpen())') > -1 && load.indexOf('if (!memOpen())') < load.indexOf('/memories?ids='), 'no fetch while folded');
  assert.doesNotMatch(js.slice(js.indexOf('function setMemOpen'), js.indexOf('/** The memory ids')), /localStorage/, 'the open state is never saved');
  assert.match(js, /A new conversation folds "She remembered" again/);
});
