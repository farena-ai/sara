// Phase 67: Settings → Models → On this computer. The "Nothing leaves this computer" switch (private
// local mode; the server enforces it at one choke point, src/net-guard.ts), the list of what it
// pauses, and a model on this computer: Ollama found (or how to get it), the hardware, a suggested
// model, Download with progress and Cancel, and the models already here with Use.
import { serverText, t } from './naming.js';
import { EMBED_TAG } from './model-count.js';

const $ = (sel) => document.querySelector(sel);
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
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

/** The "what would leave" lines, by id (the server sends English as a fallback). */
const LEAVE = {
  'cloud-models': () => t('Cloud models and subscriptions'),
  web: () => t('Web search and web pages'),
  'model-lists': () => t('Daily model list checks for cloud providers'),
  updates: () => t('Checking for updates'),
  reports: () => t('Sending a reported reply to the developer (it is still kept here)'),
  telegram: () => t('Telegram'),
  discord: () => t('Discord'),
  google: () => t('Gmail and Google Calendar'),
  github: () => t('GitHub'),
  push: () => t('Notifications to phones and browsers'),
  offsite: () => t('Off-server backup copies (S3)'),
  pictures: () => t('Pictures of her (Grok Imagine)'),
  voice: () => t('Cloud voices, hearing and live calls'),
  weather: () => t('Weather and travel times'),
  mcp: () => t('Other programs (MCP) on other computers'),
  home: () => t('Home Assistant on another computer'),
  alexa: () => t('Alexa (your own skill; it runs at Amazon)'),
  shell: () => t('Internet for her commands (builds, npm install, git push)'),
};

/** What each suggested model is like (the server's table: src/local-models.ts). */
const NOTES = {
  'qwen3.5:2b': () => t('Small and quick: fine for short chats and memory notes; weak at tools.'),
  'qwen3.5:4b': () => t('Fine for everyday chat and quick jobs; weak at coding.'),
  'qwen3.5:9b': () => t('Usable chat and simple tools.'),
  'gemma4:12b': () => t('Good chat, decent tools, can see pictures.'),
  'gpt-oss:20b': () => t('Good chat and tools.'),
  'qwen3.8:27b': () => t('Strong chat, coding and tools: what the published results used.'),
};

let helpers = { openSettings: () => {} };
let view = null; // /api/private-local
let models = null; // /api/local-models
let pollTimer = 0;

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

/** The header badge while nothing may leave this computer. */
export function setPrivateBadge(on) {
  const b = $('#pl-badge');
  if (b) b.hidden = !on;
  document.body.classList.toggle('private-local', Boolean(on));
}

function renderPrivate(v) {
  view = v;
  setPrivateBadge(v.on);
  const sw = $('#pl-on');
  sw.checked = v.on;
  sw.disabled = Boolean(v.locked || v.demo);
  $('#pl-status').textContent = v.demo
    ? t('Not available in the demo.')
    : v.locked
      ? t('Set by SARA_PRIVATE_LOCAL=1 on this server: it stays on.')
      : v.on
        ? t('On since {date}. Sara only connects to this computer.', { date: new Date(v.since).toLocaleString() })
        : t('Off. Sara may use the internet for what you set up.');
  $('#pl-need').hidden = v.on || v.localModels.length > 0;
  const items = [...v.leave].sort((a, b) => Number(b.active) - Number(a.active));
  $('#pl-leave').replaceChildren(
    ...items.map((it) => {
      const li = el('li', it.active ? 'pl-item active' : 'pl-item');
      li.append(el('span', '', (LEAVE[it.id] ?? (() => it.label))()));
      if (it.names?.length) li.append(el('span', 'muted small', ` (${it.names.join(', ')})`));
      li.append(el('span', `pl-chip${it.active && v.on ? ' paused' : ''}`, it.active ? (v.on ? t('paused') : t('set up')) : t('not set up')));
      return li;
    }),
  );
}

function renderModels(m) {
  models = m;
  const box = $('#lm-ollama');
  if (m.ollama.found) {
    // Phase 114 (F4): counted like the first-run guide and Default model (embedding models left out).
    const here = m.ollama.models.filter((x) => !x.cloud && !EMBED_TAG.test(x.name));
    box.replaceChildren(el('p', 'small', t('Ollama {version} is running on this computer, with {n} models here.', { version: m.ollama.version ?? '', n: here.length })));
  } else {
    const p = el('p', 'small', t("Ollama isn't running on this computer. It's a free program that runs AI models on your own computer; Sara uses it for models here."));
    const actions = el('p', 'actions-left');
    const dl = el('a', 'button', t('Download Ollama'));
    dl.href = m.download;
    dl.target = '_blank';
    dl.rel = 'noopener';
    const again = el('button', 'ghost', t('Look again'));
    again.type = 'button';
    again.addEventListener('click', () => void loadLocalModels());
    actions.append(dl, ' ', again);
    box.replaceChildren(p, actions);
    if (m.winget) {
      const w = el('button', 'ghost small', t('Install Ollama with winget'));
      w.type = 'button';
      w.addEventListener('click', () => void installWinget());
      const note = el('p', 'muted small', t('Or let Windows install it for you: this runs “winget install Ollama.Ollama” on this computer. Windows may ask for permission. Nothing is installed until you press it.'));
      box.append(note, w);
    }
    if (m.install) box.append(el('pre', 'oa-snip', `${m.install.state === 'running' ? t('Installing…') : m.install.state === 'done' ? t('Installed. Press Look again.') : t('winget stopped with a problem.')}\n${m.install.output}`));
  }
  $('#lm-pick').hidden = !m.ollama.found;
  if (!m.ollama.found) {
    $('#lm-installed-box').hidden = true;
    return;
  }
  const hw = m.hardware;
  $('#lm-hw').textContent =
    hw.basis === 'gpu'
      ? t('Graphics card: {name}, {vram} GB.', { name: hw.gpu.name, vram: hw.gpu.vramGb })
      : hw.basis === 'unified'
        ? t('Mac with Apple silicon: {ram} GB of memory, about {budget} GB for a model.', { ram: hw.ramGb, budget: hw.budgetGb })
        : t('No graphics card found: {ram} GB of memory. Models run on the processor (slower).', { ram: hw.ramGb });
  const have = new Set(m.ollama.models.map((x) => x.name));
  const sel = $('#lm-model');
  const keep = sel.value;
  sel.replaceChildren(
    ...m.tiers.map((tier) => {
      const o = el('option', '', `${tier.model} · ${tier.sizeGb} GB${tier.model === m.recommended.model ? ` · ${t('suggested for this computer')}` : ''}${have.has(tier.model) ? ` · ${t('downloaded')}` : ''}`);
      o.value = tier.model;
      return o;
    }),
  );
  sel.value = m.tiers.some((x) => x.model === keep) ? keep : m.recommended.model;
  renderPick();
  renderPull(m.pull);
  const here = m.ollama.models.filter((x) => !x.cloud);
  $('#lm-installed-box').hidden = !here.length;
  $('#lm-installed').replaceChildren(
    ...here.map((x) => {
      const li = el('li');
      li.append(el('span', 'lm-name', `${x.name} · ${x.sizeGb < 0.1 ? '<0.1' : x.sizeGb} GB`));
      if (m.using?.model === x.name) li.append(el('span', 'pl-chip', t('in use')));
      else if (!/embed|minilm|bge-|e5-/i.test(x.name)) {
        const b = el('button', 'ghost small', t('Use'));
        b.type = 'button';
        b.addEventListener('click', () => void useModel(x.name, b));
        li.append(b);
      }
      return li;
    }),
  );
}

function renderPick() {
  if (!models) return;
  const model = $('#lm-model').value;
  $('#lm-note').textContent = (NOTES[model] ?? (() => models.tiers.find((x) => x.model === model)?.note ?? ''))();
  const have = models.ollama.models.some((x) => x.name === model);
  const running = models.pull?.state === 'running';
  const btn = $('#lm-download');
  btn.textContent = have ? t('Use this model') : t('Download this model');
  btn.disabled = running || (!have && Boolean(view?.on));
  const offline = !have && Boolean(view?.on) && !running;
  $('#lm-offline').hidden = !offline;
  $('#lm-offline').textContent = offline ? t('Downloading needs the internet: turn “Nothing leaves this computer” off for the download, then on again.') : '';
}

function renderPull(p) {
  const running = p?.state === 'running';
  $('#lm-cancel').hidden = !running;
  const bar = $('#lm-progress');
  bar.hidden = !running;
  if (running) {
    if (p.percent === null) bar.removeAttribute('value');
    else bar.value = p.percent;
  }
  const s = $('#lm-pull-status');
  if (!p) s.textContent = '';
  else if (running) s.textContent = p.totalBytes ? t('Downloading {model}: {done} of {total} GB ({pct}%)', { model: p.model, done: gb(p.completedBytes), total: gb(p.totalBytes), pct: p.percent ?? 0 }) : t('Downloading {model}: starting…', { model: p.model });
  else if (p.state === 'done') s.textContent = models?.using?.model === p.model ? t('{model} is downloaded. She now uses it for talking and background work.', { model: p.model }) : t('{model} is downloaded.', { model: p.model });
  else if (p.state === 'cancelled') s.textContent = t('Download cancelled. Ollama keeps what it has, so pressing Download again carries on.');
  else if (p.state === 'error') s.textContent = t('The download stopped: {error}', { error: p.error ?? '' });
  clearTimeout(pollTimer);
  if (running) pollTimer = setTimeout(() => void pollPull(), 1000);
}

async function pollPull() {
  try {
    const r = await api('/local-models/pull');
    if (models) models.pull = r.pull;
    renderPull(r.pull);
    if (r.pull && r.pull.state !== 'running') void loadLocalModels();
  } catch {
    /* the next look shows it */
  }
}

async function useModel(model, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/local-models/use', { method: 'POST', body: { model } });
    $('#lm-pull-status').textContent = t('She now uses {model} for talking and background work.', { model });
    await loadLocalModels();
  } catch (err) {
    $('#lm-pull-status').textContent = err.message;
    if (btn) btn.disabled = false;
  }
}

async function download() {
  const model = $('#lm-model').value;
  if (models?.ollama.models.some((x) => x.name === model)) return useModel(model, $('#lm-download'));
  $('#lm-download').disabled = true;
  try {
    const r = await api('/local-models/pull', { method: 'POST', body: { model } });
    models.pull = r.pull;
    renderPull(r.pull);
  } catch (err) {
    $('#lm-pull-status').textContent = err.message;
  } finally {
    renderPick();
  }
}

async function installWinget() {
  if (!confirm(t('Install Ollama now? This runs “winget install Ollama.Ollama” on this computer (it downloads Ollama from the internet). Windows may ask for permission.'))) return;
  try {
    await api('/local-models/install-ollama', { method: 'POST', body: { confirm: true } });
  } catch (err) {
    $('#lm-pull-status').textContent = err.message;
  }
  const tick = async () => {
    await loadLocalModels();
    if (models?.install?.state === 'running') setTimeout(() => void tick(), 2000);
  };
  void tick();
}

async function toggle() {
  const sw = $('#pl-on');
  const want = sw.checked;
  if (!want && !confirm(t('Turn off “Nothing leaves this computer”? Sara can then reach the internet again for what you set up (cloud models, web search, bridges, notifications).'))) {
    sw.checked = true;
    return;
  }
  sw.disabled = true;
  try {
    renderPrivate(await api('/private-local', { method: 'PUT', body: { on: want, ...(want ? {} : { confirm: true }) } }));
    if (models) renderPick();
  } catch (err) {
    sw.checked = !want;
    $('#pl-status').textContent = err.message;
    if (err.data?.needsModel) $('#pl-need').hidden = false;
  } finally {
    sw.disabled = Boolean(view?.locked || view?.demo);
  }
}

export async function loadLocalModels() {
  const [v, m] = await Promise.all([api('/private-local').catch((err) => ({ error: err.message })), api('/local-models').catch((err) => ({ error: err.message }))]);
  if (v.error) $('#pl-status').textContent = v.error;
  else renderPrivate(v);
  if (m.error) $('#lm-ollama').replaceChildren(el('p', 'small', m.error));
  else renderModels(m);
}

export function initLocalModels(h) {
  helpers = { ...helpers, ...h };
  $('#pl-on').addEventListener('change', () => void toggle());
  $('#lm-model').addEventListener('change', renderPick);
  $('#lm-download').addEventListener('click', () => void download());
  $('#lm-cancel').addEventListener('click', async () => {
    const r = await api('/local-models/pull', { method: 'DELETE' }).catch(() => null);
    if (r) renderPull(r.pull);
  });
  $('#pl-badge').addEventListener('click', () => helpers.openSettings('models-local'));
}
