// E5 (docs/DECISIONS_HELPER.md): the decision card (ranked options with bars, a Close call badge,
// "I chose this" and "Save as document") and the side-by-side comparison table. Drawn from the card
// src/decisions.ts computes from the tool's own arguments; every value goes in as text.
import { serverText, t } from './naming.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
async function post(path, body) {
  const res = await fetch(`/api/decisions/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
const num = (n) => (Math.round(Number(n) * 10) / 10).toFixed(1);

export function decisionCard(c) {
  const card = el('div', 'rcard rcard-decision');
  card.setAttribute('role', 'group');
  const head = el('div', 'rcard-head');
  head.append(el('span', 'rcard-title', c.question || t('Decision')));
  if (c.tie) head.append(el('span', 'dc-badge', t('Tie')));
  else if (c.closeCall) head.append(el('span', 'dc-badge', t('Close call')));
  card.append(head);
  card.setAttribute('aria-label', c.question || t('Decision'));
  const status = el('p', 'rc-meta', '');
  status.setAttribute('aria-live', 'polite');
  const list = el('ol', 'dc-rows');
  const choose = [];
  for (const r of Array.isArray(c.rows) ? c.rows.slice(0, 12) : []) {
    const li = el('li', `dc-row${r.rank === 1 ? ' dc-top' : ''}`);
    const top = el('div', 'dc-line');
    top.append(el('span', 'dc-name', `${r.rank}. ${r.option}`), el('span', 'dc-pct', t('{score} of 100', { score: num(r.pct) })));
    const bar = el('div', 'dc-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', t('{score} of 100', { score: num(r.pct) }));
    const fill = el('span', 'dc-fill');
    fill.style.setProperty('--dc-pct', `${Math.max(0, Math.min(100, Number(r.pct) || 0))}%`);
    bar.append(fill);
    li.append(top, bar);
    const notes = [];
    if (r.estimates) notes.push(t('{n} × my estimate', { n: r.estimates }));
    if (r.missing) notes.push(t('{n} × missing', { n: r.missing }));
    if (notes.length) li.append(el('span', 'dc-note muted small', notes.join(' · ')));
    if (c.id) {
      const b = btn(t('I chose this'), 'ghost small dc-choose', async () => {
        for (const x of choose) x.disabled = true;
        try {
          await post(`${c.id}/choose`, { chosen: r.option });
          status.textContent = t('Saved: {option}', { option: r.option });
        } catch (err) {
          for (const x of choose) x.disabled = false;
          status.textContent = err.message;
        }
      });
      choose.push(b);
      li.append(b);
    }
    list.append(li);
  }
  card.append(list);
  if (Array.isArray(c.factors) && c.factors.length) card.append(el('p', 'rc-meta', `${t('Deciding factors')}: ${c.factors.map((f) => `${f.criterion} ${f.points > 0 ? '+' : '−'}${num(Math.abs(f.points))}`).join(', ')}`));
  if (c.estimates) card.append(el('p', 'rc-meta', t('Scores marked “my estimate” are estimates, not looked up.')));
  if (!c.tie) card.append(el('p', 'rc-meta', c.robust ? t('The winner holds if any one weight moves by one.') : t('One small change in the weights or scores changes the winner.')));
  if (c.id) {
    const actions = el('div', 'dc-actions');
    const save = btn(t('Save as document'), 'ghost small', async () => {
      save.disabled = true;
      try {
        const { made } = await post(`${c.id}/document`);
        const a = el('a', 'rcard-link', t('Download {name}', { name: made.name }));
        a.href = `/api/library/made/${encodeURIComponent(made.id)}/file`;
        save.replaceWith(a);
      } catch (err) {
        save.disabled = false;
        status.textContent = err.message;
      }
    });
    actions.append(save);
    card.append(actions);
  }
  card.append(status);
  return card;
}

export function compareCard(c) {
  const card = el('div', 'rcard rcard-compare');
  card.setAttribute('role', 'group');
  const head = el('div', 'rcard-head');
  head.append(el('span', 'rcard-title', c.title || t('Comparison')));
  card.append(head);
  card.setAttribute('aria-label', c.title || t('Comparison'));
  const wrap = el('div', 'dc-table-wrap');
  const table = el('table', 'dc-table');
  const hr = el('tr');
  hr.append(el('th', '', t('Item')));
  for (const a of Array.isArray(c.attributes) ? c.attributes : []) hr.append(el('th', '', a));
  const thead = el('thead');
  thead.append(hr);
  const tbody = el('tbody');
  for (const r of Array.isArray(c.rows) ? c.rows : []) {
    const tr = el('tr');
    const th = el('th', '', r.name);
    th.scope = 'row';
    tr.append(th);
    for (const v of Array.isArray(r.cells) ? r.cells : []) {
      const td = el('td', v === null ? 'dc-missing' : '', v === null ? '—' : v);
      if (v === null) td.title = t('missing');
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  card.append(wrap);
  if (c.missing) card.append(el('p', 'rc-meta', t('{n} values missing (—): nothing was filled in.', { n: c.missing })));
  return card;
}
