// V2.5 Snap and file (docs/design/SNAP.md): Library → Scan pages. Pages come from the live camera
// (phone app, phone browser or a webcam) or from photos; each is cropped to the page and
// straightened (web/scan-math.js; drag the corners to fix it), turned, reordered, then saved in one
// tap as one PDF in the Library (POST /api/library/scan). The usual reader reads the pages and
// What Sara knows finds their dates; this view shows both and offers the reminders.
import { t } from './naming.js';
import { jobText, openLibrary } from './library.js';
import { findPageQuad, levels, outSize, rotateRgba, skewAngle, toGray, warpQuad } from './scan-math.js';

const $ = (s) => document.querySelector(s);
/** The longest side a page is kept at (pixels) and sent as (JPEG). */
const KEEP = 2400;
const SEND = 2000;
const AUTO_KEY = 'sara.scan.auto';
/** Pages: { id, src: canvas, corners, turns, thumb }. */
let pages = [];
let editing = null;
let stream = null;
let polling = 0;
let seq = 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick, title) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('click', onClick);
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const status = (s) => {
  const n = $('#scan-status');
  if (n) n.textContent = s;
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
/** Draws a picture (image, video frame, bitmap) into a canvas whose longest side is at most `max`. */
function fit(src, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = canvas(w * k, h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);

/** The page's corners on its picture: found on a small copy, or the frame turned to straighten text lines. */
function detect(src) {
  const small = fit(src, src.width, src.height, 420);
  const k = src.width / small.width;
  const g = toGray(pixels(small).data, small.width, small.height);
  const q = findPageQuad(g, small.width, small.height);
  if (q.found) return q.corners.map((p) => ({ x: p.x * k, y: p.y * k }));
  const deg = skewAngle(g, small.width, small.height);
  return Math.abs(deg) >= 0.4 ? tilted(src.width, src.height, deg) : frame(src);
}
const frame = (src) => [{ x: 0, y: 0 }, { x: src.width - 1, y: 0 }, { x: src.width - 1, y: src.height - 1 }, { x: 0, y: src.height - 1 }];
/** The largest rectangle turned by `deg` that fits in the picture (its corners). */
function tilted(w, h, deg) {
  const a = (deg * Math.PI) / 180;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const at = (s) =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([u, v]) => {
      const x = (u * w * s) / 2;
      const y = (v * h * s) / 2;
      return { x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) };
    });
  let s = 1;
  while (s > 0.5 && at(s).some((p) => p.x < 0 || p.y < 0 || p.x > w - 1 || p.y > h - 1)) s -= 0.01;
  return at(s);
}

/** The finished page: cut out straight, turned, light evened out, as a canvas at most SEND px. */
function render(p, max = SEND) {
  const src = pixels(p.src);
  const size = outSize(p.corners);
  const k = Math.min(1, max / Math.max(size.w, size.h));
  const W = Math.max(1, Math.round(size.w * k));
  const H = Math.max(1, Math.round(size.h * k));
  let img = { data: warpQuad(src.data, p.src.width, p.src.height, p.corners, W, H), w: W, h: H };
  for (let i = 0; i < p.turns % 4; i++) img = rotateRgba(img.data, img.w, img.h);
  levels(img.data);
  const c = canvas(img.w, img.h);
  c.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  return c;
}

async function addPicture(src, w, h) {
  const c = fit(src, w, h, KEEP);
  const auto = $('#scan-auto')?.checked !== false;
  const p = { id: ++seq, src: c, corners: auto ? detect(c) : frame(c), turns: 0, thumb: '' };
  p.thumb = render(p, 360).toDataURL('image/jpeg', 0.7);
  pages.push(p);
  drawPages();
}

async function addFiles(files) {
  const list = [...(files ?? [])].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  for (const f of list) {
    status(t('Preparing page {n}…', { n: pages.length + 1 }));
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      await addPicture(bmp, bmp.width, bmp.height);
      bmp.close?.();
    } catch {
      status(t("That picture can't be opened here. Try a JPEG or PNG."));
      return;
    }
  }
  status('');
}

function drawPages() {
  const list = $('#scan-pages');
  if (!list) return;
  list.replaceChildren(
    ...pages.map((p, i) => {
      const li = el('li', 'snap-page');
      const img = el('img', 'snap-thumb');
      img.src = p.thumb;
      img.alt = t('Page {n}', { n: i + 1 });
      const open = btn('', 'snap-open', () => openEdit(p), t('Fix the corners of page {n}', { n: i + 1 }));
      open.append(img);
      const bar = el('div', 'snap-tools');
      bar.append(
        el('span', 'small muted', t('Page {n}', { n: i + 1 })),
        btn('↻', 'ghost small icon', () => turn(p), t('Turn page {n}', { n: i + 1 })),
        btn('←', 'ghost small icon', () => move(i, -1), t('Move page {n} earlier', { n: i + 1 })),
        btn('✕', 'ghost small icon', () => drop(i), t('Remove page {n}', { n: i + 1 })),
      );
      bar.children[2].disabled = i === 0;
      li.append(open, bar);
      return li;
    }),
  );
  $('#scan-save').disabled = !pages.length;
  $('#scan-count').textContent = pages.length ? t('{n} pages', { n: pages.length }) : '';
}
function turn(p) {
  p.turns = (p.turns + 1) % 4;
  p.thumb = render(p, 360).toDataURL('image/jpeg', 0.7);
  drawPages();
}
function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  drawPages();
}
function drop(i) {
  pages.splice(i, 1);
  drawPages();
}

// ---------------------------------------------------------------- fix the corners

function openEdit(p) {
  editing = { p, corners: p.corners.map((c) => ({ ...c })), drag: -1 };
  $('#scan-edit').hidden = false;
  $('#scan-pages').hidden = true;
  drawEdit();
  $('#scan-edit-canvas').focus();
}
function closeEdit(keep) {
  if (editing && keep) {
    editing.p.corners = editing.corners;
    editing.p.thumb = render(editing.p, 360).toDataURL('image/jpeg', 0.7);
  }
  editing = null;
  $('#scan-edit').hidden = true;
  $('#scan-pages').hidden = false;
  drawPages();
}
function drawEdit() {
  if (!editing) return;
  const cv = $('#scan-edit-canvas');
  const src = editing.p.src;
  cv.width = src.width;
  cv.height = src.height;
  const g = cv.getContext('2d');
  g.drawImage(src, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || 'currentColor';
  const r = Math.max(src.width, src.height) / 60;
  g.lineWidth = r / 3;
  g.strokeStyle = accent;
  g.beginPath();
  editing.corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
  g.closePath();
  g.stroke();
  g.fillStyle = accent;
  for (const c of editing.corners) {
    g.beginPath();
    g.arc(c.x, c.y, r, 0, Math.PI * 2);
    g.fill();
  }
}
function toPicture(e) {
  const cv = $('#scan-edit-canvas');
  const b = cv.getBoundingClientRect();
  return { x: ((e.clientX - b.left) / b.width) * cv.width, y: ((e.clientY - b.top) / b.height) * cv.height, k: cv.width / b.width };
}
function editPointer() {
  const cv = $('#scan-edit-canvas');
  cv.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    const p = toPicture(e);
    let best = -1;
    let d = 44 * p.k;
    editing.corners.forEach((c, i) => {
      const dd = Math.hypot(c.x - p.x, c.y - p.y);
      if (dd < d) (d = dd), (best = i);
    });
    editing.drag = best;
    if (best >= 0) {
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!editing || editing.drag < 0) return;
    const p = toPicture(e);
    const src = editing.p.src;
    editing.corners[editing.drag] = { x: Math.min(src.width - 1, Math.max(0, p.x)), y: Math.min(src.height - 1, Math.max(0, p.y)) };
    drawEdit();
  });
  const up = () => editing && (editing.drag = -1);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  // Keyboard: 1-4 picks a corner, arrows move it.
  let pick = 0;
  cv.addEventListener('keydown', (e) => {
    if (!editing) return;
    if (/^[1-4]$/.test(e.key)) pick = Number(e.key) - 1;
    const step = (e.shiftKey ? 20 : 4) * (editing.p.src.width / 400);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const c = editing.corners[pick];
    c.x = Math.min(editing.p.src.width - 1, Math.max(0, c.x + d[0]));
    c.y = Math.min(editing.p.src.height - 1, Math.max(0, c.y + d[1]));
    drawEdit();
  });
}

// ---------------------------------------------------------------- the live camera

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    status(t('The camera works here only over https or on this computer. Use Add photos instead.'));
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
  } catch {
    status(t("The camera didn't start. Allow the camera for Sara, or use Add photos."));
    return;
  }
  const v = $('#scan-video');
  v.srcObject = stream;
  await v.play().catch(() => {});
  $('#scan-live').hidden = false;
  $('#scan-camera').hidden = true;
  status('');
}
function stopCamera() {
  for (const tr of stream?.getTracks() ?? []) tr.stop();
  stream = null;
  const v = $('#scan-video');
  if (v) v.srcObject = null;
  const live = $('#scan-live');
  if (live) live.hidden = true;
  const cam = $('#scan-camera');
  if (cam) cam.hidden = false;
}
async function shoot() {
  const v = $('#scan-video');
  if (!v?.videoWidth) return;
  await addPicture(v, v.videoWidth, v.videoHeight);
  status(t('Page {n} taken. Take the next page, or press Done.', { n: pages.length }));
}

// ---------------------------------------------------------------- save, then show what was read

const jpeg = (c) => c.toDataURL('image/jpeg', 0.85);

async function save() {
  if (!pages.length) return;
  const b = $('#scan-save');
  b.disabled = true;
  stopCamera();
  status(t('Making the PDF…'));
  try {
    const body = { pages: pages.map((p) => jpeg(render(p))), title: $('#scan-title').value.trim(), learn: $('#scan-learn').checked };
    const r = await api('/library/scan', { method: 'POST', body });
    pages = [];
    $('#scan-title').value = '';
    drawPages();
    status(r.already ? t('This scan is already in your library.') : t('Saved to your library as {name}.', { name: r.doc.name }));
    void follow(r.doc.id);
  } catch (err) {
    status(err.message);
    b.disabled = false;
  }
}

async function follow(id) {
  const mine = ++polling;
  const box = $('#scan-result');
  box.hidden = false;
  for (let k = 0; k < 400 && mine === polling && !$('#lib-scan').hidden; k++) {
    let r;
    try {
      r = await api(`/library/scan/${id}`);
    } catch (err) {
      box.replaceChildren(el('p', 'small', err.message));
      return;
    }
    drawResult(r);
    if (r.doc.status === 'failed' || (r.doc.status === 'ready' && (!r.doc.job || r.doc.job.phase === 'done' || r.doc.job.needs))) return;
    if (r.doc.job?.needs) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

function drawResult(r) {
  const box = $('#scan-result');
  const d = r.doc;
  const open = btn(t('Open in the Library'), 'ghost small', () => void openLibrary(d.id));
  const head = el('div', 'snap-result-head');
  head.append(el('strong', '', d.name), open);
  const out = [head];
  const job = jobText(d.job);
  if (d.status === 'failed') out.push(el('p', 'small', d.error || t("She couldn't read it.")));
  else if (d.status !== 'ready' || job) out.push(el('p', 'muted small', job || t('Reading the pages…')));
  if (d.job?.needs === 'ocr-approval') out.push(el('p', 'small', t('Open it in the Library to choose whether a cloud model may read the pages.')));
  if (d.status === 'ready') {
    const sug = r.suggestions ?? [];
    if (sug.length) {
      out.push(el('h3', '', t('Dates she found')));
      const ul = el('ul', 'snap-list');
      for (const s of sug) ul.append(suggestionRow(s, d.id));
      out.push(ul);
    }
    if (r.facts?.length) {
      out.push(el('h3', '', t('Also found')));
      const ul = el('ul', 'snap-list');
      for (const f of r.facts.slice(0, 12)) ul.append(el('li', 'small', f.text));
      out.push(ul);
    }
    if (!sug.length && !r.facts?.length) out.push(el('p', 'muted small', t('No dates or numbers to keep were found. You can still search it and ask her about it.')));
    if (r.text?.length) {
      const det = el('details', 'snap-text');
      det.append(el('summary', '', t('What she read')));
      for (const p of r.text) {
        const para = el('p', 'small', p.text);
        if (p.page) para.prepend(el('span', 'muted', `${t('page {n}', { n: p.page })} · `));
        det.append(para);
      }
      out.push(det);
    }
  }
  box.replaceChildren(...out);
}

function suggestionRow(s, docId) {
  const li = el('li', 'snap-sug');
  const when = new Date(`${s.date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  li.append(el('span', '', `${t(s.label)}: ${when}`));
  if (s.status === 'accepted') li.append(el('span', 'muted small', t('Reminder set')));
  else if (s.status === 'pending') {
    const say = el('span', 'muted small', '');
    li.append(
      btn(t('Remind me {n} days before', { n: s.daysBefore }), 'ghost small', async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(`/facts/suggestions/${s.id}/accept`, { method: 'POST', body: {} });
          void refresh(docId);
        } catch (err) {
          say.textContent = err.message;
        }
      }),
      btn(t('Not needed'), 'ghost small', async () => {
        await api(`/facts/suggestions/${s.id}/dismiss`, { method: 'POST', body: {} }).catch(() => {});
        void refresh(docId);
      }),
      say,
    );
  }
  return li;
}
async function refresh(id) {
  drawResult(await api(`/library/scan/${id}`));
}

// ---------------------------------------------------------------- open / close

/** Opens Scan pages inside the Library window. */
export function openScan() {
  const lib = $('#library');
  if (lib && !lib.open) lib.showModal();
  for (const id of ['#lib-home', '#lib-doc', '#lib-research', '#lib-topics', '#lib-meetings', '#lib-study', '#lib-media']) {
    const n = $(id);
    if (n) n.hidden = true;
  }
  $('#lib-scan').hidden = false;
  $('#scan-result').hidden = true;
  drawPages();
}
function closeScan() {
  stopCamera();
  if (editing) closeEdit(false);
  polling++;
  const s = $('#lib-scan');
  if (s && !s.hidden) s.hidden = true;
}

export function initScan() {
  const sec = $('#lib-scan');
  if (!sec) return;
  const auto = $('#scan-auto');
  try {
    auto.checked = localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    /* private mode */
  }
  auto.addEventListener('change', () => {
    try {
      localStorage.setItem(AUTO_KEY, auto.checked ? 'on' : 'off');
    } catch {
      /* private mode */
    }
  });
  $('#lib-scan-open')?.addEventListener('click', openScan);
  $('#lib-sc-back').addEventListener('click', () => {
    closeScan();
    $('#lib-home').hidden = false;
  });
  $('#scan-camera').addEventListener('click', () => void startCamera());
  $('#scan-shot').addEventListener('click', () => void shoot());
  $('#scan-live-done').addEventListener('click', stopCamera);
  $('#scan-file').addEventListener('change', async () => {
    await addFiles($('#scan-file').files);
    $('#scan-file').value = '';
  });
  $('#scan-save').addEventListener('click', () => void save());
  $('#scan-edit-ok').addEventListener('click', () => closeEdit(true));
  $('#scan-edit-cancel').addEventListener('click', () => closeEdit(false));
  $('#scan-edit-whole').addEventListener('click', () => {
    if (!editing) return;
    editing.corners = frame(editing.p.src);
    drawEdit();
  });
  $('#scan-edit-auto').addEventListener('click', () => {
    if (!editing) return;
    editing.corners = detect(editing.p.src);
    drawEdit();
  });
  editPointer();
  // Leaving the view (another Library view, closing the window) turns the camera off.
  // (Only on the change to hidden: setting `hidden` again records a mutation too.)
  let shown = !sec.hidden;
  new MutationObserver(() => {
    if (shown && sec.hidden) closeScan();
    shown = !sec.hidden;
  }).observe(sec, { attributes: true, attributeFilter: ['hidden'] });
  $('#library')?.addEventListener('close', () => stopCamera());
}
