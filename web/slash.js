// Phase 128 (PL2b, docs/design/POLISH2.md §4.3, N19): the `/` menu in the app's message box.
//
// Typing / as the first character opens a small listbox above the box, built like the @ menu
// (web/refs.js): ↑ ↓ to move, Enter or Tab to pick, Escape to close, a tap on a row on phones. Each row
// is a command and its one line. The list comes from the server (GET /api/chat-menu: APP_MENU in
// src/bridges/commands.ts, the same lines as the Telegram and Discord menus), already filtered for a
// household member; here it is filtered for the chat: group chats, partner chats and off-the-record
// chats don't offer the commands that only work in your own chats. Picking a command puts it in the
// box (with a space when it takes words); Enter on a finished command sends it as before.

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, t: (s: string) => string, el: (tag: string, cls?: string, text?: string) => HTMLElement, chat: () => { own: boolean, offRecord: boolean } | null } | null} */
let ctx = null;
// The app's t() (handed in, so this file has no imports and runs in Node tests).
const t = (s) => (ctx?.t ? ctx.t(s) : s);
let list = null;
let loading = null;
let items = [];
let active = 0;

/** The menu's commands once loaded ([{ name, line, args, own }]); [] before. */
export const slashCommands = () => list ?? [];

/** Loads the list (once per language: `reload` after a language change). */
export function loadSlash(reload = false) {
  if (!ctx) return Promise.resolve([]);
  if (reload) {
    list = null;
    loading = null;
  }
  loading ??= ctx.api('/chat-menu').then((r) => (list = r.commands ?? [])).catch(() => (loading = null, []));
  return loading;
}

/**
 * The rows for what is typed (pure: tests call it). `typed` is the box's text up to the caret; the
 * menu only opens when it starts with / and has no space yet.
 */
export function slashRows(typed, commands, chat) {
  if (!chat || !/^\/[^\s/]*$/.test(typed)) return null;
  const q = typed.slice(1).toLowerCase();
  const here = commands.filter((c) => chat.own || !c.own);
  const byName = here.filter((c) => c.name.startsWith(q));
  return byName.length || !q ? byName : here.filter((c) => c.line.toLowerCase().includes(q));
}

export function initSlash(c) {
  ctx = c;
  const input = $('#input');
  const menu = $('#slash-menu');
  if (!input || !menu) return;
  input.addEventListener('input', () => void onType());
  input.addEventListener('focus', () => void loadSlash());
  input.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return close();
    }
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // A finished command (\"/stop\") goes as typed: Enter sends it.
      if (e.key === 'Enter' && input.value.trim().toLowerCase() === `/${items[active].name}`) return close();
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(items[active]);
    }
  }, true);
  input.addEventListener('blur', () => setTimeout(close, 150));
  // The ? keeps the box focused (so the menu stays) and opens its tip as everywhere else.
  $('#slash-tip')?.addEventListener('mousedown', (e) => e.preventDefault());
}

async function onType() {
  const input = $('#input');
  const typed = input.value.slice(0, input.selectionStart ?? input.value.length);
  if (!/^\/[^\s/]*$/.test(typed)) return close();
  const chat = ctx.chat();
  if (!chat) return close();
  const commands = await loadSlash();
  // The box may have changed while the list loaded.
  if (input.value.slice(0, input.selectionStart ?? input.value.length) !== typed) return;
  const note = $('#slash-note');
  if (chat.offRecord) {
    items = [];
    paint();
    note.textContent = t('Commands don’t work in an off-the-record chat.');
    note.hidden = false;
    return show();
  }
  const rows = slashRows(typed, commands, chat) ?? [];
  if (!rows.length) return close();
  note.hidden = true;
  items = rows;
  active = 0;
  paint();
  show();
}

function show() {
  $('#slash-menu').hidden = false;
  const input = $('#input');
  input.setAttribute('aria-controls', 'slash-list');
  input.setAttribute('aria-expanded', 'true');
}
function close() {
  const menu = $('#slash-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  items = [];
  const input = $('#input');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'ref-menu');
  input.removeAttribute('aria-activedescendant');
}

function paint() {
  const ul = $('#slash-list');
  ul.replaceChildren(...items.map((it, i) => {
    const li = ctx.el('li', `ref-item slash-item${i === active ? ' active' : ''}`);
    li.id = `slash-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === active ? 'true' : 'false');
    li.append(ctx.el('span', 'slash-name', `/${it.name}`), ctx.el('span', 'slash-line muted small', it.line));
    // Mouse and touch: pick without taking the focus from the box.
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', () => pick(it));
    return li;
  }));
  ul.hidden = !items.length;
  if (items.length) {
    $('#input').setAttribute('aria-activedescendant', `slash-opt-${active}`);
    ul.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
  }
}

function pick(it) {
  const input = $('#input');
  const text = `/${it.name}${it.args ? ' ' : ''}`;
  const rest = input.value.slice(input.selectionStart ?? input.value.length).replace(/^\S*/, '');
  input.value = text + rest.replace(/^\s+/, '');
  input.setSelectionRange(text.length, text.length);
  close();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
