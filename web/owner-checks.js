// U1.5 (docs/TRY_THESE.md): Help → Try these, the owner's guided checklist. Short "try this" items
// from the newest releases (src/owner-checks.ts), newest release first, with progress, Take me there,
// what you should see, and Worked / Didn't work / Skip plus a note. A Didn't work note can go to her
// as a self-repair request (repair_status / repair_fix in a new chat). Send results to the developer
// is off until the owner ticks it; Preview shows exactly what Send sends (the existing hub ticket
// path, scrubbed on the server). Export as Markdown downloads the results.
import { currentIdentity, serverText, t } from './naming.js';

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

const ctx = { ask: null, openMine: null };
let view = null;
const RESULTS = [
  ['worked', () => t('Worked')],
  ['failed', () => t('Didn’t work')],
  ['skipped', () => t('Skip')],
];
const status = (text) => ($('#try-status').textContent = text);

/** The text she gets for "Ask her to fix it" (lean words "is broken" / "check yourself" offer repair_*). */
export function fixRequest(item, note) {
  const said = String(note || '').trim();
  return t('“{title}” didn’t work for me. {note} It is broken: check yourself and fix what you can.', { title: t(item.title), note: said ? (/[.!?…]$/.test(said) ? said : `${said}.`) : t(item.expect) });
}

function go(item) {
  $('#try-these').close();
  if (item.ask) return void ctx.ask?.(t(item.ask));
  location.hash = item.view;
}

async function mark(item, result, note) {
  try {
    view = await api(`/owner-checks/${encodeURIComponent(item.id)}`, { method: 'PUT', body: { result, note } });
    render();
  } catch (err) {
    status(err.message);
  }
}

function card(item) {
  const box = el('article', 'ochk-item');
  box.dataset.id = item.id;
  if (item.result) box.dataset.result = item.result;
  const head = el('div', 'ochk-item-head');
  head.append(el('strong', '', t(item.title)));
  if (item.new) head.append(el('span', 'ochk-chip ochk-new', t('New')));
  if (item.result) head.append(el('span', `ochk-chip ochk-${item.result}`, RESULTS.find(([k]) => k === item.result)[1]()));
  const steps = el('ol', 'ochk-steps');
  for (const s of item.steps) steps.append(el('li', '', t(s)));
  const exp = el('p', 'small ochk-expect');
  exp.append(el('span', 'muted', `${t('What you should see:')} `), t(item.expect));
  const there = el('button', 'ghost small ochk-go', item.ask ? t('Start the chat') : t('Take me there'));
  there.type = 'button';
  there.addEventListener('click', () => go(item));
  const picks = el('div', 'ochk-picks');
  picks.setAttribute('role', 'group');
  picks.setAttribute('aria-label', t('How did it go?'));
  const note = el('textarea', 'ochk-note');
  note.rows = 2;
  note.maxLength = 500;
  note.placeholder = t('A note (optional): what happened instead?');
  note.setAttribute('aria-label', t('Note for {title}', { title: t(item.title) }));
  note.value = item.note ?? '';
  note.hidden = !item.result;
  for (const [k, label] of RESULTS) {
    const b = el('button', 'ghost small', label());
    b.type = 'button';
    b.setAttribute('aria-pressed', String(item.result === k));
    b.addEventListener('click', () => void mark(item, item.result === k ? null : k, note.value));
    picks.append(b);
  }
  picks.prepend(there);
  note.addEventListener('change', () => item.result && void mark(item, item.result, note.value));
  box.append(head, steps);
  if (item.ask) box.append(el('p', 'ochk-ask', `“${t(item.ask)}”`));
  box.append(exp, picks, note);
  if (item.result === 'failed') {
    const fix = el('button', 'small ochk-fix', t('Ask {name} to fix it', { name: currentIdentity()?.name || t('Sara') }));
    fix.type = 'button';
    fix.title = t('Opens a new chat asking her to check herself (self-repair) and fix it, with your note.');
    fix.addEventListener('click', () => {
      $('#try-these').close();
      ctx.ask?.(fixRequest(item, note.value.trim()));
    });
    box.append(fix);
  }
  return box;
}

function render() {
  if (!view) return;
  $('#try-progress').textContent = t('{done} of {total} tried: {worked} worked, {failed} didn’t work, {skipped} skipped', { done: view.done, total: view.total, ...view.counts });
  $('#try-bar').max = view.total;
  $('#try-bar').value = view.done;
  const byId = new Map(view.items.map((i) => [i.id, i]));
  $('#try-list').replaceChildren(
    ...view.groups.map((g) => {
      const sec = el('section', 'ochk-group');
      const items = g.ids.map((id) => byId.get(id));
      const done = items.filter((i) => i.result).length;
      sec.append(el('h3', '', t('New in {version}', { version: g.release })), el('p', 'muted small', t('{done} of {total} tried', { done, total: items.length })), ...items.map(card));
      return sec;
    }),
  );
  $('#try-send-on').checked = view.sendOn;
  $('#try-send').disabled = !view.sendOn || !view.done;
  $('#try-send-when').textContent = view.sentAt ? t('Last sent {when} as {ticket}.', { when: new Date(view.sentAt).toLocaleString(), ticket: view.ticket }) : '';
}

/** `focus`: a Try these id to scroll to (What's new → Try it). */
export async function openTryThese(focus) {
  const d = $('#try-these');
  if (!d.open) d.showModal();
  status('');
  $('#try-preview-box').hidden = true;
  try {
    view = await api('/owner-checks');
    render();
    const spot = focus ? [...$('#try-list').querySelectorAll('.ochk-item')].find((n) => n.dataset.id === focus) : null;
    if (spot) {
      spot.classList.add('ochk-focus');
      spot.scrollIntoView({ block: 'center' });
    }
    const fresh = view.items.filter((i) => i.new).map((i) => i.id);
    // Seen once the list was shown: they stay marked New until the next time it opens.
    if (fresh.length) void api('/owner-checks/seen', { method: 'POST', body: { ids: fresh } }).catch(() => {});
  } catch (err) {
    status(err.message);
  }
}

async function preview() {
  const box = $('#try-preview-box');
  try {
    const p = await api('/owner-checks/preview');
    box.textContent = `${p.title}\n\n${p.body}`;
    box.hidden = false;
  } catch (err) {
    status(err.message);
  }
}

async function sendResults() {
  status(t('Sending…'));
  try {
    view = await api('/owner-checks/send', { method: 'POST', body: {} });
    render();
    status(t('Sent as {ticket}. Follow it in Help → My reports.', { ticket: view.ticket }));
  } catch (err) {
    status(err.message);
  }
}

export function initOwnerChecks(o = {}) {
  ctx.ask = o.ask ?? null;
  ctx.openMine = o.openMine ?? null;
  const d = $('#try-these');
  if (!d) return;
  $('#help-try')?.addEventListener('click', () => {
    if ($('#help-menu').open) $('#help-menu').close();
    void openTryThese();
  });
  $('#try-preview').addEventListener('click', () => void preview());
  $('#try-send').addEventListener('click', () => void sendResults());
  $('#try-send-on').addEventListener('change', async (e) => {
    try {
      view = await api('/owner-checks', { method: 'PUT', body: { sendOn: e.target.checked } });
      render();
    } catch (err) {
      status(err.message);
    }
  });
  if (o.demo) $('#help-try').hidden = true;
}
