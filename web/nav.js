// The sidebar's places (Today, Planner, Memory…): a short list of pinned places, everything else
// under More, and her face with Settings and Help in a row below. The owner pins and unpins places
// (saved per device in localStorage), so new places land in More instead of making the box bigger.
// The buttons keep their ids (#open-today…), so shortcuts, /#view= links and the tours still work.
import { t } from './naming.js';
import { icon } from './icons.js';

/** Every place, in the order they are listed. */
// V3 (docs/ops/V3_DESIGN.md §2): Add-ons is a place too (it opens Settings → Add-ons → Get more). New
// devices pin it; a device that saved its own pins finds it under More.
export const DESTS = ['today', 'planner', 'memory', 'library', 'scrapbook', 'moments', 'story', 'team', 'findings', 'evals', 'addons'];
export const DEFAULT_PINS = ['today', 'planner', 'library', 'addons', 'moments'];
const KEY = 'sara.navPins';
/** The window each place opens (to show which one is open). */
const DIALOG = { today: 'today', planner: 'planner', memory: 'memory', library: 'library', scrapbook: 'scrapbook', moments: 'moments', story: 'story', team: 'team', findings: 'findings', evals: 'evals' };

const $ = (s) => document.querySelector(s);
const PIN_PATH = 'M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8';

/** The pinned places, in list order (unknown names dropped; a broken value means the defaults). */
export function pinsFrom(raw) {
  try {
    const list = JSON.parse(raw ?? 'null');
    if (!Array.isArray(list)) return [...DEFAULT_PINS];
    return DESTS.filter((d) => list.includes(d));
  } catch {
    return [...DEFAULT_PINS];
  }
}
const readPins = () => pinsFrom(localStorage.getItem(KEY));

function svg(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  s.append(p);
  return s;
}

const nameOf = (dest) => document.querySelector(`.side-dest[data-dest="${dest}"] .side-go span`)?.textContent?.trim() || dest;

function pinButton(dest) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'side-pin';
  b.dataset.pin = dest;
  b.append(icon('pin') ?? svg(PIN_PATH));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const pins = readPins();
    setPins(pins.includes(dest) ? pins.filter((x) => x !== dest) : [...pins, dest]);
    // Keep the keyboard where it was: on the same place's pin, wherever it moved.
    document.querySelector(`.side-pin[data-pin="${dest}"]`)?.focus();
  });
  return b;
}

function labelPins() {
  const pins = readPins();
  for (const b of document.querySelectorAll('.side-pin')) {
    const on = pins.includes(b.dataset.pin);
    const name = nameOf(b.dataset.pin);
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? t('Unpin {name} from your sidebar', { name }) : t('Pin {name} to your sidebar', { name });
    b.setAttribute('aria-label', b.title);
  }
}

/** Puts each place in the pinned list or under More, and saves the choice on this device. */
export function setPins(list) {
  const pins = DESTS.filter((d) => list.includes(d));
  localStorage.setItem(KEY, JSON.stringify(pins));
  layout();
}

function layout() {
  const pins = readPins();
  const pinned = $('#side-pinned');
  const more = $('#side-more-list');
  if (!pinned || !more) return;
  for (const d of DESTS) {
    const row = document.querySelector(`.side-dest[data-dest="${d}"]`);
    if (row) (pins.includes(d) ? pinned : more).append(row);
  }
  const visible = (n) => n.getClientRects().length > 0 || getComputedStyle(n).display !== 'none';
  const left = [...more.children].filter(visible).length;
  $('#side-more-empty').hidden = left > 0;
  labelPins();
  syncDot();
}

function syncDot() {
  const dot = $('#team-dot');
  $('#more-dot').hidden = !dot || dot.hidden || !$('#side-more-list').contains(dot);
}

const menu = () => $('#side-more-menu');
export const moreOpen = () => !menu().hidden;

/** Opens or closes the More list. */
export function setMore(open, { focus = false } = {}) {
  const m = menu();
  if (!m || m.hidden === !open) return;
  // Never taller than the room above the list (large text, short windows).
  if (open) m.style.setProperty('--more-room', `${Math.max(160, Math.round($('#side-nav').getBoundingClientRect().top - 12))}px`);
  m.hidden = !open;
  $('#side-more').setAttribute('aria-expanded', String(open));
  $('#side-nav').classList.toggle('more-open', open);
  if (open && focus) m.querySelector('.side-go:not([hidden]), .side-pin')?.focus();
}

/** For the tours: shows the place a step points at (opens More when it lives there). */
export function revealNav(sel) {
  const el = document.querySelector(sel);
  setMore(Boolean(el && menu().contains(el)));
}

export function initNav() {
  if (!$('#side-nav')) return;
  for (const row of document.querySelectorAll('.side-dest')) row.append(pinButton(row.dataset.dest));
  layout();
  $('#side-more').addEventListener('click', (e) => {
    e.stopPropagation();
    setMore(!moreOpen(), { focus: e.detail === 0 });
  });
  // Choosing a place closes the list; a click anywhere else closes it too.
  menu().addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.side-go')) setMore(false);
  });
  document.addEventListener('click', (e) => {
    if (moreOpen() && e.target instanceof Element && !e.target.closest('#side-more-menu, #side-more, .tour-card')) setMore(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!moreOpen()) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setMore(false);
      $('#side-more').focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!(document.activeElement instanceof Element) || !menu().contains(document.activeElement)) return;
    const items = [...menu().querySelectorAll('.side-go, .side-pin')].filter((n) => n.getClientRects().length);
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  // The team's "working" dot also shows on More while Team is in there.
  const dot = $('#team-dot');
  if (dot) new MutationObserver(syncDot).observe(dot, { attributes: true, attributeFilter: ['hidden'] });
  // The place whose window is open is marked in the list.
  const mark = () => {
    for (const [dest, id] of Object.entries(DIALOG)) document.querySelector(`#open-${dest}`)?.classList.toggle('is-open', Boolean(document.getElementById(id)?.open));
  };
  for (const id of Object.values(DIALOG)) {
    const d = document.getElementById(id);
    if (d) new MutationObserver(mark).observe(d, { attributes: true, attributeFilter: ['open'] });
  }
}

/**
 * V3 §2: outside Sara Classic the places lead the sidebar (Go to, then Projects and Conversations) and
 * her face, Help and Settings sit in a footer row. The nodes move in the DOM, so the focus order is the
 * order you see; Sara Classic keeps the places under the list, exactly as before.
 */
export function placeRail(on = document.documentElement.dataset.palette !== 'classic') {
  const side = $('#sidebar');
  const nav = $('#side-nav');
  const convs = $('#conversations');
  if (!side || !nav || !convs) return;
  let foot = $('#side-foot');
  const row = document.querySelector('#sidebar .side-foot-row');
  const upd = $('#side-update');
  if (on) {
    if (nav.nextElementSibling !== convs) convs.before(nav);
    if (!foot) {
      foot = document.createElement('div');
      foot.id = 'side-foot';
      foot.className = 'side-foot';
      side.append(foot);
    }
    if (row && row.parentElement !== foot) foot.append(row);
    if (upd && upd.parentElement !== foot) foot.append(upd);
  } else {
    if (row && row.parentElement !== nav) nav.append(row);
    if (upd && upd.parentElement !== nav) nav.append(upd);
    if (convs.nextElementSibling !== nav) convs.after(nav);
    foot?.remove();
  }
  side.classList.toggle('rail', on);
}

/** After a language change: the pins' labels use the new words. */
export const relabelNav = labelPins;
