// UI cleanup (wave 2): small shared behaviour for the windows (Planner, Memory, Library, Your story,
// Our moments, Scrapbook, Team). Each window's opening paragraph shows two lines with "Show more",
// so the controls sit near the top instead of under a wall of text. Styles live in ui-tidy.css.
import { t } from './naming.js';
import { icon as makeIcon, ICONS } from './icons.js';

/** The windows whose first paragraph (right under the title) is folded to two lines. */
export const INTRO_WINDOWS = ['#planner', '#memory', '#lib-home', '#story', '#moments', '#scrapbook', '#team'];

/** Folds one paragraph to two lines and adds a Show more / Show less button under it when it's longer. */
export function foldIntro(p) {
  if (!p || p.classList.contains('dlg-intro')) return;
  p.classList.add('dlg-intro');
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'linkish dlg-more';
  more.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  const label = () => (more.textContent = p.classList.contains('open') ? t('Show less') : t('Show more'));
  label();
  more.addEventListener('click', () => {
    p.classList.toggle('open');
    more.setAttribute('aria-expanded', String(p.classList.contains('open')));
    label();
  });
  p.after(more);
  // Shown only when the folded text is really cut (measured once the window is on screen).
  const measure = () => {
    if (p.classList.contains('open') || !p.clientHeight) return;
    more.hidden = p.scrollHeight <= p.clientHeight + 2;
    label();
  };
  if ('ResizeObserver' in window) new ResizeObserver(measure).observe(p);
  else more.hidden = false;
}

/**
 * A ⋯ button that lists the visible buttons of its overflow box (`.tidy-overflow`, next to it) in a
 * small menu. The real buttons stay in the page with their ids and handlers; the menu clicks them.
 */
export function overflowMenu(more, box) {
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = document.querySelector('.pop-menu.tidy-pop');
    for (const m of document.querySelectorAll('.pop-menu')) m.remove();
    if (open?.dataset.for === more.dataset.moreId) return;
    const menu = document.createElement('div');
    menu.className = 'pop-menu tidy-pop';
    menu.setAttribute('role', 'menu');
    menu.dataset.for = more.dataset.moreId ?? '';
    for (const b of box.querySelectorAll('button, a')) {
      if (b.hidden) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.className = `pop-item${b.classList.contains('danger-text') || b.classList.contains('danger') ? ' danger-text' : ''}`;
      item.textContent = b.textContent;
      if (b.title) item.title = b.title;
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.remove();
        b.click();
      });
      menu.append(item);
    }
    if (!menu.children.length) return;
    // Inside a window the menu must sit in the window's top layer, or it shows behind it.
    (more.closest('dialog') ?? document.body).append(menu);
    const r = more.getBoundingClientRect();
    menu.style.setProperty('top', `${Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4))}px`);
    menu.style.setProperty('left', `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`);
    menu.querySelector('button')?.focus();
  });
}

let moreIds = 0;
/** Wires every ⋯ button written in the page (`.tidy-more-btn` followed by its `.tidy-overflow`). */
export function wireOverflow(root = document) {
  for (const more of root.querySelectorAll('.tidy-more-btn:not([data-more-id])')) {
    const box = more.nextElementSibling?.classList.contains('tidy-overflow') ? more.nextElementSibling : null;
    if (!box) continue;
    more.dataset.moreId = String(++moreIds);
    overflowMenu(more, box);
  }
}

/**
 * The one empty state (Phase 114 PL1c, docs/design/POLISH.md §4.4; styles: .empty-state in kit.css):
 * an icon in a soft circle, what goes here in one sentence, why it's empty or how it fills (muted),
 * then at most one main button and a "How do I…?" link to the page's own block.
 *   emptyState({ icon, text, why, action: { label, run }, howto: true, tag })
 *   emptyState(icon, text, tag, hint)   (the older call, same look)
 * `icon` is a name from icons.js (an outline icon) or, for content, an emoji.
 */
export function emptyState(icon, text, tag = 'div', hint = '') {
  const o = icon && typeof icon === 'object' ? icon : { icon, text, tag, why: hint };
  const box = document.createElement(o.tag ?? 'div');
  box.className = 'empty-state';
  const add = (cls, words) => {
    const span = document.createElement('span');
    span.className = cls;
    if (words !== undefined) span.textContent = words;
    box.append(span);
    return span;
  };
  const ring = add('empty-icon');
  ring.setAttribute('aria-hidden', 'true');
  const svg = o.icon && ICONS[o.icon] ? makeIcon(o.icon) : null;
  if (svg) ring.append(svg);
  else ring.textContent = o.icon ?? '';
  add('empty-text', o.text);
  if (o.why) add('empty-hint', o.why);
  if (o.action || o.howto) {
    const row = add('empty-actions');
    if (o.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = o.action.ghost ? 'ghost small' : 'small';
      b.textContent = o.action.label;
      b.addEventListener('click', () => o.action.run());
      row.append(b);
    }
    if (o.howto) {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'linkish small empty-howto';
      h.textContent = `${t('How do I…?')} ▸`;
      h.addEventListener('click', () => openHowtoNear(h));
      row.append(h);
    }
  }
  return box;
}
/** Opens the "How do I…?" block of the window or Settings page a control is in. */
export function openHowtoNear(node) {
  const scope = node.closest('dialog') ?? document;
  const block = [...scope.querySelectorAll('details.howto')].find((d) => d.getClientRects().length);
  if (!block) return false;
  block.open = true;
  block.scrollIntoView({ block: 'nearest' });
  block.querySelector('summary')?.focus();
  return true;
}

export function initTidy() {
  wireOverflow();
  for (const sel of INTRO_WINDOWS) {
    const box = document.querySelector(sel);
    const h2 = box?.querySelector('h2');
    const p = h2?.nextElementSibling;
    if (p?.tagName === 'P' && p.classList.contains('muted')) foldIntro(p);
  }
}
