// V0.8 (docs/SIGN_IN_SSO.md): Settings → Connections → Devices and sign-in → Sign in with your provider.
// Owner only. A provider preset fills the issuer pattern and shows the steps; the exact redirect URL is
// shown to paste; Check the provider, Test sign-in (a popup, signs nobody in), who maps to whom with a
// live preview, and opt-in just-in-time members. Saves with its own Save button (not the page saver).
import { serverText, t } from './naming.js';
import { SSO_ISSUERS, SSO_PRESET_IDS, ssoPresetName, ssoSteps } from './sso-presets.js';

const $ = (s) => document.querySelector(s);
let wired = false;
let view = null;

async function call(path, method = 'GET', body) {
  const r = await fetch('/api/sso' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(serverText(d, String(r.status)));
  return d;
}
const words = (v) => String(v ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

/** Plain sentences for the server's reason codes (sign-in page, Check and Test sign-in). */
export function ssoReasonText(reason) {
  return ({
    state: t('The sign-in took too long or was started in another window. Start again.'),
    denied: t('The provider did not allow the sign-in (cancelled, or this account may not use the app).'),
    failed: t('The provider’s answer did not pass Sara’s checks. Use Test sign-in in Settings for details.'),
    unavailable: t('Sara could not reach the provider. Check the issuer URL and that the provider is running.'),
    no_account: t('This account is not linked to anyone here. Ask the owner to add your email in Settings → Connections → Devices and sign-in.'),
    group: t('This account is not in a group that may sign in as this person.'),
    disabled: t('This account is paused on this server.'),
    linked: t('Another provider account is already linked to this person. The owner can unlink it in Settings.'),
    email: t('The provider did not confirm this email address.'),
    adult: t('Tick “I’m 18 or older” and try again.'),
    off: t('Sign-in with your provider is off on this server.'),
    issuer: t('The issuer does not match: copy the issuer URL exactly as the provider shows it.'),
    audience: t('The ID token was made for another app: check the client ID.'),
    expired: t('The ID token is expired or from the future: check the clock on this server and the provider.'),
    signature: t('The ID token signature is wrong: check the issuer URL.'),
    unknown_key: t('The provider signed with a key it does not publish: try again in a minute.'),
    nonce: t('The sign-in answer was replayed or mixed up. Start again.'),
    client: t('The provider refused the client ID or secret: copy them again.'),
    discovery: t('The provider’s discovery document could not be read: check the issuer URL.'),
    network: t('Sara could not reach the provider. Check the issuer URL and that the provider is running.'),
    incomplete: t('Fill in the issuer URL, client ID, client secret and this server’s address first.'),
  })[reason] ?? t('Sign-in did not work. Use your token or passkey.');
}

const ROLE = () => ({ owner: t('Owner'), member: t('Member'), kid: t('Kid') });
function decisionText(d) {
  if (!d) return '';
  if (!d.ok) return '✗ ' + ssoReasonText(d.reason);
  if (d.create) return '✓ ' + t('A new member would be made: {name}', { name: d.create.name });
  const by = { link: t('linked before'), email: t('by email'), group: t('by group'), role: t('by owner group') }[d.by] ?? '';
  return '✓ ' + t('Signs in as {name} ({role}, {how})', { name: d.person.name, role: ROLE()[d.person.role] ?? d.person.role, how: by });
}

function paintSteps() {
  const id = $('#sso-preset').value;
  const box = $('#sso-steps');
  box.replaceChildren(...ssoSteps(id, t).map(([text, code]) => {
    const li = el('li', '', text);
    if (code) { li.append(' '); li.append(el('code', '', code)); }
    return li;
  }));
  $('#sso-issuer').placeholder = SSO_ISSUERS[id] ?? '';
}

function paintPeople() {
  const box = $('#sso-people');
  box.replaceChildren(...(view?.people ?? []).map((p) => {
    const row = el('div', 'sso-person');
    row.dataset.id = p.id;
    const head = el('p', 'sso-person-head');
    head.append(el('strong', '', p.name), ' ', el('span', 'muted small', ROLE()[p.role] ?? p.role));
    if (!p.active) head.append(' ', el('span', 'muted small', t('paused')));
    if (p.linked) {
      head.append(' ', el('span', 'muted small', t('linked')), ' ');
      const un = el('button', 'ghost small', t('Unlink'));
      un.type = 'button';
      un.addEventListener('click', async () => {
        await call('/unlink', 'POST', { person: p.id }).catch(() => {});
        await loadSso();
      });
      head.append(un);
    }
    const mk = (cls, label, value, ph) => {
      const l = el('label', 'row small ' + cls, label + ' ');
      const i = el('input');
      i.value = value.join(', ');
      i.placeholder = ph;
      i.maxLength = 1200;
      i.setAttribute('data-nodirty', '');
      l.append(i);
      return l;
    };
    row.append(head, mk('sso-p-emails', t('Emails'), p.emails ?? [], t('e.g. name@example.com')), mk('sso-p-groups', t('Groups'), p.groups ?? [], t('e.g. family')));
    return row;
  }));
}

function paintTest(r) {
  const box = $('#sso-test-result');
  if (!r) { box.textContent = ''; return; }
  const lines = [r.ok ? decisionText({ ok: true, ...(r.create ? { create: { name: r.who } } : { person: { name: r.who, role: r.role }, by: r.by }) }) : '✗ ' + ssoReasonText(r.reason)];
  if (r.email) lines.push(t('Email: {email}', { email: r.email }));
  lines.push(r.groups?.length ? t('Groups the provider sent: {groups}', { groups: r.groups.join(', ') }) : t('The provider sent no groups.'));
  box.textContent = lines.join(' · ');
}

function paint(v) {
  view = v;
  $('#sso-preset').value = SSO_PRESET_IDS.includes(v.preset) ? v.preset : 'generic';
  paintSteps();
  $('#sso-redirect').textContent = v.redirectUrl || location.origin + '/api/sso/callback';
  $('#sso-issuer').value = v.issuer ?? '';
  $('#sso-client').value = v.clientId ?? '';
  $('#sso-secret').value = '';
  $('#sso-secret').placeholder = v.secretSaved ? t('Saved (type to replace)') : '';
  $('#sso-label').value = v.label ?? '';
  $('#sso-on').checked = Boolean(v.enabled);
  $('#sso-claim').value = v.groupClaim ?? 'groups';
  $('#sso-skew').value = String(v.skewSeconds ?? 60);
  $('#sso-rg-owner').value = (v.roleGroups?.owner ?? []).join(', ');
  $('#sso-rg-member').value = (v.roleGroups?.member ?? []).join(', ');
  $('#sso-rg-kid').value = (v.roleGroups?.kid ?? []).join(', ');
  $('#sso-jit').checked = Boolean(v.jit?.on);
  $('#sso-jit-adults').checked = Boolean(v.jit?.adults);
  $('#sso-jit-emails').value = (v.jit?.emails ?? []).join(', ');
  $('#sso-jit-groups').value = (v.jit?.groups ?? []).join(', ');
  paintPeople();
  paintTest(v.test);
}

function gather() {
  const people = {};
  for (const row of document.querySelectorAll('#sso-people .sso-person')) {
    people[row.dataset.id] = { emails: words(row.querySelector('.sso-p-emails input').value), groups: words(row.querySelector('.sso-p-groups input').value) };
  }
  const secret = $('#sso-secret').value.trim();
  return {
    enabled: $('#sso-on').checked, preset: $('#sso-preset').value, issuer: $('#sso-issuer').value.trim(), clientId: $('#sso-client').value.trim(),
    ...(secret ? { clientSecret: secret } : {}), origin: location.origin, label: $('#sso-label').value.trim(),
    groupClaim: $('#sso-claim').value.trim() || 'groups', skewSeconds: Math.max(0, Math.min(300, Number($('#sso-skew').value) || 0)),
    people, roleGroups: { owner: words($('#sso-rg-owner').value), member: words($('#sso-rg-member').value), kid: words($('#sso-rg-kid').value) },
    jit: { on: $('#sso-jit').checked, adults: $('#sso-jit-adults').checked, emails: words($('#sso-jit-emails').value), groups: words($('#sso-jit-groups').value) },
  };
}

const say = (text) => { $('#sso-status').textContent = text; };

async function save() {
  say(t('Saving…'));
  try { paint(await call('', 'PUT', gather())); say(t('Saved.')); return true; } catch (err) { say(err.message); return false; }
}

async function preview() {
  const email = $('#sso-pv-email').value.trim();
  const groups = words($('#sso-pv-groups').value);
  if (!email && !groups.length) { $('#sso-pv-out').textContent = ''; return; }
  try { $('#sso-pv-out').textContent = decisionText(await call('/preview', 'POST', { email, groups })); } catch (err) { $('#sso-pv-out').textContent = err.message; }
}

async function testSignIn() {
  if (!(await save())) return;
  let url;
  try { ({ url } = await call('/test', 'POST', {})); } catch (err) { say(err.message); return; }
  const before = view?.test?.at ?? '';
  // noopener: the provider's page gets no handle on this one (window.open then returns null).
  window.open(url, 'sara-sso-test', 'popup,width=520,height=680,noopener');
  say(t('Finish the sign-in in the new window…'));
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    const { result } = await call('/test-result').catch(() => ({ result: null }));
    if (result && result.at !== before) { paintTest(result); if (view) view.test = result; say(result.ok ? t('Test sign-in worked.') : t('Test sign-in did not work.')); return; }
  }
  say(t('No answer from the test window yet. Run Test sign-in again.'));
}

function wire() {
  if (wired) return;
  wired = true;
  $('#sso-preset').replaceChildren(...SSO_PRESET_IDS.map((id) => { const o = el('option', '', ssoPresetName(id, t)); o.value = id; return o; }));
  $('#sso-preset').addEventListener('change', () => {
    paintSteps();
    const issuer = $('#sso-issuer');
    // Fill in the pattern for providers with a fixed address; others keep what was typed.
    if ($('#sso-preset').value === 'google') issuer.value = SSO_ISSUERS.google;
    else if (issuer.value === SSO_ISSUERS.google) issuer.value = '';
  });
  $('#sso-copy').addEventListener('click', () => void navigator.clipboard?.writeText($('#sso-redirect').textContent).then(() => say(t('Copied.')), () => {}));
  $('#sso-save').addEventListener('click', () => void save());
  $('#sso-check').addEventListener('click', async () => {
    if (!(await save())) return;
    say(t('Checking…'));
    try {
      const r = await call('/check', 'POST', {});
      say(r.ok ? t('The provider answered: {n} signing keys{logout}.', { n: r.keys, logout: r.endSession ? t(', sign-out supported') : '' }) : ssoReasonText(r.reason));
    } catch (err) { say(err.message); }
  });
  $('#sso-test').addEventListener('click', () => void testSignIn());
  for (const id of ['#sso-pv-email', '#sso-pv-groups']) $(id).addEventListener('input', () => void preview());
}

export async function loadSso() {
  if (!$('#sso-box') || document.body.classList.contains('member')) return;
  wire();
  try { paint(await call('')); } catch (err) { say(err.message); }
}
