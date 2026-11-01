// Phase 113 (docs/SUPPORT.md): the anonymous daily check-in's first-run notice and Settings →
// Data & health → Privacy, a notice from the hub (shown once), Help → Report a problem / Suggest
// something (one sheet with diagnostics shown in full, a tick per part), My reports, and "Report
// this" on error notices. The page never talks to the hub itself: everything goes through Sara's
// own /api/hub routes. Text from the hub is always shown as plain text (textContent).
import { serverText, t } from './naming.js';

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

const st = { demo: false, member: false, openSettings: null, pending: null, diag: null, sending: false };
const KIND = { bug: () => t('A problem'), idea: () => t('An idea'), question: () => t('A question') };
const STATUS = {
  new: () => t('New'),
  triaged: () => t('Looked at'),
  'in-progress': () => t('Being worked on'),
  waiting: () => t('Waiting for you'),
  fixed: () => t('Fixed'),
  closed: () => t('Closed'),
};
const LEVEL = { info: () => t('Note'), update: () => t('Update'), 'known-issue': () => t('Known issue') };
const PARTS = [
  ['system', () => t('Version and platform')],
  ['error', () => t('The error')],
  ['steps', () => t('Steps of the failed reply (tool names and results)')],
  ['settingsShape', () => t('Which settings are on (no values)')],
  ['log', () => t('The last 200 log lines')],
];
const BLOCKED = {
  demo: () => t('Not sent: this is the demo.'),
  private: () => t('Not sent while “Nothing leaves this computer” is on.'),
  offline: () => t('Not sent: Sara can’t reach the internet from here.'),
  off: () => t('Switched off: nothing is sent.'),
  tests: () => t('Not sent: this is a test copy.'),
  notice: () => t('Starts after you’ve seen the first-run notice.'),
  member: () => t('The server checks in once for everyone.'),
};
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

// ---- first-run notice and the hub's notices ----

async function refresh() {
  if (st.demo) return;
  let info;
  try {
    info = await api('/hub');
  } catch {
    return;
  }
  st.member = Boolean(info.member);
  if (st.member) return;
  if (info.firstRun) whenClear(() => {
    $('#hub-first').hidden = false;
    void api('/hub/first-run', { method: 'POST', body: { action: 'shown' } }).catch(() => {});
  });
  if (info.banner) whenClear(() => showBanner(info.banner));
}

/** Shown only once no window covers the page (setup, sign-in steps): a notice under a window isn't seen. */
function whenClear(fn) {
  if (!document.querySelector('dialog:modal')) return fn();
  setTimeout(() => whenClear(fn), 2000);
}

function showBanner(n) {
  $('#hub-banner-level').textContent = (LEVEL[n.level] ?? LEVEL.info)();
  $('#hub-banner').dataset.level = n.level in LEVEL ? n.level : 'info';
  $('#hub-banner-text').textContent = String(n.text ?? '').slice(0, 280);
  const link = $('#hub-banner-link');
  let ok = false;
  try {
    ok = new URL(n.url).protocol === 'https:';
  } catch {
    ok = false;
  }
  link.hidden = !ok;
  if (ok) link.href = n.url;
  else link.removeAttribute('href');
  $('#hub-banner').hidden = false;
  // Shown once: Sara forgets it now (it stays on screen until closed).
  void api('/hub/notice', { method: 'POST', body: { id: n.id } }).catch(() => {});
}

async function firstRun(action) {
  $('#hub-first').hidden = true;
  await api('/hub/first-run', { method: 'POST', body: { action } }).catch(() => {});
}

// ---- Settings → Data & health → Privacy ----

export async function loadPrivacy() {
  try {
    const info = await api('/hub');
    if (info.member) return;
    $('#hub-on').checked = info.on;
    privacyStatus(info);
  } catch (err) {
    $('#hub-status').textContent = err.message;
  }
}
function privacyStatus(info) {
  const bits = [];
  if (info.blocked && info.blocked !== 'tests') bits.push((BLOCKED[info.blocked] ?? BLOCKED.off)());
  if (info.lastSentAt) bits.push(t('Last check-in: {when}', { when: when(info.lastSentAt) }));
  else if (info.on) bits.push(t('No check-in sent yet.'));
  $('#hub-status').textContent = bits.join(' ');
}
async function showPreview() {
  const pre = $('#hub-preview');
  try {
    const r = await api('/hub/preview');
    pre.textContent = JSON.stringify(r.payload, null, 2);
    pre.hidden = false;
  } catch (err) {
    $('#hub-status').textContent = err.message;
  }
}

// ---- Report a problem / Suggest something ----

/** Opens the sheet: kind 'bug' | 'idea' | 'question', optional text, or an error (Report this). */
export function openReport(o = {}) {
  const kind = o.kind === 'idea' || o.kind === 'question' ? o.kind : 'bug';
  st.pending = { error: o.error ?? '', conversationId: o.conversationId ?? null };
  st.diag = null;
  $('#hub-kind').value = kind;
  $('#hub-report-title').textContent = kind === 'idea' ? t('Suggest something') : t('Report a problem');
  const text = String(o.text ?? '').trim();
  $('#hub-title').value = text ? text.split('\n')[0].slice(0, 120) : o.error ? String(o.error).split('\n')[0].slice(0, 120) : '';
  $('#hub-body').value = text.length > 120 || text.includes('\n') ? text : '';
  $('#hub-email').value = '';
  $('#hub-diag').replaceChildren();
  $('#hub-diag-add').hidden = false;
  $('#hub-report-status').textContent = '';
  $('#hub-report-send').disabled = false;
  $('#hub-report-send').hidden = false;
  $('#hub-report-cancel').textContent = t('Cancel');
  $('#hub-report').showModal();
  if (o.error) void addDiagnostics();
  else $('#hub-title').focus();
}

async function addDiagnostics() {
  $('#hub-report-status').textContent = t('Building diagnostics on this computer…');
  try {
    const r = await api('/hub/diagnostics', { method: 'POST', body: { error: st.pending?.error ?? '', ...(st.pending?.conversationId ? { conversationId: st.pending.conversationId } : {}) } });
    st.diag = r.diagnostics ?? {};
    renderDiagnostics();
    $('#hub-diag-add').hidden = true;
    $('#hub-report-status').textContent = t('This is everything that would be sent with your report. Untick what you want to keep.');
  } catch (err) {
    $('#hub-report-status').textContent = err.message;
  }
}

function renderDiagnostics() {
  const box = $('#hub-diag');
  box.replaceChildren();
  for (const [key, label] of PARTS) {
    const v = st.diag?.[key];
    if (v === undefined || (Array.isArray(v) && !v.length)) continue;
    const part = el('div', 'hub-part');
    const lab = el('label', 'row hub-part-head');
    const box1 = document.createElement('input');
    box1.type = 'checkbox';
    box1.checked = true;
    box1.dataset.part = key;
    box1.id = `hub-part-${key}`;
    lab.append(box1, el('span', '', label()));
    const pre = el('pre', 'hub-part-text', typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    pre.dataset.raw = '';
    part.append(lab, pre);
    box.append(part);
  }
  if (!box.children.length) box.append(el('p', 'muted small', t('Nothing to add from here.')));
}

function tickedDiagnostics() {
  if (!st.diag) return undefined;
  const out = {};
  for (const b of document.querySelectorAll('#hub-diag input[data-part]')) if (b.checked) out[b.dataset.part] = st.diag[b.dataset.part];
  return Object.keys(out).length ? out : undefined;
}

async function sendReport() {
  if (st.sending) return;
  const title = $('#hub-title').value.trim();
  if (!title) {
    $('#hub-report-status').textContent = t('Write a short title first.');
    $('#hub-title').focus();
    return;
  }
  st.sending = true;
  $('#hub-report-send').disabled = true;
  $('#hub-report-status').textContent = t('Sending… (a small puzzle keeps spam out; it takes a moment)');
  try {
    const diagnostics = tickedDiagnostics();
    const r = await api('/hub/tickets', { method: 'POST', body: { kind: $('#hub-kind').value, title, body: $('#hub-body').value, contact: $('#hub-email').value.trim(), ...(diagnostics ? { diagnostics } : {}) } });
    $('#hub-report-status').textContent = t('Sent as {ticket}. Follow it in Help → My reports.', { ticket: r.ticket });
    $('#hub-report-send').hidden = true;
    $('#hub-report-cancel').textContent = t('Close');
  } catch (err) {
    $('#hub-report-status').textContent = err.message;
    $('#hub-report-send').disabled = false;
  } finally {
    st.sending = false;
  }
}

// ---- My reports ----

export async function openMine() {
  $('#hub-mine').showModal();
  $('#hub-mine-status').textContent = t('Checking for replies…');
  try {
    renderMine((await api('/hub/tickets')).tickets);
    const r = await api('/hub/tickets/refresh', { method: 'POST', body: {} });
    renderMine(r.tickets);
    $('#hub-mine-status').textContent = r.offline ? t('Not checked: Sara can’t reach the support desk from here.') : r.tickets.length ? t('Checked just now.') : '';
  } catch (err) {
    $('#hub-mine-status').textContent = err.message;
  }
}

function renderMine(tickets) {
  const list = $('#hub-mine-list');
  if (!tickets.length) return list.replaceChildren(el('p', 'muted small', t('You haven’t sent any reports yet.')));
  list.replaceChildren(
    ...tickets.map((x) => {
      const card = el('article', 'hub-ticket');
      const head = el('div', 'hub-ticket-head');
      const chip = el('span', 'hub-chip', (STATUS[x.status] ?? STATUS.new)());
      chip.dataset.status = x.status;
      head.append(el('strong', 'hub-ticket-id', x.ticket), el('span', 'muted small', (KIND[x.kind] ?? KIND.bug)()), chip);
      card.append(head, el('p', 'hub-ticket-title', x.title));
      if (x.fixedIn) card.append(el('p', 'small hub-fixed', t('Fixed in Sara {version}', { version: x.fixedIn })));
      const meta = [t('Sent {when}', { when: when(x.createdAt) })];
      if (x.checkedAt) meta.push(t('checked {when}', { when: when(x.checkedAt) }));
      card.append(el('p', 'muted small', meta.join(' · ')));
      for (const rep of x.replies ?? []) {
        const r = el('div', `hub-reply ${rep.from === 'you' ? 'mine' : 'team'}`);
        r.append(el('span', 'muted small', `${rep.from === 'you' ? t('You') : t('The Sara team')} · ${when(rep.at)}`), el('p', 'hub-reply-text', rep.text));
        card.append(r);
      }
      if (x.status !== 'closed') {
        const row = el('div', 'hub-reply-box');
        const box = document.createElement('textarea');
        box.rows = 2;
        box.maxLength = 4000;
        box.setAttribute('aria-label', t('Your reply'));
        box.placeholder = t('Your reply');
        const go = el('button', 'small', t('Send reply'));
        go.type = 'button';
        go.addEventListener('click', async () => {
          if (!box.value.trim()) return;
          go.disabled = true;
          try {
            renderMine((await api(`/hub/tickets/${encodeURIComponent(x.ticket)}/reply`, { method: 'POST', body: { text: box.value } })).tickets);
            $('#hub-mine-status').textContent = t('Reply sent.');
          } catch (err) {
            $('#hub-mine-status').textContent = err.message;
            go.disabled = false;
          }
        });
        row.append(box, go);
        card.append(row);
      }
      return card;
    }),
  );
}

/** "Report this" on an error notice: opens the sheet with the error filled in. */
export function reportThisButton(text, conversationId) {
  const b = el('button', 'link small hub-report-this', t('Report this'));
  b.type = 'button';
  b.addEventListener('click', () => openReport({ kind: 'bug', error: text, conversationId }));
  return b;
}

/** Deep links: #report=bug, #report=idea, #reports (from /bug in the chat apps). */
export function hubHash(hash) {
  const m = /^#report(?:=(bug|idea|question))?$/.exec(hash) ?? [];
  if (/^#reports$/.test(hash)) {
    void openMine();
    return true;
  }
  if (m[0]) {
    openReport({ kind: m[1] ?? 'bug' });
    return true;
  }
  return false;
}

export function initHub(o = {}) {
  st.demo = Boolean(o.demo);
  st.openSettings = o.openSettings ?? null;
  $('#hub-first-ok').addEventListener('click', () => void firstRun('dismiss'));
  $('#hub-first-off').addEventListener('click', () => void firstRun('off'));
  $('#hub-first-show').addEventListener('click', async () => {
    await firstRun('dismiss');
    await st.openSettings?.('dh-privacy');
    await showPreview();
  });
  $('#hub-banner-close').addEventListener('click', () => ($('#hub-banner').hidden = true));
  $('#hub-on').addEventListener('change', async () => {
    try {
      privacyStatus(await api('/hub', { method: 'PUT', body: { on: $('#hub-on').checked } }));
    } catch (err) {
      $('#hub-status').textContent = err.message;
    }
  });
  $('#hub-show').addEventListener('click', () => void showPreview());
  $('#hub-reset').addEventListener('click', async () => {
    if (!confirm(t('Make a new install ID? Later check-ins can’t be linked to earlier ones.'))) return;
    try {
      privacyStatus(await api('/hub/reset-id', { method: 'POST', body: {} }));
      if (!$('#hub-preview').hidden) await showPreview();
      $('#hub-status').textContent = t('A new install ID was made.');
    } catch (err) {
      $('#hub-status').textContent = err.message;
    }
  });
  const help = () => $('#help-menu').open && $('#help-menu').close();
  $('#help-report').addEventListener('click', () => {
    help();
    openReport({ kind: 'bug' });
  });
  $('#help-suggest').addEventListener('click', () => {
    help();
    openReport({ kind: 'idea' });
  });
  $('#help-mine').addEventListener('click', () => {
    help();
    void openMine();
  });
  $('#hub-kind').addEventListener('change', () => ($('#hub-report-title').textContent = $('#hub-kind').value === 'idea' ? t('Suggest something') : t('Report a problem')));
  $('#hub-diag-add').addEventListener('click', () => void addDiagnostics());
  $('#hub-report-send').addEventListener('click', () => void sendReport());
  $('#hub-report-cancel').addEventListener('click', () => $('#hub-report').close());
  $('#hub-mine-new').addEventListener('click', () => {
    $('#hub-mine').close();
    openReport({ kind: 'bug' });
  });
  if (st.demo) for (const id of ['#help-report', '#help-suggest', '#help-mine']) $(id).hidden = true;
  else void refresh();
}
