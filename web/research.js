// EC6 (docs/RESEARCH.md): Library → Research a question. He types a question; she drafts a plan
// (steps and web searches) that he edits and starts; while she reads, the pages read and the pages
// that failed (with the reason) are listed live, with "Write the report now" and Stop. The report
// (every sentence links a page she read) is kept in her Library and downloads as PDF or Word.
// Polls the run every 1.5 s while it works; nothing here calls a model or fetches a page itself.
import { parse, toDom } from './markdown.js';
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const POLL_MS = 1500;
let runId = null;
let timer = null;
let draft = null;
let limits = { pageChoices: [4, 8, 12, 20], defaultPages: 8, maxSteps: 5, maxSearches: 3 };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
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
/** A labelled control with its ? tip. */
function field(label, input, help) {
  const id = `rs-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const l = el('label', 'rs-label', label);
  l.htmlFor = id;
  const row = el('div', 'rs-field');
  row.append(el('div', 'rs-label-row'), input);
  row.firstChild.append(l, tip(help));
  return row;
}

const STATUS_WORDS = {
  planning: () => t('Drafting a plan…'),
  plan: () => t('Check the plan, change anything, then start.'),
  running: () => t('Searching and reading pages…'),
  writing: () => t('Writing the report…'),
  done: () => t('The report is ready and kept in her Library.'),
  stopped: () => t('Stopped. The report shows what was found and what is missing.'),
  failed: () => t('This run could not finish.'),
};
const working = (s) => s === 'planning' || s === 'running' || s === 'writing';

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

/** Opens the Research view inside the Library window. */
export async function openResearch() {
  $('#lib-home').hidden = true;
  $('#lib-doc').hidden = true;
  $('#lib-research').hidden = false;
  runId = null;
  draft = null;
  await render();
}
export function closeResearch() {
  stopPolling();
  $('#lib-research').hidden = true;
}

async function render() {
  stopPolling();
  const host = $('#lib-r-body');
  if (!host || $('#lib-research').hidden) return;
  try {
    if (runId == null) {
      const r = await api('/research');
      limits = r.limits ?? limits;
      host.replaceChildren(askForm(r), pastRuns(r.runs));
      return;
    }
    const { run } = await api(`/research/${runId}`);
    host.replaceChildren(runView(run));
    if (working(run.status)) timer = setTimeout(() => void render(), POLL_MS);
  } catch (e) {
    host.replaceChildren(el('p', 'small error', e.status === 403 ? t('Only the owner of this server can turn this on.') : e.message));
  }
}

function askForm(r) {
  const box = el('div', 'rs-ask');
  const q = document.createElement('textarea');
  q.rows = 3;
  q.maxLength = 500;
  q.placeholder = t('For example: do heat pumps work in cold climates?');
  box.append(field(t('Your question'), q, t('She drafts a plan first and reads nothing until you start it. She uses your web search and reads public pages only; every sentence of the report links the page it came from.')));
  if (!r.ready) box.append(el('p', 'small error', serverText({ error: r.why }, r.why ?? '')));
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const go = btn(t('Draft a plan'), '', async () => {
    go.disabled = true;
    try {
      const made = await api('/research', { method: 'POST', body: { question: q.value } });
      runId = made.run.id;
      await render();
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
      go.disabled = false;
    }
  });
  go.disabled = !r.ready;
  const acts = el('div', 'actions-left');
  acts.append(go);
  box.append(acts, status);
  return box;
}

function pastRuns(runs) {
  const box = el('div', 'rs-past');
  if (!runs.length) return box;
  box.append(el('h3', '', t('Earlier research')));
  for (const r of runs) {
    const b = btn('', 'rs-past-run', () => {
      runId = r.id;
      void render();
    });
    b.append(el('span', 'rs-past-q', r.question), el('span', 'muted small', STATUS_WORDS[r.status]?.() ?? r.status));
    box.append(b);
  }
  return box;
}

function runView(run) {
  const box = el('div', 'rs-run');
  box.append(el('h3', 'rs-question', run.question));
  const st = el('p', 'small', STATUS_WORDS[run.status]?.() ?? run.status);
  st.setAttribute('role', 'status');
  box.append(st);
  if (run.status === 'plan') box.append(planEditor(run));
  if (run.status === 'running' || run.status === 'writing') {
    const acts = el('div', 'actions-left');
    if (run.status === 'running') acts.append(btn(t('Write the report now'), '', () => void act(`/research/${run.id}/write-now`)));
    acts.append(btn(t('Stop'), 'ghost danger-text', () => void act(`/research/${run.id}/stop`)));
    box.append(acts);
  }
  if (run.status === 'planning') {
    const acts = el('div', 'actions-left');
    acts.append(btn(t('Stop'), 'ghost danger-text', () => void act(`/research/${run.id}/stop`)));
    box.append(acts);
  }
  if (run.report) box.append(reportView(run));
  if (run.sources.length || run.searched.length) box.append(sourceLists(run));
  return box;
}

async function act(path) {
  try {
    await api(path, { method: 'POST', body: {} });
  } catch (e) {
    alert(e.message);
  }
  await render();
}

function planEditor(run) {
  draft ??= structuredClone(run.plan);
  const box = el('div', 'rs-plan');
  draft.steps.forEach((step, i) => {
    const row = el('fieldset', 'rs-step');
    row.append(el('legend', 'small', t('Step {n}', { n: i + 1 })));
    const q = document.createElement('input');
    q.type = 'text';
    q.maxLength = 300;
    q.value = step.question;
    q.addEventListener('input', () => (step.question = q.value));
    const s = document.createElement('input');
    s.type = 'text';
    s.value = step.searches.join('; ');
    s.addEventListener('input', () => (step.searches = s.value.split(';').map((x) => x.trim()).filter(Boolean)));
    row.append(field(t('What to find out'), q, t('One part of your question. The report says plainly when no page she read answers it.')), field(t('Web searches'), s, t('Up to 3 searches for this step, separated by ";". Each one goes to your web search setup.')));
    if (draft.steps.length > 1) row.append(btn(t('Remove this step'), 'ghost small', () => {
      draft.steps.splice(i, 1);
      void render();
    }));
    box.append(row);
  });
  if (draft.steps.length < limits.maxSteps) box.append(btn(t('Add a step'), 'ghost small', () => {
    draft.steps.push({ question: '', searches: [] });
    void render();
  }));
  const pages = document.createElement('select');
  for (const n of limits.pageChoices) pages.append(new Option(t('up to {n} pages', { n }), String(n), false, n === draft.pages));
  pages.addEventListener('change', () => (draft.pages = Number(pages.value)));
  box.append(field(t('Pages to read'), pages, t('At most this many pages are read. More pages take longer and use more of your model; you can write the report early at any time.')));
  const status = el('p', 'small', '');
  const acts = el('div', 'actions-left');
  acts.append(
    btn(t('Start'), '', async () => {
      try {
        await api(`/research/${run.id}/plan`, { method: 'PUT', body: draft });
        await api(`/research/${run.id}/start`, { method: 'POST', body: {} });
        draft = null;
      } catch (e) {
        status.textContent = e.message;
        status.classList.add('error');
        return;
      }
      await render();
    }),
    btn(t('Cancel'), 'ghost', () => {
      draft = null;
      void act(`/research/${run.id}/stop`);
    }),
  );
  box.append(acts, status);
  return box;
}

function reportView(run) {
  const box = el('div', 'rs-report');
  const acts = el('div', 'actions-left');
  const link = (label, href) => {
    const a = el('a', 'button ghost small', label);
    a.href = href;
    a.download = '';
    return a;
  };
  const base = `/api/research/${run.id}/`;
  acts.append(link(t('Download PDF'), `${base}export?format=pdf`), link(t('Download Word'), `${base}export?format=docx`), link(t('Download Markdown'), `${base}export?format=md`));
  if (run.reportDocId) acts.append(btn(t('Open in her Library'), 'ghost small', () => void import('./library.js').then((m) => m.openLibrary(run.reportDocId))));
  const md = el('div', 'rs-report-text');
  md.append(toDom(parse(run.report)));
  box.append(acts, md, btn(t('Research something else'), 'ghost small', () => {
    runId = null;
    void render();
  }));
  return box;
}

function sourceLists(run) {
  const box = el('div', 'rs-sources');
  const read = run.sources.filter((s) => s.status === 'read');
  const failed = run.sources.filter((s) => s.status === 'failed');
  box.append(el('h3', '', t('Pages read ({n})', { n: read.length })));
  const ul = el('ol', 'rs-list');
  for (const s of read) {
    const li = el('li');
    const a = el('a', '', s.title);
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a, el('span', 'muted small', ` · ${new URL(s.url).host}`));
    ul.append(li);
  }
  if (!read.length) box.append(el('p', 'muted small', t('None yet.')));
  else box.append(ul);
  box.append(el('h3', '', t('Could not be read ({n})', { n: failed.length })));
  const fl = el('ul', 'rs-list');
  for (const s of failed) {
    const li = el('li');
    li.append(el('span', 'rs-url', s.url), el('span', 'small error', ` · ${s.reasonText}`));
    fl.append(li);
  }
  if (failed.length) box.append(fl);
  else box.append(el('p', 'muted small', t('None.')));
  if (run.searched.length) box.append(el('p', 'muted small', t('Searches run: {list}', { list: run.searched.join('; ') })));
  return box;
}

$('#library')?.addEventListener('close', stopPolling);
