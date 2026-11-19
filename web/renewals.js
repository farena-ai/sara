// V2.1 (docs/RENEWALS.md): Settings → You → What Sara knows → Renewals and paperwork. One list of what
// needs renewing (passport, license, registration, insurance, warranties, subscriptions, a lease) from
// her Library documents, renewal mail, the Money page and rows you add. Each row: Remind me (at the
// usual days before), Fill the form (asks her in chat; she stops before Submit), Start a renewal errand,
// Hide. Add by photo of the card: the photo goes to the Library and is read like any document.
import { t } from './naming.js';
import { api } from './setup-card.js';
import { handleIt } from './handle-it.js';

const $ = (sel) => document.querySelector(sel);
let hooks = {};
export function initRenewals(h) {
  hooks = h ?? {};
}

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
const WHAT = () => ({ passport: t('Passport'), license: t('Driver’s license'), registration: t('Registration'), insurance: t('Insurance'), warranty: t('Warranty'), subscription: t('Subscription'), lease: t('Lease'), other: t('Other') });
const ICON = { passport: '🛂', license: '🪪', registration: '🚗', insurance: '🛡️', warranty: '🧾', subscription: '🔁', lease: '🏠', other: '📄' };
const day = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};
const left = (n) => (n <= 0 ? t('today') : n === 1 ? t('tomorrow') : n < 60 ? t('in {n} days', { n }) : n < 730 ? t('in {n} months', { n: Math.round(n / 30.4) }) : t('in {n} years', { n: Math.round(n / 365) }));
const closeSettings = () => {
  const st = document.querySelector('#settings');
  if (st?.open) st.close();
};
const say = (msg) => {
  const s = $('#rnw-status');
  if (s) s.textContent = msg;
};

async function act(path, body, done) {
  try {
    const r = await api(path, { method: 'POST', body: body ?? {} });
    if (done) done(r);
  } catch (e) {
    say(e.message);
  }
  void loadRenewals();
}

function sourceLine(r) {
  const line = el('div', 'rnw-src muted small');
  const s = r.source ?? {};
  if (s.kind === 'document' && s.docId) {
    const a = el('a', 'wsk-link', s.page ? `${s.name}, ${t('p. {n}', { n: s.page })}` : s.name);
    a.href = s.page ? `/#view=library:${s.docId}:${s.page}` : `/#view=library:${s.docId}`;
    a.addEventListener('click', closeSettings);
    line.append(t('Read in a document'), ' · ', a);
  } else if (s.kind === 'mail') line.append(t('From your mail: {who}', { who: s.sender || t('a sender') }));
  else if (s.kind === 'money') line.append(t('From the Money page'));
  else line.append(t('You added it'));
  if (r.alsoIn) line.append(` · ${t('also in your mail or Money page')}`);
  if (r.reminder) line.append(` · ${t('Reminder on {day}', { day: day(r.reminder.dueAt) })}`);
  return line;
}

function row(r) {
  const li = el('li', `rnw-row${r.daysLeft <= r.daysBefore ? ' soon' : ''}`);
  li.dataset.id = r.id;
  const head = el('div', 'rnw-head');
  const what = WHAT()[r.what] ?? r.what;
  head.append(el('span', 'rnw-icon', ICON[r.what] ?? ICON.other), el('span', 'rnw-what small', what), el('span', 'rnw-title', r.title));
  const when = el('div', 'rnw-when small', `${day(r.date)} · ${left(r.daysLeft)}`);
  li.append(head, when, sourceLine(r));
  const acts = el('div', 'rnw-acts');
  const remind = btn(r.reminder ? t('Reminder set') : t('Remind me {n} days before', { n: r.daysBefore }), r.reminder || r.daysLeft > r.daysBefore ? 'ghost small' : 'small', () => void act(`/facts/renewals/${encodeURIComponent(r.id)}/remind`, {}, () => say(t('Reminder added.'))));
  remind.disabled = Boolean(r.reminder);
  const fill = btn(t('Fill the form'), 'ghost small', () => {
    closeSettings();
    void hooks.ask?.(t('Help me fill in the renewal form for my {what} “{title}” (date: {date}) with My details. Use the form in my Library if there is one, else the official renewal page, and stop before Submit.', { what: what.toLowerCase(), title: r.title, date: day(r.date) }));
  });
  fill.title = t('Asks her in a chat: she fills it with My details and stops before Submit.');
  const errand = r.errandId
    ? btn(t('Open the errand'), 'ghost small', () => (closeSettings(), hooks.openErrands?.()))
    : btn(t('Start a renewal errand'), 'ghost small', () =>
        void act(`/facts/renewals/${encodeURIComponent(r.id)}/errand`, {}, () => {
          say(t('Errand planned. Press Start on the Errands page when you are ready.'));
          closeSettings();
          hooks.openErrands?.();
        }),
      );
  const hide = btn(r.source?.kind === 'you' ? t('Delete') : t('Hide'), 'ghost small', () => void act(`/facts/renewals/${encodeURIComponent(r.id)}/${r.source?.kind === 'you' ? 'remove' : 'hide'}`, {}, () => say(t('Done.'))));
  // W4.1: Handle it = her plan first, then the run with its stops (web/handle-it.js).
  const handle = btn(t('Handle it'), 'small', () => void handleIt('renewal', r.id));
  acts.append(handle, remind, fill, errand, hide);
  li.append(acts);
  return li;
}

let shown = 0;
export async function loadRenewals() {
  const host = $('#rnw-list');
  if (!host) return;
  let r;
  try {
    r = await api('/facts/renewals');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  shown = r.renewals.length;
  if (!shown) {
    host.replaceChildren(el('p', 'muted small', t('Nothing to renew yet. Add your passport, license, policies and warranties to the Library, snap a photo of a card, or type one in below: renewal mail shows up here by itself.')));
    return;
  }
  const ul = el('ul', 'rnw-rows');
  ul.append(...r.renewals.map(row));
  host.replaceChildren(ul);
}

async function addOne() {
  const title = ($('#rnw-title')?.value ?? '').trim();
  const date = $('#rnw-date')?.value ?? '';
  const what = $('#rnw-what')?.value ?? '';
  await act('/facts/renewals', { what, title, date }, () => {
    $('#rnw-title').value = '';
    $('#rnw-date').value = '';
    say(t('Added.'));
  });
}

async function addPhoto(file) {
  if (!file) return;
  const before = shown;
  say(t('Reading the photo…'));
  try {
    const lib = await import('./library.js');
    const doc = await lib.uploadDoc(file, { keep: true, learn: false });
    const [d] = await lib.waitRead([doc.id], (s) => say(s));
    if (d?.status === 'failed') return say(`${t("Couldn't read it")}: ${d.error ?? ''}`);
    await loadRenewals();
    say(shown > before ? t('Found the date and added it. The photo is in your Library.') : t('No renewal date found on it. Type it in below; the photo is in your Library.'));
  } catch (e) {
    say(e.message);
  } finally {
    const inp = $('#rnw-photo');
    if (inp) inp.value = '';
  }
}

globalThis.document?.addEventListener('click', (e) => {
  if (e.target?.closest?.('#rnw-add')) void addOne();
});
globalThis.document?.addEventListener('change', (e) => {
  if (e.target?.id === 'rnw-photo') void addPhoto(e.target.files?.[0]);
});
