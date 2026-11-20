// V2.7 (docs/design/GIFTS.md, docs/PEOPLE.md "Gifts and occasions"):
// - giftsSection: on a person's card, the next occasions, a budget, gift ideas (each can go on the
//   Planner's Gifts list), a draft card in your writing style and the reminder switch;
// - loadGiftPrefs / initGiftPrefs: Settings → You → Briefing and reminders → Gifts and occasions.
// Every value from the server is set as text.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
function btn(label, cls, onClick, status) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.disabled = true;
    try {
      await onClick(b);
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function dayWords(ymd) {
  return new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}
function occName(o) {
  return o.key === 'birthday' ? t('Birthday') : o.label;
}
function whenWords(o) {
  return o.days === 0 ? t('today') : o.days === 1 ? t('tomorrow') : t('in {n} days', { n: o.days });
}

/** The card's Gifts and occasions section (filled once the server answers). */
export function giftsSection(p) {
  const sec = el('section', 'ppl-sec gf-sec');
  const h = el('h4', '', t('Gifts and occasions'));
  h.append(' ', tip(t('Ideas come only from what she may use in a normal chat: never private facts, health or money details, or private cards. Nothing is bought or sent.')));
  sec.append(h);
  const body = el('div', 'gf-body');
  body.append(el('p', 'muted small sk-line', t('Loading…')));
  sec.append(body);
  const load = () => api(`/people/${p.id}/gifts`).then((d) => draw(body, p, d, load)).catch((err) => body.replaceChildren(el('p', 'muted small', err.message)));
  void load();
  return sec;
}

function draw(body, p, d, reload) {
  body.replaceChildren();
  const status = el('p', 'muted small gf-status');
  status.setAttribute('role', 'status');
  if (d.blocked) {
    body.append(el('p', 'muted small', t('This card is private, so she doesn\'t plan gifts or write cards from it.')));
    return;
  }
  const show = (v) => draw(body, p, v, reload);
  // Next occasions.
  if (d.occasions.length) {
    const ul = el('ul', 'gf-occ');
    for (const o of d.occasions.slice(0, 3)) {
      const li = el('li', 'small');
      li.append(el('strong', '', occName(o)), el('span', 'muted', ` · ${dayWords(o.date)} · ${whenWords(o)}`));
      ul.append(li);
    }
    body.append(ul);
  } else body.append(el('p', 'muted small', t('No birthday or yearly date on this card yet. Add one to get a reminder ahead of it.')));
  // Budget + reminder.
  const row = el('div', 'gf-row');
  const bud = el('label', 'pt-field gf-budget');
  const inp = document.createElement('input');
  inp.id = 'gf-budget';
  inp.type = 'number';
  inp.min = '0';
  inp.step = '5';
  inp.inputMode = 'decimal';
  inp.placeholder = d.budget ? String(d.budget) : t('e.g. 50');
  inp.value = d.plan.budget ? String(d.plan.budget) : '';
  inp.addEventListener('change', () => void api(`/people/${p.id}/gifts`, { method: 'PUT', body: { budget: inp.value ? Number(inp.value) : null } }).then(show).catch((err) => (status.textContent = err.message)));
  bud.append(el('span', '', t('Budget')), tip(t('Ideas over this amount are left out. Empty uses the default budget from Settings → You → Briefing and reminders.')), inp);
  const rem = el('label', 'row small gf-remind');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'gf-remind';
  box.checked = Boolean(d.reminds);
  box.addEventListener('change', () => void api(`/people/${p.id}/gifts`, { method: 'PUT', body: { remind: box.checked } }).then(show).catch((err) => (status.textContent = err.message)));
  rem.append(box, ` ${t('Remind me {n} days before', { n: d.days })} `, tip(t('A reminder before each birthday and yearly date on this card. On by default for family and partners, and for anyone with a budget or ideas.')));
  row.append(bud, rem);
  body.append(row);
  if (!d.on) body.append(el('p', 'muted small', t('Gift reminders are off in Settings → You → Briefing and reminders.')));
  // Ideas.
  const ideas = el('div', 'gf-ideas');
  ideas.append(el('span', 'pt-sub', t('Gift ideas')));
  if (d.plan.ideas.length) {
    const ul = el('ul', 'pt-list gf-list');
    d.plan.ideas.forEach((i, n) => {
      const li = el('li', 'small gf-idea');
      const txt = el('span', 'gf-idea-text');
      txt.append(el('strong', '', i.title));
      if (i.price) txt.append(el('span', 'muted', ` · ${t('about {n}', { n: i.price })}`));
      if (i.why) txt.append(el('span', 'muted gf-why', i.why));
      li.append(txt);
      if (i.taskId) li.append(el('span', 'ppl-badge gf-listed', t('On the Gifts list')));
      else li.append(btn(t('Add to shopping list'), 'ghost small', async () => show(await api(`/people/${p.id}/gifts/list`, { method: 'POST', body: { idea: n } })), status));
      ul.append(li);
    });
    ideas.append(ul);
  }
  const occ = d.occasions[0]?.key;
  ideas.append(btn(d.plan.ideas.length ? t('More ideas') : t('Suggest gift ideas'), 'small', async (b) => {
    status.textContent = t('Thinking of ideas…');
    show(await api(`/people/${p.id}/gifts/ideas`, { method: 'POST', body: { occasion: occ } }));
    void b;
  }, status));
  body.append(ideas);
  // Card text.
  const card = el('div', 'gf-card');
  const cardHead = el('span', 'pt-sub gf-head', t('Card text'));
  cardHead.append(' ', tip(t('A short card in your own writing style (Settings → You → About you → Writing style). Copy it into a card or a message; she never sends it.')));
  card.append(cardHead);
  const acts = el('div', 'gf-acts');
  if (d.plan.card?.text) {
    const ta = document.createElement('textarea');
    ta.id = 'gf-card-text';
    ta.rows = 4;
    ta.value = d.plan.card.text;
    ta.setAttribute('aria-label', t('Card text'));
    card.append(ta);
    acts.append(btn(t('Copy'), 'ghost small', async () => {
      await navigator.clipboard?.writeText(ta.value);
      status.textContent = t('Copied.');
    }, status));
  }
  acts.prepend(btn(d.plan.card?.text ? t('Write it again') : t('Write a card'), 'small', async () => {
    status.textContent = t('Writing…');
    show(await api(`/people/${p.id}/gifts/card`, { method: 'POST', body: { occasion: occ } }));
  }, status));
  card.append(acts);
  body.append(card, status);
}

// ------------------------------------------------------------------ Settings

export async function loadGiftPrefs() {
  try {
    const p = await api('/people/gifts-prefs');
    const on = $('#gift-remind-on');
    if (on) on.checked = p.on;
    const days = $('#gift-remind-days');
    if (days) days.value = String(p.days);
    const bud = $('#gift-budget');
    if (bud) bud.value = p.budget ? String(p.budget) : '';
  } catch {
    /* no People cards here (demo): the section keeps its defaults */
  }
}
async function saveGiftPrefs() {
  const s = $('#gift-prefs-status');
  try {
    await api('/people/gifts-prefs', { method: 'PUT', body: { on: $('#gift-remind-on').checked, days: Number($('#gift-remind-days').value), budget: $('#gift-budget').value ? Number($('#gift-budget').value) : null } });
    if (s) s.textContent = t('Saved.');
  } catch (err) {
    if (s) s.textContent = err.message;
  }
}
export function initGiftPrefs() {
  for (const id of ['#gift-remind-on', '#gift-remind-days', '#gift-budget']) $(id)?.addEventListener('change', () => void saveGiftPrefs());
}
