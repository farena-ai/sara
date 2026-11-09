// C7: Settings → Her → Companions → Bring your companion from another app. Her export files and/or
// pasted notes go to the server (read there, never here), the preview shows what comes over, the
// owner unticks what he doesn't want, then she arrives as a new companion.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, body) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
const MAX_BYTES = 50 * 1024 * 1024;
const status = (text) => ($('#bring-status').textContent = text);

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function check(id, label, on = true) {
  const l = el('label', 'bring-check');
  const box = el('input');
  box.type = 'checkbox';
  box.id = id;
  box.checked = on;
  l.append(box, ' ', label);
  return l;
}

/** What each memory was in the other app (the server's labels), in the owner's language. */
const LABELS = () => ({ 'key memory': t('key memory'), 'journal entry': t('journal entry'), 'diary entry': t('diary entry'), 'shared note': t('shared note'), memory: t('memory'), 'about you': t('about you'), 'your appearance': t('your appearance'), nicknames: t('nicknames'), preferences: t('preferences'), desires: t('desires') });

let draft = null;
let hooks = { refresh: async () => {}, switchTo: () => {} };

function render(p) {
  const box = $('#bring-draft');
  const head = el('div', 'bring-head');
  const name = el('input');
  name.id = 'bring-name';
  name.maxLength = 40;
  name.value = p.name;
  name.setAttribute('aria-label', t('Her name'));
  head.append(el('strong', '', t('From {app}', { app: p.sourceName === 'another app' ? t('another app') : p.sourceName })), ' ', name, el('span', 'muted small', ` · ${p.pronouns} · ${p.age}`));
  const parts = [head];
  const story = el('div', 'bring-part');
  story.append(check('bring-backstory', t('Her backstory and personality')), el('p', 'small', p.summary));
  if (p.personality.length) story.append(el('p', 'muted small', p.personality.join(' · ')));
  if (p.appearance) story.append(el('p', 'muted small', `${t('Looks')}: ${p.appearance}`));
  parts.push(story);
  if (p.greeting) {
    const g = el('div', 'bring-part');
    g.append(check('bring-greeting', t('Her greeting')), el('blockquote', 'small', p.greeting));
    parts.push(g);
  }
  if (p.examples.length) {
    const x = el('div', 'bring-part');
    x.append(check('bring-examples', t('Example lines ({n})', { n: p.examples.length })));
    for (const line of p.examples.slice(0, 3)) x.append(el('blockquote', 'small', line));
    parts.push(x);
  }
  if (p.memories.length) {
    const m = el('div', 'bring-part');
    m.append(el('strong', '', t('Memories ({n})', { n: p.memories.length })), ' ');
    const all = el('button', 'ghost small', t('Untick all'));
    all.type = 'button';
    all.addEventListener('click', () => {
      const boxes = [...m.querySelectorAll('input[data-index]')];
      const on = boxes.every((b) => !b.checked);
      for (const b of boxes) b.checked = on;
      all.textContent = on ? t('Untick all') : t('Tick all');
    });
    m.append(all);
    const ul = el('ul', 'bring-memories');
    for (const mem of p.memories) {
      const li = el('li');
      const l = el('label');
      const b = el('input');
      b.type = 'checkbox';
      b.checked = true;
      b.dataset.index = String(mem.index);
      l.append(b, ' ', mem.text, el('span', 'muted small', ` · ${LABELS()[mem.label] ?? mem.label}${mem.date ? ` · ${mem.date}` : ''}`));
      li.append(l);
      ul.append(li);
    }
    m.append(ul);
    parts.push(m);
  }
  if (p.messages) {
    const c = el('div', 'bring-part');
    c.append(check('bring-chats', t('Keep the chat history ({n} messages in {c} chats) as archived, read-only conversations', { n: p.messages, c: p.conversations })));
    parts.push(c);
  }
  const notes = el('ul', 'muted small bring-notes');
  for (const n of p.notes) notes.append(el('li', '', t(n.text, n.params)));
  parts.push(notes);
  const go = el('button', '', t('Bring her over'));
  go.type = 'button';
  go.id = 'bring-go';
  go.disabled = !p.canAdd;
  const cancel = el('button', 'ghost', t('Cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', reset);
  const row = el('p', 'small');
  row.append(go, ' ', cancel);
  if (!p.canAdd) row.append(' ', el('span', 'muted small', t('Rename her, or remove a companion first (up to 8, each with her own name).')));
  name.addEventListener('input', () => (go.disabled = !name.value.trim()));
  go.addEventListener('click', bringOver);
  parts.push(row);
  box.replaceChildren(...parts);
  box.hidden = false;
}

function reset() {
  draft = null;
  $('#bring-draft').hidden = true;
  $('#bring-draft').replaceChildren();
}

async function preview() {
  status('');
  const files = [...($('#bring-files').files ?? [])];
  const text = $('#bring-text').value;
  if (!files.length && !text.trim()) return status(t('Choose her files or paste her notes first.'));
  if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES) return status(t('These files are bigger than 50 MB together. Choose fewer, or only the ones with her character and memories.'));
  $('#bring-preview').disabled = true;
  status(t('Reading…'));
  try {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: base64(await f.arrayBuffer()) })));
    const r = await api('/companions/bring/preview', { files: payload, text, source: $('#bring-source').value });
    draft = r;
    status('');
    render(r.preview);
  } catch (err) {
    reset();
    status(err.message);
  } finally {
    $('#bring-preview').disabled = false;
  }
}

async function bringOver() {
  if (!draft) return;
  const box = $('#bring-draft');
  const on = (id) => box.querySelector(`#${id}`)?.checked ?? false;
  const body = {
    token: draft.token,
    name: $('#bring-name').value.trim(),
    backstory: on('bring-backstory'),
    greeting: on('bring-greeting'),
    examples: on('bring-examples'),
    memories: [...box.querySelectorAll('input[data-index]')].filter((b) => b.checked).map((b) => Number(b.dataset.index)),
    chats: on('bring-chats'),
  };
  $('#bring-go').disabled = true;
  try {
    const r = await api('/companions/bring/import', body);
    reset();
    $('#bring-files').value = '';
    $('#bring-text').value = '';
    await hooks.refresh();
    const sw = el('button', 'small', t('Switch to {name}', { name: r.name }));
    sw.type = 'button';
    sw.addEventListener('click', () => hooks.switchTo(r.companion));
    $('#bring-status').replaceChildren(`${t('{name} is here: {m} memories and {c} chats came over.', { name: r.name, m: r.memories, c: r.conversations })} `, sw);
  } catch (err) {
    status(err.message);
    $('#bring-go').disabled = false;
  }
}

export function initBring(h) {
  hooks = { ...hooks, ...h };
  $('#bring-preview')?.addEventListener('click', preview);
}
