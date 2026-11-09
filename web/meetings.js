// EC19 (docs/MEETINGS.md): Library → Meetings. Two ways in: a listening room (he starts it with the
// consent tick; every device shows and speaks the notice, and its microphone opens only after
// "I understand"), or a recorded voice file (the same tick). The room reuses the R2 hands-free call
// (web/voice.js): each utterance goes to the server as a WAV, which hears it, adds a line and, when
// she was called by name, answers in a sentence or two that this device speaks. The transcript is
// polled every 2 s. At the end the notes (summary, decisions, action items) show here and are kept in
// the Library; an action item becomes a to-do only when he presses Add to Planner.
import { Call, Mic, Speaker } from './voice.js';
import { serverText, t } from './naming.js';
import { closeResearch } from './research.js';

const $ = (s) => document.querySelector(s);
const POLL_MS = 2000;
let meetingId = null;
let timer = null;
let lastLine = 0;
let room = null;
let notesShown = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const raw = opts.raw !== undefined;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: raw ? { 'content-type': 'application/octet-stream' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
/** A labelled control with its ? tip (checkboxes: the box before the words). */
function field(label, input, help) {
  const id = `ms-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const l = el('label', 'ms-label', label);
  l.htmlFor = id;
  const row = el('div', input.type === 'checkbox' ? 'ms-field ms-check' : 'ms-field');
  if (input.type === 'checkbox') row.append(input, l, tip(help));
  else {
    row.append(el('div', 'ms-label-row'), input);
    row.firstChild.append(l, tip(help));
  }
  return row;
}
const input = (type) => {
  const i = document.createElement('input');
  i.type = type;
  return i;
};
const STATUS_WORDS = {
  live: () => t('Listening and taking notes.'),
  hearing: () => t('Hearing the recording…'),
  ended: () => t('Ended. The notes are not written yet.'),
  writing: () => t('Writing the notes…'),
  done: () => t('The notes are ready and kept in her Library.'),
  failed: () => t('Something went wrong.'),
};

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}
function leaveRoom() {
  room?.call.stop();
  room?.speaker.stop();
  room = null;
}

/** Opens Meetings inside the Library window. */
export async function openMeetings() {
  closeResearch();
  $('#lib-home').hidden = true;
  $('#lib-doc').hidden = true;
  $('#lib-meetings').hidden = false;
  meetingId = null;
  await render();
}
export function closeMeetings() {
  stopPolling();
  leaveRoom();
  if ($('#lib-meetings')) $('#lib-meetings').hidden = true;
}

async function render() {
  stopPolling();
  const host = $('#lib-m-body');
  if (!host || $('#lib-meetings').hidden) return;
  try {
    if (meetingId == null) {
      const r = await api('/meetings');
      host.replaceChildren(roomForm(r), fileForm(r), past(r.meetings));
      return;
    }
    const { meeting } = await api(`/meetings/${meetingId}`);
    lastLine = 0;
    notesShown = '';
    host.replaceChildren(meetingView(meeting));
    poll();
  } catch (e) {
    host.replaceChildren(el('p', 'small error', e.status === 403 ? t('Only the owner of this server can turn this on.') : e.message));
  }
}

function problem(box, r) {
  if (!r.ready) box.append(el('p', 'small error', serverText({ error: r.why }, r.why ?? '')));
}

function roomForm(r) {
  const box = el('div', 'ms-card');
  box.append(el('h3', '', t('Start a meeting room')));
  const title = input('text');
  title.maxLength = 120;
  title.placeholder = t('For example: Saturday garden party');
  const keep = input('checkbox');
  const ok = input('checkbox');
  box.append(
    field(t('Meeting name'), title, t('The name of the notes in her Library.')),
    field(t('Keep the recording'), keep, t('Off: what she hears is turned into text and the sound is dropped. On: the sound is kept with the meeting until you delete it.')),
    field(t('Everyone in the room knows Sara will listen and take notes'), ok, t('Required. Tell everyone first. She also says it out loud and shows it on every device that joins.')),
  );
  problem(box, r);
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const go = btn(t('Start the room'), '', async () => {
    go.disabled = true;
    try {
      const { meeting } = await api('/meetings', { method: 'POST', body: { title: title.value, keepAudio: keep.checked, consent: ok.checked } });
      meetingId = meeting.id;
      await render();
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
      go.disabled = false;
    }
  });
  go.disabled = !r.ready;
  const acts = el('div', 'actions-left');
  acts.append(go);
  box.append(acts, status);
  return box;
}

function fileForm(r) {
  const box = el('div', 'ms-card');
  box.append(el('h3', '', t('Notes from a recording')));
  const file = input('file');
  file.accept = '.wav,.mp3,.ogg,.opus,.m4a,.webm,audio/*';
  const title = input('text');
  title.maxLength = 120;
  const keep = input('checkbox');
  const ok = input('checkbox');
  box.append(
    field(t('Recording'), file, t('A recorded call or meeting (for example a Discord call). WAV up to 100 MB and 3 hours; MP3, OGG or M4A up to 25 MB.')),
    field(t('Meeting name'), title, t('The name of the notes in her Library. Empty: the file name.')),
    field(t('Keep the recording'), keep, t('Off: the file is dropped once she has heard it. On: it is kept with the meeting until you delete it.')),
    field(t('Everyone in this recording knew it was recorded and agreed to notes'), ok, t('Required. Only give her recordings of people who agreed.')),
  );
  problem(box, r);
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const go = btn(t('Write notes from it'), '', async () => {
    const f = file.files?.[0];
    if (!f) {
      status.textContent = t('Pick a recording first.');
      return;
    }
    go.disabled = true;
    status.textContent = t('Sending…');
    try {
      const q = new URLSearchParams({ title: title.value || f.name.replace(/\.[^.]+$/, ''), name: f.name, ...(ok.checked ? { consent: '1' } : {}), ...(keep.checked ? { keep: '1' } : {}) });
      const { meeting } = await api(`/meetings/file?${q}`, { method: 'POST', raw: f });
      meetingId = meeting.id;
      await render();
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
      go.disabled = false;
    }
  });
  go.disabled = !r.ready;
  const acts = el('div', 'actions-left');
  acts.append(go);
  box.append(acts, status);
  return box;
}

function past(list) {
  const box = el('div', 'ms-past');
  if (!list.length) return box;
  box.append(el('h3', '', t('Earlier meetings')));
  for (const m of list) {
    const b = btn('', 'ms-past-item', () => {
      meetingId = m.id;
      void render();
    });
    b.append(el('span', 'ms-past-title', m.title), el('span', 'muted small', `${new Date(m.createdAt).toLocaleString()} · ${STATUS_WORDS[m.status]?.() ?? m.status}`));
    box.append(b);
  }
  return box;
}

function lineRow(l) {
  const li = el('li', l.kind === 'notice' ? 'ms-line ms-notice-line' : l.kind === 'sara' ? 'ms-line ms-sara' : 'ms-line');
  li.append(el('span', 'ms-who', l.speaker), el('span', 'ms-said', l.text));
  return li;
}

function meetingView(m) {
  const box = el('div', 'ms-meeting');
  box.dataset.id = String(m.id);
  const back = btn(t('← All meetings'), 'ghost small', () => {
    leaveRoom();
    meetingId = null;
    void render();
  });
  const head = el('div', 'ms-head');
  head.append(el('h3', 'ms-title', m.title), el('span', 'ai-badge', t('AI companion')));
  const notice = el('p', 'ms-notice', m.announce);
  notice.setAttribute('role', 'note');
  const status = el('p', 'small ms-status', STATUS_WORDS[m.status]?.() ?? m.status);
  status.setAttribute('role', 'status');
  const lines = el('ol', 'ms-lines');
  lines.setAttribute('aria-live', 'polite');
  const controls = el('div', 'actions-left ms-controls');
  const notes = el('div', 'ms-notes');
  box.append(back, head, notice, status, controls, lines, notes);
  return box;
}

function joinButtons(m, controls, status) {
  if (room || m.status !== 'live') return;
  const go = btn(t('I understand, start my microphone'), '', async () => {
    go.disabled = true;
    try {
      const device = /Mobi/i.test(navigator.userAgent) ? t('Phone') : t('Computer');
      await api(`/meetings/${m.id}/join`, { method: 'POST', body: { device } });
      const speaker = new Speaker(async (text) => {
        const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        return res.ok ? res.blob() : null;
      });
      const call = new Call({
        mic: new Mic(),
        speaker,
        // The server hears it; '' tells the call nothing more is to be done here.
        transcribe: async (wav) => {
          const r = await api(`/meetings/${m.id}/audio?speaker=${encodeURIComponent(device)}`, { method: 'POST', raw: wav }).catch(() => ({}));
          if (r.reply && room) room.speaker.say(r.reply.text);
          void poll();
          return '';
        },
        onUtterance: async () => {},
        onStatus: (s) => {
          status.textContent = s === 'hearing' ? t('Hearing…') : s === 'thinking' ? t('Writing it down…') : STATUS_WORDS.live();
        },
      });
      room = { id: m.id, call, speaker };
      await call.start();
      speaker.say(m.announce);
      controls.replaceChildren(endButton(m));
    } catch (e) {
      leaveRoom();
      status.textContent = e.message || t('The microphone could not start.');
      go.disabled = false;
    }
  });
  controls.replaceChildren(go, endButton(m));
}

function endButton(m) {
  return btn(t('End and write the notes'), 'ghost', async () => {
    leaveRoom();
    await api(`/meetings/${m.id}/end`, { method: 'POST', body: {} }).catch(() => {});
    void poll();
  });
}

function notesView(m, host) {
  const n = m.notes;
  const out = [];
  if (n) {
    out.push(el('h4', '', t('Summary')), el('p', 'ms-summary', n.summary || t('None')));
    out.push(el('h4', '', t('Decisions')));
    const dl = el('ul', 'ms-list');
    for (const d of n.decisions.length ? n.decisions : [t('None')]) dl.append(el('li', '', d));
    out.push(dl, el('h4', '', t('Action items')));
    const al = el('ul', 'ms-list ms-actions');
    const open = [];
    n.actions.forEach((a, i) => {
      const li = el('li', 'ms-action');
      li.append(el('span', 'ms-task', a.task), el('span', 'muted small', [a.owner || t('Not said'), a.dueAt ? new Date(a.dueAt).toLocaleDateString() : a.due].filter(Boolean).join(' · ')));
      if (a.taskId) li.append(el('span', 'small ms-added', t('In the Planner')));
      else {
        open.push(i);
        li.append(btn(t('Add to Planner'), 'ghost small', () => void addTodos(m.id, [i], host)));
      }
      al.append(li);
    });
    if (!n.actions.length) al.append(el('li', '', t('None')));
    out.push(al);
    if (open.length > 1) {
      const all = el('div', 'actions-left');
      all.append(btn(t('Add all to Planner'), 'ghost small', () => void addTodos(m.id, open, host)));
      out.push(all);
    }
    out.push(el('p', 'small muted', t('Nothing goes to the Planner until you add it.')));
  }
  if (m.error) out.push(el('p', 'small error', serverText({ error: m.error }, m.error)));
  const acts = el('div', 'actions-left');
  if (m.status === 'done' || m.status === 'failed' || m.status === 'ended') acts.append(btn(m.notes ? t('Write the notes again') : t('Write the notes'), 'ghost small', async () => {
    await api(`/meetings/${m.id}/notes`, { method: 'POST', body: {} }).catch(() => {});
    void poll();
  }));
  if (m.keepAudio) {
    const a = el('a', 'button ghost small', t('Download the recording'));
    a.href = `/api/meetings/${m.id}/recording`;
    a.download = '';
    acts.append(a);
  }
  acts.append(btn(t('Delete this meeting'), 'ghost small danger', async () => {
    if (!confirm(t('Delete this meeting, its transcript and its recording? The notes in the Library stay.'))) return;
    try {
      await api(`/meetings/${m.id}`, { method: 'DELETE' });
      meetingId = null;
      void render();
    } catch (e) {
      host.append(el('p', 'small error', e.message));
    }
  }));
  out.push(acts);
  host.replaceChildren(...out);
}

async function addTodos(id, items, host) {
  try {
    await api(`/meetings/${id}/todos`, { method: 'POST', body: { items } });
    void poll();
  } catch (e) {
    host.append(el('p', 'small error', e.message));
  }
}

async function poll() {
  stopPolling();
  const box = document.querySelector(`.ms-meeting[data-id="${meetingId}"]`);
  if (!box || meetingId == null) return;
  try {
    const { meeting: m } = await api(`/meetings/${meetingId}?since=${lastLine}`);
    const lines = box.querySelector('.ms-lines');
    for (const l of m.lines) {
      lines.append(lineRow(l));
      lastLine = Math.max(lastLine, l.n);
    }
    const status = box.querySelector('.ms-status');
    if (!room || m.status !== 'live') status.textContent = STATUS_WORDS[m.status]?.() ?? m.status;
    if (m.status === 'live') joinButtons(m, box.querySelector('.ms-controls'), status);
    else {
      leaveRoom();
      box.querySelector('.ms-controls').replaceChildren();
      const key = JSON.stringify([m.status, m.notes, m.error]);
      if (key !== notesShown) {
        notesShown = key;
        notesView(m, box.querySelector('.ms-notes'));
      }
    }
    if (m.status === 'live' || m.status === 'hearing' || m.status === 'writing') timer = setTimeout(() => void poll(), POLL_MS);
  } catch (e) {
    box.querySelector('.ms-status').textContent = e.message;
    timer = setTimeout(() => void poll(), POLL_MS * 2);
  }
}
