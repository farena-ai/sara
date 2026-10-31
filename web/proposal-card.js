// Phase 98 (ST3, docs/design/STAPLES.md §2.1.1): the shared proposal card ("never silent"). One
// card for anything that wants to be added or allowed without the owner's own hand: a plugin and its
// permissions (install and update reviews), a Sara tool a plugin asks to use; later phases use it
// for peers, people found in memory and goals. It shows what, why, what it can do in plain words
// (the riskiest first, new ones marked) and the buttons. Every value is set as text: nothing from
// the outside becomes markup.
import { t } from './naming.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {{ title: string, source?: string, chips?: { text: string, cls?: string }[], why?: string[],
 *   can?: { id: string, text: string, risk?: string }[], added?: string[], warn?: string[],
 *   body?: Node[], buttons?: { label: string, cls?: string, onClick: (b: HTMLButtonElement) => void }[] }} p
 */
export function proposalCard(p) {
  const card = el('section', 'prop-card');
  card.setAttribute('aria-label', p.title);
  const head = el('div', 'prop-head');
  head.append(el('h4', 'prop-title', p.title));
  if (p.source) head.append(el('span', 'prop-source muted small', p.source));
  card.append(head);
  if (p.chips?.length) {
    const chips = el('div', 'prop-chips');
    for (const c of p.chips) chips.append(el('span', `prop-chip${c.cls ? ` ${c.cls}` : ''}`, c.text));
    card.append(chips);
  }
  for (const w of p.why ?? []) card.append(el('p', 'prop-why small', w));
  if (p.can?.length) {
    card.append(el('p', 'prop-can-head small', t('What it can do')));
    const ul = el('ul', 'prop-can');
    const added = new Set(p.added ?? []);
    for (const c of p.can) {
      const li = el('li', `prop-line${c.risk ? ` risk-${c.risk}` : ''}${added.has(c.id) ? ' added' : ''}`);
      li.append(el('span', 'prop-dot'), el('span', 'prop-text', c.text));
      if (added.has(c.id)) li.append(el('span', 'prop-chip new', t('New')));
      ul.append(li);
    }
    card.append(ul);
  }
  for (const w of p.warn ?? []) card.append(el('p', 'prop-warn small', w));
  for (const n of p.body ?? []) card.append(n);
  if (p.buttons?.length) {
    const row = el('div', 'prop-buttons');
    for (const b of p.buttons) {
      const btn = el('button', b.cls ?? '', b.label);
      btn.type = 'button';
      btn.addEventListener('click', () => b.onClick(btn));
      row.append(btn);
    }
    card.append(row);
  }
  return card;
}
