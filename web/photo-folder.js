// V4.1 Photo library search (docs/PHOTO_LIBRARY.md): the owner's photo folder on this computer.
// Settings → Skills & tools → Library → Photo folder picks the folder and shows how far the index
// is; Our moments gets a "Your photo folder" section: search by words (a place, a word in a photo,
// a person, a year), made-for-you albums (trips, people, photos with writing) and one photo's
// details (people you name, "name this place"). The page only ever sees photo ids, never paths.
import { serverText, t } from './naming.js';
import { openLightbox } from './lightbox.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const body = opts.body;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const st = { q: '', album: '', items: [], open: null, timer: null };
/** Photos shown before a search (the newest). */
const NEWEST = 12;
const photoSrc = (id) => `/api/moments/folder/photo/${id}`;
const dayOf = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const monthOf = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/** One line about the index: counts, which model looks, or why none does. */
export function statusLine(s) {
  if (!s.folder) return t('No folder picked yet. Type the full path of a photo folder on this computer.');
  const parts = [];
  if (s.scanning) parts.push(t('Looking through the folder…'));
  parts.push(t('{total} photos, {described} described, {waiting} waiting.', { total: s.total, described: s.described, waiting: s.waiting }));
  if (s.failed) parts.push(t('{n} could not be read.', { n: s.failed }));
  parts.push(
    s.reader
      ? t('Captions and the text in photos by {model} on this computer.', { model: s.reader.model })
      : t('No picture model on this computer, so photos are found by place, date, file name and people. Pick one under Which model does what → Looking at pictures.'),
  );
  return parts.join(' ');
}

// ---- Settings → Library → Photo folder

export async function loadPhotoFolder() {
  const box = $('#lib-photos-folder');
  if (!box) return;
  let s;
  try {
    s = await api('/moments/folder');
  } catch (err) {
    $('#lib-photos-status').textContent = err.message;
    return;
  }
  if (document.activeElement !== box) box.value = s.folder ?? '';
  $('#lib-photos-status').textContent = statusLine(s);
  $('#lib-photos-scan').disabled = !s.folder || s.scanning;
  $('#lib-photos-forget').disabled = !s.folder;
}

async function useFolder() {
  const status = $('#lib-photos-status');
  try {
    await api('/moments/folder', { method: 'PUT', body: { folder: $('#lib-photos-folder').value } });
    await scanNow();
  } catch (err) {
    status.textContent = err.message;
  }
}

async function scanNow() {
  const status = $('#lib-photos-status');
  status.textContent = t('Looking through the folder…');
  try {
    const r = await api('/moments/folder/scan', { body: {} });
    status.textContent = `${t('{added} new, {changed} changed, {removed} gone.', r)} ${statusLine(r.status)}`;
  } catch (err) {
    status.textContent = err.message;
  }
  void drawPhotoFolder();
}

async function forgetIndex() {
  if (!confirm(t('Forget the whole photo index? Your photos stay where they are; only what Sara wrote about them is deleted.'))) return;
  try {
    await api('/moments/folder', { method: 'DELETE' });
    $('#lib-photos-folder').value = '';
    await loadPhotoFolder();
  } catch (err) {
    $('#lib-photos-status').textContent = err.message;
  }
}

// ---- Our moments → Your photo folder

/** Draws the section in Our moments (called each time the album loads). */
export async function drawPhotoFolder() {
  const sec = $('#mo-photos');
  if (!sec) return;
  let s;
  try {
    s = await api('/moments/folder');
  } catch {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  const has = Boolean(s.folder);
  $('#mo-ph-find').hidden = !has;
  $('#mo-ph-pick').hidden = has;
  $('#mo-ph-state').textContent = has ? statusLine(s) : t('Search the photos on this computer by place, by the words in them or by who is in them. Nothing leaves this computer.');
  if (!has) {
    $('#mo-ph-albums').replaceChildren();
    $('#mo-ph-results').replaceChildren();
    $('#mo-ph-detail').hidden = true;
    return;
  }
  void drawAlbums();
  void search();
}

async function drawAlbums() {
  const box = $('#mo-ph-albums');
  let d;
  try {
    d = await api('/moments/folder/albums');
  } catch {
    return;
  }
  box.replaceChildren();
  for (const a of d.albums) {
    const b = el('button', `mo-ph-album${st.album === a.id ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(st.album === a.id));
    const img = el('img');
    img.src = photoSrc(a.cover);
    img.alt = '';
    img.loading = 'lazy';
    const name = a.kind === 'trip' ? `${a.place} · ${monthOf(a.month)}` : a.kind === 'writing' ? t('Photos with writing') : a.title;
    const label = el('span', 'mo-ph-album-name', name);
    const n = el('span', 'muted small', a.ids.length === 1 ? t('One photo') : t('{n} photos', { n: a.ids.length }));
    b.append(img, label, n);
    b.addEventListener('click', () => {
      st.album = st.album === a.id ? '' : a.id;
      $('#mo-ph-q').value = '';
      st.q = '';
      void drawAlbums();
      void search();
    });
    box.append(b);
  }
  box.hidden = !d.albums.length;
}

async function search() {
  const grid = $('#mo-ph-results');
  let d;
  try {
    d = await api(`/moments/folder/search?q=${encodeURIComponent(st.q)}${st.album ? `&album=${encodeURIComponent(st.album)}` : ''}`);
  } catch (err) {
    $('#mo-ph-state').textContent = err.message;
    return;
  }
  st.items = d.items;
  grid.replaceChildren();
  // Without a search or an album only the newest few, so the album below stays in reach.
  const browsing = !st.q && !st.album;
  const shown = d.items.slice(0, browsing ? NEWEST : 120);
  for (const p of shown) {
    const fig = el('figure', 'mo-item mo-ph-item');
    const img = el('img');
    img.src = photoSrc(p.id);
    img.alt = p.caption || p.name;
    img.loading = 'lazy';
    img.addEventListener('click', () => openDetail(p));
    const cap = el('figcaption', 'mo-caption small', p.caption || p.name);
    const meta = el('span', 'muted small', [p.place, dayOf(p.takenAt)].filter(Boolean).join(' · '));
    fig.append(img, cap, meta);
    grid.append(fig);
  }
  const note = $('#mo-ph-count');
  note.textContent = browsing
    ? d.items.length > NEWEST
      ? t('The newest {n}. Search or pick an album to see more.', { n: NEWEST })
      : ''
    : d.items.length === 1
      ? t('One photo found.')
      : d.items.length
        ? t('{n} photos found.', { n: d.items.length })
        : t('No photos match that. Try a place, a word in a photo, a person or a year.');
}

function openDetail(p) {
  st.open = p;
  const box = $('#mo-ph-detail');
  box.hidden = false;
  const img = $('#mo-ph-big');
  img.src = photoSrc(p.id);
  img.alt = p.caption || p.name;
  $('#mo-ph-caption').textContent = p.caption || (p.state === 'new' ? t('Not described yet.') : p.name);
  $('#mo-ph-meta').textContent = [p.place, p.country, dayOf(p.takenAt), p.camera, p.folder ? `${p.folder}/${p.name}` : p.name].filter(Boolean).join(' · ');
  $('#mo-ph-text').textContent = p.text ? `${t('Writing in the photo:')} ${p.text}` : '';
  $('#mo-ph-people').value = p.people.join(', ');
  $('#mo-ph-place-row').hidden = !p.hasGps;
  $('#mo-ph-place-name').value = '';
  $('#mo-ph-msg').textContent = '';
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function savePeople() {
  const p = st.open;
  if (!p) return;
  try {
    const got = await api(`/moments/folder/${p.id}/people`, { method: 'PUT', body: { people: $('#mo-ph-people').value.split(',') } });
    st.open = got;
    $('#mo-ph-msg').textContent = t('Saved.');
    void drawAlbums();
  } catch (err) {
    $('#mo-ph-msg').textContent = err.message;
  }
}

async function namePlace() {
  const p = st.open;
  const name = $('#mo-ph-place-name').value.trim();
  if (!p || !name) return;
  try {
    await api('/moments/folder/places', { body: { name, photo: p.id, radiusKm: 0.5 } });
    $('#mo-ph-msg').textContent = t('Photos taken near here are now called {name}.', { name });
    void search();
  } catch (err) {
    $('#mo-ph-msg').textContent = err.message;
  }
}

if (globalThis.document?.querySelector('#mo-photos')) {
  $('#lib-photos-save')?.addEventListener('click', () => void useFolder());
  $('#lib-photos-scan')?.addEventListener('click', () => void scanNow());
  $('#lib-photos-forget')?.addEventListener('click', () => void forgetIndex());
  $('#mo-ph-pick')?.addEventListener('click', () => {
    $('#moments')?.close();
    location.hash = '#view=settings:ab-library';
  });
  $('#mo-ph-q').addEventListener('input', () => {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.q = $('#mo-ph-q').value.trim();
      if (st.q) st.album = '';
      void drawAlbums();
      void search();
    }, 250);
  });
  // Enter in the search box searches; it must not submit (close) the dialog's form.
  $('#mo-ph-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  $('#mo-ph-people').addEventListener('change', () => void savePeople());
  $('#mo-ph-people').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void savePeople();
    }
  });
  $('#mo-ph-place-go').addEventListener('click', () => void namePlace());
  $('#mo-ph-big').addEventListener('click', () => {
    const list = st.items.slice(0, !st.q && !st.album ? NEWEST : 120).map((p) => ({ src: photoSrc(p.id), label: [p.place, dayOf(p.takenAt)].filter(Boolean).join(' · '), caption: p.caption || p.name }));
    const i = st.items.findIndex((p) => p.id === st.open?.id);
    openLightbox(list, Math.max(0, i));
  });
}
