// Phase 111 (TD1, docs/design/TODAY.md §3.5): Customise Today. Reorder, resize and hide tiles,
// move whole sections, and Today's few settings, saved for this companion on the server
// (PUT /api/today/layout), so the layout follows the owner to every device he uses her on.
// Three ways to change it, all with the keyboard as well as the mouse:
//   · the Customise sheet: one card per section (↑/↓), one row per tile (drag handle, S/M/L,
//     Show, ↑/↓ buttons, a ? tip);
//   · each tile's ⋯ menu: Smaller, Larger, Move up, Move down, Hide this tile;
//   · a focused tile: Alt+↑/↓ moves it, Alt+←/→ resizes it (announced).
// Every change shows on the page at once (live preview) and is saved a moment later; hiding a
// tile offers Undo for 8 seconds; Reset asks once and restores the designed layout.
import { t } from './naming.js';
import { icon } from './icons.js';
import { SECTIONS, TILES, layoutModel, migrateDeviceKeys, relayout, tileById } from './today.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (cls, text, onClick) => {
  const b = el('button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
};

let ctx = null;
let prefs = null;
let saveTimer = 0;

/** Tile and section names (the sheet, the menus and what is announced). */
export function tileTitle(id) {
  const words = {
    'td-calendar': t('Your day'), 'td-weather': t('Weather'), 'td-dates': t('Coming up'), 'td-needs': t('Needs you'), 'td-mail': t('Mail'),
    'td-memories': t('She remembered'), 'td-otd': t('Moments'), 'td-plans': t('Her plans'), 'td-rooms': t('Rooms'), 'td-jobs': t('Running now'),
    'td-board': t('On the board'), 'td-projects': t('Coding projects'), 'td-usage': t('Usage today'), 'td-business': t('Money and replies'), 'td-money': t('Money'), 'td-home': t('Home'), 'td-models': t('Model changes'),
    'td-hooks': t('From your webhooks'), 'td-watching': t('Watching'), 'td-teams': t('My teams'), 'td-agenda': t('Planner'), 'td-setup': t('Add to your day'),
  };
  return words[id] ?? id;
}
export function sectionTitle(id) {
  return { day: t('Your day'), needs: t('Needs you'), her: t('With her'), work: t('Work'), more: t('Home & more') }[id] ?? id;
}
/** Each tile row's ? tip in the sheet: what it shows and where its data comes from (≤ 260 characters). */
export function tileTip(id) {
  const tips = {
    'td-calendar': t('Your calendar, reminders, to-dos with a time and leave-by times on one line, with a Now marker. From Google Calendar and the Planner.'),
    'td-weather': t('The weather where you get your morning briefing, from Open-Meteo, updated every 15 minutes.'),
    'td-dates': t('Events, dates she remembered and birthdays from your people cards for the next days.'),
    'td-needs': t('Everything waiting on you in one list: approvals, failed work, overdue to-dos, cards waiting on you, important mail and webhooks.'),
    'td-mail': t('Your inbox from Gmail: total and unread, the change since yesterday, what looks important, and what she organized today, with Undo.'),
    'td-memories': t('The newest things she learned about you, from her memory.'),
    'td-otd': t('A photo from this day in the past, or your newest moments.'),
    'td-plans': t('Her own plans for today: the messages she plans to send and why.'),
    'td-rooms': t('What is going on in the Discord channels and Telegram groups where Keep up is on, from her room summary. Only for you.'),
    'td-jobs': t('Background jobs and team tasks that are running, and how today’s runs went.'),
    'td-board': t('Board cards she is working on.'),
    'td-projects': t('Coding workspaces from the last 7 days: the last change, the last tests and open pull requests when GitHub is connected.'),
    'td-usage': t('Tokens and estimated cost since midnight. Local models and subscriptions count as $0.'),
    'td-business': t('Unpaid invoices (and how many are overdue) and how many people were waiting on a reply at the last check. Shows once you make an invoice or ask who you owe a reply.'),
    'td-money': t('Your portfolio’s value and today’s move (with the price source and time), bills due this week and what you spent this month. Shows once you load holdings, bank exports or add a bill.'),
    'td-home': t('Who is home, the scenes you picked and a few devices from Home Assistant.'),
    'td-models': t('Models that were retired and what uses their replacement now.'),
    'td-hooks': t('Important webhook deliveries. They also show in Needs you.'),
    'td-watching': t('Your “tell me when” watches on prices, games and odds, with the last value she saw.'),
    'td-teams': t('The teams you follow: the next game, the last result and a live score, from ESPN. Shows once you follow a team.'),
    'td-agenda': t('Your to-dos for today as a list. They also show on Your day and in Needs you.'),
    'td-setup': t('Things you could add to Today, like the weather or your calendar.'),
  };
  return tips[id] ?? '';
}

// ---------- the model (pure; tested in Node) ----------

/** The prefs with one tile moved up or down inside its section. */
export function moveTile(p, id, dir) {
  const def = tileById(id);
  if (!def) return p;
  const sec = layoutModel(p).find((s) => s.id === def.section);
  const ids = sec.tiles.map((x) => x.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return p;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { ...p, order: { ...(p.order ?? {}), [def.section]: ids } };
}
/** The prefs with a whole section moved up or down. */
export function moveSection(p, sec, dir) {
  const ids = layoutModel(p).map((s) => s.id);
  const i = ids.indexOf(sec);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return p;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { ...p, sections: ids };
}
/** The prefs with a tile one size smaller or larger (only the sizes it allows). */
export function resizeTile(p, id, dir) {
  const def = tileById(id);
  if (!def) return p;
  const cur = layoutModel(p).flatMap((s) => s.tiles).find((x) => x.id === id).size;
  const i = def.sizes.indexOf(cur) + dir;
  if (i < 0 || i >= def.sizes.length) return p;
  return setTile(p, id, { size: def.sizes[i] });
}
export function setTile(p, id, patch) {
  const tiles = { ...(p.tiles ?? {}) };
  tiles[id] = { ...(tiles[id] ?? {}), ...patch };
  const next = { ...p, tiles };
  // The Rooms tile's switch is its own setting (off by default, owner decision 2026-11-01).
  if (id === 'td-rooms' && patch.hidden !== undefined) next.rooms = { ...(p.rooms ?? { ids: [] }), on: !patch.hidden };
  return next;
}

// ---------- saving ----------

function changed(next, { save = true } = {}) {
  prefs = next;
  relayout(prefs);
  if (!$('#td-custom').hidden) drawSheet();
  if (!save) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), 400);
}
async function flush() {
  clearTimeout(saveTimer);
  try {
    const r = await ctx.api('/today/layout', { method: 'PUT', body: prefs });
    prefs = { ...prefs, ...r.prefs };
  } catch (err) {
    ctx.status(err.message);
  }
}
/** A patch from a tile (Home picks, Add to your day's Hide): saved, then that part reloads. */
export function savePrefs(patch) {
  changed({ ...prefs, ...patch });
  setTimeout(() => ctx.reloadParts?.(['layout', 'home']), 700);
}

function announce(text) {
  const live = $('#td-live');
  if (live) live.textContent = text;
}
function position(id) {
  const def = tileById(id);
  const sec = layoutModel(prefs).find((s) => s.id === def.section);
  return { section: sectionTitle(def.section), n: sec.tiles.findIndex((x) => x.id === id) + 1 };
}

let toastTimer = 0;
function hideWithUndo(id) {
  const before = prefs;
  changed(setTile(prefs, id, { hidden: true }));
  $('#td-toast-text').textContent = t('Hidden “{tile}”', { tile: tileTitle(id) });
  $('#td-toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#td-toast').hidden = true), 8000);
  $('#td-toast-undo').onclick = () => {
    $('#td-toast').hidden = true;
    changed(before);
    $(`#${id}`)?.focus();
  };
}

// ---------- the ⋯ menu on each tile ----------

let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.button.setAttribute('aria-expanded', 'false');
  openMenu = null;
}
/** The ⋯ button for a tile's head (today.js tileHead asks for it). */
export function tileMenu(tile) {
  const b = btn('ghost icon td-more', '');
  b.append(icon('dots') ?? document.createTextNode('⋯'));
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.setAttribute('aria-label', t('Options for {tile}', { tile: tileTitle(tile.id) }));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenu?.button === b) return closeMenu();
    closeMenu();
    const id = tile.id;
    const def = tileById(id);
    const cur = layoutModel(prefs).flatMap((s) => s.tiles).find((x) => x.id === id);
    const menu = el('div', 'td-menu');
    menu.setAttribute('role', 'menu');
    const item = (text, on, fn) => {
      const m = btn('td-menu-item', text, () => {
        closeMenu();
        fn();
      });
      m.setAttribute('role', 'menuitem');
      m.disabled = !on;
      return m;
    };
    const idx = def.sizes.indexOf(cur.size);
    const sec = layoutModel(prefs).find((s) => s.id === def.section).tiles;
    const at = sec.findIndex((x) => x.id === id);
    menu.append(
      item(t('Smaller'), idx > 0, () => changed(resizeTile(prefs, id, -1))),
      item(t('Larger'), idx < def.sizes.length - 1, () => changed(resizeTile(prefs, id, 1))),
      item(t('Move up'), at > 0, () => changed(moveTile(prefs, id, -1))),
      item(t('Move down'), at < sec.length - 1, () => changed(moveTile(prefs, id, 1))),
      item(t('Hide this tile'), true, () => hideWithUndo(id)),
      item(t('Customize Today'), true, () => openSheet()),
    );
    b.after(menu);
    b.setAttribute('aria-expanded', 'true');
    openMenu = { menu, button: b };
    menu.querySelector('button:not(:disabled)')?.focus();
    menu.addEventListener('keydown', (ev) => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') (ev.preventDefault(), items[(i + 1) % items.length]?.focus());
      else if (ev.key === 'ArrowUp') (ev.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus());
      else if (ev.key === 'Escape') (ev.preventDefault(), ev.stopPropagation(), closeMenu(), b.focus());
    });
  });
  return b;
}

/** Alt+↑/↓ moves the focused tile, Alt+←/→ resizes it (§9). */
function onTileKey(e) {
  if (!e.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tile = e.target.closest?.('.td-tile');
  if (!tile || tile !== e.target || !tileById(tile.id)) return;
  e.preventDefault();
  const id = tile.id;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    changed(moveTile(prefs, id, e.key === 'ArrowUp' ? -1 : 1));
    const p = position(id);
    announce(t('{tile} moved to {section}, position {n}', { tile: tileTitle(id), section: p.section, n: p.n }));
  } else {
    changed(resizeTile(prefs, id, e.key === 'ArrowLeft' ? -1 : 1));
    const cur = layoutModel(prefs).flatMap((s) => s.tiles).find((x) => x.id === id);
    announce(t('{tile} is now size {size}', { tile: tileTitle(id), size: cur.size }));
  }
  tile.focus();
}

// ---------- the Customise sheet ----------

const SIZE_WORDS = () => ({ S: t('Small'), M: t('Medium'), L: t('Large') });
let dragId = null;

function drawSheet() {
  const box = $('#td-custom-list');
  const model = layoutModel(prefs, { member: ctx.member() });
  box.replaceChildren(
    ...model.map((sec, si) => {
      const card = el('section', 'td-custom-card td-c-sec');
      card.setAttribute('aria-label', sectionTitle(sec.id));
      const head = el('div', 'td-c-sec-head');
      head.append(el('h3', '', sectionTitle(sec.id)), arrows(si > 0, si < model.length - 1, (dir) => changed(moveSection(prefs, sec.id, dir)), sectionTitle(sec.id)));
      const ul = el('ul', 'td-c-tiles');
      sec.tiles.forEach((x, i) => ul.append(tileRow(x, i, sec.tiles.length)));
      card.append(head, ul);
      return card;
    }),
  );
  $('#td-away-hours').value = String(prefs.awayHours ? prefs.awayHours : 3);
  $('#td-away-hours-n').textContent = prefs.awayHours ? t('{n} hours away', { n: prefs.awayHours }) : t('Off');
  $('#td-needs-mail').checked = prefs.needsMail !== false;
  $('#td-away-voice').checked = prefs.awayVoice === true;
  $('#td-away-rooms').checked = prefs.awayRooms === true;
  // Include rooms is the owner's (members and the demo never see rooms on Today).
  $('#td-away-rooms-row').hidden = ctx.member() || ctx.demo();
  $('#td-usage-cost').checked = prefs.usageCost !== false;
  $('#td-coming-days').value = String(prefs.comingDays ?? 7);
  $('#td-phone-open').value = prefs.phoneOpen ?? 'left';
  // Rooms (owner and main companion only: the server sends the list only there).
  const rooms = ctx.data()?.rooms?.available ?? ctx.roomsAvailable?.() ?? null;
  const roomsCard = $('#td-custom-rooms');
  roomsCard.hidden = ctx.member() || ctx.demo() || !rooms;
  $('#td-rooms-on').checked = Boolean(prefs.rooms?.on);
  const picks = $('#td-rooms-picks');
  picks.hidden = !prefs.rooms?.on;
  picks.replaceChildren(
    ...(rooms ?? []).map((r) => {
      const lab = el('label', 'row td-c-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(r.id);
      cb.dataset.nodirty = '';
      // All by default once on (an empty pick list means every keep-up room).
      cb.checked = !prefs.rooms?.ids?.length || prefs.rooms.ids.includes(r.id);
      cb.addEventListener('change', () => {
        const ids = [...picks.querySelectorAll('input:checked')].map((c) => Number(c.value));
        changed({ ...prefs, rooms: { on: true, ids: ids.length === rooms.length ? [] : ids } });
        setTimeout(() => ctx.reloadParts?.(['rooms']), 700);
      });
      const name = el('span', '', r.name);
      name.dataset.raw = '';
      lab.append(cb, name);
      return lab;
    }),
  );
  if (rooms && !rooms.length) picks.replaceChildren(el('p', 'muted small', t('No room has Keep up on yet. Switch it on in Settings → Chats → Rooms.')));
}

function arrows(up, down, fn, what) {
  const g = el('span', 'td-c-arrows');
  const u = btn('ghost icon td-c-up', '↑', () => fn(-1));
  u.disabled = !up;
  u.setAttribute('aria-label', t('Move {what} up', { what }));
  const d = btn('ghost icon td-c-down', '↓', () => fn(1));
  d.disabled = !down;
  d.setAttribute('aria-label', t('Move {what} down', { what }));
  g.append(u, d);
  return g;
}

function tileRow(x, i, n) {
  const li = el('li', `td-c-tile${x.shown ? '' : ' off'}`);
  li.dataset.id = x.id;
  // Drag (mouse and touch) as well as the ↑/↓ buttons.
  const grip = el('span', 'td-c-grip');
  grip.setAttribute('aria-hidden', 'true');
  grip.append(icon('menu') ?? document.createTextNode('≡'));
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    dragId = x.id;
    li.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', x.id);
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
  });
  li.addEventListener('dragover', (e) => {
    if (dragId && tileById(dragId)?.section === tileById(x.id).section) e.preventDefault();
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragId || dragId === x.id) return;
    const sec = tileById(x.id).section;
    const ids = layoutModel(prefs).find((s) => s.id === sec).tiles.map((y) => y.id).filter((y) => y !== dragId);
    ids.splice(ids.indexOf(x.id), 0, dragId);
    changed({ ...prefs, order: { ...(prefs.order ?? {}), [sec]: ids } });
  });
  const name = el('span', 'td-c-name', tileTitle(x.id));
  const tip = btn('tip', '?');
  tip.dataset.tip = tileTip(x.id);
  tip.dataset.guide = 'today';
  tip.setAttribute('aria-label', t('What is this?'));
  const label = el('span', 'td-c-label');
  label.append(name, tip);
  const size = document.createElement('select');
  size.className = 'td-c-size';
  size.dataset.noauto = '';
  size.setAttribute('aria-label', t('Size of {tile}', { tile: tileTitle(x.id) }));
  for (const z of x.sizes) size.append(new Option(SIZE_WORDS()[z], z, z === x.size, z === x.size));
  size.disabled = x.sizes.length < 2;
  size.addEventListener('change', () => changed(setTile(prefs, x.id, { size: size.value })));
  const show = el('label', 'td-c-show');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = x.shown;
  cb.dataset.nodirty = '';
  cb.setAttribute('aria-label', t('Show {tile}', { tile: tileTitle(x.id) }));
  cb.addEventListener('change', () => (cb.checked ? changed(setTile(prefs, x.id, { hidden: false })) : hideWithUndo(x.id)));
  show.append(cb, el('span', 'small', t('Show')));
  li.append(grip, label, size, show, arrows(i > 0, i < n - 1, (dir) => changed(moveTile(prefs, x.id, dir)), tileTitle(x.id)));
  return li;
}

export const editing = () => !$('#td-custom')?.hidden;
export function openSheet() {
  closeMenu();
  drawSheet();
  $('#td-custom').hidden = false;
  document.documentElement.classList.add('td-editing');
  $('#td-custom-done').focus();
}
async function closeSheet() {
  $('#td-custom').hidden = true;
  document.documentElement.classList.remove('td-editing');
  await flush();
  $('#td-custom-open')?.focus();
}

/** Called with each batched answer: this companion's prefs (and the old device keys, once). */
export function setPrefs(p) {
  if (!p) return;
  if (editing()) return;
  prefs = p;
  const patch = migrateDeviceKeys(p, globalThis.localStorage);
  if (patch) {
    prefs = { ...prefs, ...patch };
    void ctx.api('/today/layout', { method: 'PUT', body: patch }).catch(() => {});
  }
}
export const layoutPrefs = () => prefs;
/**
 * Phase 112 (TD2): a section opened or closed on a phone or a tablet, saved for this companion and
 * that form factor only (the desktop never collapses).
 */
export function saveCollapsed(form, list) {
  if (!prefs || (form !== 'phone' && form !== 'tablet')) return;
  changed({ ...prefs, collapsed: { ...(prefs.collapsed ?? { phone: [], tablet: [] }), [form]: [...list] } });
}

export function initTodayLayout(c) {
  ctx = c;
  $('#td-custom-open')?.addEventListener('click', () => (editing() ? void closeSheet() : openSheet()));
  $('#td-custom-done')?.addEventListener('click', () => void closeSheet());
  $('#td-custom-reset')?.addEventListener('click', async () => {
    if (!confirm(t('Put every tile back where it was designed to be?'))) return;
    try {
      const r = await ctx.api('/today/layout', { method: 'DELETE' });
      prefs = r.prefs;
      relayout(prefs);
      drawSheet();
      ctx.reloadParts?.(['layout', 'rooms']);
    } catch (err) {
      ctx.status(err.message);
    }
  });
  $('#td-away-hours')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#td-away-hours-n').textContent = v <= 3 ? t('Off') : t('{n} hours away', { n: v });
  });
  $('#td-away-hours')?.addEventListener('change', (e) => changed({ ...prefs, awayHours: Number(e.target.value) <= 3 ? 0 : Number(e.target.value) }));
  $('#td-away-voice')?.addEventListener('change', (e) => {
    changed({ ...prefs, awayVoice: e.target.checked });
    setTimeout(() => ctx.reloadParts?.(['away']), 700);
  });
  $('#td-away-rooms')?.addEventListener('change', (e) => {
    changed({ ...prefs, awayRooms: e.target.checked });
    setTimeout(() => ctx.reloadParts?.(['away']), 700);
  });
  $('#td-needs-mail')?.addEventListener('change', (e) => {
    changed({ ...prefs, needsMail: e.target.checked });
    setTimeout(() => ctx.reloadParts?.(['needs']), 700);
  });
  $('#td-usage-cost')?.addEventListener('change', (e) => {
    changed({ ...prefs, usageCost: e.target.checked });
    setTimeout(() => ctx.reloadParts?.(['usage']), 700);
  });
  $('#td-coming-days')?.addEventListener('change', (e) => {
    changed({ ...prefs, comingDays: Number(e.target.value) });
    setTimeout(() => ctx.reloadParts?.(['coming']), 700);
  });
  $('#td-phone-open')?.addEventListener('change', (e) => changed({ ...prefs, phoneOpen: e.target.value }));
  $('#td-rooms-on')?.addEventListener('change', (e) => {
    changed({ ...prefs, rooms: { on: e.target.checked, ids: prefs.rooms?.ids ?? [] }, tiles: { ...(prefs.tiles ?? {}), 'td-rooms': { ...(prefs.tiles?.['td-rooms'] ?? {}), hidden: !e.target.checked } } });
    setTimeout(() => ctx.reloadParts?.(['rooms']), 700);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editing() && !e.defaultPrevented) {
      e.preventDefault();
      void closeSheet();
    }
  });
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.menu.contains(e.target)) closeMenu();
  });
  $('#td-tiles')?.addEventListener('keydown', onTileKey);
}

export { SECTIONS, TILES };
