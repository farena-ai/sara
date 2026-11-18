// U5.34 (docs/DASHBOARD.md): the server dashboard at the top of Settings → Privacy & system → Health.
// One card per server: this one, and each linked server that gave you an active help pass (read through
// its support report, the same one "Look at <name>'s Sara" shows). Colors: green fine, amber look soon,
// red needs you, grey not reported. Every row links to the page with the details.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {((path: string, o?: object) => Promise<any>) | null} */
let api = null;
let busy = false;

const LABEL = { health: 'Health', versions: 'Versions', disk: 'Disk space', memory: 'Memory', cpu: 'Processor load', backups: 'Backups', errors: 'Recent errors', repair: 'Self-repair', updates: 'Updates' };
const STATE = { ok: 'Fine', warn: 'Look soon', bad: 'Needs you', unknown: 'Not reported' };
const APP = { windows: 'Windows app', mac: 'Mac app' };

export function initDashboard(c) {
  api = c.api;
  $('#dash-refresh')?.addEventListener('click', () => void loadDashboard({ refresh: true }));
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

/** Opens a row's details: a Settings page here, or Messages (the friend's chat) for a linked server. */
function open(row) {
  if (row.page) location.hash = `#view=settings:${row.page}`;
  else if (row.view) {
    const s = $('#settings');
    if (s?.open) s.close();
    location.hash = `#view=${row.view}`;
  }
}

function card(c) {
  const box = el('div', 'dash-card');
  box.dataset.state = c.state;
  const head = el('div', 'dash-card-head');
  head.append(el('strong', 'dash-name', c.self ? t('This server') : c.name), el('span', `dash-pill dash-${c.state}`, t(STATE[c.state] ?? c.state)));
  box.append(head);
  box.append(el('p', 'muted small dash-when', t('Checked {when}', { when: when(c.checkedAt) })));
  if (c.error) box.append(el('p', 'small dash-error', t('Could not read it: {error}', { error: c.error })));
  const ul = el('ul', 'dash-rows');
  for (const r of c.rows) {
    const li = el('li', `dash-row dash-${r.state}`);
    li.dataset.key = r.key;
    const dot = el('span', 'dash-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = el('span', 'dash-text');
    text.append(el('span', 'dash-label', t(LABEL[r.key] ?? r.key)), ' ', el('span', 'dash-val', t(r.text, r.params)));
    if (r.key === 'versions' && c.apps?.length) text.append(el('span', 'muted dash-apps', c.apps.map((a) => `${t(APP[a.kind] ?? a.kind)} ${a.version}${a.behind ? ` (${t('older')})` : ''}`).join(' · ')));
    const go = el('button', 'ghost small dash-go', t('Details'));
    go.type = 'button';
    go.setAttribute('aria-label', `${t(LABEL[r.key] ?? r.key)}: ${t('Details')}`);
    go.addEventListener('click', () => open(r));
    li.append(dot, text, go);
    li.title = t(STATE[r.state] ?? r.state);
    ul.append(li);
  }
  if (c.rows.length) box.append(ul);
  return box;
}

export async function loadDashboard(o = {}) {
  const host = $('#dash-cards');
  if (!host || !api || busy) return;
  busy = true;
  const status = $('#dash-status');
  const btn = $('#dash-refresh');
  if (btn) btn.disabled = true;
  if (status) status.textContent = o.refresh ? t('Checking every server…') : '';
  try {
    let d = await api(o.refresh ? '/dashboard/refresh' : '/dashboard', o.refresh ? { method: 'POST', body: {} } : undefined);
    // Linked servers not read yet since this page opened: read them once by themselves.
    if (!o.refresh && d.linked?.some((l) => !l.read)) {
      host.replaceChildren(...d.servers.map(card));
      if (status) status.textContent = t('Checking every server…');
      d = await api('/dashboard/refresh', { method: 'POST', body: {} });
    }
    host.replaceChildren(...d.servers.map(card));
    if (status) status.textContent = d.linked?.length ? t('Linked servers shown while their owner gives you a help pass.') : t('Linked servers show here while their owner gives you a help pass (Messages → their chat).');
  } catch (e) {
    if (status) status.textContent = e.message;
  } finally {
    busy = false;
    if (btn) btn.disabled = false;
  }
}
