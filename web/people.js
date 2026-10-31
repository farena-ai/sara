// Phase 101 (ST6, docs/design/STAPLES.md §9.7, docs/PEOPLE.md): Memory → People. A grid of person
// cards (photo or initials, name, who they are to you, last mentioned, birthday), search and circle
// filters, the review of people she proposes (the shared proposal card: Looks right / Merge with… /
// Not a person / Forget), and a person's card: who they are (editable), what she knows by date with
// the source of each fact, people linked, the sensitive group folded (count only until opened), his
// notes, Merge, Split, Forget. On a phone the card is a full screen. Every value from the server is
// set as text: nothing a card says ever becomes markup.
import { serverText, t } from './naming.js';
import { proposalCard } from './proposal-card.js';
import { emptyState } from './tidy.js';

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
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onClick(b, e);
  });
  return b;
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

export const CIRCLES = ['family', 'partner', 'friend', 'work', 'neighbour', 'other'];
const CIRCLE_WORD = { family: () => t('Family'), partner: () => t('Partner'), friend: () => t('Friends'), work: () => t('Work'), neighbour: () => t('Neighbours'), other: () => t('Other') };
const CIRCLE_ONE = { family: () => t('family'), partner: () => t('partner'), friend: () => t('friend'), work: () => t('work'), neighbour: () => t('neighbour'), other: () => t('other') };
const CATEGORY_WORD = { health: () => t('health'), intimate: () => t('intimate'), money: () => t('money'), legal: () => t('legal') };

let ctx = null;
const st = { list: [], counts: { proposed: 0, active: 0 }, backfill: null, notes: 0, filter: 'all', q: '', open: null, sensitive: false, editing: false, splitting: null, timer: 0, poll: 0, laterReview: false };

// ---------------- pure helpers (tested in Node) ----------------

/** "Jamie Lee" → "JL", "Ana" → "A" (two letters at most). */
export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const last = parts.length > 1 ? ([...parts.at(-1)][0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}
/** Days from `today` (YYYY-MM-DD) to the next MM-DD of a birthday (0 = today), or null. */
export function daysToBirthday(birthday, today) {
  const m = /(\d{2})-(\d{2})$/.exec(String(birthday ?? ''));
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today ?? ''));
  if (!m || !d) return null;
  const base = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  for (const y of [Number(d[1]), Number(d[1]) + 1]) {
    const at = Date.UTC(y, Number(m[1]) - 1, Number(m[2]));
    if (at >= base) return Math.round((at - base) / 86_400_000);
  }
  return null;
}
/** "today", "yesterday", "3 days ago", "2 weeks ago", "4 months ago". */
export function agoWords(iso, now = Date.now()) {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  if (days < 14) return t('{n} days ago', { n: days });
  if (days < 60) return t('{n} weeks ago', { n: Math.round(days / 7) });
  if (days < 730) return t('{n} months ago', { n: Math.round(days / 30) });
  return t('{n} years ago', { n: Math.round(days / 365) });
}
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function fmtDay(iso) {
  const m = /(?:(\d{4})-)?(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return '';
  try {
    return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', ...(m[1] ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(Number(m[1] ?? 2000), Number(m[2]) - 1, Number(m[3]), 12)));
  } catch {
    return iso;
  }
}
const birthdayWords = (b) => {
  const n = daysToBirthday(b, localDay());
  if (n === null) return '';
  return n === 0 ? t('birthday today') : n === 1 ? t('birthday tomorrow') : n <= 60 ? t('birthday in {n} days', { n }) : t('birthday {date}', { date: fmtDay(b) });
};

// ---------------- the avatar ----------------

function avatar(p, big = false) {
  const box = el('span', `ppl-av c-${p.circle}${big ? ' big' : ''}`);
  box.setAttribute('aria-hidden', 'true');
  if (p.photo) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/people/${p.id}/photo?v=${encodeURIComponent(p.updatedAt)}`;
    img.addEventListener('error', () => img.replaceWith(el('span', 'ppl-ini', initials(p.name))));
    box.append(img);
  } else box.append(el('span', 'ppl-ini', initials(p.name)));
  return box;
}

// ---------------- loading ----------------

function showErr(err) {
  $('#ppl-status').textContent = err?.message ?? String(err);
}

export async function loadPeople() {
  if (!$('#ppl-list')) return;
  try {
    const q = st.q.trim();
    const filter = st.filter;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (CIRCLES.includes(filter)) params.set('circle', filter);
    if (filter === 'proposed') params.set('status', 'proposed');
    const d = await api(`/people${params.size ? `?${params}` : ''}`);
    st.list = d.people;
    st.counts = d.counts;
    st.backfill = d.backfill;
    st.notes = d.notes;
    renderCount();
    renderReview();
    renderCircles();
    renderList();
    if (st.backfill?.state === 'running') pollBackfill();
  } catch (err) {
    if (err.status === 404) {
      $('#ppl-list').replaceChildren(emptyState('👥', t('People cards are not available here.')));
      return;
    }
    showErr(err);
  }
}

function renderCount() {
  const n = st.counts.proposed;
  const c = $('#ppl-tab-count');
  if (!c) return;
  c.hidden = !n;
  c.textContent = n ? String(n) : '';
  c.title = n ? t('{n} to check', { n }) : '';
}

function renderCircles() {
  const box = $('#ppl-circles');
  const chip = (id, label) => {
    const b = btn(label, `ppl-chip${st.filter === id ? ' on' : ''}`, () => {
      st.filter = id;
      void loadPeople();
    });
    b.setAttribute('aria-pressed', st.filter === id ? 'true' : 'false');
    return b;
  };
  box.replaceChildren(chip('all', t('Everyone')), ...CIRCLES.map((c) => chip(c, CIRCLE_WORD[c]())), ...(st.counts.proposed || st.filter === 'proposed' ? [chip('proposed', t('To check ({n})', { n: st.counts.proposed }))] : []));
}

/** The banner at the top: the backfill offer, its progress, or "I found N people… Check them?". */
function renderReview() {
  const box = $('#ppl-review');
  const b = st.backfill;
  const out = [];
  if (b?.state === 'running') {
    const bar = el('div', 'ppl-progress');
    const fill = el('span', 'ppl-progress-fill');
    fill.dataset.pct = String(Math.round((100 * b.done) / Math.max(1, b.total)));
    bar.append(fill);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuenow', fill.dataset.pct);
    out.push(proposalCard({ title: t('Looking for people in what I remember…'), why: [t('{done} of {total} notes read', { done: b.done, total: b.total })], body: [bar] }));
  } else if (st.counts.proposed && st.filter !== 'proposed' && !st.laterReview) {
    const n = st.counts.proposed;
    out.push(
      proposalCard({
        title: b?.state === 'done' && b.proposed ? t('I found {n} people in what I remember. Check them?', { n: b.proposed }) : t('{n} people to check', { n }),
        why: [t('Nothing about them is used until you say it looks right (or you mention them in three conversations).')],
        buttons: [
          { label: t('Check them'), onClick: () => ((st.filter = 'proposed'), void loadPeople()) },
          { label: t('Not now'), cls: 'ghost', onClick: () => ((st.laterReview = true), renderReview()) },
        ],
      }),
    );
  } else if ((!b || b.state === 'never') && st.notes >= 5 && !st.counts.active && !st.counts.proposed) {
    out.push(
      proposalCard({
        title: t('Find the people in what I remember?'),
        why: [t('I have {n} notes about your life. I can read them once and suggest a card for each person in them.', { n: st.notes })],
        buttons: [
          { label: t('Look now'), onClick: startBackfill },
          { label: t('Not now'), cls: 'ghost', onClick: () => box.replaceChildren() },
        ],
      }),
    );
  }
  box.replaceChildren(...out);
  $('#ppl-backfill').hidden = b?.state === 'running' || b?.state === 'done';
  $('#ppl-tip-backfill').hidden = $('#ppl-backfill').hidden;
}

async function startBackfill() {
  try {
    st.backfill = await api('/people/backfill', { method: 'POST', body: {} });
    renderReview();
    pollBackfill();
  } catch (err) {
    showErr(err);
  }
}
function pollBackfill() {
  clearTimeout(st.poll);
  st.poll = setTimeout(async () => {
    try {
      const b = await api('/people/backfill');
      st.backfill = b;
      if (b.state === 'running') {
        renderReview();
        pollBackfill();
      } else void loadPeople();
    } catch {
      /* the next open tries again */
    }
  }, 1500);
}

function renderList() {
  const list = $('#ppl-list');
  if (!st.list.length) {
    const q = st.q.trim();
    list.replaceChildren(emptyState('👥', q ? t('Nobody matches “{q}”.', { q }) : st.filter === 'proposed' ? t('Nothing to check right now.') : t('No people yet.'), 'div', q || st.filter !== 'all' ? '' : t('As you talk about the people in your life, she suggests a card for each. You can also add one.')));
    list.classList.remove('ppl-review-mode');
    return;
  }
  const review = st.filter === 'proposed';
  list.classList.toggle('ppl-review-mode', review);
  list.replaceChildren(...st.list.map((p) => (review && p.status === 'proposed' ? proposedCard(p) : tile(p))));
}

function tile(p) {
  const b = el('button', 'ppl-tile');
  b.type = 'button';
  b.setAttribute('aria-label', t('Open {name}', { name: p.name }));
  const mid = el('span', 'ppl-tile-mid');
  const top = el('span', 'ppl-tile-top');
  top.append(el('span', 'ppl-name', p.name));
  if (p.status === 'proposed') top.append(el('span', 'ppl-badge check', t('to check')));
  else if (p.origin === 'her') top.append(el('span', 'ppl-badge her', t('added on her own')));
  mid.append(top);
  if (p.relation) mid.append(el('span', 'ppl-rel', p.relation));
  const sub = [p.lastMentioned ? t('mentioned {when}', { when: agoWords(p.lastMentioned) }) : '', p.birthday ? birthdayWords(p.birthday) : ''].filter(Boolean);
  if (sub.length) mid.append(el('span', 'ppl-sub', sub.join(' · ')));
  b.append(avatar(p), mid);
  b.addEventListener('click', () => void openPerson(p.id));
  return b;
}

/** A person she proposes (STAPLES §9.3 review): name, relation, three facts with sources, the four answers. */
function proposedCard(p) {
  const facts = el('ul', 'ppl-facts compact');
  for (const f of p.preview ?? []) facts.append(factRow(f, { compact: true }));
  const why = [p.conversations ? (p.conversations === 1 ? t('Mentioned in 1 conversation') : t('Mentioned in {n} conversations', { n: p.conversations })) : '', p.factCount === 1 ? t('1 thing she knows') : t('{n} things she knows', { n: p.factCount })].filter(Boolean);
  const card = proposalCard({
    title: p.name,
    source: p.origin === 'her' ? t('added on her own') : t('from what she remembers'),
    chips: [...(p.relation ? [{ text: p.relation }] : []), { text: CIRCLE_ONE[p.circle]?.() ?? p.circle, cls: `ppl-circle c-${p.circle}` }],
    why: [why.join(' · ')],
    body: [facts],
    buttons: [
      { label: t('Looks right'), onClick: async (b) => act(b, () => api(`/people/${p.id}/accept`, { method: 'POST', body: {} })) },
      { label: t('Merge with…'), cls: 'ghost', onClick: (b) => mergePicker(p, b) },
      { label: t('Not a person'), cls: 'ghost', onClick: async (b) => act(b, () => api(`/people/${p.id}/reject`, { method: 'POST', body: {} })) },
      { label: t('Forget'), cls: 'ghost danger', onClick: () => forgetDialog(p) },
    ],
  });
  card.classList.add('ppl-prop');
  card.querySelector('.prop-head')?.prepend(avatar(p));
  return card;
}

async function act(b, fn) {
  if (b) b.disabled = true;
  try {
    await fn();
    await loadPeople();
    if (st.open) await openPerson(st.open.person.id, { keep: true });
  } catch (err) {
    showErr(err);
    if (b) b.disabled = false;
  }
}

/** "Merge with…": pick the other card (the one that stays). */
function mergePicker(p, anchor) {
  const others = st.list.filter((x) => x.id !== p.id);
  const box = el('div', 'ppl-merge');
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', t('Merge with'));
  sel.append(new Option(t('Pick the person this is…'), ''));
  // Everyone (not only the current filter): the list is fetched fresh.
  void api('/people').then((d) => {
    for (const o of d.people.filter((x) => x.id !== p.id)) sel.append(new Option(`${o.name}${o.relation ? ` (${o.relation})` : ''}`, String(o.id)));
  }).catch(() => {
    for (const o of others) sel.append(new Option(o.name, String(o.id)));
  });
  box.append(
    el('span', 'small', t('Same person as:')),
    sel,
    btn(t('Merge'), '', async (b) => {
      if (!sel.value) return sel.focus();
      await act(b, () => api(`/people/${p.id}/merge`, { method: 'POST', body: { into: Number(sel.value) } }));
      if (st.open?.person.id === p.id) await openPerson(Number(sel.value));
    }),
    btn(t('Cancel'), 'ghost', () => box.remove()),
  );
  (anchor?.closest('.prop-card, .ppl-card-actions') ?? $('#ppl-list')).after(box);
  sel.focus();
}

/** "Forget this person": the card, its facts and links; ticked, the memories they came from too. */
function forgetDialog(p) {
  const d = document.createElement('dialog');
  d.className = 'ppl-forget';
  const f = el('form', 'settings-body');
  f.method = 'dialog';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'ppl-forget-mem';
  const lab = el('label', 'row');
  lab.append(box, el('span', '', t('Also forget the memories they came from (and hide those messages from her)')));
  const go = btn(t('Forget {name}', { name: p.name }), 'danger', async (b) => {
    b.disabled = true;
    try {
      await api(`/people/${p.id}${box.checked ? '?memories=1' : ''}`, { method: 'DELETE' });
      d.close();
      closeCard();
      await loadPeople();
    } catch (err) {
      showErr(err);
      b.disabled = false;
    }
  });
  const actions = el('div', 'actions');
  actions.append(btn(t('Cancel'), 'ghost', () => d.close()), go);
  f.append(el('h3', '', t('Forget {name}?', { name: p.name })), el('p', 'small', t('Her card for {name} goes for good: what she knows, the links, the photo. Without the box ticked, she still has her plain notes.', { name: p.name })), lab, actions);
  d.append(f);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

// ---------------- a person's card ----------------

function factRow(f, opts = {}) {
  const li = el('li', `ppl-fact${f.pending ? ' pending' : ''}${f.private ? ' private' : ''}`);
  const head = el('div', 'ppl-fact-head');
  head.append(el('span', 'ppl-fact-day', fmtDay(f.happenedOn)));
  if (f.private) {
    const lock = el('span', 'ppl-lock');
    lock.title = t('Private: only in private conversations');
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', t('Private'));
    head.append(lock);
  }
  if (f.category) head.append(el('span', 'ppl-badge sens', CATEGORY_WORD[f.category]?.() ?? f.category));
  if (f.edited) head.append(el('span', 'ppl-fact-meta', t('edited')));
  li.append(head);
  const body = el('p', 'ppl-fact-text', f.content);
  body.dataset.raw = '';
  li.append(body);
  if (f.source && ctx?.jumpTo) {
    // The owner's own words when she kept them (the fact's evidence), else the conversation's title.
    const said = f.evidence && !f.folded ? String(f.evidence).replace(/\s+/g, ' ').trim() : '';
    const label = said ? (said.length > 70 ? `${said.slice(0, 69).trimEnd()}…` : said) : f.source.title ?? t('a conversation');
    const a = el('a', 'ppl-src', t('from “{title}”', { title: label }));
    a.href = '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      ctx.jumpTo(f.source.conversationId, f.source.messageId);
    });
    li.append(a);
  } else if (!opts.compact && !f.source) li.append(el('span', 'ppl-src muted', f.memoryKind ? t('from a note') : t('you added this')));
  if (opts.compact) return li;
  const row = el('div', 'ppl-fact-actions');
  if (f.pending) row.append(btn(t('Yes, this is about them'), 'small', (b) => act(b, () => api(`/person-facts/${f.id}`, { method: 'PUT', body: { resolve: true } }))));
  row.append(
    btn(t('Correct'), 'ghost small', () => editFact(li, f)),
    btn(f.private ? t('Not private') : t('Private'), 'ghost small', (b) => act(b, () => api(`/person-facts/${f.id}`, { method: 'PUT', body: { private: !f.private } }))),
    btn(t('Take off the card'), 'ghost small', (b) => act(b, () => api(`/person-facts/${f.id}`, { method: 'DELETE' }))),
  );
  if (st.splitting) {
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'ppl-split-pick';
    pick.checked = st.splitting.has(f.id);
    pick.setAttribute('aria-label', t('Move to the new card'));
    pick.addEventListener('change', () => (pick.checked ? st.splitting.add(f.id) : st.splitting.delete(f.id)));
    li.prepend(pick);
  }
  li.append(row);
  return li;
}

function editFact(li, f) {
  const area = document.createElement('textarea');
  area.value = f.content;
  area.rows = 3;
  area.setAttribute('aria-label', t('Correct what she knows'));
  const row = el('div', 'ppl-fact-actions');
  row.append(
    btn(t('Save'), 'small', (b) => act(b, () => api(`/person-facts/${f.id}`, { method: 'PUT', body: { content: area.value } }))),
    btn(t('Cancel'), 'ghost small', () => void openPerson(f.personId, { keep: true })),
  );
  li.replaceChildren(area, el('p', 'muted small', t('This corrects her memory too (the note it came from).')), row);
  area.focus();
}

export async function openPerson(id, opts = {}) {
  try {
    const d = await api(`/people/${id}${opts.sensitive || (opts.keep && st.sensitive) ? '?sensitive=1' : ''}`);
    if (!opts.keep) {
      st.sensitive = Boolean(opts.sensitive);
      st.editing = false;
      st.splitting = null;
    }
    st.open = d;
    renderCard();
  } catch (err) {
    showErr(err);
  }
}

function closeCard() {
  st.open = null;
  st.splitting = null;
  st.editing = false;
  $('#ppl-card').hidden = true;
  $('#ppl-home').hidden = false;
  document.getElementById('memory')?.classList.remove('ppl-full');
}

function renderCard() {
  const box = $('#ppl-card');
  const d = st.open;
  if (!d) return closeCard();
  const p = d.person;
  $('#ppl-home').hidden = true;
  box.hidden = false;
  document.getElementById('memory')?.classList.add('ppl-full');
  const back = btn(t('All people'), 'ghost ppl-back', () => {
    closeCard();
    void loadPeople();
  });
  back.prepend(el('span', 'ppl-back-arrow', '‹'));
  // Head: photo or initials, name, who they are, circle, private, added on her own.
  const head = el('header', 'ppl-card-head');
  const av = avatar(p, true);
  const photoBtn = el('label', 'ppl-photo');
  photoBtn.title = p.photo ? t('Change the photo') : t('Add a photo');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/jpeg,image/png,image/webp';
  file.className = 'ppl-file';
  file.setAttribute('aria-label', p.photo ? t('Change the photo') : t('Add a photo'));
  file.addEventListener('change', () => void uploadPhoto(p, file.files?.[0]));
  photoBtn.append(av, file);
  const who = el('div', 'ppl-who');
  const h = el('h3', 'ppl-card-name', p.name);
  who.append(h);
  const chips = el('div', 'ppl-card-chips');
  if (p.relation) chips.append(el('span', 'ppl-chip-static rel', p.relation));
  chips.append(el('span', `ppl-chip-static ppl-circle c-${p.circle}`, CIRCLE_ONE[p.circle]?.() ?? p.circle));
  if (p.status === 'proposed') chips.append(el('span', 'ppl-badge check', t('to check')));
  if (p.origin === 'her') chips.append(el('span', 'ppl-badge her', t('added on her own')));
  if (p.private) chips.append(el('span', 'ppl-badge', t('private')));
  who.append(chips);
  const meta = [p.fullName && p.fullName !== p.name ? p.fullName : '', p.aliases?.length ? t('also {names}', { names: p.aliases.join(', ') }) : '', p.birthday ? birthdayWords(p.birthday) : '', p.lastMentioned ? t('mentioned {when}', { when: agoWords(p.lastMentioned) }) : '', d.conversations ? (d.conversations === 1 ? t('in 1 conversation') : t('in {n} conversations', { n: d.conversations })) : ''].filter(Boolean);
  if (meta.length) who.append(el('p', 'ppl-card-meta', meta.join(' · ')));
  head.append(photoBtn, who);
  const actions = el('div', 'ppl-card-actions');
  if (p.status === 'proposed') actions.append(btn(t('Looks right'), '', (b) => act(b, () => api(`/people/${p.id}/accept`, { method: 'POST', body: {} }))));
  actions.append(
    btn(t('Edit'), 'ghost', () => ((st.editing = !st.editing), renderCard())),
    btn(t('Merge with…'), 'ghost', (b) => mergePicker(p, b)),
    btn(st.splitting ? t('Cancel split') : t('Split…'), 'ghost', () => ((st.splitting = st.splitting ? null : new Set()), renderCard())),
    btn(t('Forget this person'), 'ghost danger', () => forgetDialog(p)),
  );
  if (p.photo) actions.append(btn(t('Remove the photo'), 'ghost', (b) => act(b, () => api(`/people/${p.id}/photo`, { method: 'DELETE' }))));
  const parts = [back, head, actions];
  if (st.editing) parts.push(editForm(p));
  if (st.splitting) parts.push(splitBar(p));
  // What she knows, by date (the sensitive group folded, count only until opened).
  const facts = d.facts.filter((f) => f.supersededBy === null || f.supersededBy === undefined);
  const plain = facts.filter((f) => !f.category);
  const sens = facts.filter((f) => f.category);
  const knows = el('section', 'ppl-sec');
  knows.append(el('h4', '', t('What she knows')));
  if (plain.length) {
    const ul = el('ul', 'ppl-facts');
    for (const f of plain) ul.append(factRow(f));
    knows.append(ul);
  } else knows.append(el('p', 'muted small', t('Nothing yet. When you talk about {name}, she adds it here with where she heard it.', { name: p.name })));
  parts.push(knows);
  if (sens.length) {
    const det = el('details', 'ppl-sec ppl-sens');
    if (st.sensitive) det.open = true;
    const sum = el('summary', '', t('Sensitive ({n})', { n: sens.length }));
    det.append(sum);
    det.addEventListener('toggle', () => {
      if (det.open && !st.sensitive) void openPerson(p.id, { sensitive: true, keep: true }).then(() => (st.sensitive = true, renderCard()));
      if (!det.open && st.sensitive) {
        st.sensitive = false;
        void openPerson(p.id, { keep: true });
      }
    });
    if (st.sensitive) {
      const ul = el('ul', 'ppl-facts');
      for (const f of sens) ul.append(factRow(f));
      det.append(ul);
    } else det.append(el('p', 'muted small', t('Folded for privacy. Open to see them.')));
    parts.push(det);
  }
  // Facts a newer note replaced (the weekly look-back or a later conversation): kept, and can come back.
  const old = d.facts.filter((f) => f.supersededBy !== null && f.supersededBy !== undefined && !f.category);
  if (old.length) {
    const det = el('details', 'ppl-sec ppl-old');
    det.append(el('summary', '', t('Replaced by newer notes ({n})', { n: old.length })));
    const ul = el('ul', 'ppl-facts');
    for (const f of old) {
      const li = factRow(f, { compact: true });
      li.classList.add('replaced');
      if (f.memoryId) li.append(btn(t('Use it again'), 'ghost small', (b) => act(b, () => api(`/memories/${f.memoryId}`, { method: 'PATCH', body: { supersededBy: null } }))));
      ul.append(li);
    }
    det.append(ul);
    parts.push(det);
  }
  // People linked to this one.
  const links = el('section', 'ppl-sec');
  links.append(el('h4', '', t('People linked')));
  const lrow = el('div', 'ppl-links');
  for (const l of d.links) {
    const chip = el('span', 'ppl-link');
    const go = btn(l.name, 'ppl-link-go', () => void openPerson(l.id));
    chip.append(go, el('span', 'ppl-link-rel', l.relation), btn('×', 'ghost ppl-link-x', (b) => act(b, () => api(`/people/${p.id}`, { method: 'PUT', body: { unlink: [l.id] } }))));
    chip.lastChild.setAttribute('aria-label', t('Remove the link to {name}', { name: l.name }));
    lrow.append(chip);
  }
  lrow.append(btn(t('Link someone'), 'ghost small', (b) => linkPicker(p, b)));
  links.append(lrow);
  parts.push(links);
  // Recent mentions.
  if (d.mentions?.length) {
    const sec = el('section', 'ppl-sec');
    sec.append(el('h4', '', t('Recently mentioned')));
    const ul = el('ul', 'ppl-mentions');
    for (const m of d.mentions) {
      const li = el('li');
      const a = el('a', '', m.title ?? t('a conversation'));
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        ctx?.jumpTo?.(m.conversationId, m.messageId);
      });
      li.append(a, el('span', 'muted small', ` · ${agoWords(m.at)}`));
      ul.append(li);
    }
    sec.append(ul);
    parts.push(sec);
  }
  // His notes (never rewritten by her).
  const notes = el('section', 'ppl-sec');
  const nh = el('h4', '', t('Your notes'));
  nh.append(' ', tip(t('Only you write here; she reads it but never changes it. Gift ideas, how you met, anything.')));
  const area = document.createElement('textarea');
  area.id = 'ppl-notes';
  area.rows = 3;
  area.value = p.notes ?? '';
  area.placeholder = t('e.g. likes green tea; met at the climbing gym');
  area.setAttribute('aria-label', t('Your notes'));
  const saved = el('span', 'muted small', '');
  saved.setAttribute('role', 'status');
  const save = btn(t('Save notes'), 'small', async () => {
    try {
      await api(`/people/${p.id}`, { method: 'PUT', body: { notes: area.value } });
      saved.textContent = t('Saved');
    } catch (err) {
      saved.textContent = err.message;
    }
  });
  const nrow = el('div', 'ppl-fact-actions');
  nrow.append(save, saved);
  notes.append(nh, area, nrow);
  parts.push(notes);
  parts.push(el('p', 'muted small ppl-foot', t('These are things about {name}, a real person: you can correct or remove any of them, and Forget removes the card for good.', { name: p.name })));
  box.replaceChildren(...parts);
  box.scrollTop = 0;
  back.focus({ preventScroll: true });
}

function editForm(p) {
  const f = el('div', 'ppl-edit');
  const field = (label, input, help) => {
    const l = el('label', '');
    l.append(el('span', '', label), input);
    if (help) l.append(tip(help));
    return l;
  };
  const inp = (v, max = 80) => {
    const i = document.createElement('input');
    i.value = v ?? '';
    i.maxLength = max;
    return i;
  };
  const name = inp(p.name);
  const full = inp(p.fullName ?? '');
  const aliases = inp((p.aliases ?? []).join(', '), 400);
  const rel = inp(p.relation);
  const circle = document.createElement('select');
  for (const c of CIRCLES) circle.append(new Option(CIRCLE_WORD[c](), c, false, c === p.circle));
  const month = document.createElement('select');
  month.setAttribute('aria-label', t('Birthday month'));
  month.append(new Option('—', ''));
  for (let m = 1; m <= 12; m++) month.append(new Option(new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m - 1, 15))), String(m).padStart(2, '0')));
  const day = document.createElement('select');
  day.setAttribute('aria-label', t('Birthday day'));
  day.append(new Option('—', ''));
  for (let x = 1; x <= 31; x++) day.append(new Option(String(x), String(x).padStart(2, '0')));
  const bm = /(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(p.birthday ?? '');
  if (bm) {
    month.value = bm[2];
    day.value = bm[3];
  }
  const year = inp(bm?.[1] ?? '', 4);
  year.inputMode = 'numeric';
  year.placeholder = t('year (optional)');
  year.setAttribute('aria-label', t('Birthday year'));
  const bday = el('div', 'ppl-bday');
  bday.append(month, day, year);
  const priv = document.createElement('input');
  priv.type = 'checkbox';
  priv.checked = p.private;
  const privL = el('label', 'row');
  privL.append(priv, el('span', '', t('Keep this person to private conversations')), tip(t('Her card for them is only used in private conversations (with a model on your own hardware), never in normal ones.')));
  const status = el('span', 'muted small', '');
  status.setAttribute('role', 'status');
  const save = btn(t('Save'), '', async (b) => {
    const birthday = month.value && day.value ? `${/^\d{4}$/.test(year.value.trim()) ? `${year.value.trim()}-` : ''}${month.value}-${day.value}` : null;
    b.disabled = true;
    try {
      await api(`/people/${p.id}`, { method: 'PUT', body: { name: name.value, fullName: full.value || null, aliases: aliases.value.split(',').map((x) => x.trim()).filter(Boolean), relation: rel.value, circle: circle.value, birthday, private: priv.checked } });
      st.editing = false;
      await openPerson(p.id, { keep: true });
      void loadPeople();
    } catch (err) {
      status.textContent = err.message;
      b.disabled = false;
    }
  });
  const row = el('div', 'ppl-fact-actions');
  row.append(save, btn(t('Cancel'), 'ghost', () => ((st.editing = false), renderCard())), status);
  f.append(
    field(t('Name'), name),
    field(t('Full name'), full),
    field(t('Also called'), aliases, t('Other ways you say it, separated by commas ("Jeff from work", "J"). She uses them to tell two people with the same name apart.')),
    field(t('Who they are to you'), rel, t('In your own words ("my brother", "my manager"). She updates it only when you tell her something new.')),
    field(t('Circle'), circle, t('Family, partner, friends, work, neighbours or other. In a work chat she leans to work people when a name could be two.')),
    field(t('Birthday'), bday, t('Month and day (the year if you know it). It shows on Today and she remembers it once a year.')),
    privL,
    row,
  );
  return f;
}

function splitBar(p) {
  const bar = el('div', 'ppl-split');
  const name = document.createElement('input');
  name.placeholder = t('Name of the other person');
  name.value = p.name;
  name.maxLength = 80;
  name.setAttribute('aria-label', t('Name of the other person'));
  bar.append(
    el('p', 'small', t('Tick what is really about someone else, then move it to a new card.')),
    name,
    btn(t('Move to a new card'), '', async (b) => {
      const ids = [...(st.splitting ?? [])];
      if (!ids.length) return;
      b.disabled = true;
      try {
        const r = await api(`/people/${p.id}/split`, { method: 'POST', body: { factIds: ids, name: name.value } });
        st.splitting = null;
        await openPerson(r.person.id);
        void loadPeople();
      } catch (err) {
        showErr(err);
        b.disabled = false;
      }
    }),
  );
  return bar;
}

function linkPicker(p, anchor) {
  const box = el('div', 'ppl-merge');
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', t('Link to'));
  sel.append(new Option(t('Pick a person…'), ''));
  void api('/people').then((d) => {
    for (const o of d.people.filter((x) => x.id !== p.id)) sel.append(new Option(o.name, String(o.id)));
  });
  const rel = document.createElement('input');
  rel.placeholder = t("how (e.g. Jeff's wife)");
  rel.maxLength = 80;
  rel.setAttribute('aria-label', t('How they are linked'));
  box.append(sel, rel, btn(t('Link'), '', (b) => (sel.value && rel.value.trim() ? act(b, () => api(`/people/${p.id}`, { method: 'PUT', body: { links: [{ id: Number(sel.value), relation: rel.value.trim() }] } })) : sel.focus())), btn(t('Cancel'), 'ghost', () => box.remove()));
  anchor.closest('.ppl-sec')?.append(box);
  sel.focus();
}

async function uploadPhoto(p, file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) return showErr(new Error(t('That picture is too large (3 MB at most).')));
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  try {
    await api(`/people/${p.id}/photo`, { method: 'PUT', body: { data } });
    await openPerson(p.id, { keep: true });
    void loadPeople();
  } catch (err) {
    showErr(err);
  }
}

// ---------------- wiring ----------------

/** Memory → Notes / People tabs. */
function showTab(tab) {
  for (const x of document.querySelectorAll('#memory .mem-tabs .tab')) {
    x.classList.toggle('active', x.dataset.tab === tab);
    x.setAttribute('aria-selected', x.dataset.tab === tab ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('#memory > form > .tab-panel')) panel.hidden = panel.dataset.panel !== tab;
  document.getElementById('memory')?.classList.toggle('ppl-wide', tab === 'people');
  if (tab === 'people') void loadPeople();
  else closeCard();
}

/** The Memory window opened: back to Notes (the People tab loads when it's picked). */
export function peopleOnOpen(tab = 'notes') {
  closeCard();
  showTab(tab);
  // The tab's count of people to check (one small request).
  if (tab !== 'people') api('/people?status=proposed').then((d) => ((st.counts = d.counts), renderCount())).catch(() => undefined);
}

/** Opens Memory → People on one person (Today's dates tile, the command bar). */
export async function showPerson(id) {
  await ctx?.openMemory?.();
  showTab('people');
  await openPerson(id);
}

/** A `people` event (cards changed elsewhere): the open page follows, at most every 1.5 s. */
export function peopleEvent() {
  if (!$('#memory')?.open || document.querySelector('#memory .ppl-panel')?.hidden) return;
  clearTimeout(st.timer);
  st.timer = setTimeout(function refresh() {
    // Never re-render under the owner's hands: a merge/forget/split picker open or an editor focused.
    const busy = document.querySelector('#memory .ppl-merge, dialog.ppl-forget[open], #memory .ppl-edit, #memory .ppl-split') || document.activeElement?.closest?.('#memory .ppl-panel input, #memory .ppl-panel textarea, #memory .ppl-panel select');
    if (busy) {
      st.timer = setTimeout(refresh, 3000);
      return;
    }
    if (st.open) void openPerson(st.open.person.id, { keep: true });
    else void loadPeople();
  }, 1500);
}

export function initPeople(c) {
  ctx = c;
  if (!$('#ppl-list')) return;
  for (const x of document.querySelectorAll('#memory .mem-tabs .tab')) x.addEventListener('click', () => showTab(x.dataset.tab));
  let timer = 0;
  $('#ppl-q').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      st.q = $('#ppl-q').value;
      void loadPeople();
    }, 250);
  });
  $('#ppl-backfill').addEventListener('click', () => void startBackfill());
  $('#ppl-add').addEventListener('click', () => {
    $('#ppl-new').hidden = false;
    $('#ppl-new-name').focus();
  });
  $('#ppl-new-cancel').addEventListener('click', () => ($('#ppl-new').hidden = true));
  const add = async () => {
    const name = $('#ppl-new-name').value.trim();
    if (!name) return $('#ppl-new-name').focus();
    try {
      const r = await api('/people', { method: 'POST', body: { name, relation: $('#ppl-new-rel').value.trim() } });
      $('#ppl-new-name').value = '';
      $('#ppl-new-rel').value = '';
      $('#ppl-new').hidden = true;
      await loadPeople();
      await openPerson(r.person.id);
    } catch (err) {
      showErr(err);
    }
  };
  $('#ppl-new-save').addEventListener('click', () => void add());
  for (const id of ['#ppl-new-name', '#ppl-new-rel']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), void add()));
  // Escape on an open card goes back to the list (not out of the window).
  $('#memory').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.open && !document.querySelector('.ppl-forget[open], .tip-card')) {
      e.preventDefault();
      closeCard();
      void loadPeople();
    }
  });
  $('#memory').addEventListener('close', () => closeCard());
}
