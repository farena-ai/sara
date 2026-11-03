// Phase 119 part A (docs/design/RECALL.md §4.8): "when it comes up" reminders in the app.
//
// Under her reply: the ⏰ chip (what came up · the reminder · Done / Again next time / Forget), in the
// same row as "Remembered on her own"; the card under the reply that set one (When it comes up · who
// or the words · the text · Once / Every time · Undo, or Keep it / No when it waits for his OK).
// Planner → Reminders → When it comes up: the list with Forget, a Done fold (30 days) and an add row
// (words or a person from People, once or every time) with a live preview from
// POST /api/reminders/check. Settings → You → When it comes up holds the keys of §3.3.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', `ghost small ${cls ?? ''}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function initWhen(c) {
  ctx = c;
  $('#wm-add')?.addEventListener('click', () => void addOne());
  for (const id of ['wm-topic', 'wm-person']) $(`#${id}`)?.addEventListener('change', () => void preview());
  // PL2c (N22): Words or A person; the other one is cleared so only one is sent.
  for (const b of document.querySelectorAll('.wm-by [data-by]')) {
    b.addEventListener('click', () => {
      const person = b.dataset.by === 'person';
      for (const x of document.querySelectorAll('.wm-by [data-by]')) x.setAttribute('aria-checked', x === b ? 'true' : 'false');
      $('#wm-topic').hidden = person;
      $('#wm-person').hidden = !person;
      if (person) $('#wm-topic').value = '';
      else $('#wm-person').value = '';
      void preview();
    });
  }
  $('#wm-topic')?.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void preview(), 400);
  });
}
let previewTimer = 0;

/** "every time (1 of 3)" / "once". */
const howOften = (it) => (it.each ? t('every time ({n} of {m})', { n: it.n ?? it.fired ?? 0, m: it.of ?? 3 }) : t('once'));

/** The ⏰ chip for one reminder that came up in a reply (`meta.mentions` item). */
export function whenChip(item, { onAnswer } = {}) {
  const box = el('div', 'recall-chip when-chip');
  box.dataset.fire = String(item.fireId ?? '');
  const ic = el('span', 'recall-icon', '⏰');
  ic.setAttribute('aria-hidden', 'true');
  const body = el('div', 'recall-body');
  body.append(el('span', 'recall-head', t('{what} came up', { what: item.what })), el('span', 'recall-text', `“${item.text}”`));
  if (item.each) body.append(el('span', 'recall-kind muted small', howOften(item)));
  const row = el('div', 'recall-actions');
  const answered = (a) => {
    row.replaceChildren(el('span', 'muted small', a === 'again' ? t('It will come up again next time.') : a === 'forget' ? t('Forgotten.') : t('Done')));
    box.classList.toggle('recall-dismissed', a !== 'again');
  };
  const answer = (a) => async () => {
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    try {
      await ctx.api(`/reminders/fires/${item.fireId}`, { method: 'POST', body: { answer: a } });
      item.answer = a;
      answered(a);
      onAnswer?.(a);
    } catch {
      for (const b of row.querySelectorAll('button')) b.disabled = false;
    }
  };
  if (item.answer && item.answer !== 'done') answered(item.answer);
  else row.append(btn(t('Done'), 'wm-done', answer('done')), btn(t('Again next time'), 'wm-again', answer('again')), btn(t('Forget'), 'wm-forget', answer('forget')));
  body.append(row);
  box.append(ic, body);
  return box;
}

/** The card under the reply that set one (`meta.reminderCard` item). */
export function whenCard(card) {
  const box = el('div', 'when-card');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', t('When it comes up'));
  const head = el('div', 'when-card-head');
  head.append(el('span', 'when-card-ic', '⏰'), el('strong', '', t('When it comes up')));
  const what = el('div', 'when-card-what', card.personId ? `👤 ${card.what}` : `“${card.what}”`);
  const text = el('div', 'when-card-text', card.text);
  const meta = el('div', 'muted small', [card.each ? t('every time') : t('once'), card.until ? t('until {date}', { date: day(card.until) }) : ''].filter(Boolean).join(' · '));
  const row = el('div', 'when-card-actions');
  const done = (line) => row.replaceChildren(el('span', 'muted small', line));
  if (card.armed === false) {
    row.append(
      btn(t('Keep it'), 'wm-keep', async () => {
        await ctx.api(`/reminders/${card.id}`, { method: 'PATCH', body: { state: 'armed' } });
        done(t('Kept.'));
      }),
      btn(t('No'), 'wm-no', async () => {
        await ctx.api(`/reminders/${card.id}`, { method: 'DELETE' });
        done(t('Not kept.'));
      }),
    );
  } else {
    row.append(
      btn(t('Undo'), 'wm-undo', async () => {
        await ctx.api(`/reminders/${card.id}`, { method: 'DELETE' });
        done(t('Undone.'));
      }),
    );
  }
  box.append(head, what, text, meta, row);
  return box;
}

/** Everything Part A draws under one stored assistant message. */
export function whenFor(m) {
  const out = [];
  if (m.role !== 'assistant') return out;
  for (const c of Array.isArray(m.meta?.reminderCard) ? m.meta.reminderCard : []) if (c?.id) out.push(whenCard(c));
  for (const it of Array.isArray(m.meta?.mentions) ? m.meta.mentions : []) if (it?.fireId) out.push(whenChip(it));
  return out;
}

// ---------------------------------------------------------------- Planner → Reminders

function reminderRow(r, done) {
  const row = el('div', 'item when-item');
  const mid = el('div', 'grow');
  mid.append(el('div', 'title', `${r.personId ? '👤 ' : ''}${r.personId ? r.what : `“${r.what}”`} → ${r.text}`));
  const bits = [r.each ? t('every time ({n} of {m})', { n: r.fired ?? 0, m: 3 }) : t('once')];
  if (r.until) bits.push(t('until {date}', { date: day(r.until) }));
  if (r.lastCameUp) bits.push(t('last came up {date}', { date: day(r.lastCameUp) }));
  if (done) bits.push(r.ended === 'expired' ? t('ended: nobody mentioned it') : r.ended === 'forgot' ? t('forgotten') : t('came up'));
  if (!r.armed && !done) bits.push(t('waiting for Keep it'));
  mid.append(el('div', 'sub', bits.join(' · ')));
  row.append(mid);
  if (done) row.append(btn(t('Again next time'), '', () => void act(() => ctx.api(`/reminders/${r.id}`, { method: 'PATCH', body: { state: 'armed' } }))));
  else row.append(btn(t('Forget'), '', () => void act(() => ctx.api(`/reminders/${r.id}`, { method: 'DELETE' }))));
  return row;
}
async function act(f) {
  try {
    await f();
  } finally {
    void loadWhenList();
  }
}

/** Fills the "When it comes up" group of Planner → Reminders (and the People picker). */
export async function loadWhenList() {
  const list = $('#wm-list');
  if (!list || !ctx) return;
  let v;
  try {
    v = await ctx.api('/reminders?kind=mention');
  } catch {
    $('#wm-section')?.setAttribute('hidden', '');
    return;
  }
  $('#wm-section')?.removeAttribute('hidden');
  list.replaceChildren(...(v.reminders.length ? v.reminders.map((r) => reminderRow(r, false)) : [el('p', 'muted small', t('Nothing is waiting to come up. Say “when Dan comes up, remind me…” in any of your chats, or add one here.'))]));
  const dl = $('#wm-done-list');
  if (dl) dl.replaceChildren(...v.done.map((r) => reminderRow(r, true)));
  const dc = $('#wm-done-count');
  if (dc) dc.textContent = v.done.length ? `(${v.done.length})` : '';
  const pick = $('#wm-person');
  if (pick && !pick.dataset.loaded) {
    pick.dataset.loaded = '1';
    try {
      const ppl = await ctx.api('/people?status=active');
      for (const p of (ppl.people ?? ppl ?? []).slice(0, 300)) pick.append(new Option(p.relation ? `${p.name} (${p.relation})` : p.name, String(p.id)));
    } catch {
      /* no People here: words only */
    }
    const by = document.querySelector('.wm-by');
    if (by) by.hidden = pick.options.length <= 1;
  }
}

async function preview() {
  const out = $('#wm-preview');
  if (!out) return;
  const topic = $('#wm-topic').value.trim();
  const personId = $('#wm-person').value;
  if (!topic && !personId) return void (out.textContent = '');
  try {
    const r = await ctx.api('/reminders/check', { method: 'POST', body: { topic, personId } });
    out.textContent = r.tooCommon ? t('Too common: try something more specific.') : r.ok === false ? r.message : t('Would have come up {n} times in the last 30 days.', { n: r.last30 });
  } catch (err) {
    out.textContent = err.message;
  }
}

async function addOne() {
  const text = $('#wm-text').value.trim();
  const topic = $('#wm-topic').value.trim();
  const personId = $('#wm-person').value;
  const status = $('#wm-status');
  if (!text) return $('#wm-text').focus();
  if (!topic && !personId) return $('#wm-topic').focus();
  try {
    await ctx.api('/reminders', { method: 'POST', body: { text, mention: { topic, personId: personId || undefined, each: $('#wm-each').value === 'each' } } });
    $('#wm-text').value = '';
    $('#wm-topic').value = '';
    $('#wm-person').value = '';
    $('#wm-preview').textContent = '';
    if (status) status.textContent = t('Added.');
  } catch (err) {
    if (status) status.textContent = err.message;
  }
  void loadWhenList();
}

// ---------------------------------------------------------------- Settings → You → When it comes up

const IDS = { 'wm-on': ['on'], 'wm-confirm': ['confirm'], 'wm-per-reply': ['perReply'], 'wm-per-day': ['perDay'], 'wm-expires': ['expiresDays'], 'wm-gap': ['each', 'gapHours'], 'wm-fires': ['each', 'fires'], 'wm-calls': ['calls'], 'wm-rooms': ['rooms'] };
const CHOICES = { 'wm-per-reply': 'perReply', 'wm-per-day': 'perDay', 'wm-expires': 'expiresDays', 'wm-gap': 'gapHours', 'wm-fires': 'fires' };
const get = (o, path) => path.reduce((x, k) => x?.[k], o);

export async function loadWhenSettings() {
  const form = $('#wm-form');
  if (!form || !ctx) return;
  let v;
  try {
    v = await ctx.api('/mentions');
  } catch {
    form.hidden = true;
    return;
  }
  form.hidden = false;
  for (const [id, key] of Object.entries(CHOICES)) {
    const s = $(`#${id}`);
    if (!s || s.options.length) continue;
    for (const n of v.choices[key]) s.append(new Option(key === 'expiresDays' && n === 0 ? t('never') : key === 'gapHours' ? t('{n} h', { n }) : key === 'expiresDays' ? t('{n} days', { n }) : String(n), String(n)));
  }
  for (const [id, path] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c) continue;
    const val = get(v.settings, path);
    if (c.type === 'checkbox') c.checked = Boolean(val);
    else c.value = String(val);
  }
  form.dataset.loaded = '1';
}

export async function saveWhenSettings() {
  const form = $('#wm-form');
  if (!form?.dataset.loaded || !ctx) return;
  const body = { each: {} };
  for (const [id, path] of Object.entries(IDS)) {
    const c = $(`#${id}`);
    if (!c) continue;
    const val = c.type === 'checkbox' ? c.checked : /^(undo|ask|off|dm)$/.test(c.value) ? c.value : Number(c.value);
    if (path.length === 2) body.each[path[1]] = val;
    else body[path[0]] = val;
  }
  await ctx.api('/mentions', { method: 'PUT', body });
}
