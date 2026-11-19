// S11 (docs/WRITING_STYLE.md): "Make it sound human" on a made document or a research report. Asks
// the server for a rewrite (facts locked, src/humanize.ts) and shows it side by side: Before with the
// removed words marked, After with the new ones marked, the "reads natural" score before and after,
// and whether every fact stayed. Keep makes a new version of the document (or replaces the report);
// Undo puts the old words back. A child gets suggestions for their own draft instead (no Keep).
import { serverText, t } from './naming.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
async function post(path, body) {
  const r = await fetch(`/api/writing/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(serverText(d, String(r.status)));
  return d;
}

const LABEL = () => ({ natural: t('Reads natural'), mixed: t('A little stiff'), stiff: t('Stiff') });
function scoreChip(c) {
  const chip = el('span', `hz-score hz-${c.label}`, `${LABEL()[c.label] ?? ''} · ${c.score}/100`);
  return chip;
}
/** One column: the text with the changed spans marked (`side`: which changes this column shows). */
function column(title, changes, side) {
  const col = el('section', 'hz-col');
  col.append(el('h4', 'hz-col-title', title));
  const body = el('div', 'hz-text');
  for (const c of changes) {
    if (c.type === 'same') body.append(document.createTextNode(c.text));
    else if (side === 'before' && c.type === 'del') body.append(el('del', 'hz-del', c.text));
    else if (side === 'after' && c.type === 'add') body.append(el('ins', 'hz-add', c.text));
  }
  col.append(body);
  return col;
}

function dialog() {
  let dlg = document.getElementById('hz-view');
  if (!dlg) {
    dlg = el('dialog', 'hz-view');
    dlg.id = 'hz-view';
    dlg.setAttribute('aria-labelledby', 'hz-title');
    document.body.append(dlg);
  }
  return dlg;
}

/**
 * Opens the side-by-side view. `src` = { madeId } | { researchId } | { text }, `title` for the head,
 * `onKept(result)` after Keep / Undo (e.g. to refresh a report).
 */
export async function openHumanize(src, title, onKept) {
  const dlg = dialog();
  let voice = false;
  const head = el('div', 'hz-head');
  const h = el('h3', 'hz-title', t('Make it sound human'));
  h.id = 'hz-title';
  head.append(h, el('span', 'muted small hz-sub', title ?? ''));
  const status = el('p', 'muted small hz-status', t('Rewriting in plain words…'));
  status.setAttribute('role', 'status');
  const main = el('div', 'hz-main');
  const acts = el('div', 'hz-actions');
  dlg.replaceChildren(head, status, main, acts);
  if (!dlg.open) dlg.showModal();

  const run = async () => {
    status.textContent = t('Rewriting in plain words…');
    main.replaceChildren();
    acts.replaceChildren();
    let r;
    try {
      r = await post('humanize', { ...src, voice });
    } catch (err) {
      status.textContent = t("Couldn't rewrite it: {why}", { why: err.message });
      return;
    }
    if (r.coach) return void showCoach(r);
    showResult(r);
  };

  const showCoach = (r) => {
    status.textContent = t("Here are suggestions for your own draft. You make the changes, so it stays your work.");
    const box = el('div', 'hz-coach');
    const list = el('ul');
    for (const s of r.coach.suggestions) list.append(el('li', '', s));
    const qs = el('ul');
    for (const q of r.coach.questions) qs.append(el('li', '', q));
    box.append(el('h4', '', t('Suggestions')), list, el('h4', '', t('Questions to think about')), qs);
    main.append(box);
    const close = el('button', 'ghost', t('Close'));
    close.type = 'button';
    close.addEventListener('click', () => dlg.close());
    acts.append(close);
  };

  const showResult = (r) => {
    const scores = el('div', 'hz-scores');
    scores.append(el('span', 'small', t('Before')), scoreChip(r.check.before), el('span', 'small', t('After')), scoreChip(r.check.after));
    const facts = el('p', `small hz-facts${r.facts.ok ? ' ok' : ''}`, r.facts.ok ? t('Every number, name, quote, citation and link is the same.') : t('Some facts changed, so it stays as written.'));
    status.textContent = r.kept === 'original' ? t('Kept as written: {why}', { why: r.reason ?? '' }) : r.kept === 'repaired' ? t('A few sentences stay as written so every fact is exact.') : '';
    status.hidden = !status.textContent;
    const cols = el('div', 'hz-cols');
    cols.append(column(t('Before'), r.changes, 'before'), column(t('After'), r.changes, 'after'));
    main.append(scores, facts, cols);
    const mine = el('label', 'hz-voice small');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = voice;
    cb.disabled = !r.hasCard;
    cb.addEventListener('change', () => {
      voice = cb.checked;
      void run();
    });
    mine.append(cb, document.createTextNode(` ${t('Match my voice')}`));
    if (!r.hasCard) mine.title = t('Add samples of your own writing in Settings → You → About you → Writing style first.');
    const keep = el('button', '', t('Keep'));
    keep.type = 'button';
    keep.disabled = r.kept === 'original' || !(src.madeId || src.researchId);
    const undo = el('button', 'ghost', t('Undo'));
    undo.type = 'button';
    undo.hidden = true;
    const close = el('button', 'ghost', t('Close'));
    close.type = 'button';
    close.addEventListener('click', () => dlg.close());
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      try {
        const k = await post('keep', { ...src, text: r.after });
        status.hidden = false;
        status.textContent = k.made ? t('Kept as version {n}.', { n: k.made.version }) : t('Kept.');
        undo.hidden = false;
        if (k.made) src = { madeId: k.made.id };
        onKept?.(k);
      } catch (err) {
        status.hidden = false;
        status.textContent = err.message;
        keep.disabled = false;
      }
    });
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        const k = await post('keep', { ...src, text: r.before });
        status.textContent = k.made ? t('Back to the words as written (version {n}).', { n: k.made.version }) : t('Back to the words as written.');
        undo.hidden = true;
        onKept?.(k);
      } catch (err) {
        status.textContent = err.message;
        undo.disabled = false;
      }
    });
    acts.append(mine, keep, undo, close);
  };
  await run();
}

/** The "Make it sound human" button for a card or a report. */
export function humanizeButton(src, title, onKept, cls = 'ghost') {
  const b = el('button', cls, t('Make it sound human'));
  b.type = 'button';
  b.addEventListener('click', () => void openHumanize(src, title, onKept));
  return b;
}
