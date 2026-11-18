// U4.21 (docs/FAMILY.md "Home and family planner"): the Meals and Calendar tabs of the Family page,
// the chores rota editor, and the Family planner section in Settings → Household. Meals: a week grid
// with one dinner a day (a saved recipe or a title), allergy warnings, recipes pasted as text or a
// page address, everyone's likes and allergies, and one tap to the grocery list. Calendar: the family
// week (events, dinners, chores), events a parent approves after an import (a school letter, a PDF in
// the Library, an iCal file or link), and private events only their person sees. Nothing calls a model.
import { t } from './naming.js';

/** @type {{ api: Function, el: Function, say: Function, reload: Function, data: () => any } | null} */
let h = null;
let weekStart = '';
let week = null;
let libDocs = null;

export function initFamilyPlan(c) {
  h = c;
}
const el = (tag, cls, text) => h.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const input = (cls, attrs = {}) => Object.assign(el('input', cls), attrs);
const labelled = (control, label) => (control.setAttribute('aria-label', label), control);
const dayName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const nameOf = (id) => h.data()?.people.find((p) => p.id === id)?.name ?? id;
const parent = () => Boolean(h.data()?.me.parent);
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function act(f, ok) {
  try {
    const r = await f();
    if (ok) h.say(typeof ok === 'function' ? ok(r) : ok);
  } catch (err) {
    h.say(err.message);
  }
  await loadWeek();
  h.rerender();
}
async function loadWeek() {
  try {
    week = await h.api(`/family/week${weekStart ? `?start=${weekStart}` : ''}`);
    weekStart = week.week.start;
  } catch (err) {
    h.say(err.message);
  }
}

function weekNav(body, render) {
  const nav = el('div', 'fpl-nav');
  const go = (n) => async () => {
    weekStart = addDays(weekStart, n);
    await loadWeek();
    render();
  };
  nav.append(btn('‹', 'ghost small', go(-7)), el('strong', 'fpl-week', t('Week of {day}', { day: dayName(weekStart) })), btn('›', 'ghost small', go(7)));
  nav.firstChild.setAttribute('aria-label', t('Previous week'));
  nav.lastChild.setAttribute('aria-label', t('Next week'));
  if (weekStart !== week?.thisWeek) nav.append(btn(t('This week'), 'ghost small', async () => {
    weekStart = '';
    await loadWeek();
    render();
  }));
  body.append(nav);
}

// ---------------------------------------------------------------- Meals
export async function mealsTab(body) {
  if (!week) await loadWeek();
  if (!week) return;
  const render = () => {
    body.replaceChildren();
    void mealsTab(body);
  };
  weekNav(body, render);
  const grid = el('div', 'fpl-grid');
  const today = todayIso();
  for (const d of week.week.days) {
    const card = el('div', `fpl-day${d.day === today ? ' fpl-today' : ''}`);
    card.append(el('strong', 'fpl-dayname', dayName(d.day)));
    if (d.meal) {
      card.append(el('span', 'fpl-meal', `🍽 ${d.meal.title}`));
      for (const w of d.meal.warnings) card.append(el('span', 'fpl-warn small', t('Allergy: {who}', { who: w })));
    } else card.append(el('span', 'muted small', t('No dinner yet')));
    if (parent()) {
      const pick = el('select', 'fpl-pick');
      labelled(pick, t('Dinner'));
      pick.append(Object.assign(document.createElement('option'), { value: '', textContent: t('Pick a recipe…') }));
      for (const r of week.recipes) pick.append(Object.assign(document.createElement('option'), { value: String(r.id), textContent: r.title, selected: d.meal?.recipeId === r.id }));
      const name = labelled(input('fpl-title', { maxLength: 100, placeholder: t('or type a dinner') }), t('Dinner'));
      const row = el('div', 'fpl-row');
      row.append(btn(t('Save'), 'small', () => void act(() => h.api(`/family/meals/${d.day}`, { method: 'PUT', body: pick.value ? { recipeId: Number(pick.value), ...(name.value.trim() ? { title: name.value } : {}) } : { title: name.value } }), (r) => (r.warnings?.length ? t('Saved. Allergy: {who}', { who: r.warnings.join('; ') }) : t('Saved.')))));
      if (d.meal) row.append(btn(t('Clear'), 'ghost small', () => void act(() => h.api(`/family/meals/${d.day}`, { method: 'DELETE' }))));
      card.append(pick, name, row);
    }
    grid.append(card);
  }
  body.append(grid);
  if (parent()) {
    const shop = el('div', 'fpl-row');
    shop.append(btn(t('Add to the grocery list'), 'small', () => void act(() => h.api('/family/meals/shopping', { method: 'POST', body: { start: weekStart } }), (r) => t('Added {n} items to the grocery list.', { n: r.added }))), tip(t('Puts this week’s ingredients on your grocery list, with amounts added up and grouped by aisle. Things already on the list are not added twice.')));
    shop.append(el('span', 'muted small', t('Or ask her: “plan dinners for the week”. She reads everyone’s allergies first.')));
    body.append(shop);
    body.append(recipesCard());
  }
  body.append(prefsCard());
}

function recipesCard() {
  const card = el('div', 'fam-card');
  const head = el('h3', 'fam-h', t('Family recipes'));
  head.append(' ', tip(t('Paste a recipe (the title on the first line, then the ingredients) or a recipe page’s address. Sara keeps the ingredients so the grocery list can add them up.')));
  card.append(head);
  const box = labelled(Object.assign(el('textarea', 'fpl-paste'), { rows: 4, maxLength: 40000, placeholder: t('Paste a recipe or a recipe page address') }), t('Recipe'));
  const row = el('div', 'fpl-row');
  const lib = labelled(el('select', 'fpl-lib'), t('From the Library'));
  lib.append(Object.assign(document.createElement('option'), { value: '', textContent: t('From the Library…') }));
  void libraryDocs().then((docs) => {
    for (const d of docs) lib.append(Object.assign(document.createElement('option'), { value: String(d.id), textContent: d.name }));
  });
  row.append(btn(t('Save recipe'), 'small', () => void act(() => {
    const v = box.value.trim();
    if (lib.value) return h.api('/family/recipes', { method: 'POST', body: { libraryId: Number(lib.value) } });
    if (!v) throw new Error(t('Paste a recipe first.'));
    return h.api('/family/recipes', { method: 'POST', body: /^(https?:\/\/)\S+$/i.test(v) ? { url: v } : { text: v } });
  }, (r) => t('Saved “{title}” with {n} ingredients.', { title: r.recipe.title, n: r.recipe.ingredients.length }))), lib);
  card.append(box, row);
  if (week.recipes.length) {
    const ul = el('ul', 'fam-list');
    for (const r of week.recipes) {
      const li = el('li', 'fam-row');
      li.append(el('span', 'fam-main', `${r.title} · ${t('{n} ingredients', { n: r.n })}`), btn(t('Delete'), 'ghost small', () => {
        if (confirm(t('Delete the recipe “{title}”?', { title: r.title }))) void act(() => h.api(`/family/recipes/${r.id}`, { method: 'DELETE' }));
      }));
      ul.append(li);
    }
    card.append(ul);
  }
  return card;
}

async function libraryDocs() {
  if (!libDocs) libDocs = (await h.api('/library').catch(() => null))?.docs?.slice(0, 200).map((d) => ({ id: d.id, name: d.name ?? d.title ?? String(d.id) })) ?? [];
  return libDocs;
}

function prefsCard() {
  const card = el('div', 'fam-card');
  const head = el('h3', 'fam-h', parent() ? t('Likes and allergies') : t('What I like and can’t eat'));
  head.append(' ', tip(t('Used when dinners are planned: an allergy shows a warning on any dinner with it. Each person sees and edits only their own; parents see everyone’s.')));
  card.append(head);
  const d = h.data();
  const who = parent() ? d.people : d.people.filter((p) => p.id === d.me.person);
  for (const p of who) {
    const cur = week.prefs.find((x) => x.person === p.id) ?? { likes: '', dislikes: '', allergies: '' };
    const row = el('div', 'fpl-prefs');
    const likes = labelled(input('', { value: cur.likes, maxLength: 200, placeholder: t('Likes') }), t('Likes'));
    const dislikes = labelled(input('', { value: cur.dislikes, maxLength: 200, placeholder: t('Doesn’t like') }), t('Doesn’t like'));
    const allergies = labelled(input('', { value: cur.allergies, maxLength: 200, placeholder: t('Allergies') }), t('Allergies'));
    row.append(el('strong', '', p.name), likes, dislikes, allergies, btn(t('Save'), 'ghost small', () => void act(() => h.api(`/family/prefs/${p.id}`, { method: 'PUT', body: { likes: likes.value, dislikes: dislikes.value, allergies: allergies.value } }), t('Saved.'))));
    card.append(row);
  }
  return card;
}

// ---------------------------------------------------------------- Calendar
export async function calendarTab(body) {
  if (!week) await loadWeek();
  if (!week) return;
  const render = () => {
    body.replaceChildren();
    void calendarTab(body);
  };
  weekNav(body, render);
  const grid = el('div', 'fpl-grid fpl-cal');
  const today = todayIso();
  for (const d of week.week.days) {
    const card = el('div', `fpl-day${d.day === today ? ' fpl-today' : ''}`);
    card.append(el('strong', 'fpl-dayname', dayName(d.day)));
    const ul = el('ul', 'fpl-items');
    for (const e of d.events) {
      const li = el('li', `fpl-ev${e.who === 'family' ? '' : ' fpl-private'}`);
      const txt = el('span', 'fpl-ev-text', `${e.allDay ? '' : `${e.start.slice(11)} `}${e.title}`);
      if (e.who !== 'family') txt.append(el('span', 'muted small', ` · ${t('only you')}`));
      li.append(txt);
      if (e.who !== 'family' || parent()) {
        const x = btn('✕', 'ghost small fpl-x', () => void act(() => h.api(`/family/events/${e.id}`, { method: 'DELETE' })));
        x.setAttribute('aria-label', t('Remove {title}', { title: e.title }));
        li.append(x);
      }
      ul.append(li);
    }
    if (d.meal) ul.append(el('li', 'fpl-dinner', `🍽 ${d.meal.title}`));
    for (const c of d.chores) ul.append(el('li', 'fpl-chore muted', `✓ ${c.title} · ${nameOf(c.assignee)}`));
    if (!ul.children.length) ul.append(el('li', 'muted small', t('Nothing planned')));
    card.append(ul);
    grid.append(card);
  }
  body.append(grid);
  body.append(addEventCard());
  if (parent() && week.pending.length) body.append(pendingCard());
  if (parent()) body.append(importCard());
}

function addEventCard() {
  const card = el('div', 'fam-card');
  const head = el('h3', 'fam-h', t('Add an event'));
  head.append(' ', tip(parent() ? t('Family events show for everyone at home. Tick Only me for a private one: nobody else sees it, not even the owner.') : t('Family events wait for a parent’s OK before everyone sees them. Only me keeps it private: nobody else sees it.')));
  card.append(head);
  const row = el('div', 'fam-add');
  const title = labelled(input('', { maxLength: 100, placeholder: t('Swim meet, dentist, game night…') }), t('Event'));
  const day = labelled(input('fam-num fpl-date', { type: 'date', value: weekStart }), t('Date'));
  const time = labelled(input('fam-num', { type: 'time' }), t('Time (optional)'));
  const mine = input('', { type: 'checkbox' });
  const l = el('label', 'fam-check');
  l.append(mine, el('span', '', t('Only me')));
  row.append(title, day, time, l, btn(t('Add'), 'small', () => void act(() => {
    if (!title.value.trim() || !day.value) throw new Error(t('Name the event and pick a date.'));
    return h.api('/family/events', { method: 'POST', body: { title: title.value, start: time.value ? `${day.value}T${time.value}` : day.value, who: mine.checked ? 'me' : 'family' } });
  }, (r) => (r.event.status === 'pending' ? t('Added. It waits for a parent’s OK.') : t('Added.')))));
  card.append(row);
  return card;
}

function pendingCard() {
  const card = el('div', 'fam-card fpl-pending');
  card.append(el('h3', 'fam-h', t('{n} events waiting for your OK', { n: week.pending.length })));
  const ul = el('ul', 'fam-list');
  const boxes = [];
  for (const e of week.pending) {
    const li = el('li', 'fam-row');
    const l = el('label', 'fam-check');
    const b = input('', { type: 'checkbox', checked: true });
    b.dataset.id = String(e.id);
    boxes.push(b);
    l.append(b, el('span', '', `${dayName(e.start.slice(0, 10))}${e.allDay ? '' : ` ${e.start.slice(11)}`} · ${e.title}`));
    li.append(l, el('span', 'muted small', e.source || nameOf(e.by)));
    ul.append(li);
  }
  const ids = (on) => boxes.filter((b) => b.checked === on).map((b) => Number(b.dataset.id));
  const row = el('div', 'fpl-row');
  row.append(btn(t('Add the ticked ones'), 'small', () => void act(async () => {
    await h.api('/family/events/decide', { method: 'POST', body: { ids: ids(true), ok: true } });
    if (ids(false).length) await h.api('/family/events/decide', { method: 'POST', body: { ids: ids(false), ok: false } });
  }, t('Added to the family calendar.'))), btn(t('Skip them all'), 'ghost small', () => void act(() => h.api('/family/events/decide', { method: 'POST', body: { ids: boxes.map((b) => Number(b.dataset.id)), ok: false } }))));
  card.append(ul, row);
  return card;
}

function importCard() {
  const card = el('div', 'fam-card');
  const head = el('h3', 'fam-h', t('Import a school or activity calendar'));
  head.append(' ', tip(t('Paste a school letter or email, pick a PDF from the Library, or give an iCal link or .ics file. Every dated line becomes an event that waits for your OK.')));
  card.append(head);
  const box = labelled(Object.assign(el('textarea', 'fpl-paste'), { rows: 3, maxLength: 200000, placeholder: t('Paste a school letter, or an iCal link (webcal:// or .ics)') }), t('Calendar text or link'));
  const file = Object.assign(input('', { type: 'file', accept: '.ics,.txt,text/calendar,text/plain' }), { hidden: true });
  const lib = labelled(el('select', 'fpl-lib'), t('From the Library'));
  lib.append(Object.assign(document.createElement('option'), { value: '', textContent: t('A PDF in the Library…') }));
  void libraryDocs().then((docs) => {
    for (const d of docs) lib.append(Object.assign(document.createElement('option'), { value: String(d.id), textContent: d.name }));
  });
  const send = (body) => act(() => h.api('/family/events/import', { method: 'POST', body }), (r) => t('Found {n} events. Tick the ones to add.', { n: r.pending.length }));
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    const text = await f.text();
    void send(text.includes('BEGIN:VCALENDAR') ? { ics: text, source: f.name } : { text, source: f.name });
  });
  const row = el('div', 'fpl-row');
  row.append(btn(t('Read it'), 'small', () => {
    const v = box.value.trim();
    if (lib.value) return void send({ libraryId: Number(lib.value), source: lib.selectedOptions[0]?.textContent ?? '' });
    if (!v) return h.say(t('Paste something first.'));
    void send(/^(https?|webcals?):\/\/\S+$/i.test(v) ? { url: v } : { text: v });
  }), btn(t('Open an .ics file'), 'ghost small', () => file.click()), lib, file);
  card.append(box, row);
  return card;
}

// ---------------------------------------------------------------- Chores: rota and stars
/** "Takes turns" for a chore (parents): the people it rotates between, weekly. */
export function rotaControl(c, onSaved) {
  const d = h.data();
  const cur = d.plan?.rotas?.[c.id] ?? [];
  const wrap = el('details', 'fpl-rota');
  wrap.append(el('summary', 'small', cur.length ? t('Takes turns: {list}', { list: cur.map(nameOf).join(' → ') }) : t('Take turns…')));
  const boxes = [];
  for (const p of d.people.filter((x) => x.id !== 'owner' || d.people.length < 3)) {
    const l = el('label', 'fam-check');
    const b = input('', { type: 'checkbox', checked: cur.includes(p.id) || (!cur.length && p.id === c.assignee) });
    b.dataset.id = p.id;
    boxes.push(b);
    l.append(b, el('span', '', p.name));
    wrap.append(l);
  }
  wrap.append(btn(t('Save'), 'ghost small', async () => {
    try {
      await h.api(`/family/rota/${c.id}`, { method: 'PUT', body: { people: boxes.filter((b) => b.checked).map((b) => b.dataset.id) } });
      h.say(t('Saved. It moves to the next person each week.'));
    } catch (err) {
      h.say(err.message);
    }
    onSaved();
  }), tip(t('Tick two or more people: the chore moves to the next one each week, on the day set in Settings → Household → Family planner.')));
  return wrap;
}
/** A kid's points as stars (at most 5 drawn, the number after). */
export function stars(points) {
  if (!points) return '';
  return `${'★'.repeat(Math.min(5, points))}${points > 5 ? ` ${points}` : ''}`;
}

// ---------------------------------------------------------------- Settings → Household → Family planner
const DAYS = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];
export async function loadPlanSettings() {
  const root = document.querySelector('#fpl-settings');
  if (!root || !h) return;
  const status = document.querySelector('#fpl-set-status');
  let s;
  try {
    s = (await h.api('/family')).plan?.settings;
  } catch (err) {
    if (status) status.textContent = err.message;
    return;
  }
  if (!s) return;
  const dinner = document.querySelector('#fpl-dinner');
  const on = document.querySelector('#fpl-remind');
  const at = document.querySelector('#fpl-remind-at');
  const day = document.querySelector('#fpl-rota-day');
  if (!day.options.length) DAYS().forEach((n, i) => day.append(Object.assign(document.createElement('option'), { value: String(i), textContent: n })));
  dinner.value = s.dinnerTime;
  on.checked = s.reminders;
  at.value = s.remindAt;
  at.disabled = !s.reminders;
  day.value = String(s.rotaDay);
  if (root.dataset.wired) return;
  root.dataset.wired = '1';
  const save = async () => {
    at.disabled = !on.checked;
    try {
      await h.api('/family/plan-settings', { method: 'PUT', body: { dinnerTime: dinner.value, reminders: on.checked, remindAt: at.value, rotaDay: Number(day.value) } });
      if (status) status.textContent = t('Saved.');
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  };
  for (const c of [dinner, on, at, day]) c.addEventListener('change', () => void save());
}

/** Family Today lines: tonight's dinner, chores left, the next family event. */
export function todayLines(p) {
  const out = [];
  if (!p) return out;
  if (p.dinner) out.push(el('p', 'small fpl-tile-dinner', t('Tonight: {meal}', { meal: p.dinner })));
  if (p.choresLeft) out.push(el('p', 'small muted', p.choresLeft === 1 ? t('One chore left today') : t('{n} chores left today', { n: p.choresLeft })));
  if (p.nextEvent) out.push(el('p', 'small muted', t('Next: {title}, {when}', { title: p.nextEvent.title, when: `${dayName(p.nextEvent.start.slice(0, 10))}${p.nextEvent.allDay ? '' : ` ${p.nextEvent.start.slice(11)}`}` })));
  return out;
}
export function resetWeek() {
  week = null;
}
