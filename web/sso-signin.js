// V0.8 (docs/SIGN_IN_SSO.md): the sign-in page's "Sign in with <provider>" button and the return from
// the provider (/?sso=done → POST /api/sso/finish; /?sso=<reason> → a plain sentence). The owner token
// and passkeys stay on the same page as before.
import { t } from './naming.js';
import { ssoReasonText } from './sso-settings.js';

const $ = (s) => document.querySelector(s);
let wired = false;

async function post(path, body = {}) {
  const r = await fetch('/api/sso/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? String(r.status));
  return d;
}

/** Shows or hides the button from /api/session's `sso` ({enabled, label, jit}). */
export function paintSsoLogin(session) {
  const btn = $('#login-sso');
  if (!btn) return;
  const s = session.sso;
  btn.hidden = !s?.enabled;
  $('#login-sso-adult').hidden = !s?.jit;
  btn.textContent = s?.label ? t('Sign in with {name}', { name: s.label }) : t('Sign in with your provider');
  if (wired) return;
  wired = true;
  btn.addEventListener('click', async () => {
    $('#login-error').textContent = '';
    try { location.assign((await post('start', { confirm18: $('#login-sso-18')?.checked === true })).url); } catch (err) { $('#login-error').textContent = err.message; }
  });
}

/**
 * The page came back from the provider. Returns 'stop' (the Test sign-in window closes itself),
 * 'again' (signed in: boot again) or undefined (nothing to do, or an error shown on the sign-in page).
 */
export async function ssoReturn({ waitOnSignIn }) {
  const q = new URLSearchParams(location.search);
  if (q.has('sso-test')) {
    history.replaceState(null, '', '/');
    const p = document.createElement('p');
    p.className = 'sso-test-done';
    p.textContent = t('Test sign-in finished. You can close this window: the result is in Settings.');
    document.body.replaceChildren(p);
    setTimeout(() => window.close(), 1200);
    return 'stop';
  }
  const r = q.get('sso');
  if (!r) return undefined;
  history.replaceState(null, '', '/');
  if (r !== 'done') {
    setTimeout(() => { const e = $('#login-error'); if (e) e.textContent = ssoReasonText(r); }, 0);
    return undefined;
  }
  try {
    const d = await post('finish');
    if (d.pendingApproval && !(await waitOnSignIn(d.pendingApproval))) return undefined;
    return 'again';
  } catch (err) {
    setTimeout(() => { const e = $('#login-error'); if (e) e.textContent = err.message; }, 0);
    return undefined;
  }
}

/** Sign out: a provider session also leaves the provider (when it has a sign-out page). */
export function ssoAfterLogout(r) {
  if (r?.endSession && /^https?:\/\//.test(r.endSession)) { location.assign(r.endSession); return true; }
  return false;
}
