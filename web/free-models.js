// W2.4 Settings → Models & usage → On this computer → Recommended for this computer (docs/FREE_MODELS.md).
// One card per job from the curated free model list (src/free-models.json), picked for this computer's
// hardware: size, memory, license, how well it did ("tested here", our published results, or untested),
// "Why this one", and a one-click Download through the existing pull route (it never switches her
// talking model). Hearing and voices go to the Voice page's own installer; the phone model to the app.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const JOB = {
  chat: () => t('Talking'),
  coding: () => t('Coding'),
  vision: () => t('Looking at pictures'),
  hearing: () => t('Hearing you'),
  voice: () => t('Her voice'),
  embeddings: () => t('Meaning search'),
  phone: () => t('Offline copy on your phone'),
};

let data = null;
let pullTimer = 0;
let checkTimer = 0;
let wired = false;

const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');
const size = (gb) => (gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb} GB`);

function needText(m, hw) {
  if (m.how === 'phone') return t('Runs on the phone');
  if (m.how === 'voice') return t('Runs on the processor');
  if (hw?.basis === 'cpu') return t('Runs on the processor with {gb} GB of memory', { gb: Math.max(m.cpuRamGb ?? 0, 4) });
  return m.minGb ? t('Needs {gb} GB of graphics memory', { gb: m.minGb }) : t('Runs on almost any computer');
}

function testedChip(q) {
  if (q.kind === 'here') return el('span', `pl-chip fm-chip ${q.passed === q.of ? 'ok' : 'warn'}`, t('Tested here: {passed}/{of}, {date}', { passed: q.passed, of: q.of, date: day(q.at) }));
  if (q.kind === 'eval') return el('span', 'pl-chip fm-chip ok', q.score ? t('Tested in our results: {score}', { score: q.score }) : t('Tested in our results'));
  return el('span', 'pl-chip fm-chip', t('Untested'));
}

function actionFor(row) {
  const m = row.pick;
  const box = el('span', 'fm-act');
  const running = data?.pull?.state === 'running';
  if (row.action === 'installed') {
    box.append(el('span', 'pl-chip fm-chip ok', t('Downloaded')));
    if (row.job === 'chat') {
      const b = el('button', 'ghost small', t('Use for talking'));
      b.type = 'button';
      b.addEventListener('click', () => void use(row.installed, b));
      box.append(' ', b);
    }
  } else if (row.action === 'download') {
    const b = el('button', 'small', running && data.pull.model === m.pull ? t('Downloading…') : t('Download'));
    b.type = 'button';
    b.disabled = running || Boolean(data?.privateLocal);
    b.title = data?.privateLocal ? t('Downloading needs the internet: turn “Nothing leaves this computer” off for the download, then on again.') : '';
    b.addEventListener('click', () => void download(m.pull, b));
    box.append(b);
    const p = data?.pull;
    if (running && p.model === m.pull) {
      const gbs = (n) => (n / 1024 ** 3).toFixed(1);
      box.append(el('span', 'muted small fm-progress', p.totalBytes ? t('Downloading {model}: {done} of {total} GB ({pct}%)', { model: m.pull, done: gbs(p.completedBytes), total: gbs(p.totalBytes), pct: p.percent ?? 0 }) : t('Downloading {model}: starting…', { model: m.pull })));
    }
  } else if (row.action === 'get-ollama') {
    box.append(el('span', 'muted small', t('Needs Ollama (see above)')));
  } else if (row.action === 'voice') {
    const b = el('button', 'ghost small', t('Set up in Voice'));
    b.type = 'button';
    b.addEventListener('click', () => {
      location.hash = '#view=settings:her-voice';
    });
    box.append(b);
  } else if (row.action === 'phone') {
    box.append(el('span', 'muted small', t('The Android app offers it when you turn on its offline copy.')));
  }
  return box;
}

function card(row, hw) {
  const c = el('div', 'fm-job');
  c.dataset.job = row.job;
  const head = el('p', 'fm-head');
  head.append(el('strong', '', JOB[row.job]?.() ?? row.job));
  c.append(head);
  if (!row.pick) {
    const need = row.smallest?.minGb ?? 0;
    c.append(el('p', 'muted small', t('Needs about {gb} GB of graphics memory; this computer has less. A cloud model can do this job.', { gb: need })));
    return c;
  }
  const m = row.pick;
  const line = el('p', 'fm-line');
  line.append(el('span', 'fm-name', m.name), ' ', testedChip(m.tested));
  c.append(line);
  c.append(el('p', 'muted small', [size(m.sizeGb), needText(m, hw), t('License: {license}', { license: m.license })].join(' · ')));
  const act = el('div', 'fm-row');
  act.append(actionFor(row));
  c.append(act);
  const why = el('details', 'fm-why');
  why.append(el('summary', '', t('Why this one')));
  why.append(el('p', 'small', t(m.why)));
  if (m.tested.kind === 'eval') why.append(el('p', 'muted small', t('From our own results: {label}.', { label: t(m.tested.label) })));
  if (m.tested.kind === 'untested') why.append(el('p', 'muted small', t('We have not tested this one ourselves yet. Re-check now tests it once it is downloaded.')));
  if (row.others.length) why.append(el('p', 'muted small', t('Also fits: {names}', { names: row.others.map((o) => `${o.name} (${size(o.sizeGb)})`).join(', ') })));
  c.append(why);
  return c;
}

function renderRecheck(rc) {
  const sw = $('#fm-recheck-on');
  if (sw) sw.checked = Boolean(rc.on);
  const now = $('#fm-recheck-now');
  if (now) now.disabled = Boolean(rc.running) || data?.ollama?.found === false;
  const s = $('#fm-recheck-status');
  if (!s) return;
  s.textContent = rc.running
    ? t('Re-checking… big models load one at a time, so this can take a few minutes.')
    : rc.lastRun
      ? t('Last re-check: {date}.', { date: day(rc.lastRun) })
      : t('Not re-checked on this computer yet.');
  clearTimeout(checkTimer);
  if (rc.running) checkTimer = setTimeout(() => void pollCheck(), 3000);
}

function render(d) {
  data = d;
  const list = $('#fm-list');
  if (!list) return;
  list.replaceChildren(...d.jobs.map((row) => card(row, d.hardware)));
  $('#fm-version').textContent = t('Free model list from {date}. Sizes are the download; nothing downloads until you press a button.', { date: day(`${d.updated}T12:00:00`) });
  renderRecheck(d.recheck);
  clearTimeout(pullTimer);
  if (d.pull?.state === 'running') pullTimer = setTimeout(() => void loadFreeModels(), 1500);
}

async function download(model, btn) {
  btn.disabled = true;
  try {
    await api('/local-models/pull', { body: { model, use: false } });
    $('#fm-recheck-status').textContent = t('Downloading {model}: starting…', { model });
  } catch (err) {
    $('#fm-recheck-status').textContent = err.message;
  }
  void loadFreeModels();
}

async function use(model, btn) {
  btn.disabled = true;
  try {
    await api('/local-models/use', { body: { model } });
    $('#fm-recheck-status').textContent = t('She now uses {model} for talking and background work.', { model });
  } catch (err) {
    $('#fm-recheck-status').textContent = err.message;
  }
}

async function pollCheck() {
  try {
    const rc = await api('/local-models/recheck');
    if (!rc.running) return void loadFreeModels();
    renderRecheck(rc);
  } catch {
    /* the next open shows it */
  }
}

function wire() {
  if (wired) return;
  wired = true;
  $('#fm-recheck-on')?.addEventListener('change', async (e) => {
    const box = e.currentTarget;
    try {
      renderRecheck(await api('/local-models/recheck', { method: 'PUT', body: { on: box.checked } }));
    } catch (err) {
      $('#fm-recheck-status').textContent = err.message;
    }
  });
  $('#fm-recheck-now')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      renderRecheck(await api('/local-models/recheck', { body: {} }));
    } catch (err) {
      $('#fm-recheck-status').textContent = err.message;
      b.disabled = false;
    }
  });
}

/** Loads the list (Settings → On this computer opens it). */
export async function loadFreeModels() {
  if (!$('#fm-list')) return;
  wire();
  try {
    render(await api('/local-models/recommended'));
  } catch (err) {
    $('#fm-recheck-status').textContent = err.message;
  }
}
