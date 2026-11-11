// Phase 75 (stage 1): the new look's small controls around the chat.
// - The composer's "+" menu (attach a file, a photo, something to do together).
// - On phones the header's chips (model/workspace, voice, server) fold behind one ⋯ button.
// - The context ring in the header and its sheet ("This conversation is 46% full").
// - Message actions on touch: a long-press on a message (or its small ⋯) shows them.
// - Her glow breathes while she thinks and works (a class on <html>).
// Popovers close on Escape, a tap outside, or picking something; focus returns to their button.
import { t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
const pops = [];
function closeMsgActions() {
  for (const m of document.querySelectorAll('#messages .msg.show-actions')) {
    m.classList.remove('show-actions');
    m.querySelector(':scope > .msg-more')?.setAttribute('aria-expanded', 'false');
  }
}

function popover(button, panel, { onOpen } = {}) {
  const set = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('on', open);
    if (open) {
      for (const p of pops) if (p.panel !== panel && !p.panel.hidden && !(p.panel.classList.contains('head-chips') && !p.panel.classList.contains('folded'))) p.set(false);
      closeMsgActions();
      onOpen?.();
    }
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    set(panel.hidden);
    if (!panel.hidden) panel.querySelector('button:not([hidden]), a')?.focus({ preventScroll: true });
  });
  panel.addEventListener('click', (e) => {
    // Picking an item closes a menu (the sheet stays until a tap outside).
    if (panel.getAttribute('role') === 'menu' && e.target instanceof Element && e.target.closest('button')) set(false);
  });
  pops.push({ button, panel, set });
  return set;
}

export function initLook() {
  const plus = $('#composer-plus');
  const menu = $('#composer-menu');
  if (plus && menu) {
    popover(plus, menu);
    // Arrow keys move through the menu.
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button')].filter((b) => !b.hidden && b.offsetParent !== null);
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });
  }
  const more = $('#head-more');
  const chips = $('#head-chips');
  if (more && chips) {
    const set = popover(more, chips);
    // After the click that asked for it has finished (its outside-click would close it again).
    openChips = () => new Promise((done) => setTimeout(() => {
      if (chips.classList.contains('folded')) set(true);
      done();
    }, 0));
    // Wide screens show the chips in the header; only phones fold them away.
    const wide = matchMedia('(min-width: 721px)');
    const sync = () => {
      chips.classList.toggle('folded', !wide.matches);
      if (wide.matches) {
        chips.hidden = false;
        more.setAttribute('aria-expanded', 'false');
      } else set(false);
    };
    wide.addEventListener('change', sync);
    sync();
    chips.addEventListener('click', (e) => {
      if (!wide.matches && e.target instanceof Element && e.target.closest('button')) set(false);
    });
  }
  const ring = $('#ctx-ring');
  const sheet = $('#ctx-sheet');
  if (ring && sheet) popover(ring, sheet);

  document.addEventListener('click', (e) => {
    for (const p of pops) {
      if (p.panel.hidden || p.panel.classList.contains('head-chips') && !p.panel.classList.contains('folded')) continue;
      if (e.target instanceof Node && (p.panel.contains(e.target) || p.button.contains(e.target))) continue;
      p.set(false);
    }
    // A tap outside an open message closes its actions.
    if (e.target instanceof Element && !e.target.closest('#messages .msg.show-actions')) closeMsgActions();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMsgActions();
    for (const p of pops) {
      if (p.panel.hidden || (p.panel.classList.contains('head-chips') && !p.panel.classList.contains('folded'))) continue;
      p.set(false);
      p.button.focus();
    }
  });

  // Long-press a message on a touch screen: its actions (copy, pin, keep, regenerate…) show.
  const box = $('#messages');
  let press = null;
  box?.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const msg = e.target instanceof Element ? e.target.closest('.msg') : null;
    if (!msg?.querySelector(':scope > .msg-actions') || e.target.closest('button, a, input, select, textarea')) return;
    const x = e.clientX;
    const y = e.clientY;
    press = { msg, x, y, timer: setTimeout(() => {
      msg.querySelector(':scope > .msg-more')?.click();
      msg.dataset.pressed = '1';
      press = null;
    }, 480) };
  });
  const cancel = (e) => {
    if (!press) return;
    if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return;
    clearTimeout(press.timer);
    press = null;
  };
  for (const ev of ['pointerup', 'pointercancel', 'pointermove', 'scroll']) box?.addEventListener(ev, cancel, { passive: true });
  // The click right after a long-press doesn't also count as a tap.
  box?.addEventListener('click', (e) => {
    const msg = e.target instanceof Element ? e.target.closest('.msg[data-pressed]') : null;
    if (msg) {
      delete msg.dataset.pressed;
      e.stopPropagation();
    }
  }, true);
  box?.addEventListener('contextmenu', (e) => {
    if (e.target instanceof Element && e.target.closest('.msg[data-pressed]')) e.preventDefault();
  });
}

let openChips = async () => {};
/** Phones: unfolds the header's chips (the tour points at the conversation settings in there). */
export const showHeadChips = () => openChips();

/**
 * The header ring: `pct` of what she keeps word for word, or null to hide it. `kept` is how many
 * messages that is (the sheet explains it in plain words).
 */
export function setContextRing(pct, kept, fill) {
  const ring = $('#ctx-ring');
  if (!ring) return;
  ring.hidden = pct === null;
  if (pct === null) {
    $('#ctx-sheet').hidden = true;
    return;
  }
  ring.style.setProperty('--ctx', String(pct));
  ring.dataset.pct = String(pct);
  ring.classList.toggle('full', pct >= 100);
  ring.classList.toggle('high', pct >= 80 && pct < 100);
  // 3.3.0 (ezplain): an everyday setup shows the ring only from here (web/v4.css).
  ring.classList.toggle('warm', pct >= 60);
  $('#ctx-pct').textContent = `${pct}%`;
  const words = pct >= 100 ? t('Nothing is lost, keep talking: this chat is long, so she now keeps its oldest messages as short notes she still remembers.') : t('This conversation is {pct}% full', { pct });
  $('#ctx-full').textContent = words;
  // 3.4.1: in plain words, from the server's measure (the same budget /status and tidying use).
  const tk = fill?.tokens;
  const w = (n) => Math.max(0, Math.round((Number(n) * 0.75) / 100) * 100).toLocaleString();
  $('#ctx-how').textContent = tk?.keep
    ? `${t('About {pct}% of what she can hold: about {used} of {keep} words of this chat, word for word.', { pct, used: w(tk.used), keep: w(tk.keep) })} ${t('Older parts live on as the notes and summaries she writes.')}${fill.model ? ` ${t('Follows the model: {model}.', { model: fill.model })}` : ''}`
    : t('She keeps the last {n} messages of a conversation in mind word for word. Older ones live on as the notes and summaries she writes.', { n: kept });
  ring.title = words;
  ring.setAttribute('aria-label', words);
}

/** Her glow: breathes while she thinks, works or waits; brighter while she writes. */
export function setLookBusy(status) {
  const root = document.documentElement;
  root.classList.toggle('sara-busy', Boolean(status) && status !== 'listening' && status !== 'hearing');
  root.classList.toggle('sara-speaking', status === 'writing' || status === 'answering');
}
