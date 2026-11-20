// P1 polish (2026-11-20, docs/handoffs/2026-11-20-p1enter.md): Enter sends, Shift+Enter makes a new
// line, in every box where you type to her; Settings → You → Appearance → Chat behavior can swap it
// (Enter = new line, Ctrl/Cmd+Enter = send). One helper (web/enter-send.js); the offline page and the
// desktop quick ask keep a copy of the same rule (they can't import it), and a test keeps them equal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';
import { ENTER_KEY, enterAction, enterSend, enterSendsOn, setEnterSends } from '../web/enter-send.js';

const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Ev = { key?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number };
/** [event, Enter-sends on → result, Enter-sends off → result] */
const TABLE: [Ev, string | null, string | null][] = [
  [{ key: 'Enter' }, 'send', null],
  [{ key: 'Enter', shiftKey: true }, null, null],
  [{ key: 'Enter', ctrlKey: true }, 'send', 'send'],
  [{ key: 'Enter', metaKey: true }, 'send', 'send'],
  [{ key: 'Enter', altKey: true }, 'send', null],
  [{ key: 'Enter', ctrlKey: true, shiftKey: true }, null, null],
  [{ key: 'Enter', isComposing: true }, null, null],
  [{ key: 'Enter', isComposing: true, ctrlKey: true }, null, null],
  [{ key: 'Enter', keyCode: 229 }, null, null],
  [{ key: 'a' }, null, null],
  [{ key: 'Tab' }, null, null],
];

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, v), m };
};

test('enterAction: Enter sends, Shift+Enter is a new line, Ctrl/Cmd+Enter sends, IME is never cut off', () => {
  for (const [e, on, off] of TABLE) {
    assert.equal(enterAction(e, true), on, `on ${JSON.stringify(e)}`);
    assert.equal(enterAction(e, false), off, `off ${JSON.stringify(e)}`);
  }
  assert.equal(enterAction(null as never, true), null);
});

test('the setting is on by default on every device and remembers off', () => {
  assert.equal(ENTER_KEY, 'sara.enterSends');
  assert.equal(enterSendsOn(store()), true);
  assert.equal(enterSendsOn(store({ [ENTER_KEY]: 'on' })), true);
  assert.equal(enterSendsOn(store({ [ENTER_KEY]: 'off' })), false);
  assert.equal(enterSendsOn({ getItem() { throw new Error('blocked'); } } as never), true);
  const s = store();
  setEnterSends(false, s);
  assert.equal(s.m.get(ENTER_KEY), 'off');
  setEnterSends(true, s);
  assert.equal(s.m.get(ENTER_KEY), 'on');
});

/** A tiny element stand-in: listeners, attributes and dispatch. */
function box() {
  const on: Record<string, ((e: unknown) => void)[]> = {};
  const attrs: Record<string, string> = {};
  return {
    attrs,
    addEventListener: (t: string, f: (e: unknown) => void) => (on[t] ??= []).push(f),
    setAttribute: (k: string, v: string) => (attrs[k] = v),
    fire(t: string, o: Record<string, unknown>) {
      const e = { ...o, type: t, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const f of on[t] ?? []) f(e);
      return e;
    },
  };
}

test('enterSend: keydown sends and keeps the key; Shift+Enter falls through to a new line', () => {
  const s = store();
  const b = box();
  const sent: Ev[] = [];
  enterSend(b as never, (e: Ev) => sent.push(e), { store: s });
  assert.equal(b.attrs.enterkeyhint, 'send');
  const k = b.fire('keydown', { key: 'Enter', ctrlKey: true });
  assert.equal(k.defaultPrevented, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ctrlKey, true, 'Ctrl/Cmd+Enter keeps its meaning for the caller (Interrupt now)');
  const sh = b.fire('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(sh.defaultPrevented, false);
  const li = b.fire('beforeinput', { inputType: 'insertLineBreak' });
  assert.equal(li.defaultPrevented, false, 'the line break after Shift+Enter stays');
  assert.equal(sent.length, 1);
});

test('enterSend: phones whose keyboard hides the Enter key (229 / composing) still send on the line break', () => {
  const s = store();
  const b = box();
  let n = 0;
  enterSend(b as never, () => n++, { store: s });
  const k = b.fire('keydown', { key: 'Unidentified', keyCode: 229, isComposing: true });
  assert.equal(k.defaultPrevented, false);
  for (const inputType of ['insertLineBreak', 'insertParagraph']) {
    const e = b.fire('beforeinput', { inputType });
    assert.equal(e.defaultPrevented, true, inputType);
  }
  assert.equal(n, 2);
  assert.equal(b.fire('beforeinput', { inputType: 'insertText', data: 'a' }).defaultPrevented, false);
});

test('enterSend: with the setting off, Enter is a new line and Ctrl/Cmd+Enter sends', () => {
  const s = store({ [ENTER_KEY]: 'off' });
  const b = box();
  let n = 0;
  enterSend(b as never, () => n++, { store: s });
  assert.equal(b.attrs.enterkeyhint, 'enter');
  assert.equal(b.fire('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(b.fire('beforeinput', { inputType: 'insertLineBreak' }).defaultPrevented, false);
  assert.equal(n, 0);
  assert.equal(b.fire('keydown', { key: 'Enter', metaKey: true }).defaultPrevented, true);
  assert.equal(n, 1);
  // Switching back on applies to boxes already on screen.
  s.setItem(ENTER_KEY, 'on');
  assert.equal(b.fire('keydown', { key: 'Enter' }).defaultPrevented, true);
  assert.equal(n, 2);
});

test('enterSend: multiline boxes (notes, emails) keep Enter for lines and send with Ctrl/Cmd+Enter', () => {
  const b = box();
  let n = 0;
  enterSend(b as never, () => n++, { store: store(), multiline: true });
  assert.equal(b.attrs.enterkeyhint, 'enter');
  assert.equal(b.fire('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(b.fire('beforeinput', { inputType: 'insertLineBreak' }).defaultPrevented, false);
  assert.equal(b.fire('keydown', { key: 'Enter', ctrlKey: true }).defaultPrevented, true);
  assert.equal(n, 1);
});

/** Pulls `function enterAction(...) {...}` out of a file that can't import the helper and runs the table. */
function copyOf(text: string, file: string) {
  const m = text.match(/function enterAction\(e, on\) \{[\s\S]*?\n\s*\}\n/);
  assert.ok(m, `${file} keeps a copy of enterAction`);
  // Safe: the body is a function copied from a file in this repo, never outside input.
  return new Function(`${m[0]}; return enterAction;`)() as (e: Ev, on: boolean) => string | null;
}

test('the offline page and the desktop quick ask keep the same rule and the same setting', () => {
  for (const file of ['web/offline-view.js', 'desktop/shared/quick-ask.html']) {
    const text = src(file);
    const f = copyOf(text, file);
    for (const [e, on, off] of TABLE) {
      assert.equal(f(e, true), on, `${file} on ${JSON.stringify(e)}`);
      assert.equal(f(e, false), off, `${file} off ${JSON.stringify(e)}`);
    }
    assert.match(text, /sara\.enterSends/, file);
    assert.match(text, /insertLineBreak/, file);
    assert.match(text, /enterkeyhint/, file);
  }
});

test('every box where you type to her uses the helper (no hand-made Enter handlers left)', () => {
  const uses: [string, RegExp][] = [
    ['web/app.js', /enterSend\(\$\('#input'\)/],
    ['web/messages.js', /enterSend\(box,/],
    ['web/workspace-view.js', /enterSend\(\$\('#wv-ask'\)/],
    ['web/reception-chat.js', /enterSend\(q,/],
  ];
  for (const [file, re] of uses) {
    const text = src(file);
    assert.match(text, re, file);
    assert.match(text, /from '\.\/enter-send\.js'/, file);
  }
  const offline = src('web/offline-view.js');
  assert.ok((offline.match(/enterKeys\(/g) ?? []).length >= 3, 'offline chat box, queued-message edit and notes');
  const qa = src('desktop/shared/quick-ask.html');
  assert.match(qa, /enterKeys\(q,/);
  // Its footer hint follows the setting.
  assert.match(qa, /if \(!on\(\)\) \$\('hint'\)\.textContent = t\('Ctrl\/Cmd\+Enter to ask/);
  // The old one-off rule (Enter && !shiftKey) must not come back in a composer.
  for (const file of ['web/app.js', 'web/messages.js', 'web/workspace-view.js', 'web/reception-chat.js', 'web/offline-view.js', 'desktop/shared/quick-ask.html']) {
    assert.doesNotMatch(src(file), /e\.key === 'Enter' && !e\.shiftKey/, file);
  }
  // Ctrl/Cmd+Enter still means Interrupt now in the main box (Phase 116).
  assert.match(src('web/app.js'), /state\.nowSend = Boolean\(\(e\.ctrlKey \|\| e\.metaKey\) && enterSendsOn\(\)\)/);
});

test('Settings → Appearance → Chat behavior has the switch, with a tip, on by default', () => {
  const html = src('web/index.html');
  const chat = html.slice(html.indexOf('id="ap-g-chat"'), html.indexOf('id="ap-g-chat"') + 3000);
  assert.match(chat, /<select id="ap-enter">/);
  assert.match(chat, /<option value="on">[^<]*\(default\)<\/option>/);
  const tips = JSON.parse(src('web/tips.json'));
  assert.ok(tips.tips?.['ap-enter'] ?? tips['ap-enter'], 'ap-enter has a tip');
  const app = src('web/app.js');
  assert.match(app, /\$\('#ap-enter'\)\.value = enterSendsOn\(\) \? 'on' : 'off'/);
  assert.match(app, /setEnterSends\(\$\('#ap-enter'\)\.value !== 'off'\)/);
});

test('the desktop apps leave Enter to the page (no native key grab)', () => {
  const win = src('desktop/windows/src/main.cpp');
  const qa = win.slice(win.indexOf('add_AcceleratorKeyPressed'), win.indexOf('add_AcceleratorKeyPressed') + 600);
  assert.match(qa, /VK_ESCAPE/);
  assert.doesNotMatch(qa, /VK_RETURN/);
  assert.doesNotMatch(src('desktop/mac/Sources/Shell.swift'), /keyEquivalent = "\\r"/);
});
