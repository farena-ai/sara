// W3.4 (docs/design/W3WORKFORCE.md): Team → Goals and weekly plan. Workers get goals with one simple
// measure and a budget cap; at the cap their goal jobs wait and she asks you once. A goal can pass
// work along a chain of workers (one's output is the next one's job). Each week the workers propose
// a plan you approve or change in one card. Nothing here calls a model by itself.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => Promise<void> } | null} */
let ctx = null;
let data = null;
let workers = [];
let editing = null;
let edits = {};
let added = [];
let open = new Set();

export function initGoals(c) {
  ctx = c;
}
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const usd = (n) => (n > 0 && n < 0.01 ? '<$0.01' : `$${Number(n).toFixed(2)}`);
const num = (n) => Number(n).toLocaleString();
const PER = { week: () => t('this week'), total: () => t('in total') };
const STATE = { on: () => t('On'), capped: () => t('At its cap: waiting for you'), paused: () => t('Paused') };

/** Called from loadWorkers (web/workers.js) with the workers list it already has. */
export async function loadGoals(list) {
  const host = $('#wgoals');
  if (!ctx || !host) return;
  if (list) workers = list;
  try {
    data = await ctx.api('/workers/goals');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.status === 403 ? t('Only the owner of this server can use this.') : e.message));
    return;
  }
  const rows = [planBox()];
  if (!data.goals.length && !editing) rows.push(el('p', 'muted small', workers.length ? t('No goals yet. Give a worker a goal with something to count and a budget cap.') : t('Make a worker first, then give it a goal.')));
  for (const g of data.goals) rows.push(goalCard(g));
  if (editing) rows.push(goalForm(editing));
  else if (workers.length) {
    const acts = el('div', 'rt-more-acts');
    acts.append(btn(t('New goal'), 'ghost small', () => {
      editing = { workerId: workers[0].id, kind: 'jobs', target: 1, period: 'week', chain: [] };
      void loadGoals();
    }));
    rows.push(acts);
  }
  host.replaceChildren(...rows);
}

async function act(path, method = 'POST', body = {}) {
  try {
    const r = await ctx.api(path, { method, ...(method === 'DELETE' ? {} : { body }) });
    await loadGoals();
    return r;
  } catch (e) {
    alert(e.message);
    await loadGoals();
    return null;
  }
}

const nameOf = (id) => workers.find((w) => w.id === id)?.name ?? '?';
const goalOf = (id) => data.goals.find((g) => g.id === id);

// ── This week's plan ─────────────────────────────────────────────────────

function planBox() {
  const box = el('div', 'wg-plan');
  const h = el('h4', '', t('This week’s plan'));
  h.append(tip(t('Each week (on the weekly report’s day and hour) your workers propose jobs for their goals. Change titles, untick what you don’t want, add jobs, then approve once. Nothing starts before that.')));
  box.append(h);
  const p = data.plan;
  const status = el('p', 'muted small wg-status');
  status.setAttribute('role', 'status');
  if (!p || p.state !== 'proposed') {
    if (p?.state === 'approved') box.append(el('p', 'muted small', t('Approved: {n} jobs were queued.', { n: p.made })));
    else if (p?.state === 'skipped') box.append(el('p', 'muted small', t('You skipped this week’s plan.')));
    else box.append(el('p', 'muted small', t('No plan yet. One comes each week while a goal is on.')));
    if (data.goals.length) {
      const acts = el('div', 'rt-more-acts');
      acts.append(btn(t('Propose a plan now'), 'ghost small', () => void act('/workers/plan/propose')));
      box.append(acts);
    }
    return box;
  }
  const list = el('ul', 'wg-plan-list');
  let total = 0;
  for (const it of p.items) {
    const e = (edits[it.key] ??= { title: it.title, skip: false });
    const li = el('li', `wg-item${e.skip ? ' wg-skip' : ''}`);
    const keep = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !e.skip });
    keep.setAttribute('aria-label', t('Keep this job'));
    keep.addEventListener('change', () => {
      e.skip = !keep.checked;
      li.classList.toggle('wg-skip', e.skip);
    });
    const title = Object.assign(document.createElement('input'), { type: 'text', value: e.title, maxLength: 160 });
    title.setAttribute('aria-label', t('Job'));
    title.addEventListener('input', () => (e.title = title.value));
    const g = goalOf(it.goalId);
    const bits = [nameOf(it.workerId), g ? g.title : ''];
    if (it.estUsd) {
      bits.push(t('about {usd}', { usd: usd(it.estUsd) }));
      total += it.estUsd;
    }
    const line = el('p', 'muted small', bits.filter(Boolean).join(' · '));
    if (it.overCap) line.append(' ', el('span', 'chip waiting', t('over the cap')));
    const main = el('div', 'wg-item-main');
    main.append(title, line);
    li.append(keep, main);
    list.append(li);
  }
  for (const [i, a] of added.entries()) {
    const li = el('li', 'wg-item');
    const main = el('div', 'wg-item-main');
    main.append(el('strong', '', a.title), el('p', 'muted small', `${nameOf(goalOf(a.goalId)?.workerId)} · ${goalOf(a.goalId)?.title ?? ''}`));
    li.append(btn('×', 'ghost small', () => {
      added.splice(i, 1);
      void loadGoals();
    }), main);
    li.firstChild.setAttribute('aria-label', t('Remove'));
    list.append(li);
  }
  box.append(list);
  if (total > 0) box.append(el('p', 'muted small', t('Estimated cost: about {usd}', { usd: usd(total) })));
  // Add a job to the plan.
  const addRow = el('div', 'wg-add');
  const pick = document.createElement('select');
  pick.setAttribute('aria-label', t('Goal'));
  for (const g of data.goals) pick.append(Object.assign(document.createElement('option'), { value: String(g.id), textContent: g.title }));
  const what = Object.assign(document.createElement('input'), { type: 'text', maxLength: 160, placeholder: t('Another job for this goal') });
  what.setAttribute('aria-label', t('Another job for this goal'));
  addRow.append(tip(t('Add a job of your own to this week’s plan; it goes to the goal’s worker.')), pick, what, btn(t('Add'), 'ghost small', () => {
    if (what.value.trim().length < 3) return;
    added.push({ goalId: Number(pick.value), title: what.value.trim() });
    void loadGoals();
  }));
  if (data.goals.length) box.append(addRow);
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(t('Approve the plan'), 'primary small', async () => {
    const items = p.items.map((it) => ({ key: it.key, title: edits[it.key]?.title ?? it.title, skip: Boolean(edits[it.key]?.skip) }));
    const r = await act('/workers/plan/decide', 'POST', { approve: true, items, add: added });
    if (r) {
      edits = {};
      added = [];
      void loadGoals();
    }
  }));
  acts.append(btn(t('Skip this week'), 'ghost small', async () => {
    if (await act('/workers/plan/decide', 'POST', { approve: false })) {
      edits = {};
      added = [];
    }
  }));
  box.append(acts, status);
  return box;
}

// ── A goal ───────────────────────────────────────────────────────────────

function bar(label, value, max, text, help, spend = false) {
  const row = el('div', 'wg-bar');
  const lab = el('span', 'wg-bar-label small', label);
  lab.append(' ', tip(help));
  const m = document.createElement('meter');
  m.min = 0;
  m.max = Math.max(max || 0, value || 0) || 1;
  m.value = Math.max(0, value || 0);
  // Spend: fine low, yellow near the cap, red at it. Progress: the higher the better.
  if (max && spend) Object.assign(m, { low: max * 0.6, high: max * 0.95, optimum: 0 });
  else if (max) Object.assign(m, { low: max * 0.34, high: max * 0.67, optimum: max });
  m.setAttribute('aria-label', label);
  row.append(lab, m, el('span', 'small wg-bar-text', text));
  return row;
}

function goalCard(g) {
  const card = el('div', `rt-row wg-goal${g.state === 'on' ? '' : ' wg-held'}`);
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', g.title), el('span', `chip ${g.state === 'capped' ? 'waiting' : g.state === 'paused' ? 'muted' : 'ok'}`, STATE[g.state]?.() ?? g.state));
  card.append(head);
  card.append(el('p', 'muted small wg-chain', [g.worker, ...g.chainNames].join(' → ')));
  const p = g.progress;
  const what = p.measure || (p.kind === 'jobs' ? t('finished jobs') : '');
  const ptext = p.target ? t('{current} of {target} {what} {per}', { current: num(p.current), target: num(p.target), what, per: PER[p.period]() }) : t('{current} {what} {per}, no target', { current: num(p.current), what, per: PER[p.period]() });
  card.append(bar(t('Progress'), p.current, p.target, ptext, p.kind === 'jobs' ? t('Counts jobs that went through the whole chain (the last worker finished them).') : t('A number the worker reports with a PROGRESS line, or that you type in with Edit.')));
  const s = g.spent;
  if (g.cap.usd != null) card.append(bar(t('Spent'), s.usd, g.cap.usd, t('{spent} of {cap} {per}', { spent: usd(s.usd), cap: usd(g.cap.usd), per: PER[g.period]() }), t('Model cost of this goal’s jobs from the usage meter. At the cap its jobs wait and she asks you once.'), true));
  if (g.cap.tokens != null) card.append(bar(t('Tokens'), s.tokens, g.cap.tokens, t('{spent} of {cap} {per}', { spent: num(s.tokens), cap: num(g.cap.tokens), per: PER[g.period]() }), t('Tokens this goal’s jobs used. A running job never gets more than is left under the cap.'), true));
  if (g.cap.usd == null && g.cap.tokens == null) card.append(el('p', 'muted small', t('Spent: {usd}, {n} tokens {per} (no cap)', { usd: usd(s.usd), n: num(s.tokens), per: PER[g.period]() })));
  const bl = el('div', 'wg-blocked');
  const bh = el('strong', 'small', t('What is blocked'));
  bl.append(bh);
  if (!g.blocked.length) bl.append(el('p', 'muted small', g.waiting || g.running ? t('Nothing. {running} working, {waiting} waiting.', { running: g.running, waiting: g.waiting }) : t('Nothing.')));
  for (const b of g.blocked) bl.append(el('p', 'small wr-needs', t(b.key, b.params)));
  card.append(bl);
  if (g.chains.length) {
    const ch = el('details', 'wg-chains');
    ch.open = open.has(g.id);
    ch.addEventListener('toggle', () => (ch.open ? open.add(g.id) : open.delete(g.id)));
    ch.append(el('summary', 'small', t('Recent hand-offs ({n})', { n: g.chains.length })));
    const mark = { done: '✓', failed: '✗', running: '…', queued: '·' };
    // A step that kept the job's title shows only who did it.
    for (const c of g.chains) ch.append(el('p', 'small wg-chain-line', c.map((x, i) => (i && x.title === c[i - 1].title ? `${x.worker} ${mark[x.status] ?? ''}` : `${x.worker} ${mark[x.status] ?? ''} ${x.title}`)).join('  →  ')));
    card.append(ch);
  }
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(t('Give it a job'), 'ghost small', async () => {
    const title = prompt(t('What job toward “{goal}”?', { goal: g.title }));
    if (title?.trim()) await act(`/workers/goals/${g.id}/jobs`, 'POST', { title: title.trim(), input: '' });
  }));
  if (g.cap.usd != null || g.cap.tokens != null)
    acts.append(btn(t('Raise the cap'), g.state === 'capped' ? 'primary small' : 'ghost small', async () => {
      const dollars = g.cap.usd != null;
      const cur = dollars ? g.cap.usd : g.cap.tokens;
      const v = prompt(dollars ? t('New cap in dollars {per}:', { per: PER[g.period]() }) : t('New cap in tokens {per}:', { per: PER[g.period]() }), String(dollars ? Math.max(cur * 2, cur + 1) : cur * 2));
      if (v && Number(v) > 0) await act(`/workers/goals/${g.id}`, 'PATCH', dollars ? { capUsd: Number(v) } : { capTokens: Number(v) });
    }));
  acts.append(g.state === 'paused' ? btn(t('Resume'), 'ghost small', () => void act(`/workers/goals/${g.id}`, 'PATCH', { state: 'on' })) : btn(t('Pause'), 'ghost small', () => void act(`/workers/goals/${g.id}`, 'PATCH', { state: 'paused' })));
  acts.append(btn(t('Edit'), 'ghost small', () => {
    editing = { ...g };
    void loadGoals();
  }));
  acts.append(btn(t('Delete'), 'ghost small danger', () => {
    if (confirm(t('Delete this goal? Its jobs stay with the workers.'))) void act(`/workers/goals/${g.id}`, 'DELETE');
  }));
  card.append(acts);
  return card;
}

function goalForm(g) {
  const form = el('div', 'rt-form wg-form');
  const field = (label, input, help) => {
    const lab = el('label', 'rt-field');
    lab.append(el('span', '', label), input, tip(help));
    form.append(lab);
    return input;
  };
  const text = (value, max, ph) => Object.assign(document.createElement('input'), { type: 'text', value: value ?? '', maxLength: max, placeholder: ph ?? '' });
  const number = (value, step) => Object.assign(document.createElement('input'), { type: 'number', value: value == null ? '' : String(value), min: '0', step: String(step) });
  const select = (opts, value) => {
    const s = document.createElement('select');
    for (const [v, label] of opts) s.append(Object.assign(document.createElement('option'), { value: String(v), textContent: label, selected: String(v) === String(value ?? '') }));
    return s;
  };
  const who = workers.map((w) => [w.id, w.name]);
  const worker = field(t('Worker'), select(who, g.workerId), t('The worker that starts each job for this goal.'));
  const title = field(t('Goal'), text(g.title, 120, t('e.g. Two blog posts a week')), t('What you want, in a few words. Workers see it with their jobs.'));
  const kind = field(t('Measure'), select([['jobs', t('Finished jobs')], ['number', t('A number')]], g.kind), t('Finished jobs counts jobs the last worker in the chain finished. A number is something the worker reports (PROGRESS: 37) or you type in.'));
  const target = field(t('Target'), number(g.target ?? 0, 1), t('Where you want the measure to be. 0 = no target.'));
  const measure = field(t('Counts what'), text(g.measure, 40, t('e.g. posts')), t('A short name for what is counted, shown next to the numbers.'));
  const current = g.id ? field(t('Now at'), number(g.current ?? 0, 1), t('Set the number by hand (for a number measure).')) : null;
  const period = field(t('Counted per'), select([['week', t('Week (from Monday)')], ['total', t('Whole goal')]], g.period), t('Week starts the count and the spend again every Monday; whole goal counts from when you made it.'));
  const capUsd = field(t('Cap in dollars'), number(g.capUsd, 0.5), t('Most this goal may spend on models per period. At the cap its jobs stop and she asks you. Empty = no dollar cap.'));
  const capTokens = field(t('Cap in tokens'), number(g.capTokens, 10000), t('Most tokens this goal may use per period (local models too). Empty = no token cap.'));
  const others = [['', t('Nobody')], ...who];
  const chainSel = [0, 1, 2].map((i) => field(i ? t('Then to') : t('Then passes to'), select(others, g.chain?.[i] ?? ''), t('When a worker finishes, its output becomes the next worker’s job (for example scout → writer → editor).')));
  const every = field(t('Weekly job'), text(g.every, 160, t('e.g. Find two topics')), t('A job that goes into every weekly plan for this goal (you still approve it).'));
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(g.id ? t('Save') : t('Make the goal'), 'primary small', async () => {
    const body = { workerId: Number(worker.value), title: title.value, kind: kind.value, target: Number(target.value || 0), measure: measure.value, period: period.value, capUsd: capUsd.value ? Number(capUsd.value) : null, capTokens: capTokens.value ? Number(capTokens.value) : null, chain: chainSel.map((s) => Number(s.value)).filter(Boolean), every: every.value };
    if (current) body.current = Number(current.value || 0);
    const prev = editing;
    editing = null;
    const r = await act(g.id ? `/workers/goals/${g.id}` : '/workers/goals', g.id ? 'PATCH' : 'POST', body);
    if (!r) {
      editing = prev;
      void loadGoals();
    }
  }));
  acts.append(btn(t('Cancel'), 'ghost small', () => {
    editing = null;
    void loadGoals();
  }));
  form.append(acts);
  return form;
}
