// S4 (docs/PEOPLE.md "Keeping in touch"): the relationship parts of Memory → People and Today.
// - attentionView: the "Needs attention" list (waiting replies, promises, dates, keep in touch),
//   most urgent first, each with its own answers;
// - tiesSection: on a person's card, the last contact per channel, keep-in-touch cadence, email
//   addresses, dates and promises;
// - renderPeopleDueTile: Today's People tile.
// Every value from the server is set as text.
import { serverText, t } from './naming.js';

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
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.disabled = true;
    try {
      await onClick(b, e);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
}
export async function tiesApi(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

/** A due day (YYYY-MM-DD) in the reader's words ("Fri, Nov 20"). */
export function dayWords(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ''))) return '';
  return new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function agoDays(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = Math.floor(ms / 86_400_000);
  if (d < 0) return dayWords(new Date(iso).toISOString().slice(0, 10));
  if (d === 0) return t('today');
  if (d === 1) return t('yesterday');
  if (d < 60) return t('{n} days ago', { n: d });
  return t('{n} months ago', { n: Math.floor(d / 30) });
}

/** The nudge's line in the reader's language (dates in their words). */
export function nudgeText(n) {
  const params = { ...n.params };
  if (params.date) params.date = dayWords(params.date) || params.date;
  return t(n.text, params);
}

/** The answers a nudge offers: [label, call]. */
function answers(n, done) {
  const act = (action) => () => tiesApi('/people/attention', { method: 'PUT', body: { key: n.key, action } }).then(done);
  const promise = (action) => () => tiesApi(`/people/promises/${n.promiseId}`, { method: 'PUT', body: { action } }).then(done);
  if (n.kind === 'promise-check') return [[t('Yes, I promised'), promise('confirm')], [t('Not a promise'), promise('dismiss')]];
  if (n.kind === 'promise') return [[t('Done'), promise('done')], [t('Later'), act('later')]];
  if (n.kind === 'keep') return [[t('I got in touch'), act('done')], [t('Later'), act('later')]];
  if (n.kind === 'waiting') return [[t('Not needed'), act('dismiss')], [t('Later'), act('later')]];
  return [[t('Got it'), act('dismiss')]];
}

const KIND_CLASS = { waiting: 'wait', promise: 'promise', 'promise-check': 'check', birthday: 'date', date: 'date', keep: 'keep' };

/** The "Needs attention" list: a row per nudge, most urgent first. */
export function attentionView(items, { openPerson, changed }) {
  const ul = el('ul', 'pt-due');
  for (const n of items) {
    const li = el('li', `pt-due-row k-${KIND_CLASS[n.kind] ?? 'other'}`);
    const who = btn(n.name, 'linkish pt-due-name', () => openPerson?.(n.personId));
    who.setAttribute('aria-label', t('Open {name}', { name: n.name }));
    const text = el('span', 'pt-due-text', nudgeText(n));
    const acts = el('span', 'pt-due-acts');
    for (const [label, call] of answers(n, changed)) acts.append(btn(label, 'ghost small', call));
    li.append(who, text, acts);
    ul.append(li);
  }
  return ul;
}

const CADENCES = [
  [0, () => t('Off')],
  [14, () => t('Every 2 weeks')],
  [30, () => t('Every month')],
  [90, () => t('Every 3 months')],
  [182, () => t('Every 6 months')],
  [365, () => t('Every year')],
];
const CHANNEL_WORD = {
  'mail:in': () => t('Mail from them'),
  'mail:out': () => t('Mail you sent'),
  'chat:in': () => t('Their message in a chat room'),
  'chat:out': () => t('Your reply in a chat room'),
  'meeting:met': () => t('Last meeting'),
  'meeting:next': () => t('Next meeting'),
};
const STATUS_WORD = { proposed: () => t('to confirm'), open: () => t('open'), done: () => t('done') };

/** On a person's card: last contact per channel, keep in touch, addresses, dates and promises. */
export function tiesSection(p, ties, reload) {
  const sec = el('section', 'ppl-sec pt-ties');
  const h = el('h4', '', t('Keeping in touch'));
  h.append(' ', tip(t('Built from your mail headers, calendars and the chat rooms she keeps up with. No message text is kept, only the promise sentence you confirm.')));
  sec.append(h);
  // Last contact per channel.
  if (ties.contacts.length) {
    const ul = el('ul', 'pt-contacts');
    for (const c of ties.contacts) {
      const word = CHANNEL_WORD[`${c.channel}:${c.dir}`]?.() ?? c.channel;
      const when = c.dir === 'next' ? dayWords(c.at.slice(0, 10)) : agoDays(c.at);
      const li = el('li', 'small');
      li.append(el('span', 'pt-c-word', word), el('span', 'muted', ` · ${when}${c.label ? ` · ${c.label}` : ''}`));
      ul.append(li);
    }
    sec.append(ul);
  } else sec.append(el('p', 'muted small', t('No contact found yet. Add their email address so she can match your mail and meetings.')));
  const save = (body) => tiesApi(`/people/${p.id}/ties`, { method: 'PUT', body }).then(reload);
  // Keep in touch (cadence).
  const keep = el('label', 'pt-field');
  const sel = document.createElement('select');
  sel.id = 'ppl-keep';
  for (const [days, word] of CADENCES) {
    const o = document.createElement('option');
    o.value = String(days);
    o.textContent = word();
    sel.append(o);
  }
  sel.value = String(CADENCES.find(([d]) => d === ties.tie.keepDays)?.[0] ?? (ties.tie.keepDays ? 30 : 0));
  sel.addEventListener('change', () => void save({ keepDays: Number(sel.value) || null }));
  keep.append(el('span', '', t('Keep in touch')), tip(t('She reminds you when this much time passed since your last mail, chat or meeting with them.')), sel);
  // Email addresses.
  const mail = el('label', 'pt-field');
  const inp = document.createElement('input');
  inp.id = 'ppl-emails';
  inp.type = 'text';
  inp.autocomplete = 'off';
  inp.placeholder = t('name@example.com, another@example.com');
  inp.value = ties.tie.emails.join(', ');
  inp.addEventListener('change', () => void save({ emails: inp.value.split(/[,;\s]+/).filter(Boolean) }));
  mail.append(el('span', '', t('Email addresses')), tip(t('Used only to match your mail and meetings with them. She also learns an address when a sender uses their full name.')), inp);
  sec.append(keep, mail);
  // Dates (anniversaries).
  const dates = el('div', 'pt-dates');
  dates.append(el('span', 'pt-sub', t('Dates to remember')), tip(t('Anniversaries and other yearly days. She reminds you a week ahead. The birthday is on the card itself.')));
  const dl = el('ul', 'pt-list');
  ties.tie.dates.forEach((d, i) => {
    const li = el('li', 'small');
    li.append(el('span', '', `${d.label} · ${dayWords(`2000-${d.date.slice(-5)}`).replace(/^\S+\s/, '')}`), btn(t('Remove'), 'ghost small', () => save({ dates: ties.tie.dates.filter((_, j) => j !== i) })));
    dl.append(li);
  });
  const addRow = el('div', 'pt-add');
  const lab = document.createElement('input');
  lab.id = 'ppl-date-label';
  lab.maxLength = 60;
  lab.placeholder = t('e.g. Wedding anniversary');
  lab.setAttribute('aria-label', t('What day'));
  const day = document.createElement('input');
  day.id = 'ppl-date-day';
  day.type = 'date';
  day.setAttribute('aria-label', t('Date'));
  addRow.append(lab, day, btn(t('Add'), 'small', () => (day.value ? save({ dates: [...ties.tie.dates, { label: lab.value || t('Anniversary'), date: day.value }] }) : undefined)));
  dates.append(dl, addRow);
  sec.append(dates);
  // Promises.
  const pr = el('div', 'pt-promises');
  pr.append(el('span', 'pt-sub', t('Promises')), tip(t('What you promised them. Found in your own sent mail and chat replies (you confirm each one first), or added here.')));
  const pl = el('ul', 'pt-list');
  for (const x of ties.promises) {
    const li = el('li', `small pt-p s-${x.status}`);
    li.append(el('span', 'pt-p-text', x.text), el('span', 'muted', `${x.due ? ` · ${dayWords(x.due)}` : ''} · ${STATUS_WORD[x.status]?.() ?? x.status}`));
    const go = (action) => () => tiesApi(`/people/promises/${x.id}`, { method: 'PUT', body: { action } }).then(reload);
    if (x.status === 'proposed') li.append(btn(t('Yes, I promised'), 'ghost small', go('confirm')), btn(t('Not a promise'), 'ghost small', go('dismiss')));
    else if (x.status === 'open') li.append(btn(t('Done'), 'ghost small', go('done')), btn(t('Remove'), 'ghost small', go('dismiss')));
    else li.append(btn(t('Remove'), 'ghost small', go('dismiss')));
    pl.append(li);
  }
  const pAdd = el('div', 'pt-add');
  const what = document.createElement('input');
  what.id = 'ppl-promise-text';
  what.maxLength = 160;
  what.placeholder = t('e.g. Send the slides');
  what.setAttribute('aria-label', t('What you promised'));
  const due = document.createElement('input');
  due.id = 'ppl-promise-due';
  due.type = 'date';
  due.setAttribute('aria-label', t('By when'));
  pAdd.append(what, due, btn(t('Add'), 'small', () => (what.value.trim().length >= 3 ? tiesApi('/people/promises', { method: 'POST', body: { personId: p.id, text: what.value, due: due.value || null } }).then(reload) : undefined)));
  pr.append(pl, pAdd);
  sec.append(pr);
  return sec;
}

/** Today's People tile: the top nudges and a way to the People page. */
export function renderPeopleDueTile(part, tileHead, openPeople) {
  const tile = $('#td-people');
  if (!tile) return;
  tile.hidden = !part?.items?.length;
  if (tile.hidden) return;
  tileHead?.(tile, t('People'));
  const ul = el('ul', 'td-biz pt-tile');
  for (const n of part.items) {
    const li = el('li', `small pt-tile-row k-${KIND_CLASS[n.kind] ?? 'other'}`);
    li.append(el('span', '', nudgeText(n)));
    ul.append(li);
  }
  if (part.more) ul.append(el('li', 'small muted', t('and {n} more', { n: part.more })));
  tile.querySelector('.td-body').replaceChildren(ul, btn(t('Open People'), 'ghost small', () => openPeople?.()));
}
