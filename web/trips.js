// S6 (docs/TRAVEL.md): the Trips page (a place in the sidebar) and its Today tile. Each trip: its
// timeline (flights, hotel, car, train, events) with times in their own time zones, confirmation
// codes, flight status and rebooking options; Add to calendar and Packing list run only on a tap.
// The flight status source is off until the person picks one (AirLabs needs their own free key).
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let data = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#tp-status');
  if (s) s.textContent = msg;
};
const KIND_WORDS = () => ({ flight: t('Flight'), hotel: t('Hotel'), car: t('Car'), train: t('Train'), event: t('Event') });
/** A booking's time in its own zone, in the person's language ("Fri, Nov 20, 8:05 AM CST"). */
export function whenOf(b) {
  try {
    return new Date(b.startsAt).toLocaleString([], { timeZone: b.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch {
    return b.when ?? '';
  }
}
function statusWords(st) {
  if (!st) return '';
  const bits = [];
  if (st.state === 'cancelled') bits.push(t('Cancelled'));
  else if (st.state === 'diverted') bits.push(t('Diverted'));
  else if (st.state === 'landed') bits.push(t('Landed'));
  // U3.14: a position-only source (OpenSky) says where the plane is, never "on time".
  else if (st.position) bits.push(st.position.onGround ? t('On the ground') : t('In the air'));
  else if ((st.depDelayMin ?? 0) >= 15) bits.push(t('Delayed {n} min', { n: st.depDelayMin }));
  else bits.push(t('On time'));
  if (st.depGate) bits.push(t('Gate {gate}', { gate: st.depGate }));
  return bits.join(' · ');
}

export function initTrips(c) {
  ctx = c;
  const save = async (body) => {
    try {
      const r = await ctx.api('/trips/settings', { method: 'PUT', body });
      if (data) data.settings = r.settings;
      paintSettings();
      say(t('Saved.'));
    } catch (err) {
      say(err.message);
    }
  };
  $('#tp-provider')?.addEventListener('change', (e) => void save({ provider: e.target.value }));
  $('#tp-key-save')?.addEventListener('click', () => {
    const k = $('#tp-key');
    void save({ key: k.value.trim() }).then(() => (k.value = ''));
  });
  for (const [id, key] of [['#tp-alerts', 'alerts'], ['#tp-checkin', 'checkin'], ['#tp-leaveby', 'leaveBy']]) $(id)?.addEventListener('change', (e) => void save({ [key]: e.target.checked }));
}

/** U3.19: an Ask hit opened here: the item outlined and scrolled into view. */
function spot(node) {
  if (!node) return;
  node.classList.add('ask-spot');
  node.scrollIntoView?.({ block: 'center' });
  setTimeout(() => node.classList.remove('ask-spot'), 4000);
}

/** Opens Trips; from an Ask hit, at the trip (and its booking). */
export async function openTrips(id, booking) {
  await loadTrips();
  if (!$('#trips').open) $('#trips').showModal();
  if (id) spot($(`#tp-list [data-booking="${Number(booking)}"]`) ?? $(`#tp-list [data-trip="${Number(id)}"]`));
}

export async function loadTrips() {
  if (!ctx) return;
  try {
    data = await ctx.api('/trips');
  } catch (err) {
    say(err.message);
    return;
  }
  render();
}

async function act(id, what, done) {
  try {
    const r = await ctx.api(`/trips/${id}/${what}`, { method: 'POST', body: {} });
    if (done) say(done(r));
    await loadTrips();
  } catch (err) {
    say(err.message);
  }
}

function paintSettings() {
  const s = data?.settings;
  if (!s) return;
  if ($('#tp-provider')) $('#tp-provider').value = s.provider;
  for (const [id, v] of [['#tp-alerts', s.alerts], ['#tp-checkin', s.checkin], ['#tp-leaveby', s.leaveBy]]) if ($(id)) $(id).checked = v;
  const k = $('#tp-key-row');
  if (k) k.hidden = s.provider !== 'airlabs';
  const note = $('#tp-src-note');
  if (note) note.hidden = s.provider !== 'opensky';
  const has = $('#tp-key-state');
  if (has) has.textContent = s.hasKey ? t('A key is saved.') : t('No key saved yet.');
}

function bookingRow(b) {
  const li = el('li', `tp-b tp-${b.kind}`);
  li.dataset.booking = String(b.id);
  const top = el('div', 'tp-b-top');
  top.append(el('span', 'tp-kind', KIND_WORDS()[b.kind] ?? b.kind), el('strong', 'tp-b-title', b.title));
  if (b.status) top.append(el('span', `er-chip tp-chip tp-st-${b.status.state}${(b.status.depDelayMin ?? 0) >= 15 ? ' tp-late' : ''}`, statusWords(b.status)));
  li.append(top);
  const meta = [whenOf(b)];
  if (b.endsAt && (b.kind === 'hotel' || b.kind === 'car')) meta.push(t('until {when}', { when: whenOf({ ...b, startsAt: b.endsAt }) }));
  if (b.place && b.kind !== 'flight') meta.push(b.place);
  if (b.confirmation) meta.push(t('Confirmation {code}', { code: b.confirmation }));
  if (b.inCalendar) meta.push(t('In your calendar'));
  li.append(el('span', 'muted small tp-b-meta', meta.join(' · ')));
  if (b.rebook?.length) {
    const box = el('div', 'tp-rebook');
    box.append(el('span', 'small tp-rebook-h', t('Rebooking options (she never books or pays):')));
    const ul = el('ul', 'tp-rebook-list small');
    for (const o of b.rebook) {
      const item = el('li');
      if (o.url) {
        const a = el('a', '', o.label);
        a.href = o.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        item.append(a);
      } else item.append(o.label);
      ul.append(item);
    }
    box.append(ul);
    li.append(box);
  }
  return li;
}

function card(trip) {
  const c = el('section', 'tp-card');
  c.dataset.trip = String(trip.id);
  const head = el('div', 'tp-head');
  head.append(el('strong', 'tp-title', trip.title), el('span', 'muted small', trip.dates));
  const ol = el('ol', 'tp-line');
  for (const b of trip.bookings) ol.append(bookingRow(b));
  const actions = el('div', 'tp-actions');
  const flights = trip.bookings.some((b) => b.kind === 'flight');
  actions.append(btn(t('Rename'), 'ghost small', () => renameTrip(trip, head)));
  actions.append(btn(t('Add to calendar'), 'ghost small', () => void act(trip.id, 'calendar', (r) => r.text)));
  actions.append(btn(trip.packing ? t('Packing list made') : t('Packing list'), 'ghost small', () => void act(trip.id, 'packing', (r) => t('Packing list “{name}”: {n} things, on your shared lists in the Planner.', { name: r.packing.name, n: r.packing.items.length }))));
  if (flights) actions.append(btn(t('Check flights now'), 'ghost small', () => void act(trip.id, 'check', () => (data?.settings?.provider === 'off' ? t('Flight status is off. Pick a source below.') : t('Checked.')))));
  actions.append(
    btn(t('Forget this trip'), 'ghost small', async () => {
      if (!confirm(t('Forget this trip? A new email about it brings it back.'))) return;
      try {
        await ctx.api(`/trips/${trip.id}`, { method: 'DELETE' });
        await loadTrips();
      } catch (err) {
        say(err.message);
      }
    }),
  );
  c.append(head, ol);
  if (trip.packing) c.append(el('p', 'muted small tp-pack', t('Packing list “{name}”: {n} things, on your shared lists in the Planner.', { name: trip.packing.name, n: trip.packing.items.length })));
  c.append(actions);
  return c;
}

/** V0.10: rename a trip in place (the route existed since S6); an empty name gives back her own. */
function renameTrip(trip, head) {
  const input = el('input', 'tp-rename');
  input.type = 'text';
  input.value = trip.title;
  input.maxLength = 120;
  input.setAttribute('aria-label', t('Trip name'));
  input.placeholder = t('Leave it empty to go back to the name she gave it.');
  const save = btn(t('Save'), 'small', async () => {
    save.disabled = true;
    try {
      await ctx.api(`/trips/${trip.id}`, { method: 'PATCH', body: { title: input.value } });
      say(t('Renamed.'));
      await loadTrips();
    } catch (err) {
      save.disabled = false;
      say(err.message);
    }
  });
  const cancel = btn(t('Cancel'), 'ghost small', () => render());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save.click();
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      render();
    }
  });
  const row = el('div', 'tp-rename-row');
  row.append(input, save, cancel);
  head.replaceChildren(row);
  input.focus();
  input.select();
}

function render() {
  paintSettings();
  const list = $('#tp-list');
  if (!list) return;
  const trips = data?.trips ?? [];
  if (!trips.length) {
    list.replaceChildren(el('p', 'muted small', t('No trips yet. When a booking arrives in a connected mailbox (a flight, hotel, rental car, train or event ticket), it shows up here as a trip.')));
    return;
  }
  list.replaceChildren(...trips.map(card));
}

/** Today: the next trip (or the one under way) and what comes next. */
export function renderTripsTile(p, tileHead) {
  const tile = $('#td-trips');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Trips'));
  const list = el('ul', 'td-biz tp-tile');
  for (const tr of p.trips) {
    const li = el('li', 'small tp-tile-trip');
    const top = el('div', 'tp-tile-top');
    top.append(el('span', 'tp-tile-title', tr.title), el('span', 'muted', tr.dates));
    li.append(top);
    for (const n of tr.next) li.append(el('span', 'muted tp-tile-next', `${n.kind === 'train' ? `${KIND_WORDS().train} ${n.title}` : `${KIND_WORDS()[n.kind] ?? ''}: ${n.title}`} · ${n.when}${n.status ? ` · ${n.status}` : ''}`));
    list.append(li);
  }
  tile.querySelector('.td-body').replaceChildren(list, btn(t('Open Trips'), 'ghost small', () => void openTrips()));
}
