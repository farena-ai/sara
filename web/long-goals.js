// S3 (docs/GOALS.md "Goals over days"): the Goals page (a place in the sidebar) and its Today tile.
// Each goal: progress bar, the next step, its milestones (tick one off, add one, move a date), what
// each milestone started (a task, reminder, errand or automation), a proposed new plan as a proposal
// card (only used when the person presses it) and the history. Nothing here calls a model.
import { t } from './naming.js';
import { proposalCard } from './proposal-card.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => void, openErrands?: () => void } | null} */
let ctx = null;
let data = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#gl-status');
  if (s) s.textContent = msg;
};
const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
export const GOAL_WORDS = () => ({ active: t('On its way'), paused: t('Paused'), done: t('Done'), stopped: t('Stopped') });
const LINK_WORDS = () => ({ task: t('Task'), reminder: t('Reminder'), errand: t('Errand'), automation: t('Automation') });
const KIND_OPTIONS = () => [['none', t('Just a checkpoint')], ['task', t('A task')], ['reminder', t('A reminder')], ['errand', t('An errand')]];

export function initGoals(c) {
  ctx = c;
  $('#gl-add')?.addEventListener('click', () => void addGoal());
  $('#gl-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addGoal();
    }
  });
}

/** U3.19: an Ask hit opened here: the item outlined and scrolled into view. */
function spot(node) {
  if (!node) return;
  node.classList.add('ask-spot');
  node.scrollIntoView?.({ block: 'center' });
  setTimeout(() => node.classList.remove('ask-spot'), 4000);
}

/** Opens Goals; from an Ask hit, at the goal. */
export async function openGoals(id) {
  await loadGoals();
  if (!$('#goals').open) $('#goals').showModal();
  if (id) spot($(`#gl-list [data-goal="${Number(id)}"]`));
}

export async function loadGoals() {
  if (!ctx) return;
  try {
    data = await ctx.api('/goal-plans');
  } catch (err) {
    say(err.message);
    return;
  }
  render();
}

async function addGoal() {
  const title = $('#gl-title')?.value.trim();
  if (!title) return say(t('Say what you want done, like “get my house sale paperwork done”.'));
  const due = $('#gl-due')?.value || undefined;
  try {
    await ctx.api('/goal-plans', { method: 'POST', body: { title, ...(due ? { due } : {}) } });
    $('#gl-title').value = '';
    $('#gl-due').value = '';
    say(t('Set up with three checkpoints. Change them below, or ask her in a chat for a fuller plan.'));
    await loadGoals();
  } catch (err) {
    say(err.message);
  }
}

async function act(id, what, method = 'POST', body = {}) {
  try {
    await ctx.api(what ? `/goal-plans/${id}/${what}` : `/goal-plans/${id}`, { method, body });
    await loadGoals();
  } catch (err) {
    say(err.message);
  }
}

function chip(status) {
  return el('span', `er-chip gl-chip gl-${status}`, GOAL_WORDS()[status] ?? status);
}

function bar(pct) {
  const p = el('progress', 'gl-bar');
  p.max = 100;
  p.value = pct;
  p.setAttribute('aria-label', t('{pct}% done', { pct }));
  return p;
}

/** The proposed new plan, on the shared proposal card. Only the person uses it. */
function proposalOf(g) {
  const p = g.proposal;
  const ul = el('ul', 'gl-moves small');
  for (const m of p.moves) ul.append(el('li', '', `${g.milestones[m.index]?.text ?? ''}: ${m.from ? day(m.from) : '—'} → ${day(m.to)}`));
  if (p.due) ul.append(el('li', 'gl-move-due', t('The goal’s date: {from} → {to}', { from: day(p.due.from), to: day(p.due.to) })));
  const card = proposalCard({
    title: t('A new plan'),
    why: [p.why],
    body: [ul],
    buttons: [
      { label: t('Use the new plan'), onClick: () => act(g.id, 'accept') },
      { label: t('Keep the old plan'), cls: 'ghost', onClick: () => act(g.id, 'dismiss') },
    ],
  });
  card.classList.add('gl-proposal');
  return card;
}

function milestones(g) {
  const ol = el('ol', 'gl-ms');
  g.milestones.forEach((m, i) => {
    const li = el('li', `gl-m gl-m-${m.status}`);
    const box = el('input', 'gl-m-box');
    box.type = 'checkbox';
    box.checked = m.status === 'done';
    box.disabled = m.status === 'skipped' || g.status === 'stopped';
    box.setAttribute('aria-label', t('Done: {step}', { step: m.text }));
    box.addEventListener('change', () => void act(g.id, '', 'PATCH', box.checked ? { done: i } : { undone: i }));
    const text = el('span', 'gl-m-text', m.text);
    const meta = el('span', 'gl-m-meta small muted', [m.due ? day(m.due) : '', m.link ? `${LINK_WORDS()[m.link.kind] ?? m.link.kind} #${m.link.id}` : ''].filter(Boolean).join(' · '));
    li.append(box, text, meta);
    if (m.link?.kind === 'errand' && ctx.openErrands) li.append(btn(t('Open Errands'), 'linkish small', () => ctx.openErrands()));
    ol.append(li);
  });
  return ol;
}

function addRow(g) {
  const row = el('div', 'gl-add-m');
  const text = el('input', 'gl-m-new');
  text.maxLength = 200;
  text.placeholder = t('Add a milestone');
  text.setAttribute('aria-label', text.placeholder);
  const due = el('input', 'gl-m-due');
  due.type = 'date';
  due.setAttribute('aria-label', t('Due'));
  const kind = el('select', 'gl-m-kind');
  kind.setAttribute('aria-label', t('What it starts'));
  for (const [v, label] of KIND_OPTIONS()) kind.append(Object.assign(document.createElement('option'), { value: v, textContent: label }));
  const add = btn(t('Add'), 'ghost small', () => {
    if (!text.value.trim()) return;
    void act(g.id, '', 'PATCH', { addMilestone: { text: text.value.trim(), ...(due.value ? { due: due.value } : {}), kind: kind.value } });
  });
  row.append(text, due, kind, add);
  return row;
}

function card(g) {
  const c = el('article', `gl-card gl-card-${g.status}`);
  c.dataset.goal = String(g.id);
  const head = el('div', 'gl-head');
  head.append(el('strong', 'gl-title', g.title), chip(g.status));
  const p = g.progress ?? { done: 0, total: g.milestones.length, pct: 0 };
  c.append(head, el('p', 'gl-meta small muted', [t('{done} of {total} milestones', { done: p.done, total: p.total }), g.due ? t('by {when}', { when: day(g.due) }) : ''].filter(Boolean).join(' · ')), bar(p.pct));
  const next = g.milestones.find((m) => m.status === 'todo');
  if (next && g.status !== 'stopped') {
    const n = el('p', 'gl-next small');
    n.append(el('span', 'gl-next-h', `${t('Next step')}: `), document.createTextNode(`${next.text}${next.due ? ` (${day(next.due)})` : ''}`));
    c.append(n);
  }
  if (g.proposal) c.append(proposalOf(g));
  c.append(milestones(g));
  if (g.status === 'active' || g.status === 'paused') c.append(addRow(g));
  const row = el('div', 'gl-actions');
  if (g.status === 'active') row.append(btn(t('Pause'), 'ghost small', () => void act(g.id, 'pause')));
  if (g.status === 'paused') row.append(btn(t('Resume'), 'small', () => void act(g.id, 'resume')));
  if (g.status === 'active' || g.status === 'paused') row.append(btn(t('Stop'), 'ghost small danger-text', () => void act(g.id, 'stop')));
  if (g.conversationId && ctx.openConversation) row.append(btn(t('Open its chat'), 'ghost small', () => ctx.openConversation(g.conversationId)));
  if (g.status === 'done' || g.status === 'stopped') row.append(btn(t('Delete'), 'ghost small danger-text', () => void act(g.id, '', 'DELETE')));
  c.append(row);
  const hist = el('details', 'gl-history');
  hist.append(el('summary', 'small', t('History')));
  const ul = el('ul', 'gl-log small muted');
  for (const x of g.history.slice(-12).reverse()) ul.append(el('li', '', `${new Date(x.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · ${x.text}`));
  hist.append(ul);
  c.append(hist);
  return c;
}

function render() {
  const list = $('#gl-list');
  if (!list || !data) return;
  const order = { active: 0, paused: 1, done: 2, stopped: 3 };
  const all = [...data.goals].sort((a, b) => Number(!!b.proposal) - Number(!!a.proposal) || (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id - a.id);
  if (!all.length) list.replaceChildren(el('p', 'empty muted', t('No goals yet. Add one above, or tell her something like “get my house sale paperwork done by Dec 15”.')));
  else list.replaceChildren(...all.map(card));
  const n = $('#gl-proposals');
  if (n) {
    n.hidden = !data.proposals;
    n.textContent = t('New plans to look at: {n}', { n: data.proposals });
  }
}

/** Today: active goals with progress and the next step (none active: no tile). */
export function renderGoalsTile(p, tileHead) {
  const tile = $('#td-goals');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Goals'));
  const list = el('ul', 'td-biz gl-tile');
  for (const x of p.items) {
    const li = el('li', 'small gl-tile-item');
    const top = el('div', 'gl-tile-top');
    top.append(el('span', 'gl-tile-title', x.title), el('span', 'muted', t('{done} of {total}', { done: x.done, total: x.total })));
    li.append(top, bar(x.pct));
    if (x.proposal) li.append(el('span', 'gl-tile-plan', t('A new plan is waiting')));
    else if (x.next) li.append(el('span', 'muted', `${t('Next step')}: ${x.next}${x.nextDue ? ` (${day(x.nextDue)})` : ''}`));
    list.append(li);
  }
  const go = btn(p.proposals ? t('Open Goals to look at the new plan') : t('Open Goals'), 'ghost small', () => void openGoals());
  tile.querySelector('.td-body').replaceChildren(list, go);
}
