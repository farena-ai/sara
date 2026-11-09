// C10 (docs/ops/C10_DESIGN.md): Team → Workers that stay. A worker is one of your helpers (or a crew
// member) that keeps going: a name and a character, its own chat, the tool groups it may use, a daily
// token budget and a queue of jobs it does one at a time. Failed jobs can be replayed (a copy) or
// dropped; a worker that needs you sends one alert. Export a worker (and the workers it leads) as a
// file; import shows what it may do before anything is made. Nothing here calls a model by itself.
import { t } from './naming.js';
import { orbMount } from './orb.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openConversation?: (id: string) => Promise<void> } | null} */
let ctx = null;
let data = null;
let editing = null;
let preview = null;

export function initWorkers(c) {
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
const GROUPS = {
  read: () => t('Read files'),
  web: () => t('Search the web'),
  write: () => t('Change files'),
  shell: () => t('Run commands'),
  git: () => t('Use git'),
  agent: () => t('Hand work to a coding agent'),
};
const JOB = { queued: () => t('waiting'), running: () => t('working'), done: () => t('done'), failed: () => t('failed'), dropped: () => t('dropped') };
const short = (s) => new Date(s).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

export async function loadWorkers() {
  const host = $('#workers');
  if (!ctx || !host) return;
  try {
    data = await ctx.api('/workers');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.status === 403 ? t('Only the owner of this server can use this.') : e.message));
    return;
  }
  const rows = [];
  if (data.pinned) rows.push(el('p', 'muted small', t('Crews are turned off by your admin.')));
  if (!data.workers.length && !editing) rows.push(el('p', 'muted small', t('No workers yet. Make one from a helper or a crew member.')));
  for (const w of data.workers) rows.push(workerRow(w));
  if (editing) rows.push(workerForm(editing));
  else if (!data.pinned) {
    const acts = el('div', 'rt-more-acts');
    acts.append(btn(t('New worker'), 'ghost small', () => {
      editing = { toolGroups: ['read'], dailyTokens: 200000, timeLimitMin: 30, maxAttempts: 3, helper: data.helpers[0]?.id ?? 'writer' };
      void loadWorkers();
    }));
    acts.append(importButton());
    rows.push(acts);
  }
  if (preview) rows.push(previewBox());
  rows.push(failedBox());
  host.replaceChildren(...rows);
}

async function act(path, method = 'POST', body = {}) {
  try {
    const r = await ctx.api(path, { method, ...(method === 'DELETE' ? {} : { body }) });
    await loadWorkers();
    return r;
  } catch (e) {
    alert(e.message);
    await loadWorkers();
    return null;
  }
}

function workerRow(w) {
  const row = el('div', `rt-row wr-row${w.state === 'on' ? '' : ' rt-off'}`);
  const head = el('div', 'rt-row-head');
  // V4b: a small orb per worker: swirling while it works on a job, still otherwise.
  head.append(orbMount(16, { state: w.running ? 'thinking' : 'idle', cls: 'wr-orb', name: w.name }), el('span', 'rt-title', w.name), el('span', `wt-state wt-${w.state === 'on' ? 'active' : 'paused'}`, w.state === 'on' ? t('On') : t('Paused')));
  if (w.needsYou) head.append(el('span', 'chip waiting', t('Needs you')));
  row.append(head);
  if (w.character) row.append(el('p', 'muted small wr-char', w.character));
  const helper = data.helpers.find((h) => h.id === w.helper);
  const lead = data.workers.find((x) => x.id === w.leadId);
  const bits = [helper ? `${helper.emoji} ${helper.name}` : w.helper, w.toolGroups.map((g) => GROUPS[g]?.() ?? g).join(', '), t('{used} of {max} tokens today', { used: w.usedToday.toLocaleString(), max: w.dailyTokens.toLocaleString() })];
  if (lead) bits.push(t('led by {name}', { name: lead.name }));
  row.append(el('div', 'rt-when muted small', bits.join(' · ')));
  const status = w.running ? t('Working on “{title}”', { title: w.running.title }) : w.queued ? t('{n} jobs waiting', { n: w.queued }) : w.last ? t('Last job {time}: {title}', { time: short(w.last.endedAt ?? w.last.createdAt), title: w.last.title }) : t('No jobs yet');
  row.append(el('div', 'rt-status small', status));
  if (w.needsYou) row.append(el('p', 'small wr-needs', w.needsYou.text));
  const acts = el('div', 'rt-more-acts');
  if (!data.pinned) acts.append(btn(t('Give it a job'), 'ghost small', () => void addJob(w)));
  acts.append(w.state === 'on' ? btn(t('Stop'), 'ghost small', () => void act(`/workers/${w.id}/stop`)) : btn(t('Turn on'), 'ghost small', () => void act(`/workers/${w.id}`, 'PATCH', { state: 'on' })));
  acts.append(btn(t('Open its chat'), 'ghost small', () => void openChat(w.conversationId)));
  acts.append(btn(t('Export'), 'ghost small', () => void exportWorker(w)));
  acts.append(btn(t('Edit'), 'ghost small', () => {
    editing = { ...w };
    void loadWorkers();
  }));
  acts.append(btn(t('Delete'), 'ghost small danger', () => {
    if (confirm(t('Delete this worker? Its chat and finished jobs stay; waiting jobs are dropped.'))) void act(`/workers/${w.id}`, 'DELETE');
  }));
  row.append(acts);
  return row;
}

async function addJob(w) {
  const title = prompt(t('What should {name} do?', { name: w.name }));
  if (!title?.trim()) return;
  await act(`/workers/${w.id}/jobs`, 'POST', { title: title.trim(), input: '' });
}

async function openChat(id) {
  if ($('#team')?.open) $('#team').close();
  await ctx.openConversation?.(id);
}

function exportWorker(w) {
  const memories = confirm(t('Include what it remembers (its last results)? Secrets are never included.'));
  const a = document.createElement('a');
  a.href = `/api/workers/${w.id}/export${memories ? '?memories=1' : ''}`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

function importButton() {
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  file.setAttribute('aria-label', t('Import a worker'));
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const bundle = JSON.parse(await f.text());
      const r = await ctx.api('/workers/import/preview', { method: 'POST', body: { bundle } });
      preview = { bundle, ...r.preview };
    } catch (e) {
      alert(e.message || t('This is not a worker bundle Sara can read.'));
    }
    await loadWorkers();
  });
  const wrap = el('span', 'wr-import');
  wrap.append(file, btn(t('Import a worker'), 'ghost small', () => file.click()), tip(t('Pick a worker file someone exported. You see each worker and what it may do before anything is made; imported workers start paused.')));
  return wrap;
}

function previewBox() {
  const box = el('div', 'rt-form wr-preview');
  box.append(el('h4', '', t('Look over before importing')));
  const list = el('ul', 'wr-preview-list small');
  for (const w of preview.workers) {
    const li = el('li', '');
    li.append(el('strong', '', w.name));
    if (w.lead) li.append(document.createTextNode(` · ${t('led by {name}', { name: w.lead })}`));
    if (w.character) li.append(el('p', 'muted', w.character));
    li.append(el('p', '', t('May use: {tools}', { tools: w.tools.join(', ') })));
    if (w.risky.length) li.append(el('p', 'wr-risky', t('Can change things: {tools}', { tools: w.risky.join(', ') })));
    li.append(el('p', 'muted', t('{max} tokens a day, {min} minutes a job', { max: w.dailyTokens.toLocaleString(), min: w.timeLimitMin })));
    if (w.memories) li.append(el('p', 'muted', t('Brings {n} remembered results', { n: w.memories })));
    list.append(li);
  }
  box.append(list);
  if (preview.missingSkills.length) box.append(el('p', 'muted small', t('Skills you do not have yet: {names}', { names: preview.missingSkills.join(', ') })));
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(t('Import paused'), 'primary small', async () => {
    const bundle = preview.bundle;
    preview = null;
    await act('/workers/import', 'POST', { bundle, confirm: true });
  }));
  acts.append(btn(t('Cancel'), 'ghost small', () => {
    preview = null;
    void loadWorkers();
  }));
  box.append(acts);
  return box;
}

function failedBox() {
  const box = el('div', 'wr-failed');
  const h = el('h4', '', t('Failed jobs'));
  h.append(tip(t('Jobs that kept failing or ran past their time. Read why, then replay a copy (the failed one stays here) or drop it.')));
  box.append(h);
  if (!data.failed.length) {
    box.append(el('p', 'muted small', t('No failed jobs.')));
    return box;
  }
  const list = el('ul', 'wr-failed-list');
  for (const j of data.failed) {
    const li = el('li', 'small');
    li.append(el('strong', '', `${j.worker}: ${j.title}`));
    li.append(el('p', 'muted', t('{status} after {n} tries, {time}: {why}', { status: JOB[j.status]?.() ?? j.status, n: j.attempts, time: short(j.endedAt ?? j.createdAt), why: j.error ?? '' })));
    const acts = el('div', 'rt-more-acts');
    if (j.replayedBy) acts.append(el('span', 'muted', t('Replayed')));
    else if (!data.pinned) acts.append(btn(t('Replay'), 'ghost small', () => void act(`/workers/jobs/${j.id}/replay`)));
    acts.append(btn(t('Drop'), 'ghost small danger', () => void act(`/workers/jobs/${j.id}/drop`)));
    li.append(acts);
    list.append(li);
  }
  box.append(list);
  return box;
}

function workerForm(w) {
  const form = el('div', 'rt-form wr-form');
  const field = (label, input, help) => {
    const lab = el('label', 'rt-field');
    lab.append(el('span', '', label), input, tip(help));
    form.append(lab);
    return input;
  };
  const input = (value, max) => Object.assign(document.createElement('input'), { type: 'text', value: value ?? '', maxLength: max });
  const num = (value, min, max, step) => Object.assign(document.createElement('input'), { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) });
  const select = (opts, value) => {
    const s = document.createElement('select');
    for (const [v, label] of opts) s.append(Object.assign(document.createElement('option'), { value: v, textContent: label, selected: String(v) === String(value ?? '') }));
    return s;
  };
  let from = null;
  if (!w.id && data.crews.length) {
    const opts = [['', t('No, a helper of my own')]];
    data.crews.forEach((c) => c.members.forEach((m, i) => opts.push([`${c.id}:${i}`, `${c.name}: ${m.task}`])));
    from = field(t('From a crew member'), select(opts, ''), t('A crew member that stays: it keeps its helper and its part as its character, and gets its own chat and queue.'));
  }
  const name = field(t('Name'), input(w.name, 40), t('What you call this worker. Its chat is called “Worker: name”.'));
  const character = document.createElement('textarea');
  character.rows = 2;
  character.maxLength = 1000;
  character.value = w.character ?? '';
  field(t('Character'), character, t('How it works and sounds, e.g. “Calm and thorough; short sentences; asks before deleting anything.”'));
  const helper = field(t('Built on'), select(data.helpers.map((h) => [h.id, `${h.emoji} ${h.name}`]), w.helper), t('The helper it starts from: its job and model. Its tools are the groups below.'));
  const groups = el('div', 'wr-groups');
  const boxes = {};
  for (const g of data.groups) {
    const lab = el('label', 'wr-group small');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: (w.toolGroups ?? []).includes(g.id) });
    boxes[g.id] = cb;
    lab.append(cb, document.createTextNode(` ${GROUPS[g.id]?.() ?? g.id}`));
    groups.append(lab);
  }
  field(t('It may'), groups, t('The groups of tools this worker may use. Anything that changes files or runs commands still asks you first, like her own.'));
  const daily = field(t('Tokens a day'), num(w.dailyTokens ?? 200000, 10000, 5000000, 10000), t('Its own daily budget. When it is used up, its jobs wait until tomorrow and it tells you once.'));
  const minutes = field(t('Minutes a job'), num(w.timeLimitMin ?? 30, 2, 240, 1), t('A job that runs longer is stopped and counts as a failed try.'));
  const tries = field(t('Tries'), num(w.maxAttempts ?? 3, 1, 5, 1), t('How often a failing job is tried (waiting 1, 5, then 30 minutes) before it goes to Failed jobs.'));
  const leads = [['', t('Nobody (it reports to you)')], ...data.workers.filter((x) => x.id !== w.id).map((x) => [x.id, x.name])];
  const lead = field(t('Led by'), select(leads, w.leadId ?? ''), t('A lead can hand jobs to the workers under it; their results come back to the lead’s chat.'));
  const acts = el('div', 'rt-more-acts');
  acts.append(btn(w.id ? t('Save') : t('Make the worker'), 'primary small', async () => {
    const body = { name: name.value, character: character.value, helper: helper.value, toolGroups: Object.keys(boxes).filter((k) => boxes[k].checked), dailyTokens: Number(daily.value), timeLimitMin: Number(minutes.value), maxAttempts: Number(tries.value), leadId: lead.value ? Number(lead.value) : null };
    if (from?.value) {
      const [crewId, member] = from.value.split(':').map(Number);
      Object.assign(body, { fromCrew: { crewId, member } });
      if (!name.value.trim()) delete body.name;
      if (!character.value.trim()) delete body.character;
      delete body.helper;
    }
    const prev = editing;
    editing = null;
    const r = await act(w.id ? `/workers/${w.id}` : '/workers', w.id ? 'PATCH' : 'POST', body);
    if (!r) {
      editing = prev;
      void loadWorkers();
    }
  }));
  acts.append(btn(t('Cancel'), 'ghost small', () => {
    editing = null;
    void loadWorkers();
  }));
  form.append(acts);
  return form;
}
