// V2.9 One-minute voice journal (docs/design/JOURNAL.md): Library → Journal. Record up to a minute
// (or type), tag a mood, and the entry is kept in your own sealed book (src/journal.ts). Recordings
// go only to /api/library/journal, which hears them on this computer; never /api/voice/transcribe
// (that one may use a cloud speech service). "On this day" shows the same day in earlier years.
import { locale, serverText, t } from './naming.js';
import { Mic } from './voice.js';

const $ = (s) => document.querySelector(s);
const MOODS = ['great', 'good', 'okay', 'low', 'rough'];
const MOOD_LABEL = { great: () => t('Great day'), good: () => t('Good day'), okay: () => t('Okay day'), low: () => t('Low day'), rough: () => t('Rough day') };
let state = { entries: [], hearing: false, prefs: { keepAudio: false }, maxSeconds: 60 };
let mood = null;
let mic = null;
let rec = null; // { started, timer, stop }
let busy = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.raw ? { 'content-type': 'audio/wav' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(serverText(data, res.statusText));
    err.typeInstead = Boolean(data.typeInstead);
    throw err;
  }
  return data;
}
const status = (s) => {
  const n = $('#jr-status');
  if (n) n.textContent = s;
};
const dayText = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeText = (at) => new Date(at).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
const clockText = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Mood chips (a radio group you can clear by tapping the chosen one again). */
function moodChips(box, current, onPick) {
  box.replaceChildren();
  for (const m of MOODS) {
    const b = btn(MOOD_LABEL[m](), '', () => onPick(current === m ? null : m));
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(current === m));
    box.append(b);
  }
}
function drawMood() {
  moodChips($('#jr-moods'), mood, (m) => {
    mood = m;
    drawMood();
  });
}

function drawStreak(d) {
  const n = $('#jr-streak');
  if (!n) return;
  if (d.today) n.textContent = d.streak > 1 ? t('{n} days in a row. Today is done.', { n: d.streak }) : t('Today is done.');
  else if (d.streak > 1) n.textContent = t('{n} days in a row: add today to keep it going.', { n: d.streak });
  else if (d.streak === 1) n.textContent = t('You wrote yesterday: add today to keep it going.');
  else n.textContent = t('A minute a day. Nothing for today yet.');
}

function drawOtd(otd) {
  const box = $('#jr-otd');
  if (!box) return;
  box.replaceChildren();
  box.hidden = !otd?.items?.length;
  if (box.hidden) return;
  const first = otd.items[0];
  const oneYear = otd.items.every((e) => e.years === first.years);
  box.append(el('h3', '', otd.kind === 'month' ? t('On this day, a month ago') : !oneYear ? t('On this day in earlier years') : first.years > 1 ? t('On this day, {n} years ago', { n: first.years }) : t('On this day, a year ago')));
  for (const e of otd.items) {
    const row = el('div', 'jr-otd-item');
    const head = el('p', 'muted small', dayText(e.day));
    if (e.mood) head.append(' · ', el('span', 'jr-tag', MOOD_LABEL[e.mood]()));
    row.append(head, el('p', 'jr-entry-text', e.text));
    box.append(row);
  }
}

function drawEntry(e) {
  const li = el('li', 'jr-entry');
  li.dataset.id = String(e.id);
  const head = el('div', 'jr-entry-head');
  const when = el('strong', '', dayText(e.day));
  const meta = el('span', 'muted small', [timeText(e.at), e.spoken ? t('spoken, {time}', { time: clockText(e.seconds) }) : t('typed'), e.edited ? t('edited') : ''].filter(Boolean).join(' · '));
  head.append(when, meta);
  li.append(head);
  if (e.mood) li.append(el('span', 'jr-tag', MOOD_LABEL[e.mood]()));
  li.append(el('p', 'jr-entry-text', e.text));
  if (e.audio) {
    const a = el('audio');
    a.controls = true;
    a.preload = 'none';
    a.src = `/api/library/journal/${e.id}/audio`;
    a.setAttribute('aria-label', t('Your recording'));
    li.append(a);
  }
  const tools = el('div', 'jr-entry-tools');
  tools.append(
    btn(t('Edit'), 'ghost small', () => editEntry(li, e)),
    btn(t('Delete'), 'ghost small', async () => {
      if (!confirm(t('Delete this journal entry?'))) return;
      try {
        await api(`/library/journal/${e.id}`, { method: 'DELETE' });
        await load();
      } catch (err) {
        status(err.message);
      }
    }),
  );
  li.append(tools);
  return li;
}

function editEntry(li, e) {
  let m = e.mood;
  li.replaceChildren();
  const box = el('div', 'jr-entry-moods');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', t('Mood'));
  const paint = () =>
    moodChips(box, m, (next) => {
      m = next;
      paint();
    });
  paint();
  const ta = el('textarea');
  ta.rows = 4;
  ta.maxLength = 4000;
  ta.value = e.text;
  ta.setAttribute('aria-label', t('Entry'));
  const tools = el('div', 'jr-entry-tools');
  tools.append(
    btn(t('Save'), 'small', async () => {
      try {
        await api(`/library/journal/${e.id}`, { method: 'PATCH', body: { text: ta.value, mood: m } });
        await load();
      } catch (err) {
        status(err.message);
      }
    }),
    btn(t('Cancel'), 'ghost small', () => li.replaceWith(drawEntry(e))),
  );
  li.append(el('strong', '', dayText(e.day)), box, ta, tools);
  ta.focus();
}

function draw(d) {
  state = d;
  drawStreak(d);
  drawOtd(d.onThisDay);
  drawMood();
  $('#jr-keep').checked = Boolean(d.prefs?.keepAudio);
  const recBtn = $('#jr-record');
  recBtn.hidden = !d.hearing;
  $('#jr-keep').closest('label').hidden = !d.hearing;
  if (!d.hearing && !rec) $('#jr-timer').textContent = t('Hearing is not set up on this computer, so type your entry for now.');
  else if (!rec) $('#jr-timer').textContent = t('Up to {time}', { time: clockText(d.maxSeconds) });
  const list = $('#jr-list');
  list.replaceChildren(...d.entries.map(drawEntry));
  if (!d.entries.length) list.append(el('li', 'muted small', t('No entries yet. Your first one takes a minute.')));
}

async function load() {
  try {
    draw(await api('/library/journal'));
  } catch (err) {
    status(err.message);
  }
}

// ---------------------------------------------------------------- recording

async function startRecording() {
  if (busy) return;
  status('');
  try {
    mic ??= new Mic();
    await mic.open();
  } catch {
    status(t('The microphone is off for this page. Allow it in the browser, or type your entry.'));
    return;
  }
  mic.start();
  const b = $('#jr-record');
  b.textContent = t('Stop and save');
  b.classList.add('on');
  const started = Date.now();
  const tick = () => {
    const s = (Date.now() - started) / 1000;
    $('#jr-timer').textContent = `${clockText(s)} / ${clockText(state.maxSeconds)}`;
    if (s >= state.maxSeconds) void stopRecording();
  };
  rec = { started, timer: setInterval(tick, 250) };
  tick();
}

async function stopRecording(save = true) {
  if (!rec) return;
  clearInterval(rec.timer);
  rec = null;
  const b = $('#jr-record');
  b.textContent = t('Record a minute');
  b.classList.remove('on');
  const wav = mic?.stop(500);
  mic?.close();
  mic = null;
  if (!save) return;
  if (!wav) {
    status(t('That was too short. Hold on a little longer.'));
    $('#jr-timer').textContent = '';
    return;
  }
  busy = true;
  b.disabled = true;
  status(t('Hearing it on this computer…'));
  try {
    const q = new URLSearchParams();
    if (mood) q.set('mood', mood);
    if ($('#jr-keep').checked) q.set('keep', '1');
    await api(`/library/journal?${q}`, { method: 'POST', raw: wav });
    mood = null;
    status(t('Saved.'));
    await load();
  } catch (err) {
    status(err.message);
    if (err.typeInstead) $('#jr-text').focus();
  } finally {
    busy = false;
    b.disabled = false;
  }
}

async function saveTyped() {
  const text = $('#jr-text').value.trim();
  if (!text) {
    status(t('Write a few words first.'));
    return;
  }
  try {
    await api('/library/journal', { method: 'POST', body: { text, mood } });
    $('#jr-text').value = '';
    mood = null;
    status(t('Saved.'));
    await load();
  } catch (err) {
    status(err.message);
  }
}

// ---------------------------------------------------------------- open / close

/** Opens the Journal inside the Library window. */
export function openJournal() {
  const lib = $('#library');
  if (lib && !lib.open) lib.showModal();
  for (const id of ['#lib-home', '#lib-doc', '#lib-research', '#lib-topics', '#lib-meetings', '#lib-study', '#lib-media', '#lib-scan']) {
    const n = $(id);
    if (n) n.hidden = true;
  }
  $('#lib-journal').hidden = false;
  status('');
  void load();
}

export function initJournal() {
  const sec = $('#lib-journal');
  if (!sec) return;
  $('#lib-journal-open')?.addEventListener('click', openJournal);
  $('#jr-back').addEventListener('click', () => {
    sec.hidden = true;
    $('#lib-home').hidden = false;
  });
  $('#jr-record').addEventListener('click', () => void (rec ? stopRecording() : startRecording()));
  $('#jr-save').addEventListener('click', () => void saveTyped());
  $('#jr-keep').addEventListener('change', async () => {
    try {
      state.prefs = (await api('/library/journal/prefs', { method: 'PUT', body: { keepAudio: $('#jr-keep').checked } })).prefs;
    } catch (err) {
      status(err.message);
    }
  });
  // Leaving the view (another Library view, closing the window) drops a recording in progress.
  // (Only on the change to hidden: setting `hidden` again records a mutation too.)
  let shown = !sec.hidden;
  new MutationObserver(() => {
    if (shown && sec.hidden) void stopRecording(false);
    shown = !sec.hidden;
  }).observe(sec, { attributes: true, attributeFilter: ['hidden'] });
  $('#library')?.addEventListener('close', () => void stopRecording(false));
}
