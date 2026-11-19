// W4.3 (docs/LANGUAGE_PRACTICE.md): Library → Learn a language. Pick the language and level; each
// day a short session: spaced-repetition cards (the U4.23 study engine, same review route), three
// sentences to listen to (her local voice for that language) and three to say back (local hearing,
// words as you speak when the W0.3 multilingual model is here; scored word by word with one gentle
// tip). Practice talking opens Talk with Sara in the practice chat, heard and spoken in the language.
// Local voices and hearing only: never the cloud-capable hearing route or a cloud voice.
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
let data = null;
let step = { kind: 'start', i: 0, shown: false, result: null };
let call = null;
let audio = null;

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
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if ((res.headers.get('content-type') ?? '').startsWith('audio/')) return res.ok ? res.blob() : null;
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(out, t('Something went wrong.')));
  return out;
}
const status = (msg) => {
  const s = $('#ll-status');
  if (s) s.textContent = msg ?? '';
};
const uiLang = () => document.documentElement.lang || 'en';
export function langName(code) {
  try {
    return new Intl.DisplayNames([uiLang()], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Opens the page inside the Library window. */
export async function openLangLearn() {
  const lib = $('#library');
  if (lib && !lib.open) lib.showModal();
  for (const n of document.querySelectorAll('#library section[id^="lib-"]')) n.hidden = n.id !== 'lib-lang';
  step = { kind: 'start', i: 0, shown: false, result: null };
  await load();
}

async function load(body) {
  try {
    data = body ? await api('/study/lang', { method: 'PUT', body }) : await api('/study/lang');
    status('');
  } catch (err) {
    status(err.message);
    return;
  }
  fill();
  render();
  if (data.local.voice || data.local.hearing) void api('/study/lang/warm', { body: {} }).catch(() => {});
}

function fill() {
  const sel = $('#ll-lang');
  if (sel) {
    sel.replaceChildren(
      ...(data.prefs.lang ? [] : [Object.assign(el('option', '', t('Pick one…')), { value: '' })]),
      ...data.langs.map((l) => Object.assign(el('option', '', langName(l)), { value: l })),
    );
    sel.value = data.prefs.lang ?? '';
  }
  if ($('#ll-level')) $('#ll-level').value = data.prefs.level;
  if ($('#ll-daily')) $('#ll-daily').value = String(data.prefs.daily);
}

function stopMic() {
  call?.stop();
  call = null;
}
function stopAudio() {
  if (audio) {
    audio.pause();
    audio = null;
  }
}
async function play(text, slow = false) {
  stopAudio();
  stopMic();
  try {
    const blob = await api('/study/lang/say', { body: { text, slow } });
    if (!blob) return void status(t('No voice for this language on this computer yet. Add one in Settings → Voice.'));
    audio = new Audio(URL.createObjectURL(blob));
    await audio.play();
  } catch (err) {
    status(err.message);
  }
}

async function postStream(id, bytes, end, lang) {
  const res = await fetch(`/api/voice/stream?id=${encodeURIComponent(id)}${end ? '&end=1' : ''}&lang=${encodeURIComponent(lang)}`, { method: 'POST', headers: { 'content-type': 'audio/L16' }, body: bytes });
  if (!res.ok) throw new Error(`stream ${res.status}`);
  return res.json();
}
async function hear(wav) {
  const res = await fetch(`/api/study/lang/hear?lang=${encodeURIComponent(data.prefs.lang)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(out, `HTTP ${res.status}`));
  return out.text ?? '';
}

/** Say it: the microphone hears one sentence (live words when available), then it is scored. */
async function listen(p) {
  stopAudio();
  stopMic();
  const live = $('#ll-live');
  const v = await import('./voice.js');
  const mic = new v.Mic();
  let gate = null;
  const lang = data.prefs.lang;
  call = new v.Call({
    mic,
    speaker: { speaking: false, stop() {} },
    transcribe: (wav) => hear(wav),
    isSpeech: (f) => (gate ??= new v.SpeechGate(mic.ctx?.sampleRate ?? 48000)).push(f),
    stream: data.local.live ? () => new v.StreamHearing((id, b, e) => postStream(id, b, e, lang), mic.ctx?.sampleRate ?? 48000) : undefined,
    onPartial: (words) => {
      if (live) live.textContent = `“${words}…”`;
    },
    onUtterance: async (text) => {
      stopMic();
      await score(p, text);
    },
    onStatus: (s) => {
      if (s === 'hearing') status(t('Hearing you…'));
      else if (s === 'thinking') status(t('Checking…'));
    },
  });
  try {
    await call.start();
    status(t('Listening… say the sentence.'));
    const say = $('#ll-say');
    if (say) say.textContent = t('Stop');
  } catch (err) {
    stopMic();
    status(err?.name === 'NotAllowedError' ? t('Microphone: permission denied.') : t('Microphone: {message}', { message: err?.message ?? '' }));
  }
}

async function score(p, said) {
  try {
    const r = await api('/study/lang/score', { body: { id: p.id, said } });
    step.result = r.result;
    data.progress = r.progress;
    status('');
  } catch (err) {
    status(err.message);
  }
  render();
}

async function review(card, grade) {
  try {
    await api(`/study/cards/${card.id}/review`, { body: { grade } });
  } catch (err) {
    return void status(err.message);
  }
  next();
}

const ORDER = ['cards', 'listen', 'speak', 'done'];
function next() {
  stopAudio();
  stopMic();
  const list = { cards: data.session.cards, listen: data.session.listen, speak: data.session.speak };
  let { kind, i } = step;
  i += 1;
  while (kind !== 'done' && (kind === 'start' || i >= (list[kind]?.length ?? 0))) {
    kind = ORDER[Math.max(0, ORDER.indexOf(kind) + 1)];
    i = 0;
    if (kind === 'done' || list[kind]?.length) break;
  }
  step = { kind, i, shown: false, result: null };
  if (kind === 'done') void load();
  else render();
}

function sentence(text) {
  const s = el('p', 'll-sentence', text);
  s.lang = data.prefs.lang;
  return s;
}

function renderProgress() {
  const box = $('#ll-progress');
  if (!box) return;
  box.replaceChildren();
  if (!data.prefs.lang) return;
  const p = data.progress;
  const chip = (text, cls = '') => el('span', `ll-chip ${cls}`.trim(), text);
  box.append(
    chip(t('{n}-day streak', { n: p.streak }), p.streak ? 'll-hot' : ''),
    chip(t('{n} words known', { n: p.wordsKnown })),
    chip(t('{n} of {m} cards learned', { n: p.cardsLearned, m: p.cards })),
    chip(t('{n} said today', { n: p.saidToday })),
  );
  const loc = data.local;
  const talk = btn(t('Practice talking'), 'small', () => void practiceTalk());
  talk.disabled = !(loc.voice && loc.hearing);
  talk.title = talk.disabled ? t('Talk practice needs a voice and hearing for this language on this computer.') : t('Talk with her in {lang} at your level.', { lang: langName(data.prefs.lang) });
  box.append(talk);
  if (!loc.voice || !loc.hearing) {
    const n = el('p', 'muted small ll-local');
    n.append(loc.voice ? t('No hearing for this language on this computer yet: cards and listening still work.') : loc.hearing ? t('No voice for this language on this computer yet: you can still read the sentences.') : t('No voice or hearing for this language on this computer yet: cards still work.'), ' ');
    const a = el('a', '', t('Set up voice'));
    a.href = '#view=settings:her-voice';
    n.append(a);
    box.append(n);
  }
}

function render() {
  renderProgress();
  const body = $('#ll-body');
  if (!body || !data) return;
  body.replaceChildren();
  if (!data.prefs.lang) return void body.append(el('p', 'muted', t('Pick the language you are learning to start.')));
  const s = data.session;
  const card = el('div', 'll-card');
  body.append(card);
  if (step.kind === 'start') {
    card.append(el('h3', '', t("Today's practice")));
    const ol = el('ol', 'll-plan');
    if (s.cards.length) ol.append(el('li', '', t('{n} cards', { n: s.cards.length })));
    ol.append(el('li', '', t('Listen to {n} sentences', { n: s.listen.length })), el('li', '', t('Say {n} sentences back', { n: s.speak.length })));
    card.append(ol, btn(t("Start today's practice"), '', () => next()));
    return;
  }
  if (step.kind === 'done') {
    card.append(el('h3', '', t('Done for today. See you tomorrow!')), btn(t('Practice again'), 'ghost', () => ((step = { kind: 'start', i: 0, shown: false, result: null }), render())));
    return;
  }
  const row = el('div', 'll-actions');
  if (step.kind === 'cards') {
    const c = s.cards[step.i];
    card.append(el('p', 'muted small', t('Card {i} of {n}', { i: step.i + 1, n: s.cards.length })), sentence(c.front));
    if (data.local.voice) row.append(btn(t('Hear it'), 'ghost small', () => void play(c.front)));
    if (!step.shown) row.append(btn(t('Show meaning'), 'small', () => ((step.shown = true), render())));
    else {
      card.append(el('p', 'll-meaning', c.back));
      for (const [g, label] of [[1, t('Again')], [3, t('Hard')], [4, t('Good')], [5, t('Easy')]]) row.append(btn(label, g === 4 ? 'small' : 'ghost small', () => void review(c, g)));
    }
  } else if (step.kind === 'listen') {
    const p = s.listen[step.i];
    card.append(el('p', 'muted small', t('Listen {i} of {n}', { i: step.i + 1, n: s.listen.length })));
    if (data.local.voice) {
      row.append(btn(t('Play'), 'small', () => void play(p.text)), btn(t('Slower'), 'ghost small', () => void play(p.text, true)));
      if (!step.shown) row.append(btn(t('Show the words'), 'ghost small', () => ((step.shown = true), render())));
    }
    if (step.shown || !data.local.voice) card.append(sentence(p.text), el('p', 'll-meaning', p.meaning));
    row.append(btn(t('Next'), 'ghost small', () => next()));
  } else if (step.kind === 'speak') {
    const p = s.speak[step.i];
    card.append(el('p', 'muted small', t('Say it back {i} of {n}', { i: step.i + 1, n: s.speak.length })), sentence(p.text), el('p', 'll-meaning', p.meaning));
    if (data.local.voice) row.append(btn(t('Hear it'), 'ghost small', () => void play(p.text)));
    const say = btn(call ? t('Stop') : step.result ? t('Try again') : t('Say it'), 'small', () => (call ? (stopMic(), status(''), render()) : void listen(p)));
    say.id = 'll-say';
    say.disabled = !data.local.hearing;
    row.append(say);
    const live = el('p', 'll-live muted small');
    live.id = 'll-live';
    live.lang = data.prefs.lang;
    card.append(live);
    if (step.result) {
      const words = el('p', 'll-words');
      words.lang = data.prefs.lang;
      for (const w of step.result.words) {
        const span = el('span', `ll-w ll-${w.mark}`, w.w);
        span.title = w.mark === 'ok' ? t('Right') : w.mark === 'close' ? t('Close: heard “{w}”', { w: w.heard ?? '' }) : t('Not heard');
        words.append(span, ' ');
      }
      card.append(words, el('p', 'll-tip', t(step.result.feedback, step.result.params)));
      if (step.result.heard) card.append(el('p', 'muted small', t('She heard: “{text}”', { text: step.result.heard })));
    }
    row.append(btn(t('Next'), 'ghost small', () => next()));
    if (!data.local.hearing) card.append(el('p', 'muted small', t('Hearing in this language is not installed on this computer yet. Add it in Settings → Voice.')));
  }
  card.append(row);
}

async function practiceTalk() {
  stopAudio();
  stopMic();
  try {
    const r = await api('/study/lang/talk', { body: {} });
    $('#library')?.close();
    location.hash = `#c=${r.conversationId}`;
    await new Promise((ok) => setTimeout(ok, 1200));
    const { startTalk } = await import('./talk.js');
    await startTalk({ learn: data.prefs.lang });
  } catch (err) {
    status(err.message);
  }
}

export function initLangLearn() {
  $('#lib-lang-open')?.addEventListener('click', () => void openLangLearn());
  $('#lib-l-back')?.addEventListener('click', () => {
    stopAudio();
    stopMic();
    $('#lib-lang').hidden = true;
    $('#lib-home').hidden = false;
  });
  const save = () => {
    step = { kind: 'start', i: 0, shown: false, result: null };
    const lang = $('#ll-lang').value;
    void load({ ...(lang ? { lang } : {}), level: $('#ll-level').value, daily: Number($('#ll-daily').value) });
  };
  for (const id of ['#ll-lang', '#ll-level', '#ll-daily']) $(id)?.addEventListener('change', save);
  $('#library')?.addEventListener('close', () => {
    stopAudio();
    stopMic();
  });
}
