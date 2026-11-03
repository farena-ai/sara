// Phase 72: Settings → Add-ons → Home Assistant → Presence (per companion, off by default). The
// pickers are filled from Home Assistant's own entities; every change saves at once (the server
// checks the whole set and says plainly what's missing).
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
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

/** Fills a select with entities (an empty choice first for single pickers), keeping the chosen ones. */
export function fillEntities(select, entities, chosen, empty) {
  const want = new Set((Array.isArray(chosen) ? chosen : [chosen]).filter(Boolean));
  const opts = [];
  if (empty) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = empty;
    opts.push(o);
  }
  const ids = new Set(entities.map((e) => e.id));
  // A chosen entity Home Assistant doesn't list right now stays chosen.
  for (const id of want) if (!ids.has(id)) entities = [...entities, { id, name: id, state: '' }];
  for (const e of entities) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id;
    o.dataset.raw = '';
    o.selected = want.has(e.id);
    opts.push(o);
  }
  select.replaceChildren(...opts);
}

const kindLabel = (k) => ({ arrive: t('got home'), leave: t('left home'), bedtime: t('bedtime'), morning: t('morning lights') })[k] ?? k;
const whyLabel = (w) => (w === 'rate limit' ? t('held back: too soon after the last one') : w === 'quiet hours' ? t('held back: quiet hours') : t('held back'));
let current;

function show(v) {
  current = v;
  $('#pr-off').hidden = v.connected;
  $('#pr-box').hidden = !v.connected;
  $('#pr-on').checked = v.enabled;
  $('#pr-arrive').checked = v.arrive;
  $('#pr-leave').checked = v.leave;
  $('#pr-bed-on').checked = v.bedtime.on;
  $('#pr-bed-time').value = v.bedtime.time ?? '';
  $('#pr-morning-on').checked = v.morning.on;
  $('#pr-morning-from').value = v.morning.from;
  $('#pr-morning-to').value = v.morning.to;
  $('#pr-how').value = v.how;
  $('#pr-gap').value = String(v.gapHours);
  const last = v.log?.[0];
  $('#pr-status').textContent = last ? t('Last: {kind}, {what} ({time}).', { kind: kindLabel(last.kind), what: last.fired ? t('she reacted') : whyLabel(last.why), time: new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : '';
}

async function fillPickers(v) {
  const list = async (domains) => (await api(`/home/entities?domains=${domains}`)).entities;
  try {
    const [people, bed, lights, players, tts] = await Promise.all([list('person,device_tracker'), list('input_boolean,switch,binary_sensor'), list('light,switch'), list('media_player'), list('tts')]);
    fillEntities($('#pr-people'), people, v.people);
    fillEntities($('#pr-bed-entity'), bed, v.bedtime.entity, t('No switch (only the time)'));
    fillEntities($('#pr-morning-light'), lights, v.morning.light, t('Choose a light…'));
    fillEntities($('#pr-player'), players, v.speaker?.player, t('Choose a speaker…'));
    fillEntities($('#pr-tts'), tts, v.speaker?.tts, t('Choose a voice…'));
  } catch (err) {
    $('#pr-status').textContent = err.message;
  }
}

export async function loadPresence() {
  try {
    const v = await api('/home/presence');
    show(v);
    if (v.connected) await fillPickers(v);
  } catch (err) {
    if (err.status !== 403) $('#pr-status').textContent = err.message;
  }
}

function collect() {
  const player = $('#pr-player').value;
  const tts = $('#pr-tts').value;
  return {
    enabled: $('#pr-on').checked,
    people: [...$('#pr-people').selectedOptions].map((o) => o.value),
    arrive: $('#pr-arrive').checked,
    leave: $('#pr-leave').checked,
    bedtime: { on: $('#pr-bed-on').checked, entity: $('#pr-bed-entity').value, time: $('#pr-bed-time').value },
    morning: { on: $('#pr-morning-on').checked, light: $('#pr-morning-light').value, from: $('#pr-morning-from').value || '05:00', to: $('#pr-morning-to').value || '11:00' },
    how: $('#pr-how').value,
    speaker: player && tts ? { player, tts } : null,
    gapHours: Number($('#pr-gap').value),
  };
}

async function save() {
  $('#pr-status').textContent = '';
  try {
    show(await api('/home/presence', { method: 'PUT', body: collect() }));
    $('#pr-status').textContent = t('Saved.');
  } catch (err) {
    $('#pr-status').textContent = err.message;
  }
}

export function initPresence() {
  for (const el of $('#pr-box').querySelectorAll('input, select')) el.addEventListener('change', () => void save());
  $('#pr-test').addEventListener('click', async () => {
    $('#pr-status').textContent = t('Trying…');
    try {
      const r = await api('/home/presence/test', { method: 'POST', body: { kind: current?.arrive === false && current?.morning?.on ? 'morning' : 'arrive' } });
      $('#pr-status').textContent = r.fired ? t('She said: {text}', { text: r.text ?? '' }) : t('It didn’t work: {why}', { why: r.why ?? '' });
    } catch (err) {
      $('#pr-status').textContent = err.message;
    }
  });
}
