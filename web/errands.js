// R3 (docs/ERRANDS.md): the Errands page (a place in the sidebar) and its Today tile. Each errand: its
// status, progress, "what she needs from you" with the right answer box (a choice, an address, a
// note), Approve step / Skip / Stop / Edit, and the timeline with each step's result and evidence.
// Only here can the person turn on "send without asking" for one errand. Nothing here calls a model.
import { t } from './naming.js';
import { openHandle } from './handle-it.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => void } | null} */
let ctx = null;
let data = null;
const editing = new Set();

export function initErrands(c) {
  ctx = c;
  $('#er-plan')?.addEventListener('click', () => void planNew());
  $('#er-goal')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void planNew();
    }
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
const say = (msg) => {
  const s = $('#er-status');
  if (s) s.textContent = msg;
};
export const STATUS_WORDS = () => ({ planning: t('Planning'), working: t('Working'), waiting_you: t('Waiting on you'), waiting_others: t('Waiting on others'), done: t('Done'), stopped: t('Stopped') });
const STEP_MARK = { todo: '○', waiting_you: '!', waiting_others: '…', done: '✓', skipped: '–' };
const KIND_WORDS = () => ({ research: t('Look up'), message: t('Email'), form: t('Form'), browser: t('Browser'), call: t('Call'), purchase: t('Payment'), wait: t('Wait'), decide: t('Decide') });
const EVIDENCE_WORDS = () => ({ verified: t('Verified'), unverified: t('Not verified'), read: t('Read only') });

export async function openErrands() {
  await loadErrands();
  if (!$('#errands').open) $('#errands').showModal();
}

export async function loadErrands() {
  try {
    data = await ctx.api('/errands');
  } catch (err) {
    say(err.message);
    return;
  }
  const sel = $('#er-template');
  if (sel && sel.options.length <= 1) for (const x of data.templates) sel.append(Object.assign(document.createElement('option'), { value: x.id, textContent: x.name, title: x.pitch }));
  render();
}

async function planNew() {
  const goal = $('#er-goal')?.value.trim();
  if (!goal) return say(t('Say what she should take care of, like “get the Acme charge refunded”.'));
  try {
    await ctx.api('/errands', { method: 'POST', body: { goal, ...($('#er-template')?.value ? { template: $('#er-template').value } : {}) } });
    $('#er-goal').value = '';
    say(t('Planned. Check the steps, then press Start.'));
    await loadErrands();
  } catch (err) {
    say(err.message);
  }
}

async function act(id, what, body = {}) {
  try {
    await ctx.api(`/errands/${id}/${what}`, { method: 'POST', body });
    await loadErrands();
  } catch (err) {
    say(err.message);
  }
}

function chip(status) {
  const c = el('span', `er-chip er-${status}`, STATUS_WORDS()[status] ?? status);
  return c;
}

function timeline(e) {
  const ol = el('ol', 'er-steps');
  for (const s of e.steps) {
    const li = el('li', `er-step er-step-${s.status}`);
    const head = el('div', 'er-step-head');
    head.append(el('span', 'er-mark', STEP_MARK[s.status] ?? '○'), el('span', 'er-kind', KIND_WORDS()[s.kind] ?? s.kind), el('span', 'er-text', s.text));
    li.append(head);
    if (s.result) li.append(el('p', 'er-result small', s.result.length > 300 ? `${s.result.slice(0, 299)}…` : s.result));
    if (s.evidence) {
      const ev = el('p', `er-evidence small er-ev-${s.evidence.verified}`, `${EVIDENCE_WORDS()[s.evidence.verified] ?? ''}: ${s.evidence.line ?? ''}`);
      li.append(ev);
    }
    ol.append(li);
  }
  return ol;
}

/** The answer box for what she needs: a choice, an address, a note; then Approve step / Skip. */
function needsBox(e) {
  const s = e.steps.find((x) => x.status === 'waiting_you');
  const box = el('div', 'er-needs');
  box.append(el('h4', 'er-needs-h', t('What she needs from you')), el('p', 'er-needs-text', e.needs ?? ''));
  let input = null;
  if (s?.pending === 'decide' && s.options?.length) {
    input = el('select', 'er-choice');
    input.setAttribute('aria-label', t('Your choice'));
    for (const o of s.options) input.append(Object.assign(document.createElement('option'), { value: o, textContent: o }));
  } else if (s?.pending === 'decide' || s?.pending === 'address' || s?.pending === 'call' || s?.pending === 'purchase' || s?.pending === 'confirm') {
    input = el('input', 'er-answer');
    input.type = s.pending === 'address' ? 'email' : 'text';
    input.placeholder = s.pending === 'address' ? t('their@email.address') : s.pending === 'decide' ? t('Your choice') : t('A note (optional): what happened');
    input.setAttribute('aria-label', input.placeholder);
  }
  if (input) box.append(input);
  const label = s?.pending === 'send' || s?.pending === 'follow_up' ? t('Approve and send') : s?.pending === 'call' || s?.pending === 'purchase' || s?.pending === 'confirm' ? t('Done') : t('Approve step');
  const go = btn(label, 'small', () => {
    const v = input?.value?.trim() ?? '';
    const body = s?.pending === 'decide' ? { choice: v } : s?.pending === 'address' ? { to: v } : v ? { note: v } : {};
    void act(e.id, 'approve', body);
  });
  go.dataset.act = 'approve';
  const row = el('div', 'er-row');
  row.append(go, btn(t('Skip'), 'ghost small', () => void act(e.id, 'skip')));
  box.append(row);
  return box;
}

function editBox(e) {
  const box = el('div', 'er-edit');
  const deadline = el('input', 'er-deadline');
  deadline.type = 'date';
  deadline.value = e.deadline?.slice(0, 10) ?? '';
  deadline.setAttribute('aria-label', t('Deadline'));
  const budget = el('input', 'er-budget');
  budget.type = 'number';
  budget.min = '0';
  budget.step = '1';
  budget.value = e.budget ?? '';
  budget.setAttribute('aria-label', t('Budget (US dollars)'));
  const note = el('input', 'er-note');
  note.placeholder = t('A note for her (what changed)');
  note.setAttribute('aria-label', note.placeholder);
  const auto = el('input', 'er-auto');
  auto.type = 'checkbox';
  auto.checked = e.sendWithoutAsking;
  const autoLabel = el('label', 'er-auto-label small');
  autoLabel.append(auto, document.createTextNode(` ${t('Send this errand’s emails without asking me (never payments)')}`));
  const l1 = el('label', 'small', `${t('Deadline')} `);
  l1.append(deadline);
  const l2 = el('label', 'small', `${t('Budget (US dollars)')} `);
  l2.append(budget);
  const save = btn(t('Save'), 'small', async () => {
    try {
      await ctx.api(`/errands/${e.id}`, { method: 'PATCH', body: { deadline: deadline.value || null, budget: budget.value === '' ? null : Number(budget.value), sendWithoutAsking: auto.checked, ...(note.value.trim() ? { note: note.value.trim() } : {}) } });
      editing.delete(e.id);
      await loadErrands();
    } catch (err) {
      say(err.message);
    }
  });
  box.append(l1, l2, note, autoLabel, save);
  return box;
}

function card(e) {
  const c = el('article', `er-card er-card-${e.status}`);
  c.dataset.errand = String(e.id);
  const head = el('div', 'er-head');
  const done = e.steps.filter((s) => s.status === 'done').length;
  head.append(el('strong', 'er-goal', e.goal), chip(e.status));
  const meta = [t('{done} of {total} steps', { done, total: e.steps.length }), e.deadline ? t('by {when}', { when: e.deadline }) : '', e.budget !== null ? t('budget {amount}', { amount: `$${e.budget}` }) : '', e.sendWithoutAsking ? t('sends without asking') : ''].filter(Boolean).join(' · ');
  c.append(head, el('p', 'er-meta small muted', meta));
  const bar = el('div', 'er-bar');
  const fill = el('span', 'er-bar-fill');
  fill.dataset.pct = String(Math.round((done / Math.max(1, e.steps.length)) * 10) * 10);
  bar.append(fill);
  c.append(bar);
  if (e.status === 'waiting_you') c.append(needsBox(e));
  const next = e.steps.find((s) => s.status === 'todo' || s.status === 'waiting_others');
  if (next && e.status !== 'waiting_you' && e.status !== 'done' && e.status !== 'stopped') c.append(el('p', 'er-next small', `${t('Next')}: ${next.text}`));
  if (e.summary) c.append(el('p', 'er-summary small', e.summary));
  const row = el('div', 'er-actions');
  if (e.status === 'planning') row.append(btn(t('Start'), 'small', () => void act(e.id, 'start')));
  if (e.status !== 'done' && e.status !== 'stopped') {
    row.append(btn(t('Edit'), 'ghost small', () => (editing.has(e.id) ? editing.delete(e.id) : editing.add(e.id), render())));
    row.append(btn(t('Stop'), 'ghost small danger-text', () => void act(e.id, 'stop')));
  }
  // W4.1: a Handle it run opens its progress card (Pause/Resume, its stops, receipts).
  if (e.facts?.handleKind) row.append(btn(e.paused ? t('Paused: open progress') : t('Open progress'), 'ghost small', () => void openHandle(e.id)));
  if (e.conversationId && ctx.openConversation) row.append(btn(t('Open its chat'), 'ghost small', () => ctx.openConversation(e.conversationId)));
  c.append(row);
  if (editing.has(e.id)) c.append(editBox(e));
  const tl = el('details', 'er-timeline');
  tl.open = e.status === 'waiting_you' || e.status === 'planning';
  tl.append(el('summary', 'small', t('Timeline')), timeline(e));
  if (e.log.length) {
    const log = el('ul', 'er-log small muted');
    for (const x of e.log.slice(-8)) log.append(el('li', '', `${new Date(x.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · ${x.text}`));
    tl.append(log);
  }
  c.append(tl);
  return c;
}

function render() {
  const list = $('#er-list');
  if (!list || !data) return;
  const order = { waiting_you: 0, planning: 1, working: 2, waiting_others: 3, done: 4, stopped: 5 };
  const all = [...data.errands].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id - a.id);
  if (!all.length) list.replaceChildren(el('p', 'empty muted', t('No errands yet. Tell her a goal, like “book an oil change this week”.')));
  else list.replaceChildren(...all.map(card));
  const n = $('#er-needs-count');
  if (n) {
    n.hidden = !data.needYou;
    n.textContent = t('{n} waiting on you', { n: data.needYou });
  }
}

/** Today: open errands, the ones waiting on you first (no open errand: no tile). */
export function renderErrandsTile(p, tileHead) {
  const tile = $('#td-errands');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Errands'));
  const list = el('ul', 'td-biz er-tile');
  for (const x of p.items) {
    const li = el('li', 'small');
    li.append(chip(x.status), document.createTextNode(` ${x.goal}`));
    if (x.needs) li.append(el('span', 'er-tile-needs', ` · ${x.needs}`));
    else if (x.next) li.append(el('span', 'muted', ` · ${x.next}`));
    list.append(li);
  }
  const go = btn(p.needYou ? t('{n} waiting on you: open Errands', { n: p.needYou }) : t('Open Errands'), 'ghost small', () => void openErrands());
  tile.querySelector('.td-body').replaceChildren(list, go);
}
