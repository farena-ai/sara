// N6 (docs/WHAT_SARA_KNOWS.md): Settings → You → What Sara knows. What she keeps about the person's
// world, grouped (people and family, home, vehicles, health, work, money, dates), each fact with its
// source (a chat, or a Library document and page), when she learned it and how (said or read), with
// Edit, Delete and Not true. Dates found in documents wait as cards ("From your documents"): Accept
// adds a reminder. "Ask your documents" answers from every Library file with checked quotes.
// W1.1 (docs/design/W1KNOW.md): the one "What I know about you" page: search, topics with ages,
// "Why do you think that?" (the source message), "That's wrong" and "Forget" with Undo on the action
// timeline, duplicate merge suggestions and counts of what else she keeps.
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
// W0.6 units (days < 14, weeks < 8, months < 24, then years) in the page's own language.
export function ageText(days) {
  if (typeof days !== 'number' || days < 0) return '';
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto' });
  if (days < 14) return rtf.format(-days, 'day');
  if (days < 56) return rtf.format(-Math.floor(days / 7), 'week');
  if (days < 730) return rtf.format(-Math.max(2, Math.floor(days / 30.44)), 'month');
  return rtf.format(-Math.floor(days / 365.25), 'year');
}
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
  const age = ageText(f.ageDays);
  if (age) line.append(` (${age})`);
  if (f.quote) line.append(el('q', 'wsk-quote', f.quote));
  return line;
}

async function act(path, opts, status) {
  try {
    const r = await api(path, opts);
    if (status) say(status, r?.timelineId);
  } catch (e) {
    say(e.message);
  }
  void loadFacts();
}

// The status line under the list; a change with a timeline row gets an Undo button.
function say(text, timelineId) {
  const out = $('#wsk-status');
  if (!out) return;
  if (!timelineId) {
    out.textContent = text;
    return;
  }
  const box = el('span', 'kn-undo');
  box.append(el('span', '', text), btn(t('Undo'), 'ghost small', async () => {
    try {
      await api(`/timeline/${timelineId}/revert`, { method: 'POST', body: {} });
      out.textContent = t('Undone.');
    } catch (e) {
      out.textContent = e.message;
    }
    void loadFacts();
  }));
  out.replaceChildren(box);
}

// "Why do you think that?": the words it came from, opened under the fact.
async function showWhy(f, li, b) {
  const open = li.querySelector('.kn-why');
  if (open) {
    open.remove();
    b.setAttribute('aria-expanded', 'false');
    return;
  }
  const box = el('div', 'kn-why small');
  b.setAttribute('aria-expanded', 'true');
  li.append(box);
  box.append(el('span', 'muted', t('Looking…')));
  try {
    const w = await api(`/facts/${f.id}/why`);
    const parts = [];
    if (w.kind === 'chat' && w.message) {
      const when = new Date(w.message.at);
      parts.push(el('span', 'muted', t('You said, {when}:', { when: Number.isNaN(when.getTime()) ? day(w.learnedOn) : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })));
      parts.push(el('blockquote', 'kn-said', w.message.text));
      parts.push(btn(t('Open it in the chat'), 'linkish small', () => {
        closeSettings();
        hooks.jumpTo?.(w.conversationId, w.messageId);
      }));
    } else if (w.kind === 'chat') parts.push(el('span', 'muted', w.gone ? t('The message it came from was forgotten, so it isn’t shown.') : t('The message it came from is no longer there.')));
    else if (w.kind === 'document' && w.docId) {
      parts.push(el('span', 'muted', t('She read it in:')), docLink(w.docId, w.name ?? t('a document'), w.page));
      if (w.quote) parts.push(el('q', 'wsk-quote', w.quote));
    } else parts.push(el('span', 'muted', t('You added it yourself.')));
    box.replaceChildren(...parts);
  } catch (e) {
    box.replaceChildren(el('span', 'muted', e.message));
  }
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
  const wrong = btn(t('That’s wrong'), 'ghost small', () => {
    const box = el('input', 'wsk-edit');
    box.value = f.edited || !f.label ? f.text : `${f.label}: ${f.value}`;
    box.maxLength = 500;
    box.setAttribute('aria-label', t('Edit this fact'));
    const save = btn(t('Save'), 'small', () => void act(`/facts/${f.id}/wrong`, { method: 'POST', body: { text: box.value } }, t('Fixed.')));
    const cancel = btn(t('Cancel'), 'ghost small', () => void loadFacts());
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save.click();
      }
    });
    acts.replaceChildren(box, save, cancel);
    box.focus();
  });
  wrong.title = t('Correct it: she uses your words from now on.');
  const forget = btn(t('Forget'), 'ghost small', () => void act(`/facts/${f.id}/forget`, { method: 'POST', body: {} }, t('Forgotten.')));
  forget.title = t('She stops knowing and using it. Undo brings it back.');
  const notTrue = btn(t('Not true'), 'ghost small', () => void act(`/facts/${f.id}/not-true`, { method: 'POST', body: {} }, t('Forgotten. She won’t learn it again from the same words.')));
  notTrue.title = t('Forget it for good: she won’t learn it again from the same words.');
  acts.append(wrong, forget, notTrue);
  if (f.why) {
    const why = btn(t('Why do you think that?'), 'linkish small', () => void showWhy(f, li, why));
    why.setAttribute('aria-expanded', 'false');
    acts.append(why);
  }
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

// What else she keeps, as counts with a way there (health only says it is kept private).
const ALSO = () => ({
  people: (n) => t('People cards: {n}', { n }),
  notes: (n) => t('Notes from your chats: {n}', { n }),
  style: (n) => t('How you like to work: {n}', { n }),
  renewals: (n) => t('Renewals: {n}', { n }),
  purchases: (n) => t('Purchases: {n}', { n }),
  skills: (n) => t('Learned skills: {n}', { n }),
  health: () => t('Health log: kept private'),
});
function alsoStrip(also) {
  const host = $('#kn-also');
  if (!host) return;
  const words = ALSO();
  const chips = [];
  for (const a of also ?? []) {
    if (a.count === 0 || !words[a.id]) continue;
    const chip = el('span', 'kn-chip small');
    chip.dataset.also = a.id;
    chip.append(el('span', '', words[a.id](a.count)));
    if (a.open) {
      chip.append(btn(t('Open'), 'linkish small', () => {
        if (!a.open.startsWith('#view=settings:')) closeSettings();
        location.hash = a.open;
      }));
    } else chip.append(btn(t('Show'), 'linkish small', () => $('#rnw-box')?.scrollIntoView({ block: 'start', behavior: 'smooth' })));
    chips.push(chip);
  }
  host.hidden = !chips.length;
  host.replaceChildren(...(chips.length ? [el('span', 'muted small', t('She also keeps:')), ...chips] : []));
}

function dupBox(dups) {
  const host = $('#kn-dups');
  if (!host) return;
  host.hidden = !dups?.length;
  if (!dups?.length) return host.replaceChildren();
  const rows = dups.map((d) => {
    const row = el('div', 'kn-dup');
    row.append(el('span', 'small', d.keep.text), el('span', 'muted small', d.drop.text));
    const acts = el('div', 'wsk-acts');
    const merge = btn(t('Merge'), 'small', () => void act('/facts/merge', { method: 'POST', body: { keep: d.keep.id, drop: d.drop.id } }, t('Merged. She keeps the newer one.')));
    merge.title = t('Keeps the newer one; the older one stays on the Memory page as replaced.');
    acts.append(merge, btn(t('Keep both'), 'ghost small', () => void act('/facts/keep-both', { method: 'POST', body: { a: d.keep.id, b: d.drop.id } }, t('She won’t ask about these two again.'))));
    row.append(acts);
    return row;
  });
  host.replaceChildren(el('strong', 'small', t('These look like the same thing ({n})', { n: dups.length })), ...rows);
}

export async function loadFacts() {
  const host = $('#wsk-list');
  if (!host) return;
  const q = ($('#kn-q')?.value ?? '').trim();
  let r;
  let k;
  try {
    [r, k] = await Promise.all([api('/facts'), api(`/facts/know${q ? `?q=${encodeURIComponent(q)}` : ''}`)]);
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
  alsoStrip(k.also);
  dupBox(k.duplicates);
  if (!k.total) {
    host.replaceChildren(el('p', 'muted small', q ? t('Nothing she knows matches that.') : t('Nothing yet. Tell her about your world, or add your lease, policies and warranties to the Library: what she finds shows up here with where it came from.')));
    return;
  }
  const names = GROUPS();
  const parts = [];
  for (const g of k.topics) {
    const sec = el('section', 'wsk-group');
    sec.dataset.group = g.id;
    sec.append(el('h4', '', `${names[g.id] ?? g.id} (${g.items.length})`));
    const ul = el('ul', 'wsk-facts');
    ul.append(...g.items.map(factRow));
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
let searchTimer = 0;
globalThis.document?.addEventListener('input', (e) => {
  if (e.target?.id !== 'kn-q') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadFacts(), 250);
});
globalThis.document?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target?.id === 'wsk-ask') {
    e.preventDefault();
    void askDocs();
  }
});
