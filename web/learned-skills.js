// Phase 97 (ST2): skills she learns (docs/design/STAPLES.md §5.4–§5.7). The two cards in the chat,
// both after her reply and never in the middle of a task:
//   "Make this a skill?"  what she noticed (asked N times since …, or the same steps in N coding
//                         jobs), the draft (name, what + when, the steps) and Save it / Edit first /
//                         Not now / Never for this. Nothing is saved before Save it; a saved one is on
//                         trial until the skill check says it helps.
//   "A fix for …?"        the diff to a skill she used, with why (the step that failed and the one
//                         that worked, or your own words), and Apply / Edit / Dismiss. Applying keeps
//                         the old version (Skills → open the skill → Versions to undo).
// And on Settings → Abilities → Skills: "Skills she learns" (the switches, the count before she
// offers, how far back she looks, offers per day) and the cards still waiting for an answer.
import { currentIdentity, serverText, t } from './naming.js';
import { checkWords, editDraft, loadSkills } from './skills.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const herName = () => currentIdentity().name || t('Sara');
const dayWords = (iso) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
};
function raw(tag, cls, text) {
  const e = el(tag, cls, text);
  e.dataset.raw = '';
  return e;
}

// ---------------------------------------------------------------------------------------------
// The offer card
// ---------------------------------------------------------------------------------------------

function offerBody(card, v, redraw) {
  const what = v.kind === 'chain'
    ? t('I ran the same {n} steps in {count} coding jobs since {day}. Want me to keep them as a skill, so I do them the same way every time?', { n: v.steps.length, count: v.count, day: dayWords(v.since) })
    : t('You asked me for this {n} times since {day}. Want me to keep it as a skill, so I do it the same way every time?', { n: v.count, day: dayWords(v.since) });
  card.append(el('p', 'lsk-what', what));
  if (v.kind === 'chain' && v.steps.length) {
    const ol = el('ol', 'lsk-steps');
    for (const s of v.steps) ol.append(raw('li', '', s));
    card.append(ol);
  }
  const answered = v.status !== 'offered';
  if (!answered) {
    if (!v.draft) {
      card.append(el('p', 'muted small', t('Writing a draft…')));
      setTimeout(() => void redraw(), 2500);
    } else {
      const d = v.draft;
      const box = el('details', 'lsk-draft');
      box.open = true;
      box.append(el('summary', '', t('The draft')));
      box.append(raw('p', 'lsk-name', d.name), raw('p', 'lsk-desc', d.description), raw('pre', 'lsk-pre', d.body));
      if (d.by === 'plain') box.append(el('p', 'muted small', t('Written plainly from her steps: no model could be used for it here. Edit it before you save it.')));
      card.append(box);
    }
  }
  const row = el('div', 'lsk-actions');
  const decide = async (b, action, draft) => {
    for (const x of row.querySelectorAll('button')) x.disabled = true;
    try {
      await api(`/skills/learning/offers/${v.id}`, { method: 'POST', body: { action, ...(draft ? { draft } : {}) } });
      await redraw();
      void loadSkills();
      void loadLearning();
    } catch (err) {
      card.append(el('p', 'lsk-error small', err.message));
      for (const x of row.querySelectorAll('button')) x.disabled = false;
    }
  };
  if (!answered) {
    row.append(
      btn(t('Save it'), '', (b) => decide(b, 'save')),
      btn(t('Edit first'), 'ghost', () => editDraft(v.draft ?? { name: '', description: '', body: '' }, async (draft) => decide(null, 'save', draft))),
      btn(t('Not now'), 'ghost', (b) => decide(b, 'later')),
      btn(t('Never for this'), 'ghost danger-text', (b) => decide(b, 'never')),
    );
    card.append(row);
    return;
  }
  if (v.status === 'accepted') {
    card.append(el('p', 'lsk-done', t('Saved as the skill “{name}”.', { name: v.skillName ?? '' })));
    if (v.skill) card.append(el('p', 'muted small', checkWords(v.skill)));
  } else if (v.status === 'snoozed') card.append(el('p', 'lsk-done', t("Not now: she won't ask about this for 14 days.")));
  else if (v.status === 'never') card.append(el('p', 'lsk-done', t("She won't offer this one again.")));
  else card.append(el('p', 'lsk-done', t('This offer was taken back: some of the conversations it came from are gone.')));
}

// ---------------------------------------------------------------------------------------------
// The fix card
// ---------------------------------------------------------------------------------------------

function diffView(diff) {
  const pre = el('pre', 'lsk-pre lsk-diff');
  pre.dataset.raw = '';
  for (const line of String(diff).split('\n')) {
    if (!line) continue;
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'lsk-add' : line.startsWith('-') && !line.startsWith('---') ? 'lsk-del' : line.startsWith('@@') ? 'lsk-hunk' : '';
    const s = el('span', cls, line);
    pre.append(s, document.createTextNode('\n'));
  }
  return pre;
}

function fixBody(card, f, redraw) {
  if (f.kind === 'step-failed') card.append(el('p', 'lsk-what', t('A step failed and another one worked: {bad} → {good}', { bad: f.evidence?.failing?.step ?? '', good: f.evidence?.worked?.step ?? '' })));
  else card.append(el('p', 'lsk-what', t('You corrected her: “{quote}”', { quote: f.evidence?.quote ?? '' })));
  card.append(diffView(f.diff));
  if (f.status !== 'proposed') {
    card.append(el('p', 'lsk-done', f.status === 'applied' ? t('Applied. The old version is kept: open the skill → Versions to go back.') : t('Dismissed.')));
    return;
  }
  const row = el('div', 'lsk-actions');
  let area = null;
  const decide = async (action) => {
    for (const x of row.querySelectorAll('button')) x.disabled = true;
    try {
      await api(`/skills/learning/fixes/${f.id}`, { method: 'POST', body: { action, ...(area ? { body: area.value } : {}) } });
      await redraw();
      void loadSkills();
      void loadLearning();
    } catch (err) {
      card.append(el('p', 'lsk-error small', err.message));
      for (const x of row.querySelectorAll('button')) x.disabled = false;
    }
  };
  row.append(
    btn(t('Apply'), '', () => decide('apply')),
    btn(t('Edit'), 'ghost', (b) => {
      if (area) return;
      area = el('textarea', 'lsk-edit');
      area.rows = 10;
      area.value = f.proposed;
      area.setAttribute('aria-label', t('The steps after the fix'));
      area.dataset.nodirty = '';
      row.before(area);
      b.disabled = true;
      area.focus();
    }),
    btn(t('Dismiss'), 'ghost', () => decide('dismiss')),
  );
  card.append(row);
}

// ---------------------------------------------------------------------------------------------
// One card (chat or settings)
// ---------------------------------------------------------------------------------------------

function cardFor(kind, id) {
  const card = el('div', 'lsk-card');
  card.dataset.kind = kind;
  card.dataset.id = String(id);
  const redraw = async () => {
    let v;
    try {
      v = await api(`/skills/learning/${kind === 'offer' ? 'offers' : 'fixes'}/${id}`);
    } catch (err) {
      card.replaceChildren(el('p', 'muted small', err.status === 404 ? t('This card is gone.') : err.message));
      return;
    }
    const title = kind === 'offer' ? t('{name}: make this a skill?', { name: herName() }) : t('{name}: a fix for the skill “{skill}”?', { name: herName(), skill: v.name });
    card.replaceChildren(el('p', 'lsk-title', title));
    if (kind === 'offer') offerBody(card, v, redraw);
    else fixBody(card, v, redraw);
  };
  card.append(el('p', 'muted small', t('Loading…')));
  void redraw();
  return card;
}

/**
 * The card for a notice message in the chat (stored as `skill:<id>` an offer, `skillfix:<id>` a fix;
 * the server sends the kind apart and the id in the content and in meta).
 */
export function learnCard(m) {
  const fix = m.kind === 'skillfix';
  const id = Number(fix ? (m.meta?.fix ?? m.content) : (m.meta?.offer ?? m.content));
  return cardFor(fix ? 'fix' : 'offer', id);
}

// ---------------------------------------------------------------------------------------------
// Settings → Abilities → Skills → Skills she learns
// ---------------------------------------------------------------------------------------------

let learning = null;

function status(text) {
  const s = $('#lsk-status');
  if (s) s.textContent = text ?? '';
}

export async function loadLearning() {
  const box = $('#lsk-waiting');
  if (!box) return;
  try {
    learning = await api('/skills/learning');
  } catch (err) {
    $('#lsk-section').hidden = err.status === 404;
    box.replaceChildren(el('p', 'muted small', err.message));
    return;
  }
  $('#lsk-section').hidden = false;
  const s = learning.settings;
  $('#lsk-offer').checked = s.offer;
  $('#lsk-check').checked = s.check;
  $('#lsk-chains').checked = s.chains;
  $('#lsk-fixes').checked = s.fixes;
  $('#lsk-times').value = String(s.times);
  $('#lsk-times-n').textContent = String(s.times);
  const fill = (sel, list, words, value) => {
    sel.replaceChildren(...list.map((n) => {
      const o = el('option', '', words(n));
      o.value = String(n);
      return o;
    }));
    sel.value = String(value);
  };
  fill($('#lsk-lookback'), learning.choices.lookBackDays, (n) => t('{n} days', { n }), s.lookBackDays);
  fill($('#lsk-perday'), learning.choices.perDay, (n) => String(n), s.perDay);
  for (const id of ['#lsk-times', '#lsk-lookback', '#lsk-perday', '#lsk-check', '#lsk-chains', '#lsk-fixes']) $(id).disabled = !s.offer && id !== '#lsk-fixes';
  const cards = [...learning.offers.map((o) => cardFor('offer', o.id)), ...learning.fixes.filter(Boolean).map((f) => cardFor('fix', f.id))];
  box.replaceChildren(...(cards.length ? cards : [el('p', 'muted small', learning.watching ? t('Nothing waits for you. Repeats she is watching: {n}.', { n: learning.watching }) : t('Nothing waits for you.'))]));
}

async function save(patch) {
  try {
    learning = await api('/skills/learning', { method: 'PUT', body: patch });
    status(t('Saved.'));
    await loadLearning();
  } catch (err) {
    status(err.message);
  }
}

export function initLearning() {
  if (!$('#lsk-offer')) return;
  for (const [id, key] of [['#lsk-offer', 'offer'], ['#lsk-check', 'check'], ['#lsk-chains', 'chains'], ['#lsk-fixes', 'fixes']]) $(id).addEventListener('change', (e) => void save({ [key]: e.target.checked }));
  $('#lsk-times').addEventListener('input', (e) => ($('#lsk-times-n').textContent = e.target.value));
  $('#lsk-times').addEventListener('change', (e) => void save({ times: Number(e.target.value) }));
  $('#lsk-lookback').addEventListener('change', (e) => void save({ lookBackDays: Number(e.target.value) }));
  $('#lsk-perday').addEventListener('change', (e) => void save({ perDay: Number(e.target.value) }));
  $('#lsk-mine').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const r = await api('/skills/learning/mine', { method: 'POST', body: {} });
      status(r.found ? t('Found {n} repeated step chains in {runs} coding jobs.', { n: r.found, runs: r.runs }) : t('No repeated step chains in {runs} coding jobs.', { runs: r.runs }));
      await loadLearning();
    } catch (err) {
      status(err.message);
    } finally {
      b.disabled = false;
    }
  });
}
