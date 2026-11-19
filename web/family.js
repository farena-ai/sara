// R8 (docs/FAMILY.md): the Family page (a place in the sidebar) and its Today tile. Chores (a parent
// adds them; a kid taps "I did it", with a photo when asked; a parent approves), Allowance (balances,
// the ledger, "Record a payout": a record only), Groceries (shared lists grouped by aisle, a store per
// item, "Cheapest near me" for staples, and Shopping mode: big checkboxes at phone width), and Kids
// (the owner turns on kid-safe mode per member: age band, bedtime, daily time, safe search; parents
// see each kid's topics and minutes, never their words). Nothing here calls a model.
import { t } from './naming.js';
import { kidDashboard, kidProfileForm } from './kid-mode.js';
import { calendarTab, initFamilyPlan, loadPlanSettings, mealsTab, resetWeek, rotaControl, stars, todayLines } from './family-plan.js';

export { loadPlanSettings };

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, refreshToday?: () => void } | null} */
let ctx = null;
let data = null;
let tab = 'chores';
let listId = '';
let shopping = false;
let shopStore = '';

export function initFamily(c) {
  ctx = c;
  initFamilyPlan({ api: c.api, el: c.el, say: (m) => say(m), data: () => data, rerender: () => render() });
  for (const b of document.querySelectorAll('#family .fam-tabs button')) b.addEventListener('click', () => {
    tab = b.dataset.tab;
    render();
    document.querySelector('#family .settings-body')?.scrollTo?.(0, 0);
    document.querySelector('#family')?.scrollTo?.(0, 0);
  });
}
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
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
const say = (msg) => {
  const s = $('#fam-status');
  if (s) s.textContent = msg;
};
const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const REPEAT = () => ({ once: t('Once'), daily: t('Every day'), weekdays: t('Weekdays'), weekly: t('Every week') });
const worth = (c) => [c.cents ? money(c.cents) : '', c.points ? t('{n} points', { n: c.points }) : ''].filter(Boolean).join(' + ') || t('No reward');
const nameOf = (id) => data?.people.find((p) => p.id === id)?.name ?? id;
const input = (cls, attrs = {}) => Object.assign(el('input', cls), attrs);
const select = (options, value, label) => {
  const s = el('select');
  s.setAttribute('aria-label', label);
  for (const [v, text] of options) s.append(Object.assign(document.createElement('option'), { value: v, textContent: text, selected: v === value }));
  return s;
};
const field = (label, control, help) => {
  const l = el('label', 'fam-field');
  l.append(el('span', 'fam-label', label));
  if (help) l.append(tip(help));
  l.append(control);
  return l;
};
async function run(f, ok) {
  try {
    await f();
    if (ok) say(ok);
  } catch (err) {
    say(err.message);
  }
  await loadFamily();
  ctx.refreshToday?.();
}

export async function openFamily() {
  await loadFamily();
  if (!$('#family').open) $('#family').showModal();
}

export async function loadFamily() {
  try {
    data = await ctx.api('/family');
    resetWeek();
  } catch (err) {
    say(err.message);
    return;
  }
  if (tab === 'kids' && !data.me.parent) tab = 'chores';
  render();
}

function render() {
  if (!data) return;
  for (const b of document.querySelectorAll('#family .fam-tabs button')) {
    b.hidden = b.dataset.tab === 'kids' && !data.me.parent;
    b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  }
  const body = $('#fam-body');
  body.replaceChildren();
  $('#family').classList.toggle('fam-shopping', tab === 'grocery' && shopping);
  if (tab === 'chores') body.append(...choresTab());
  if (tab === 'money') body.append(...moneyTab());
  if (tab === 'grocery') void groceryTab(body);
  if (tab === 'kids') body.append(...kidsTab());
  if (tab === 'meals') void mealsTab(body);
  if (tab === 'calendar') void calendarTab(body);
}

// ---------------------------------------------------------------- chores
function choresTab() {
  const out = [];
  if (data.me.parent) {
    const form = el('div', 'fam-add');
    const title = input('', { maxLength: 100, placeholder: t('Chore (feed the cat, empty the dishwasher…)') });
    title.setAttribute('aria-label', t('Chore'));
    const others = data.people.filter((p) => p.id !== data.me.person);
    const who = select(others.map((p) => [p.id, p.name]), others.find((p) => p.child)?.id ?? '', t('Who does it'));
    const repeat = select(Object.entries(REPEAT()), 'weekly', t('How often'));
    const amount = input('fam-num', { type: 'number', min: '0', step: '0.25', placeholder: '$' });
    amount.setAttribute('aria-label', t('Allowance'));
    const points = input('fam-num', { type: 'number', min: '0', step: '1', placeholder: t('Points') });
    points.setAttribute('aria-label', t('Points'));
    const photo = input('', { type: 'checkbox' });
    const photoL = el('label', 'fam-check');
    photoL.append(photo, el('span', '', t('Ask for a photo')));
    const add = btn(t('Add chore'), 'small', () => void run(async () => {
      if (!title.value.trim()) throw new Error(t('Name the chore.'));
      await ctx.api('/family/chores', { method: 'POST', body: { title: title.value, assignee: who.value, repeat: repeat.value, amount: amount.value || 0, points: Number(points.value || 0), photo: photo.checked } });
    }, t('Chore added.')));
    form.append(title, who, repeat, amount, points, photoL, add, tip(t('A chore repeats on its own. They tap “I did it” (with a photo if you ask), you approve, and what it is worth goes into their allowance.')));
    if (!others.length) form.append(el('p', 'muted small', t('Invite someone in Settings → Household first.')));
    out.push(form);
  }
  if (data.waiting.length) {
    out.push(el('h3', 'fam-h', data.me.parent ? t('Waiting for your OK') : t('Waiting for a parent’s OK')));
    const list = el('ul', 'fam-list');
    for (const m of data.waiting) {
      const li = el('li', 'fam-row fam-waiting');
      const text = el('div', 'fam-main');
      text.append(el('strong', '', m.title), el('span', 'muted small', ` · ${nameOf(m.kid)} · ${worth(m)}${m.note ? ` · “${m.note}”` : ''}`));
      li.append(text);
      if (m.photo) {
        const img = Object.assign(el('img', 'fam-photo'), { src: `/api/family/marks/${m.id}/photo`, alt: t('Photo of the finished chore'), loading: 'lazy' });
        li.append(img);
      }
      if (data.me.parent && m.kid !== data.me.person) {
        const acts = el('div', 'fam-acts');
        acts.append(btn(t('Approve'), 'small', () => void run(() => ctx.api(`/family/marks/${m.id}/approve`, { method: 'POST', body: {} }), t('Approved.'))), btn(t('Not yet'), 'ghost small', () => void run(() => ctx.api(`/family/marks/${m.id}/reject`, { method: 'POST', body: {} }))));
        li.append(acts);
      }
      list.append(li);
    }
    out.push(list);
  }
  const chores = data.me.parent ? data.chores : data.chores.filter((c) => c.assignee === data.me.person);
  const mine = data.kids.find((k) => k.id === data.me.person);
  if (data.me.child && mine?.points) out.push(el('p', 'fpl-stars fpl-star-total', t('You have {stars} stars', { stars: stars(mine.points) })));
  out.push(el('h3', 'fam-h', data.me.parent ? t('Chores') : t('My chores')));
  if (!chores.length) out.push(el('p', 'muted small', data.me.parent ? t('No chores yet. Add one above, or ask her: “add a chore for Mia: feed the cat every day, $1”.') : t('No chores for you right now.')));
  const list = el('ul', 'fam-list');
  for (const c of chores) {
    const li = el('li', `fam-row${c.active ? '' : ' fam-off'}`);
    const text = el('div', 'fam-main');
    text.append(el('strong', '', c.title), el('span', 'muted small', ` · ${data.me.parent ? `${nameOf(c.assignee)} · ` : ''}${REPEAT()[c.repeat]} · ${c.active ? t('due {when}', { when: when(c.dueAt) }) : t('paused')} · ${worth(c)}`));
    // U4.21: a kid sees what a chore is worth as stars; a parent can make it take turns.
    if (data.me.child && c.points) text.append(el('span', 'fpl-stars', ` ${stars(c.points)}`));
    if (data.me.parent && c.active) text.append(rotaControl(c, () => void loadFamily()));
    li.append(text);
    const acts = el('div', 'fam-acts');
    if (c.active && (c.assignee === data.me.person || data.me.parent)) acts.append(doneButton(c));
    if (data.me.parent) {
      acts.append(btn(c.active ? t('Pause') : t('Resume'), 'ghost small', () => void run(() => ctx.api(`/family/chores/${c.id}`, { method: 'PATCH', body: { active: !c.active } }))));
      acts.append(btn(t('Delete'), 'ghost small', () => {
        if (confirm(t('Delete the chore “{title}”?', { title: c.title }))) void run(() => ctx.api(`/family/chores/${c.id}`, { method: 'DELETE' }));
      }));
    }
    li.append(acts);
    list.append(li);
  }
  out.push(list);
  return out;
}

/** "I did it" (and a photo, when the chore asks for one). */
function doneButton(c) {
  const wrap = el('span', 'fam-done');
  const go = async (photo) => run(() => ctx.api(`/family/chores/${c.id}/done`, { method: 'POST', body: photo ? { photo } : {} }), t('Nice! It waits for a parent’s OK.'));
  if (!c.photo) {
    wrap.append(btn(t('I did it'), 'small fam-big', () => void go()));
    return wrap;
  }
  const file = Object.assign(input('', { type: 'file', accept: 'image/*', capture: 'environment' }), { hidden: true });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return say(t('That photo is too big (4 MB at most).'));
    const r = new FileReader();
    r.onload = () => void go(String(r.result));
    r.readAsDataURL(f);
  });
  wrap.append(file, btn(t('I did it (add a photo)'), 'small fam-big', () => file.click()), btn(t('Without a photo'), 'ghost small', () => void go()));
  return wrap;
}

// ---------------------------------------------------------------- allowance
function moneyTab() {
  const out = [];
  if (!data.kids.length) {
    out.push(el('p', 'muted small', data.me.parent ? t('No kids yet: turn on kid-safe mode for someone on the Kids tab.') : t('Nothing here yet.')));
    return out;
  }
  out.push(el('p', 'muted small', t('Approved chores add up here. “Record a payout” only writes it down: Sara never moves money.')));
  for (const k of data.kids) {
    const card = el('div', 'fam-card');
    const head = el('div', 'fam-money-head');
    head.append(el('strong', '', k.name), el('span', 'fam-balance', money(k.balanceCents)));
    card.append(head, el('p', 'muted small', t('Earned {earned} · paid out {paid}{points}', { earned: money(k.earnedCents), paid: money(k.paidCents), points: k.points ? ` · ${t('{n} points', { n: k.points })}` : '' })));
    if (data.me.parent) {
      const row = el('div', 'fam-add');
      const amt = input('fam-num', { type: 'number', min: '0', step: '0.25', placeholder: '$' });
      amt.setAttribute('aria-label', t('Amount paid'));
      row.append(amt, btn(t('Record a payout'), 'ghost small', () => void run(() => ctx.api(`/family/kids/${k.id}/pay`, { method: 'POST', body: { amount: amt.value } }), t('Recorded. No money was moved.'))));
      card.append(row);
    }
    const more = btn(t('Show the ledger'), 'ghost small', async () => {
      try {
        const r = await ctx.api(`/family/kids/${k.id}`);
        const ul = el('ul', 'fam-ledger');
        for (const x of r.ledger) ul.append(el('li', 'small', `${new Date(x.at).toLocaleDateString()} · ${x.kind === 'paid' ? t('Paid out') : t('Earned')} ${money(x.cents)}${x.points ? ` · ${t('{n} points', { n: x.points })}` : ''} · ${x.note}`));
        if (!r.ledger.length) ul.append(el('li', 'muted small', t('Nothing yet.')));
        more.replaceWith(ul);
      } catch (err) {
        say(err.message);
      }
    });
    card.append(more);
    out.push(card);
  }
  return out;
}

// ---------------------------------------------------------------- groceries
async function groceryTab(body) {
  const lists = data.grocery;
  if (!listId || !lists.some((l) => l.id === listId)) listId = lists[0]?.id ?? '';
  const top = el('div', 'fam-add');
  if (lists.length > 1) {
    const pick = select(lists.map((l) => [l.id, l.name]), listId, t('Grocery list'));
    pick.addEventListener('change', () => {
      listId = pick.value;
      render();
    });
    top.append(pick);
  }
  top.append(btn(t('New grocery list'), 'ghost small', () => void run(async () => {
    const r = await ctx.api('/family/grocery', { method: 'POST', body: { name: t('Groceries') } });
    listId = r.list.id;
  }, t('Made. Everyone at home gets an invitation to it.'))));
  if (listId) {
    const sm = btn(shopping ? t('Done shopping') : t('Shopping mode'), shopping ? 'small' : 'ghost small', () => {
      shopping = !shopping;
      render();
    });
    top.append(sm, tip(t('Big checkboxes for the store, one aisle after another. Pick a store to see only what you buy there.')));
  }
  for (const inv of data.groceryInvites ?? []) {
    const p = el('p', 'small fam-invite', t('{name} invited you to “{list}”.', { name: nameOf(inv.from), list: inv.name }));
    p.append(' ', btn(t('Join'), 'small', () => void run(() => ctx.api(`/boards/invites/${inv.boardId}/accept`, { method: 'POST', body: {} }))));
    body.append(p);
  }
  body.append(top);
  if (!listId) {
    body.append(el('p', 'muted small', t('No grocery list yet. Make one and share it with everyone at home.')));
    return;
  }
  let list;
  try {
    list = (await ctx.api(`/family/grocery/${listId}`)).list;
  } catch (err) {
    say(err.message);
    return;
  }
  if (tab !== 'grocery') return;
  if (!shopping) {
    const add = el('div', 'fam-add');
    const what = input('', { maxLength: 120, placeholder: t('Add an item (milk, bananas…)') });
    what.setAttribute('aria-label', t('Item'));
    const go = () => void run(async () => {
      if (!what.value.trim()) return;
      await ctx.api(`/family/grocery/${listId}/items`, { method: 'POST', body: { title: what.value } });
    });
    what.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    });
    add.append(what, btn(t('Add'), 'small', go));
    if (data.me.owner) add.append(btn(t('Cheapest near me'), 'ghost small', () => void run(async () => {
      say(t('Checking stores near you…'));
      const r = await ctx.api(`/family/grocery/${listId}/cheapest`, { method: 'POST', body: {} });
      say(r.results.length ? r.results.map((x) => (x.price ? `${x.title}: ${x.price} ${t('at')} ${x.store}` : `${x.title}: ${x.error}`)).join(' · ') : t('No staples to check (milk, eggs, bread…).'));
    })), tip(t('Checks prices for a few staples (milk, eggs, bread…) at stores near you with the shopping helper, and puts the cheapest store on each item. Nothing is bought.')));
    body.append(add);
  } else if (list.stores.length) {
    const pick = select([['', t('All stores')], ...list.stores.map((s) => [s, s])], shopStore, t('Store'));
    pick.addEventListener('change', () => {
      shopStore = pick.value;
      render();
    });
    body.append(pick);
  }
  const aisleNames = Object.fromEntries(data.options.aisles.map((a) => [a.id, t(a.name)]));
  for (const a of list.aisles) {
    const items = a.items.filter((i) => !shopping || !shopStore || i.store === shopStore || !i.store);
    if (!items.length) continue;
    const sec = el('section', 'fam-aisle');
    sec.append(el('h3', 'fam-h', aisleNames[a.id] ?? a.name));
    const ul = el('ul', 'fam-list');
    for (const i of items) ul.append(itemRow(i, list.stores, aisleNames));
    sec.append(ul);
    body.append(sec);
  }
  if (!list.aisles.length) body.append(el('p', 'muted small', t('The list is empty.')));
}

function itemRow(i, stores, aisleNames) {
  const li = el('li', `fam-row fam-item${i.done ? ' fam-got' : ''}`);
  const box = input('fam-box', { type: 'checkbox', checked: i.done });
  const label = el('label', 'fam-item-label');
  label.append(box, el('span', 'fam-item-title', i.title));
  box.addEventListener('change', () => void run(() => ctx.api(`/family/grocery/${listId}/items/${i.ref}`, { method: 'PATCH', body: { done: box.checked } })));
  li.append(label);
  const meta = el('span', 'muted small fam-item-meta', [i.store, i.price].filter(Boolean).join(' · '));
  li.append(meta);
  if (!shopping) {
    const acts = el('div', 'fam-acts');
    const store = input('fam-store', { value: i.store ?? '', placeholder: t('Store'), maxLength: 40 });
    store.setAttribute('aria-label', t('Store'));
    store.setAttribute('list', 'fam-stores');
    store.addEventListener('change', () => void run(() => ctx.api(`/family/grocery/${listId}/items/${i.ref}`, { method: 'PATCH', body: { store: store.value } })));
    const aisle = select(Object.entries(aisleNames), i.aisle, t('Aisle'));
    aisle.addEventListener('change', () => void run(() => ctx.api(`/family/grocery/${listId}/items/${i.ref}`, { method: 'PATCH', body: { aisle: aisle.value } })));
    acts.append(store, aisle, btn('✕', 'ghost small icon', () => void run(() => ctx.api(`/family/grocery/${listId}/items/${i.ref}`, { method: 'DELETE' }))));
    acts.lastChild.setAttribute('aria-label', t('Remove'));
    li.append(acts);
    let dl = $('#fam-stores');
    if (!dl) {
      dl = el('datalist');
      dl.id = 'fam-stores';
      $('#fam-body').append(dl);
    }
    dl.replaceChildren(...stores.map((s) => Object.assign(document.createElement('option'), { value: s })));
  }
  return li;
}

// ---------------------------------------------------------------- kids (parents)
function kidsTab() {
  const out = [el('p', 'muted small', t('Kid-safe mode keeps adult content off, uses kid-friendly words, and turns off computer use, shopping, mail and outside apps. It is checked on the server for every request.'))];
  const others = data.people.filter((p) => p.id !== 'owner');
  if (!others.length) out.push(el('p', 'muted small', t('Invite your kids in Settings → Household (tick “This is a child”).')));
  for (const p of others) {
    const card = el('div', 'fam-card');
    const head = el('div', 'fam-money-head');
    head.append(el('strong', '', p.name), el('span', 'muted small', p.child ? t('Kid-safe mode') : p.parent ? t('Parent') : t('Grown-up member')));
    card.append(head);
    const kid = data.kids.find((k) => k.id === p.id);
    const prof = kid?.profile;
    // W5.4 (web/kid-mode.js): the profile editor v2 (age band defaults, tone, strictness, tools, transcript view).
    const h = { el, btn, tip, input, select, field, run, api: ctx.api, say };
    if (data.me.owner) {
      card.append(kidProfileForm(p, prof, data.options, h));
      if (!p.child) {
        const par = input('', { type: 'checkbox', checked: p.parent });
        const parL = el('label', 'fam-check');
        parL.append(par, el('span', '', t('Parent here (can approve chores and record payouts)')));
        par.addEventListener('change', () => void run(() => ctx.api(`/family/parents/${p.id}`, { method: 'PUT', body: { on: par.checked } })));
        card.append(parL);
      }
    }
    if (p.child) {
      // W5.4: the parent dashboard (time, requests, flagged moments, the week, transcript view when on).
      const dash = el('div', 'kid-dash');
      const show = btn(t('Dashboard'), 'small', () => {
        show.remove();
        void kidDashboard(dash, p, h).then(() => studySets(dash, p));
      });
      card.append(show, dash);
    }
    out.push(card);
  }
  return out;
}

// U4.23 (docs/LEARNING.md): their study sets, titles and counts only (under the dashboard).
async function studySets(host, p) {
  try {
    const r = await ctx.api(`/family/kids/${p.id}`);
    const sl = el('ul', 'fam-ledger');
    for (const s of r.study ?? []) sl.append(el('li', 'small', `${s.title} · ${t('{learned} of {cards} learned · {due} due', { learned: s.learned, cards: s.cards, due: s.due })} · ${t('{n} studied today', { n: s.reviewedToday })}`));
    if (sl.children.length) host.append(el('p', 'muted small', t('Study sets (titles and counts, never the cards)')), sl);
  } catch {
    /* the dashboard already said what went wrong */
  }
}

// ---------------------------------------------------------------- Today
export function renderFamilyTile(p, tileHead) {
  const tile = $('#td-family');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Family'));
  const parts = [];
  const name = (id) => p.names?.[id] ?? id;
  if (p.role === 'parent') {
    if (p.waiting.length) {
      const ul = el('ul', 'td-biz fam-tile');
      for (const m of p.waiting) {
        const li = el('li', 'small');
        li.append(document.createTextNode(`${name(m.kid)}: ${m.title} · ${worth(m)} `));
        li.append(btn(t('Approve'), 'ghost small', async () => {
          try {
            await ctx.api(`/family/marks/${m.id}/approve`, { method: 'POST', body: {} });
          } catch (err) {
            ctx.toast?.(err.message);
          }
          ctx.refreshToday?.();
        }));
        ul.append(li);
      }
      parts.push(el('p', 'small fam-tile-h', t('Waiting for your OK')), ul);
    }
    if (p.kids.length) parts.push(el('p', 'small muted', p.kids.map((k) => `${k.name} ${money(k.balanceCents)}`).join(' · ')));
    if (p.due.length) parts.push(el('p', 'small muted', t('Due today: {list}', { list: p.due.map((c) => `${c.title} (${name(c.assignee)})`).join(', ') })));
  } else {
    const ul = el('ul', 'td-biz fam-tile');
    for (const c of p.due) {
      const li = el('li', 'small');
      li.append(document.createTextNode(`${c.title} · ${worth(c)} `), doneButton(c));
      ul.append(li);
    }
    if (p.due.length) parts.push(ul);
    if (p.waiting.length) parts.push(el('p', 'small muted', t('{n} waiting for a parent’s OK', { n: p.waiting.length })));
    if (p.balance) parts.push(el('p', 'small', t('Your allowance: {money}', { money: money(p.balance.balanceCents) })));
  }
  parts.unshift(...todayLines(p.plan));
  parts.push(btn(t('Open Family'), 'ghost small', () => void openFamily()));
  tile.querySelector('.td-body').replaceChildren(...parts);
}
