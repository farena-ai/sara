// Phase 44: her library. A window listing the documents she keeps (add, search, open one to see
// what she learned and the text she read, remove), plus the upload used by the 📎 in chat.
// Phase 74: big files (up to ~1 GB) go up in 8 MB pieces that resume after a dropped connection;
// a long document shows its reading progress (Pause / Resume / Cancel), its contents with section
// summaries, and opens at a page (the links in her answers: /#view=library:<id>:<page>).
import { serverText, t } from './naming.js';
import { emptyState } from './tidy.js';
import { choices } from './kit.js';
import { openReadFeed, openReadTogether } from './read-together.js';
import { closeResearch, openResearch } from './research.js';

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
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

/** File types she reads (the server checks the file itself too). */
export const DOC_EXTS = ['pdf', 'docx', 'xlsx', 'pptx', 'epub', 'html', 'htm', 'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'log', 'rtf'];
export const isDocFile = (f) => !f.type.startsWith('image/') && (DOC_EXTS.includes((f.name.split('.').pop() ?? '').toLowerCase()) || /pdf|word|sheet|presentation|epub|text\/|csv|html/.test(f.type));

const KIND_ICON = { pdf: '📕', docx: '📘', xlsx: '📗', pptx: '📙', epub: '📖', html: '🌐', markdown: '📝', text: '📄', csv: '📊', image: '🖼️' };
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Uploads one document. keep = in her library; otherwise only for `conversationId` (read once).
 * Returns the stored document (or the copy already in her library).
 */
export async function uploadDoc(file, { keep = true, conversationId = null, learn = true, onProgress = () => {} } = {}) {
  // Big files: in pieces, so proxies with a request-size limit and dropped connections don't matter.
  if (file.size > CHUNKED_FROM) return uploadInPieces(file, { keep, conversationId, learn, onProgress });
  const q = new URLSearchParams({ name: file.name, keep: keep ? '1' : '0', learn: learn ? '1' : '0' });
  if (conversationId) q.set('conversation', conversationId);
  const res = await fetch(`/api/library?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data.doc;
}

/** Files bigger than this are sent in pieces (the server says how big a piece is). */
const CHUNKED_FROM = 8 * 1024 * 1024;

async function uploadInPieces(file, { keep, conversationId, learn, onProgress }) {
  const start = await api('/library/uploads', { method: 'POST', body: { name: file.name, size: file.size, keep, learn, ...(conversationId ? { conversation: conversationId } : {}) } });
  const piece = start.chunkBytes || CHUNKED_FROM;
  let sent = start.received || 0;
  let tries = 0;
  onProgress(sent, file.size);
  while (sent < file.size) {
    const end = Math.min(file.size, sent + piece);
    try {
      const res = await fetch(`/api/library/uploads/${start.id}?offset=${sent}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file.slice(sent, end) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        sent = data.received;
        tries = 0;
      } else if (res.status === 409 && typeof data.received === 'number') sent = data.received; // the server has a different amount: go on from there
      else throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
    } catch (err) {
      // A dropped connection: ask where the server got to and go on from there (a few tries).
      if (err.status && err.status !== 400) throw err;
      if (++tries > 6) throw err;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** tries)));
      const st = await api(`/library/uploads/${start.id}`).catch(() => null);
      if (st) sent = st.received;
    }
    onProgress(sent, file.size);
  }
  const done = await api(`/library/uploads/${start.id}/done`, { method: 'POST', body: {} });
  return done.doc;
}

const mb = (n) => (n / 1048576).toFixed(n >= 100 * 1048576 ? 0 : 1);

/** "about 6 minutes left" */
function timeLeft(sec) {
  if (!sec) return '';
  if (sec < 90) return t('about a minute left');
  if (sec < 90 * 60) return t('about {n} minutes left', { n: Math.round(sec / 60) });
  return t('about {n} hours left', { n: (sec / 3600).toFixed(1) });
}

/** "about 6 minutes" (for the estimate before reading scanned pages). */
function duration(sec) {
  if (sec < 90) return t('about a minute');
  if (sec < 90 * 60) return t('about {n} minutes', { n: Math.round(sec / 60) });
  return t('about {n} hours', { n: (sec / 3600).toFixed(1) });
}

/** What a long document's reading job is doing, in a few words ("Reading page 412 of 980 · about 6 minutes left"). */
export function jobText(job) {
  if (!job || job.phase === 'done') return '';
  if (job.phase === 'cancelled') return t('Reading was cancelled.');
  const left = timeLeft(job.etaSeconds);
  let what;
  if (job.needs === 'ocr-approval') what = t('Waiting for you: read the scanned pages with a cloud model?');
  else if (job.needs === 'local-ocr') what = t('Waiting for a picture model on this computer to read the scanned pages.');
  else if (job.phase === 'text') what = job.pages ? t('Reading page {n} of {total}', { n: Math.min(job.page + 1, job.pages), total: job.pages }) : t('Opening it…');
  else if (job.phase === 'ocr') what = t('Reading scanned pages: {n} of {total}', { n: job.ocrDone, total: job.ocrTotal });
  else if (job.phase === 'structure') what = t('Finding the chapters and sections…');
  else if (job.phase === 'summaries') what = t('Writing a summary of each section: {n} of {total}', { n: job.stepsDone, total: job.stepsTotal });
  else if (job.phase === 'learn') what = t('Learning the key points…');
  else what = t('Getting it ready for meaning search…');
  if (job.paused) return `${t('Paused')} · ${what}`;
  return left && !job.needs ? `${what} · ${left}` : what;
}

/** How far along it is (0 to 1), for the progress bar. */
function jobFraction(job) {
  if (!job) return 0;
  const parts = { text: 0, ocr: 0.6, structure: 0.75, summaries: 0.78, learn: 0.9, vectors: 0.97, done: 1, cancelled: 1 };
  const base = parts[job.phase] ?? 0;
  if (job.phase === 'text') return job.pages ? 0.6 * (job.page / job.pages) : 0;
  if (job.phase === 'ocr') return 0.6 + 0.15 * (job.ocrTotal ? job.ocrDone / job.ocrTotal : 1);
  if (job.phase === 'summaries' || job.phase === 'learn') return base + 0.1 * (job.stepsTotal ? Math.min(1, job.stepsDone / job.stepsTotal) : 0);
  return base;
}

const jobRunning = (job) => job && !['done', 'cancelled'].includes(job.phase);

/** Waits until documents are read (or a limit), calling back with progress text. */
export async function waitRead(ids, onState = () => {}, ms = 90_000) {
  const until = Date.now() + ms;
  let docs = [];
  while (Date.now() < until) {
    docs = (await Promise.all(ids.map((id) => api(`/library/${id}`).then((r) => r.doc).catch(() => null)))).filter(Boolean);
    const busy = docs.filter((d) => d.status === 'waiting' || d.status === 'reading');
    if (!busy.length) return docs;
    const job = busy.find((d) => d.job)?.job;
    onState(job ? `${busy.map((d) => d.name).join(', ')}: ${jobText(job)}` : `${t('Reading')} ${busy.map((d) => d.name).join(', ')}…`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  return docs;
}

function statusText(d, { withJob = true } = {}) {
  // The document page shows the job in its own panel (with the bar and buttons), so not twice.
  if (!withJob && jobRunning(d.job)) d = { ...d, job: null, learn: null, status: d.status === 'reading' || d.status === 'waiting' ? 'ready' : d.status };
  if (jobRunning(d.job) && (d.status === 'waiting' || d.status === 'reading' || d.job.paused || d.job.needs)) return jobText(d.job);
  if (d.status === 'waiting' || d.status === 'reading') return t('Reading it…');
  if (d.status === 'failed') return `${t("Couldn't read it")}: ${d.error ?? ''}`;
  const bits = [];
  if (d.passages) bits.push(`${d.passages} ${d.passages === 1 ? t('passage') : t('passages')}`);
  if (d.pages) bits.push(`${d.pages} ${t('pages')}`);
  if (d.pagesSeen) bits.push(`${d.pagesSeen} ${t('scanned pages read')}`);
  if (jobRunning(d.job)) bits.push(jobText(d.job));
  if (d.learn === 'waiting' || d.learn === 'learning') bits.push(t('learning the key points…'));
  else if (d.learn === 'done') bits.push(d.facts ? `${d.facts} ${d.facts === 1 ? t('note in her memory') : t('notes in her memory')}` : t('nothing to remember'));
  else if (d.learn === 'failed') bits.push(t("couldn't learn from it yet"));
  return bits.join(' · ');
}

let current = null;
let currentDoc = null;
let textFrom = 0;

async function loadList() {
  let r;
  try {
    r = await api('/library');
  } catch (err) {
    $('#lib-summary').textContent = err.status === 403 ? t('The library is not available in the demo.') : err.message;
    $('#lib-list').replaceChildren();
    return;
  }
  const c = r.counts;
  // Wave 3: plain words (what it does for you, then where to turn it on), no "meaning search" jargon up front.
  const meaning = r.meaning
    ? r.meaning.error
      ? ` ${t('Finding things by what they mean is not working right now ({error}).', { error: r.meaning.error.slice(0, 80) })}`
      : r.meaning.total
        ? ` ${t('She also finds things by what they mean, even in other words (ready: {ready} of {total} parts).', { ready: Math.min(r.meaning.indexed, r.meaning.total), total: r.meaning.total })}`
        : ` ${t('She also finds things by what they mean, even in other words.')}`
    : ` ${t('She finds things by the words in them. To also find them when you put it in other words, turn on Meaning search in Settings → Which model does what → More jobs.')}`;
  // UI cleanup (wave 2): an empty library shows the shared empty card instead of a line of text.
  $('#lib-summary').textContent = c.docs ? `${t('Documents: {n} ({size}).', { n: c.docs, size: sizeText(c.bytes) })}${meaning}` : '';
  $('#lib-shared-row').hidden = !(window.saraCompanionCount?.() > 1);
  $('#lib-shared').checked = Boolean(r.shared);
  $('#lib-list').replaceChildren(
    ...r.docs.map((d) => {
      const card = el('button', 'lib-card');
      card.type = 'button';
      card.append(el('span', 'lib-icon', KIND_ICON[d.kind] ?? '📄'));
      const body = el('span', 'lib-card-body');
      body.append(el('span', 'lib-name', d.title && d.title.length < 80 ? d.title : d.name));
      if (d.summary) body.append(el('span', 'lib-about muted small', d.summary));
      body.append(el('span', `lib-state small${d.status === 'failed' ? ' error' : ' muted'}`, `${statusText(d)} · ${sizeText(d.size)} · ${new Date(d.addedAt).toLocaleDateString()}`));
      card.append(body);
      card.addEventListener('click', () => void openDoc(d.id));
      return card;
    }),
  );
  if (!c.docs) $('#lib-list').replaceChildren(emptyState('library', t('Nothing here yet. Add a document to get started.')));
  // Still reading or learning: look again shortly.
  if (r.docs.some((d) => ['waiting', 'reading'].includes(d.status) || ['waiting', 'learning'].includes(d.learn) || (jobRunning(d.job) && !d.job.paused && !d.job.needs))) scheduleRefresh();
}

let refreshTimer = 0;
function scheduleRefresh() {
  // Phase 74: a long document sends an event for every page; a look already planned stays
  // planned (restarting the timer on each event would put it off until the reading ends).
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    if (!$('#library').open) return;
    if (current) void openDoc(current, { quiet: true });
    else void loadList();
  }, 2500);
}

function showJob(d) {
  const job = d.job;
  const on = jobRunning(job);
  $('#lib-doc-job').hidden = !on;
  if (!on) return;
  $('#lib-doc-job-text').textContent = jobText(job);
  $('#lib-doc-job-bar').value = jobFraction(job);
  $('#lib-doc-pause').hidden = job.paused;
  $('#lib-doc-resume').hidden = !job.paused && job.needs !== 'local-ocr';
  const ask = job.needs === 'ocr-approval' && job.estimate && !job.estimate.error;
  $('#lib-doc-ocr-ask').hidden = !ask;
  if (ask) {
    const e = job.estimate;
    const cost = e.usd === null ? t('the cost is not known for this model (see Settings → Data & health → Usage and costs)') : t('about ${usd}', { usd: e.usd.toFixed(2) });
    $('#lib-doc-ocr-text').textContent = t('{n} scanned pages need her picture model, {model} ({provider}). It runs in the cloud: {time}, {cost}.', { n: e.pages, model: e.model, provider: e.provider, time: duration(e.seconds), cost });
  }
}

/** The contents of a long document: chapters and sections, their pages and summaries. */
function showContents(d, sections) {
  $('#lib-doc-overview-box').hidden = !d.overview;
  $('#lib-doc-overview').textContent = d.overview ?? '';
  $('#lib-doc-contents-box').hidden = !sections?.length;
  $('#lib-doc-contents').replaceChildren(
    ...(sections ?? []).slice(0, 600).map((sec) => {
      const li = el('li', `lib-sec lib-sec-${Math.min(4, sec.level)}`);
      const head = el('div', 'lib-sec-head');
      head.append(el('span', 'lib-sec-title', sec.title));
      if (sec.page) {
        const go = el('button', 'ghost small lib-sec-page', sec.pageEnd > sec.page ? t('pages {a}–{b}', { a: sec.page, b: sec.pageEnd }) : t('page {n}', { n: sec.page }));
        go.type = 'button';
        go.addEventListener('click', () => void showPage(d, sec.page));
        head.append(go);
      }
      li.append(head);
      if (sec.summary) li.append(el('p', 'muted small lib-sec-summary', sec.summary));
      return li;
    }),
  );
}

/** Shows the text from a page on (and a link that opens the PDF itself there). */
async function showPage(d, page) {
  const r = await api(`/library/${d.id}/passages?page=${page}&limit=40`).catch(() => ({ passages: [] }));
  textFrom = Infinity; // "Show more" goes on from the start view only
  $('#lib-doc-text').replaceChildren();
  showText(r.passages);
  $('#lib-doc-more').hidden = true;
  $('#lib-doc-page-row').hidden = false;
  $('#lib-doc-page-note').textContent = t('From page {n}.', { n: page });
  $('#lib-doc-page-pdf').hidden = d.kind !== 'pdf';
  $('#lib-doc-page-pdf').href = `/api/library/${d.id}/file?inline=1#page=${page}`;
  $('#lib-doc-text-head').scrollIntoView({ block: 'start', behavior: 'smooth' });
  const first = [...$('#lib-doc-text').querySelectorAll('.lib-passage')].find((p) => p.dataset.place === `page ${page}`);
  first?.classList.add('lib-cited');
}

async function openDoc(id, { quiet = false, page = 0 } = {}) {
  let r;
  try {
    r = await api(`/library/${id}`);
  } catch (err) {
    $('#lib-upload-status').textContent = err.message;
    return showHome();
  }
  const d = r.doc;
  current = id;
  $('#lib-home').hidden = true;
  $('#lib-doc').hidden = false;
  $('#lib-doc-name').textContent = `${KIND_ICON[d.kind] ?? '📄'} ${d.name}`;
  $('#lib-doc-about').textContent = [d.title && d.title !== d.name ? d.title : '', d.summary ?? ''].filter(Boolean).join(' · ');
  $('#lib-doc-state').textContent = `${statusText(d, { withJob: false })}${d.keep ? '' : ` · ${t('shared in one chat only')}`}`;
  $('#lib-doc-state').classList.toggle('error', d.status === 'failed');
  $('#lib-doc-warnings').replaceChildren(...(d.warnings ?? []).map((w) => el('li', '', w)));
  $('#lib-doc-download').href = `/api/library/${d.id}/file`;
  $('#lib-doc-pdf').hidden = d.kind !== 'pdf' || d.status !== 'ready';
  $('#lib-doc-pdf').href = `/api/library/${d.id}/file?inline=1`;
  showJob(d);
  showContents(d, r.sections);
  $('#lib-doc-download').setAttribute('download', d.name);
  $('#lib-doc-keep').hidden = d.keep;
  // E5: Read together (text and Markdown documents she keeps).
  $('#lib-doc-together').hidden = !(d.keep && !d.readOnly && d.status === 'ready' && ['text', 'markdown'].includes(d.kind));
  currentDoc = d;
  $('#lib-doc-relearn').hidden = !d.keep || d.status !== 'ready' || d.readOnly;
  // Phase 110: a room archive is read-only (no re-read, no learning; Remove stays: his records, his choice).
  $('#lib-doc-reread').hidden = Boolean(d.readOnly);
  if (d.readOnly) $('#lib-doc-state').textContent = t('A read-only room archive: other people\'s words, kept as your record. She never learns from it by herself.');
  $('#lib-doc-facts').replaceChildren(
    ...(r.facts.length
      ? r.facts.map((f) => {
          const row = el('div', 'mem');
          row.append(el('div', '', f.content));
          if (f.evidence) row.append(el('div', 'muted small', `“${f.evidence}”`));
          const del = el('button', 'ghost small', t('Delete'));
          del.type = 'button';
          del.addEventListener('click', async () => {
            await api(`/memories/${f.id}`, { method: 'DELETE' });
            row.remove();
          });
          const bar = el('div', 'mem-actions');
          bar.append(del);
          row.append(bar);
          return row;
        })
      : [el('p', 'muted small', d.learn === 'waiting' || d.learn === 'learning' ? t('She is still reading it for the key points…') : d.keep ? t('No notes from this one.') : t('Documents shared in one chat only aren\'t learned. Keep it in her library to learn from it.'))]),
  );
  if (!quiet) {
    textFrom = 0;
    $('#lib-doc-page-row').hidden = true;
    $('#lib-doc-text').replaceChildren();
    showText(r.passages);
    if (page) await showPage(d, page);
  }
  if (['waiting', 'reading'].includes(d.status) || ['waiting', 'learning'].includes(d.learn) || (jobRunning(d.job) && !d.job.paused && !d.job.needs)) scheduleRefresh();
}

function showText(passages) {
  let last = $('#lib-doc-text').lastElementChild?.dataset.place ?? null;
  for (const p of passages) {
    if (p.place && p.place !== last) {
      const h = el('div', 'lib-place muted small', p.place);
      h.dataset.place = p.place;
      $('#lib-doc-text').append(h);
      last = p.place;
    }
    const para = el('p', 'lib-passage', p.text);
    para.dataset.place = p.place;
    $('#lib-doc-text').append(para);
  }
  textFrom += passages.length;
  $('#lib-doc-more').hidden = passages.length < 40 || !Number.isFinite(textFrom);
}

function showHome() {
  current = null;
  closeResearch();
  $('#lib-doc').hidden = true;
  $('#lib-home').hidden = false;
  void loadList();
  void loadArchives();
}

// ---------- Phase 110 (CH4): the room archives (rooms → weeks, search, read-only viewer)
let archiveRoom = null;
async function loadArchives() {
  const box = $('#lib-archives');
  let r;
  try {
    r = await api(`/library/archives${archiveRoom ? `?room=${archiveRoom}` : ''}`);
  } catch {
    box.hidden = true; // not the owner's space, or the demo
    return;
  }
  box.hidden = !r.rooms.length && !archiveRoom;
  $('#la-summary').textContent = r.counts.docs ? t('Archived weeks: {n} ({size}). Read-only; kept until you delete them.', { n: r.counts.docs, size: sizeText(r.counts.bytes) }) : t('No archived weeks yet.');
  $('#la-list').replaceChildren(
    ...r.rooms.map((room) => {
      const sec = el('div', 'la-room');
      sec.append(el('h4', '', room.collection.replace(/^Archive: /, '')));
      for (const d of room.weeks) {
        const card = el('button', 'lib-card la-week');
        card.type = 'button';
        card.append(el('span', 'lib-icon', '🗂'));
        const body = el('span', 'lib-card-body');
        body.append(el('span', 'lib-name', d.name.replace(/^Archive: .* — /, '')), el('span', 'lib-state small muted', `${t('Passages: {n}', { n: d.passages })} · ${sizeText(d.size)}`));
        card.append(body);
        card.addEventListener('click', () => void openDoc(d.id));
        sec.append(card);
      }
      return sec;
    }),
  );
}
let archiveTimer;
$('#la-q').addEventListener('input', () => {
  clearTimeout(archiveTimer);
  archiveTimer = setTimeout(async () => {
    const q = $('#la-q').value.trim();
    const box = $('#la-hits');
    if (!q) return void (box.hidden = true);
    try {
      const r = await api(`/library/archives?q=${encodeURIComponent(q)}${archiveRoom ? `&room=${archiveRoom}` : ''}`);
      box.hidden = false;
      box.replaceChildren(
        ...(r.hits.length
          ? r.hits.map((h) => {
              const b = el('button', 'lib-hit');
              b.type = 'button';
              b.append(el('span', 'lib-name small', `${(h.collection ?? '').replace(/^Archive: /, '')} · ${h.place}`), el('span', 'small', h.text.slice(0, 300)));
              b.addEventListener('click', () => void openDoc(h.docId));
              return b;
            })
          : [el('p', 'muted small', t('Nothing found in the room archives.'))]),
      );
    } catch (err) {
      box.hidden = false;
      box.replaceChildren(el('p', 'muted small', err.message));
    }
  }, 300);
});

/** Opens the Library at the room archives (of one room when given). */
export async function openArchives(roomId = null) {
  archiveRoom = roomId;
  await openLibrary();
  await loadArchives();
  $('#lib-archives').scrollIntoView({ block: 'start' });
}

async function addFiles(files) {
  const docs = [...files];
  if (!docs.length) return;
  const status = $('#lib-upload-status');
  status.classList.remove('error');
  const bar = $('#lib-upload-bar');
  for (const f of docs) {
    status.textContent = `${t('Adding')} ${f.name}…`;
    try {
      const d = await uploadDoc(f, {
        keep: true,
        learn: $('#lib-learn').checked,
        onProgress: (sent, total) => {
          bar.hidden = false;
          bar.value = total ? sent / total : 0;
          status.textContent = t('Uploading {name}: {sent} of {total} MB', { name: f.name, sent: mb(sent), total: mb(total) });
        },
      });
      bar.hidden = true;
      status.textContent = d ? `${t('Added')} ${d.name}. ${t('She is reading it now.')}` : '';
      // L7: the line goes once she has read it (the list shows the result).
      if (d?.id)
        void waitRead([d.id], () => {}, 5 * 60_000).then(() => {
          if (status.textContent.startsWith(`${t('Added')} ${d.name}.`)) status.textContent = '';
          void loadList();
        });
    } catch (err) {
      bar.hidden = true;
      status.textContent = `${f.name}: ${err.message}`;
      status.classList.add('error');
    }
    await loadList();
  }
}

export async function openLibrary(docId, page = 0) {
  if (!docId) archiveRoom = archiveRoom ?? null;
  $('#lib-upload-status').textContent = '';
  $('#lib-q').value = '';
  $('#lib-hits').hidden = true;
  if (!$('#library').open) $('#library').showModal();
  if (docId) await openDoc(docId, { page });
  else showHome();
}

// ---------- Phase 74: the Library settings page (Settings → Add-ons → Library)
const SPEED_WORDS = { 1: 'Gentle (chat always first)', 2: 'Normal', 3: 'Fast' };
let speedSeg = null;
function speedLabel() {
  $('#lib-speed-n').textContent = t(SPEED_WORDS[$('#lib-speed').value] ?? 'Normal');
}
export async function loadLibrarySettings() {
  const r = await api('/library/settings').catch(() => null);
  if (!r) return;
  $('#lib-max-mb').value = String(r.maxMb);
  $('#lib-member-max-mb').value = String(r.memberMaxMb);
  $('#lib-ocr').value = r.ocr;
  $('#lib-speed').value = String(r.speed);
  speedLabel();
  // Phase 114 (PL1c, S6): three segments with a one-line meaning instead of a 3-step slider.
  speedSeg ??= choices($('#lib-speed'), [
    { value: 1, label: t('Gentle'), meaning: t('Reads only while you are not chatting; big books take longer.') },
    { value: 2, label: t('Normal'), meaning: t('Reads in the background and pauses while she answers you.') },
    { value: 3, label: t('Fast'), meaning: t('Reads as fast as the model allows; chats may wait a little.') },
  ], { label: t('Background reading') });
  speedSeg.sync();
  $('#lib-settings-status').textContent = '';
}
export async function saveLibrarySettings() {
  await api('/library/settings', { method: 'PUT', body: { maxMb: Number($('#lib-max-mb').value), memberMaxMb: Number($('#lib-member-max-mb').value), ocr: $('#lib-ocr').value, speed: Number($('#lib-speed').value) } });
  $('#lib-settings-status').textContent = t('Saved.');
}
$('#lib-speed').addEventListener('input', speedLabel);

$('#open-library').addEventListener('click', () => void openLibrary());
$('#lib-back').addEventListener('click', showHome);
// EC6: Research a question (web/research.js), inside the Library window.
$('#lib-research-open').addEventListener('click', () => void openResearch());
$('#lib-r-back').addEventListener('click', showHome);
$('#lib-file').addEventListener('change', async () => {
  await addFiles($('#lib-file').files);
  $('#lib-file').value = '';
});
for (const ev of ['dragover', 'drop']) {
  $('#lib-drop').addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (ev === 'drop') void addFiles(e.dataTransfer.files);
  });
}
$('#lib-doc-more').addEventListener('click', async () => {
  const r = await api(`/library/${current}/passages?from=${textFrom}&limit=40`);
  showText(r.passages);
});
$('#lib-doc-together').addEventListener('click', async () => {
  if (!currentDoc) return;
  $('#library').close();
  let note = '';
  try {
    if (!(await openReadTogether(currentDoc))) note = t('Open a chat with her first.');
  } catch (err) {
    note = err.message;
  }
  if (!note) return;
  $('#library').showModal();
  $('#lib-doc-state').textContent = note;
});
// E6: a public feed instead of a document (the Feed tab of Read together).
$('#lib-feed-together').addEventListener('click', async () => {
  $('#library').close();
  let note = '';
  try {
    if (!(await openReadFeed())) note = t('Open a chat with her first.');
  } catch (err) {
    note = err.message;
  }
  if (!note) return;
  $('#library').showModal();
  $('#lib-upload-status').textContent = note;
});
$('#lib-doc-keep').addEventListener('click', async () => {
  await api(`/library/${current}`, { method: 'PATCH', body: { keep: true } });
  await openDoc(current);
});
$('#lib-doc-reread').addEventListener('click', async () => {
  await api(`/library/${current}/reread`, { method: 'POST', body: {} });
  await openDoc(current);
});
const jobAction = (what, body = {}) => async () => {
  try {
    await api(`/library/${current}/${what}`, { method: 'POST', body });
  } catch (err) {
    $('#lib-doc-job-text').textContent = err.message;
  }
  await openDoc(current, { quiet: true });
};
$('#lib-doc-pause').addEventListener('click', jobAction('pause'));
$('#lib-doc-resume').addEventListener('click', jobAction('resume'));
$('#lib-doc-cancel').addEventListener('click', jobAction('cancel'));
$('#lib-doc-ocr-yes').addEventListener('click', jobAction('ocr', { approve: true }));
$('#lib-doc-ocr-no').addEventListener('click', jobAction('ocr', { approve: false }));
$('#lib-doc-relearn').addEventListener('click', async () => {
  await api(`/library/${current}/learn`, { method: 'POST', body: {} });
  await openDoc(current);
});
$('#lib-doc-delete').addEventListener('click', () => {
  // Ask once, with plain choices, right under the button.
  if ($('#lib-remove-bar')) return;
  const bar = el('div', 'unsaved-bar lib-remove-bar');
  bar.id = 'lib-remove-bar';
  bar.append(el('span', '', t('Remove this document?')));
  const choice = (label, cls, forget) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      bar.remove();
      if (forget === null) return;
      await api(`/library/${current}${forget ? '?forget=1' : ''}`, { method: 'DELETE' });
      showHome();
    });
    bar.append(b);
  };
  choice(t('Remove and forget what she learned'), 'danger', true);
  choice(t('Remove, keep what she learned'), 'ghost', false);
  choice(t('Cancel'), 'ghost', null);
  $('#lib-doc-delete').closest('.actions-left').after(bar);
});
$('#lib-shared').addEventListener('change', async () => {
  const r = await api('/library/settings', { method: 'PUT', body: { shared: $('#lib-shared').checked } });
  $('#lib-upload-status').textContent = r.restart ? t('Saved. It takes effect after Sara restarts (Settings → Updates → Restart).') : t('Saved.');
});
let searchTimer = 0;
$('#lib-q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('#lib-q').value.trim();
    const box = $('#lib-hits');
    if (!q) return void (box.hidden = true);
    const r = await api(`/library/search?q=${encodeURIComponent(q)}`).catch(() => ({ hits: [] }));
    box.hidden = false;
    box.replaceChildren(
      ...(r.hits.length
        ? r.hits.map((h) => {
            const b = el('button', 'lib-hit');
            b.type = 'button';
            b.append(el('span', 'lib-hit-src small', `${h.name}${h.place ? `, ${h.place}` : ''}`), el('span', 'lib-hit-text', h.text.length > 320 ? `${h.text.slice(0, 320)}…` : h.text));
            b.addEventListener('click', () => void openDoc(h.docId, { page: h.page ?? 0 }));
            return b;
          })
        : [el('p', 'muted small', t('Nothing found.'))]),
    );
  }, 300);
});
// Live updates while the window is open (another device added one, reading finished).
window.addEventListener('sara:library', () => {
  if ($('#library').open) scheduleRefresh();
});
