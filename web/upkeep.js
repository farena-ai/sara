// V2.6 (docs/UPKEEP.md): Settings → You → My details → Car and house upkeep. Each job with its next due
// date (cars by miles or months), Done today / Log with details, Book it (an errand that finds a place
// and asks for a booking, stopping before anything is sent without your OK), reminders on or off,
// history, and service receipts from Money → Purchases offered once. Loaded by web/my-details.js.
import { t } from './naming.js';
import { api } from './setup-card.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (text !== undefined && text !== null) x.textContent = text;
  return x;
};
const btn = (label, cls, on) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', on);
  return b;
};
const day = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const num = (n) => Number(n).toLocaleString();
const money = (c) => (c == null ? '' : (c / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const left = (n) => (n < 0 ? t('{n} days overdue', { n: -n }) : n === 0 ? t('today') : n === 1 ? t('tomorrow') : n < 60 ? t('in {n} days', { n }) : t('in {n} months', { n: Math.round(n / 30.4) }));
const ICON = { car: '🚗', home: '🏠' };
const name = (it) => (it.key === 'own' ? it.title : t(it.title));
const say = (msg) => {
  const s = $('#upk-status');
  if (s) s.textContent = msg ?? '';
};

let wired = false;
let last = null;
let laterOpen = false;
/** Jobs further out than this go under "Later" (the first few always show). */
const SOON_DAYS = 60;
const ALWAYS = 4;

async function act(path, body, done) {
  try {
    const r = await api(`/my-details/upkeep${path}`, { method: 'POST', body: body ?? {} });
    if (done) done(r);
  } catch (e) {
    say(e.message);
  }
  await loadUpkeep();
}

function every(it) {
  const parts = [];
  if (it.everyMonths) parts.push(it.everyMonths === 1 ? t('every month') : t('every {n} months', { n: it.everyMonths }));
  if (it.everyMiles) parts.push(t('every {n} miles', { n: num(it.everyMiles) }));
  return parts.join(` ${t('or')} `);
}

function logForm(it, li) {
  const f = el('div', 'upk-log');
  const date = el('input');
  date.type = 'date';
  date.value = new Date().toLocaleDateString('en-CA');
  date.setAttribute('aria-label', t('Date'));
  const inputs = [date];
  let miles;
  if (it.car) {
    miles = el('input');
    miles.inputMode = 'numeric';
    miles.placeholder = t('Miles');
    miles.setAttribute('aria-label', t('Miles'));
    inputs.push(miles);
  }
  const cost = el('input');
  cost.inputMode = 'decimal';
  cost.placeholder = t('Cost');
  cost.setAttribute('aria-label', t('Cost'));
  const note = el('input');
  note.maxLength = 200;
  note.placeholder = t('Note');
  note.setAttribute('aria-label', t('Note'));
  inputs.push(cost, note);
  f.append(...inputs, btn(t('Save'), 'small', () => void act(`/${it.id}/log`, { date: date.value, miles: miles?.value, cost: cost.value, note: note.value }, () => say(t('Logged. The next date moved.')))));
  li.append(f);
  date.focus();
}

function row(it) {
  const li = el('li', `upk-row${it.daysLeft <= 7 ? ' soon' : ''}${it.daysLeft < 0 ? ' late' : ''}`);
  li.dataset.id = String(it.id);
  const head = el('div', 'upk-head');
  head.append(el('span', 'upk-icon', ICON[it.place]), el('span', 'upk-title', name(it)));
  if (it.car) head.append(el('span', 'upk-car muted small', it.car));
  const due = it.next.by === 'miles' && it.next.miles ? t('Due around {miles} miles (about {date})', { miles: num(it.next.miles), date: day(it.next.date) }) : t('Due {date}', { date: day(it.next.date) });
  const when = el('div', 'upk-when small', `${due} · ${left(it.daysLeft)}`);
  const sub = [every(it), it.lastDate ? t('last done {date}', { date: day(it.lastDate) }) : t('not logged yet: counting from when you added it')];
  if (it.reminder?.status === 'pending') sub.push(t('reminder on {date}', { date: day(it.reminder.dueAt) }));
  else if (!it.remind) sub.push(t('no reminder'));
  const meta = el('div', 'upk-meta muted small', sub.join(' · '));
  li.append(head, when, meta);
  if (it.why) li.append(el('div', 'upk-why muted small', t(it.why)));
  const acts = el('div', 'upk-acts');
  acts.append(
    btn(t('Done today'), it.daysLeft <= 7 ? 'small' : 'ghost small', () => void act(`/${it.id}/log`, {}, () => say(t('Logged. The next date moved.')))),
    btn(t('Log with details'), 'ghost small', (e) => {
      e.currentTarget.disabled = true;
      logForm(it, li);
    }),
  );
  if (it.service) {
    if (it.errandId) acts.append(btn(t('Open the errand'), 'ghost small', () => openErrandsView()));
    else acts.append(btn(t('Book it'), 'ghost small', () => void act(`/${it.id}/book`, {}, () => { say(t('Errand started: she finds places near you and asks before booking.')); openErrandsView(); })));
  }
  acts.append(
    btn(it.remind ? t('Reminders off') : t('Reminders on'), 'ghost small', () => void act(`/${it.id}/remind`, { on: !it.remind })),
    btn(t('Remove'), 'ghost small danger', () => {
      if (confirm(t('Remove “{name}” and its history?', { name: name(it) }))) void act(`/${it.id}/remove`);
    }),
  );
  li.append(acts);
  if (it.history?.length) {
    const d = el('details', 'upk-hist');
    d.append(el('summary', 'small', t('History ({n})', { n: it.history.length })));
    const ul = el('ul', 'small');
    for (const h of it.history) {
      const bits = [day(h.date)];
      if (h.miles != null) bits.push(t('{n} miles', { n: num(h.miles) }));
      if (h.costCents != null) bits.push(money(h.costCents));
      if (h.note) bits.push(h.note);
      if (h.source === 'receipt') bits.push(t('from a receipt'));
      ul.append(el('li', '', bits.join(' · ')));
    }
    d.append(ul);
    li.append(d);
  }
  return li;
}

function openErrandsView() {
  const st = $('#settings');
  if (st?.open) st.close();
  location.hash = '#view=errands';
}

function found(list) {
  const box = $('#upk-found');
  if (!box) return;
  box.replaceChildren();
  box.hidden = !list.length;
  if (!list.length) return;
  box.append(el('p', 'small upk-found-head', t('Found in your receipts')));
  const ul = el('ul', 'upk-rows');
  for (const f of list) {
    const li = el('li', 'upk-row');
    li.append(el('div', 'small', t('{item} at {store}, {date}: looks like “{job}”', { item: f.item, store: f.store, date: day(f.date), job: t(f.title) }) + (f.car ? ` (${f.car})` : '')));
    const acts = el('div', 'upk-acts');
    acts.append(btn(t('Log it'), 'small', () => void act(`/${f.itemId}/log`, { purchaseId: f.purchaseId }, () => say(t('Logged. The next date moved.')))), btn(t('Not this'), 'ghost small', () => void act('/skip', { purchaseId: f.purchaseId })));
    li.append(acts);
    ul.append(li);
  }
  box.append(ul);
}

function wire() {
  if (wired || !$('#upk-box')) return;
  wired = true;
  const car = () => $('#upk-car').value.trim();
  $('#upk-setup-car').addEventListener('click', () => {
    if (!car()) return void (say(t('Type which car first, like 2019 Honda Civic.')), $('#upk-car').focus());
    void act('/setup', { place: 'car', car: car() }, (r) => say(r.added ? t('Added {n} jobs.', { n: r.added }) : t('That schedule is already here.')));
  });
  $('#upk-setup-home').addEventListener('click', () => void act('/setup', { place: 'home' }, (r) => say(r.added ? t('Added {n} jobs.', { n: r.added }) : t('That schedule is already here.'))));
  $('#upk-odo-save').addEventListener('click', () => {
    if (!car()) return void (say(t('Type which car first, like 2019 Honda Civic.')), $('#upk-car').focus());
    void act('/miles', { car: car(), miles: $('#upk-odo-miles').value }, () => {
      $('#upk-odo-miles').value = '';
      say(t('Miles saved.'));
    });
  });
  $('#upk-add-go').addEventListener('click', () => {
    const body = { title: $('#upk-add-title').value, everyMonths: $('#upk-add-months').value, everyMiles: $('#upk-add-miles').value };
    const forCar = $('#upk-add-for').value;
    void act('/add', forCar ? { ...body, place: 'car', car: forCar } : { ...body, place: 'home' }, () => {
      for (const id of ['#upk-add-title', '#upk-add-months', '#upk-add-miles']) $(id).value = '';
      say(t('Added.'));
    });
  });
  $('#upk-car').addEventListener('input', () => paintOdo());
}

function paintOdo() {
  const note = $('#upk-odo-note');
  if (!note || !last) return;
  const o = last.odometer?.[$('#upk-car').value.trim()];
  note.textContent = o ? t('Last: {miles} miles on {date}, about {n} a day', { miles: num(o.miles), date: day(o.date), n: o.perDay }) : '';
}

export async function loadUpkeep() {
  if (!$('#upk-box')) return;
  wire();
  try {
    last = await api('/my-details/upkeep');
  } catch {
    return; // not on the demo
  }
  const rows = $('#upk-rows');
  const soon = last.items.filter((it, i) => i < ALWAYS || it.daysLeft <= SOON_DAYS);
  const later = last.items.slice(soon.length);
  rows.replaceChildren(...soon.map(row));
  if (later.length) {
    const d = el('details', 'upk-later');
    d.open = laterOpen;
    d.addEventListener('toggle', () => (laterOpen = d.open));
    d.append(el('summary', 'small', t('Later ({n})', { n: later.length })));
    const ul = el('ul', 'upk-rows');
    ul.append(...later.map(row));
    d.append(ul);
    const li = el('li', 'upk-later-li');
    li.append(d);
    rows.append(li);
  }
  const pick = $('#upk-add-for');
  const was = pick.value;
  pick.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: t('Home') }), ...last.cars.map((c) => Object.assign(document.createElement('option'), { value: c, textContent: c })));
  pick.value = last.cars.includes(was) ? was : '';
  $('#upk-empty').hidden = last.items.length > 0;
  const dl = $('#upk-cars');
  dl.replaceChildren(...last.cars.map((c) => Object.assign(document.createElement('option'), { value: c })));
  if (!$('#upk-car').value && last.cars.length) $('#upk-car').value = last.cars[0];
  paintOdo();
  found(last.found);
}
