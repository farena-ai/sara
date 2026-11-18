// U4.23 (docs/LEARNING.md "Learning coach"): the Study view inside the Library window, its Today tile
// and the Study cards section of Settings → You → Briefing and reminders. Make a set from a Library
// document, one of its chapters or pasted text; study due cards (flashcards with Again/Hard/Good/Easy,
// multiple choice, short answers graded with kind feedback); summary sheet; export (Anki TSV, CSV) and
// import. Kid mode: the hint comes before the answer. Each person's own sets (their own space).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
let kid = false;
let mode = { view: 'home', set: null };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
async function api(path, opts = {}) {
  const raw = typeof opts.body === 'string';
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': raw ? 'text/plain' : 'application/json' } : {},
    body: opts.body !== undefined ? (raw ? opts.body : JSON.stringify(opts.body)) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? t('Something went wrong.'));
  return data;
}
const say = (msg) => {
  const s = $('#sy-status');
  if (s) s.textContent = msg;
};
const bar = (pct) => {
  const b = el('div', 'sy-bar');
  const f = el('span');
  f.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  b.append(f);
  b.setAttribute('role', 'img');
  b.setAttribute('aria-label', t('{pct}% learned', { pct }));
  return b;
};

/** Opens the Study view inside the Library window (all due cards, or one set). */
export async function openStudy(setId = null) {
  const lib = $('#library');
  if (lib && !lib.open) lib.showModal();
  for (const id of ['#lib-home', '#lib-doc', '#lib-research', '#lib-topics', '#lib-meetings']) {
    const n = $(id);
    if (n) n.hidden = true;
  }
  $('#lib-study').hidden = false;
  mode = setId ? { view: 'study', set: setId } : { view: 'home', set: null };
  await render();
}
export function closeStudy() {
  const s = $('#lib-study');
  if (s) s.hidden = true;
}

async function render() {
  const host = $('#lib-s-body');
  if (!host || $('#lib-study').hidden) return;
  try {
    if (mode.view === 'study') return await renderStudy(host);
    if (mode.view === 'summary') return await renderSummary(host);
    const r = await api('/study');
    kid = Boolean(r.kid);
    host.replaceChildren(dueLine(r.due), makeForm(), setList(r.sets), importRow(), el('p', 'muted small', ''));
    void fillDocs();
  } catch (err) {
    host.replaceChildren(el('p', 'error', err.message));
  }
}

function dueLine(due) {
  const p = el('div', 'sy-due');
  p.append(el('strong', '', due ? t('{n} cards due today', { n: due }) : t('Nothing due today. Well done!')));
  if (due) p.append(btn(t('Study now'), 'small', () => ((mode = { view: 'study', set: null }), void render())));
  return p;
}

function makeForm() {
  const box = el('div', 'sy-make');
  box.append(el('h3', '', t('Make a study set')));
  const src = el('select');
  src.id = 'sy-src';
  src.setAttribute('aria-label', t('From'));
  src.append(new Option(t('Text I paste'), ''));
  const sec = el('select');
  sec.id = 'sy-sec';
  sec.setAttribute('aria-label', t('Chapter'));
  sec.hidden = true;
  const text = el('textarea');
  text.id = 'sy-text';
  text.rows = 5;
  text.placeholder = t('Paste notes, a chapter or an article…');
  text.setAttribute('aria-label', t('Text to study'));
  src.addEventListener('change', () => {
    const doc = docs.find((d) => String(d.id) === src.value);
    text.hidden = Boolean(doc);
    sec.hidden = !doc || !doc.sections.length;
    sec.replaceChildren(new Option(t('The whole document'), ''), ...(doc?.sections ?? []).map((s) => new Option(`${'  '.repeat(Math.max(0, s.level - 1))}${s.title}`, String(s.id))));
  });
  const go = btn(t('Make cards'), 'small', async () => {
    go.disabled = true;
    say(t('Making cards… (one model call)'));
    try {
      const body = src.value ? { docId: Number(src.value), ...(sec.value ? { section: Number(sec.value) } : {}) } : { text: text.value };
      const { set } = await api('/study', { method: 'POST', body });
      say(t('Made “{title}”.', { title: set.title }));
      await render();
    } catch (err) {
      say(err.message);
    } finally {
      go.disabled = false;
    }
  });
  const row = el('div', 'sy-row');
  row.append(src, sec);
  box.append(row, text, go);
  const status = el('p', 'muted small');
  status.id = 'sy-status';
  status.setAttribute('role', 'status');
  box.append(status);
  return box;
}
let docs = [];
async function fillDocs() {
  try {
    docs = (await api('/study/docs')).docs ?? [];
  } catch {
    docs = [];
  }
  const src = $('#sy-src');
  if (!src) return;
  for (const d of docs) src.append(new Option(d.title, String(d.id)));
}

function setList(sets) {
  const box = el('div', 'sy-sets');
  box.append(el('h3', '', t('Your study sets')));
  if (!sets.length) {
    box.append(el('p', 'muted small', t('No study sets yet. Make one above, or ask her: “quiz me on chapter 3”.')));
    return box;
  }
  for (const s of sets) {
    const p = s.progress;
    const card = el('div', 'sy-set');
    const top = el('div', 'sy-set-top');
    top.append(el('strong', '', s.title), el('span', 'muted small', t('{learned} of {cards} learned · {due} due', { learned: p.learned, cards: p.cards, due: p.due })));
    card.append(top, bar(p.pct));
    if (s.source?.label) card.append(el('span', 'muted small', s.source.label));
    if (s.coach) card.append(el('span', 'muted small', t('Homework helper: hints and steps, never the answers.')));
    const acts = el('div', 'sy-acts');
    acts.append(btn(p.due ? t('Study') : t('Practice'), 'small', () => ((mode = { view: 'study', set: s.id }), void render())));
    if (s.summary?.length) acts.append(btn(t('Summary sheet'), 'ghost small', () => ((mode = { view: 'summary', set: s.id }), void render())));
    for (const [fmt, label] of [['anki', t('Export for Anki')], ['csv', t('Export CSV')]]) {
      const a = el('a', 'button-link ghost small', label);
      a.href = `/api/study/${s.id}/export?format=${fmt}`;
      a.setAttribute('download', '');
      acts.append(a);
    }
    acts.append(btn(t('Delete'), 'ghost small danger-text', async () => {
      if (!confirm(t('Delete “{title}” and its progress?', { title: s.title }))) return;
      await api(`/study/${s.id}`, { method: 'DELETE' }).catch((e) => say(e.message));
      await render();
    }));
    card.append(acts);
    if (p.streak > 1) card.append(el('span', 'muted small', t('{n}-day streak', { n: p.streak })));
    box.append(card);
  }
  return box;
}

function importRow() {
  const row = el('p', 'small sy-import');
  const file = el('input');
  file.type = 'file';
  file.accept = '.txt,.tsv,.csv';
  file.hidden = true;
  file.id = 'sy-import-file';
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const fmt = /\.csv$/i.test(f.name) ? 'csv' : 'anki';
      const { set } = await api(`/study/import?format=${fmt}&title=${encodeURIComponent(f.name.replace(/\.\w+$/, ''))}`, { method: 'POST', body: await f.text() });
      say(t('Made “{title}”.', { title: set.title }));
      await render();
    } catch (err) {
      say(err.message);
    }
    file.value = '';
  });
  row.append(btn(t('Import cards (Anki text or CSV)…'), 'ghost small', () => file.click()), file);
  return row;
}

async function renderSummary(host) {
  const { set } = await api(`/study/${mode.set}`);
  const ul = el('ul', 'sy-summary');
  for (const s of set.summary) ul.append(el('li', '', s));
  host.replaceChildren(btn(t('← Study sets'), 'ghost small', () => ((mode = { view: 'home', set: null }), void render())), el('strong', 'sy-sum-title', set.title), ul, btn(t('Study'), 'small', () => ((mode = { view: 'study', set: set.id }), void render())));
}

async function nextCard() {
  if (mode.set) return (await api(`/study/${mode.set}`)).next;
  const r = await api('/study');
  for (const s of r.sets) if (s.progress.due) return (await api(`/study/${s.id}`)).next;
  return null;
}

async function renderStudy(host) {
  const back = btn(t('← Study sets'), 'ghost small', () => ((mode = { view: 'home', set: null }), void render()));
  const card = await nextCard();
  if (!card) {
    host.replaceChildren(back, el('p', 'sy-done', t('All done for today! Your cards come back when it’s time to see them again.')));
    return;
  }
  const box = el('div', 'sy-card');
  box.dataset.kind = card.kind;
  box.append(el('span', 'muted small', { basic: t('Flashcard'), cloze: t('Fill in the blank'), choice: t('Pick an answer'), short: t('Short answer') }[card.kind] ?? ''));
  box.append(el('p', 'sy-front', card.front));
  const out = el('div', 'sy-out');
  out.setAttribute('role', 'status');
  const nextBtn = () => btn(t('Next card'), 'small', () => void render());
  const grades = () => {
    const g = el('div', 'sy-grades');
    for (const [n, label] of [[1, t('Again')], [3, t('Hard')], [4, t('Good')], [5, t('Easy')]]) {
      g.append(btn(label, n === 4 ? 'small' : 'ghost small', async () => {
        await api(`/study/cards/${card.id}/review`, { method: 'POST', body: { grade: n } }).catch((e) => say(e.message));
        await render();
      }));
    }
    return g;
  };
  let step = 0;
  const reveal = async () => {
    const r = await api(`/study/cards/${card.id}/reveal`, { method: 'POST', body: { step } });
    step++;
    if (r.step === 'hint') {
      out.replaceChildren(el('p', 'sy-hint', `${t('Hint')}: ${r.text}`));
      return;
    }
    out.replaceChildren(el('p', 'sy-back', r.text), grades());
    showBtn.remove();
    hintBtn?.remove();
  };
  const hintBtn = card.hint && !kid ? btn(t('Hint'), 'ghost small', () => ((hintBtn.disabled = true), out.prepend(el('p', 'sy-hint', `${t('Hint')}: ${card.hint}`)))) : null;
  const showBtn = btn(kid && card.hint ? t('Show a hint') : t('Show the answer'), 'small', async () => {
    await reveal();
    showBtn.textContent = t('Show the answer');
  });
  const check = async (answer) => {
    try {
      const { result } = await api(`/study/cards/${card.id}/answer`, { method: 'POST', body: { answer } });
      out.replaceChildren(el('p', result.correct ? 'sy-right' : 'sy-wrong', result.feedback), nextBtn());
    } catch (err) {
      out.replaceChildren(el('p', 'error', err.message));
    }
  };
  const acts = el('div', 'sy-acts');
  if (card.kind === 'choice' && card.choices) {
    const opts = el('div', 'sy-choices');
    for (const c of card.choices) opts.append(btn(c, 'ghost sy-choice', () => {
      for (const b of opts.querySelectorAll('button')) b.disabled = true;
      void check(c);
    }));
    box.append(opts);
  } else if (card.kind === 'short') {
    const a = el('textarea');
    a.rows = 3;
    a.setAttribute('aria-label', t('Your answer'));
    a.placeholder = t('Your answer');
    box.append(a);
    acts.append(btn(t('Check my answer'), 'small', () => void check(a.value)));
    if (card.hint) acts.append(btn(t('Hint'), 'ghost small', () => out.replaceChildren(el('p', 'sy-hint', `${t('Hint')}: ${card.hint}`))));
  } else {
    acts.append(showBtn);
    if (hintBtn) acts.append(hintBtn);
  }
  box.append(acts, out);
  host.replaceChildren(back, box);
}

// ---------- Today tile
export function renderStudyTile(p, tileHead) {
  const tile = $('#td-study');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Study'));
  const list = el('ul', 'td-biz sy-tile');
  for (const s of p.sets) {
    const li = el('li', 'small sy-tile-item');
    li.append(el('span', 'sy-tile-title', s.title), el('span', 'muted', t('{n} due', { n: s.due })));
    list.append(li);
  }
  const go = btn(t('Study {n} cards', { n: p.due }), 'ghost small', () => void openStudy().then(() => ((mode = { view: 'study', set: null }), render())));
  tile.querySelector('.td-body').replaceChildren(list, go);
}

// ---------- Settings → You → Briefing and reminders → Study cards
export async function loadStudyPrefs() {
  try {
    const { prefs } = await api('/study');
    $('#sy-remind').checked = prefs.remind;
    $('#sy-remind-at').value = prefs.remindAt;
    $('#sy-new').value = String(prefs.newPerDay);
    $('#sy-max').value = String(prefs.maxCards);
  } catch {
    /* demo or no study: the section stays at its defaults */
  }
}
async function saveStudyPrefs() {
  const s = $('#sy-prefs-status');
  try {
    await api('/study/prefs', { method: 'PUT', body: { remind: $('#sy-remind').checked, remindAt: $('#sy-remind-at').value, newPerDay: Number($('#sy-new').value), maxCards: Number($('#sy-max').value) } });
    if (s) s.textContent = t('Saved.');
  } catch (err) {
    if (s) s.textContent = err.message;
  }
}

export function initStudy() {
  $('#lib-study-open')?.addEventListener('click', () => void openStudy());
  $('#lib-s-back')?.addEventListener('click', () => {
    closeStudy();
    $('#lib-home').hidden = false;
  });
  for (const id of ['#sy-remind', '#sy-remind-at', '#sy-new', '#sy-max']) $(id)?.addEventListener('change', () => void saveStudyPrefs());
}
