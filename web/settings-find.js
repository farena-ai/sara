// SETTINGS3 S4 (docs/design/SETTINGS3.md): search finds single settings, not only pages. One record per
// control (its label, its tip, where it lives and its current value); the page ranking stays as it was
// (web/settings-search.js rankPages, test/phase128b 128b.3). Choosing a setting opens its page, unfolds
// Advanced if needed (howto.js showMe) and highlights its row for 2 s.
import { foldText, searchWords } from './settings-search.js';

/** A control's search record. `label`/`tip` are display text; `path` says where it lives. */
export function controlRecord({ id, page, label, tip = '', path = '', value = '' }) {
  return { id, page, label, path, value, name: foldText(label), text: foldText(`${label} ${tip}`) };
}

/** The controls that match, best first: phrase at the start of the label, all words in the label, then in label + tip. */
export function rankControls(q, recs, limit = 8) {
  const words = searchWords(q);
  if (!words.length) return [];
  const phrase = foldText(q).trim();
  const all = (s) => words.every((w) => s.includes(w));
  const scored = [];
  recs.forEach((r, i) => {
    const tier = r.name.startsWith(phrase) ? 0 : all(r.name) ? 1 : all(r.text) ? 2 : -1;
    if (tier >= 0) scored.push({ r, i, tier });
  });
  return scored.sort((a, b) => a.tier - b.tier || a.i - b.i).slice(0, limit).map((x) => x.r);
}

const SECRET = /key|token|secret|password|pass\b|pin\b|webhook-url|cookie/i;
/** The text of a control's label without the control's own text (options) and the tip button. */
function labelText(c) {
  const lab = c.closest('label') ?? (c.id ? document.querySelector(`label[for="${c.id}"]`) : null);
  if (lab) {
    const parts = [];
    for (const n of lab.childNodes) if (n.nodeType === 3 || (n.nodeType === 1 && !n.matches('select, input, textarea, button, .tip, [data-tip], datalist, small, .muted'))) parts.push(n.textContent);
    const s = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (s) return s;
  }
  return c.getAttribute('aria-label') ?? '';
}
function tipOf(c) {
  const lab = c.closest('label, .add-row, p') ?? c.parentElement;
  return lab?.querySelector('button.tip')?.dataset.tip ?? '';
}
/** What the control is set to now, in words (never a secret's value). */
function valueOf(c, t) {
  if (c.type === 'checkbox') return c.checked ? t('On') : t('Off');
  if (c.tagName === 'SELECT') return c.selectedOptions?.[0]?.textContent?.trim() ?? '';
  if (c.type === 'password' || SECRET.test(c.id) || c.type === 'file') return '';
  const v = String(c.value ?? '').trim();
  return v.length > 40 ? `${v.slice(0, 39)}…` : v;
}

/** Every named control of the given pages, as search records. `pathOf(page)` → "Group › Page". */
export function controlRecords(pages, pathOf, t = (s) => s) {
  const out = [];
  for (const p of pages) {
    for (const c of p.querySelectorAll('input[id]:not([type=hidden]):not([type=file]), select[id], textarea[id]')) {
      if (c.closest('[data-raw], .card-preview, [hidden]:not(.settings-page, details)')) continue;
      const label = labelText(c);
      if (!label || label.length > 90) continue;
      out.push(controlRecord({ id: c.id, page: p.dataset.page, label, tip: tipOf(c), path: pathOf(p), value: valueOf(c, t) }));
    }
  }
  return out;
}

/** The row of a control (what gets highlighted). */
export const rowOf = (c) => c.closest('label, .add-row, .s3-card > *') ?? c;
