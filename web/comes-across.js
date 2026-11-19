// W1.4 (docs/PERSONA_STYLE.md): Settings → Sara → Name and personality → How she comes across. One
// persona style (src/persona-style.ts) drives chat text, her voice, email drafts' sign-off, the website
// receptionist's greeting and her picture. A live preview shows one sentence in all four places.
// Saves on change (not the page saver). Also tells the page which face a device with no pick shows.
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
let wired = false;
let view = null;
let audio = null;
let timer = 0;

async function call(path, method = 'GET', body) {
  const r = await fetch(`/api/persona/style${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(serverText(d, String(r.status)));
  return d;
}

const ENGINE = () => ({ local: t('this computer'), openai: 'OpenAI', elevenlabs: 'ElevenLabs', xai: 'Grok', off: t('off') });

/** A device with no picture of its own shows the persona's face (web/app.js setFace reads it). */
export function applyHerFace(face) {
  const root = document.documentElement;
  if (face) root.dataset.herFace = face;
  else delete root.dataset.herFace;
  globalThis.dispatchEvent?.(new Event('sara-herface'));
}

/** On start: fetch the style once so her picture follows it on every device. */
export async function initComesAcross() {
  try {
    view = await call('');
    applyHerFace(view.style.face);
  } catch {
    /* members without the route, offline: the device default stays */
  }
}

function sentence() {
  return $('#hca-sentence')?.value.trim() || t('The plumber comes tomorrow at 10, so I moved your call to 11.');
}

async function preview() {
  const box = $('#hca-box');
  if (!box) return;
  try {
    const p = await call('/preview', 'POST', { sentence: sentence() });
    $('#hca-chat').textContent = p.chat;
    $('#hca-email').textContent = p.email;
    const g = p.greeting;
    const name = g.params.name === 'this business' ? t('this business') : g.params.name;
    $('#hca-greeting').textContent = `${t(g.key, { name })} ${g.then}`;
    const v = p.spoken.voice;
    $('#hca-voice').textContent = v.tts === 'off' ? t('Her voice is off.') : t('{voice} on {engine}, {speed}× speed', { voice: v.id || t('default voice'), engine: ENGINE()[v.tts] ?? v.tts, speed: v.speed });
    $('#hca-say').disabled = v.tts === 'off';
  } catch (e) {
    $('#hca-status').textContent = e.message;
  }
}

async function save(patch) {
  const st = $('#hca-status');
  try {
    view = await call('', 'PUT', patch);
    applyHerFace(view.style.face);
    st.textContent = t('Saved. Chat, voice, email drafts and the receptionist all use it now.');
    void preview();
  } catch (e) {
    st.textContent = e.message;
  }
}

async function say() {
  const st = $('#hca-status');
  try {
    audio?.pause();
    const r = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: sentence() }) });
    if (!r.ok) throw new Error(serverText(await r.json().catch(() => ({})), String(r.status)));
    audio = new Audio(URL.createObjectURL(await r.blob()));
    await audio.play();
  } catch (e) {
    st.textContent = e.message;
  }
}

function wire() {
  if (wired) return;
  wired = true;
  $('#hca-sentence').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void preview(), 300);
  });
  $('#hca-signoff').addEventListener('change', (e) => void save({ signOff: e.target.value }));
  for (const [id, key] of [['#hca-greet', 'greet'], ['#hca-face', 'face'], ['#hca-human', 'humanizer']]) $(id).addEventListener('change', (e) => void save({ [key]: e.target.value }));
  $('#hca-say').addEventListener('click', () => void say());
  $('#hca-open-voice').addEventListener('click', () => globalThis.openSettingsPage?.('her-voice'));
}

/** Settings → her-character: fill the section and its preview. */
export async function loadComesAcross() {
  if (!$('#hca-box')) return;
  wire();
  try {
    view = await call('');
  } catch (e) {
    $('#hca-status').textContent = e.message;
    return;
  }
  const s = view.style;
  $('#hca-signoff').value = s.signOff;
  $('#hca-greet').value = s.greet;
  $('#hca-face').value = s.face;
  $('#hca-human').value = s.humanizer;
  $('#hca-sentence').placeholder = t('The plumber comes tomorrow at 10, so I moved your call to 11.');
  $('#hca-voice-where').textContent = view.talk ? t('How she talks: {talk}.', { talk: t(view.talk) }) : '';
  $('#hca-status').textContent = '';
  applyHerFace(s.face);
  void preview();
}
