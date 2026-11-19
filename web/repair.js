// ROADMAP_T T1/T2 (docs/SELF_REPAIR.md): Settings → Privacy & system → Health → Self-repair.
// The permission ("small fixes on her own" or "ask me first"), the 24-hour full permission, problems now
// (Fix / Learn a skill / Not now / Open), and what she fixed (steps, Undo while it can be undone).
// U3.17: "Share fixes that worked" (off by default; the ticked linked friends), fixes friends shared that fit a
// problem here (Use it runs her own engine: T1 fix or a T3 change she tests; nothing runs by itself), what
// she shared, and "Send to the Sara developers" with the exact scrubbed preview first.
import { serverText, t } from './naming.js';

const $ = (s) => globalThis.document?.querySelector(s);
let state = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
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
const say = (m) => {
  const s = $('#repair-status');
  if (s) s.textContent = m;
};
const when = (iso) => {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
};
const RESULT = () => ({
  fixed: t('Fixed'),
  'not-fixed': t('Not fixed'),
  undone: t('Put back'),
  'needs-you': t('Needs you'),
  proposed: t('Suggested'),
  applied: t('On trial'),
  declined: t('Not now'),
  refused: t('Not allowed'),
  failed: t('Did not work'),
});
const SEV = () => ({ high: t('Serious'), medium: t('Needs a look'), low: t('Minor') });

async function act(fn, busy) {
  say(busy);
  try {
    state = await fn();
    const done = state.done ?? [];
    say(done.length ? t('{n} done. See each step below.', { n: done.length }) : '');
    paint();
  } catch (err) {
    say(err.message);
  }
}

function paint() {
  const box = $('#repair-view');
  if (!box || !state) return;
  const st = state.settings;
  const sel = $('#repair-permission');
  if (sel) {
    sel.value = st.permission;
    sel.dataset.loaded = '1';
  }
  const full = $('#repair-full');
  if (full) full.checked = st.fullOn;
  const until = $('#repair-full-until');
  if (until) until.textContent = st.fullOn ? t('until {when}', { when: when(st.fullUntil) }) : '';
  box.replaceChildren();
  // Problems now.
  const head = el('p', 'small muted', state.checkedAt ? t('Checked {when}.', { when: when(state.checkedAt) }) : '');
  box.append(head);
  const ps = state.problems ?? [];
  const list = el('ul', 'health rp-list');
  if (!ps.length) {
    const li = el('li', 'ok');
    li.append(el('span', 'mark', '✓'), document.createTextNode(t('Nothing is wrong right now.')));
    list.append(li);
  }
  for (const p of ps) {
    const li = el('li', p.severity === 'high' ? 'bad' : 'warn');
    li.append(el('span', 'mark', p.level === 2 ? '+' : '!'));
    const body = el('span', 'rp-body');
    body.append(el('strong', '', [SEV()[p.severity], p.area ? t(p.area) : ''].filter(Boolean).join(' · ')), document.createTextNode(t(p.text, p.params ?? {})));
    if (p.fix) body.append(el('span', 'muted small rp-fix', t(p.fix, p.params ?? {})));
    const row = el('span', 'rp-acts');
    if (p.fixable) row.append(btn(p.level === 2 ? t('Learn a skill') : t('Fix it'), 'small', () => act(() => api('/repair/fix', { method: 'POST', body: { problem: p.id } }), t('Fixing…'))));
    if (p.level === 2) row.append(btn(t('Not now'), 'ghost small', () => act(() => api('/repair/decline', { method: 'POST', body: { problem: p.id } }), '')));
    if (!p.fixable && p.page) row.append(btn(t('Open'), 'ghost small', () => (location.hash = `#view=settings:${p.page}`)));
    body.append(row);
    li.append(body);
    list.append(li);
  }
  box.append(list);
  // What she fixed.
  const runs = state.runs ?? [];
  if (runs.length) {
    box.append(el('p', 'small rp-sub', t('What she fixed')));
    const ul = el('ul', 'health rp-list');
    for (const r of runs.slice(0, 20)) {
      const li = el('li', r.result === 'fixed' || r.result === 'applied' ? 'ok' : r.undone ? 'warn' : '');
      li.append(el('span', 'mark', r.result === 'fixed' || r.result === 'applied' ? '✓' : '·'));
      const body = el('span', 'rp-body');
      body.append(el('strong', '', RESULT()[r.result] ?? r.result), document.createTextNode(t(r.title, r.params ?? {})));
      const meta = [when(r.at), r.by === 'auto' ? t('on her own') : String(r.by).startsWith('link:') ? t('by {name}’s Sara (fix pass)', { name: String(r.by).slice(5) }) : '', r.trialUntil && !r.undone ? t('on trial until {when}', { when: when(r.trialUntil) }) : ''].filter(Boolean).join(' · ');
      body.append(el('span', 'muted small rp-fix', meta));
      if (r.steps?.length) {
        const d = el('details', 'rp-steps');
        d.append(el('summary', 'small', t('Steps')));
        const ol = el('ol', 'small');
        for (const s of r.steps) ol.append(el('li', '', t(s.text, s.params ?? {})));
        d.append(ol);
        body.append(d);
      }
      if (r.undoable && !r.undone) {
        const row = el('span', 'rp-acts');
        row.append(btn(t('Undo'), 'ghost small', () => act(() => api(`/repair/runs/${r.id}/undo`, { method: 'POST', body: {} }), t('Putting it back…'))));
        body.append(row);
      }
      li.append(body);
      ul.append(li);
    }
    box.append(ul);
  }
}

// ---- U3.17: fixes shared between linked friends -------------------------------------------------------
let shared = null;
async function shareAct(fn, busy) {
  say(busy);
  try {
    await fn();
    say('');
  } catch (err) {
    say(err.message);
  }
  await loadShared();
}
async function loadShared() {
  const box = $('#repair-share-view');
  const row = $('#repair-share-row');
  if (!box) return;
  try {
    shared = await api('/remote-repair/recipes');
  } catch {
    shared = null;
  }
  if (row) row.hidden = !shared;
  paintShared();
}
function devButton(r) {
  const out = el('div', 'rp-dev');
  const b = btn(t('Send to the Sara developers'), 'ghost small', async () => {
    try {
      const { preview } = await api(`/remote-repair/recipes/${r.id}/report`);
      const pre = el('pre', 'rp-preview small', `${preview.title}\n\n${preview.body}${preview.diagnostics?.error ? `\n\n${preview.diagnostics.error}` : ''}`);
      const send = btn(t('Send this'), 'small', () => shareAct(async () => {
        const res = await api(`/remote-repair/recipes/${r.id}/report`, { method: 'POST', body: {} });
        say(t('Sent. Ticket {ticket}.', { ticket: res.ticket }));
      }, t('Sending…')));
      out.replaceChildren(el('p', 'small muted', t('Exactly this is sent (private things removed):')), pre, send, btn(t('Cancel'), 'ghost small', () => out.replaceChildren(b)));
    } catch (err) {
      say(err.message);
    }
  });
  if (r.ticket) out.append(el('span', 'muted small', t('Sent to the Sara developers ({ticket}).', { ticket: r.ticket })));
  else out.append(b);
  return out;
}
function recipeLine(r) {
  if (r.kind === 'code') return t('A code change to {files}', { files: (r.files ?? []).join(', ') });
  return r.text ? t(r.text, r.params ?? {}) : r.problem;
}
function paintShared() {
  const box = $('#repair-share-view');
  const on = $('#repair-share');
  if (!box) return;
  box.replaceChildren();
  if (!shared) return;
  if (on) {
    on.checked = Boolean(shared.share?.on);
    on.dataset.loaded = '1';
  }
  const friends = shared.friends ?? [];
  if (shared.share?.on) {
    if (!friends.length) box.append(el('p', 'small muted', t('Link a friend’s Sara under Messages first.')));
    else {
      const fs = el('fieldset', 'rp-friends');
      fs.append(el('legend', 'small', t('Share with')));
      for (const f of friends) {
        const lab = el('label', 'small rp-friend');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = (shared.share.links ?? []).includes(f.id);
        cb.addEventListener('change', () => {
          const links = friends.filter((x) => (x.id === f.id ? cb.checked : (shared.share.links ?? []).includes(x.id))).map((x) => x.id);
          shareAct(() => api('/repair/settings', { method: 'PUT', body: { shareLinks: links } }), '');
        });
        lab.append(cb, document.createTextNode(` ${f.name}`));
        fs.append(lab);
      }
      box.append(fs);
    }
  }
  const ins = shared.in ?? [];
  if (ins.length) {
    box.append(el('p', 'small rp-sub', t('Fixes friends shared')));
    const ul = el('ul', 'health rp-list');
    for (const r of ins) {
      const li = el('li', r.status === 'used' ? 'ok' : 'warn');
      li.append(el('span', 'mark', r.status === 'used' ? '✓' : '+'));
      const body = el('span', 'rp-body');
      body.append(el('strong', '', t('From {name}’s Sara', { name: r.peer })), document.createTextNode(recipeLine(r)));
      const meta = [t('worked on version {version}', { version: r.version })];
      if (r.checks?.length) meta.push(r.checks.map((c) => `${c.name} ${c.skipped ? t('skipped') : c.ok ? t('passed') : t('failed')}`).join(', '));
      body.append(el('span', 'muted small rp-fix', meta.join(' · ')));
      const row = el('span', 'rp-acts');
      if (r.status === 'new') {
        row.append(btn(r.kind === 'code' ? t('Prepare and test it here') : t('Fix it the same way'), 'small', () => shareAct(() => api(`/remote-repair/recipes/${r.id}/accept`, { method: 'POST', body: {} }).then(() => loadRepair()), t('Fixing…'))));
        row.append(btn(t('Not now'), 'ghost small', () => shareAct(() => api(`/remote-repair/recipes/${r.id}/dismiss`, { method: 'POST', body: {} }), '')));
        body.append(el('span', 'muted small rp-fix', r.kind === 'code' ? t('Your Sara checks it against her own rules and runs her tests; then it waits for your OK under Updates → Code changes.') : t('Your Sara runs her own fix for this problem, with a copy first and Undo.')));
      } else if (r.change) body.append(el('span', 'muted small rp-fix', t('Code change #{id}: see Updates → Code changes.', { id: r.change })));
      else body.append(el('span', 'muted small rp-fix', t('Done: see What she fixed (Undo is there).')));
      body.append(row, devButton(r));
      li.append(body);
      ul.append(li);
    }
    box.append(ul);
  }
  const sent = shared.sent ?? [];
  if (sent.length) {
    const d = el('details', 'rp-steps');
    d.append(el('summary', 'small', t('Fixes you shared ({n})', { n: sent.length })));
    const ul = el('ul', 'small rp-sent');
    for (const r of sent.slice(0, 20)) {
      const li = el('li', '', t('{what}: shared with {name}', { what: r.kind === 'code' ? (r.files ?? []).join(', ') : r.problem, name: r.peer }));
      li.append(devButton(r));
      ul.append(li);
    }
    d.append(ul);
    box.append(d);
  }
}

/** Loader: Settings → Privacy & system → Health. */
export async function loadRepair() {
  if (!$('#repair-view')) return;
  try {
    state = await api('/repair');
    paint();
  } catch {
    say(t('Not available'));
  }
  await loadShared();
}

/** Saver (the permission select; the 24-hour switch saves at once). */
export async function saveRepair() {
  const sel = $('#repair-permission');
  if (!sel?.dataset.loaded || !state || sel.value === state.settings.permission) return;
  state = await api('/repair/settings', { method: 'PUT', body: { permission: sel.value } });
  paint();
}

let wired = false;
export function initRepair() {
  if (wired || !$('#repair-view')) return;
  wired = true;
  $('#repair-check')?.addEventListener('click', () => act(() => api('/repair/check', { method: 'POST', body: { deep: true } }), t('Checking everything…')));
  $('#repair-fix-all')?.addEventListener('click', () => act(() => api('/repair/fix', { method: 'POST', body: { problem: 'everything' } }), t('Fixing…')));
  $('#repair-full')?.addEventListener('change', (e) => act(() => api('/repair/settings', { method: 'PUT', body: { full: e.target.checked } }), ''));
  $('#repair-share')?.addEventListener('change', (e) => shareAct(() => api('/repair/settings', { method: 'PUT', body: { share: e.target.checked } }), ''));
}
