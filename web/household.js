// Phase 71: household mode (docs/HOUSEHOLD.md). The owner's Settings → Household page (invite,
// people with their usage and limits, suspend / remove / delete), the member's Your account page
// (their limits, today's use, a new token, download, delete), and joining with an invite on the
// sign-in page. Limits save as they change (no Save button); every string goes through t().
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

const st = { data: null, deps: null };
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const money = (n) => (n ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '$0');
const limitLabel = (n) => (n ? String(n) : t('No limit'));
const costLabel = (n) => (n ? `$${n}` : t('No limit'));
const hoursLabel = (h) => (h === 1 ? t('1 hour') : h === 24 ? t('1 day') : h === 72 ? t('3 days') : t('7 days'));
const STATUS = { active: () => t('Active'), suspended: () => t('Paused'), leaving: () => t('Being removed') };

function fillSelect(sel, values, label, current) {
  sel.replaceChildren(...values.map((v) => new Option(label(v), String(v))));
  sel.value = String(current ?? values[0]);
}

/**
 * The models a member may use (the first ticked is their default). Phase 114 (PL1c, S9): "All my
 * models" or "Only these…"; with Only these, a searchable list grouped by provider (Ollama Cloud
 * apart, its subscription note once per group) and no scroll box of its own.
 */
function modelPicker(models, chosen, onChange) {
  const box = el('div', 'hh-models');
  if (!models.length) {
    box.append(el('p', 'muted small', t('Add a model first (Settings → Models).')));
    return box;
  }
  const isOn = (m) => chosen.some((c) => c.providerId === m.providerId && c.model === m.model);
  const all = models.every(isOn);
  const mode = el('div', 'seg hh-mode');
  mode.setAttribute('role', 'radiogroup');
  mode.setAttribute('aria-label', t('Models they may use'));
  const list = el('div', 'hh-model-list');
  const find = el('input', 'hh-model-find');
  find.type = 'search';
  find.placeholder = t('Find a model');
  find.setAttribute('aria-label', t('Find a model'));
  find.dataset.nodirty = '';
  const groups = new Map();
  for (const m of models) {
    const cloud = /(:|-)cloud$/i.test(m.model);
    const key = cloud ? `${m.label} · Ollama Cloud` : m.label;
    if (!groups.has(key)) groups.set(key, { cloud, items: [] });
    groups.get(key).items.push(m);
  }
  const boxes = [];
  for (const [label, g] of groups) {
    const sec = el('div', 'hh-model-group');
    const head = el('p', 'hh-model-head small');
    const name = el('strong', '', label);
    name.dataset.raw = '';
    head.append(name);
    // Ollama Cloud models run on your Ollama subscription: said once, before you share one.
    if (g.cloud) head.append(' ', el('span', 'badge warn small', t('Ollama Cloud: uses your subscription')));
    sec.append(head);
    for (const m of g.items) {
      const lab = el('label', 'row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = all || isOn(m);
      cb.dataset.provider = m.providerId;
      cb.dataset.model = m.model;
      if (onChange) cb.addEventListener('change', onChange);
      const n = el('span', '', m.model);
      n.dataset.raw = '';
      lab.append(cb, ' ', n);
      sec.append(lab);
      boxes.push({ lab, cb, sec, text: `${m.model} ${label}`.toLowerCase() });
    }
    list.append(sec);
  }
  find.addEventListener('input', () => {
    const q = find.value.trim().toLowerCase();
    for (const b of boxes) b.lab.hidden = Boolean(q) && !b.text.includes(q);
    for (const sec of list.children) sec.hidden = ![...sec.querySelectorAll('label.row')].some((l) => !l.hidden);
  });
  const only = el('div', 'hh-only');
  only.append(find, list);
  const pick = (which) => {
    for (const b of mode.children) b.setAttribute('aria-checked', String(b.dataset.mode === which));
    only.hidden = which === 'all';
    if (which === 'all' && boxes.some((b) => !b.cb.checked)) {
      for (const b of boxes) b.cb.checked = true;
      onChange?.();
    }
  };
  for (const [id, label] of [['all', t('All my models')], ['only', t('Only these…')]]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.mode = id;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => pick(id));
    mode.append(b);
  }
  box.append(mode, only);
  pick(all ? 'all' : 'only');
  return box;
}
const pickedModels = (box) => [...box.querySelectorAll('input[type=checkbox]:checked')].map((cb) => ({ providerId: cb.dataset.provider, model: cb.dataset.model }));

// ---------- the owner's page ----------
export async function loadHousehold() {
  const status = $('#hh-status');
  try {
    st.data = await api('/household');
  } catch (err) {
    status.textContent = err.message;
    return;
  }
  const d = st.data;
  // The invite form: pick-lists from the server's own options.
  fillSelect($('#hh-msgs'), d.options.messages, limitLabel, $('#hh-msgs').value || 0);
  fillSelect($('#hh-cost'), d.options.cost, costLabel, $('#hh-cost').value || 0);
  for (const o of $('#hh-hours').options) o.textContent = hoursLabel(Number(o.value));
  const picked = pickedModels($('#hh-models'));
  const box = modelPicker(d.models, picked.length ? picked : d.models.slice(0, 1));
  box.id = 'hh-models';
  $('#hh-models').replaceWith(box);
  renderInvites(d.invites);
  renderMembers(d.members, d.models, d.options);
}

function renderInvites(list) {
  const ul = $('#hh-invites');
  ul.replaceChildren();
  if (!list.length) return ul.append(el('li', 'muted small', t('No invites waiting.')));
  for (const inv of list) {
    const li = el('li', 'hh-invite-row');
    const name = el('strong', '', inv.name);
    name.dataset.raw = '';
    li.append(name, ' ', el('span', 'muted small', t('works until {date}', { date: new Date(inv.expiresAt).toLocaleString() })), ' ');
    const cancel = el('button', 'ghost small', t('Cancel invite'));
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      try {
        const r = await api(`/household/invites/${inv.id}`, { method: 'DELETE' });
        renderInvites(r.invites);
      } catch (err) {
        $('#hh-status').textContent = err.message;
      }
    });
    li.append(cancel);
    ul.append(li);
  }
}

function usageLine(u) {
  if (!u) return t('Usage isn’t available right now.');
  const today = u.days.at(-1)?.messages ?? 0;
  const week = u.days.reduce((n, x) => n + x.messages, 0);
  return t('Messages today: {today} · last 7 days: {week} · about {cost}', { today, week, cost: money(u.usd) });
}

function renderMembers(members, models, options) {
  const box = $('#hh-members');
  box.replaceChildren();
  $('#hh-none').hidden = members.length > 0;
  for (const m of members) {
    const card = el('div', 'hh-card');
    card.dataset.member = m.id;
    const head = el('div', 'hh-card-head');
    const name = el('strong', '', m.name);
    name.dataset.raw = '';
    head.append(name, el('span', `hh-badge hh-${m.status}`, STATUS[m.status]?.() ?? m.status));
    card.append(head);
    card.append(el('p', 'muted small', t('Joined {date}', { date: fmtDay(m.createdAt) }) + (m.deleteAfter ? ` · ${t('Deleted on {date}', { date: fmtDay(m.deleteAfter) })}` : '')));
    card.append(el('p', 'small', usageLine(m.usage)));
    if (m.usage?.byModel?.length) {
      const ul = el('ul', 'hh-models-used small muted');
      for (const x of m.usage.byModel.slice(0, 6)) {
        const li = el('li', '', `${x.model}: ${money(x.usd)} · ${x.tokens.toLocaleString()} ${t('tokens')}`);
        li.dataset.raw = '';
        ul.append(li);
      }
      card.append(ul);
    }
    // Limits: saved as they change.
    const save = async (patch) => {
      try {
        const r = await api(`/household/members/${m.id}`, { method: 'PUT', body: { limits: patch } });
        st.data = r;
        $('#hh-status').textContent = t('Saved');
      } catch (err) {
        $('#hh-status').textContent = err.message;
        void loadHousehold();
      }
    };
    if (m.status !== 'leaving') {
      const lim = el('div', 'hh-limits');
      const picker = modelPicker(models, m.limits.models, () => {
        const chosen = pickedModels(picker);
        if (!chosen.length) {
          $('#hh-status').textContent = t('Keep at least one model.');
          return void loadHousehold();
        }
        void save({ models: chosen });
      });
      const ml = el('div', 'hh-field');
      ml.append(el('span', 'hh-legend', t('Models they may use')), picker);
      lim.append(ml);
      const msgs = el('select');
      fillSelect(msgs, options.messages, limitLabel, m.limits.messagesPerDay);
      msgs.setAttribute('aria-label', t('Messages a day'));
      msgs.addEventListener('change', () => void save({ messagesPerDay: Number(msgs.value) }));
      const cost = el('select');
      fillSelect(cost, options.cost, costLabel, m.limits.costPerDay);
      cost.setAttribute('aria-label', t('Spending a day'));
      cost.addEventListener('change', () => void save({ costPerDay: Number(cost.value) }));
      const l1 = el('label', '', t('Messages a day'));
      l1.append(' ', msgs);
      const l2 = el('label', '', t('Spending a day'));
      l2.append(' ', cost);
      lim.append(l1, l2);
      for (const [key, label] of [['voice', t('Voice')], ['pictures', t('Pictures from her')]]) {
        const lab = el('label', 'row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = m.limits[key];
        cb.addEventListener('change', () => void save({ [key]: cb.checked }));
        lab.append(cb, ' ', label);
        lim.append(lab);
      }
      card.append(lim);
    }
    const acts = el('p', 'actions-left');
    const btn = (label, cls, fn) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      acts.append(b, ' ');
    };
    const act = (path, method = 'POST', body = {}) => async () => {
      try {
        const r = await api(`/household/members/${m.id}${path}`, { method, ...(method === 'DELETE' ? {} : { body }) });
        st.data = r;
        renderMembers(r.members, r.models, r.options);
      } catch (err) {
        $('#hh-status').textContent = err.message;
      }
    };
    if (m.status === 'active') btn(t('Pause'), 'ghost small', act('/suspend'));
    if (m.status === 'suspended') btn(t('Resume'), 'ghost small', act('/resume'));
    if (m.status !== 'leaving') {
      btn(t('Remove'), 'ghost small danger', async () => {
        if (!confirm(t('Remove {name}? They are signed out and can only download their data for {days} days; then their space is deleted for good.', { name: m.name, days: options.leavingDays }))) return;
        await act('/remove')();
      });
    } else {
      btn(t('Delete now'), 'small danger', async () => {
        if (!confirm(t('Delete {name}’s space now? Everything in it is gone for good. Make sure they downloaded their data.', { name: m.name }))) return;
        await act('', 'DELETE')();
      });
    }
    card.append(acts);
    box.append(card);
  }
}

async function makeInvite() {
  const status = $('#hh-status');
  status.textContent = '';
  try {
    const r = await api('/household/invites', {
      method: 'POST',
      body: {
        name: $('#hh-name').value.trim(),
        hours: Number($('#hh-hours').value),
        confirm18: $('#hh-18').checked,
        limits: { models: pickedModels($('#hh-models')), messagesPerDay: Number($('#hh-msgs').value), costPerDay: Number($('#hh-cost').value), voice: $('#hh-voice').checked, pictures: $('#hh-pictures').checked },
      },
    });
    $('#hh-new').hidden = false;
    $('#hh-new-url').textContent = r.url;
    $('#hh-new-code').textContent = r.code;
    $('#hh-new-qr').src = r.qr;
    $('#hh-name').value = '';
    $('#hh-18').checked = false;
    renderInvites(r.invites);
    status.textContent = t('Invite made. It works once.');
  } catch (err) {
    status.textContent = err.message;
  }
}

// ---------- the member's page ----------
export async function loadAccount() {
  const dl = $('#acc-info');
  try {
    const me = await api('/household/me');
    const row = (k, v, raw) => {
      const dd = el('dd', '', v);
      if (raw) dd.dataset.raw = '';
      dl.append(el('dt', '', k), dd);
    };
    dl.replaceChildren();
    row(t('Name here'), me.name, true);
    row(t('Joined'), fmtDay(me.createdAt));
    row(t('Models you may use'), me.limits.models.map((m) => m.model).join(', ') || '–', true);
    row(t('Messages a day'), limitLabel(me.limits.messagesPerDay));
    row(t('Spending a day'), costLabel(me.limits.costPerDay));
    row(t('Voice'), me.limits.voice ? t('Allowed') : t('Not allowed'));
    row(t('Pictures from her'), me.limits.pictures ? t('Allowed') : t('Not allowed'));
    row(t('Today'), t('Messages: {n} · about {cost}', { n: me.today.messages, cost: money(me.today.usd) }));
  } catch (err) {
    $('#acc-status').textContent = err.message;
  }
}

async function deleteAccount() {
  const token = $('#acc-del-token').value.trim();
  if (!token) return void ($('#acc-status').textContent = t('Type your member token to confirm.'));
  if (!confirm(t('Delete your whole space on this server? This can’t be undone.'))) return;
  try {
    await api('/household/me/delete', { method: 'POST', body: { token } });
    location.href = '/';
  } catch (err) {
    $('#acc-status').textContent = err.message;
  }
}

// ---------- joining with an invite (sign-in page) ----------
/** The invite code from a link (/#join=CODE), shown in the join box. */
export function joinFromLink() {
  const m = /#join=([\w-]+)/.exec(location.hash);
  if (!m) return false;
  showJoin(m[1]);
  return true;
}
function showJoin(code = '') {
  $('#join').hidden = false;
  $('#join-open').hidden = true;
  if (code) $('#join-code').value = code;
  if (!code) return;
  api(`/household/join?code=${encodeURIComponent(code)}`).then(
    (r) => ($('#join-who').textContent = t('The owner of this server invited you as {name}. With it you get your own space here: your own companion, conversations and memories, which the owner can’t read.', { name: r.invite.name })),
    (err) => ($('#login-error').textContent = err.message),
  );
}
async function join() {
  $('#login-error').textContent = '';
  try {
    const r = await api('/household/join', { method: 'POST', body: { code: $('#join-code').value.trim(), confirm18: $('#join-18').checked } });
    history.replaceState(null, '', '/');
    $('#join-code').value = '';
    $('#joined-token').textContent = r.token;
    $('#joined-saved').checked = false;
    $('#joined-done').disabled = true;
    st.deps.show('joined');
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
}

/** A paused or leaving member sees a short card instead of the app. */
export function showPaused(member) {
  const leaving = member.status === 'leaving';
  $('#paused-title').textContent = leaving ? t('Your account is being removed') : t('Your account is paused');
  $('#paused-text').textContent = leaving
    ? t('The owner of this server removed your account. Download your data before {date}; after that it is deleted for good.', { date: member.deleteAfter ? fmtDay(member.deleteAfter) : '' })
    : t('The owner of this server has paused your account. Nothing was deleted. Ask them to resume it.');
  $('#paused-export').hidden = !leaving;
  st.deps.show('member-paused');
}

export function initHousehold(deps) {
  st.deps = deps;
  $('#hh-invite').addEventListener('click', () => void makeInvite());
  $('#hh-new-copy').addEventListener('click', () => deps.copyText($('#hh-new-url').textContent, $('#hh-new-copy')));
  $('#acc-delete').addEventListener('click', () => void deleteAccount());
  $('#acc-devices').addEventListener('click', () => deps.showSettingsTab('dh-devices'));
  $('#acc-tok-rotate').addEventListener('click', async () => {
    try {
      const r = await api('/owner-token/rotate', { method: 'POST', body: { current: $('#acc-tok-current').value.trim(), keepPasskeys: true } });
      $('#acc-tok-current').value = '';
      $('#acc-tok-new').hidden = false;
      $('#acc-tok-value').textContent = r.token;
    } catch (err) {
      $('#acc-status').textContent = err.message;
    }
  });
  $('#join-show').addEventListener('click', () => showJoin());
  $('#join-go').addEventListener('click', () => void join());
  $('#joined-copy').addEventListener('click', () => deps.copyText($('#joined-token').textContent, $('#joined-copy')));
  $('#joined-saved').addEventListener('change', () => ($('#joined-done').disabled = !$('#joined-saved').checked));
  $('#joined-done').addEventListener('click', async () => {
    $('#joined-token').textContent = '';
    await deps.boot();
  });
  $('#paused-logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST', body: {} }).catch(() => {});
    location.href = '/';
  });
  window.addEventListener('hashchange', () => joinFromLink());
}
