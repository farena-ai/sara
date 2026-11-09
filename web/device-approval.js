// C15 (docs/DEVICES.md "Approve new devices"): the three places the approval shows in the app.
// 1. A device that signs in from elsewhere waits on the sign-in screen with its 5-character code.
// 2. A device already in use gets a prompt (Approve a device?) where the owner types that code.
// 3. A remote device asking for a sensitive action (Always allow, a new password, an add-on from
//    a web address, a chat token, an update) shows its code until the owner approves it elsewhere;
//    then the action runs once.
// Settings → Devices and sign-in → Approve new devices: the switch, max devices, allowed addresses.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
async function call(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { data, status: res.status });
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What a request asks for, in the app's language (the server sends English). */
const ACTIONS = {
  'allow-all': () => t('turn on Always allow'),
  password: () => t('change the owner password (token)'),
  'addon-url': () => t('install an add-on from a web address'),
  'channel-token': () => t('change a chat channel token'),
  restart: () => t('restart or update Sara'),
  'approval-off': () => t('turn off new-device approval'),
  hands: () => t('let Sara use a computer (computer use)'),
};
export function requestLine(r) {
  if (r.kind === 'sign-in') return t('{label} wants to sign in, from {ip}.', { label: r.label, ip: r.ip });
  return t('{label} (from {ip}) asks to {what}.', { label: r.label, ip: r.ip, what: ACTIONS[r.action]?.() ?? r.action });
}

// ---------------- 1. the waiting device ----------------

/** Shows the code on the sign-in screen and waits; resolves true when approved, false on no. */
export async function waitOnSignIn(pending) {
  const box = $('#login-wait');
  if (!box) return false;
  box.hidden = false;
  $('#login-wait-code').textContent = pending.code;
  $('#login-wait-status').textContent = t('Waiting for your OK…');
  for (;;) {
    await sleep(2000);
    const s = await call('/session').catch(() => null);
    if (s?.authenticated) {
      box.hidden = true;
      return true;
    }
    const st = s?.pendingApproval?.state;
    if (!s?.pendingApproval || st === 'denied' || st === 'expired') {
      $('#login-wait-status').textContent = st === 'expired' ? t('No answer in 10 minutes, so this device is not signed in. Sign in again for a new code.') : t('Refused. This device is not signed in.');
      return false;
    }
  }
}

// ---------------- 2. the prompt on a device already in use ----------------

let shown = null;
export async function checkPrompts() {
  const pop = $('#dap-pop');
  if (!pop) return;
  const { requests } = await call('/device-approvals').catch(() => ({ requests: [] }));
  const r = requests[0];
  if (!r) {
    if (pop.open) pop.close();
    shown = null;
    return;
  }
  if (shown === r.createdAt && pop.open) return;
  shown = r.createdAt;
  $('#dap-pop-what').textContent = requestLine(r);
  $('#dap-pop-code').value = '';
  $('#dap-pop-error').textContent = '';
  if (!pop.open) pop.showModal();
  $('#dap-pop-code').focus();
}

async function answerPrompt(yes) {
  const code = $('#dap-pop-code').value.trim().toUpperCase().replace(/[\s-]+/g, '');
  try {
    if (yes || code) {
      if (!/^[A-Z0-9]{5}$/.test(code)) {
        $('#dap-pop-error').textContent = t('Type the 5-character code that device shows.');
        return $('#dap-pop-code').focus();
      }
      await call(`/device-approvals/${encodeURIComponent(code)}`, { method: 'POST', body: { approve: yes } });
    } else await call('/device-approvals/deny-all', { method: 'POST', body: {} });
    $('#dap-pop').close();
    shown = null;
    void checkPrompts();
  } catch (err) {
    $('#dap-pop-error').textContent = err.message;
  }
}

// ---------------- 3. a sensitive action from this (remote) device ----------------

/** Shows the code until the owner answers elsewhere; resolves true when approved. */
export async function waitForApproval(approval) {
  const d = $('#dap-ask');
  if (!d) return false;
  $('#dap-ask-what').textContent = t('This device is signed in from elsewhere, so the owner approves this first: {what}.', { what: ACTIONS[approval.action]?.() ?? approval.action });
  $('#dap-ask-code').textContent = approval.code;
  $('#dap-ask-status').textContent = t('Waiting for your OK…');
  let cancelled = false;
  const cancel = () => (cancelled = true);
  $('#dap-ask-cancel').addEventListener('click', cancel, { once: true });
  if (!d.open) d.showModal();
  try {
    for (;;) {
      await sleep(2000);
      if (cancelled) return false;
      const s = await call(`/device-approvals/${encodeURIComponent(approval.code)}/status`).catch(() => null);
      if (s?.state === 'approved') return true;
      if (!s || s.state === 'denied' || s.state === 'expired') {
        $('#dap-ask-status').textContent = s?.state === 'expired' ? t('No answer in 10 minutes, so nothing was changed.') : t('Refused, so nothing was changed.');
        await sleep(2500);
        return false;
      }
    }
  } finally {
    if (d.open) d.close();
  }
}

// ---------------- Settings ----------------

export async function loadDeviceApproval() {
  const box = $('#dap-box');
  if (!box) return;
  const s = await call('/device-approval').catch(() => null);
  box.hidden = !s?.available;
  if (!s?.available) return;
  $('#dap-on').checked = s.on;
  $('#dap-max').value = String(s.maxDevices);
  $('#dap-hosts').value = s.allowedHosts.join(', ');
  $('#dap-notice').hidden = !s.notice;
  const { requests } = await call('/device-approvals').catch(() => ({ requests: [] }));
  $('#dap-list').replaceChildren(...requests.map((r) => {
    const li = document.createElement('li');
    li.textContent = requestLine(r);
    return li;
  }));
}

async function saveDeviceApproval(extra = {}) {
  try {
    await call('/device-approval', { method: 'PUT', body: { on: $('#dap-on').checked, maxDevices: Number($('#dap-max').value), allowedHosts: $('#dap-hosts').value, ...extra } });
    $('#dap-status').textContent = t('Saved');
    await loadDeviceApproval();
  } catch (err) {
    $('#dap-status').textContent = err.message;
  }
}

export function initDeviceApproval() {
  if (!$('#dap-pop')) return;
  $('#dap-pop-approve').addEventListener('click', () => answerPrompt(true));
  $('#dap-pop-deny').addEventListener('click', () => answerPrompt(false));
  $('#dap-pop-later').addEventListener('click', () => $('#dap-pop').close());
  $('#dap-pop-code').addEventListener('keydown', (e) => e.key === 'Enter' && answerPrompt(true));
  $('#dap-save')?.addEventListener('click', () => saveDeviceApproval());
  $('#dap-notice-ok')?.addEventListener('click', () => saveDeviceApproval({ noticeSeen: true }));
}
