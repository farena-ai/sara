// EC16: Provisioning (SCIM 2.0) settings for organization administrators.
import { t, attachTips } from './business-i18n.js';

const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const STEPS = () => [
  ['Microsoft Entra ID', [t('In the Entra admin center open Enterprise applications, New application, Create your own application (non-gallery), then Provisioning and set the mode to Automatic.'), t('Paste the SCIM address below as Tenant URL and the token as Secret Token, choose Test Connection, then assign the people and groups to provision.')]],
  ['Okta', [t('In the Okta Admin Console open your Sara app, General, App Settings, and turn on SCIM provisioning. On the Provisioning tab use the SCIM address below, userName as the unique identifier and HTTP Header authentication with the token.')]],
];

export async function renderScimSettings({ api, host, run, current }) {
  const config = await api('/scim/config'); if (!current()) return;
  const section = element('section'); section.className = 'sso-settings'; section.id = 'scim-settings';
  section.append(element('h2', t('Provisioning (SCIM)')));
  section.append(element('p', t('Your identity provider can create, update, disable and remove accounts here automatically. Disabling someone there ends their Sara sessions at once.')));
  section.append(element('p', t('Groups named in Administrator groups under Company sign-in make people organization administrators; everyone else provisioned is a member. Accounts you invited yourself are never changed.')));
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const enabledLabel = element('label'); enabledLabel.className = 'check';
  const enabled = element('input'); enabled.type = 'checkbox'; enabled.id = 'scim-enabled'; enabled.dataset.tip = t('Turns on the SCIM address below. Off: every provisioning request is refused; accounts already provisioned stay as they are.');
  enabledLabel.append(enabled, document.createTextNode(t('Turn on provisioning')));
  const urlLabel = element('label', t('SCIM address (tenant URL)'));
  const url = element('input'); url.id = 'scim-url'; url.readOnly = true; url.value = config.baseUrl; url.dataset.tip = t('Paste this address into your provider’s provisioning settings, exactly as shown.');
  urlLabel.append(url);
  const tokenLabel = element('label', t('Secret token'));
  const token = element('input'); token.id = 'scim-token'; token.readOnly = true; token.autocomplete = 'off'; token.dataset.tip = t('Shown only once after you create it. Sara keeps only a fingerprint of it in the operator vault. Creating a new token stops the old one at once.');
  tokenLabel.append(token);
  const tokenState = element('p'); tokenState.className = 'muted';
  const counts = element('p'); counts.className = 'muted';
  const fill = value => {
    enabled.checked = value.enabled;
    tokenState.textContent = value.tokenSet ? t('A token is set. Create a new one if it was lost; the old one then stops working.') : t('No token yet. Create one and paste it into your provider.');
    counts.textContent = t('Provisioned so far: {users} people, {groups} groups.', { users: value.users, groups: value.groups });
  };
  enabled.onchange = () => run(async () => { const value = await api('/scim/config', { enabled: enabled.checked }); if (!current()) return; fill(value); status.textContent = value.enabled ? t('Provisioning is on.') : t('Provisioning is off.'); }, enabled);
  const create = element('button', t('Create a new token')); create.type = 'button';
  create.onclick = () => run(async () => {
    const result = await api('/scim/token', {}); if (!current()) return;
    token.value = result.token; fill({ ...config, enabled: enabled.checked, tokenSet: true });
    status.textContent = t('Copy the token now. It is not shown again.');
  }, create);
  const copy = element('button', t('Copy token')); copy.type = 'button';
  copy.onclick = () => run(async () => { if (!token.value) return; await navigator.clipboard.writeText(token.value); status.textContent = t('Token copied.'); }, copy);
  const actions = element('div'); actions.className = 'actions'; actions.append(create, copy);
  const steps = element('details'); steps.className = 'sso-steps'; steps.append(element('summary', t('Setup steps for Microsoft Entra ID and Okta')));
  for (const [name, lines] of STEPS()) { steps.append(element('h3', name)); const list = element('ol'); for (const line of lines) list.append(element('li', line)); steps.append(list); }
  section.append(enabledLabel, urlLabel, tokenLabel, tokenState, actions, status, counts, steps);
  fill(config); host.append(section); attachTips(section);
}
