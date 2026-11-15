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
  const controls = element('div'); controls.className = 'usage-controls'; controls.append(from.wrapper, to.wrapper);
  const csv = element('a', t('Download CSV')); csv.className = 'button'; csv.id = 'audit-csv'; csv.setAttribute('download', '');
  const json = element('a', t('Download JSON')); json.className = 'button'; json.id = 'audit-json'; json.setAttribute('download', '');
  const links = () => {
    const q = new URLSearchParams(); if (from.input.value) q.set('from', from.input.value); if (to.input.value) q.set('to', to.input.value);
    const s = q.toString() ? `?${q}` : '';
    csv.href = `/api/business/org/audit.csv${s}`; json.href = `/api/business/org/audit.json${s}`;
  };
  from.input.onchange = links; to.input.onchange = links; links();
  const actions = element('div'); actions.className = 'actions'; actions.append(csv, json);
  section.append(controls, actions);
  host.append(section); attachTips(section);
}
