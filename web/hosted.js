// W2.3 (docs/HOSTING_FRIENDS.md): a Sara hosted for a friend. The owner's side lives on Settings →
// Household → People on this server (invite link, totals, pause, remove, delete); the friend's side
// on Your account (their own model and spending limit). Drawn from web/household.js; strings via t().
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const body = opts.body;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}
const money = (n) => (n ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '$0');
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const STATUS = { active: () => t('On'), suspended: () => t('Paused'), leaving: () => t('Closing') };

let reload = () => undefined;

/** The owner's list of hosted friends and their waiting invites (from GET /api/household). */
export function renderHosted(d, again) {
  if (again) reload = again;
  const inv = $('#hst-invites');
  const list = $('#hst-list');
  if (!inv || !list) return;
  inv.replaceChildren(
    ...(d.hostedInvites ?? []).map((i) => {
      const li = el('li', 'hh-invite-row');
      const name = el('strong', '', i.name);
      name.dataset.raw = '';
      li.append(name, ' ', el('span', 'muted small', t('works until {date}', { date: new Date(i.expiresAt).toLocaleString() })), ' ');
      const b = el('button', 'ghost small', t('Cancel invite'));
      b.type = 'button';
      b.addEventListener('click', () => act(() => api(`/household/invites/${i.id}`, { method: 'DELETE' })));
      li.append(b);
      return li;
    }),
  );
  const rows = d.hosted ?? [];
  list.replaceChildren(
    ...(rows.length ? [] : [el('p', 'muted small', t('You host nobody yet.'))]),
    ...rows.map((f) => {
      const card = el('div', 'hh-card hst-row');
      const head = el('div', 'hh-card-head');
      const name = el('strong', '', f.name);
      name.dataset.raw = '';
      head.append(name, el('span', `hh-badge hh-${f.status}`, STATUS[f.status]?.() ?? f.status));
      card.append(head);
      card.append(el('p', 'small', t('Last 7 days: {n} messages · {tokens} tokens · about {cost}', { n: f.usage.messages7d, tokens: f.usage.tokens7d.toLocaleString(), cost: money(f.usage.usd7d) })));
      if (f.status === 'leaving' && f.deleteAfter) card.append(el('p', 'muted small', t('They can download their data until {when}; then it is deleted.', { when: fmtDay(f.deleteAfter) })));
      else card.append(el('p', 'muted small', t('Joined {when}', { when: fmtDay(f.createdAt) })));
      const bar = el('div', 'hst-actions');
      const btn = (label, cls, fn) => {
        const b = el('button', cls, label);
        b.type = 'button';
        b.addEventListener('click', fn);
        bar.append(b);
      };
      if (f.status === 'active') btn(t('Pause'), 'ghost small', () => act(() => api(`/household/hosted/${f.id}`, { method: 'PUT', body: { status: 'suspended' } })));
      if (f.status === 'suspended') btn(t('Turn back on'), 'ghost small', () => act(() => api(`/household/hosted/${f.id}`, { method: 'PUT', body: { status: 'active' } })));
      if (f.status !== 'leaving')
        btn(t('Remove'), 'ghost small danger', () => {
          if (confirm(t('Remove {name}’s Sara? They get a few days to download their data, then everything is deleted.', { name: f.name }))) act(() => api(`/household/hosted/${f.id}/remove`, { body: {} }));
        });
      else
        btn(t('Delete now'), 'small danger', () => {
          if (confirm(t('Delete {name}’s Sara now? This can’t be undone.', { name: f.name }))) act(() => api(`/household/hosted/${f.id}`, { method: 'DELETE' }));
        });
      card.append(bar);
      return card;
    }),
  );
}

async function act(fn) {
  const status = $('#hst-status');
  try {
    await fn();
    status.textContent = t('Saved.');
    reload();
  } catch (err) {
    status.textContent = err.message;
  }
}

async function makeInvite() {
  const status = $('#hst-status');
  try {
    const r = await api('/household/hosted/invites', { body: { name: $('#hst-name').value.trim(), hours: Number($('#hst-hours').value), confirm18: $('#hst-18').checked } });
    $('#hst-new').hidden = false;
    $('#hst-new-url').textContent = r.url;
    $('#hst-new-qr').src = r.qr;
    $('#hst-name').value = '';
    $('#hst-18').checked = false;
    status.textContent = t('Invite ready. It works once.');
    renderHosted(r);
  } catch (err) {
    status.textContent = err.message;
  }
}

/** The friend's own model and spending limit on Your account. */
export async function loadHostedAccount() {
  for (const n of document.querySelectorAll('.acc-hosted-only')) n.hidden = false;
  // The page's intro speaks of a household; a hosted friend's Sara is their own.
  const intro = $('#settings-help-text');
  if (intro) intro.textContent = t('This is your own Sara on someone else\'s server. You bring your own model and set your own spending limit. The server owner sees only your usage totals, never your conversations.');
  try {
    const [p, s] = await Promise.all([api('/providers'), api('/spend')]);
    const mine = (p.providers ?? []).find((x) => x.id === 'mine');
    if (mine) {
      $('#acc-m-url').value = mine.baseUrl ?? '';
      $('#acc-m-model').value = p.defaultProviderId === 'mine' ? (p.defaultModel ?? mine.defaultModel ?? '') : (mine.defaultModel ?? '');
      $('#acc-m-key').placeholder = mine.hasKey ? t('Saved (leave empty to keep it)') : '';
    }
    $('#acc-sp-day').value = String(s.spend?.dayUsd ?? 0);
    $('#acc-sp-month').value = String(s.spend?.monthUsd ?? 0);
  } catch (err) {
    $('#acc-m-status').textContent = err.message;
  }
}

async function saveModel() {
  const status = $('#acc-m-status');
  const baseUrl = $('#acc-m-url').value.trim();
  const model = $('#acc-m-model').value.trim();
  const key = $('#acc-m-key').value.trim();
  if (!baseUrl || !model) return void (status.textContent = t('Type the address and the model name.'));
  try {
    const had = Boolean($('#acc-m-key').placeholder);
    await api('/providers/mine', { method: 'PUT', body: { kind: 'openai-compatible', label: t('My models'), baseUrl, defaultModel: model, needsKey: Boolean(key) || had, ...(key ? { apiKey: key } : {}) } });
    await api('/settings', { method: 'PUT', body: { defaultProviderId: 'mine', defaultModel: model } });
    $('#acc-m-key').value = '';
    status.textContent = t('Your model is saved.');
    void loadHostedAccount();
  } catch (err) {
    status.textContent = err.message;
  }
}

async function saveSpend() {
  const status = $('#acc-m-status');
  try {
    await api('/spend', { method: 'PUT', body: { spend: { dayUsd: Number($('#acc-sp-day').value) || 0, monthUsd: Number($('#acc-sp-month').value) || 0 } } });
    status.textContent = t('Your spending limit is saved.');
  } catch (err) {
    status.textContent = err.message;
  }
}

export function initHosted() {
  $('#hst-invite')?.addEventListener('click', () => void makeInvite());
  $('#hst-new-copy')?.addEventListener('click', () => void navigator.clipboard?.writeText($('#hst-new-url').textContent ?? '').then(() => ($('#hst-status').textContent = t('Link copied.'))));
  $('#acc-m-save')?.addEventListener('click', () => void saveModel());
  $('#acc-sp-save')?.addEventListener('click', () => void saveSpend());
}
