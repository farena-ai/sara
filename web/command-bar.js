// Phase 75 (stage 2): the command bar. Ctrl+K / ⌘K anywhere (in a text box only with Ctrl/⌘ held,
// which the shortcut needs anyway), or the search button in the header. One field; results in
// groups: Places (every sidebar place, the ones under More too), Conversations (titles at once, the
// words inside messages through GET /api/find), Settings (every page and every setting's label,
// through the same tiered search as the Settings window) and Actions (new conversation, project,
// off the record, a call, switching companion or theme, Your Saras…). Empty: what you opened
// recently first, then the usual places and actions. Keys: ↑ ↓ (Home/End), Enter, Escape. Built as a
// combobox + listbox for screen readers (aria-activedescendant follows the highlighted row).
import { t } from './naming.js';
import { icon as lineIcon } from './icons.js';

const $ = (s) => document.querySelector(s);
const RECENT = 'sara.cmdRecent';
const PER_GROUP = 6;

/** Lower case without accents, so "cafe" finds "Café". */
export const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * How well `text` matches the words of `q`: 0 = not at all (every word must be there), higher is
 * better (the whole query at the start, then a word starting with it, then anywhere).
 */
export function score(q, text, extra = '') {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hay = fold(text);
  const all = `${hay} ${fold(extra)}`;
  if (!words.every((w) => all.includes(w))) return 0;
  const whole = fold(q).trim();
  if (hay.startsWith(whole)) return 4;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${whole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(hay)) return 3;
  if (words.every((w) => hay.includes(w))) return 2;
  return 1;
}

/** The recent list: newest first, no repeats, at most 6 (broken values mean an empty list). */
export function pushRecent(raw, key, max = 6) {
  let list = [];
  try {
    const v = JSON.parse(raw ?? '[]');
    if (Array.isArray(v)) list = v.filter((x) => typeof x === 'string');
  } catch {
    /* start over */
  }
  return [key, ...list.filter((x) => x !== key)].slice(0, max);
}
const readRecent = () => pushRecent(localStorage.getItem(RECENT), '').filter(Boolean);

const ui = { ctx: null, items: [], active: 0, q: '', findTimer: 0, findSeq: 0, found: [], opener: null };

function dialog() {
  return $('#cmdbar');
}

/** Opens the bar (from the shortcut, the header button or the tour). */
export function openCommandBar() {
  const d = dialog();
  if (!d || d.open) return;
  ui.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = $('#search-cmd-q');
  input.value = '';
  ui.q = '';
  ui.found = [];
  d.showModal();
  render();
  input.focus();
}

export function closeCommandBar() {
  const d = dialog();
  if (d?.open) d.close();
}

function allItems() {
  const c = ui.ctx;
  return {
    places: c.places().map((x) => ({ ...x, group: 'places' })),
    convs: c.conversations().map((x) => ({ ...x, group: 'convs' })),
    settings: c.settings().map((x) => ({ ...x, group: 'settings' })),
    // V3 (docs/ops/V3_DESIGN.md §2): projects too.
    projects: (c.projects?.() ?? []).map((x) => ({ ...x, group: 'projects' })),
    actions: c.actions().map((x) => ({ ...x, group: 'actions' })),
  };
}

const groupName = (id) => ({ recent: t('Recent'), places: t('Places'), projects: t('Projects'), convs: t('Conversations'), settings: t('Settings'), actions: t('Actions') })[id] ?? id;

function pick(list, q, n = PER_GROUP) {
  return list
    .map((x) => ({ x, s: score(q, x.label, `${x.sub ?? ''} ${x.words ?? ''}`) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((r) => r.x);
}

/** The groups to show for the text typed so far. */
function results(q) {
  const all = allItems();
  if (!q.trim()) {
    const byKey = new Map([...all.places, ...all.projects, ...all.convs, ...all.settings, ...all.actions].map((x) => [x.key, x]));
    const recent = readRecent().map((k) => byKey.get(k)).filter(Boolean).map((x) => ({ ...x, group: 'recent' }));
    const seen = new Set(recent.map((x) => x.key));
    return [
      ['recent', recent],
      ['actions', all.actions.filter((x) => !seen.has(x.key)).slice(0, 5)],
      ['places', all.places.filter((x) => !seen.has(x.key)).slice(0, 5)],
      ['projects', all.projects.filter((x) => !seen.has(x.key)).slice(0, 4)],
      ['convs', all.convs.filter((x) => !seen.has(x.key)).slice(0, 4)],
    ];
  }
  // Conversations: matching titles first, then messages that contain the words (from the server).
  const titles = pick(all.convs, q);
  const have = new Set(titles.map((x) => x.key));
  const inside = ui.found.filter((x) => !have.has(x.key)).slice(0, Math.max(0, PER_GROUP - titles.length));
  // Settings: the tiered page search (app.js matchSettings) plus each setting's own label.
  const settings = ui.ctx.searchSettings(q).slice(0, PER_GROUP);
  return [
    ['places', pick(all.places, q)],
    ['projects', pick(all.projects, q)],
    ['convs', [...titles, ...inside]],
    ['settings', settings.map((x) => ({ ...x, group: 'settings' }))],
    ['actions', pick(all.actions, q)],
  ];
}

function render() {
  const list = $('#cmd-list');
  const input = $('#search-cmd-q');
  if (!list) return;
  const groups = results(ui.q).filter(([, items]) => items.length);
  ui.items = groups.flatMap(([, items]) => items);
  if (ui.active >= ui.items.length) ui.active = 0;
  let n = 0;
  list.replaceChildren(
    ...groups.map(([id, items]) => {
      const g = document.createElement('div');
      g.className = 'cmd-group';
      g.setAttribute('role', 'group');
      const head = document.createElement('div');
      head.className = 'cmd-head';
      head.id = `cmd-g-${id}`;
      head.textContent = groupName(id);
      head.setAttribute('role', 'presentation');
      g.setAttribute('aria-labelledby', head.id);
      g.append(head);
      for (const it of items) {
        const i = n++;
        const row = document.createElement('div');
        row.className = 'cmd-item';
        row.id = `cmd-o-${i}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === ui.active));
        const icon = document.createElement('span');
        icon.className = 'cmd-icon';
        icon.setAttribute('aria-hidden', 'true');
        // 2.8: an icon name from web/icons.js draws a line icon; anything else (a companion's emoji) stays text.
        const svg = lineIcon(it.icon ?? 'dot');
        if (svg) icon.append(svg);
        else icon.textContent = it.icon ?? '•';
        const words = document.createElement('span');
        words.className = 'cmd-words';
        const label = document.createElement('span');
        label.className = 'cmd-label';
        label.textContent = it.label;
        if (it.raw) label.dataset.raw = '';
        words.append(label);
        if (it.sub) {
          const sub = document.createElement('span');
          sub.className = 'cmd-sub';
          sub.textContent = it.sub;
          if (it.raw) sub.dataset.raw = '';
          words.append(sub);
        }
        row.append(icon, words);
        if (it.hint) {
          const k = document.createElement('kbd');
          k.className = 'cmd-kbd';
          k.textContent = it.hint;
          row.append(k);
        }
        row.addEventListener('mousemove', () => {
          if (ui.active !== i) setActive(i, false);
        });
        row.addEventListener('click', () => choose(i));
        g.append(row);
      }
      return g;
    }),
  );
  if (!ui.items.length) {
    const empty = document.createElement('p');
    empty.className = 'cmd-empty';
    empty.textContent = ui.q.trim() ? t('Nothing found.') : t('Type to search.');
    list.append(empty);
  }
  input.setAttribute('aria-activedescendant', ui.items.length ? `cmd-o-${ui.active}` : '');
  $('#cmd-status').textContent = ui.q.trim() ? (ui.items.length === 1 ? t('One result') : t('Results: {n}', { n: ui.items.length })) : '';
}

function setActive(i, scroll = true) {
  if (!ui.items.length) return;
  ui.active = (i + ui.items.length) % ui.items.length;
  for (const r of document.querySelectorAll('#cmd-list .cmd-item')) r.setAttribute('aria-selected', String(r.id === `cmd-o-${ui.active}`));
  $('#search-cmd-q').setAttribute('aria-activedescendant', `cmd-o-${ui.active}`);
  if (scroll) document.getElementById(`cmd-o-${ui.active}`)?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const it = ui.items[i];
  if (!it) return;
  localStorage.setItem(RECENT, JSON.stringify(pushRecent(localStorage.getItem(RECENT), it.key)));
  ui.opener = null; // the place it opens takes the focus
  closeCommandBar();
  // After the bar has closed (a window it opens must not open inside it).
  setTimeout(() => void it.run(), 0);
}

async function findInside(q) {
  const seq = ++ui.findSeq;
  if (fold(q).trim().length < 3) {
    ui.found = [];
    return;
  }
  let hits = [];
  try {
    hits = await ui.ctx.api(`/find?q=${encodeURIComponent(q.trim())}`);
  } catch {
    hits = [];
  }
  if (seq !== ui.findSeq) return;
  const seen = new Set();
  ui.found = hits
    .filter((h) => h.messageId)
    .filter((h) => (seen.has(h.conversationId) ? false : seen.add(h.conversationId)))
    .map((h) => ({ key: `conv:${h.conversationId}`, group: 'convs', icon: 'chat', label: h.title, sub: String(h.snippet ?? '').replace(/[*_`#>~]+/g, ''), raw: true, run: () => ui.ctx.jumpTo(h.conversationId, h.messageId) }));
  if (dialog()?.open && ui.q === q) render();
}

/** Ctrl+K / ⌘K: in a text box too (the modifier says it isn't typing); not over another window's own search. */
export function isCommandKey(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK');
}

export function initCommandBar(ctx) {
  ui.ctx = ctx;
  const d = dialog();
  const input = $('#search-cmd-q');
  if (!d || !input) return;
  $('#cmd-open')?.addEventListener('click', openCommandBar);
  $('#cmd-close')?.addEventListener('click', closeCommandBar);
  input.addEventListener('input', () => {
    ui.q = input.value;
    ui.active = 0;
    render();
    clearTimeout(ui.findTimer);
    ui.findTimer = setTimeout(() => void findInside(input.value), 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(ui.active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      setActive(ui.items.length - 1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      setActive(ui.active + (e.key === 'PageDown' ? 5 : -5));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      choose(ui.active);
    }
  });
  // A click on the dimmed area closes it.
  d.addEventListener('click', (e) => {
    if (e.target === d) closeCommandBar();
  });
  d.addEventListener('close', () => {
    clearTimeout(ui.findTimer);
    if (ui.opener?.isConnected) ui.opener.focus({ preventScroll: true });
    ui.opener = null;
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (!isCommandKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (d.open) closeCommandBar();
      else openCommandBar();
    },
    true,
  );
}
