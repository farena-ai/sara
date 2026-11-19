// EC19 (docs/MEETINGS.md): Library → Meetings. Two ways in: a listening room (he starts it with the
// consent tick; every device shows and speaks the notice, and its microphone opens only after
// "I understand"), or a recorded voice file (the same tick). The room reuses the R2 hands-free call
// (web/voice.js): each utterance goes to the server as a WAV, which hears it, adds a line and, when
// she was called by name, answers in a sentence or two that this device speaks. The transcript is
// polled every 2 s. At the end the notes (summary, decisions, action items) show here and are kept in
// the Library; an action item becomes a to-do only when he presses Add to Planner.
// S2 (meeting assistant): a third way in, Record this computer (the Windows app records the
// microphone and the computer's sound through SaraDesktop, after the consent notice); every
// recording is turned into WAV parts here (decodeAudioData for MP3/M4A/MP4/WebM) and sent part by
// part; the meeting view adds who-said-what with times, transcript search, playback from a line,
// speaker rename, open questions, the calendar event and follow-up emails that wait for Send.
import { Call, Mic, Speaker } from './voice.js';
import { serverText, t } from './naming.js';
import { closeResearch } from './research.js';
import { closeCaptions, fillLangs, openCaptions } from './captions.js';

const $ = (s) => document.querySelector(s);
const POLL_MS = 2000;
let meetingId = null;
let timer = null;
let lastLine = 0;
let room = null;
let notesShown = '';
let prefs = { remind: true, cloud: false, speakers: true };
const PART_SEC = 600;
const REC_KEY = 'sara.meetingRec';

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
  const i = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') i.type = type;
  return i;
};
const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
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
  closeCaptions();
  leaveRoom();
  if ($('#lib-meetings')) $('#lib-meetings').hidden = true;
}

async function render() {
  stopPolling();
  closeCaptions();
  const host = $('#lib-m-body');
  if (!host || $('#lib-meetings').hidden) return;
  try {
    if (meetingId == null) {
      const r = await api('/meetings');
      if (r.prefs) prefs = r.prefs;
      host.replaceChildren(...(desktopRecorder() ? [desktopForm(r)] : []), roomForm(r), fileForm(r), past(r.meetings));
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
  file.accept = '.wav,.mp3,.ogg,.opus,.m4a,.mp4,.webm,audio/*,video/mp4';
  const title = input('text');
  title.maxLength = 120;
  const keep = input('checkbox');
  const ok = input('checkbox');
  box.append(
    field(t('Recording'), file, t('A recorded call or meeting: WAV, MP3, M4A, MP4, WebM or OGG, up to 3 hours. Long files are sent in parts.')),
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
      meetingId = await sendRecording(f, { title: title.value || f.name.replace(/\.[^.]+$/, ''), consent: ok.checked, keepAudio: keep.checked, channels: 'mixed' }, (msg) => (status.textContent = msg));
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
  li.dataset.speaker = l.kind === 'said' ? l.speaker : '';
  li.dataset.n = String(l.n);
  const when = typeof l.t === 'number' && l.kind !== 'notice' ? btn(clock(l.t), 'ms-time ghost small', () => playFrom(l.t)) : el('span', 'ms-time muted small', '');
  if (typeof l.t === 'number' && l.kind !== 'notice') when.setAttribute('aria-label', t('Play from {time}', { time: clock(l.t) }));
  li.append(when, el('span', 'ms-who', l.speaker), el('span', 'ms-said', l.text));
  return li;
}
/** S2: a line's time plays the kept recording from there. */
function playFrom(sec) {
  const a = document.querySelector('.ms-meeting .ms-audio');
  if (!a) return;
  a.currentTime = Math.max(0, sec - 0.5);
  void a.play().catch(() => {});
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
  // V4.4: big live captions with an optional translated line (web/captions.js).
  const caps = btn(t('Captions'), 'ghost small ms-cap-open', () => {
    stopPolling();
    void openCaptions(m.id, { host: $('#lib-m-body'), onBack: () => void render() });
  });
  caps.title = t('Big live captions, with a translated line under each if you like.');
  head.append(el('h3', 'ms-title', m.title), el('span', 'ai-badge', t('AI companion')), caps);
  const notice = el('p', 'ms-notice', m.announce);
  notice.setAttribute('role', 'note');
  const status = el('p', 'small ms-status', STATUS_WORDS[m.status]?.() ?? m.status);
  status.setAttribute('role', 'status');
  const lines = el('ol', 'ms-lines');
  lines.setAttribute('aria-live', 'polite');
  const controls = el('div', 'actions-left ms-controls');
  const notes = el('div', 'ms-notes');
  const event = el('p', 'small ms-event');
  event.hidden = true;
  const tools = el('div', 'ms-tools');
  const search = input('search');
  search.placeholder = t('A word or a name');
  search.addEventListener('input', () => filterLines(box, search.value));
  tools.append(field(t('Search the transcript'), search, t('Shows only the lines with these words. Press a time to play the recording from there.')));
  const speakers = el('div', 'ms-speakers');
  box.append(back, head, notice, status, event, controls);
  if (m.keepAudio && m.status !== 'live') {
    const audio = el('audio', 'ms-audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = `/api/meetings/${m.id}/recording?play=1`;
    box.append(audio);
  }
  box.append(tools, speakers, lines, notes);
  return box;
}

function filterLines(box, q) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const li of box.querySelectorAll('.ms-line')) {
    const hay = li.textContent.toLowerCase();
    const ok = words.every((w) => hay.includes(w));
    li.hidden = !ok;
    if (ok) shown++;
  }
  const note = box.querySelector('.ms-search-note') ?? el('p', 'small muted ms-search-note');
  note.textContent = words.length ? t('{n} lines match.', { n: shown }) : '';
  box.querySelector('.ms-tools').append(note);
}

/** S2: Speaker 1 / Speaker 2… with Rename (the transcript and action item owners follow). */
function speakerBar(m, box) {
  const host = box.querySelector('.ms-speakers');
  const names = [...new Set([...box.querySelectorAll('.ms-line')].map((li) => li.dataset.speaker).filter(Boolean))];
  const key = names.join('|');
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren();
  if (!names.length || m.status === 'live') return;
  host.append(el('span', 'small muted', t('Speakers')));
  for (const name of names) {
    const chip = el('span', 'ms-chip');
    chip.append(el('span', '', name), btn(t('Rename'), 'ghost small', () => {
      const to = input('text');
      to.maxLength = 40;
      to.value = name;
      const form = el('div', 'ms-rename');
      form.append(field(t('New name'), to, t('Replaces this label on every line of the transcript, and as the owner of action items.')), btn(t('Save'), 'small', async () => {
        try {
          await api(`/meetings/${m.id}/speakers`, { method: 'POST', body: { from: name, to: to.value } });
          meetingId = m.id;
          await render();
        } catch (e) {
          form.append(el('p', 'small error', e.message));
        }
      }));
      chip.replaceWith(form);
      to.focus();
    }));
    host.append(chip);
  }
}

function joinButtons(m, controls, status) {
  // Back from Captions while this device is still in the room: only the End button.
  if (room && room.id === m.id && !controls.childElementCount) controls.replaceChildren(endButton(m));
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
    if (n.questions?.length) {
      const ql = el('ul', 'ms-list');
      for (const q of n.questions) ql.append(el('li', '', q));
      out.push(el('h4', '', t('Open questions')), ql);
    }
    if (n.drafts?.length) out.push(...draftsView(m, host));
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

/** S2: follow-up emails per attendee group: edit, then Send, Save as a draft or Dismiss. */
function draftsView(m, host) {
  const out = [el('h4', '', t('Follow-up emails')), el('p', 'small muted', t('Nothing is sent until you press Send.'))];
  m.notes.drafts.forEach((d, i) => {
    const card = el('div', 'ms-card ms-draft');
    if (d.status !== 'waiting') {
      const word = { sent: t('Sent'), saved: t('Saved in your mail drafts'), dismissed: t('Dismissed') }[d.status] ?? d.status;
      card.append(el('strong', '', d.subject), el('p', 'small muted', `${d.to.join(', ')} · ${word}`));
      out.push(card);
      return;
    }
    card.append(el('strong', '', d.subject));
    const to = input('text');
    to.value = d.to.join(', ');
    const subject = input('text');
    subject.value = d.subject;
    const body = input('textarea');
    body.rows = 8;
    body.value = d.body;
    card.append(
      field(t('To'), to, t('The attendees of this group from the calendar event. Change or remove addresses before sending.')),
      field(t('Subject'), subject, t('The subject line of the email.')),
      field(t('Message'), body, t('Written from the notes. Edit anything; what you see is what is sent.')),
    );
    const act = async (action) => {
      try {
        await api(`/meetings/${m.id}/drafts/${i}`, { method: 'POST', body: { action, to: to.value, subject: subject.value, body: body.value } });
        notesShown = '';
        void poll();
      } catch (e) {
        card.append(el('p', 'small error', e.message));
      }
    };
    const acts = el('div', 'actions-left');
    acts.append(btn(t('Send'), 'small', () => void act('send')), btn(t('Save as a draft'), 'ghost small', () => void act('save')), btn(t('Dismiss'), 'ghost small', () => void act('dismiss')));
    card.append(acts);
    out.push(card);
  });
  return out;
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
    if (!room || m.status !== 'live') status.textContent = m.status === 'hearing' && m.parts > 1 ? t('Hearing part {n} of {total}…', { n: Math.min(m.parts, m.got + 1), total: m.parts }) : STATUS_WORDS[m.status]?.() ?? m.status;
    const ev = box.querySelector('.ms-event');
    if (m.notes?.event) {
      ev.hidden = false;
      ev.textContent = `${t('Calendar')}: ${m.notes.event.title} · ${new Date(m.notes.event.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${m.notes.event.attendees.length ? ` · ${t('{n} attendees', { n: m.notes.event.attendees.length })}` : ''}`;
    }
    speakerBar(m, box);
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

// ---------------------------------------------------------------- S2: recordings sent in parts

const wavHeader = (channels, rate, bytes) => {
  const b = new DataView(new ArrayBuffer(44));
  const str = (o, x) => [...x].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  b.setUint32(4, 36 + bytes, true);
  str(8, 'WAVEfmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, channels, true);
  b.setUint32(24, rate, true);
  b.setUint32(28, rate * channels * 2, true);
  b.setUint16(32, channels * 2, true);
  b.setUint16(34, 16, true);
  str(36, 'data');
  b.setUint32(40, bytes, true);
  return b.buffer;
};

/** A PCM WAV's layout (16-bit), read from its first bytes; null when it is something else. */
async function wavLayout(file) {
  const head = new DataView(await file.slice(0, 1 << 16).arrayBuffer());
  const tag = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => head.getUint8(o + i)));
  if (head.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = null;
  for (let o = 12; o + 8 <= head.byteLength; ) {
    const id = tag(o);
    const size = head.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: head.getUint16(o + 8, true), channels: head.getUint16(o + 10, true), rate: head.getUint32(o + 12, true), bits: head.getUint16(o + 22, true) };
    if (id === 'data') return fmt && fmt.format === 1 && fmt.bits === 16 ? { ...fmt, offset: o + 8, bytes: Math.min(size, file.size - o - 8) } : null;
    o += 8 + size + (size % 2);
  }
  return null;
}

/** Any recording as WAV parts of about ten minutes: a 16-bit WAV is cut as is, others decoded here. */
async function wavParts(file, keepStereo, say) {
  const w = await wavLayout(file);
  if (w) {
    const frame = w.channels * 2;
    const step = Math.floor(w.rate * PART_SEC) * frame;
    const parts = [];
    for (let o = 0; o < w.bytes; o += step) {
      const n = Math.min(step, w.bytes - o);
      // Read when sent, one part at a time (a Mac recording comes from the app in pieces, never all at once).
      parts.push(async () => new Blob([wavHeader(w.channels, w.rate, n), await file.slice(w.offset + o, w.offset + o + n).arrayBuffer()]));
    }
    return { parts, seconds: w.bytes / (frame * w.rate) };
  }
  say(t('Reading the recording…'));
  const Ctx = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error(t('This browser cannot read that file. Save it as WAV and try again.'));
  let audio;
  try {
    audio = await new Ctx(1, 1, 16000).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(t('This browser cannot read that file. Save it as WAV and try again.'));
  }
  const channels = keepStereo && audio.numberOfChannels >= 2 ? 2 : 1;
  const data = [...Array(audio.numberOfChannels).keys()].map((c) => audio.getChannelData(c));
  const per = 16000 * PART_SEC;
  const parts = [];
  for (let a = 0; a < audio.length; a += per) {
    const n = Math.min(per, audio.length - a);
    const pcm = new Int16Array(n * channels);
    for (let i = 0; i < n; i++) {
      if (channels === 2) {
        pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(data[0][a + i] * 32767)));
        pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(data[1][a + i] * 32767)));
      } else {
        let v = 0;
        for (const d of data) v += d[a + i];
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round((v / data.length) * 32767)));
      }
    }
    const part = new Blob([wavHeader(channels, 16000, pcm.byteLength), pcm.buffer]);
    parts.push(async () => part);
  }
  return { parts, seconds: audio.duration };
}

/** Sends a recording part by part; returns the new meeting's id. */
async function sendRecording(file, o, say) {
  if (!o.consent) throw new Error(t('Tick that everyone in this recording knew it was recorded and agreed to notes.'));
  const { parts, seconds } = await wavParts(file, o.channels === 'speakers', say);
  if (seconds > 3 * 3600 + 60) throw new Error(t('Recordings can be up to 3 hours.'));
  const startedAt = o.startedAt ?? (file.lastModified ? new Date(file.lastModified - seconds * 1000).toISOString() : undefined);
  const { meeting } = await api('/meetings/upload', { method: 'POST', body: { title: o.title, consent: true, keepAudio: o.keepAudio, name: file.name, parts: parts.length, channels: o.channels, seconds: Math.round(seconds), ...(startedAt ? { startedAt } : {}) } });
  for (let i = 0; i < parts.length; i++) {
    say(t('Sending part {n} of {total}…', { n: i + 1, total: parts.length }));
    await api(`/meetings/${meeting.id}/part?i=${i}`, { method: 'POST', raw: await parts[i]() });
  }
  return meeting.id;
}

// ---------------------------------------------------------------- S2: Record this computer (Windows and Mac apps)

const desktopRecorder = () => Boolean(globalThis.SaraDesktop?.meetingRec);
let recTimer = null;

function desktopForm(r) {
  const box = el('div', 'ms-card ms-rec');
  box.append(el('h3', '', t('Record this computer')));
  box.append(el('p', 'small muted', t('Records your microphone and the sound of this computer (Zoom, Teams, Meet or any call), so you are Speaker 1 and the others Speaker 2.')));
  const title = input('text');
  title.maxLength = 120;
  title.placeholder = t('For example: Weekly sync');
  const keep = input('checkbox');
  const ok = input('checkbox');
  const line = t('Tell everyone: "I\'m recording this call so my assistant can take notes. Is that OK?"');
  box.append(
    field(t('Meeting name'), title, t('The name of the notes in her Library.')),
    field(t('Keep the recording'), keep, t('Off: the sound is dropped once she has heard it. On: kept with the meeting so you can play it from any line, until you delete it.')),
    field(t('Everyone on the call knows it is recorded and agreed'), ok, t('Required. In many places recording a call needs everyone\'s agreement. Say it at the start; it is also the first line of the transcript.')),
  );
  const notice = el('p', 'ms-notice', line);
  notice.setAttribute('role', 'note');
  notice.hidden = !prefs.remind;
  box.append(notice);
  problem(box, r);
  const status = el('p', 'small', '');
  status.setAttribute('role', 'status');
  const micOnly = el('p', 'small muted', globalThis.SaraDesktop?.platform === 'mac' ? t('Only your microphone is being recorded. To include the call’s sound, allow Sara in System Settings → Privacy & Security → Screen & System Audio Recording, then start again.') : t('Only your microphone is being recorded: the sound of this computer could not be captured.'));
  micOnly.hidden = true;
  const acts = el('div', 'actions-left');
  const stop = btn(t('Stop and write the notes'), '', () => {
    micOnly.hidden = true;
    void stopDesktop(status, acts);
  });
  const go = btn(t('Start recording'), '', async () => {
    if (!ok.checked) {
      status.textContent = t('Tick that everyone on the call knows it is recorded first.');
      return;
    }
    go.disabled = true;
    try {
      const res = await globalThis.SaraDesktop.call('meetingRec', { op: 'start' });
      localStorage.setItem(REC_KEY, JSON.stringify({ title: title.value || t('Meeting'), keepAudio: keep.checked, startedAt: new Date().toISOString() }));
      if (prefs.remind) speak(line.replace(/^[^"]*"|"[^"]*$/g, ''));
      acts.replaceChildren(stop);
      tick(status, res?.startedAt ? Date.parse(res.startedAt) : Date.now());
      // U2.7: without the computer's sound (the Mac's Screen & System Audio Recording permission) it says so.
      micOnly.hidden = res?.loopback !== false;
    } catch (e) {
      const mac = globalThis.SaraDesktop?.platform === 'mac';
      status.textContent = e.message === 'mic' ? (mac ? t('The microphone could not start. Check System Settings → Privacy & Security → Microphone.') : t('The microphone could not start. Check Windows Settings → Privacy → Microphone.')) : e.message || t('Recording could not start.');
      go.disabled = false;
    }
  });
  go.disabled = !r.ready;
  acts.append(go);
  box.append(acts, status, micOnly);
  void globalThis.SaraDesktop.call('meetingRec', { op: 'status' }).then((st) => {
    if (st?.recording) {
      acts.replaceChildren(stop);
      tick(status, Date.now() - st.seconds * 1000);
      micOnly.hidden = st.loopback !== false;
    }
  }).catch(() => {});
  return box;
}

function tick(status, since) {
  clearInterval(recTimer);
  const show = () => (status.textContent = t('Recording… {time}', { time: clock((Date.now() - since) / 1000) }));
  show();
  recTimer = setInterval(() => {
    if (!status.isConnected) return clearInterval(recTimer);
    show();
  }, 1000);
}

async function speak(text) {
  try {
    const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) return;
    const a = new Audio(URL.createObjectURL(await res.blob()));
    void a.play().catch(() => {});
  } catch {}
}

async function stopDesktop(status, acts) {
  clearInterval(recTimer);
  acts.replaceChildren();
  status.textContent = t('Saving the recording…');
  try {
    await globalThis.SaraDesktop.call('meetingRec', { op: 'stop' });
    status.textContent = t('Sending…');
  } catch (e) {
    status.textContent = e.message || t('Recording could not be saved.');
  }
}

/** The app hands over the finished recording (a file handle): it is sent in parts like any file. */
globalThis.addEventListener?.('sara-meeting-file', async (e) => {
  const file = e.detail?.file;
  if (!file) return;
  let o = {};
  try {
    o = JSON.parse(localStorage.getItem(REC_KEY) ?? '{}');
  } catch {}
  const status = document.querySelector('.ms-rec [role="status"]');
  const say = (msg) => {
    if (status) status.textContent = msg;
  };
  try {
    const id = await sendRecording(file, { title: o.title || t('Meeting'), consent: true, keepAudio: Boolean(o.keepAudio), channels: 'speakers', startedAt: o.startedAt }, say);
    localStorage.removeItem(REC_KEY);
    void globalThis.SaraDesktop?.call('meetingRec', { op: 'discard' }).catch(() => {});
    await openMeetingsView();
    meetingId = id;
    await render();
  } catch (err) {
    say(err.message);
  }
});

// ---------------------------------------------------------------- S2: Today tile, prefs, the view

/** U3.19: an Ask hit opened here: the item outlined and scrolled into view. */
function spot(node) {
  if (!node) return;
  node.classList.add('ask-spot');
  node.scrollIntoView?.({ block: 'center' });
  setTimeout(() => node.classList.remove('ask-spot'), 4000);
}

/** Opens Library → Meetings from anywhere (Today, #view=meetings, an Ask hit at a transcript line). */
export async function openMeetingsView(id, line) {
  const { openLibrary } = await import('./library.js');
  await openLibrary();
  await openMeetings();
  if (id) {
    meetingId = id;
    await render();
    // The transcript lines arrive with the first poll: wait for the quoted one (up to 4 s).
    for (let k = 0; line && k < 27; k++) {
      const li = document.querySelector(`.ms-meeting .ms-line[data-n="${Number(line)}"]`);
      if (li) return spot(li);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export function renderMeetingsTile(p, tileHead) {
  const tile = $('#td-meetings');
  if (!tile) return;
  tile.hidden = !p;
  if (!p) return;
  tileHead?.(tile, t('Meetings'));
  const list = el('ul', 'td-biz ms-tile');
  for (const x of p.items) {
    const li = el('li', 'small');
    li.append(el('span', 'ms-task', x.task), el('span', 'muted', ` · ${[x.owner, new Date(x.dueAt).toLocaleDateString()].filter(Boolean).join(' · ')}`));
    list.append(li);
  }
  if (p.drafts) list.append(el('li', 'small muted', t('{n} follow-up emails wait for you', { n: p.drafts })));
  const first = p.items[0]?.meeting;
  tile.querySelector('.td-body').replaceChildren(list, btn(t('Open Meetings'), 'ghost small', () => void openMeetingsView(first)));
}

/** Settings → Voice → Meetings (owner only): remind me to tell everyone; a cloud engine may hear. */
export async function loadMeetingPrefs() {
  const box = $('#meet-prefs');
  if (!box) return;
  try {
    const r = await api('/meetings');
    prefs = r.prefs ?? prefs;
    $('#meet-remind').checked = prefs.remind;
    $('#meet-cloud').checked = prefs.cloud;
    $('#meet-speakers').checked = prefs.speakers !== false;
    drawSpeakerAddon(r.speakerAddon);
    drawCaptionPrefs(r.captions);
  } catch {
    box.hidden = true;
    return;
  }
  if (box.dataset.wired) return;
  box.dataset.wired = '1';
  for (const [btn, action] of [['#meet-speakers-get', 'install'], ['#meet-speakers-remove', 'remove']])
    $(btn).addEventListener('click', async () => {
      try {
        drawSpeakerAddon((await api('/meetings/speaker-addon', { method: 'POST', body: { action } })).speakerAddon);
      } catch (err) {
        $('#meet-prefs-note').textContent = err.message;
      }
    });
  for (const [id, key] of [['#meet-remind', 'remind'], ['#meet-cloud', 'cloud'], ['#meet-speakers', 'speakers']])
    $(id).addEventListener('change', async (e) => {
      try {
        prefs = (await api('/meetings/prefs', { method: 'PUT', body: { [key]: e.target.checked } })).prefs;
      } catch (err) {
        e.target.checked = !e.target.checked;
        $('#meet-prefs-note').textContent = err.message;
      }
    });
}

/** V4.4: Settings → Voice → Meetings: the captions' language and whether a cloud model may translate. */
function drawCaptionPrefs(c) {
  const lang = $('#meet-cap-lang');
  const cloud = $('#meet-cap-cloud');
  if (!lang || !cloud || !c) return;
  fillLangs(lang, c.langs, c.prefs.lang);
  cloud.checked = c.prefs.cloud;
  const note = $('#meet-cap-note');
  if (note) note.textContent = !c.prefs.lang ? '' : c.engine === 'local' ? t('Translated on this computer.') : c.engine === 'cloud' ? t('Translated by your cloud model.') : serverText({ error: c.why }, c.why ?? '');
  if (lang.dataset.wired) return;
  lang.dataset.wired = '1';
  const save = async (body, undo) => {
    try {
      drawCaptionPrefs((await api('/meetings/captions', { method: 'PUT', body })).captions);
    } catch (err) {
      undo();
      $('#meet-prefs-note').textContent = err.message;
    }
  };
  lang.addEventListener('change', () => {
    const was = c.prefs.lang;
    void save({ lang: lang.value }, () => (lang.value = was));
  });
  cloud.addEventListener('change', () => void save({ cloud: cloud.checked }, () => (cloud.checked = !cloud.checked)));
}

/** U3.13: the speaker add-on's state under "Better speaker separation" (polled while it downloads). */
let saTimer = 0;
function drawSpeakerAddon(sa) {
  const row = $('#meet-speakers-row');
  if (!row) return;
  row.hidden = !sa;
  if (!sa) return;
  const text = {
    ready: t('Ready on this computer.'),
    missing: t('Not downloaded yet (about {mb} MB). It downloads the first time a meeting needs it.', { mb: sa.mb }),
    installing: t('Downloading (about {mb} MB)…', { mb: sa.mb }),
    failed: t('Could not download it: {error}', { error: sa.error || '' }),
    unsupported: t('Not available on this system: speakers are split by pauses and pitch.'),
  }[sa.state];
  $('#meet-speakers-status').textContent = text || '';
  $('#meet-speakers-get').hidden = !['missing', 'failed'].includes(sa.state);
  $('#meet-speakers-remove').hidden = sa.state !== 'ready';
  clearTimeout(saTimer);
  if (sa.state === 'installing')
    saTimer = setTimeout(async () => {
      if (!row.isConnected || row.closest('[hidden]')) return;
      drawSpeakerAddon((await api('/meetings').catch(() => ({}))).speakerAddon);
    }, 2000);
}
