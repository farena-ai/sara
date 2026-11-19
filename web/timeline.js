// V5.1 (docs/design/V5TIMELINE.md): Settings → Privacy & system → Reports → Action timeline.
// What she changed for this person, newest first: Revert where Sara has a way back, and a plain
// "can't be undone" reason where not. Server: src/routes/timeline.ts (each space its own).
import { serverText, t } from './naming.js';

/** @type {{ openChat?: (id: string) => void }} */
let ctx = {};
let before = 0;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const KIND = () => ({ files: t('Files'), settings: t('Settings'), mail: t('Mail'), calendar: t('Calendar'), planner: t('Planner'), other: t('Other') });
const ICON = { files: '📄', settings: '⚙', mail: '✉', calendar: '📅', planner: '✓', other: '•' };

const when = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function row(item) {
  const li = el('li', 'tl-row');
  li.dataset.id = String(item.id);
  li.dataset.kind = item.kind;
  const head = el('div', 'tl-head');
  const icon = el('span', 'tl-icon', ICON[item.kind] ?? '•');
  icon.setAttribute('aria-hidden', 'true');
  const main = el('div', 'tl-main');
  const line = item.title ? t(item.title, item.params ?? {}) : item.summary;
  main.append(el('strong', 'tl-sum', line));
  const meta = el('span', 'tl-meta muted small', `${KIND()[item.kind] ?? item.kind} · ${when(item.at)}`);
  main.append(meta);
  head.append(icon, main);
  li.append(head);
  const foot = el('div', 'tl-foot');
  if (item.revertedAt) foot.append(el('span', 'tl-done small', t('Reverted {when}', { when: when(item.revertedAt) })));
  else if (item.canRevert) {
    const b = btn(t('Revert'), 'ghost tl-revert', () => confirmRow(li, item));
    b.setAttribute('aria-label', t('Revert: {what}', { what: line }));
    foot.append(b);
  } else if (item.never) foot.append(el('span', 'tl-never muted small', t(item.never)));
  if (item.conversationId && ctx.openChat) {
    const a = el('a', 'tl-chat small', t('Open the chat'));
    a.href = '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      ctx.openChat?.(item.conversationId);
    });
    foot.append(a);
  }
  li.append(foot);
  return li;
}

function confirmRow(li, item) {
  const foot = li.querySelector('.tl-foot');
  if (!foot || li.querySelector('.tl-ask')) return;
  const ask = el('div', 'tl-ask');
  ask.setAttribute('role', 'group');
  const q = el('p', 'small', item.kind === 'files' ? t('Put the files back as they were before this? Later file changes in the same chat go back too; the files as they are now are kept as a snapshot.') : t('Put this back the way it was?'));
  const yes = btn(t('Yes, revert'), 'tl-yes', async () => {
    yes.disabled = true;
    no.disabled = true;
    try {
      const { item: done } = await api(`/timeline/${item.id}/revert`, { method: 'POST', body: {} });
      li.replaceWith(row(done));
      status(t('Reverted.'));
    } catch (err) {
      ask.remove();
      status(t(err.message), true);
      void loadTimeline();
    }
  });
  const no = btn(t('Keep it'), 'ghost', () => ask.remove());
  ask.append(q, yes, no);
  foot.after(ask);
  yes.focus();
}

function status(text, bad = false) {
  const s = $('#tl-status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('error', bad);
}

/** Draws the list (Settings loader; `o.openChat` comes from app.js). */
export async function loadTimeline(o) {
  if (o) ctx = o;
  const list = $('#tl-list');
  if (!list) return;
  const sel = $('#tl-kind');
  if (sel && !sel.dataset.wired) {
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => void loadTimeline());
    $('#tl-more')?.addEventListener('click', () => void more());
  }
  before = 0;
  list.replaceChildren();
  await more();
}

async function more() {
  const list = $('#tl-list');
  const kind = $('#tl-kind')?.value ?? '';
  try {
    const q = new URLSearchParams({ limit: '50', ...(kind ? { kind } : {}), ...(before ? { before: String(before) } : {}) });
    const { items } = await api(`/timeline?${q}`);
    for (const it of items) list.append(row(it));
    before = items.length ? items[items.length - 1].id : before;
    const more = $('#tl-more');
    if (more) more.hidden = items.length < 50;
    if (!list.children.length) status(kind ? t('Nothing of this kind yet.') : t('Nothing yet. When she changes files, settings, mail, your calendar or the planner for you, it shows up here.'));
    else status('');
  } catch (err) {
    status(t(err.message), true);
  }
}
