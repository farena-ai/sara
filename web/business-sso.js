// EC2: Company sign-in (OpenID Connect) settings for organization administrators.
import { t, attachTips } from './business-i18n.js';

const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
// Product names stay as they are in every language.
const PRESETS = () => [['entra', 'Microsoft Entra ID'], ['google', 'Google Workspace'], ['okta', 'Okta'], ['generic', t('Other OpenID Connect provider (Keycloak, Authentik)')]];
const ISSUERS = { entra: 'https://login.microsoftonline.com/TENANT-ID/v2.0', google: 'https://accounts.google.com', okta: 'https://YOUR-ORG.okta.com', generic: 'https://HOST/realms/REALM' };
const STEPS = () => ({
  entra: [
    [t('In the Microsoft Entra admin center open App registrations, choose New registration, pick the Web platform and paste the redirect URL above.')],
    [t('Copy the Application (client) ID. Under Certificates & secrets create a client secret and copy its value.')],
    [t('Issuer URL, with the Directory (tenant) ID from Overview:'), ISSUERS.entra],
    [t('Optional groups: in Token configuration add a groups claim. Entra sends group object IDs; paste those IDs below.')],
  ],
  google: [
    [t('In Google Cloud Console open Google Auth Platform, then Clients, then Create client. Choose Web application and add the redirect URL above under Authorized redirect URIs.')],
    [t('Copy the client ID and client secret. Issuer URL:'), ISSUERS.google],
    [t('Set the audience to Internal so only your Workspace accounts can sign in, and add your domain below. Google sends no groups.')],
  ],
  okta: [
    [t('In the Okta Admin Console open Applications, choose Create App Integration, then OIDC and Web Application.')],
    [t('Add the redirect URL above as a sign-in redirect URI, tick Refresh Token, and assign the people or groups who may use Sara.')],
    [t('Copy the client ID and client secret. Issuer URL:'), ISSUERS.okta],
    [t('Optional groups: on the Sign On tab set a groups claim filter for the ID token.')],
  ],
  generic: [
    [t('Create a confidential OpenID Connect client (authorization code flow) with the redirect URL above, then copy its client ID and secret.')],
    [t('Keycloak issuer URL:'), ISSUERS.generic],
    [t('For session checks allow refresh tokens (offline access). For roles add a groups claim to the ID token.')],
  ],
});
const words = value => value.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);

export async function renderSsoSettings({ api, host, run, current }) {
  const config = await api('/sso/config'); if (!current()) return;
  const section = element('section'); section.className = 'sso-settings'; section.id = 'sso-settings';
  section.append(element('h2', t('Company sign-in (single sign-on)')));
  section.append(element('p', t('Let colleagues sign in with your organization’s account: Microsoft Entra ID, Google Workspace, Okta, Keycloak or another OpenID Connect provider. Passkeys keep working.')));
  section.append(element('p', t('Break-glass: the passkey of the person who set up this instance always signs in, even when company sign-in is required or misconfigured.')));
  const field = (label, tip, id, kind = 'input') => {
    const wrapper = element('label', label); const input = element(kind); input.id = id; input.dataset.tip = tip; wrapper.append(input); return { wrapper, input };
  };
  const check = (label, tip, id) => {
    const wrapper = element('label'); wrapper.className = 'check'; const input = element('input'); input.type = 'checkbox'; input.id = id; input.dataset.tip = tip;
    wrapper.append(input, document.createTextNode(label)); return { wrapper, input };
  };
  const redirect = field(t('Redirect URL to register at your provider'), t('Copy this exact address into your provider’s app registration. It must match character for character.'), 'sso-redirect');
  redirect.input.readOnly = true; redirect.input.value = config.redirectUrl;
  const copy = element('button', t('Copy redirect URL')); copy.type = 'button';
  copy.onclick = () => run(async () => { await navigator.clipboard.writeText(config.redirectUrl); status.textContent = t('Redirect URL copied.'); }, copy);
  const copyRow = element('div'); copyRow.className = 'copy-row'; copyRow.append(redirect.wrapper, copy);
  section.append(copyRow);

  const form = element('form'); form.noValidate = true;
  const enabled = check(t('Turn on company sign-in'), t('Shows “Sign in with your company account” on the sign-in page. Turning it off ends every company sign-in session.'), 'sso-enabled');
  const preset = field(t('Provider'), t('Choose your identity provider. The setup steps below follow your choice.'), 'sso-preset', 'select');
  for (const [value, label] of PRESETS()) { const option = element('option', label); option.value = value; preset.input.append(option); }
  const issuer = field(t('Issuer URL'), t('The issuer address from your provider, exactly as its discovery document states it. HTTPS is required.'), 'sso-issuer'); issuer.input.type = 'url'; issuer.input.maxLength = 512; issuer.input.spellcheck = false;
  const clientId = field(t('Client ID'), t('The application or client ID your provider shows for the Sara app registration.'), 'sso-client-id'); clientId.input.maxLength = 256; clientId.input.spellcheck = false;
  const secret = field(t('Client secret'), t('Kept encrypted in the operator vault and never shown again. Leave empty to keep the saved secret.'), 'sso-client-secret'); secret.input.type = 'password'; secret.input.autocomplete = 'off'; secret.input.maxLength = 4096;
  const secretState = element('p', config.secretSaved ? t('A client secret is saved. Leave the field empty to keep it.') : t('No client secret saved yet.')); secretState.className = 'muted';
  const domains = field(t('Allowed email domains'), t('Only people whose verified email ends in one of these domains may sign in, for example example.com. Separate with commas. Empty allows any account your provider accepts.'), 'sso-domains');
  const claim = field(t('Group claim name'), t('The ID-token claim that lists a person’s groups. Usually groups.'), 'sso-group-claim'); claim.input.maxLength = 64; claim.input.spellcheck = false;
  const admins = field(t('Administrator groups'), t('People in any of these groups become organization administrators. Separate with commas. Your own break-glass account is never changed.'), 'sso-admin-groups', 'textarea');
  const members = field(t('Member groups'), t('People in any of these groups become members. When any group is listed, people in no listed group are refused.'), 'sso-member-groups', 'textarea');
  for (const area of [admins.input, members.input]) area.rows = 2;
  const jit = check(t('Create accounts on first sign-in (just in time)'), t('Off: a new person needs an invitation before the first company sign-in. On: anyone passing the domain and group rules gets an account.'), 'sso-jit');
  const enforce = check(t('Members must use company sign-in'), t('Refuses passkey sign-in for everyone except the break-glass account, so removing someone at your provider removes them here.'), 'sso-enforce');
  const hours = field(t('Session length (hours)'), t('A company sign-in ends after this many hours, from 1 to 168. People then sign in again.'), 'sso-session-hours'); hours.input.type = 'number'; hours.input.min = '1'; hours.input.max = '168';
  const minutes = field(t('Session check (minutes)'), t('How often Sara asks your provider whether each signed-in person is still allowed, from 5 to 60 minutes. Needs refresh tokens.'), 'sso-check-minutes'); minutes.input.type = 'number'; minutes.input.min = '5'; minutes.input.max = '60';

  const fill = value => {
    enabled.input.checked = value.enabled; preset.input.value = value.preset; issuer.input.value = value.issuer; clientId.input.value = value.clientId; secret.input.value = '';
    domains.input.value = value.allowedDomains.join(', '); claim.input.value = value.groupClaim; admins.input.value = value.adminGroups.join(', '); members.input.value = value.memberGroups.join(', ');
    jit.input.checked = value.jit; enforce.input.checked = value.enforce; hours.input.value = String(value.sessionHours); minutes.input.value = String(value.checkMinutes);
    secretState.textContent = value.secretSaved ? t('A client secret is saved. Leave the field empty to keep it.') : t('No client secret saved yet.');
  };
  const steps = element('details'); steps.className = 'sso-steps';
  const showSteps = () => {
    const chosen = preset.input.value; issuer.input.placeholder = ISSUERS[chosen];
    const list = element('ol');
    for (const [text, code] of STEPS()[chosen]) { const item = element('li', text); if (code) { item.append(' '); item.append(element('code', code)); } list.append(item); }
    steps.replaceChildren(element('summary', t('Setup steps for {provider}', { provider: PRESETS().find(([value]) => value === chosen)[1] })), list);
  };
  preset.input.onchange = showSteps;
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const save = element('button', t('Save company sign-in')); save.type = 'submit'; save.className = 'primary';
  const test = element('button', t('Test connection')); test.type = 'button';
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    const sessionHours = Number(hours.input.value); const checkMinutes = Number(minutes.input.value);
    if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 168 || !Number.isInteger(checkMinutes) || checkMinutes < 5 || checkMinutes > 60) { status.textContent = t('Use a session length from 1 to 168 hours and a session check from 5 to 60 minutes.'); return; }
    const value = await api('/sso/config', { enabled: enabled.input.checked, preset: preset.input.value, issuer: issuer.input.value.trim(), clientId: clientId.input.value.trim(), ...(secret.input.value ? { clientSecret: secret.input.value } : {}),
      allowedDomains: words(domains.input.value), groupClaim: claim.input.value.trim() || 'groups', adminGroups: words(admins.input.value), memberGroups: words(members.input.value), jit: jit.input.checked, enforce: enforce.input.checked, sessionHours, checkMinutes });
    if (!current()) return; fill(value); status.textContent = t('Company sign-in saved.');
  }, save); };
  test.onclick = () => run(async () => {
    const result = await api('/sso/test', {}); if (!current()) return;
    status.textContent = result.ok ? t('Connection works: {keys} signing keys found.', { keys: result.keys }) + (result.endSession ? '' : ' ' + t('This provider has no sign-out address, so signing out ends only the Sara session.'))
      : result.reason === 'incomplete' ? t('Save an issuer URL and client ID first.') : result.reason === 'issuer' ? t('The issuer URL does not match what the provider reports. Copy it exactly from the provider.') : t('Sara could not reach the provider’s discovery document or keys. Check the issuer URL and the network.');
  }, test);
  const actions = element('div'); actions.className = 'actions'; actions.append(save, test);
  form.append(enabled.wrapper, preset.wrapper, steps, issuer.wrapper, clientId.wrapper, secret.wrapper, secretState, domains.wrapper, claim.wrapper, admins.wrapper, members.wrapper, jit.wrapper, enforce.wrapper, hours.wrapper, minutes.wrapper, actions, status);
  section.append(form, element('p', t('Without refresh tokens from your provider, only the session length applies: a person removed at the provider keeps access until their session ends.')));
  fill(config); showSteps(); host.append(section); attachTips(section);
}
