// U4.22 (docs/HEALTH.md): the Health place (a sidebar place): medicines with dose reminders, a
// taken/skipped log and refill estimates; appointments with prep questions, after-visit notes and an
// .ics for the calendar; symptoms, mood, sleep and measurements with quick add and simple charts; a
// doctor summary PDF for a date range; a parent manages a child's medicines. Never medical advice.
// Its privacy switches live in Settings → You → What Sara knows → Health log (loadHealthSettings).
import { initCare, loadCare } from './care.js';
import { t } from './naming.js';
import { initSimpleHome } from './simple-home.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, showSettingsTab?: (page: string) => void } | null} */
let ctx = null;
let data = null;
let kid = '';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#hl-status');
  if (s) s.textContent = msg;
};
const when = (iso) => {
  try {
    return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
};
const dayOf = (d) => d.toISOString().slice(0, 10);
const valueOf = (e) => (typeof e.value !== 'number' ? '' : typeof e.value2 === 'number' ? `${e.value}/${e.value2}${e.unit ? ` ${e.unit}` : ''}` : e.scale ? `${e.value}/${e.scale}` : `${e.value}${e.unit ? ` ${e.unit}` : ''}`);
const TYPE_WORDS = () => ({ symptom: t('Symptom'), mood: t('Mood'), sleep: t('Sleep'), measure: t('Measurement') });
/** What a reading is called: mood and sleep in the person's language, others by the name they logged. */
const nameOf = (e) => (e.type === 'mood' || e.type === 'sleep') && e.name === e.type ? TYPE_WORDS()[e.type] : e.name;
async function call(path, o, ok) {
  try {
    const r = await ctx.api(path, o);
    if (ok) say(ok);
    return r;
  } catch (err) {
    say(err?.message ?? String(err));
    return undefined;
  }
}
const json = (method, body) => ({ method, body });

export function initHealth(c) {
  ctx = c;
  initCare(c); // V5.4
  initSimpleHome(c);
  $('#hl-quick-go')?.addEventListener('click', () => void quickAdd());
  $('#hl-quick')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void quickAdd();
    }
  });
  $('#hl-med-add')?.addEventListener('click', () => void addMed());
  $('#hl-appt-add')?.addEventListener('click', () => void addAppt());
  $('#hl-pdf')?.addEventListener('click', () => {
    const from = $('#hl-from').value;
    const to = $('#hl-to').value;
    location.href = `/api/health-log/summary.pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  });
  $('#hl-privacy')?.addEventListener('click', () => {
    $('#health')?.close();
    ctx.showSettingsTab?.('you-knows');
  });
  $('#hl-kid')?.addEventListener('change', () => {
    kid = $('#hl-kid').value;
    void renderKid();
  });
  $('#hl-kid-add')?.addEventListener('click', () => void addMed(kid));
  $('#hl-import-go')?.addEventListener('click', () => void importFile());
  const to = new Date();
  if ($('#hl-to')) $('#hl-to').value = dayOf(to);
  if ($('#hl-from')) $('#hl-from').value = dayOf(new Date(to.getTime() - 30 * 86_400_000));
}

export async function openHealth() {
  const d = $('#health');
  if (!d) return;
  if (!d.open) d.showModal();
  await loadHealth();
}

export async function loadHealth() {
  if (!ctx) return;
  const r = await call('/health-log');
  if (!r) return;
  data = r;
  render();
  void loadCare();
}

async function quickAdd() {
  const box = $('#hl-quick');
  const text = box.value.trim();
  if (!text) return;
  if (await call('/health-log/entries', json('POST', { text }), t('Logged.'))) {
    box.value = '';
    await loadHealth();
  }
}
async function addMed(forKid) {
  const p = forKid ? '#hl-kid-' : '#hl-med-';
  const name = $(`${p}name`).value.trim();
  if (!name) return say(t('Give the medicine a name.'));
  const body = { name, dose: $(`${p}dose`).value.trim(), times: $(`${p}times`).value, ...($(`${p}supply`)?.value ? { supply: Number($(`${p}supply`).value), refilledOn: dayOf(new Date()) } : {}) };
  const path = forKid ? `/health-log/kids/${encodeURIComponent(forKid)}/meds` : '/health-log/meds';
  if (await call(path, json('POST', body), t('Medicine added.'))) {
    for (const f of ['name', 'dose', 'times', 'supply']) if ($(`${p}${f}`)) $(`${p}${f}`).value = '';
    if (forKid) await renderKid();
    else await loadHealth();
  }
}
async function addAppt() {
  const title = $('#hl-appt-title').value.trim();
  const at = $('#hl-appt-when').value;
  if (!title || !at) return say(t('Give the appointment a name and a time.'));
  if (await call('/health-log/appts', json('POST', { title, when: new Date(at).toISOString(), where: $('#hl-appt-where').value.trim() }), t('Appointment added.'))) {
    for (const f of ['title', 'when', 'where']) $(`#hl-appt-${f}`).value = '';
    await loadHealth();
  }
}

function render() {
  renderDue();
  renderMeds();
  renderCharts();
  renderEntries();
  renderTrends();
  renderImports();
  renderAppts();
  const kids = data.kids ?? [];
  const box = $('#hl-kids');
  if (box) box.hidden = !kids.length;
  const sel = $('#hl-kid');
  if (sel && kids.length) {
    sel.replaceChildren(...kids.map((k) => Object.assign(document.createElement('option'), { value: k.id, textContent: k.name })));
    kid = kids.some((k) => k.id === kid) ? kid : kids[0].id;
    sel.value = kid;
    void renderKid();
  }
}

function medName(id, meds = data.meds) {
  return meds.find((m) => m.id === id)?.name ?? t('Medicine');
}
function renderDue() {
  const list = $('#hl-due');
  const due = data.doses.filter((d) => d.status === 'due');
  list.replaceChildren();
  $('#hl-due-h').hidden = !due.length;
  for (const d of due) {
    const row = el('div', 'hl-row');
    row.append(el('span', 'hl-row-main', `${medName(d.medId)} · ${when(d.due)}`));
    row.append(btn(t('Taken'), 'small', () => void mark(d.id, 'taken')), btn(t('Skipped'), 'small ghost', () => void mark(d.id, 'skipped')));
    list.append(row);
  }
}
async function mark(id, status) {
  if (await call(`/health-log/doses/${id}`, json('POST', { status }), status === 'taken' ? t('Marked taken.') : t('Marked skipped.'))) await loadHealth();
}

function medCard(m, opts) {
  const card = el('div', 'hl-card');
  const top = el('div', 'hl-row');
  const main = el('div', 'hl-row-main');
  main.append(el('strong', '', m.name), el('span', 'muted small', ` ${m.dose ?? ''} · ${m.times.length ? m.times.join(', ') : t('no set time')}`));
  top.append(main);
  if (opts.log) top.append(btn(t('Taken'), 'small', () => void opts.log(m.id, 'taken')), btn(t('Skipped'), 'small ghost', () => void opts.log(m.id, 'skipped')));
  top.append(btn(t('Remove'), 'small ghost', () => void opts.remove(m.id)));
  card.append(top);
  if (m.refill) {
    const r = m.refill;
    const p = el('p', `small ${r.soon ? 'hl-soon' : 'muted'}`, t('About {n} left; refill by {date}.', { n: r.left, date: new Date(`${r.date}T12:00:00`).toLocaleDateString() }));
    card.append(p);
  }
  if (m.managedBy === 'parent') card.append(el('p', 'muted small', t('Managed by a parent.')));
  return card;
}
function renderMeds() {
  const list = $('#hl-meds');
  list.replaceChildren();
  if (!data.meds.length) list.append(el('p', 'muted small', t('No medicines yet.')));
  for (const m of data.meds)
    list.append(
      medCard(m, {
        log: async (id, status) => {
          if (await call('/health-log/doses', json('POST', { medId: id, status }), status === 'taken' ? t('Marked taken.') : t('Marked skipped.'))) await loadHealth();
        },
        remove: async (id) => {
          if (!confirm(t('Remove this medicine and its dose log?'))) return;
          if (await call(`/health-log/meds/${id}`, { method: 'DELETE' }, t('Removed.'))) await loadHealth();
        },
      }),
    );
}

/** A small line chart (two lines for blood pressure), drawn with theme colors. */
function chart(points) {
  const W = 260;
  const H = 64;
  const vals = points.flatMap((p) => [p.value, p.value2].filter((v) => typeof v === 'number'));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i) => (points.length === 1 ? W / 2 : 4 + (i * (W - 8)) / (points.length - 1));
  const y = (v) => (hi === lo ? H / 2 : H - 6 - ((v - lo) * (H - 12)) / (hi - lo));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'hl-chart');
  svg.setAttribute('aria-hidden', 'true');
  for (const [key, cls] of [['value', 'hl-line'], ['value2', 'hl-line hl-line2']]) {
    const pts = points.map((p, i) => (typeof p[key] === 'number' ? `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}` : '')).filter(Boolean);
    if (!pts.length) continue;
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('class', cls);
    svg.append(line);
    for (const pt of pts) {
      const [cx, cy] = pt.split(',');
      const c = document.createElementNS(ns, 'circle');
      Object.entries({ cx, cy, r: '2.5', class: cls.replace('hl-line', 'hl-dot') }).forEach(([k, v]) => c.setAttribute(k, v));
      svg.append(c);
    }
  }
  return svg;
}
function renderCharts() {
  const box = $('#hl-charts');
  box.replaceChildren();
  for (const name of data.names.slice(0, 8)) {
    const pts = data.entries.filter((e) => e.name === name && typeof e.value === 'number').reverse().slice(-30);
    if (pts.length < 1) continue;
    const card = el('div', 'hl-chart-card');
    const last = pts.at(-1);
    card.append(el('div', 'hl-chart-head', `${nameOf(last)} · ${valueOf(last)}`), chart(pts));
    box.append(card);
  }
}
// ---------- V4.3: trends and imports from a watch or phone app
const METRIC_WORDS = () => ({ steps: t('Steps'), sleep: t('Sleep'), 'heart rate': t('Heart rate'), 'resting heart rate': t('Resting heart rate'), weight: t('Weight') });
// Product names stay as they are in every language.
const SOURCE_WORDS = () => ({ apple: 'Apple Health', google: 'Google Fit', garmin: 'Garmin' });
const amount = (v, unit) => (unit === 'steps' ? t('{n} steps', { n: Math.round(v).toLocaleString() }) : unit === 'h' ? t('{n} h', { n: v.toLocaleString(undefined, { maximumFractionDigits: 1 }) }) : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`);
const shortDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
async function importFile() {
  const box = $('#hl-import-file');
  const f = box?.files?.[0];
  if (!f) return say(t('Pick a file first.'));
  const go = $('#hl-import-go');
  go.disabled = true;
  say(t('Reading {name}…', { name: f.name }));
  try {
    const res = await fetch(`/api/health-log/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return say(r.error ?? t('That did not work. Try again.'));
    say(r.added || r.updated ? t('Imported from {source}: {added} new, {updated} updated.', { source: SOURCE_WORDS()[r.source] ?? r.source, added: r.added, updated: r.updated }) : t('Nothing new: everything in this file is already in Health.'));
    box.value = '';
    await loadHealth();
  } catch (err) {
    say(err?.message ?? String(err));
  } finally {
    go.disabled = false;
  }
}
function renderTrends() {
  const box = $('#hl-trends');
  if (!box) return;
  box.replaceChildren();
  const trends = data.trends ?? [];
  if (!trends.length) box.append(el('p', 'muted small', t('No trends yet. Import a file from your watch or phone below, or log sleep and weight by hand.')));
  for (const tr of trends) {
    const card = el('div', 'hl-chart-card hl-trend');
    card.append(el('div', 'hl-chart-head', `${METRIC_WORDS()[tr.name] ?? tr.name} · ${amount(tr.last.value, tr.unit)}`));
    card.append(chart(tr.points));
    const sub = el('div', 'hl-trend-sub small');
    sub.append(el('span', '', t('7-day average: {v}', { v: amount(tr.avg7, tr.unit) })));
    if (typeof tr.change === 'number') sub.append(el('span', 'hl-change', tr.change > 0 ? t('{n}% more than the week before', { n: tr.change }) : tr.change < 0 ? t('{n}% less than the week before', { n: -tr.change }) : t('same as the week before')));
    sub.append(el('span', 'muted', t('30 days to {date}', { date: shortDay(tr.last.day) })));
    card.append(sub);
    box.append(card);
  }
}
function renderImports() {
  const list = $('#hl-imports');
  if (!list) return;
  list.replaceChildren();
  for (const im of (data.imports ?? []).slice(0, 10)) {
    const row = el('div', 'hl-row');
    const span = im.from ? (im.from === im.to ? shortDay(im.from) : `${shortDay(im.from)} – ${shortDay(im.to)}`) : '';
    row.append(el('span', 'hl-row-main small', `${SOURCE_WORDS()[im.source] ?? im.source} · ${im.file || t('a file')} · ${when(im.at)} · ${t('{n} added', { n: im.added })}${span ? ` (${span})` : ''}`));
    row.append(
      btn(t('Undo import'), 'small ghost', async () => {
        if (!confirm(t('Remove what this import added?'))) return;
        const r = await call(`/health-log/imports/${im.id}`, { method: 'DELETE' });
        if (r) {
          say(t('Removed {n} readings.', { n: r.removed }));
          await loadHealth();
        }
      }),
    );
    list.append(row);
  }
}

function renderEntries() {
  const list = $('#hl-entries');
  list.replaceChildren();
  if (!data.entries.length) list.append(el('p', 'muted small', t('Nothing logged yet. Try “headache 6/10” or “BP 128/82”.')));
  for (const e of data.entries.slice(0, 20)) {
    const row = el('div', 'hl-row');
    row.append(el('span', 'hl-row-main', `${when(e.at)} · ${nameOf(e)} ${valueOf(e)}${e.note ? ` (${e.note})` : ''}`));
    row.append(
      btn(t('Delete'), 'small ghost', async () => {
        if (await call(`/health-log/entries/${e.id}`, { method: 'DELETE' }, t('Removed.'))) await loadHealth();
      }),
    );
    list.append(row);
  }
}
function renderAppts() {
  const list = $('#hl-appts');
  list.replaceChildren();
  if (!data.appts.length) list.append(el('p', 'muted small', t('No appointments yet.')));
  for (const a of data.appts) {
    const card = el('div', 'hl-card');
    const top = el('div', 'hl-row');
    const main = el('div', 'hl-row-main');
    main.append(el('strong', '', a.title), el('span', 'muted small', ` ${when(a.when)}${a.where ? ` · ${a.where}` : ''}`));
    const ics = el('a', 'small', t('Add to calendar'));
    ics.href = `/api/health-log/appts/${a.id}/ics`;
    ics.setAttribute('download', 'appointment.ics');
    top.append(
      main,
      ics,
      btn(t('Remove'), 'small ghost', async () => {
        if (!confirm(t('Remove this appointment?'))) return;
        if (await call(`/health-log/appts/${a.id}`, { method: 'DELETE' }, t('Removed.'))) await loadHealth();
      }),
    );
    card.append(top);
    const qs = el('ul', 'hl-qs');
    for (const q of a.questions) qs.append(el('li', '', q));
    card.append(el('div', 'small muted', t('Questions to ask')), qs);
    const add = el('div', 'hl-row');
    const qIn = el('input');
    qIn.maxLength = 300;
    qIn.placeholder = t('Add a question');
    qIn.setAttribute('aria-label', t('Add a question'));
    add.append(
      qIn,
      btn(t('Add'), 'small', async () => {
        if (!qIn.value.trim()) return;
        if (await call(`/health-log/appts/${a.id}`, json('PATCH', { addQuestion: qIn.value }), t('Saved.'))) await loadHealth();
      }),
    );
    card.append(add);
    const notes = el('textarea', 'hl-notes');
    notes.rows = 2;
    notes.maxLength = 4000;
    notes.value = a.notes ?? '';
    notes.placeholder = t('After the visit: what the doctor said, next steps');
    notes.setAttribute('aria-label', t('After-visit notes'));
    notes.addEventListener('change', () => void call(`/health-log/appts/${a.id}`, json('PATCH', { notes: notes.value }), t('Saved.')));
    card.append(notes);
    list.append(card);
  }
}

async function renderKid() {
  const list = $('#hl-kid-meds');
  if (!list || !kid) return;
  const r = await call(`/health-log/kids/${encodeURIComponent(kid)}`);
  if (!r) return;
  list.replaceChildren();
  if (!r.meds.length) list.append(el('p', 'muted small', t('No medicines yet.')));
  for (const m of r.meds)
    list.append(
      medCard(m, {
        log: async (id, status) => {
          if (await call(`/health-log/kids/${encodeURIComponent(kid)}/doses`, json('POST', { medId: id, status }), status === 'taken' ? t('Marked taken.') : t('Marked skipped.'))) await renderKid();
        },
        remove: async (id) => {
          if (!confirm(t('Remove this medicine and its dose log?'))) return;
          if (await call(`/health-log/kids/${encodeURIComponent(kid)}/meds/${id}`, { method: 'DELETE' }, t('Removed.'))) await renderKid();
        },
      }),
    );
}

/** Settings → You → What Sara knows → Health log (the four switches save on change). */
export async function loadHealthSettings(api) {
  const call2 = api ?? ctx?.api;
  if (!call2 || !$('#hs-cloud')) return;
  let r;
  try {
    r = await call2('/health-log');
  } catch {
    return;
  }
  const map = { 'hs-cloud': 'cloudOk', 'hs-ask': 'includeInAsk', 'hs-remind': 'reminders', 'hs-names': 'namesInAlerts' };
  for (const [id, key] of Object.entries(map)) {
    const box = $(`#${id}`);
    box.checked = Boolean(r.settings[key]);
    if (box.dataset.wired) continue;
    box.dataset.wired = '1';
    box.addEventListener('change', async () => {
      const s = $('#hs-state');
      try {
        await call2('/health-log/settings', { method: 'PUT', body: { [key]: box.checked } });
        if (s) s.textContent = t('Saved.');
      } catch (err) {
        box.checked = !box.checked;
        if (s) s.textContent = err?.message ?? String(err);
      }
    });
  }
}
