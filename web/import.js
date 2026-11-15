// Phase 65: Settings → Privacy & system → Move in and export → Bring her from another app. Choose a chat file → see what's in it and
// say who is who → see the size and the model (cloud models cost money) → she reads it (progress,
// Stop) → review what she learned (facts about you, your history together, a personality draft),
// edit, untick → Save. Nothing is kept before Save; the raw chats only when asked.
import { locale, serverText, t } from './naming.js';

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
    headers: opts.raw ? { 'content-type': 'application/octet-stream' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const num = (n) => Number(n).toLocaleString(locale());
const MAX_ROWS = 400;
const formatLabel = (f) => ({ chatgpt: t('ChatGPT export'), claude: t('Claude export'), characterai: t('Character.AI chat'), sillytavern: t('SillyTavern chat'), json: t('Chat file (JSON)'), csv: t('Chat file (CSV)'), text: t('Text transcript') })[f] ?? f;
/** App names stay as they are; "another app" is translated. */
const sourceLabel = (s) => (s.id === 'text' ? t('Another app') : s.name);

let pv = null;
let selected = new Set();
let roles = {};
let poll = null;
let estimateTimer = null;
let sources = [];

const msg = (s) => ($('#ci-msg').textContent = s);
function show(step) {
  $('#ci-preview').hidden = step !== 'preview';
  $('#ci-progress').hidden = step !== 'progress';
  $('#ci-review').hidden = step !== 'review';
}

function choice() {
  return { conversations: [...selected], roles, source: $('#ci-source').value, localOnly: $('#ci-local').checked };
}

function renderPreview() {
  const range = pv.from ? ` ${day(pv.from)} – ${day(pv.to)}` : '';
  $('#ci-summary').textContent = `${formatLabel(pv.format)}: ${t('{n} conversations, {m} messages', { n: num(pv.conversations), m: num(pv.messages) })}${range ? `,${range}` : ''}.`;
  const notes = [];
  if (pv.droppedForSafety) notes.push(t('{n} conversations were left out by the safety check and will never be stored.', { n: pv.droppedForSafety }));
  if (pv.redacted) notes.push(t('Secrets (keys, passwords) were blanked out in {n} messages.', { n: pv.redacted }));
  if (pv.leftOut) notes.push(t('{n} system or empty lines were left out.', { n: pv.leftOut }));
  $('#ci-notes').textContent = notes.join(' ');
  $('#ci-source').replaceChildren(...sources.map((s) => Object.assign(el('option', '', sourceLabel(s)), { value: s.id, selected: s.id === pv.source })));
  $('#ci-speakers').replaceChildren(
    ...pv.speakers.map((s) => {
      const row = el('label', 'ci-speaker');
      row.append(el('span', '', `${s.name} `), el('span', 'muted small', t('({n} messages)', { n: num(s.messages) })));
      const sel = el('select');
      for (const [v, label] of [['owner', t('You')], ['companion', t('Her (the character)')], ['other', t('Leave out')]]) sel.append(Object.assign(el('option', '', label), { value: v, selected: s.role === v }));
      sel.addEventListener('change', () => {
        roles[s.name] = sel.value;
        estimateSoon();
      });
      row.append(sel);
      return row;
    }),
  );
  renderList();
}

function renderList() {
  const rows = pv.list.slice(0, MAX_ROWS).map((c) => {
    const li = el('li', 'ci-conv');
    const label = el('label', 'row');
    const box = Object.assign(el('input'), { type: 'checkbox', checked: selected.has(c.index) });
    box.dataset.noauto = '';
    box.addEventListener('change', () => {
      if (box.checked) selected.add(c.index);
      else selected.delete(c.index);
      countChosen();
      estimateSoon();
    });
    label.append(box, el('span', '', ` ${c.title} `), el('span', 'muted small', `${day(c.from)} · ${t('{n} messages', { n: num(c.messages) })}`));
    li.append(label);
    return li;
  });
  if (pv.list.length > MAX_ROWS) rows.push(el('li', 'muted small', t('…and {n} more (chosen with All / None).', { n: num(pv.list.length - MAX_ROWS) })));
  $('#ci-list').replaceChildren(...rows);
  countChosen();
}

function countChosen() {
  $('#ci-chosen').textContent = t('{n} of {m} chosen', { n: num(selected.size), m: num(pv.conversations) });
}

function estimateSoon() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => void estimate(), 250);
}

async function estimate() {
  if (!pv) return;
  $('#ci-start').disabled = true;
  try {
    const e = await api(`/import/${pv.id}/estimate`, { method: 'POST', body: choice() });
    const parts = [];
    if (e.model) {
      parts.push(e.chunks === 1 ? t('About {tokens} tokens in one model call, with {model} ({provider}).', { tokens: num(e.inputTokens + e.outputTokens), model: e.model.model, provider: e.model.provider }) : t('About {tokens} tokens in {calls} model calls, with {model} ({provider}).', { tokens: num(e.inputTokens + e.outputTokens), calls: num(e.chunks), model: e.model.model, provider: e.model.provider }));
      if (e.model.local) parts.push(t('It runs on your own hardware: no cost.'));
      else if (e.model.usd !== null) parts.push(t('A cloud model: about ${usd} (an estimate).', { usd: e.model.usd.toFixed(2) }));
      else parts.push(t('A cloud model: it may cost money (no price set for it in Usage and costs).'));
    } else parts.push(`${t(e.problem ?? 'No model is set up.')} ${t('You can still read them without a model.')}`);
    if (e.tooMuch) parts.push(t('That is too much to read at once. Choose fewer conversations.'));
    $('#ci-estimate').textContent = parts.join(' ');
    $('#ci-start').disabled = !e.model || e.tooMuch || !e.chunks;
  } catch (err) {
    $('#ci-estimate').textContent = err.message;
  }
}

async function pick(file) {
  msg(t('Reading {name}…', { name: file.name }));
  await loadImport();
  show('');
  try {
    if (pv) await api(`/import/${pv.id}`, { method: 'DELETE' }).catch(() => {});
    pv = await api(`/import/preview?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file });
    selected = new Set(pv.list.map((c) => c.index));
    if (pv.list.length < pv.conversations) for (let i = 0; i < pv.conversations; i++) selected.add(i);
    roles = Object.fromEntries(pv.speakers.map((s) => [s.name, s.role]));
    renderPreview();
    show('preview');
    msg(t('Nothing is saved until you check what she learned and press Save.'));
    void estimate();
  } catch (err) {
    pv = null;
    msg(err.message);
  }
}

async function start(useModel) {
  msg('');
  try {
    const st = await api(`/import/${pv.id}/start`, { method: 'POST', body: { ...choice(), useModel } });
    follow(st);
  } catch (err) {
    msg(err.message);
  }
}

function follow(st) {
  clearTimeout(poll);
  if (st.state === 'learning') {
    show('progress');
    $('#ci-bar').max = Math.max(1, st.total);
    $('#ci-bar').value = st.done;
    $('#ci-status').textContent = t('She is reading: part {n} of {m}.', { n: num(Math.min(st.done + 1, st.total)), m: num(st.total) });
    poll = setTimeout(async () => {
      try {
        follow(await api(`/import/${pv.id}`));
      } catch (err) {
        msg(err.message);
        show('');
      }
    }, 1000);
    return;
  }
  if (st.state === 'review') return renderReview(st);
  show('preview');
  msg(st.state === 'cancelled' ? t('Stopped. Nothing was saved.') : st.state === 'error' ? t('The model kept failing, so she stopped. You can read it without a model instead.') : '');
}

function item(kind, value, meta, multiline) {
  const li = el('li', 'ci-item');
  const box = Object.assign(el('input'), { type: 'checkbox', checked: true });
  box.dataset.noauto = '';
  box.setAttribute('aria-label', t('Keep this'));
  const field = multiline ? el('textarea') : el('input');
  field.value = value;
  field.dataset.noauto = '';
  field.className = 'ci-edit';
  if (multiline) field.rows = 3;
  field.setAttribute('aria-label', t('Edit before saving'));
  const body = el('div', 'ci-item-body');
  body.append(field);
  if (meta) body.append(el('span', 'muted small', meta));
  li.append(box, body);
  li.dataset.kind = kind;
  return li;
}

function renderReview(st) {
  const p = st.proposals;
  show('review');
  $('#ci-review-note').textContent = p.by === 'heuristic' ? t('A simple reading without a model: check each line.') : t('Untick anything you don’t want her to keep, and edit any line. {n} suggestions were left out (not in your own words, or unsafe).', { n: p.dropped });
  $('#ci-facts').replaceChildren(...(p.facts.length ? p.facts.map((f) => Object.assign(item('fact', f.text, `“${f.quote}” · ${day(f.date)}`), { _data: f })) : [el('li', 'muted small', t('Nothing found.'))]));
  $('#ci-summaries').replaceChildren(...(p.summaries.length ? p.summaries.map((s) => Object.assign(item('summary', s.text, day(s.date), true), { _data: s })) : [el('li', 'muted small', t('Nothing found.'))]));
  const style = [...p.personality.map((x) => ['personality', x]), ...p.speech.map((x) => ['speech', x])];
  $('#ci-style').replaceChildren(...(style.length ? style.map(([k, x]) => item(k, x, k === 'speech' ? t('How she writes') : t('Her character'))) : [el('li', 'muted small', t('Nothing found.'))]));
  $('#ci-apply').checked = false;
  $('#ci-apply').disabled = !style.length;
  $('#ci-keep').checked = false;
  msg('');
}

function kept(list) {
  return [...list.querySelectorAll('li.ci-item')].filter((li) => li.querySelector('input[type=checkbox]').checked).map((li) => ({ li, text: li.querySelector('.ci-edit').value.trim() })).filter((x) => x.text);
}

async function save() {
  const facts = kept($('#ci-facts')).map(({ li, text }) => ({ ...li._data, text }));
  const summaries = kept($('#ci-summaries')).map(({ li, text }) => ({ ...li._data, text }));
  const style = kept($('#ci-style'));
  $('#ci-save').disabled = true;
  try {
    const r = await api(`/import/${pv.id}/confirm`, {
      method: 'POST',
      body: {
        facts,
        summaries,
        personality: style.filter((x) => x.li.dataset.kind === 'personality').map((x) => x.text),
        speech: style.filter((x) => x.li.dataset.kind === 'speech').map((x) => x.text),
        applyPersonality: $('#ci-apply').checked,
        keepRaw: $('#ci-keep').checked,
        source: $('#ci-source').value,
      },
    });
    pv = null;
    show('');
    const parts = [t('Saved: {f} things about you and {s} moments of your history.', { f: r.facts, s: r.summaries })];
    if (r.personality || r.speech) parts.push(t('{n} notes were added to her personality.', { n: r.personality + r.speech }));
    if (r.conversations) parts.push(t('{n} chats were kept, read-only.', { n: r.conversations }));
    if (r.droppedForSafety) parts.push(t('{n} lines were left out by the safety check.', { n: r.droppedForSafety }));
    msg(parts.join(' '));
  } catch (err) {
    msg(err.message);
  } finally {
    $('#ci-save').disabled = false;
  }
}

async function discard() {
  clearTimeout(poll);
  if (pv) await api(`/import/${pv.id}`, { method: 'DELETE' }).catch(() => {});
  pv = null;
  show('');
  msg(t('Thrown away. Nothing was saved.'));
}

export async function loadImport() {
  if (sources.length) return;
  try {
    sources = (await api('/import')).sources;
  } catch {
    /* the demo, or signed out: the page says what it can */
  }
}

export function initImport() {
  $('#ci-file').addEventListener('change', () => {
    const f = $('#ci-file').files[0];
    $('#ci-file').value = '';
    if (f) void pick(f);
  });
  $('#ci-source').addEventListener('change', estimateSoon);
  $('#ci-local').addEventListener('change', estimateSoon);
  $('#ci-all').addEventListener('click', () => {
    selected = new Set(Array.from({ length: pv.conversations }, (_, i) => i));
    renderList();
    estimateSoon();
  });
  $('#ci-none').addEventListener('click', () => {
    selected = new Set();
    renderList();
    estimateSoon();
  });
  $('#ci-start').addEventListener('click', () => void start(true));
  $('#ci-simple').addEventListener('click', () => void start(false));
  $('#ci-discard').addEventListener('click', () => void discard());
  $('#ci-throw').addEventListener('click', () => void discard());
  $('#ci-cancel').addEventListener('click', async () => {
    try {
      follow(await api(`/import/${pv.id}/cancel`, { method: 'POST', body: {} }));
    } catch (err) {
      msg(err.message);
    }
  });
  $('#ci-save').addEventListener('click', () => void save());
}
