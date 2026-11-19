// R6 (docs/WORK_APPS.md): the work-app sections in Settings. Business details → Booking page and
// Accounting export; Gmail and Calendar → Docs and Sheets; Email and calendar → Word and Excel files.
// The extra Google/Microsoft permissions are only asked for when the person presses the button.
import { t } from './naming.js';
import { loadReception } from './receptionist.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
export function initWorkApps(c) {
  ctx = c;
}
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
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
const dayNames = () => [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')];
const field = (label, input, help) => {
  const l = el('label', 'wa-field');
  const head = el('span', 'wa-lab');
  head.append(el('span', '', label), ...(help ? [tip(help)] : []));
  l.append(head, input);
  return l;
};
const input = (id, type, value, attrs = {}) => {
  const i = el('input');
  i.id = id;
  i.type = type;
  i.value = String(value ?? '');
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, String(v));
  return i;
};
const select = (id, options, value) => {
  const s = el('select');
  s.id = id;
  for (const [v, label] of options) {
    const o = el('option', '', label);
    o.value = String(v);
    s.append(o);
  }
  s.value = String(value);
  return s;
};
const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export async function loadWorkApps(page) {
  if (!ctx) return;
  if (page === 'you-business') {
    await loadBooking();
    loadExport();
    // V3.5: the website receptionist (web/receptionist.js) shares this page and the booking requests.
    void loadReception(ctx);
  }
  if (page === 'ab-google') await loadDocsPermission();
  if (page === 'ab-mail') await loadFilesPermission();
}

// ---------------------------------------------------------------- booking page

async function loadBooking() {
  const host = $('#wa-book');
  if (!host) return;
  let d;
  try {
    d = await ctx.api('/booking');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  const s = d.settings;
  const status = $('#wa-book-status');
  const save = async (body) => {
    try {
      await ctx.api('/booking', { method: 'PUT', body });
      if (status) status.textContent = t('Saved.');
    } catch (e) {
      if (status) status.textContent = e.message;
    }
    void loadBooking();
  };
  const on = el('label', 'wa-check');
  const onBox = input('wa-book-on', 'checkbox', '');
  onBox.checked = s.on;
  on.append(onBox, el('span', '', t('Turn on my booking page')), tip(t('A public page where people pick a free time with you. Off by default; anyone with the link can see your free times (not what is in your calendar).')));
  const slug = input('wa-book-slug', 'text', s.slug, { maxlength: 40, placeholder: t('your-name') });
  const title = input('wa-book-title', 'text', s.title, { maxlength: 80 });
  const duration = select('wa-book-duration', [15, 20, 30, 45, 60, 90].map((n) => [n, t('{n} minutes', { n })]), s.duration);
  const buffer = select('wa-book-buffer', [0, 5, 10, 15, 30].map((n) => [n, t('{n} minutes', { n })]), s.buffer);
  const maxDay = input('wa-book-max', 'number', s.maxPerDay, { min: 1, max: 20 });
  const ahead = input('wa-book-ahead', 'number', s.daysAhead, { min: 1, max: 60 });
  const notice = input('wa-book-notice', 'number', s.minNoticeHours, { min: 0, max: 168 });
  const approval = select('wa-book-approval', [['ask', t('Ask me first')], ['auto', t('Confirm on its own')]], s.approval);
  const cal = select('wa-book-calendar', [['', t('The first one connected')], ...d.calendars.map((c) => [c.id, c.label])], s.calendar);
  const note = input('wa-book-note', 'text', s.note, { maxlength: 300, placeholder: t('e.g. We meet on Zoom; I send the link.') });
  const grid = el('div', 'wa-grid');
  grid.append(
    field(t('Page name'), slug, t('The end of the link: /book/your-name. Letters, digits and dashes.')),
    field(t('Meeting name'), title),
    field(t('Length'), duration),
    field(t('Buffer'), buffer, t('Kept free before and after each meeting.')),
    field(t('At most per day'), maxDay),
    field(t('Days ahead'), ahead, t('How far ahead people can book.')),
    field(t('Notice (hours)'), notice, t('The soonest someone can book, counted from now.')),
    field(t('New bookings'), approval, t('Ask me first: you confirm each request here (and get a notice). Confirm on its own: the event and the email go out at once.')),
    field(t('Calendar'), cal, t('Where the events go. Free time is read from every connected calendar and your planner.')),
  );
  const noteRow = field(t('A line for visitors'), note);
  // Weekly windows: one row per day.
  const wins = el('div', 'wa-days');
  const rows = dayNames().map((name, day) => {
    const w = s.windows.find((x) => x.day === day);
    const r = el('div', 'wa-day');
    const c = input(`wa-day-${day}`, 'checkbox', '');
    c.checked = Boolean(w);
    const a = input(`wa-day-${day}-start`, 'time', w?.start ?? '09:00');
    const b = input(`wa-day-${day}-end`, 'time', w?.end ?? '17:00');
    a.setAttribute('aria-label', t('From'));
    b.setAttribute('aria-label', t('To'));
    const l = el('label', 'wa-check');
    l.append(c, el('span', '', name));
    r.append(l, a, el('span', 'muted small', '–'), b);
    wins.append(r);
    return { day, c, a, b };
  });
  const collect = () => ({
    on: onBox.checked,
    slug: slug.value,
    title: title.value,
    duration: Number(duration.value),
    buffer: Number(buffer.value),
    maxPerDay: Number(maxDay.value),
    daysAhead: Number(ahead.value),
    minNoticeHours: Number(notice.value),
    approval: approval.value,
    calendar: cal.value,
    note: note.value,
    windows: rows.filter((r) => r.c.checked).map((r) => ({ day: r.day, start: r.a.value, end: r.b.value })),
  });
  const saveBtn = btn(t('Save booking page'), '', () => void save(collect()));
  onBox.addEventListener('change', () => void save(collect()));
  const link = el('p', 'small');
  if (d.url && s.on) {
    const a = el('a', '', d.url);
    a.href = d.url;
    a.target = '_blank';
    a.rel = 'noopener';
    link.append(el('span', 'muted', `${t('Your page:')} `), a, ' ', btn(t('Copy'), 'ghost small', () => navigator.clipboard?.writeText(d.url)));
  } else link.append(el('span', 'muted', t('Off. Nobody can see a booking page.')));
  const warn = [];
  if (!d.calendars.length) warn.push(t('Connect a calendar first (Gmail and Calendar, or Email and calendar): confirmed bookings become events there.'));
  if (!d.mailbox) warn.push(t('Connect a mailbox too: the confirmation email goes out from it.'));
  // Requests.
  const reqs = el('ul', 'wa-reqs');
  for (const r of d.requests) {
    const li = el('li', `wa-req wa-${r.status}`);
    const head = el('div', 'wa-req-head');
    head.append(el('strong', '', `${when(r.start)} · ${r.name}`), el('span', 'muted small', ` ${r.email} · ${r.status === 'pending' ? t('waiting for you') : r.status === 'confirmed' ? t('confirmed') : t('declined')}`));
    li.append(head);
    if (r.note) li.append(el('p', 'small', r.note));
    if (r.outcome) li.append(el('p', 'muted small', r.outcome));
    if (r.status === 'pending') {
      const row = el('div', 'add-row');
      const act = (what) => async () => {
        try {
          await ctx.api(`/booking/requests/${r.id}/${what}`, { method: 'POST', body: {} });
        } catch (e) {
          if (status) status.textContent = e.message;
        }
        void loadBooking();
      };
      row.append(btn(t('Confirm'), '', act('confirm')), btn(t('Decline'), 'ghost', act('decline')));
      li.append(row);
    }
    reqs.append(li);
  }
  host.replaceChildren(on, link, ...warn.map((w) => el('p', 'muted small', w)), grid, noteRow, el('p', 'small wa-sub', t('When you are free')), wins, el('div', 'add-row'), ...(d.requests.length ? [el('p', 'small wa-sub', t('Requests')), reqs] : []));
  host.querySelector('.add-row').append(saveBtn);
}

// ---------------------------------------------------------------- accounting export

function loadExport() {
  const host = $('#wa-acct');
  if (!host || host.dataset.ready) return;
  host.dataset.ready = '1';
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = input('wa-acct-from', 'date', iso(first));
  const to = input('wa-acct-to', 'date', iso(last));
  const format = select('wa-acct-format', [['quickbooks', 'QuickBooks Online'], ['xero', 'Xero'], ['generic', t('Generic CSV')]], 'quickbooks');
  const what = select('wa-acct-what', [['invoices', t('Invoices')], ['expenses', t('Expenses')], ['time', t('Time')]], 'invoices');
  const out = el('p', 'muted small');
  out.setAttribute('role', 'status');
  const grid = el('div', 'wa-grid');
  grid.append(field(t('From'), from), field(t('To'), to), field(t('Format'), format, t('QuickBooks Online and Xero import these files as they are. Generic puts invoices, expenses and time in one file.')), field(t('What'), what));
  format.addEventListener('change', () => {
    what.disabled = format.value === 'generic';
  });
  const go = btn(t('Download CSV'), '', async () => {
    const q = new URLSearchParams({ from: from.value, to: to.value, format: format.value, what: format.value === 'generic' ? 'all' : what.value });
    try {
      const r = await fetch(`/api/accounting/export?${q}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? String(r.status));
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      out.textContent = t('{n} rows in {name}. Nothing was sent anywhere.', { n: r.headers.get('x-rows') ?? '0', name });
    } catch (e) {
      out.textContent = e.message;
    }
  });
  const row = el('div', 'add-row');
  row.append(go);
  host.replaceChildren(grid, row, out);
}

// ---------------------------------------------------------------- the extra permissions

async function loadDocsPermission() {
  const host = $('#wa-google');
  if (!host) return;
  const g = await ctx.api('/google').catch(() => null);
  if (!g?.connected) {
    host.replaceChildren(el('p', 'muted small', t('Sign in with Google first.')));
    return;
  }
  const allow = btn(t('Allow Docs and Sheets'), '', async () => {
    try {
      const { url } = await ctx.api('/google/connect', { method: 'POST', body: { docs: true } });
      location.href = url;
    } catch (e) {
      host.append(el('p', 'muted small', e.message));
    }
  });
  host.replaceChildren(g.docs ? el('p', 'small', t('Allowed: she can read your Google Docs and Sheets by link, and changes ask you first.')) : el('p', 'muted small', t('Not allowed yet. Google shows a new permission page; nothing else changes.')), ...(g.docs ? [] : [allow]));
}

async function loadFilesPermission() {
  const host = $('#wa-ms');
  if (!host) return;
  const d = await ctx.api('/mail').catch(() => null);
  const ms = (d?.accounts ?? []).filter((a) => a.kind === 'microsoft');
  if (!ms.length) {
    host.replaceChildren(el('p', 'muted small', t('Add an Outlook or Microsoft 365 account first.')));
    return;
  }
  const list = el('ul', 'wa-reqs');
  for (const a of ms) {
    const li = el('li', 'wa-req');
    li.append(el('strong', '', a.address), el('span', 'muted small', ` ${a.files ? t('Word and Excel files allowed') : t('files not allowed yet')}`));
    if (!a.files)
      li.append(
        ' ',
        btn(t('Allow Word and Excel files'), 'small', async () => {
          try {
            const { url } = await ctx.api('/mail/microsoft/connect', { method: 'POST', body: { address: a.address, files: true } });
            location.href = url;
          } catch (e) {
            li.append(el('p', 'muted small', e.message));
          }
        }),
      );
    list.append(li);
  }
  host.replaceChildren(list);
}
