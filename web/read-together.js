// E5: read together (docs/LIBRARY.md → Read together). A text or Markdown document from her library
// opens above the chat; select some text and press Share this passage, or switch on Follow my place.
// Only positions and hashes go to the server; it reads the text from the library itself and says
// when the passage changed. Stop ends sharing at once.
// E6: the Feed tab opens one public RSS/Atom feed (fetched by the server only on Open or Reload) and
// shares one item by its key and hash. Items are drawn as text only: no images, no page HTML.
import { t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
const MAX_PASSAGES = 3;
const MAX_CHARS = 4000;
let deps = null;
/** The open view: { conv, doc (or null), passages: Map(ord → passage), sent: ord of the last follow update, feed (E6, or null), shared: { key, textSha } of the shared feed item } */
let open = null;
let followTimer = 0;
let lastFollowAt = 0;

// SHA-256 (hex) of UTF-8 text, written out because crypto.subtle only exists on https or localhost.
const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256Hex(text) {
  const data = new TextEncoder().encode(text.normalize('NFC'));
  const len = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(len);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(len - 8, Math.floor((data.length * 8) / 2 ** 32));
  view.setUint32(len - 4, (data.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** The text between two positions, exactly as the server builds it (start in the first passage, end in the last). */
export function excerptOf(texts, start, end) {
  if (texts.length === 1) return texts[0].slice(start, end);
  return [texts[0].slice(start), ...texts.slice(1, -1), texts.at(-1).slice(0, end)].join('\n\n');
}

function note(text, { error = false } = {}) {
  $('#rt-note').textContent = text;
  $('#rt-note').classList.toggle('error', error);
}

function where(p) {
  return p.place || p.heading || t('passage {n}', { n: p.ord + 1 });
}

function showBar(place) {
  if (!open?.doc) return void ($('#rt-now').textContent = t('Read together'));
  $('#rt-now').textContent = place ? t('Reading together: {doc} · {place}', { doc: open.doc.name, place }) : t('Reading together: {doc}', { doc: open.doc.name });
}

async function send(body, label) {
  try {
    const r = await deps.api(`/read-together/${encodeURIComponent(open.conv)}`, { method: 'PUT', body });
    showBar(label);
    $('#rt-private').hidden = !r.privateLocal;
    if (open.shared) {
      open.shared = null; // one share per chat: the passage replaced the feed item
      drawFeed();
    }
    return true;
  } catch (err) {
    const reason = err.data?.reason;
    if (reason === 'passage' || reason === 'revision') note(t('This passage changed. Share it again.'), { error: true });
    else note(err.message, { error: true });
    return false;
  }
}

/** Where the selection starts and ends, as (passage ord, offset in its text). */
function selectionPoints() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const box = $('#rt-text');
  const at = (node, offset) => {
    const p = (node.nodeType === 1 ? node : node.parentElement)?.closest('.rt-passage');
    if (!p || !box.contains(p)) return null;
    const r = document.createRange();
    r.setStart(p, 0);
    r.setEnd(node, offset);
    return { ord: Number(p.dataset.ord), offset: r.toString().length };
  };
  const a = at(range.startContainer, range.startOffset);
  const b = at(range.endContainer, range.endOffset);
  return a && b ? { from: a, to: b } : null;
}

function onSelection() {
  if (!open) return;
  $('#rt-share').hidden = !selectionPoints();
}

async function shareSelection() {
  const s = selectionPoints();
  if (!s) return;
  const count = s.to.ord - s.from.ord + 1;
  const texts = Array.from({ length: count }, (_, i) => open.passages.get(s.from.ord + i)?.text ?? '');
  const text = excerptOf(texts, s.from.offset, s.to.offset);
  if (count > MAX_PASSAGES || text.length > MAX_CHARS) return note(t('Pick a shorter passage (up to about a page).'), { error: true });
  const ok = await send({ docId: open.doc.id, sha: open.doc.revision, ordFrom: s.from.ord, ordTo: s.to.ord, start: s.from.offset, end: s.to.offset, textSha: sha256Hex(text), mode: 'passage' }, where(open.passages.get(s.from.ord)));
  if (ok) note(t('Shared with her. Ask about it in your next message.'));
  $('#rt-share').hidden = true;
}

/** Follow my place: the top visible passage after 1.5 s still, at most once every 5 s. */
function onScroll() {
  if (!open || !$('#rt-follow').checked) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(sendPlace, Math.max(1500, 5000 - (Date.now() - lastFollowAt)));
}

async function sendPlace() {
  if (!open || !$('#rt-follow').checked) return;
  const box = $('#rt-text');
  const top = box.getBoundingClientRect().top;
  const first = [...box.querySelectorAll('.rt-passage')].find((p) => p.getBoundingClientRect().bottom > top + 4);
  if (!first) return;
  const p = open.passages.get(Number(first.dataset.ord));
  if (!p || p.ord === open.sent) return;
  lastFollowAt = Date.now();
  if (await send({ docId: open.doc.id, sha: open.doc.revision, ordFrom: p.ord, ordTo: p.ord, start: 0, end: p.text.length, textSha: sha256Hex(p.text), mode: 'follow' }, where(p))) {
    open.sent = p.ord;
    note(t('She follows your place. Your next message comes with this passage.'));
  }
}

function close() {
  open = null;
  clearTimeout(followTimer);
  $('#rt-panel').hidden = true;
  $('#rt-text').replaceChildren();
  $('#rt-follow').checked = false;
  // E6: nothing is remembered: the address and the list go with the view.
  $('#rt-feed-url').value = '';
  drawFeed();
}

/** E6: the Document or the Feed tab. */
function tab(which) {
  const feed = which === 'feed' || !open?.doc;
  $('#rt-tabs').hidden = !open?.doc; // a feed alone needs no tabs
  $('#rt-tab-doc').setAttribute('aria-selected', String(!feed));
  $('#rt-tab-feed').setAttribute('aria-selected', String(feed));
  $('#rt-doc-pane').hidden = feed;
  $('#rt-feed-pane').hidden = !feed;
}

function feedDate(p) {
  if (!p) return '';
  const d = new Date(p);
  return Number.isNaN(d.getTime()) ? p : d.toLocaleDateString();
}

function feedBar(name) {
  $('#rt-now').textContent = t('Reading together: {item} · {feed}', { item: name || t('(no title)'), feed: open.feed?.title ?? '' });
}

/** The open feed's items drawn as plain text (title, date and site), a link that opens only when clicked, and Share. */
function drawFeed() {
  const list = $('#rt-feed-items');
  list.replaceChildren();
  const f = open?.feed;
  $('#rt-feed-reload').hidden = !f;
  $('#rt-feed-title').hidden = !f;
  if (!f) return;
  $('#rt-feed-title').textContent = t('{feed} · {count} items', { feed: f.title, count: f.items.length });
  for (const item of f.items) {
    const li = document.createElement('li');
    li.className = 'rt-feed-item';
    li.classList.toggle('rt-shared', open.shared?.key === item.key);
    const title = document.createElement('span');
    title.className = 'rt-feed-name';
    title.textContent = item.title || t('(no title)');
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = [feedDate(item.published), f.host].filter(Boolean).join(' · ');
    li.append(title, meta);
    if (item.link && /^https?:\/\//i.test(item.link)) {
      const a = document.createElement('a');
      a.href = item.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'small';
      a.textContent = t('Open link');
      li.append(a);
    }
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'small';
    share.textContent = open.shared?.key === item.key ? t('Shared') : t('Share');
    share.addEventListener('click', () => void shareItem(item));
    li.append(share);
    list.append(li);
  }
}

/** Open or Reload: the only place a feed is fetched (by the server, once). */
async function loadFeed(url) {
  if (!open) return;
  if (!url?.trim()) return note(t('Paste the address of a feed first.'), { error: true });
  const conv = open.conv;
  note(t('Opening the feed…'));
  $('#rt-feed-go').disabled = true;
  $('#rt-feed-reload').disabled = true;
  try {
    const r = await deps.api(`/read-together/${encodeURIComponent(conv)}/feed`, { method: 'POST', body: { url: url.trim() } });
    if (open?.conv !== conv) return;
    open.feed = r.feed;
    $('#rt-feed-url').value = r.feed.url;
    $('#rt-private').hidden = !r.privateLocal;
    const s = open.shared;
    const still = s && r.feed.items.some((i) => i.key === s.key && (!s.textSha || i.textSha === s.textSha));
    if (s && !still) open.shared = { ...s, changed: true };
    drawFeed();
    if (s && !still) note(t('The item you shared changed or is no longer in the feed. Share it again.'), { error: true });
    else if (!r.feed.items.length) note(t('This feed has no items right now.'));
    else note(t('Press Share on one item. Nothing is shared until you do.'));
  } catch (err) {
    note(err.message, { error: true });
  } finally {
    $('#rt-feed-go').disabled = false;
    $('#rt-feed-reload').disabled = false;
  }
}

/** Share one item: its key and hashes only; the server reads the text from what it fetched. */
async function shareItem(item) {
  if (!open?.feed) return;
  try {
    const r = await deps.api(`/read-together/${encodeURIComponent(open.conv)}`, { method: 'PUT', body: { source: 'feed', rev: open.feed.rev, key: item.key, textSha: item.textSha } });
    open.shared = { key: item.key, textSha: item.textSha };
    open.sent = null;
    $('#rt-follow').checked = false;
    feedBar(item.title);
    $('#rt-private').hidden = !r.privateLocal;
    drawFeed();
    note(t('Shared with her. Ask about it in your next message.'));
  } catch (err) {
    note(err.message, { error: true });
  }
}

/** E6: opens the Feed tab above the current chat (from the Library's Read a feed together). */
export async function openReadFeed() {
  const conv = deps?.current();
  if (!conv) return false;
  if (open && open.conv !== conv) await stopReadTogether();
  if (!open) {
    const state = await deps.api(`/read-together/${encodeURIComponent(conv)}`).catch(() => ({ share: null, feed: null }));
    const feedShare = state.share?.source === 'feed' ? state.share : null;
    open = { conv, doc: null, passages: new Map(), sent: null, feed: state.feed ?? null, shared: feedShare ? { key: feedShare.key, textSha: state.feed?.items.find((i) => i.key === feedShare.key)?.textSha } : null };
    $('#rt-text').replaceChildren();
    $('#rt-private').hidden = !state.privateLocal;
    if (feedShare) feedBar(feedShare.name);
    else showBar('');
    if (feedShare?.mismatch) note(t('The item you shared changed or is no longer in the feed. Share it again.'), { error: true });
    else note(t('Paste the address of an RSS or Atom feed and press Open.'));
  }
  tab('feed');
  drawFeed();
  $('#rt-panel').hidden = false;
  $('#rt-feed-url').focus();
  return true;
}

/** Stop: ends sharing at once and closes the view. */
export async function stopReadTogether() {
  if (!open) return;
  const conv = open.conv;
  close();
  await deps.api(`/read-together/${encodeURIComponent(conv)}`, { method: 'DELETE', raw: true }).catch(() => {});
}

/** Opens a document beside the current chat (from the Library's Read together button). */
export async function openReadTogether(doc) {
  const conv = deps?.current();
  if (!conv) return false;
  if (open && open.conv !== conv) await stopReadTogether();
  const r = await deps.api(`/library/${doc.id}/passages?from=0&limit=200`);
  const state = await deps.api(`/read-together/${encodeURIComponent(conv)}`).catch(() => ({ share: null }));
  const kept = open?.conv === conv ? { feed: open.feed, shared: open.shared } : { feed: state.feed ?? null, shared: null };
  open = { conv, doc, passages: new Map(r.passages.map((p) => [p.ord, p])), sent: null, ...kept };
  const box = $('#rt-text');
  box.replaceChildren();
  let lastHead = null;
  for (const p of r.passages) {
    if (p.heading && p.heading !== lastHead) {
      const h = document.createElement('div');
      h.className = 'lib-place muted small';
      h.textContent = p.heading;
      box.append(h);
      lastHead = p.heading;
    }
    const para = document.createElement('p');
    para.className = 'lib-passage rt-passage';
    para.dataset.ord = String(p.ord);
    para.textContent = p.text;
    box.append(para);
  }
  showBar(state.share?.docId === doc.id && !state.share.mismatch ? state.share.place || state.share.heading : '');
  $('#rt-private').hidden = !state.privateLocal;
  if (state.share?.mismatch) note(t('This passage changed. Share it again.'), { error: true });
  else note(t('Select some text and press Share this passage. Nothing is shared until you do.'));
  $('#rt-share').hidden = true;
  tab('doc');
  drawFeed();
  $('#rt-panel').hidden = false;
  return true;
}

/** Another chat opened: sharing belongs to the chat it started in, so it ends. */
export function readTogetherSwitched(id) {
  if (open && open.conv !== id) void stopReadTogether();
}

export function initReadTogether(d) {
  deps = d;
  $('#rt-stop').addEventListener('click', () => void stopReadTogether());
  $('#rt-share').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  $('#rt-share').addEventListener('click', () => void shareSelection());
  $('#rt-text').addEventListener('scroll', onScroll, { passive: true });
  $('#rt-follow').addEventListener('change', () => {
    if ($('#rt-follow').checked) return void sendPlace();
    // Off: her next message no longer gets your place (nothing is shared until you press Share).
    if (open) void deps.api(`/read-together/${encodeURIComponent(open.conv)}?only=share`, { method: 'DELETE', raw: true }).catch(() => {});
    if (open) open.sent = null;
    if (open) showBar('');
    note(t('Follow is off. Nothing is shared until you press Share this passage.'));
  });
  document.addEventListener('selectionchange', onSelection);
  $('#rt-tab-doc').addEventListener('click', () => tab('doc'));
  $('#rt-tab-feed').addEventListener('click', () => tab('feed'));
  $('#rt-feed-go').addEventListener('click', () => void loadFeed($('#rt-feed-url').value));
  $('#rt-feed-reload').addEventListener('click', () => void loadFeed(open?.feed?.url));
  $('#rt-feed-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void loadFeed($('#rt-feed-url').value);
    }
  });
}

