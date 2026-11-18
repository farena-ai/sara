// V2.4 (docs/BRIEFING_AUDIO.md): the morning briefing as audio. Settings → You → Briefing and
// reminders → "Listen to your briefing" (make it as audio, which voice, make one now, the private
// podcast link) and "Life review" (weekly, next to the planner review), plus the play button on
// Today, shown when this morning's recording is ready. Server: src/briefing-audio.ts,
// src/life-review.ts, routes in src/routes/planner.ts.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? t('Something went wrong.'));
  return data;
}

const say = (id, msg, bad = false) => {
  const s = $(id);
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle('error', bad);
};

/** Today's local date as YYYY-MM-DD (the recording's day is the briefing's local day). */
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showFeed(feed, path) {
  const box = $('#ba-feed');
  if (!box) return;
  if (!feed) return void (box.hidden = true);
  box.hidden = false;
  $('#ba-feed-off').hidden = !feed.on;
  $('#ba-feed-on').textContent = feed.on ? t('Make a new link') : t('Make a private podcast link');
  const row = $('#ba-feed-row');
  if (path) {
    row.hidden = false;
    $('#ba-feed-url').value = `${location.origin}${path}`;
    say('#ba-feed-state', t('Copy it now: it is shown only once. Anyone with this link can listen, so keep it private.'));
  } else {
    row.hidden = true;
    $('#ba-feed-url').value = '';
    say('#ba-feed-state', feed.on ? t('A private podcast link is on. Make a new one to see it again (the old one stops working).') : t('No podcast link. Your briefings stay on this server.'));
  }
}

function paint(v) {
  $('#ba-audio').checked = Boolean(v.settings.audio);
  $('#ba-voice').value = v.settings.voice;
  const player = $('#ba-player');
  if (v.latest) {
    player.hidden = false;
    player.src = `/api/briefing/audio/${v.latest.id}`;
    say('#ba-status', t('Last recording: {day}. All recordings are in Library → Briefings.', { day: v.latest.day }));
  } else {
    player.hidden = true;
    player.removeAttribute('src');
    say('#ba-status', '');
  }
  if (v.settings.voice === 'local' && !v.localVoice) say('#ba-status', t('The voice on this computer isn’t installed. Install it in Settings → Voice, or pick your chosen voice.'), true);
  showFeed(v.feed);
}

export async function loadBriefingAudio() {
  if (!$('#ba-audio')) return;
  try {
    paint(await api('/briefing/audio'));
    const rv = await api('/review');
    $('#rv-life').checked = Boolean(rv.life);
  } catch {
    /* demo, or no briefing here: the section keeps its defaults */
  }
}

async function saveSettings() {
  try {
    paint(await api('/briefing/audio', { method: 'PUT', body: { audio: $('#ba-audio').checked, voice: $('#ba-voice').value } }));
  } catch (err) {
    say('#ba-status', err.message, true);
  }
}

/** Today: the play button for this morning's recording. */
export async function refreshTodayBriefing() {
  const b = $('#td-brief-play');
  if (!b) return;
  try {
    const v = await api('/briefing/audio');
    const ok = v.latest && v.latest.day === todayYmd();
    b.hidden = !ok;
    if (ok) b.dataset.id = String(v.latest.id);
  } catch {
    b.hidden = true;
  }
}

function toggleToday() {
  const b = $('#td-brief-play');
  const a = $('#td-brief-audio');
  if (!b || !a || !b.dataset.id) return;
  if (!a.paused) return void a.pause();
  const src = `/api/briefing/audio/${b.dataset.id}`;
  if (!a.src.endsWith(src)) a.src = src;
  void a.play().catch((err) => say('#td-status', err.message, true));
}

function paintTodayButton() {
  const b = $('#td-brief-play');
  const a = $('#td-brief-audio');
  if (!b || !a) return;
  const playing = !a.paused && !a.ended;
  b.setAttribute('aria-pressed', String(playing));
  b.querySelector('.td-btn-text').textContent = playing ? t('Pause') : t('Play briefing');
  const label = playing ? t('Pause') : t('Play this morning’s briefing');
  b.title = label;
  b.setAttribute('aria-label', label);
}

export function initBriefingAudio() {
  for (const id of ['#ba-audio', '#ba-voice']) $(id)?.addEventListener('change', () => void saveSettings());
  $('#ba-make')?.addEventListener('click', async () => {
    const b = $('#ba-make');
    b.disabled = true;
    say('#ba-status', t('Recording… (a minute or so with the voice on this computer)'));
    try {
      await api('/briefing/audio/make', { method: 'POST' });
      paint(await api('/briefing/audio'));
      void refreshTodayBriefing();
    } catch (err) {
      say('#ba-status', err.message, true);
    } finally {
      b.disabled = false;
    }
  });
  $('#ba-feed-on')?.addEventListener('click', async () => {
    try {
      const r = await api('/briefing/feed', { method: 'POST', body: { on: true } });
      showFeed({ on: true }, r.path);
    } catch (err) {
      say('#ba-feed-state', err.message, true);
    }
  });
  $('#ba-feed-off')?.addEventListener('click', async () => {
    try {
      await api('/briefing/feed', { method: 'POST', body: { on: false } });
      showFeed({ on: false });
    } catch (err) {
      say('#ba-feed-state', err.message, true);
    }
  });
  $('#ba-feed-copy')?.addEventListener('click', () => {
    const v = $('#ba-feed-url').value;
    if (v) void navigator.clipboard?.writeText(v).then(() => say('#ba-feed-state', t('Copied.')));
  });
  $('#rv-life')?.addEventListener('change', async () => {
    try {
      await api('/review', { method: 'PUT', body: { life: $('#rv-life').checked } });
      say('#rv-life-status', t('Saved.'));
    } catch (err) {
      say('#rv-life-status', err.message, true);
    }
  });
  $('#rv-life-now')?.addEventListener('click', async () => {
    const b = $('#rv-life-now');
    b.disabled = true;
    say('#rv-life-status', t('Writing your life review…'));
    try {
      await api('/review/life', { method: 'POST' });
      say('#rv-life-status', t('Sent. It is in your chat.'));
    } catch (err) {
      say('#rv-life-status', err.message, true);
    } finally {
      b.disabled = false;
    }
  });
  // Today: refresh the play button whenever Today opens.
  const today = $('#today');
  const a = $('#td-brief-audio');
  $('#td-brief-play')?.addEventListener('click', toggleToday);
  for (const ev of ['play', 'pause', 'ended']) a?.addEventListener(ev, paintTodayButton);
  if (today && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (today.open) void refreshTodayBriefing();
      else a?.pause();
    }).observe(today, { attributes: true, attributeFilter: ['open'] });
    if (today.open) void refreshTodayBriefing();
  }
}
