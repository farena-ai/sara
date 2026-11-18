// V2.10 (docs/design/V2SCHEDULE.md): find a time with a linked friend, in a one-to-one Messages chat
// (called from support.js). "Find a time with {name}" form; the friend's card with Share my free/busy /
// Not now; the 3 proposed times as buttons showing who picked what; agreed line. Only busy blocks cross:
// the servers do all of it, this page only shows and sends taps.
import { t } from './naming.js';

let ctx = null;
let state = null;
let reload = async () => {};
let say = (_m) => {};
let panel = (..._n) => {};

const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const PARTS = () => ({ day: t('Daytime (9–5)'), evening: t('Evening (5–9)'), any: t('Any time (9–9)') });
const call = (path, o) => ctx.api(`/friend-time${path}`, o);
const act = (fn, ok) => async () => {
  try {
    await fn();
    if (ok) say(ok);
    await reload();
  } catch (err) {
    say(err.message);
  }
};

/** Called once by support.js with the Messages context and helpers. */
export function initFriendTime(c, helpers) {
  ctx = c;
  reload = helpers.reload;
  say = helpers.say;
  panel = helpers.panel;
}

/** Loads the requests with the Messages page (owner only; members get nothing). */
export async function loadFriendTime() {
  if (!ctx) return;
  try {
    state = await ctx.api('/friend-time');
  } catch {
    state = null;
  }
}

const open = (r) => r.status === 'asked' || r.status === 'proposed';
const waitingOnMe = (r) => (r.side === 'friend' && r.status === 'asked') || (r.status === 'proposed' && !r.myPick);

/** Rows above the chat list: requests waiting for this owner. */
export function friendTimeRows(openChat) {
  const rows = [];
  if (!state) return rows;
  const seen = new Set();
  for (const r of state.requests ?? []) {
    if (!waitingOnMe(r) || seen.has(r.link)) continue;
    seen.add(r.link);
    const row = el('div', 'msgs-req');
    row.append(el('span', '', r.status === 'asked' ? t('{name} wants to find a time: {what}', { name: r.friend, what: r.title }) : t('Pick a time with {name}: {what}', { name: r.friend, what: r.title })), btn(t('Open'), 'small', () => openChat(r.link)));
    rows.push(row);
  }
  return rows;
}

/** The scheduling strip of a one-to-one chat: the Find a time button and this friend's requests. */
export function friendTimeStrip(chat) {
  const box = el('div', 'ft-strip');
  if (!state || chat.kind !== 'direct' || chat.status !== 'active' || !chat.linkId) return box;
  const name = chat.title;
  const mine = (state.requests ?? []).filter((r) => r.link === chat.linkId);
  const line = el('div', 'sup-line');
  line.append(btn(t('Find a time with {name}', { name }), 'ghost small ft-find', () => findForm(chat.linkId, name)));
  box.append(line);
  const shown = [...mine.filter(open), ...mine.filter((r) => !open(r)).slice(0, 2)];
  for (const r of shown) box.append(card(r));
  return box;
}

function card(r) {
  const c = el('div', `sup-card ft-card ft-${r.status}`);
  c.dataset.ft = r.id;
  const head = el('p', 'small');
  head.append(el('strong', '', r.title), document.createTextNode(` · ${t('{n} min', { n: r.minutes })} · ${PARTS()[r.part] ?? r.part}`));
  c.append(head);
  const name = r.friend;
  if (r.status === 'asked' && r.side === 'friend') {
    c.append(el('p', 'small', t('{name} wants to find a time. Only your busy times are shared (not what they are), and only if you say yes.', { name })));
    const row = el('div', 'sup-line');
    row.append(btn(t('Share my free/busy'), 'small', act(() => call(`/${r.id}/share`, { method: 'POST', body: {} }), t('Shared. Pick the time that suits you.'))), btn(t('Not now'), 'ghost small', act(() => call(`/${r.id}/decline`, { method: 'POST', body: {} }))));
    c.append(row);
  } else if (r.status === 'asked') {
    c.append(el('p', 'small muted', t('Waiting for {name} to share free/busy.', { name })));
    c.append(btn(t('Call it off'), 'ghost small', act(() => call(`/${r.id}/cancel`, { method: 'POST', body: {} }))));
  } else if (r.status === 'proposed') {
    c.append(el('p', 'small', r.myPick ? t('Waiting for {name} to pick. You can still change your pick.', { name }) : t('These times are free for both of you. Pick the one that suits you.')));
    const list = el('div', 'ft-times');
    for (const x of r.times) {
      const b = btn(when(x), `small ft-time${x === r.myPick ? ' ft-mine' : ' ghost'}`, act(() => call(`/${r.id}/pick`, { method: 'POST', body: { time: x } })));
      b.setAttribute('aria-pressed', String(x === r.myPick));
      const tags = [];
      if (x === r.myPick) tags.push(t('your pick'));
      if (x === r.theirPick) tags.push(t('{name}’s pick', { name }));
      const cell = el('div', 'ft-slot');
      cell.append(b);
      if (tags.length) cell.append(el('span', 'small muted', tags.join(' · ')));
      list.append(cell);
    }
    c.append(list, btn(t('Call it off'), 'ghost small', act(() => call(`/${r.id}/cancel`, { method: 'POST', body: {} }))));
  } else if (r.status === 'agreed') {
    c.append(el('p', 'small ft-agreed', t('Agreed: {time}. It is in your planner.', { time: when(r.agreed) })));
  } else {
    const text = r.status === 'none' ? t('No common free time in those days. Try other days or another part of the day.') : r.status === 'declined' ? (r.side === 'asker' ? t('{name} said not now.', { name }) : t('You said not now.')) : t('Called off.');
    c.append(el('p', 'small muted', text));
  }
  if (!open(r)) c.append(btn(t('Remove'), 'ghost small', act(() => call(`/${r.id}`, { method: 'DELETE' }))));
  return c;
}

function findForm(link, name) {
  const what = el('input', 'ft-what');
  what.maxLength = 80;
  what.placeholder = t('What is it? (for example, Coffee)');
  what.setAttribute('aria-label', t('What is it?'));
  const mins = el('select', 'ft-mins');
  mins.setAttribute('aria-label', t('How long?'));
  for (const m of state?.minutes ?? [30, 60]) {
    const o = el('option', '', t('{n} min', { n: m }));
    o.value = String(m);
    o.selected = m === 60;
    mins.append(o);
  }
  const part = el('select', 'ft-part');
  part.setAttribute('aria-label', t('When in the day?'));
  for (const [k, v] of Object.entries(PARTS())) {
    const o = el('option', '', v);
    o.value = k;
    part.append(o);
  }
  const days = el('select', 'ft-days');
  days.setAttribute('aria-label', t('Within'));
  for (const [n, label] of [[3, t('Next 3 days')], [7, t('Next 7 days')], [14, t('Next 2 weeks')]]) {
    const o = el('option', '', label);
    o.value = String(n);
    o.selected = n === 7;
    days.append(o);
  }
  const row = el('div', 'ft-form-row');
  row.append(mins, part, days);
  const go = btn(t('Ask {name}', { name }), 'small', async () => {
    try {
      await call('', { method: 'POST', body: { link, title: what.value, minutes: Number(mins.value), part: part.value, days: Number(days.value) } });
      say(t('Asked {name}. You get 3 times once they share free/busy.', { name }));
      document.querySelector('#msgs-panel').hidden = true;
      await reload();
    } catch (err) {
      say(err.message);
    }
  });
  panel(el('p', 'small', t('Find a time with {name}', { name })), el('p', 'small muted', t('Your Sara and theirs swap busy times only, never what the events are.')), what, row, go);
  what.focus();
}
