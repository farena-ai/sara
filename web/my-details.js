// N4 (docs/MY_DETAILS.md): Settings → You → My details. What a person types into forms again and again
// (name, emails, phones, addresses, sizes, vehicles, insurance and loyalty numbers, work, an emergency
// contact), for Sara to fill web forms in their own browser. Each person's own (household members have
// their own). The server refuses card numbers, SSNs and passwords and says which field.
import { t } from './naming.js';
import { api } from './setup-card.js';

const $ = (sel) => document.querySelector(sel);
const ADDR = { home: 'home', work: 'work', ship: 'shipping' };
const PARTS = ['line1', 'line2', 'city', 'state', 'zip', 'country'];
const val = (id) => ($(`#${id}`)?.value ?? '').trim();
const set = (id, v) => {
  const x = $(`#${id}`);
  if (x) x.value = v ?? '';
};

export async function loadMyDetails() {
  if (!$('#md-first')) return;
  let r;
  try {
    r = await api('/my-details');
  } catch {
    return; // not on the demo
  }
  const d = r.details ?? {};
  set('md-first', d.firstName);
  set('md-last', d.lastName);
  set('md-email', d.email);
  set('md-work-email', d.workEmail);
  set('md-mobile', d.mobilePhone);
  set('md-home-phone', d.homePhone);
  set('md-work-phone', d.workPhone);
  for (const [k, field] of Object.entries(ADDR)) for (const p of PARTS) set(`md-${k}-${p}`, d[field]?.[p]);
  set('md-birth', d.birthDate);
  set('md-shirt', d.shirtSize);
  set('md-pants', d.pantsSize);
  set('md-dress', d.dressSize);
  set('md-shoe', d.shoeSize);
  for (const n of [1, 2]) for (const p of ['make', 'model', 'year', 'plate', 'vin']) set(`md-v${n}-${p}`, d.vehicles?.[n - 1]?.[p]);
  for (const n of [1, 2]) for (const p of ['kind', 'company', 'policy']) set(`md-i${n}-${p}`, d.insurance?.[n - 1]?.[p]);
  for (const n of [1, 2, 3, 4]) for (const p of ['store', 'number']) set(`md-l${n}-${p}`, d.loyalty?.[n - 1]?.[p]);
  set('md-employer', d.employer);
  set('md-job', d.jobTitle);
  set('md-em-name', d.emergency?.name);
  set('md-em-relation', d.emergency?.relation);
  set('md-em-phone', d.emergency?.phone);
  if ($('#md-leave-tab')) $('#md-leave-tab').checked = r.leaveStoreTab === true;
  $('#md-status').textContent = '';
}

/** The page's values in the server's shape (empty fields left out). */
function collect() {
  const addr = (k) => Object.fromEntries(PARTS.map((p) => [p, val(`md-${k}-${p}`)]).filter(([, v]) => v));
  const rows = (prefix, count, parts) => [...Array(count).keys()].map((i) => Object.fromEntries(parts.map((p) => [p, val(`md-${prefix}${i + 1}-${p}`)]).filter(([, v]) => v))).filter((o) => Object.keys(o).length);
  return {
    firstName: val('md-first'),
    lastName: val('md-last'),
    email: val('md-email'),
    workEmail: val('md-work-email'),
    mobilePhone: val('md-mobile'),
    homePhone: val('md-home-phone'),
    workPhone: val('md-work-phone'),
    home: addr('home'),
    work: addr('work'),
    shipping: addr('ship'),
    birthDate: val('md-birth'),
    shirtSize: val('md-shirt'),
    pantsSize: val('md-pants'),
    dressSize: val('md-dress'),
    shoeSize: val('md-shoe'),
    vehicles: rows('v', 2, ['make', 'model', 'year', 'plate', 'vin']),
    insurance: rows('i', 2, ['kind', 'company', 'policy']),
    loyalty: rows('l', 4, ['store', 'number']),
    employer: val('md-employer'),
    jobTitle: val('md-job'),
    emergency: { name: val('md-em-name'), relation: val('md-em-relation'), phone: val('md-em-phone') },
    leaveStoreTab: $('#md-leave-tab')?.checked === true,
  };
}

/** The input behind a refused field (\"loyalty.0.number\" → #md-l1-number). */
function inputFor(field) {
  const f = String(field ?? '');
  const m = /^(vehicles|insurance|loyalty)\.(\d)\.(\w+)$/.exec(f);
  if (m) return `#md-${{ vehicles: 'v', insurance: 'i', loyalty: 'l' }[m[1]]}${Number(m[2]) + 1}-${m[3]}`;
  const a = /^(home|work|shipping)\.(\w+)$/.exec(f);
  if (a) return `#md-${a[1] === 'shipping' ? 'ship' : a[1]}-${a[2]}`;
  const e = /^emergency\.(\w+)$/.exec(f);
  if (e) return `#md-em-${e[1]}`;
  return { firstName: '#md-first', lastName: '#md-last', email: '#md-email', workEmail: '#md-work-email', mobilePhone: '#md-mobile', homePhone: '#md-home-phone', workPhone: '#md-work-phone', birthDate: '#md-birth', shirtSize: '#md-shirt', pantsSize: '#md-pants', dressSize: '#md-dress', shoeSize: '#md-shoe', employer: '#md-employer', jobTitle: '#md-job' }[f] ?? '';
}

export async function saveMyDetails() {
  if (!$('#md-first')) return;
  const status = $('#md-status');
  try {
    await api('/my-details', { method: 'PUT', body: collect() });
    status.textContent = t('Saved.');
  } catch (err) {
    // A refused value (a card number, an SSN…): say which field, keep everything else as typed.
    const msg = err?.data?.error ?? err?.message ?? t('Couldn’t save your details.');
    status.textContent = msg;
    const sel = inputFor(err?.data?.field);
    if (sel && $(sel)) $(sel).focus();
    throw err;
  }
}
