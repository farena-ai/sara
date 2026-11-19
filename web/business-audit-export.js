// R7: Audit export for organization administrators: the control audit (sign-ins, invitations, roles,
// settings, exports) for a date range as CSV or JSON. Rows hold ids and action names, never content.
import { t, attachTips } from './business-i18n.js';

const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const field = (id, label, tip) => { const wrapper = element('label', label); const input = element('input'); input.type = 'date'; input.id = id; input.dataset.tip = tip; wrapper.append(input); return { wrapper, input }; };

export async function renderAuditExport({ host }) {
  const section = element('section'); section.className = 'sso-settings audit-export'; section.id = 'business-audit-export';
  section.append(element('h2', t('Audit export')));
  section.append(element('p', t('Who did what and when: sign-ins, invitations, roles, settings changes and exports. Rows hold account and workspace ids, never message or document content. Each export is itself recorded.')));
  const from = field('audit-from', t('From'), t('Rows from the start of this day (UTC). Empty: from the first row.'));
  const to = field('audit-to', t('To'), t('Rows up to the end of this day (UTC). Empty: up to now.'));
  // W3.3: who (an account id from the roster) and what (an action or its first word, such as inbox).
  const who = element('label', t('Who')); const actor = element('select'); actor.id = 'audit-actor'; actor.dataset.tip = t('Only what this person did. Everyone: all accounts.'); who.append(actor);
  actor.append(new Option(t('Everyone'), ''));
  try { const response = await fetch('/api/business/org/users', { credentials: 'same-origin' }); if (response.ok) for (const person of await response.json()) actor.append(new Option(person.name, person.id)); } catch { /* The list is a convenience; the export works without it. */ }
  const whatLabel = element('label', t('What')); const what = element('select'); what.id = 'audit-action'; what.dataset.tip = t('Only one kind of action, such as sign-ins, roles or the team inbox. Empty: everything.');
  for (const [value, label] of [['', t('Everything')], ['identity', t('Sign-ins and accounts')], ['organization', t('Organization and roles')], ['team', t('Team roles and spend limit')], ['workspace', t('Workspaces and members')], ['invite', t('Invitations')], ['inbox', t('Team inbox')], ['approval', t('Approvals')], ['page', t('Team pages')], ['sso', t('Company sign-in')], ['audit', t('Audit exports')]]) what.append(new Option(label, value));
  whatLabel.append(what);
  const wide = element('label', t('Include workspace activity')); wide.className = 'check'; const spaces = element('input'); spaces.type = 'checkbox'; spaces.id = 'audit-workspaces'; spaces.dataset.tip = t('Adds team inbox, approvals and page activity from every workspace: who and what only, never the text.'); wide.prepend(spaces);
  const controls = element('div'); controls.className = 'usage-controls'; controls.append(from.wrapper, to.wrapper, who, whatLabel, wide);
  const csv = element('a', t('Download CSV')); csv.className = 'button'; csv.id = 'audit-csv'; csv.setAttribute('download', '');
  const json = element('a', t('Download JSON')); json.className = 'button'; json.id = 'audit-json'; json.setAttribute('download', '');
  const links = () => {
    const q = new URLSearchParams(); if (from.input.value) q.set('from', from.input.value); if (to.input.value) q.set('to', to.input.value); if (actor.value) q.set('actor', actor.value); if (what.value) q.set('action', what.value); if (spaces.checked) q.set('workspaces', '1');
    const s = q.toString() ? `?${q}` : '';
    csv.href = `/api/business/org/audit.csv${s}`; json.href = `/api/business/org/audit.json${s}`;
  };
  from.input.onchange = links; to.input.onchange = links; actor.onchange = links; what.onchange = links; spaces.onchange = links; links();
  const actions = element('div'); actions.className = 'actions'; actions.append(csv, json);
  section.append(controls, actions);
  host.append(section); attachTips(section);
}
