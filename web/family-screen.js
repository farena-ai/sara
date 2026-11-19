// W4.5 (docs/FAMILY_SCREEN.md): the Family screen page (/family-screen) for a tablet on the wall or
// in the kitchen. It pairs once with a one-time code from the owner's Settings and then sends only
// its own token, in the x-family-screen header, to /api/family-screen/* (never a sign-in cookie).
// Today's family calendar, chores with tap-to-done per person, dinners this week, the shared
// shopping list (tap to add, or say it), reminders due and a big kid-safe Talk button. Hearing goes
// to this server's own hearing (never the browser's cloud speech); her answer is read aloud by the
// tablet's own voice. It dims at night.
import { savedLang, serverText, setLanguage, t } from './naming.js';

const KEY = 'sara.familyScreen';
const HEADER = 'x-family-screen';
const POLL_MS = 60_000;
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const token = () => {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};
const setToken = (v) => {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
};

let board = null;
let talkWho = '';
let timer = 0;

async function call(path, o = {}) {
  const headers = { [HEADER]: token(), ...(o.body !== undefined && !(o.body instanceof Blob) ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(`/api/family-screen${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body === undefined ? undefined : o.body instanceof Blob ? o.body : JSON.stringify(o.body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/pair') {
    setToken('');
    paintPair(t('This screen was signed out. Pair it again with a new code.'));
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(serverText(data, t('Something went wrong. Try again.')));
  return data;
}

const timeOf = (iso) => {
  const m = /T(\d\d):(\d\d)/.exec(iso);
  if (!m) return '';
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  return d.toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' });
};
const dayName = (day, i) => (i === 0 ? t('Today') : i === 1 ? t('Tomorrow') : new Date(`${day}T12:00:00`).toLocaleDateString(document.documentElement.lang || undefined, { weekday: 'long' }));

// ------------------------------------------------------------ pairing
function paintPair(msg = '') {
  clearInterval(timer);
  document.documentElement.classList.remove('fs-dim');
  const app = $('#fs-app');
  app.replaceChildren();
  const card = el('form', 'fs-pair');
  card.append(el('h1', '', t('Family screen')), el('p', 'fs-muted', t('On your phone or computer, open Settings → Household → People on this server → Family screen and make a code. Type it here.')));
  const input = el('input', 'fs-code');
  input.id = 'fs-code';
  input.autocomplete = 'off';
  input.maxLength = 7;
  input.placeholder = 'ABC-DEF';
  input.setAttribute('aria-label', t('Pairing code'));
  const go = el('button', 'fs-big', t('Pair this screen'));
  go.type = 'submit';
  const status = el('p', 'fs-status', msg);
  status.setAttribute('role', 'status');
  card.append(input, go, status);
  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    status.textContent = t('Pairing…');
    try {
      const r = await call('/pair', { body: { code: input.value } });
      setToken(r.token);
      await refresh();
      timer = setInterval(() => void refresh().catch(() => {}), POLL_MS);
    } catch (err) {
      status.textContent = err.message;
      go.disabled = false;
    }
  });
  app.append(card);
  input.focus();
}

// ------------------------------------------------------------ the board
function section(id, title) {
  const s = el('section', `fs-card fs-${id}`);
  s.id = `fs-${id}`;
  s.append(el('h2', '', title));
  return s;
}
const empty = (text) => el('p', 'fs-muted fs-empty', text);

function paintHead() {
  const h = el('header', 'fs-head');
  const now = new Date();
  const clock = el('div', 'fs-clock', now.toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }));
  const date = el('div', 'fs-date', now.toLocaleDateString(document.documentElement.lang || undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
  const name = el('div', 'fs-name', board.screen.name);
  const left = el('div', 'fs-when');
  left.append(clock, date);
  const right = el('div', 'fs-head-right');
  right.append(name);
  const talk = paintTalk();
  if (talk) right.append(talk);
  h.append(left, right);
  return h;
}

function paintToday() {
  const s = section('today', t('Today'));
  const list = el('ul', 'fs-list');
  for (const e of board.today.events) {
    const li = el('li', 'fs-row');
    li.append(el('span', 'fs-time', e.allDay ? t('All day') : timeOf(e.start)), el('span', 'fs-what', e.title));
    list.append(li);
  }
  if (board.today.dinner.title) {
    const li = el('li', 'fs-row fs-dinner');
    li.append(el('span', 'fs-time', timeOf(`T${board.today.dinner.time}`)), el('span', 'fs-what', t('Dinner: {meal}', { meal: board.today.dinner.title })));
    list.append(li);
  }
  s.append(list.children.length ? list : empty(t('Nothing on the family calendar today.')));
  if (board.reminders.length) {
    s.append(el('h3', '', t('Soon')));
    const r = el('ul', 'fs-list');
    for (const x of board.reminders) {
      const li = el('li', `fs-row fs-rem fs-rem-${x.kind}`);
      li.append(el('span', 'fs-time', x.inMin <= 0 ? t('Now') : x.inMin < 60 ? t('in {n} min', { n: x.inMin }) : t('in {h} h {m} min', { h: Math.floor(x.inMin / 60), m: x.inMin % 60 })), el('span', 'fs-what', x.text));
      r.append(li);
    }
    s.append(r);
  }
  return s;
}

function paintChores() {
  const s = section('chores', t('Chores'));
  if (!board.chores.length) s.append(empty(t('No chores left today.')));
  for (const p of board.chores) {
    const box = el('div', 'fs-person');
    box.append(el('h3', '', p.name));
    for (const c of p.items) {
      const b = el('button', `fs-chore${c.done ? ' is-done' : ''}`);
      b.type = 'button';
      b.dataset.id = String(c.id);
      b.dataset.person = p.person;
      b.disabled = Boolean(c.done);
      b.append(el('span', 'fs-tick', c.done ? '✓' : ''), el('span', 'fs-what', c.title));
      if (c.points) b.append(el('span', 'fs-points', t('{n} pts', { n: c.points })));
      if (c.done === 'waiting') b.append(el('span', 'fs-wait', t('Waiting for a parent')));
      b.setAttribute('aria-label', c.done ? t('{chore}: done', { chore: c.title }) : t('Mark {chore} done for {name}', { chore: c.title, name: p.name }));
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await call(`/chores/${c.id}/done`, { body: { person: p.person } });
          board.chores = r.chores;
          paint();
        } catch (err) {
          b.disabled = false;
          flash(err.message);
        }
      });
      box.append(b);
    }
    s.append(box);
  }
  return s;
}

function paintMeals() {
  const s = section('meals', t('Dinners this week'));
  const list = el('ul', 'fs-list');
  board.meals.forEach((m, i) => {
    const li = el('li', `fs-row${m.title ? '' : ' fs-none'}`);
    li.append(el('span', 'fs-day', dayName(m.day, i)), el('span', 'fs-what', m.title ?? t('Not planned yet')));
    list.append(li);
  });
  s.append(list);
  return s;
}

function paintShopping() {
  const s = section('shopping', board.shopping?.name || t('Shopping list'));
  if (!board.shopping) {
    s.append(empty(t('Make a grocery list in Family first.')));
    return s;
  }
  const form = el('form', 'fs-add');
  const input = el('input');
  input.id = 'fs-add-item';
  input.maxLength = 120;
  input.placeholder = t('Add something…');
  input.setAttribute('aria-label', t('Add to the shopping list'));
  const add = el('button', 'fs-btn', t('Add'));
  add.type = 'submit';
  form.append(input, add);
  if (board.talk.voice) {
    const mic = el('button', 'fs-btn fs-mic', '🎤');
    mic.type = 'button';
    mic.setAttribute('aria-label', t('Say what to add'));
    mic.addEventListener('click', async () => {
      const said = await listen(mic);
      if (said) await addItem(said);
    });
    form.append(mic);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim()) await addItem(input.value);
  });
  s.append(form);
  const list = el('ul', 'fs-shop');
  for (const i of board.shopping.items) {
    const li = el('li');
    const b = el('button', `fs-item${i.done ? ' is-done' : ''}`);
    b.type = 'button';
    b.append(el('span', 'fs-tick', i.done ? '✓' : ''), el('span', 'fs-what', i.title));
    b.setAttribute('aria-pressed', String(i.done));
    b.addEventListener('click', async () => {
      try {
        const r = await call(`/shopping/${encodeURIComponent(i.ref)}`, { method: 'PATCH', body: { done: !i.done } });
        board.shopping = r.shopping;
        paint();
      } catch (err) {
        flash(err.message);
      }
    });
    li.append(b);
    list.append(li);
  }
  s.append(list.children.length ? list : empty(t('The list is empty.')));
  return s;
}

async function addItem(title) {
  try {
    const r = await call('/shopping', { body: { title } });
    board.shopping = r.shopping;
    paint();
    $('#fs-add-item')?.focus();
  } catch (err) {
    flash(err.message);
  }
}

function paintTalk() {
  if (!board.talk.on) return null;
  const b = el('button', 'fs-talk-btn');
  b.id = 'fs-talk-open';
  b.type = 'button';
  b.append(el('span', '', t('Talk')));
  b.addEventListener('click', openTalk);
  return b;
}

function openTalk() {
  const d = el('dialog', 'fs-talk');
  d.id = 'fs-talk';
  const head = el('div', 'fs-talk-head');
  head.append(el('h2', '', t('Talk with Sara')));
  const x = el('button', 'fs-btn fs-close', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', t('Close'));
  x.addEventListener('click', () => d.close());
  head.append(x);
  const who = el('div', 'fs-who');
  who.setAttribute('role', 'radiogroup');
  who.setAttribute('aria-label', t('Who is talking?'));
  for (const p of [{ id: '', name: t('Everyone') }, ...board.talk.kids]) {
    const b = el('button', `fs-chip${talkWho === p.id ? ' is-on' : ''}`, p.name);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(talkWho === p.id));
    b.addEventListener('click', () => {
      talkWho = p.id;
      for (const c of who.children) {
        c.classList.toggle('is-on', c === b);
        c.setAttribute('aria-checked', String(c === b));
      }
    });
    who.append(b);
  }
  const out = el('div', 'fs-reply');
  out.setAttribute('role', 'status');
  out.textContent = board.talk.resting ? t('Talk is resting for the night. See you in the morning!') : t('Ask anything: animals, homework hints, a joke, how to spell a word.');
  const form = el('form', 'fs-add');
  const input = el('input');
  input.id = 'fs-talk-text';
  input.maxLength = 500;
  input.placeholder = t('Type here…');
  input.setAttribute('aria-label', t('What do you want to say?'));
  const send = el('button', 'fs-btn', t('Send'));
  send.type = 'submit';
  form.append(input, send);
  const ask = async (text) => {
    if (!text.trim()) return;
    out.textContent = t('Thinking…');
    send.disabled = true;
    try {
      const r = await call('/talk', { body: { text, ...(talkWho ? { person: talkWho } : {}) } });
      out.textContent = r.reply;
      speak(r.reply);
      input.value = '';
    } catch (err) {
      out.textContent = err.message;
    } finally {
      send.disabled = false;
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void ask(input.value);
  });
  if (board.talk.voice) {
    const mic = el('button', 'fs-big fs-mic-big', t('🎤 Hold a moment and talk'));
    mic.type = 'button';
    mic.addEventListener('click', async () => {
      const said = await listen(mic);
      if (said) {
        input.value = said;
        await ask(said);
      }
    });
    d.append(head, who, mic, form, out);
  } else d.append(head, who, form, out);
  d.addEventListener('close', () => {
    speechSynthesis?.cancel?.();
    d.remove();
  });
  document.body.append(d);
  d.showModal();
  input.focus();
}

function speak(text) {
  try {
    if (!('speechSynthesis' in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = document.documentElement.lang || 'en';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {
    /* no voice on this tablet */
  }
}

// ------------------------------------------------------------ hearing (this server's own)
async function listen(btn) {
  const label = btn.textContent;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    flash(t('The microphone is not allowed on this tablet.'));
    return '';
  }
  btn.disabled = true;
  btn.textContent = t('Listening…');
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination);
  await new Promise((ok) => setTimeout(ok, 4000));
  proc.disconnect();
  src.disconnect();
  for (const tr of stream.getTracks()) tr.stop();
  const rate = ctx.sampleRate;
  await ctx.close();
  btn.textContent = t('One moment…');
  try {
    const r = await call('/hear', { body: wav(chunks, rate) });
    return r.text || '';
  } catch (err) {
    flash(err.message);
    return '';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 16 kHz mono 16-bit WAV from float chunks. */
function wav(chunks, rate) {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const step = rate / 16000;
  const n = Math.floor(all.length / step);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (at, s) => [...s].forEach((ch, i) => buf.setUint8(at + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  buf.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, 16000, true);
  buf.setUint32(28, 32000, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, 'data');
  buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, all[Math.floor(i * step)])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function flash(msg) {
  const f = $('#fs-flash') ?? el('p', 'fs-flash');
  f.id = 'fs-flash';
  f.setAttribute('role', 'alert');
  f.textContent = msg;
  document.body.append(f);
  setTimeout(() => f.remove(), 5000);
}

function paint() {
  if (!board) return;
  document.title = t('Family screen');
  document.documentElement.classList.toggle('fs-dim', board.dim);
  const app = $('#fs-app');
  const grid = el('div', 'fs-grid');
  grid.append(paintToday(), paintChores(), paintMeals(), paintShopping());
  app.replaceChildren(paintHead(), grid);
}

async function refresh() {
  board = await call('/board');
  if (!$('#fs-talk[open]')) paint();
}

void setLanguage(savedLang())
  .catch(() => {})
  .then(async () => {
    if (!token()) return paintPair();
    try {
      await refresh();
    } catch {
      return;
    }
    timer = setInterval(() => void refresh().catch(() => {}), POLL_MS);
  });
// A tap anywhere wakes a dimmed screen for a minute.
document.addEventListener('pointerdown', () => {
  if (!document.documentElement.classList.contains('fs-dim')) return;
  document.documentElement.classList.remove('fs-dim');
  setTimeout(() => board?.dim && document.documentElement.classList.add('fs-dim'), 60_000);
});
