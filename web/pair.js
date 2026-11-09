// /pair: sign in this device with a one-time code (Phase 16). Scanning the QR code in Settings
// opens this page with the code after the #. Inside Sara's phone app it signs in by itself.
// On a phone browser the browser sign-in comes first and "Open in the Sara app" second (Android;
// iPhone once the app is in the App Store, see pair-link.js); on Android, Chrome comes back to
// /pair?noapp=1 when the app isn't installed.
import { savedLang, setLanguage, t } from './naming.js';
import { PLAY_URL, appLink, hasApp, inPhoneApp, phoneKind } from './pair-link.js';
import { devicesPath } from './devices-path.js';

const $ = (s) => document.querySelector(s);
const code = decodeURIComponent(location.hash.slice(1));
const noApp = new URLSearchParams(location.search).has('noapp');
const inApp = inPhoneApp(navigator.userAgent);
const phone = phoneKind(navigator.userAgent, navigator.maxTouchPoints);
const show = (sel, on = true) => ($(sel).hidden = !on);

// The page's own text goes through t(), so it follows the app language.
$('#pair-title').textContent = t('Sign in this device');
$('#pair-intro').textContent = t('A code from {path} signs this phone or computer in, without the owner token.', { path: devicesPath(t) });
$('#pair-code-label').textContent = t('Code');
$('#pair-browser').textContent = t('Sign in this browser');
$('#pair-app').textContent = t('Open in the Sara app');
$('#pair-or').textContent = t('Or use the phone app');

// Phase 33: inside the desktop app this page signs in the app itself.
if (/\bSaraDesktop\/\d/.test(navigator.userAgent)) {
  $('#pair-browser').textContent = t('Sign in');
  $('#pair-intro').textContent = t('Type the code from {path} on a device where you are already signed in (or open Sara in a browser with your owner token to make one).', { path: devicesPath(t) });
}
// Inside the phone app the button signs in the app, not "this browser".
if (inApp) $('#pair-browser').textContent = t('Sign in');
if (code || noApp) history.replaceState(null, '', '/pair'); // keep the code out of the history
if (code) $('#pair-code').value = code;

async function redeem() {
  const value = $('#pair-code').value.trim();
  if (!value) {
    // Came here from the sign-in page's app button (no code): back to the normal sign-in.
    if (noApp) return void location.assign('/');
    show('#pair-code-row');
    return void ($('#pair-status').textContent = t('Type the code from {path}.', { path: devicesPath(t) }));
  }
  $('#pair-status').textContent = t('Signing in…');
  $('#pair-browser').disabled = true;
  const res = await fetch('/api/pair/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: value }) }).catch(() => null);
  if (res?.ok) {
    $('#pair-status').textContent = t('Signed in.');
    location.replace('/');
    return;
  }
  const err = res ? (await res.json().catch(() => ({}))).error : t('Could not reach the server.');
  $('#pair-status').textContent = err ?? t('That did not work.');
  $('#pair-browser').disabled = false;
}

$('#pair-browser').addEventListener('click', redeem);
$('#pair-code').addEventListener('keydown', (e) => e.key === 'Enter' && redeem());

if (inApp && code) {
  // The phone app opened this page with the code: sign in right away.
  show('#pair-browser', false);
  void redeem();
} else if (noApp) {
  // Android's fallback: Chrome came back here because the Sara app isn't installed.
  try {
    sessionStorage.setItem('sara.noApp', '1'); // the sign-in page then stops offering the app
  } catch {
    /* private mode */
  }
  $('#pair-title').textContent = t('Get the Sara app');
  $('#pair-intro').textContent = code
    ? t("The Sara app isn't on this phone yet. Install it, then scan the code again (it works once, for a few minutes).")
    : t("The Sara app isn't on this phone yet. Install it, then scan the code again.");
  $('#pair-store').href = PLAY_URL;
  $('#pair-store').textContent = t('Get it on Google Play');
  show('#pair-store-row');
  show('#pair-code-row', false);
  $('#pair-browser').classList.add('ghost');
  $('#pair-browser').textContent = t('Sign in this browser instead');
} else if (phone && code && hasApp(phone)) {
  // A phone browser: the code works once, in one place. The browser sign-in comes first; the app
  // is the second choice under "Or use the phone app". iPhones get no app button until the
  // app is in the App Store (IOS_APP_URL in pair-link.js), so Safari never hits a dead link.
  $('#pair-app').href = appLink(phone, location.origin, code);
  show('#pair-app-block');
  $('#pair-intro').textContent = t('Sign in this browser with the code, or open the Sara app to sign the app in instead (the code works once).');
}

void setLanguage(savedLang())
  .then(() => (document.title = $('#pair-title').textContent))
  .catch(() => {});
