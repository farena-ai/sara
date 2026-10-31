// /device (Phase 52; security review): the confirm page for an app signing in with a device code.
// The owner types the code the app shows (it is never taken from the link), sees the app's name,
// the address it asked from and how long ago, and confirms it's really them with the owner token,
// the current two-step code or a passkey. Nothing happens until then.
import { savedLang, setLanguage, serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const status = (s) => ($('#dv-status').textContent = s);
// An old link may still carry the code after #: drop it unread (the owner types the code).
if (location.hash) history.replaceState(null, '', '/device');
let code = '';
let security = { twoStep: false, passkeys: [] };
const passkeysWork = () => Boolean(window.PublicKeyCredential) && window.isSecureContext;
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

function ago(seconds) {
  if (seconds < 60) return t('{n} seconds ago', { n: seconds });
  return t('{n} minutes ago', { n: Math.round(seconds / 60) });
}

async function post(path, body) {
  const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  return { res, data };
}

function done(ok, data, path) {
  if (ok) {
    status(path === 'approve' ? t('Approved. {name} is signed in now; you can close this page.', { name: data.name ?? t('The app') }) : t('Denied. The app was not signed in.'));
    $('#dv-what').hidden = true;
    $('#dv-find').hidden = true;
  } else {
    status(serverText(data, t('That did not work.')));
    $('#dv-yes').disabled = $('#dv-no').disabled = $('#dv-pk').disabled = false;
  }
}

async function decide(path, proof) {
  $('#dv-yes').disabled = $('#dv-no').disabled = $('#dv-pk').disabled = true;
  const { res, data } = await post(`device/${path}`, { code, confirmation: proof ?? {} });
  $('#dv-proof').value = '';
  done(Boolean(res?.ok), data, path);
}

async function approveWithPasskey() {
  try {
    const { res, data } = await post('passkey/confirm-options', {});
    if (!res?.ok) return status(serverText(data, t('That did not work.')));
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64u.dec(data.challenge), rpId: data.rpId, userVerification: data.userVerification, timeout: data.timeout, allowCredentials: [] } });
    if (!cred) return;
    await decide('approve', { passkey: { id: cred.id, clientDataJSON: b64u.enc(cred.response.clientDataJSON), authenticatorData: b64u.enc(cred.response.authenticatorData), signature: b64u.enc(cred.response.signature) } });
  } catch (err) {
    status(err.name === 'NotAllowedError' ? t('Cancelled.') : err.message);
  }
}

async function check(ev) {
  ev?.preventDefault();
  code = $('#dv-code-in').value.trim();
  $('#dv-what').hidden = true;
  if (!code) return status(t('Type the code the app shows.'));
  const res = await fetch(`/api/device/pending?code=${encodeURIComponent(code)}`).catch(() => null);
  if (!res) return status(t('Could not reach the server.'));
  if (res.status === 401) {
    $('#dv-signin').hidden = false;
    return status(t('Sign in to Sara in this browser first, then come back to this page (or approve it in Settings → Devices and sign-in).'));
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return status(body.error ?? t('That code is not waiting.'));
  const r = body.request;
  security = (await fetch('/api/security').then((x) => (x.ok ? x.json() : null)).catch(() => null)) ?? security;
  $('#dv-name').textContent = r.name;
  $('#dv-code').textContent = r.code;
  $('#dv-where').textContent = t('Asked from {ip} ({from}), {ago}.', { ip: r.ip || '?', from: r.from || '?', ago: ago(r.ageSeconds ?? 0) });
  $('#dv-warn').textContent = r.scope === 'hands' ? t('This pairs computer control on that Linux computer. Approve only if you started Sara hands there, the code matches, and the address is yours.') : t('It gets the same access as you. Approve only if you started it yourself just now, the code matches, and the address is yours.');
  $('#dv-proof-label').textContent = security.twoStep ? t('To confirm it’s you, enter the current 6-digit code from your authenticator app:') : t('To confirm it’s you, enter your owner token:');
  $('#dv-pk').hidden = !(security.passkeys?.length && passkeysWork());
  $('#dv-what').hidden = false;
  status('');
}

$('#dv-find').addEventListener('submit', (ev) => void check(ev));
$('#dv-yes').addEventListener('click', () => {
  const v = $('#dv-proof').value.trim();
  if (!v) return status(security.twoStep ? t('Enter the current code from your authenticator app to confirm.') : t('Enter your owner token to confirm.'));
  void decide('approve', security.twoStep ? { code: v } : { token: v });
});
$('#dv-pk').addEventListener('click', () => void approveWithPasskey());
$('#dv-no').addEventListener('click', () => void decide('deny'));
void setLanguage(savedLang()).catch(() => {});
