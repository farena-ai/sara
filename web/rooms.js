// Phase 110 (CH4): keeping up with a room. The Rooms lists (Settings → Telegram / Discord and the
// channel project page), the room window (Keep up with this room, the summary model and cap, What
// she knows right now, Room memory, the archive link, Forget this room), the plan card he confirms
// before anything runs, and the Forget confirmation with its counts. Owner only (the server checks).
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
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

/** ≈ 2,500 input + 300 output tokens per summary (the server's REFRESH_TOKENS). */
const REFRESH_TOKENS = 2800;
let hooks = { openArchive: () => undefined, openPerson: () => undefined };
let current = null;
const lists = new Map();

const when = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const number = (n) => Number(n ?? 0).toLocaleString(locale());

/** The state chip: Keeping up, Off, Paused (with why), or she's no longer there. */
function stateOf(r) {
  if (r.left) return { cls: 'left', text: t("She's no longer in this room") };
  if (r.keepUp && r.pausedReason) return { cls: 'paused', text: t('Paused: {why}', { why: seesWords(`no:${r.pausedReason}`) }) };
  if (r.keepUp) return { cls: 'on', text: t('Keeping up') };
  return { cls: 'off', text: t('Off') };
}

/** What the platform check found (§7.2), in words. */
function seesWords(s) {
  if (!s) return t('Not checked yet');
  if (s === 'yes') return t('Sees every message');
  if (s === 'admin') return t("Sees every message (she's a group admin)");
  const why = s.slice(3);
  if (why === 'privacy') return t("Can't see every message: privacy mode is on");
  if (why === 'left') return t("She's no longer in this room");
  if (why === 'not connected') return t('Not connected');
  return t("Can't see every message: {why}", { why });
}

function summaryWords(s) {
  if (s === 'ok') return t('Summary: up to date');
  if (s === 'cap') return t("Summary paused: today's cap is reached, so she uses the last lines");
  if (s === 'no-model') return t('No summary model yet: she uses the last lines');
  if (s === 'off') return t('Summaries are off: she uses the last lines');
  if (s === 'dropped' || s === 'error') return t("The last summary didn't work: she uses the last lines");
  return t('No summary yet');
}

/** One row per room: name, last activity, state chip. */
function roomRow(r) {
  const b = el('button', 'room-card room-row');
  b.type = 'button';
  const st = stateOf(r);
  const mid = el('span', 'room-row-mid');
  mid.append(el('span', 'room-name', r.name), el('span', 'muted small', t('Last activity: {when}', { when: when(r.lastActivity) })));
  b.append(mid, el('span', `room-chip ${st.cls}`, st.text));
  b.addEventListener('click', () => void openRoom(r.id));
  return b;
}

/** Fills a Rooms list (bridge = 'telegram' | 'discord'; empty = all). */
export async function loadRoomList(box, bridge) {
  if (!box) return;
  lists.set(box, bridge);
  try {
    const d = await api(`/rooms${bridge ? `?bridge=${encodeURIComponent(bridge)}` : ''}`);
    box.replaceChildren(...(d.rooms.length ? d.rooms.map(roomRow) : [el('p', 'muted small', t('No rooms yet: once she has talked in a group or server channel, it shows here.'))]));
    if (d.privateLocal) box.prepend(el('p', 'muted small', t('Paused in private local mode.')));
    return d.rooms;
  } catch {
    box.replaceChildren();
    return [];
  }
}
const refreshLists = () => {
  for (const [box, bridge] of lists) if (box.isConnected) void loadRoomList(box, bridge);
};

function renderRoom(d) {
  const r = d.room;
  current = d;
  $('#rm-title').textContent = r.name;
  const st = stateOf(r);
  $('#rm-state').replaceChildren(el('span', `room-chip ${st.cls}`, st.text), document.createTextNode(` ${r.keepUp && r.keepUpSince ? t('since {when}', { when: when(r.keepUpSince) }) : ''}`));
  $('#rm-keep').checked = r.keepUp;
  $('#rm-keep').disabled = r.left;
  $('#rm-platform').textContent = r.bridge === 'telegram' ? t('To read every message, turn privacy mode off in @BotFather (/setprivacy → Disable), then remove her from the group and add her again — or make her a group admin.') : r.bridge === 'discord' ? t("Reading every message uses Discord's Message Content Intent, which Sara already needs. It's a switch in the Developer Portal for bots in fewer than 100 servers; bigger, verified bots need Discord's approval.") : '';
  $('#rm-sees').textContent = `${t('What she can see:')} ${seesWords(r.seesAll)}${r.seesAll && r.checkedAt ? ` · ${t('checked {when}', { when: when(r.checkedAt) })}` : ''}`;
  $('#rm-model').value = r.model;
  $('#rm-per-day').value = String(r.summariesPerDay);
  $('#rm-per-day-out').textContent = String(r.summariesPerDay);
  $('#rm-last-day-row').hidden = r.bridge !== 'discord';
  $('#rm-last-day').checked = r.readLastDay;
  $('#rm-usage').textContent = r.keepUp ? `${t('Summaries today: {runs} · tokens: {tokens} of {cap}', { runs: d.today.runs, tokens: number(d.today.tokens), cap: number(r.dailyTokens) })} · ${summaryWords(d.summary)} · ${t('Lines in the log: {n}', { n: number(d.lines) })}` : '';
  $('#rm-forget').disabled = !(d.forget && (d.forget.lines || d.forget.weeks || d.forget.archives || d.forget.peopleNotes));
}

async function loadNow(id) {
  try {
    const n = await api(`/rooms/${id}/now`);
    $('#rm-now').textContent = n.keepUp ? n.text : t('Switch on Keep up with this room and this shows what she would be told if someone called her now.');
  } catch (err) {
    $('#rm-now').textContent = err.message;
  }
}

async function loadMemory(id) {
  const box = $('#rm-memory');
  try {
    const m = await api(`/rooms/${id}/memory`);
    const parts = [];
    if (m.weeks.length) {
      const ul = el('ul', 'room-weeks');
      for (const w of m.weeks) {
        const li = el('li', 'room-week');
        li.append(el('strong', '', t('Week {week}', { week: w.week.slice(-2) })), document.createTextNode(` ${w.summary}`));
        if (w.topics.length) li.append(el('span', 'muted small room-topics', w.topics.join(' · ')));
        ul.append(li);
      }
      parts.push(ul);
    }
    const people = m.people.filter((p) => p.notes.length || p.card);
    if (people.length) {
      parts.push(el('h4', '', t('People here')));
      const ul = el('ul', 'room-people');
      for (const p of people) {
        const li = el('li', 'room-person');
        li.append(el('strong', '', p.name));
        for (const n of p.notes.slice(-3)) li.append(el('span', 'small', `${n.note} (${t('week {week}', { week: n.week.slice(-2) })})`));
        if (p.card) {
          const b = el('button', 'ghost small', p.card.status === 'proposed' ? t('Check the proposed card') : t('Open the People card'));
          b.type = 'button';
          b.addEventListener('click', () => hooks.openPerson(p.card.id));
          li.append(b);
        }
        ul.append(li);
      }
      parts.push(ul);
    }
    $('#rm-archive').hidden = !m.archives.length;
    $('#rm-archive').textContent = m.archives.length === 1 ? t('Open the archive in her Library (1 week)') : t('Open the archive in her Library (weeks: {n})', { n: m.archives.length });
    box.replaceChildren(...(parts.length ? parts : [el('p', 'muted small', t('Nothing yet: the first room memory is written on the night after the first full week.'))]));
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function openRoom(id) {
  const d = await api(`/rooms/${id}`);
  renderRoom(d);
  if (!$('#room-dialog').open) $('#room-dialog').showModal();
  void loadNow(id);
  void loadMemory(id);
}

async function save(body) {
  if (!current) return;
  try {
    const d = await api(`/rooms/${current.room.id}`, { method: 'PUT', body });
    renderRoom(d);
    refreshLists();
    return d;
  } catch (err) {
    $('#rm-state').textContent = err.message;
    throw err;
  }
}

/** The plan card (§7.12): what will run, on which model, about how many tokens and what it costs. */
function openPlan() {
  const d = current;
  const r = d.room;
  const p = d.plan;
  $('#rp-room').textContent = r.name;
  const model = r.model === 'off' ? t('no model (last lines only)') : p.model ? `${p.model.model} (${p.model.label})` : r.model === 'local' ? t('no model on this computer yet') : t('no quick model yet');
  const cost = r.model === 'off' ? t('nothing') : p.model?.local ? t('free on this computer') : p.usdPerDay === null ? t('price unknown') : t('about ${usd} a day at your prices', { usd: p.usdPerDay.toFixed(2) });
  const items = [
    t('Reads every message here into a room log kept 7 days.'),
    ...(r.bridge === 'discord' && r.readLastDay ? [t('Reads the last day now (up to 100 messages).')] : []),
    ...(r.bridge === 'telegram' ? [t("Telegram doesn't let bots read history: the log starts now.")] : []),
    r.model === 'off' ? t('No summary calls: she uses the last lines and simple counts.') : t('Refreshes a short summary about every {n} messages or {m} minutes on {model}, about {tokens} tokens a day ({cost}), capped at {cap}.', { n: r.summaryEvery, m: r.summaryMinutes, model, tokens: number(p.tokensPerDay), cost, cap: number(p.cap) }),
    p.fromRate ? t('Estimate from this room: about {n} messages a day.', { n: number(p.linesPerDay) }) : t('Estimate for a busy room (about {n} messages a day); it follows the real rate once she reads along.', { n: number(p.linesPerDay) }),
    t('Every night, folds lines older than 7 days into room memory and a weekly archive in her Library.'),
    t('Reading never starts a tool. No notice is posted in the room.'),
  ];
  $('#rp-list').replaceChildren(...items.map((x) => el('li', '', x)));
  $('#rp-sees').textContent = `${t('What she can see:')} ${seesWords(r.seesAll)}`;
  $('#rp-error').hidden = true;
  $('#rp-confirm').disabled = false;
  $('#room-plan').showModal();
}

async function confirmPlan() {
  $('#rp-confirm').disabled = true;
  try {
    const d = await save({ keepUp: true, confirmed: true, model: $('#rm-model').value, readLastDay: $('#rm-last-day').checked });
    $('#room-plan').close();
    if (d?.backfill) $('#rm-state').append(document.createTextNode(` · ${d.backfill.skipped ? t('Last day not read: {why}', { why: d.backfill.skipped }) : t('Messages read from the last day: {n}.', { n: d.backfill.read })}`));
    void loadNow(d.room.id);
  } catch (err) {
    $('#rp-error').hidden = false;
    $('#rp-error').textContent = err.message;
    $('#rp-confirm').disabled = false;
    $('#rm-keep').checked = false;
  }
}

async function openForget() {
  const d = await api(`/rooms/${current.room.id}/forget`);
  const p = d.plan;
  $('#rf-counts').textContent = t('Lines from this week: {lines} · weeks of room memory: {weeks} · people notes: {notes} · archived weeks: {archives} ({size}).', { lines: number(p.lines), weeks: p.weeks, notes: p.peopleNotes, archives: p.archives, size: bytes(p.archiveBytes) });
  $('#rf-cards').textContent = [p.cards.removed.length ? t('Proposed cards removed: {names}', { names: p.cards.removed.join(', ') }) : '', p.cards.kept.length ? t('Cards you keep (without the notes from this room): {names}', { names: [...new Set(p.cards.kept)].join(', ') }) : ''].filter(Boolean).join(' ');
  $('#rf-sessions').checked = false;
  $('#rf-done').textContent = '';
  $('#rf-go').disabled = false;
  $('#room-forget').showModal();
}

/** Phase 110: a byte count the way the Library shows it (KB under a megabyte). */
function bytes(n) {
  return n < 1024 * 1024 ? `${number(Math.max(1, Math.round(n / 1024)))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initRooms(h = {}) {
  hooks = { ...hooks, ...h };
  $('#rm-keep').addEventListener('change', () => {
    if (!current) return;
    if ($('#rm-keep').checked && !current.room.keepUp) {
      $('#rm-keep').checked = false;
      openPlan();
    } else if (!$('#rm-keep').checked && current.room.keepUp) void save({ keepUp: false }).then(() => loadNow(current.room.id));
  });
  $('#rm-model').addEventListener('change', () => void save({ model: $('#rm-model').value }));
  $('#rm-per-day').addEventListener('input', () => ($('#rm-per-day-out').textContent = $('#rm-per-day').value));
  $('#rm-per-day').addEventListener('change', () => void save({ dailyTokens: Number($('#rm-per-day').value) * REFRESH_TOKENS }));
  $('#rm-last-day').addEventListener('change', () => void save({ readLastDay: $('#rm-last-day').checked }));
  $('#rm-check').addEventListener('click', async () => {
    $('#rm-check').disabled = true;
    try {
      renderRoom(await api(`/rooms/${current.room.id}/check`, { method: 'POST', body: {} }));
      refreshLists();
    } catch (err) {
      $('#rm-state').textContent = err.message;
    } finally {
      $('#rm-check').disabled = false;
    }
  });
  $('#rm-archive').addEventListener('click', () => {
    $('#room-dialog').close();
    hooks.openArchive(current.room.id);
  });
  $('#rm-forget').addEventListener('click', () => void openForget());
  $('#rp-confirm').addEventListener('click', () => void confirmPlan());
  $('#rf-go').addEventListener('click', async () => {
    $('#rf-go').disabled = true;
    try {
      const d = await api(`/rooms/${current.room.id}/forget`, { method: 'POST', body: { sessions: $('#rf-sessions').checked } });
      $('#rf-done').textContent = d.forgot?.receipt ?? '';
      renderRoom(d);
      void loadNow(d.room.id);
      void loadMemory(d.room.id);
      refreshLists();
    } catch (err) {
      $('#rf-done').textContent = err.message;
      $('#rf-go').disabled = false;
    }
  });
}
