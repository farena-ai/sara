// P3FIXES: the small functional paper cuts (docs/design/POLISH_FIXES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Drafts, DRAFT_KEY, DRAFT_MAX, msgWhen, menuKeys, extraShortcut, busy } from '../web/paper-cuts.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('web/app.js');
const css = read('web/style.css');

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), m };
}

test('drafts are kept per chat, emptied when sent, capped and never thrown by bad storage', () => {
  const s = fakeStorage();
  const d = new Drafts(s);
  d.set('a', 'half a thought');
  d.set('b', 'other chat');
  assert.equal(d.get('a'), 'half a thought');
  assert.equal(d.get('b'), 'other chat');
  assert.equal(d.get('c'), '');
  assert.equal(d.get(null), '');
  d.set('a', '   ');
  assert.equal(d.get('a'), '', 'an emptied box drops the draft');
  assert.ok(!JSON.parse(s.m.get(DRAFT_KEY)!).a);
  for (let i = 0; i < DRAFT_MAX + 10; i++) d.set(`c${i}`, `t${i}`, 1000 + i);
  assert.equal(Object.keys(JSON.parse(s.m.get(DRAFT_KEY)!)).length, DRAFT_MAX, 'oldest drafts go first');
  assert.equal(d.get(`c${DRAFT_MAX + 9}`), `t${DRAFT_MAX + 9}`);
  s.m.set(DRAFT_KEY, '{not json');
  assert.equal(new Drafts(s).get('a'), '');
  const broken = new Drafts({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.doesNotThrow(() => broken.set('a', 'x'));
  assert.equal(broken.get('a'), '');
  assert.equal(new Drafts(undefined).get('a'), '');
});

test('message times say the day when it is not today', () => {
  const now = new Date(2026, 10, 20, 15, 0);
  assert.match(msgWhen(new Date(2026, 10, 20, 9, 5), now, 'en-US'), /^9:05\sAM$/);
  assert.match(msgWhen(new Date(2026, 10, 19, 21, 30), now, 'en-US'), /^Yesterday, 9:30\sPM$/);
  assert.match(msgWhen(new Date(2026, 10, 12, 8, 0), now, 'en-US'), /^Nov 12, 8:00\sAM$/);
  assert.match(msgWhen(new Date(2025, 0, 3, 8, 0), now, 'en-US'), /^Jan 3, 2025, 8:00\sAM$/);
  assert.match(msgWhen(new Date(2026, 10, 19, 21, 30), now, 'es'), /^Ayer, /, 'other languages get their own word for yesterday');
  assert.equal(msgWhen(new Date('x'), now, 'en-US'), '');
});

test('menu keys: Esc closes and gives focus back, arrows move between items', () => {
  const focused: string[] = [];
  const item = (id: string) => ({ id, focus: () => focused.push(id) });
  const items = [item('a'), item('b'), item('c')];
  let removed = false;
  let prevented = 0;
  const menu = { _anchor: { focus: () => focused.push('anchor') }, querySelectorAll: () => items, remove: () => { removed = true; }, isConnected: true };
  const ev = (key: string) => ({ key, preventDefault: () => prevented++, stopPropagation() {} });
  assert.equal(menuKeys(menu, ev('ArrowDown'), items[0]), true);
  assert.deepEqual(focused, ['b']);
  menuKeys(menu, ev('ArrowUp'), items[0]);
  assert.equal(focused.at(-1), 'c', 'wraps to the end');
  menuKeys(menu, ev('Home'), items[2]);
  assert.equal(focused.at(-1), 'a');
  assert.equal(menuKeys(menu, ev('x'), items[0]), false);
  assert.equal(menuKeys(menu, ev('Escape'), items[0]), true);
  assert.equal(removed, true);
  assert.equal(focused.at(-1), 'anchor');
  assert.ok(prevented >= 4);
});

test('extra shortcuts: Ctrl/⌘+Shift+O new chat, Shift+Esc to the message box', () => {
  assert.equal(extraShortcut({ ctrlKey: true, shiftKey: true, code: 'KeyO' }), 'new');
  assert.equal(extraShortcut({ metaKey: true, shiftKey: true, code: 'KeyO' }), 'new');
  assert.equal(extraShortcut({ ctrlKey: true, code: 'KeyO' }), null);
  assert.equal(extraShortcut({ shiftKey: true, key: 'Escape' }), 'focus');
  assert.equal(extraShortcut({ key: 'Escape' }), null);
});

test('busy(): a button can not run its action twice at once', async () => {
  const b = { disabled: false, setAttribute() {}, removeAttribute() {} };
  let runs = 0;
  let release: () => void = () => {};
  const job = () => { runs++; return new Promise<void>((r) => { release = r; }); };
  const first = busy(b, job);
  assert.equal(b.disabled, true);
  await busy(b, job);
  assert.equal(runs, 1, 'second press while busy does nothing');
  release();
  await first;
  assert.equal(b.disabled, false);
  await assert.rejects(busy(b, async () => { throw new Error('no'); }));
  assert.equal(b.disabled, false, 'an error frees the button');
});

test('app.js wiring: drafts, focus, menus, double submit, copy, times, scroll, shortcuts', () => {
  assert.match(app, /from '\.\/paper-cuts\.js'/);
  assert.match(app, /const drafts = new Drafts\(globalThis\.sessionStorage\)/, 'drafts stay in this tab only');
  assert.match(app, /async function openConversation\(id\) \{[\s\S]{0,900}moveDraft\(/);
  assert.match(app, /async function newConversation\([\s\S]{0,1400}moveDraft\(/);
  assert.match(app, /addEventListener\('pagehide', keepDraft\)/);
  assert.match(app, /state\.conv\?\.offRecord/);
  assert.match(app, /function focusComposer\(/);
  assert.match(app, /openConversation\(c\.id\)\.then\(focusComposer\)/);
  assert.match(app, /menuKeys\(/);
  assert.match(app, /addEventListener\('resize', closeMenus\)/);
  assert.match(app, /busy\(\$\('#dc-delete'\)/);
  assert.match(app, /busy\(\$\('#pd-save'\)/);
  assert.match(app, /\$\('#pd-name'\)\.addEventListener\('keydown'/);
  assert.match(app, /t\('Copy this message'\)/);
  assert.match(app, /msgWhen\(d, new Date\(\), locale\(\)\)/);
  // LAGFIX: the typed reply follows only a reader at the newest line, from the scroll tracker (web/smooth.js).
  assert.match(app, /streamFrame\(box, \(\) => setReply\(div, target\.slice\(0, div\._shown\), \{ partial: true \}\), followTracker\(box\)\.at\)/);
  assert.match(app, /extraShortcut\(e\)/);
  assert.match(app, /\$\('#chat-title'\)\.addEventListener\('dblclick'/);
  // The Enter-to-send keydown handler and the Alt shortcuts stay as they were (other builders own them).
  assert.match(app, /const SHORTCUTS = \{ KeyT: openToday,/);
});

test('style.css: the ⋯ button shows on keyboard focus and touch targets are big enough', () => {
  assert.match(css, /#conversations a\.conv:focus-within \.conv-more/);
  assert.match(css, /@media \(pointer: coarse\) \{[^}]*\.conv-more[^}]*min-(height|width): 40px/);
  assert.match(css, /\.copy-code/);
});
