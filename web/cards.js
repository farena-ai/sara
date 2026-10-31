// Phase 57: character cards in Settings → Her → Name and personality (the gallery). Import a card
// (SillyTavern / Character Card V2 and V3, PNG or JSON) or a Sara character file with the one
// Import button or by dropping the file,
// see a preview first, then make her that character or add the character as a new companion.
// Export her as a V3 card: a PNG of her picture with the card inside, or JSON.
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
    method: opts.method ?? 'GET',
    headers: opts.raw ? { 'content-type': opts.type } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const MAX_PNG = 20 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
/** A Sara character file (her own export, pictures included): the server's MAX_CHARACTER. */
const MAX_SARA_FILE = 60 * 1024 * 1024;
let hooks = { onImported: async () => {}, picture: () => '/sara-portrait.jpg', name: () => 'character' };
let draft = null;

const status = (text) => ($('#card-status').textContent = text);

async function preview(file) {
  status('');
  const png = /\.png$/i.test(file.name) || file.type === 'image/png';
  // One Import for both kinds: a Sara character file goes to its own preview (look and voice too).
  // It's checked before the card size limit: Sara's own export carries her pictures, so it's often
  // well over a card's 2 MB (its own limit is 60 MB, as on the server).
  if (!png && file.size <= MAX_SARA_FILE && (await isSaraFile(file))) return void openSaraFile(file);
  if (file.size > (png ? MAX_PNG : MAX_JSON)) return status(png ? t('The picture is too big (up to 20 MB).') : t('The character card is too big (up to 2 MB).'));
  status(t('Reading the card…'));
  try {
    const r = await api('/character/card/preview', { method: 'POST', raw: await file.arrayBuffer(), type: png ? 'image/png' : 'application/json' });
    draft = r;
    showPreview(r.preview);
    status('');
  } catch (err) {
    draft = null;
    $('#card-preview').hidden = true;
    status(err.message);
  }
}

/** A Sara character file (format 'sara-character'), not a card. */
async function isSaraFile(file) {
  try {
    return JSON.parse(await file.text())?.format === 'sara-character';
  } catch {
    return false;
  }
}

/** Hands a Sara character file to the Character file section's own preview. */
function openSaraFile(file) {
  const input = $('#char-file');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  draft = null;
  $('#card-preview').hidden = true;
  setTimeout(() => $('#char-import-box')?.scrollIntoView({ block: 'nearest' }), 100);
}

function showPreview(p) {
  const box = $('#card-preview');
  const img = $('#card-pic');
  img.hidden = !p.picture;
  // Without a picture the text uses the whole width.
  box.classList.toggle('no-pic', !p.picture);
  if (p.picture) img.src = p.picture;
  $('#card-pic-row').hidden = !p.picture;
  $('#card-picture').checked = Boolean(p.picture);
  const name = $('#card-name');
  name.textContent = `${p.name} · ${p.age}`;
  $('#card-summary').textContent = p.summary;
  $('#card-traits').textContent = p.personality.join(' ');
  $('#card-greeting').textContent = p.greeting ? `“${p.greeting}”` : '';
  $('#card-greeting').hidden = !p.greeting;
  $('#card-tags').replaceChildren(...p.tags.map((x) => el('span', 'gallery-tag', x)));
  const facts = [p.lore ? (p.lore === 1 ? t('1 lorebook entry becomes her notes.') : t('{n} lorebook entries become her notes.', { n: p.lore })) : '', p.pictureTooBig ? t('The picture is over 5 MB, so her picture stays.') : '', ...p.notes.map((n) => t(n))].filter(Boolean);
  $('#card-notes').replaceChildren(...facts.map((x) => el('li', '', x)));
  $('#card-use-new').hidden = !p.canAdd;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

async function use(as) {
  if (!draft) return;
  const name = draft.preview.name;
  if (as === 'this' && !confirm(t('Make her {name}? Her name, personality and character change to the card’s; her memories and conversations stay.', { name }))) return;
  status(t('Loading…'));
  try {
    const r = await api('/character/card/import', { method: 'POST', body: { token: draft.token, as, picture: $('#card-picture').checked } });
    draft = null;
    $('#card-preview').hidden = true;
    await hooks.onImported(r);
    status(r.companion ? t('{name} is added as a new companion. Switch to them with ⇄ at the top of the sidebar.', { name }) : t('Now {name}. Change anything below.', { name }));
  } catch (err) {
    status(err.message);
  }
}

/** Her picture as a PNG (drawn in the browser), with the card put in by the server. */
async function exportPng() {
  status(t('Making the card…'));
  try {
    const img = new Image();
    img.src = hooks.picture();
    await img.decode();
    const scale = Math.min(1, 1024 / Math.max(img.naturalWidth || 512, img.naturalHeight || 512));
    const c = document.createElement('canvas');
    c.width = Math.round((img.naturalWidth || 512) * scale);
    c.height = Math.round((img.naturalHeight || 512) * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const res = await fetch('/api/character/card/png', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob });
    if (!res.ok) throw new Error(serverText(await res.json().catch(() => ({})), `HTTP ${res.status}`));
    download(await res.blob(), `${hooks.name()}.card.png`);
    status('');
  } catch {
    // Drawing failed: the server puts in her portrait itself.
    location.href = '/api/character/card/png';
    status('');
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[^\w.-]+/g, '-');
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

export function initCards(h) {
  hooks = { ...hooks, ...h };
  $('#card-import').addEventListener('click', () => $('#card-file').click());
  $('#card-file').addEventListener('change', () => {
    const f = $('#card-file').files?.[0];
    $('#card-file').value = '';
    if (f) void preview(f);
  });
  $('#card-use-this').addEventListener('click', () => use('this'));
  $('#card-use-new').addEventListener('click', () => use('new'));
  $('#card-cancel').addEventListener('click', () => {
    draft = null;
    $('#card-preview').hidden = true;
  });
  $('#card-export-png').addEventListener('click', () => void exportPng());
  // The Share or export menu closes after a choice.
  for (const id of ['#card-export-png', '#card-export-json', '#gallery-share']) $(id).addEventListener('click', () => ($('#card-share').open = false));
  // Drop a card anywhere on the character gallery.
  const zone = $('#card-drop');
  for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('drop-on');
  });
  for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, () => zone.classList.remove('drop-on'));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    void preview(f);
  });
}
