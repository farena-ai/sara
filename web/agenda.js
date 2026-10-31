// Phase 103 (ST8, docs/AGENDA.md, docs/design/STAPLES.md §11): her own plans. Planner → Her plans
// (the big switch, today's shared count and budget, what she's planning, her goals and proposals,
// what she did on her own, the settings with sliders), Today's "Her plans" tile, the "Why I'm
// writing" line under her planned messages and the "Added to her plans" note in the chat.
// Every value from the server is set as text (nothing becomes markup).
import { locale, t } from './naming.js';
import { proposalCard } from './proposal-card.js';

let ctx = null;
let view = null;
let focusItem = null;

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(cls, label, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
const raw = (n) => {
  n.dataset.raw = '';
  return n;
};

// ---------- pure helpers (tested in Node) ----------

/** "4k" for 4,200 tokens, "30k", "120". */
export function kTokens(n) {
  const x = Number(n) || 0;
  return x >= 1000 ? `${Math.round(x / 100) / 10}k`.replace('.0k', 'k') : String(Math.round(x));
}

/** When a plan is due, in words: "Today 7:00 PM", "Tomorrow 6:00 PM", "Fri 6 Nov, 7:00 PM". */
export function whenWords(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (day(d) === day(now)) return t('Today {time}', { time });
  if (day(d) === day(tomorrow)) return t('Tomorrow {time}', { time });
  return `${d.toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** The value for an <input type="datetime-local"> in this browser's time. */
export function localInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The reason line as she shows it: his words when there are some. */
export function whyText(x) {
  if (x?.quote) return t('you said “{quote}”', { quote: String(x.quote).replace(/^["“]+|["”]+$/g, '') });
  if (x?.kind === 'gentle') return t('a recent conversation was hard, so I checked in once');
  if (x?.why === 'You asked her to') return t('you put this on my plans');
  return x?.why ? t(x.why) : '';
}

const STATUS = { sent: 'Sent', done: 'Answered', skipped: 'Skipped', cancelled: 'Cancelled', expired: 'Skipped: the day was full', paused: 'Paused', planned: 'Planned' };
const KIND = { 'follow-up': 'Follow-up', 'check-in': 'Check-in', research: 'Look-up' };
const SKIP = { 'quiet hours': 'Quiet hours', 'daily limit': 'The messages for today are used up', 'talked recently': 'You talked a moment ago', 'texted recently': 'She wrote a moment ago', unanswered: 'Her last message is still unanswered', busy: 'She is busy in the chat', budget: 'The budget for today is used up', 'nothing due': 'Nothing is due yet', 'crisis pause': 'Paused after a hard conversation', stopped: 'Stopped', off: 'Her plans are off', 'model chose not to': 'She decided it no longer fit', 'failed checks': 'It failed her honesty checks', 'never talked': 'You haven’t talked yet', 'no chat': 'There is no chat to write in' };
const EVERY = { '1d': 'Every day', '2d': 'Every 2 days', '3d': 'Every 3 days', '7d': 'Every week', '14d': 'Every 2 weeks', '30d': 'Every month' };

// ---------- loading ----------

async function call(path, method = 'GET', body) {
  const r = await ctx.api(`/agenda${path}`, method === 'GET' ? {} : { method, body: body ?? {} });
  if (r && r.settings) view = r;
  return r;
}

export async function loadAgenda() {
  if (!ctx) return null;
  try {
    view = await ctx.api('/agenda');
  } catch {
    view = null;
  }
  renderPanel();
  return view;
}

function status(msg) {
  const s = $('#ag-status');
  if (s) s.textContent = msg;
}

async function act(fn, done) {
  status('');
  try {
    await fn();
    renderPanel();
    if (done) status(done);
    ctx.refreshToday?.();
  } catch (err) {
    status(err.message);
  }
}

// ---------- the panel ----------

function meter(label, value, max, cls) {
  const wrap = el('div', `ag-meter ${cls}`);
  const head = el('div', 'ag-meter-head');
  head.append(el('span', 'ag-meter-label', label), raw(el('strong', 'ag-meter-value', value)));
  const bar = el('div', 'ag-bar');
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', label);
  const frac = max > 0 ? Math.min(1, Number(value.split(' ')[0]) / max) : 0;
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(max));
  const fill = el('span', 'ag-fill');
  fill.dataset.level = String(Math.round((Number.isFinite(frac) ? frac : 0) * 10));
  bar.append(fill);
  wrap.append(head, bar);
  return wrap;
}

function renderMeters() {
  const box = $('#ag-meters');
  if (!box || !view) return;
  const d = view.today;
  const m = meter(t('Messages today (shared with her first messages)'), `${d.messages} / ${d.maxPerDay}`, d.maxPerDay, 'ag-m-msgs');
  m.querySelector('.ag-fill').dataset.level = String(d.maxPerDay ? Math.min(10, Math.round((d.messages / d.maxPerDay) * 10)) : 10);
  const tk = meter(t('Her plans budget today'), `${kTokens(d.tokens)} / ${kTokens(d.budgetTokens)}`, d.budgetTokens, 'ag-m-tokens');
  tk.querySelector('.ag-fill').dataset.level = String(d.budgetTokens ? Math.min(10, Math.round((d.tokens / d.budgetTokens) * 10)) : 10);
  box.replaceChildren(m, tk);
  const line = $('#ag-usage-line');
  if (line) line.textContent = t('{a} of {b} messages today · {c} of {d} tokens', { a: d.messages, b: d.maxPerDay, c: kTokens(d.tokens), d: kTokens(d.budgetTokens) });
}

function itemRow(x, { editable = true } = {}) {
  const row = el('div', `ag-item ${x.status}`);
  row.dataset.id = String(x.id);
  if (focusItem === x.id) row.classList.add('focus');
  const when = el('div', 'ag-when');
  when.append(el('span', 'ag-when-text', whenWords(x.dueAt)), el('span', `ag-kind ${x.kind}`, t(KIND[x.kind] ?? x.kind)));
  const body = el('div', 'ag-item-body');
  body.append(raw(el('p', 'ag-what', x.what)));
  const why = el('p', 'ag-why small');
  why.append(el('span', 'ag-why-k', t('Why:')), document.createTextNode(' '), raw(el('span', '', whyText(x))));
  body.append(why);
  const chips = el('div', 'ag-chips');
  chips.append(el('span', `ag-chip by-${x.createdBy}`, x.createdBy === 'her' ? t('She planned it') : t('Yours')));
  if (x.status === 'paused') chips.append(el('span', 'ag-chip paused', t('Paused')));
  if (x.moved) chips.append(el('span', 'ag-chip', t('Moved once')));
  if (x.research) chips.append(el('span', 'ag-chip', t('Looked up')));
  if (x.source?.conversationId) {
    chips.append(button('ghost small ag-src', t('Where you said it'), () => ctx.openConversation?.(x.source.conversationId)));
  }
  body.append(chips);
  row.append(when, body);
  if (x.kind === 'research' && !x.allowed && editable) {
    const ask = el('div', 'ag-ask');
    ask.append(el('p', 'small', t('She would like to look this up before then (one web search, counted in her budget).')));
    const r = el('div', 'ag-actions');
    r.append(
      button('', t('Allow once'), () => act(() => call(`/items/${x.id}`, 'PUT', { allow: true }), t('Allowed.'))),
      button('ghost', t('Not now'), () => act(() => call(`/items/${x.id}`, 'PUT', { cancel: true }))),
    );
    ask.append(r);
    body.append(ask);
  }
  if (editable) row.append(itemActions(x, row));
  return row;
}

function itemActions(x, row) {
  const acts = el('div', 'ag-actions');
  const edit = el('div', 'ag-edit');
  edit.hidden = true;
  const openEdit = (what) => {
    edit.replaceChildren();
    edit.hidden = false;
    const input = el('input');
    if (what === 'time') {
      input.type = 'datetime-local';
      input.value = localInput(x.dueAt);
      input.setAttribute('aria-label', t('New time'));
    } else {
      input.maxLength = 200;
      input.value = x.what;
      input.setAttribute('aria-label', t('What she will do'));
    }
    const save = button('', t('Save'), () =>
      act(async () => {
        if (what === 'time') {
          const d = new Date(input.value);
          if (Number.isNaN(d.getTime())) throw new Error(t('Pick a time that is still to come.'));
          await call(`/items/${x.id}`, 'PUT', { dueAt: d.toISOString() });
        } else await call(`/items/${x.id}`, 'PUT', { what: input.value });
      }, t('Saved.')),
    );
    edit.append(input, save, button('ghost', t('Cancel'), () => (edit.hidden = true)));
    input.focus();
  };
  acts.append(
    button('ghost small', t('Edit time'), () => openEdit('time')),
    button('ghost small', t('Change what'), () => openEdit('what')),
    button('ghost small danger', t('Cancel it'), () => act(() => call(`/items/${x.id}`, 'PUT', { cancel: true }), t('Cancelled.'))),
  );
  const wrap = el('div', 'ag-item-tools');
  wrap.append(acts, edit);
  void row;
  return wrap;
}

function goalCard(g) {
  const c = el('div', `ag-goal ${g.status}`);
  const head = el('div', 'ag-goal-head');
  head.append(raw(el('strong', 'ag-goal-title', g.title)), el('span', `ag-chip st-${g.status}`, t(g.status === 'active' ? 'Active' : g.status === 'paused' ? 'Paused' : g.status === 'done' ? 'Done' : g.status)));
  c.append(head);
  const why = el('p', 'ag-why small');
  why.append(el('span', 'ag-why-k', t('Why:')), document.createTextNode(' '), raw(el('span', '', g.quote ? t('you said “{quote}”', { quote: g.quote }) : t(g.why))));
  c.append(why);
  const meta = el('p', 'muted small');
  meta.textContent = [t(EVERY[g.checkEvery] ?? g.checkEvery), g.next ? t('Next check-in: {when}', { when: whenWords(g.next) }) : '', g.endsOn ? t('Until {day}', { day: new Date(`${g.endsOn}T12:00:00`).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' }) }) : ''].filter(Boolean).join(' · ');
  c.append(meta);
  if (g.notes?.length) {
    const ul = el('ul', 'ag-notes');
    for (const n of g.notes.slice(-3)) {
      const li = el('li', 'small');
      li.append(el('span', 'muted', `${n.day} `), raw(el('span', '', n.text)));
      ul.append(li);
    }
    c.append(ul);
  }
  const acts = el('div', 'ag-actions');
  if (g.status === 'active') acts.append(button('ghost small', t('Pause'), () => act(() => call(`/goals/${g.id}`, 'PUT', { status: 'paused' }))));
  if (g.status === 'paused') acts.append(button('ghost small', t('Resume'), () => act(() => call(`/goals/${g.id}`, 'PUT', { status: 'active' }))));
  if (g.status === 'active' || g.status === 'paused') acts.append(button('ghost small', t('Done'), () => act(() => call(`/goals/${g.id}`, 'PUT', { status: 'done' }), t('Well done.'))));
  c.append(acts);
  return c;
}

/** A goal she proposes, on the shared proposal card: Use it / Edit first / Not now / Never for this. */
export function goalProposal(g, onDone) {
  const body = [];
  const editor = el('div', 'ag-edit');
  editor.hidden = true;
  const decide = (decision, extra = {}) =>
    act(async () => {
      await call(`/goals/${g.id}/decide`, 'POST', { decision, ...extra });
      onDone?.(decision);
    }, decision === 'use' ? t('Added to her plans.') : '');
  const nameIn = el('input');
  nameIn.maxLength = 160;
  nameIn.value = g.title;
  nameIn.setAttribute('aria-label', t('The goal'));
  const every = el('select');
  every.setAttribute('aria-label', t('How often she checks in'));
  for (const [v, l] of Object.entries(EVERY)) every.append(new Option(t(l), v, v === (g.checkEvery ?? '7d'), v === (g.checkEvery ?? '7d')));
  editor.append(nameIn, every, button('', t('Use it'), () => decide('use', { title: nameIn.value, checkEvery: every.value })));
  body.push(editor);
  return proposalCard({
    title: t('A goal to keep at together?'),
    source: t('She suggests'),
    chips: [{ text: g.title }],
    why: [t('Why: {why}', { why: g.quote ? t('you said “{quote}”', { quote: g.quote }) : t(g.why) }), t('She checks in now and then (you pick how often) and never more than your messages a day. Nothing starts until you say Use it.')],
    body,
    buttons: [
      { label: t('Use it'), onClick: () => decide('use') },
      { label: t('Edit first'), cls: 'ghost', onClick: () => (editor.hidden = !editor.hidden) },
      { label: t('Not now'), cls: 'ghost', onClick: () => decide('not-now') },
      { label: t('Never for this'), cls: 'ghost', onClick: () => decide('never') },
    ],
  });
}

function historyRow(x) {
  const li = el('li', `ag-hist ${x.status}`);
  const top = el('div', 'ag-hist-top');
  top.append(el('span', `ag-chip st-${x.status}`, t(STATUS[x.status] ?? x.status)), el('span', 'muted small', whenWords(x.updatedAt)));
  li.append(top, raw(el('p', 'ag-what small', x.what)));
  if (x.note && x.status !== 'expired') li.append(el('p', 'muted small', t(x.note)));
  if (x.research) li.append(raw(el('p', 'muted small ag-research', x.research)));
  if (x.messageId && x.sentConversation) li.append(button('ghost small', t('Open the message'), () => ctx.openConversation?.(x.sentConversation)));
  return li;
}

function renderSettings() {
  if (!view) return;
  const s = view.settings;
  const sh = view.shared;
  const set = (id, v) => {
    const n = $(`#${id}`);
    if (!n) return;
    if (n.type === 'checkbox') n.checked = Boolean(v);
    else n.value = String(v);
    const out = $(`#${id}-n`);
    if (out) out.textContent = outText(id, n.value);
  };
  set('ag-goals', s.goals);
  set('ag-follow', s.followUps);
  set('ag-research', s.research);
  set('ag-max', sh.maxPerDay);
  set('ag-gap', sh.minGapHours);
  set('ag-qs', sh.quietStart);
  set('ag-qe', sh.quietEnd);
  set('ag-tokens', s.budgetTokens);
  set('ag-usd', s.budgetUsd);
  const r = $('#ag-research');
  if (r) r.disabled = !view.researchAvailable && !s.research;
  const rn = $('#ag-research-note');
  if (rn) rn.hidden = view.researchAvailable;
}

function outText(id, v) {
  const n = Number(v);
  if (id === 'ag-tokens') return kTokens(n);
  if (id === 'ag-usd') return `$${n.toFixed(2)}`;
  if (id === 'ag-qs' || id === 'ag-qe') return new Date(2026, 0, 1, n).toLocaleTimeString(locale(), { hour: 'numeric' });
  return String(n);
}

function renderPanel() {
  const panel = $('#ag-panel');
  if (!panel) return;
  if (!view) {
    $('#ag-state').textContent = t('Her plans are not available here.');
    return;
  }
  const on = view.settings.enabled;
  const sw = $('#ag-switch');
  sw.setAttribute('aria-checked', String(on));
  sw.classList.toggle('on', on);
  panel.classList.toggle('ag-off', !on);
  $('#ag-switch-state').textContent = on ? t('Switched on') : t('Switched off');
  $('#ag-state').textContent = on
    ? t('She keeps her own plans: follow-ups on what you tell her and goals you keep at together. Everything she does on her own is listed here, within your limits.')
    : t('Off. She plans nothing and sends nothing on her own beyond her usual first messages. Planned items wait here as paused.');
  const pause = $('#ag-pause');
  pause.hidden = !view.crisisPauseUntil;
  if (view.crisisPauseUntil) pause.textContent = t('Paused after a hard conversation until {when}: at most one gentle check-in.', { when: whenWords(view.crisisPauseUntil) });
  renderMeters();
  // Proposals first (nothing she adds on her own is used until you say so).
  const asks = $('#ag-asks');
  const proposed = view.goals.filter((g) => g.status === 'proposed');
  asks.replaceChildren(...proposed.map((g) => goalProposal(g)));
  asks.hidden = !proposed.length;
  const items = view.items;
  const list = $('#ag-items');
  list.replaceChildren(...(items.length ? items.map((x) => itemRow(x)) : [el('p', 'muted small ag-empty', on ? t('Nothing planned yet. When you mention something coming up, she may plan to ask how it went.') : t('Nothing planned.'))]));
  const goals = view.goals.filter((g) => g.status !== 'proposed');
  $('#ag-goal-list').replaceChildren(...(goals.length ? goals.map(goalCard) : [el('p', 'muted small ag-empty', t('No goals yet. Add one, or tell her what you want to keep at.'))]));
  const hist = $('#ag-history');
  hist.replaceChildren(...(view.history.length ? view.history.map(historyRow) : [el('li', 'muted small ag-empty', t('Nothing yet.'))]));
  renderSettings();
  if (focusItem) {
    const row = list.querySelector(`[data-id="${focusItem}"]`);
    row?.scrollIntoView({ block: 'center' });
    focusItem = null;
  }
}

/** Opens Planner → Her plans (from Today, the chat or a notification), optionally at one plan. */
export async function openHerPlans(itemId) {
  focusItem = itemId ?? null;
  await ctx?.openPlanner?.('agenda');
}

// ---------- the chat: the why line and the "Added to her plans" note ----------

/** Under a message she wrote from her plans: "Why I'm writing: you said “…”" (tap → the plan). */
export function agendaWhy(meta) {
  const b = el('button', 'ag-why-line small');
  b.type = 'button';
  b.textContent = t("Why I'm writing: {why}", { why: whyText(meta) });
  b.dataset.raw = '';
  if (meta?.itemId) b.addEventListener('click', () => void openHerPlans(meta.itemId));
  else b.disabled = true;
  return b;
}

/** The note after her reply when she added a plan (or suggests a goal). */
export function agendaNotice(m) {
  const a = m.meta?.agenda ?? {};
  if (a.added === 'goal') {
    const g = view?.goals?.find((x) => x.id === a.goalId);
    if (g && g.status === 'proposed') return goalProposal(g, () => void loadAgenda());
    const wrap = el('div', 'ag-note');
    wrap.append(el('span', 'ag-note-k', t('She suggested a goal')), raw(el('span', 'ag-note-what', a.title ?? '')));
    if (!view) void loadAgenda();
    wrap.append(button('ghost small', t('See her plans'), () => void openHerPlans()));
    return wrap;
  }
  const wrap = el('div', 'ag-note');
  wrap.append(el('span', 'ag-note-k', t('Added to her plans')), raw(el('span', 'ag-note-what', a.what ?? '')), el('span', 'muted small', a.dueAt ? whenWords(a.dueAt) : ''));
  wrap.append(button('ghost small', t('See her plans'), () => void openHerPlans(a.itemId)));
  return wrap;
}

// ---------- Today ----------

/** Today's "Her plans" tile: today's reach-outs with times and reasons, goals, the shared count and budget. */
export function renderPlansTile(p, head) {
  const tile = $('#td-plans');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  head(tile, t('Her plans'), p.proposals ? el('span', 'td-count td-needs', t('{n} need you', { n: p.proposals })) : null);
  const body = tile.querySelector('.td-body');
  const out = [el('p', 'muted small td-ag-usage', t('{a} of {b} messages today · {c} of {d} tokens', { a: p.messages, b: p.maxPerDay, c: kTokens(p.tokens), d: kTokens(p.budgetTokens) }))];
  if (!p.on) out.push(el('p', 'muted small', t('Her plans are off. Planned items wait as paused.')));
  if (p.proposals) {
    const b = button('ghost today-item td-ag-item needs', '', () => void openHerPlans());
    b.append(el('span', 'td-ag-what', t('She suggests a goal: say yes or no on Her plans')));
    out.push(b);
  }
  if (p.later) out.push(el('h4', 'td-bd-h', t('Coming up')));
  for (const x of p.items) {
    const row = el('div', 'td-ag-row');
    const main = button('ghost today-item td-ag-item', '', () => void openHerPlans(x.id));
    main.append(el('span', 'td-ag-time', whenWords(x.dueAt)), raw(el('span', 'td-ag-what', x.what)), raw(el('span', 'muted small td-ag-why', whyText(x))));
    const acts = el('div', 'td-ag-acts');
    acts.append(
      button('ghost small', t('Edit time'), () => void openHerPlans(x.id)),
      button('ghost small', t('Change what'), () => void openHerPlans(x.id)),
      button('ghost small', t('Cancel it'), async () => {
        await ctx.api(`/agenda/items/${x.id}`, { method: 'PUT', body: { cancel: true } });
        ctx.refreshToday?.();
      }),
    );
    row.append(main, acts);
    out.push(row);
  }
  for (const x of p.expired ?? []) {
    const r = el('p', 'muted small td-ag-skipped');
    r.append(el('span', '', `${t('Skipped: the day was full')} · `), raw(el('span', '', x.what)));
    out.push(r);
  }
  if (p.goals.length) {
    out.push(el('h4', 'td-bd-h', t('Goals')));
    for (const g of p.goals) {
      const row = el('div', 'td-ag-row');
      const main = button('ghost today-item td-ag-item', '', () => void openHerPlans());
      main.append(raw(el('span', 'td-ag-what', g.title)), el('span', 'muted small td-ag-why', g.status === 'paused' ? t('Paused') : g.next ? t('Next check-in: {when}', { when: whenWords(g.next) }) : t('No check-in planned')));
      const acts = el('div', 'td-ag-acts');
      if (g.status === 'active') acts.append(button('ghost small', t('Pause'), async () => (await ctx.api(`/agenda/goals/${g.id}`, { method: 'PUT', body: { status: 'paused' } }), ctx.refreshToday?.())));
      acts.append(button('ghost small', t('Done'), async () => (await ctx.api(`/agenda/goals/${g.id}`, { method: 'PUT', body: { status: 'done' } }), ctx.refreshToday?.())));
      row.append(main, acts);
      out.push(row);
    }
  }
  if (!p.items.length && !p.goals.length && p.on && !p.proposals) out.push(el('p', 'muted small', t('Nothing planned for today.')));
  body.replaceChildren(...out);
}

// ---------- wiring ----------

export function agendaEvent() {
  if (!$('#ag-panel')?.hidden) void loadAgenda();
}

export function initAgenda(c) {
  ctx = c;
  const sw = $('#ag-switch');
  if (!sw) return;
  sw.addEventListener('click', () => {
    const on = sw.getAttribute('aria-checked') === 'true';
    void act(() => (on ? call('/off', 'POST') : call('', 'PUT', { enabled: true })), on ? t('Stopped. Nothing more will be sent from her plans.') : t('On. She keeps her own plans now.'));
  });
  const save = (patch) => act(() => call('', 'PUT', patch), t('Saved.'));
  $('#ag-goals')?.addEventListener('change', (e) => save({ goals: e.target.checked }));
  $('#ag-follow')?.addEventListener('change', (e) => save({ followUps: e.target.checked }));
  $('#ag-research')?.addEventListener('change', (e) => save({ research: e.target.checked }));
  for (const [id, key, shared] of [['ag-max', 'maxPerDay', true], ['ag-gap', 'minGapHours', true], ['ag-qs', 'quietStart', true], ['ag-qe', 'quietEnd', true], ['ag-tokens', 'budgetTokens', false], ['ag-usd', 'budgetUsd', false]]) {
    const n = $(`#${id}`);
    if (!n) continue;
    n.addEventListener('input', () => {
      const out = $(`#${id}-n`);
      if (out) out.textContent = outText(id, n.value);
    });
    n.addEventListener('change', () => save(shared ? { shared: { [key]: Number(n.value) } } : { [key]: Number(n.value) }));
  }
  $('#ag-clear')?.addEventListener('click', async () => {
    if (!(await (ctx.confirm ?? ((m) => Promise.resolve(window.confirm(m))))(t('Clear her plans? Planned items are removed and goals are dropped. What she already sent stays.')))) return;
    void act(() => call('/clear', 'POST'), t('Cleared.'));
  });
  $('#ag-add')?.addEventListener('click', () => {
    const what = $('#ag-new-what').value.trim();
    const when = new Date($('#ag-new-when').value);
    void act(async () => {
      if (!what) throw new Error(t('Say what the plan is.'));
      if (Number.isNaN(when.getTime())) throw new Error(t('Pick a time that is still to come.'));
      await call('/items', 'POST', { what, dueAt: when.toISOString() });
      $('#ag-new-what').value = '';
    }, t('Added to her plans.'));
  });
  $('#ag-goal-add')?.addEventListener('click', () => {
    const title = $('#ag-goal-title').value.trim();
    void act(async () => {
      if (!title) throw new Error(t('Give the goal a name.'));
      await call('/goals', 'POST', { title, checkEvery: $('#ag-goal-every').value, endsOn: $('#ag-goal-ends').value || null });
      $('#ag-goal-title').value = '';
    }, t('Added to her plans.'));
  });
  $('#ag-run')?.addEventListener('click', () => {
    void act(async () => {
      const r = await call('/tick', 'POST');
      const res = r?.result ?? {};
      status(res.sent ? t('She sent one planned message.') : res.planned ? t('She added to her plans.') : res.skipped ? t('Nothing to send now ({why}).', { why: t(SKIP[String(res.skipped).split(' (')[0]] ?? 'Not now') }) : t('Nothing to send now.'));
    });
  });
}
