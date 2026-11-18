// S8 (docs/AGENT_TEAMS.md): Team → Team runs, and the run's card in the chat. She proposes a plan
// (helpers with a model, tools and a budget each; parts with what they wait for; one result). The
// person edits it and approves it once; then each helper's progress, the cost so far, Pause and
// Stop show live; the scratchpad keeps findings with their sources; at the end ONE card lists every
// outside action (send, post, buy, computer use) for a single OK. Nothing here calls a model itself.
// U3.16: Team recipes: a finished run's plan saved for next time ({job} where the job text was);
// run, edit, duplicate, export/import as JSON, delete.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => Promise<void>, openTeam?: () => Promise<void> } | null} */
let ctx = null;
let data = null;
let openId = null;
let draft = null;
/** U3.16: the recipe being edited ({id, plan, name, description}) and the one with its Run box open. */
let recipeEdit = null;
let recipeRun = null;
const cards = new Map();

export function initTeamRuns(c) {
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
const acts1 = (...kids) => {
  const d = el('div', 'rt-more-acts');
  d.append(...kids);
  return d;
};
const opt = (value, label, selected) => Object.assign(document.createElement('option'), { value, textContent: label, selected });
const STATUS = {
  proposed: () => t('plan waiting for your OK'),
  running: () => t('working'),
  paused: () => t('paused'),
  waiting: () => t('waiting for your final OK'),
  done: () => t('done'),
  failed: () => t('finished with problems'),
  stopped: () => t('stopped'),
  limit: () => t('stopped at its budget'),
  interrupted: () => t('interrupted by a restart'),
};
const STEP = { waiting: () => t('waiting'), running: () => t('working'), done: () => t('done'), failed: () => t('failed'), skipped: () => t('skipped'), stopped: () => t('stopped') };
const KIND = () => ({ researcher: t('Researcher'), drafter: t('Drafter'), checker: t('Checker'), custom: t('Your own role') });
const words = (n) => Number(n || 0).toLocaleString();
const budgetLine = (p) => t('Budget up front: about {tokens} tokens and {minutes} minutes in all.', { tokens: words(p.limits.tokens), minutes: p.limits.minutes });
const cost = (r) => (r.usd > 0 ? t('about {tokens} tokens · ${usd}', { tokens: words(r.tokens), usd: r.usd.toFixed(2) }) : t('about {tokens} tokens', { tokens: words(r.tokens) }));

export async function loadTeamRuns() {
  const host = $('#truns');
  if (!ctx || !host) return;
  try {
    data = await ctx.api('/team-runs');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.status === 403 ? t('Only the owner of this server can use this.') : e.message));
    return;
  }
  const rows = [newRow(), recipesBox()];
  if (!data.runs.length) rows.push(el('p', 'muted small', t('No team runs yet. Describe a big job and she proposes a plan for you to check.')));
  for (const r of data.runs) rows.push(runRow(r));
  host.replaceChildren(...rows);
}

function newRow() {
  const box = el('div', 'rt-form trn-new');
  const goal = document.createElement('textarea');
  goal.rows = 2;
  goal.maxLength = 4000;
  goal.placeholder = t('e.g. Compare three e-bikes under $2,000 and write it up for me');
  goal.setAttribute('aria-label', t('The job'));
  const deliver = document.createElement('select');
  deliver.id = 'trn-deliver';
  for (const [v, l] of [['message', t('A message here')], ['docx', t('A Word document')], ['pdf', t('A PDF')], ['md', t('A Markdown file')]]) deliver.append(opt(v, l, v === 'message'));
  const lab = el('label', 'rt-field');
  lab.append(el('span', '', t('Result')), deliver, tip(t('One result at the end: a message in the chat, or a document in your Library with the sources listed.')));
  box.append(goal, lab, btn(t('Plan it'), 'primary small', async () => {
    const d = deliver.value;
    try {
      const r = await ctx.api('/team-runs', { method: 'POST', body: { goal: goal.value, deliver: d === 'message' ? 'message' : 'document', ...(d === 'message' ? {} : { format: d }) } });
      openId = r.run.id;
      draft = null;
      await loadTeamRuns();
    } catch (e) {
      alert(e.message);
    }
  }));
  return box;
}

function runRow(r) {
  const row = el('div', `rt-row trn-row${r.id === openId ? ' trn-open' : ''}`);
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', r.goal), el('span', `wt-state trn-st-${r.status}`, STATUS[r.status]?.() ?? r.status));
  row.append(head);
  if (!(r.status === 'proposed' && r.id === openId)) row.append(el('div', 'rt-when muted small', r.status === 'proposed' ? budgetLine(r.plan) : t('{helpers} helpers, {parts} parts · used {cost}', { helpers: r.plan.roles.length, parts: r.plan.steps.length, cost: cost(r) })));
  if (r.id === openId) row.append(detail(r));
  else row.append(btn(t('Open'), 'ghost small', () => ((openId = r.id), (draft = null), void loadTeamRuns())));
  return row;
}

async function act(path, body = {}) {
  try {
    const r = await ctx.api(`/team-runs/${path}`, { method: 'POST', body });
    await loadTeamRuns();
    return r;
  } catch (e) {
    alert(e.message);
    await loadTeamRuns();
    return null;
  }
}

function detail(r) {
  const box = el('div', 'trn-detail');
  if (r.status === 'proposed') {
    box.append(planEditor(r));
    return box;
  }
  box.append(el('p', 'small', t('Budget: about {tokens} tokens and {minutes} minutes. Used so far: {cost}.', { tokens: words(r.plan.limits.tokens), minutes: r.plan.limits.minutes, cost: cost(r) })));
  const names = new Map(r.plan.roles.map((x) => [x.id, x.name]));
  const list = el('ul', 'trn-steps small');
  for (const s of r.steps) {
    const li = el('li', `trn-step trn-${s.status}`);
    li.append(el('strong', '', `${names.get(s.role) ?? s.role}: ${s.title}`), ' ', el('span', 'muted', `${STEP[s.status]?.() ?? s.status} · ${t('about {tokens} tokens', { tokens: words(s.tokens) })}${s.runs > 1 ? ` · ${t('round {n}', { n: s.runs })}` : ''}`));
    list.append(li);
  }
  box.append(list);
  const acts = el('div', 'rt-more-acts');
  if (r.status === 'running') acts.append(btn(t('Pause'), 'ghost small', () => void act(`${r.id}/pause`)));
  if (r.status === 'paused') acts.append(btn(t('Go on'), 'ghost small', () => void act(`${r.id}/resume`)));
  if (r.status === 'running' || r.status === 'paused') acts.append(btn(t('Stop'), 'ghost small danger', () => confirm(t('Stop this team run? What it found so far stays.')) && void act(`${r.id}/stop`)));
  if (r.status === 'waiting') box.append(finalCard(r));
  if (r.result?.kind === 'document') {
    const a = el('a', 'ghost small btn-link', t('Open the document'));
    a.href = `/api/library/made/${r.result.docId}/file`;
    a.download = '';
    acts.append(a);
  }
  acts.append(btn(t('Open the chat'), 'ghost small', () => void openChat(r.conversationId)));
  if (!['running', 'paused'].includes(r.status)) acts.append(btn(t('Save as a team recipe'), 'ghost small', () => void saveRecipe(r)));
  box.append(acts);
  if (r.notes.length) {
    const pad = el('details', 'trn-pad');
    pad.append(el('summary', 'small', t('Scratchpad: {n} findings with sources', { n: r.notes.length })));
    const ul = el('ul', 'small');
    for (const n of r.notes) {
      const li = el('li', '', `[${n.n}] ${n.text} `);
      li.append(el('span', 'muted', `(${n.role}: ${n.source})`));
      ul.append(li);
    }
    pad.append(ul);
    box.append(pad);
  }
  for (const c of r.checks) box.append(el('p', `small ${c.ok ? 'trn-ok' : 'trn-fix'}`, c.ok ? t('Check {n}: every claim backed by its sources.', { n: c.round }) : t('Check {n}: {fixes}', { n: c.round, fixes: c.fixes.join(' · ') })));
  const log = el('details', 'trn-log');
  log.append(el('summary', 'small', t('Run log')));
  const ul = el('ul', 'small muted');
  for (const l of r.log.slice(-12)) ul.append(el('li', '', `${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${l.text}`));
  log.append(ul);
  box.append(log);
  return box;
}

/** The ONE final approval: every action the helpers queued, ticked; untick any you don't want. */
function finalCard(r) {
  const card = el('div', 'wt-card trn-final');
  card.append(el('strong', '', t('One OK for everything outside: {n} actions', { n: r.actions.filter((a) => a.status === 'queued').length })));
  const ticks = [];
  for (const a of r.actions.filter((x) => x.status === 'queued')) {
    const lab = el('label', 'trn-act small');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    ticks.push([a.n, box]);
    lab.append(box, ` ${a.n}. ${a.role}: ${a.summary}`);
    card.append(lab);
  }
  const acts = el('div', 'rt-more-acts');
  acts.append(
    btn(t('Do the ticked actions'), 'primary small', () => void act(`${r.id}/decide`, { approved: true, skip: ticks.filter(([, b]) => !b.checked).map(([n]) => n) })),
    btn(t('Do none'), 'ghost small', () => void act(`${r.id}/decide`, { approved: false })),
  );
  card.append(acts);
  return card;
}

/** The plan as she proposed it: every helper, model, tool and budget, editable before the one OK. */
function planEditor(r, rec = null) {
  if (!rec) draft ??= structuredClone(r.plan);
  const p = rec ? rec.plan : draft;
  const form = el('div', 'rt-form trn-plan');
  const redraw = () => form.replaceWith(planEditor(r, rec));
  const total = () => p.roles.reduce((n, x) => n + Number(x.budget.tokens) * Math.max(1, p.steps.filter((s) => s.role === x.id).length), 0);
  const sum = el('p', 'small trn-sum');
  const drawSum = () => (sum.textContent = t('Budget up front: about {tokens} tokens and {minutes} minutes in all.', { tokens: words(total()), minutes: Math.min(240, p.roles.reduce((n, x) => n + Number(x.budget.minutes), 0)) }));
  drawSum();
  form.append(sum);
  const tools = data.tools ?? [];
  for (const role of p.roles) {
    const card = el('fieldset', 'trn-role');
    const kindName = KIND()[role.kind] ?? role.kind;
    card.append(el('legend', '', role.name === kindName ? role.name : `${role.name} (${kindName})`));
    const name = Object.assign(document.createElement('input'), { type: 'text', value: role.name, maxLength: 40 });
    name.addEventListener('input', () => (role.name = name.value));
    const more = el('details', 'trn-more');
    more.append(el('summary', 'small', t('More for this helper')));
    const lab = (label, input, help, into = card) => {
      const l = el('label', 'rt-field');
      l.append(el('span', '', label), input, tip(help));
      into.append(l);
    };
    lab(t('Name'), name, t('What this helper is called on the run and in the log.'));
    const instr = Object.assign(document.createElement('textarea'), { rows: 2, maxLength: 2000, value: role.instructions ?? '' });
    instr.addEventListener('input', () => (role.instructions = instr.value));
    lab(t('Instructions'), instr, t('Extra instructions for every part this helper does, e.g. “Use British spelling.”'), more);
    const model = document.createElement('select');
    model.append(opt('auto', t('Auto'), role.model === 'auto'));
    for (const m of data.models ?? []) model.append(opt(`${m.providerId}\n${m.model}`, m.label, role.model !== 'auto' && role.model.providerId === m.providerId && role.model.model === m.model));
    model.addEventListener('change', () => {
      const [providerId, m] = model.value.split('\n');
      role.model = model.value === 'auto' ? 'auto' : { providerId, model: m };
    });
    lab(t('Model'), model, t('Auto uses your usual model for this kind of work. In a private chat only models on this computer are used.'));
    const tok = Object.assign(document.createElement('input'), { type: 'number', min: '1000', step: '1000', value: String(role.budget.tokens) });
    tok.addEventListener('input', () => ((role.budget.tokens = Number(tok.value)), drawSum()));
    lab(t('Budget (tokens)'), tok, t('Its reading and writing for each part. The run stops when a helper or the whole run reaches its budget, and keeps what was done.'));
    const min = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: '120', value: String(role.budget.minutes) });
    min.addEventListener('input', () => ((role.budget.minutes = Number(min.value)), drawSum()));
    lab(t('Time (minutes)'), min, t('The most one of its parts may take.'), more);
    const usd = Object.assign(document.createElement('input'), { type: 'number', min: '0', step: '0.5', value: String(role.budget.usd || 0) });
    usd.addEventListener('input', () => (role.budget.usd = Number(usd.value)));
    lab(t('Spending limit ($)'), usd, t('0 means no dollar limit. Models on your own computer are free.'), more);
    const comp = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(role.computer) });
    comp.addEventListener('change', () => ((role.computer = comp.checked), drawTools()));
    lab(t('May use the computer'), comp, t('Lets this helper ask for computer-use tools. Its computer actions still wait for your one final OK.'), more);
    const box = el('div', 'team-tools trn-tools');
    const drawTools = () => {
      box.replaceChildren();
      for (const x of tools.filter((x) => !x.computer || role.computer)) {
        const l = el('label', 'small');
        const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: role.tools.includes(x.name) });
        c.addEventListener('change', () => (role.tools = c.checked ? [...role.tools, x.name] : role.tools.filter((n) => n !== x.name)));
        l.append(c, ` ${x.name}${x.kind === 'action' ? ' ✉' : ''}`);
        box.append(l);
      }
    };
    drawTools();
    const tl = el('div', 'rt-field');
    tl.append(el('span', '', t('Tools')), tip(t('The tools this helper may use. ✉ marks actions (send, post, buy, computer): they are only queued for your final OK. Commands, sign-ins and settings are never offered.')));
    card.append(tl, box, more);
    if (p.roles.length > 1 && !p.steps.some((s) => s.role === role.id)) card.append(acts1(btn(t('Remove'), 'ghost small', () => ((p.roles = p.roles.filter((x) => x !== role)), redraw()))));
    form.append(card);
  }
  if (p.roles.length < 6) form.append(acts1(btn(t('Add a helper of your own'), 'ghost small', () => {
    p.roles.push({ id: `own${Date.now() % 100000}`, name: t('Helper'), kind: 'custom', instructions: '', model: 'auto', tools: tools.filter((x) => x.kind === 'read').slice(0, 3).map((x) => x.name), computer: false, budget: { tokens: 40000, minutes: 10, usd: 0 } });
    redraw();
  })));
  const parts = el('fieldset', 'trn-parts');
  parts.append(el('legend', '', t('Parts')));
  for (const s of p.steps) {
    const row = el('div', 'trn-part');
    const who = document.createElement('select');
    who.setAttribute('aria-label', t('Helper'));
    for (const role of p.roles) who.append(opt(role.id, role.name, role.id === s.role));
    who.addEventListener('change', () => ((s.role = who.value), drawSum()));
    const title = Object.assign(document.createElement('input'), { type: 'text', value: s.title, maxLength: 120 });
    title.setAttribute('aria-label', t('Part'));
    title.addEventListener('input', () => (s.title = title.value));
    const head = el('div', 'add-row');
    head.append(who, title);
    row.append(head);
    const waits = el('div', 'small trn-waits');
    waits.append(el('span', 'muted', t('Waits for:')));
    for (const o of p.steps.filter((x) => x.id !== s.id)) {
      const l = el('label', '');
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.after.includes(o.id) });
      c.addEventListener('change', () => (s.after = c.checked ? [...s.after, o.id] : s.after.filter((a) => a !== o.id)));
      l.append(c, ` ${o.title}`);
      waits.append(l);
    }
    if (!s.after.length) waits.append(el('span', 'muted', t('(starts right away)')));
    row.append(waits);
    const what = Object.assign(document.createElement('textarea'), { rows: 2, maxLength: 3000, value: s.instructions ?? '' });
    what.setAttribute('aria-label', t('What to do'));
    what.addEventListener('input', () => (s.instructions = what.value));
    row.append(what);
    if (p.steps.length > 1) row.append(acts1(btn(t('Remove'), 'ghost small', () => {
      p.steps = p.steps.filter((x) => x !== s);
      for (const x of p.steps) x.after = x.after.filter((a) => a !== s.id);
      redraw();
    })));
    parts.append(row);
  }
  if (p.steps.length < 10) parts.append(acts1(btn(t('Add a part'), 'ghost small', () => {
    p.steps.push({ id: `p${Date.now() % 100000}`, role: p.roles[0].id, title: t('Part'), instructions: '', after: [] });
    redraw();
  })));
  parts.append(tip(t('Parts that wait for nothing run at the same time (up to 3). A part starts when everything it waits for is done. The checker can send the draft back twice at most.')));
  form.append(parts);
  const acts = el('div', 'rt-more-acts');
  if (rec) {
    acts.append(
      btn(t('Save'), 'primary small', async () => {
        try {
          await ctx.api(`/team-runs/recipes/${rec.id}`, { method: 'PUT', body: { name: rec.name, description: rec.description, plan: rec.plan } });
          recipeEdit = null;
        } catch (e) {
          alert(e.message);
        }
        await loadTeamRuns();
      }),
      btn(t('Cancel'), 'ghost small', () => ((recipeEdit = null), void loadTeamRuns())),
    );
    form.append(acts);
    return form;
  }
  acts.append(
    btn(t('Approve and start'), 'primary small', async () => {
      try {
        await ctx.api(`/team-runs/${r.id}/plan`, { method: 'PUT', body: { plan: p } });
        await ctx.api(`/team-runs/${r.id}/approve`, { method: 'POST', body: {} });
        draft = null;
      } catch (e) {
        alert(e.message);
      }
      await loadTeamRuns();
    }),
    btn(t('Drop this plan'), 'ghost small', () => ((draft = null), void act(`${r.id}/stop`))),
  );
  form.append(acts);
  return form;
}

// ---------------------------------------------------------------- U3.16: team recipes

async function saveRecipe(r) {
  const name = prompt(t('A name for this team recipe, e.g. “Product comparison”:'), '');
  if (!name?.trim()) return;
  try {
    await ctx.api(`/team-runs/${r.id}/recipe`, { method: 'POST', body: { name: name.trim() } });
  } catch (e) {
    alert(e.message);
  }
  await loadTeamRuns();
}

async function recipeAct(path, method = 'POST', body = {}) {
  try {
    const r = await ctx.api(`/team-runs/recipes/${path}`, { method, body });
    await loadTeamRuns();
    return r;
  } catch (e) {
    alert(e.message);
    return null;
  }
}

function recipesBox() {
  const box = el('section', 'trn-recipes');
  const head = el('div', 'rt-row-head');
  head.append(el('strong', '', t('Team recipes')), tip(t('A finished run’s plan kept for next time: its helpers, models, tools, budgets, parts and checks, never its results. Run one with a new job; the plan still waits for your OK.')));
  box.append(head);
  const recipes = data.recipes ?? [];
  if (!recipes.length) box.append(el('p', 'muted small', t('No recipes yet. After a run finishes, use Save as a team recipe.')));
  for (const rec of recipes) box.append(recipeRow(rec));
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    let json;
    try {
      json = JSON.parse(await f.text());
    } catch {
      return alert(t('This is not a Sara team recipe.'));
    }
    await recipeAct('import', 'POST', { recipe: json });
  });
  box.append(acts1(btn(t('Import a recipe'), 'ghost small', () => file.click()), file));
  return box;
}

function recipeRow(rec) {
  const row = el('div', 'rt-row trn-recipe');
  const head = el('div', 'rt-row-head');
  head.append(el('span', 'rt-title', rec.name));
  row.append(head, el('div', 'rt-when muted small', [rec.description, t('{helpers} helpers, {parts} parts', { helpers: rec.plan.roles.length, parts: rec.plan.steps.length })].filter(Boolean).join(' · ')));
  if (recipeEdit?.id === rec.id) {
    const form = el('div', 'rt-form trn-recipe-edit');
    const name = Object.assign(document.createElement('input'), { type: 'text', value: recipeEdit.name, maxLength: 60 });
    name.setAttribute('aria-label', t('Name'));
    name.addEventListener('input', () => (recipeEdit.name = name.value));
    const desc = Object.assign(document.createElement('input'), { type: 'text', value: recipeEdit.description, maxLength: 300, placeholder: t('What it is for (optional)') });
    desc.setAttribute('aria-label', t('What it is for (optional)'));
    desc.addEventListener('input', () => (recipeEdit.description = desc.value));
    form.append(name, desc, el('p', 'muted small', t('Where the job text goes, the recipe says {placeholder}.', { placeholder: '{job}' })), planEditor(null, recipeEdit));
    row.append(form);
    return row;
  }
  if (recipeRun === rec.id) {
    const form = el('div', 'rt-form');
    const goal = Object.assign(document.createElement('textarea'), { rows: 2, maxLength: 4000, placeholder: t('The job for this team, e.g. Compare three robot vacuums') });
    goal.setAttribute('aria-label', t('The job'));
    form.append(goal, acts1(
      btn(t('Plan it'), 'primary small', async () => {
        const r = await recipeAct(`${rec.id}/run`, 'POST', { goal: goal.value });
        if (r?.run) {
          recipeRun = null;
          openId = r.run.id;
          draft = null;
          await loadTeamRuns();
        }
      }),
      btn(t('Cancel'), 'ghost small', () => ((recipeRun = null), void loadTeamRuns())),
    ));
    row.append(form);
    setTimeout(() => goal.focus(), 0);
    return row;
  }
  row.append(acts1(
    btn(t('Run'), 'primary small', () => ((recipeRun = rec.id), void loadTeamRuns())),
    btn(t('Edit'), 'ghost small', () => ((recipeEdit = structuredClone(rec)), void loadTeamRuns())),
    btn(t('Duplicate'), 'ghost small', () => void recipeAct(`${rec.id}/duplicate`)),
    btn(t('Export'), 'ghost small', () => void exportRecipe(rec)),
    btn(t('Delete'), 'ghost small danger', () => confirm(t('Delete the team recipe “{name}”?', { name: rec.name })) && void recipeAct(String(rec.id), 'DELETE')),
  ));
  return row;
}

async function exportRecipe(rec) {
  try {
    const json = await ctx.api(`/team-runs/recipes/${rec.id}/export`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
    a.download = `${rec.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'team-recipe'}.sara-team.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    alert(e.message);
  }
}

async function openChat(id) {
  if ($('#team')?.open) $('#team').close();
  await ctx.openConversation?.(id);
}

/** Opens the Team dialog on one run (from the chat card). */
export async function openTeamRun(id) {
  openId = id;
  draft = null;
  await ctx?.openTeam?.();
  await loadTeamRuns();
  $('#truns')?.scrollIntoView({ block: 'start' });
}

/** The run's card in the chat: live status, cost so far and one button to the plan or the run. */
export function teamRunNotice(m) {
  const id = m.meta?.teamRun?.id;
  const card = el('div', 'msg notice team-run wt-card');
  const head = el('div', 'wt-card-head small');
  head.append(el('strong', '', `👥 ${t('Team run: {goal}', { goal: m.content })}`));
  const line = el('p', 'small trn-card-line', '');
  const acts = el('div', 'rt-more-acts');
  card.append(head, line, acts);
  if (id) {
    cards.set(id, { line, acts });
    void paintCard(id);
  }
  return card;
}

async function paintCard(id) {
  const c = cards.get(id);
  if (!c || !ctx) return;
  if (!c.line.isConnected && c.line.textContent) return void cards.delete(id);
  try {
    const { run } = await ctx.api(`/team-runs/${id}`);
    c.line.textContent = `${STATUS[run.status]?.() ?? run.status} · ${run.status === 'proposed' ? budgetLine(run.plan) : `${t('{done} of {parts} parts done', { done: run.steps.filter((s) => s.status === 'done').length, parts: run.steps.length })} · ${cost(run)}`}`;
    const label = run.status === 'proposed' ? t('Review the plan') : run.status === 'waiting' ? t('Review the actions') : t('Open');
    c.acts.replaceChildren(btn(label, run.status === 'proposed' || run.status === 'waiting' ? 'primary small' : 'ghost small', () => void openTeamRun(id)));
  } catch {
    c.line.textContent = t('No such team run.');
  }
}

/** A team-run event from the server: refresh the open Team dialog and the run's chat card. */
let soon = null;
const due = new Set();
export function onTeamRunEvent(ev) {
  if (!ev) return;
  due.add(ev.id);
  // Helpers save often: one refresh at most every half second.
  soon ??= setTimeout(() => {
    soon = null;
    for (const id of due) void paintCard(id);
    due.clear();
    if ($('#team')?.open && !draft && !recipeEdit && recipeRun === null) void loadTeamRuns();
  }, 500);
}
