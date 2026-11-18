// N6 (docs/WHAT_SARA_KNOWS.md): Settings → You → What Sara knows. What she keeps about the person's
// world, grouped (people and family, home, vehicles, health, work, money, dates), each fact with its
// source (a chat, or a Library document and page), when she learned it and how (said or read), with
// Edit, Delete and Not true. Dates found in documents wait as cards ("From your documents"): Accept
// adds a reminder. "Ask your documents" answers from every Library file with checked quotes.
import { t } from './naming.js';
import { api } from './setup-card.js';
import { initRenewals, loadRenewals } from './renewals.js';

const $ = (sel) => document.querySelector(sel);
let hooks = {};
export function initFacts(h) {
  hooks = h ?? {};
  initRenewals(hooks);
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

const GROUPS = () => ({ people: t('People and family'), home: t('Home'), vehicles: t('Vehicles'), health: t('Health'), work: t('Work'), money: t('Money'), dates: t('Dates'), other: t('Other') });
// Labels of facts read in documents (the server sends the English key).
const LABELS = () => ({
  'Policy number': t('Policy number'), 'Account number': t('Account number'), 'Member ID': t('Member ID'), 'Group number': t('Group number'), 'Passport number': t('Passport number'), 'License number': t('License number'), 'Loan number': t('Loan number'), 'Contract number': t('Contract number'), 'Serial number': t('Serial number'), VIN: 'VIN',
  Deductible: t('Deductible'), 'Out-of-pocket maximum': t('Out-of-pocket maximum'), Premium: t('Premium'), Copay: t('Copay'), 'Security deposit': t('Security deposit'), Rent: t('Rent'), 'Coverage limit': t('Coverage limit'),
  Insured: t('Insured'), Tenant: t('Tenant'), Landlord: t('Landlord'), 'Insurer or agent': t('Insurer or agent'),
  'Renewal date': t('Renewal date'), Expires: t('Expires'), 'Due date': t('Due date'), 'Lease ends': t('Lease ends'), 'Warranty ends': t('Warranty ends'), 'Passport expires': t('Passport expires'), 'License expires': t('License expires'),
});
const day = (iso) => {
  if (!iso) return '';
  const full = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(full ? `${iso}T12:00:00` : `2000-${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, full ? { year: 'numeric', month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric' });
};
const textOf = (f) => (f.label && !f.edited ? `${LABELS()[f.label] ?? f.label}: ${f.date ? day(f.date) : f.value}` : f.date && !f.label ? `${f.text} (${day(f.date)})` : f.text);
const closeSettings = () => {
  const st = document.querySelector('#settings');
  if (st?.open) st.close();
};
function docLink(docId, name, page) {
  const a = el('a', 'wsk-link', page ? `${name}, ${t('p. {n}', { n: page })}` : name);
  a.href = page ? `/#view=library:${docId}:${page}` : `/#view=library:${docId}`;
  a.addEventListener('click', closeSettings);
  return a;
}

function sourceLine(f) {
  const line = el('div', 'wsk-src muted small');
  const how = el('span', `wsk-how ${f.confidence}`, f.confidence === 'said' ? t('You said it') : t('Read in a document'));
  line.append(how, ' · ');
  const s = f.source ?? {};
  if (s.kind === 'document' && s.docId) line.append(docLink(s.docId, s.name ?? t('a document'), s.page));
  else if (s.kind === 'chat' && s.conversationId) {
    const b = btn(s.title || t('the chat'), 'linkish small wsk-link', () => {
      closeSettings();
      hooks.jumpTo?.(s.conversationId, s.messageId);
    });
    line.append(b);
  } else line.append(t('You added it'));
  line.append(` · ${t('Learned {day}', { day: day(f.learnedOn) })}`);
  if (f.quote) line.append(el('q', 'wsk-quote', f.quote));
  return line;
}

async function act(path, opts, status) {
  try {
    await api(path, opts);
    if (status) $('#wsk-status').textContent = status;
  } catch (e) {
    $('#wsk-status').textContent = e.message;
  }
  void loadFacts();
}

function factRow(f) {
  const li = el('li', 'wsk-fact');
  li.dataset.id = f.id;
  const head = el('div', 'wsk-text');
  head.append(el('span', '', textOf(f)));
  if (f.private) {
    const p = el('span', 'wsk-private small', t('Private'));
    p.title = t('Health facts, a passport and anything from a private chat are used only in private chats or when you ask about them.');
    head.append(p);
  }
  li.append(head, sourceLine(f));
  const acts = el('div', 'wsk-acts');
  acts.append(
    btn(t('Edit'), 'ghost small', () => {
      const box = el('input', 'wsk-edit');
      box.value = f.edited || !f.label ? f.text : `${f.label}: ${f.value}`;
      box.maxLength = 500;
      box.setAttribute('aria-label', t('Edit this fact'));
      const save = btn(t('Save'), 'small', () => void act(`/facts/${f.id}`, { method: 'PATCH', body: { text: box.value } }, t('Saved.')));
      const cancel = btn(t('Cancel'), 'ghost small', () => void loadFacts());
      acts.replaceChildren(box, save, cancel);
      box.focus();
    }),
    btn(t('Not true'), 'ghost small', () => void act(`/facts/${f.id}/not-true`, { method: 'POST', body: {} }, t('Forgotten. She won’t learn it again from the same words.'))),
    btn(t('Delete'), 'ghost small', () => void act(`/facts/${f.id}`, { method: 'DELETE' }, t('Deleted.'))),
  );
  if (f.detail) {
    const add = btn(t('Add to My details'), 'ghost small', () => {
      location.hash = '#view=settings:you-details';
    });
    add.title = t('Opens My details: type the full number there yourself (Sara keeps only the last 4 here).');
    acts.append(add);
  }
  li.append(acts);
  return li;
}

/** A "From your documents" card (this page and the Today tile). */
export function dateCard(s, done = loadFacts) {
  const li = el('li', 'ih-card wsk-card');
  const head = el('div', 'ih-head');
  head.append(el('span', 'ih-kind', t('Document')), el('span', 'ih-main', `${LABELS()[s.label] ?? s.label}: ${day(s.date)}`));
  li.append(head);
  const sub = el('div', 'ih-from muted small');
  sub.append(docLink(s.docId, s.name, s.page));
  li.append(sub);
  if (s.quote) li.append(el('q', 'wsk-quote small', s.quote));
  const acts = el('div', 'ih-acts');
  const go = async (path) => {
    try {
      await api(path, { method: 'POST', body: {} });
    } catch (e) {
      sub.textContent = e.message;
    }
    void done();
  };
  const accept = btn(t('Remind me {n} days before', { n: s.daysBefore }), 'small ih-accept', () => void go(`/facts/suggestions/${s.id}/accept`));
  acts.append(accept, btn(t('Not now'), 'ghost small', () => void go(`/facts/suggestions/${s.id}/dismiss`)));
  li.append(acts);
  return li;
}

export async function loadFacts() {
  const host = $('#wsk-list');
  if (!host) return;
  let r;
  try {
    r = await api('/facts');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  void loadRenewals();
  const sug = $('#wsk-suggest');
  if (sug) {
    // V2.1: renewal and expiry dates are in Renewals and paperwork on this page; due dates stay here.
    const due = $('#rnw-list') ? r.suggestions.filter((s) => s.dateKind === 'due') : r.suggestions;
    sug.hidden = !due.length;
    const list = el('ul', 'ih-cards');
    list.append(...due.map((s) => dateCard(s)));
    $('#wsk-suggest-list').replaceChildren(list);
  }
  if (!r.facts.length) {
    host.replaceChildren(el('p', 'muted small', t('Nothing yet. Tell her about your world, or add your lease, policies and warranties to the Library: what she finds shows up here with where it came from.')));
    return;
  }
  const names = GROUPS();
  const parts = [];
  for (const g of r.groups) {
    const facts = r.facts.filter((f) => f.group === g);
    if (!facts.length) continue;
    const sec = el('section', 'wsk-group');
    sec.dataset.group = g;
    sec.append(el('h4', '', `${names[g] ?? g} (${facts.length})`));
    const ul = el('ul', 'wsk-facts');
    ul.append(...facts.map(factRow));
    sec.append(ul);
    parts.push(sec);
  }
  host.replaceChildren(...parts);
}

export async function askDocs() {
  const q = ($('#wsk-ask')?.value ?? '').trim();
  const out = $('#wsk-answer');
  if (!q || !out) return;
  out.replaceChildren(el('p', 'muted small', t('Looking in your documents…')));
  try {
    const r = await api('/facts/ask', { method: 'POST', body: { question: q } });
    if (!r.found) {
      out.replaceChildren(el('p', 'small', t('Not found in your documents.')));
      return;
    }
    const ul = el('ul', 'wsk-answers');
    for (const x of r.quotes) {
      const li = el('li', 'small');
      li.append(el('q', 'wsk-quote', x.quote), ' ', docLink(x.docId, x.name, x.page));
      ul.append(li);
    }
    out.replaceChildren(ul);
  } catch (e) {
    out.replaceChildren(el('p', 'muted small', e.message));
  }
}

globalThis.document?.addEventListener('click', (e) => {
  if (e.target?.closest?.('#wsk-ask-go')) void askDocs();
});
globalThis.document?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target?.id === 'wsk-ask') {
    e.preventDefault();
    void askDocs();
  }
});
