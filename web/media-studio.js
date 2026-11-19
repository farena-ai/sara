// U4.28 (docs/PICTURES.md "Editing pictures and short video"): Library → Pictures and video (status of
// the local ComfyUI, what can be offered, short clips with progress + cancel, the pictures and clips
// made), the picture editor (mask brush, extend, upscale, background, restyle with a strength,
// before/after, versions) and the Settings section under Pictures from her. The owner's only.
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
let caps = null;
let editing = null; // { id, versions, after }
let maskCtx = null;
let paintCtx = null;
let painted = false;
const polls = new Map();

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
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, t('Something went wrong.')));
  return data;
}
const fileUrl = (id) => `/api/media/file/${id}`;

const OP_LABEL = { inpaint: () => t('Paint over a part and change it'), outpaint: () => t('Extend the edges'), upscale: () => t('Upscale (bigger, sharper)'), background: () => t('Remove the background'), restyle: () => t('Change the style') };
const PHASE = { sending: () => t('Sending it to ComfyUI…'), waiting: () => t('Waiting for ComfyUI…'), working: () => t('ComfyUI is working on it…'), saving: () => t('Saving it to the Library…') };
const elapsed = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
function jobLine(j) {
  if (j.status === 'done') return t('Done.');
  if (j.status === 'cancelled') return t('Cancelled; nothing was saved.');
  if (j.status === 'failed') return j.error || t('Something went wrong.');
  return `${PHASE[j.phase]?.() ?? ''} ${elapsed(j.startedAt)}`;
}

// ---------- caps (status + fallbacks) -----------------------------------------------------------
async function loadCaps(fresh = false) {
  try {
    const d = await api(`/media${fresh ? '?fresh=1' : ''}`);
    caps = d.caps;
    return d;
  } catch (err) {
    caps = null;
    return { error: err.message };
  }
}
function capsText(c) {
  if (!c) return t('Something went wrong.');
  if (!c.connected) return c.why || t("ComfyUI isn't connected.");
  const v = [c.video?.t2v && t('video from words ({name})', { name: c.video.t2v.label }), c.video?.i2v && t('video from a picture ({name})', { name: c.video.i2v.label })].filter(Boolean);
  return v.length ? t('ComfyUI is connected. Video: {list}.', { list: v.join(', ') }) : t('ComfyUI is connected.');
}
function renderCaps(box, c) {
  box.replaceChildren();
  if (!c?.connected) return;
  const ul = el('ul', 'mx-caplist');
  for (const op of ['inpaint', 'outpaint', 'upscale', 'background', 'restyle']) {
    const e = c.edits[op];
    const li = el('li', e.ok ? 'mx-ok' : 'mx-no');
    li.append(el('span', 'mx-capname', `${e.ok ? '✓' : '✕'} ${OP_LABEL[op]()}`));
    if (e.note) li.append(el('span', 'muted small', ` ${t(e.note)}`));
    ul.append(li);
  }
  box.append(ul);
  if (c.video?.note) box.append(el('p', 'muted small', t(c.video.note, { list: (c.video.found ?? []).join(', ') })));
}

// ---------- jobs ----------------------------------------------------------------------------------
function watch(job, onEnd) {
  if (polls.has(job.id)) return;
  const tick = async () => {
    let j;
    try {
      j = (await api(`/media/jobs/${job.id}`)).job;
    } catch {
      polls.delete(job.id);
      return;
    }
    onEnd(j, j.status !== 'running');
    if (j.status === 'running') polls.set(job.id, setTimeout(tick, 1500));
    else polls.delete(job.id);
  };
  polls.set(job.id, setTimeout(tick, 600));
}
function stopWatching() {
  for (const h of polls.values()) clearTimeout(h);
  polls.clear();
}

function jobRow(j) {
  const row = el('div', `mx-job mx-${j.status}`);
  row.dataset.job = j.id;
  const what = j.kind === 'video' ? t('Short video') : OP_LABEL[j.op]?.() ?? j.op;
  row.append(el('strong', '', what));
  if (j.prompt) row.append(el('span', 'muted small mx-jp', j.prompt));
  const st = el('span', 'small mx-js', jobLine(j));
  st.setAttribute('role', 'status');
  row.append(st);
  if (j.status === 'running') {
    const c = el('button', 'ghost small', t('Cancel'));
    c.type = 'button';
    c.addEventListener('click', async () => {
      c.disabled = true;
      await api(`/media/jobs/${j.id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
    });
    row.append(c);
  } else if (j.status === 'done' && j.libraryId) {
    const o = el('button', 'ghost small', t('Open'));
    o.type = 'button';
    o.addEventListener('click', () => (j.kind === 'video' ? window.open(fileUrl(j.libraryId), '_blank', 'noopener') : void openPictureEditor(j.libraryId)));
    row.append(o);
  }
  return row;
}
function renderJobs(jobs) {
  const box = $('#mx-jobs');
  if (!box) return;
  box.replaceChildren(...jobs.slice(0, 8).map(jobRow));
  for (const j of jobs) if (j.status === 'running') watch(j, (n, end) => {
    const old = box.querySelector(`[data-job="${n.id}"]`);
    if (old) old.replaceWith(jobRow(n));
    if (end) void loadItems();
  });
}

// ---------- Library → Pictures and video --------------------------------------------------------
async function loadItems() {
  const box = $('#mx-items');
  const start = $('#mx-v-start');
  if (!box) return;
  let items = [];
  try {
    items = (await api('/media/items')).items;
  } catch {}
  box.replaceChildren();
  if (!items.length) box.append(el('p', 'muted small', t('No pictures yet. Add one to the Library, then edit it here.')));
  for (const it of items) {
    const card = el('figure', 'mx-item');
    const img = el('img');
    img.src = fileUrl(it.id);
    img.alt = it.name;
    img.loading = 'lazy';
    card.append(img, el('figcaption', 'small', it.kind === 'video' ? `🎞️ ${it.name}` : it.name));
    const b = el('button', 'ghost small', it.kind === 'video' ? t('Open') : t('Edit…'));
    b.type = 'button';
    b.addEventListener('click', () => (it.kind === 'video' ? window.open(fileUrl(it.id), '_blank', 'noopener') : void openPictureEditor(it.id)));
    card.append(b);
    box.append(card);
  }
  if (start) {
    const keep = start.value;
    start.replaceChildren(el('option', '', t('Words only')));
    start.firstChild.value = '';
    for (const it of items.filter((x) => x.kind === 'image')) {
      const o = el('option', '', it.name);
      o.value = String(it.id);
      start.append(o);
    }
    start.value = keep;
  }
}

export async function openMediaView() {
  const lib = $('#library');
  if (lib && !lib.open) await (await import('./library.js')).openLibrary();
  for (const id of ['#lib-home', '#lib-doc', '#lib-study', '#lib-research', '#lib-learned', '#lib-meetings']) {
    const s = $(id);
    if (s) s.hidden = true;
  }
  $('#lib-media').hidden = false;
  $('#mx-status').textContent = t('Checking ComfyUI…');
  const d = await loadCaps();
  $('#mx-status').textContent = d.error ?? capsText(caps);
  renderCaps($('#mx-caps'), caps);
  const sec = $('#mx-v-seconds');
  if (sec && d.prefs?.seconds) sec.value = String(d.prefs.seconds);
  $('#mx-v-go').disabled = !(caps?.connected && (caps.video?.t2v || caps.video?.i2v));
  renderJobs(d.jobs ?? []);
  await loadItems();
}
function closeMediaView() {
  stopWatching();
  $('#lib-media').hidden = true;
  $('#lib-home').hidden = false;
}

async function makeClip() {
  const prompt = $('#mx-v-prompt').value.trim();
  const st = $('#mx-status');
  if (!prompt) {
    st.textContent = t('Say what the clip should show.');
    return;
  }
  const go = $('#mx-v-go');
  go.disabled = true;
  try {
    const startId = Number($('#mx-v-start').value) || undefined;
    const { job } = await api('/media/video', { method: 'POST', body: { prompt, libraryId: startId, seconds: Number($('#mx-v-seconds').value) } });
    const d = await api('/media');
    renderJobs(d.jobs ?? [job]);
    st.textContent = t('Started. You can keep using Sara; the clip lands here.');
  } catch (err) {
    st.textContent = err.message;
  } finally {
    go.disabled = false;
  }
}

// ---------- the editor -----------------------------------------------------------------------------
function showFields() {
  const op = $('#mx-op').value;
  $('#mx-f-brush').hidden = op !== 'inpaint';
  $('#mx-mask').hidden = op !== 'inpaint';
  $('#mx-f-prompt').hidden = op === 'upscale' || op === 'background';
  $('#mx-f-strength').hidden = op !== 'restyle';
  $('#mx-f-pad').hidden = op !== 'outpaint';
  $('#mx-f-scale').hidden = op !== 'upscale';
  $('#mx-prompt').placeholder = op === 'inpaint' ? t('Leave empty to just remove what you painted') : op === 'restyle' ? t('For example: a watercolor painting') : t('What should appear (optional)');
  const e = caps?.edits?.[op];
  $('#mx-op-note').textContent = e?.note ? t(e.note) : '';
  $('#mx-go').disabled = !caps?.connected || e?.ok === false;
}

function setupMask(img) {
  const c = $('#mx-mask');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  paintCtx = c.getContext('2d');
  const off = document.createElement('canvas');
  off.width = c.width;
  off.height = c.height;
  maskCtx = off.getContext('2d');
  maskCtx.fillStyle = 'black';
  maskCtx.fillRect(0, 0, off.width, off.height);
  painted = false;
}
function clearMask() {
  if (!paintCtx) return;
  paintCtx.clearRect(0, 0, paintCtx.canvas.width, paintCtx.canvas.height);
  maskCtx.fillStyle = 'black';
  maskCtx.fillRect(0, 0, maskCtx.canvas.width, maskCtx.canvas.height);
  painted = false;
}
function bindBrush() {
  const c = $('#mx-mask');
  let down = false;
  let last = null;
  const at = (e) => {
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, k: c.width / r.width };
  };
  const stroke = (a, b) => {
    const size = Number($('#mx-brush').value) * b.k;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || 'currentColor';
    for (const [ctx, color] of [[paintCtx, accent], [maskCtx, 'white']]) {
      ctx.save();
      ctx.globalAlpha = ctx === paintCtx ? 0.55 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x + 0.01, b.y);
      ctx.stroke();
      ctx.restore();
    }
    painted = true;
  };
  c.addEventListener('pointerdown', (e) => {
    if (!paintCtx) return;
    down = true;
    c.setPointerCapture(e.pointerId);
    last = at(e);
    stroke(last, last);
    e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (!down) return;
    const p = at(e);
    stroke(last, p);
    last = p;
  });
  for (const ev of ['pointerup', 'pointercancel']) c.addEventListener(ev, () => (down = false));
}

function setCompare(on) {
  $('#mx-f-compare').hidden = !on;
  $('#mx-after-wrap').hidden = !on;
  $('#mx-stage').classList.toggle('mx-cmp', on);
  if (on) $('#mx-stage').style.setProperty('--mx-cut', `${$('#mx-compare').value}%`);
}

async function loadVersions(id) {
  const box = $('#mx-versions');
  let v = [];
  try {
    v = (await api(`/media/versions/${id}`)).versions;
  } catch {}
  box.replaceChildren();
  for (const x of v) {
    const b = el('button', `mx-ver${x.libraryId === editing.id ? ' on' : ''}`);
    b.type = 'button';
    const img = el('img');
    img.src = fileUrl(x.libraryId);
    img.alt = '';
    b.append(img, el('span', 'small', x.version === 1 ? t('Original') : t('Version {n}', { n: x.version })));
    b.title = x.note || (OP_LABEL[x.op]?.() ?? '');
    b.setAttribute('aria-pressed', String(x.libraryId === editing.id));
    b.addEventListener('click', () => void showPicture(x.libraryId, null));
    box.append(b);
  }
}

async function showPicture(id, beforeId) {
  editing = { id };
  const before = $('#mx-before');
  setCompare(false);
  await new Promise((resolve) => {
    before.onload = resolve;
    before.onerror = resolve;
    before.src = fileUrl(beforeId ?? id);
  });
  if (beforeId) {
    $('#mx-after').src = fileUrl(id);
    setCompare(true);
  }
  setupMask(before);
  await loadVersions(id);
}

export async function openPictureEditor(id) {
  const dlg = $('#mx-editor');
  if (!dlg) return;
  if (!dlg.open) dlg.showModal();
  $('#mx-state').textContent = '';
  $('#mx-cancel').hidden = true;
  if (!caps) await loadCaps();
  showFields();
  if (!caps?.connected) $('#mx-state').textContent = caps?.why || t("ComfyUI isn't connected.");
  await showPicture(id, null);
}

async function runEdit() {
  const op = $('#mx-op').value;
  const st = $('#mx-state');
  if (op === 'inpaint' && !painted) {
    st.textContent = t('Paint over the part to change first.');
    return;
  }
  const body = { libraryId: editing.id, op, prompt: $('#mx-prompt').value.trim() || undefined };
  if (op === 'inpaint') body.mask = maskCtx.canvas.toDataURL('image/png');
  if (op === 'restyle') body.strength = Number($('#mx-strength').value);
  if (op === 'outpaint') {
    const side = $('#mx-pad').value;
    const px = 256;
    body.pad = { left: side === 'left' || side === 'all' ? px : 0, right: side === 'right' || side === 'all' ? px : 0, top: side === 'top' || side === 'all' ? px : 0, bottom: side === 'bottom' || side === 'all' ? px : 0 };
  }
  if (op === 'upscale') body.scale = $('#mx-scale').value;
  const go = $('#mx-go');
  go.disabled = true;
  const from = editing.id;
  try {
    const { job } = await api('/media/edit', { method: 'POST', body });
    st.textContent = jobLine(job);
    const cancel = $('#mx-cancel');
    cancel.hidden = false;
    cancel.disabled = false;
    cancel.onclick = async () => {
      cancel.disabled = true;
      await api(`/media/jobs/${job.id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
    };
    watch(job, async (j, end) => {
      st.textContent = jobLine(j);
      if (!end) return;
      cancel.hidden = true;
      go.disabled = false;
      if (j.status === 'done' && $('#mx-editor').open) await showPicture(j.libraryId, from);
    });
  } catch (err) {
    st.textContent = err.message;
    go.disabled = false;
  }
}

// ---------- Settings → Pictures from her → Editing and short video --------------------------------
export async function loadMediaSettings() {
  const box = $('#mx-settings');
  if (!box) return;
  const st = $('#mx-s-status');
  st.textContent = t('Checking ComfyUI…');
  const d = await loadCaps();
  st.textContent = d.error ?? capsText(caps);
  const ck = $('#mx-s-ckpt');
  ck.replaceChildren();
  for (const name of caps?.checkpoints ?? []) {
    const o = el('option', '', name);
    o.value = name;
    ck.append(o);
  }
  if (!ck.options.length) ck.append(el('option', '', t('None found')));
  ck.value = caps?.checkpoint ?? '';
  ck.disabled = !caps?.checkpoints?.length;
  $('#mx-s-seconds').value = String(d.prefs?.seconds ?? 3);
  const vid = $('#mx-s-video');
  const keep = d.prefs?.videoWorkflow ?? '';
  vid.replaceChildren(el('option', '', t('Automatic')));
  vid.firstChild.value = '';
  try {
    for (const n of (await api('/media/workflows')).names) {
      const o = el('option', '', n.replace(/\.json$/i, ''));
      o.value = n;
      vid.append(o);
    }
  } catch {}
  vid.value = keep;
}
async function saveMediaPrefs() {
  const st = $('#mx-s-status');
  try {
    await api('/media/prefs', { method: 'PUT', body: { checkpoint: $('#mx-s-ckpt').value, videoWorkflow: $('#mx-s-video').value, seconds: Number($('#mx-s-seconds').value) } });
    caps = null;
    st.textContent = t('Saved.');
  } catch (err) {
    st.textContent = err.message;
  }
}

export function initMediaStudio() {
  $('#lib-media-open')?.addEventListener('click', () => void openMediaView());
  $('#lib-mx-back')?.addEventListener('click', closeMediaView);
  $('#mx-v-go')?.addEventListener('click', () => void makeClip());
  $('#lib-doc-edit')?.addEventListener('click', (e) => {
    const id = Number(e.currentTarget.dataset.id);
    if (id) void openPictureEditor(id);
  });
  if ($('#mx-editor')) {
    bindBrush();
    $('#mx-op').addEventListener('change', showFields);
    $('#mx-clear').addEventListener('click', clearMask);
    $('#mx-go').addEventListener('click', () => void runEdit());
    $('#mx-compare').addEventListener('input', () => setCompare(true));
    $('#mx-editor').addEventListener('close', () => {
      editing = null;
    });
  }
  for (const id of ['#mx-s-ckpt', '#mx-s-video', '#mx-s-seconds']) $(id)?.addEventListener('change', () => void saveMediaPrefs());
  $('#mx-s-check')?.addEventListener('click', async () => {
    caps = null;
    await api('/media?fresh=1').catch(() => {});
    await loadMediaSettings();
  });
}
