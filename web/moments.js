// Phase 70: "Our moments", the photo album with her captions. A grid grouped by month (and
// "On this day" when there's a moment from a year or a month ago), the automatic albums (Us,
// Places, Her looks) and the owner's own, opened in the large picture view with swipe. One window
// per moment: edit her caption (saves when you leave the box), let her write a new one, albums,
// cover, remove from moments or delete the photo everywhere (asks first).
import { serverText, t } from './naming.js';
import { openLightbox } from './lightbox.js';
import { autoSave, onSave } from './dialogs.js';
import { emptyState } from './tidy.js';

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

const AUTO_NAMES = { us: () => t('Us'), places: () => t('Places'), looks: () => t('Her looks') };
const st = { album: '', data: null, poll: null, editing: null, openAt: null };
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const albumName = (a) => (a.auto ? (AUTO_NAMES[a.id]?.() ?? a.name) : a.name);
const src = (m) => (m.image ? `/api/uploads/${m.image}` : null);

/** What the large picture view shows for an item (the date on top, her caption below). */
const lightItem = (m) => ({ src: src(m), label: fmtDay(m.takenAt), caption: m.caption || '' });

function openLarge(list, m) {
  const photos = list.filter((x) => x.image);
  const i = photos.findIndex((x) => x.id === m.id);
  openLightbox(photos.map(lightItem), Math.max(0, i));
}

function captionText(m) {
  if (m.caption) return m.caption;
  if (m.captionState === 'pending') return t('She is writing a caption…');
  if (m.captionState === 'blocked') return t('No caption (the safety check held it back).');
  return m.kind === 'moment' ? m.text : t('No caption yet');
}

function tile(m, list) {
  const fig = el('figure', `mo-item${m.kind === 'moment' ? ' mo-note' : ''}${m.captionState === 'pending' ? ' pending' : ''}`);
  if (m.image) {
    const img = document.createElement('img');
    img.src = src(m);
    img.alt = m.caption || t('Photo from {date}', { date: fmtDay(m.takenAt) });
    img.loading = 'lazy';
    img.className = 'zoomable';
    img.title = t('See it large');
    img.addEventListener('click', () => openLarge(list, m));
    fig.append(img);
  } else fig.append(el('blockquote', 'mo-quote', m.text.length > 280 ? `${m.text.slice(0, 280)}…` : m.text));
  const cap = el('figcaption', 'mo-cap');
  cap.append(el('span', 'mo-caption', captionText(m)));
  const meta = el('span', 'mo-meta muted small');
  meta.append(document.createTextNode(`${fmtDay(m.takenAt)} · ${m.from === 'sara' ? t('from her') : t('from you')}`));
  if (m.pinned) meta.append(el('span', 'mo-badge', '♥'));
  if (m.private) meta.append(el('span', 'mo-badge', '🔒'));
  if (m.place) meta.append(el('span', 'mo-badge', `📍 ${m.place}`));
  cap.append(meta);
  const more = el('button', 'ghost small mo-more-btn', '⋯');
  more.type = 'button';
  more.title = t('Caption, albums and more');
  more.setAttribute('aria-label', t('Caption, albums and more'));
  more.addEventListener('click', () => openEdit(m));
  fig.append(cap, more);
  return fig;
}

/** Month headings with a grid under each (newest first). */
function grouped(items) {
  const out = [];
  let month = '';
  let grid = null;
  for (const m of items) {
    const mo = new Date(m.takenAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (mo !== month) {
      out.push(el('h3', 'mo-month', mo));
      grid = el('div', 'mo-grid');
      out.push(grid);
      month = mo;
    }
    grid.append(tile(m, items));
  }
  return out;
}

function albumCard(a) {
  const b = el('button', `mo-album${st.album === a.id ? ' active' : ''}`);
  b.type = 'button';
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-selected', String(st.album === a.id));
  const cover = el('span', 'mo-cover');
  if (a.cover) {
    const img = document.createElement('img');
    img.src = `/api/uploads/${a.cover}`;
    img.alt = '';
    img.loading = 'lazy';
    cover.append(img);
  } else cover.append(el('span', 'mo-cover-empty', { us: '♥', places: '📍', looks: '👗' }[a.id] ?? '🖼'));
  b.append(cover, el('span', 'mo-album-name', albumName(a)), el('span', 'mo-album-count muted small', String(a.count)));
  b.addEventListener('click', () => {
    st.album = a.id;
    void loadMoments();
  });
  return b;
}

function costLine(d) {
  const c = d.captioner;
  if (!c) return t('Captions wait until a model is set up (Settings → Models).');
  if (c.billing === 'local') return t('Captions by {model} on your own hardware (free).', { model: c.model });
  if (c.billing === 'subscription') return t('Captions by {model} through your {provider} plan (counts toward its limits).', { model: c.model, provider: c.provider });
  return c.usdPer100 === null
    ? t('Captions by {model} ({provider}): a paid model; the cost per caption isn’t known (add its price in Settings → Models → Usage).', { model: c.model, provider: c.provider })
    : t('Captions by {model} ({provider}): a paid model, about ${usd} per 100 captions.', { model: c.model, provider: c.provider, usd: c.usdPer100.toFixed(2) });
}

export async function loadMoments() {
  let d;
  try {
    d = await api(`/moments${st.album ? `?album=${encodeURIComponent(st.album)}` : ''}`);
  } catch (err) {
    $('#mo-status').textContent = err.message;
    return;
  }
  st.data = d;
  if (document.activeElement !== $('#mo-mode')) $('#mo-mode').value = d.settings.mode;
  $('#mo-cost').textContent = costLine(d);
  const status = [];
  if (d.pending) status.push(t('She is writing {n} captions…', { n: d.pending }));
  if (d.hiddenAdult) status.push(d.phoneApp ? t('{n} adults-only moments are left out in the phone app.', { n: d.hiddenAdult }) : t('{n} adults-only moments are hidden while Adult mode is off.', { n: d.hiddenAdult }));
  $('#mo-status').textContent = status.join(' ');
  $('#mo-more').hidden = !d.waiting;
  $('#mo-more').textContent = t('Write the missing captions ({n})', { n: d.waiting });
  const all = { id: '', name: t('All'), auto: false, count: '', cover: d.items.find((m) => m.image)?.image ?? null };
  $('#mo-albums').replaceChildren(...[all, ...d.albums].map(albumCard));
  const cur = d.albums.find((a) => a.id === st.album);
  $('#mo-album-head').hidden = !cur || cur.auto;
  if (cur && !cur.auto) $('#mo-album-name').textContent = cur.name;
  // On this day: only on the "All" page.
  const byId = new Map(d.items.map((m) => [m.id, m]));
  const otd = !st.album && d.onThisDay ? d.onThisDay.ids.map((id) => byId.get(id)).filter(Boolean) : [];
  $('#mo-otd').hidden = !otd.length;
  if (otd.length) {
    $('#mo-otd-title').textContent = d.onThisDay.kind === 'year' ? (d.onThisDay.years > 1 ? t('On this day, {n} years ago', { n: d.onThisDay.years }) : t('On this day, a year ago')) : t('On this day, a month ago');
    $('#mo-otd .mo-grid').replaceChildren(...otd.map((m) => tile(m, otd)));
  }
  const items = d.items;
  let body;
  if (st.album === 'looks' || st.album === 'places') {
    // Her looks: by outfit; Places: by place.
    const key = (m) => (st.album === 'looks' ? m.outfit || t('Earlier pictures') : m.place);
    const groups = new Map();
    for (const m of items) groups.set(key(m), [...(groups.get(key(m)) ?? []), m]);
    body = [...groups].flatMap(([k, list]) => {
      const g = el('div', 'mo-grid');
      g.append(...list.map((m) => tile(m, list)));
      return [el('h3', 'mo-month', k), g];
    });
  } else body = grouped(items);
  const empty = st.album
    ? cur && !cur.auto
      ? t('This album is empty. Open a photo (⋯) to add it here.')
      : t('Nothing here yet.')
    : d.settings.mode === 'off'
      ? t('Adding photos is off. Use “Add to our moments” under a photo in a conversation, or switch it on above.')
      : t('Photos you two share show up here by themselves, each with a caption from her. Keep a moment with ♡ under a message.');
  $('#mo-list').replaceChildren(...(body.length ? body : [emptyState('photo', empty)]));
  // While captions are being written, look again now and then.
  if (d.pending && !st.poll) st.poll = setInterval(() => (!$('#moments').open ? stopPoll() : void loadMoments()), 5000);
  if (!d.pending) stopPoll();
  if (st.editing) {
    const m = d.items.find((x) => x.id === st.editing.id);
    if (m && $('#moment-edit').open) fillEdit(m, false);
  }
}
function stopPoll() {
  clearInterval(st.poll);
  st.poll = null;
}

export async function openMoments(album = '') {
  st.album = album;
  await loadMoments();
  if (!$('#moments').open) $('#moments').showModal();
}

// ---- one moment ----
function fillEdit(m, all = true) {
  st.editing = m;
  $('#me-title').textContent = m.kind === 'moment' ? t('A kept moment') : m.from === 'sara' ? t('A photo from her') : t('A photo from you');
  $('#me-img').hidden = !m.image;
  if (m.image) $('#me-img').src = src(m);
  $('#me-when').textContent = [fmtDay(m.takenAt), m.conversation ? t('in “{title}”', { title: m.conversation }) : '', m.place ? `📍 ${m.place}` : ''].filter(Boolean).join(' · ');
  if (all || document.activeElement !== $('#me-caption')) $('#me-caption').value = m.caption;
  $('#me-state').textContent = m.captionState === 'pending' ? t('She is writing it…') : m.captionState === 'edited' ? t('Your words') : m.captionState === 'blocked' ? t('Held back by the safety check') : m.captionState === 'failed' ? t('She couldn’t write one (the model didn’t answer).') : '';
  $('#me-said').textContent = m.text && m.kind === 'photo' ? t('Said with it: “{text}”', { text: m.text.slice(0, 200) }) : '';
  $('#me-delete').hidden = !m.image;
  $('#me-open').hidden = !m.conversationId;
  const own = (st.data?.albums ?? []).filter((a) => !a.auto);
  $('#me-albums-wrap').hidden = !own.length;
  $('#me-albums').replaceChildren(
    ...own.map((a) => {
      const l = el('label', 'row');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = (m.albums ?? []).includes(a.id);
      c.dataset.album = a.id;
      c.dataset.nodirty = '';
      c.addEventListener('change', async () => {
        try {
          if (c.checked) await api(`/moments/albums/${a.id}/items`, { method: 'POST', body: { ids: [m.id] } });
          else await api(`/moments/albums/${a.id}/items/${m.id}`, { method: 'DELETE' });
          m.albums = c.checked ? [...(m.albums ?? []), a.id] : (m.albums ?? []).filter((x) => x !== a.id);
          await loadMoments();
        } catch (err) {
          $('#me-state').textContent = err.message;
        }
      });
      l.append(c, document.createTextNode(` ${a.name}`));
      return l;
    }),
  );
  const albums = (st.data?.albums ?? []).filter((a) => a.count && m.image);
  $('#me-cover').closest('label').hidden = !m.image;
  $('#me-cover').replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: t('Not a cover') }),
    ...albums.map((a) => Object.assign(document.createElement('option'), { value: a.id, textContent: albumName(a) })),
  );
  $('#me-cover').value = albums.find((a) => a.coverId === m.id)?.id ?? '';
}

function openEdit(m) {
  fillEdit(m);
  if (!$('#moment-edit').open) $('#moment-edit').showModal();
}

async function saveCaption() {
  const m = st.editing;
  if (!m || $('#me-caption').value.trim() === m.caption) return true;
  const r = await api(`/moments/${m.id}`, { method: 'PATCH', body: { caption: $('#me-caption').value } });
  st.editing = { ...m, ...r };
  void loadMoments();
  return true;
}

export function initMoments({ openAtMessage }) {
  st.openAt = openAtMessage;
  $('#open-moments').addEventListener('click', () => void openMoments());
  $('#sb-to-moments')?.addEventListener('click', () => {
    $('#scrapbook').close();
    void openMoments();
  });
  onSave($('#moments'), async () => {
    await api('/moments/settings', { method: 'PUT', body: { mode: $('#mo-mode').value } });
    void loadMoments();
    return true;
  });
  autoSave($('#moments'));
  onSave($('#moment-edit'), saveCaption);
  autoSave($('#moment-edit'));
  $('#mo-new').addEventListener('click', async () => {
    const name = $('#mo-new-name').value.trim();
    if (!name) return $('#mo-new-name').focus();
    try {
      const a = await api('/moments/albums', { method: 'POST', body: { name } });
      $('#mo-new-name').value = '';
      st.album = a.id;
      await loadMoments();
    } catch (err) {
      $('#mo-status').textContent = err.message;
    }
  });
  $('#mo-album-rename').addEventListener('click', async () => {
    const cur = st.data?.albums.find((a) => a.id === st.album);
    const name = cur && prompt(t('New name for the album:'), cur.name);
    if (!name?.trim()) return;
    await api(`/moments/albums/${cur.id}`, { method: 'PATCH', body: { name } }).catch((err) => ($('#mo-status').textContent = err.message));
    await loadMoments();
  });
  $('#mo-album-delete').addEventListener('click', async () => {
    const cur = st.data?.albums.find((a) => a.id === st.album);
    if (!cur || !confirm(t('Delete the album “{name}”? Its photos stay in your moments.', { name: cur.name }))) return;
    await api(`/moments/albums/${cur.id}`, { method: 'DELETE' }).catch((err) => ($('#mo-status').textContent = err.message));
    st.album = '';
    await loadMoments();
  });
  $('#mo-more').addEventListener('click', async () => {
    await api('/moments/captions', { method: 'POST', body: {} }).catch((err) => ($('#mo-status').textContent = err.message));
    await loadMoments();
  });
  $('#me-regen').addEventListener('click', async () => {
    const m = st.editing;
    if (!m) return;
    try {
      fillEdit(await api(`/moments/${m.id}/caption`, { method: 'POST', body: {} }));
    } catch (err) {
      $('#me-state').textContent = err.message;
    }
    await loadMoments();
  });
  $('#me-cover').addEventListener('change', async (e) => {
    e.stopPropagation();
    const m = st.editing;
    const to = $('#me-cover').value;
    const was = (st.data?.albums ?? []).find((a) => a.coverId === m.id);
    try {
      if (to) await api(`/moments/albums/${to}`, { method: 'PATCH', body: { cover: m.id } });
      else if (was) await api(`/moments/albums/${was.id}`, { method: 'PATCH', body: { cover: null } });
    } catch (err) {
      $('#me-state').textContent = err.message;
    }
    await loadMoments();
  });
  $('#me-open').addEventListener('click', () => {
    const m = st.editing;
    if (m?.conversationId) void st.openAt(m.conversationId, m.messageId);
  });
  $('#me-remove').addEventListener('click', async () => {
    const m = st.editing;
    if (!m) return;
    await api(`/moments/${m.id}`, { method: 'DELETE' }).catch((err) => ($('#me-state').textContent = err.message));
    $('#moment-edit').close();
    await loadMoments();
  });
  $('#me-delete').addEventListener('click', async () => {
    const m = st.editing;
    if (!m?.image) return;
    if (!confirm(t('Delete this photo everywhere? It is taken out of your conversations (their words stay) and from her album, and the file is deleted. This can’t be undone.'))) return;
    await api(`/moments/${m.id}/delete-everywhere`, { method: 'POST', body: { confirm: true } }).catch((err) => ($('#me-state').textContent = err.message));
    $('#moment-edit').close();
    await loadMoments();
  });
  $('#moment-edit').addEventListener('close', () => (st.editing = null));
}

/** The Today page's "On this day" card. */
export function renderTodayMoments(d) {
  const otd = d.onThisDay;
  $('#td-otd').hidden = !otd?.items?.length;
  if (!otd?.items?.length) return;
  renderTodayPhotos(otd.items.slice(0, 3), otd.kind === 'year' ? (otd.years > 1 ? t('On this day, {n} years ago', { n: otd.years }) : t('On this day, a year ago')) : t('On this day, a month ago'));
}

/** Phase 75 (stage 3): the Today tile's photos (On this day, or the newest ones), each opening the lightbox. */
export function renderTodayPhotos(items, title) {
  $('#td-otd').hidden = !items.length;
  $('#td-otd-title').textContent = title;
  const photos = items.filter((m) => m.image);
  $('#td-otd .today-otd').replaceChildren(
    ...items.map((m) => {
      const fig = el('figure', 'td-otd-item');
      if (m.image) {
        const img = document.createElement('img');
        img.src = src(m);
        img.alt = m.caption || '';
        img.className = 'zoomable';
        const open = () => openLightbox(photos.map(lightItem), Math.max(0, photos.indexOf(m)));
        img.addEventListener('click', open);
        // Keyboard: the photo is focusable and opens with Enter or Space.
        img.tabIndex = 0;
        img.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          open();
        });
        fig.append(img);
      }
      const cap = el('figcaption', 'small', m.caption || m.text || '');
      cap.dataset.raw = '';
      fig.append(cap);
      return fig;
    }),
  );
}

/** Under a photo in a conversation: add it to the album by hand (any of your own conversations). */
export function addToMomentsButton(messageId) {
  const b = el('button', 'ghost small mo-add', '🖼');
  b.type = 'button';
  b.title = t('Add to our moments');
  b.setAttribute('aria-label', t('Add to our moments'));
  b.addEventListener('click', async () => {
    try {
      await api('/moments', { method: 'POST', body: { messageId } });
      b.textContent = t('🖼 In our moments');
      b.disabled = true;
    } catch (err) {
      b.title = err.message;
    }
  });
  return b;
}
