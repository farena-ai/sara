// C2: the policy pins in one table, in the server's PIN_KEYS order (src/policy-profile.ts): each key,
// its label (the text of its row on Settings → Data & health → Policy), the form control that sets it,
// how that control reads and writes the pin, and the controls on other pages it locks or the page it
// notes. test/policy-pins.test.ts checks the table against PIN_KEYS and web/index.html.
import { t } from './naming.js';

/**
 * kind: 'flag' (a tick box; ticked = the pin holds `value`), 'choice' (a pick-list; '' = not pinned),
 * 'number' (a pick-list of numbers; '' = not pinned), or one of the three special rows.
 * @type {readonly { key: string, label: () => string, form: string, kind: 'flag'|'choice'|'number'|'providers'|'tools'|'egress', value?: boolean, locks?: string[], note?: string }[]}
 */
export const PINS = [
  { key: 'providers', label: () => t('Allowed model providers'), form: '.po-kinds', kind: 'providers', note: 'models-providers' },
  { key: 'tools', label: () => t('Tools'), form: '#po-commands', kind: 'tools', note: 'ab-tools' },
  { key: 'alwaysAllow', label: () => t('Turn off Always allow'), form: '#po-always', kind: 'flag', value: false, locks: ['#cu-level option[value="always"]'] },
  { key: 'adultMode', label: () => t('Keep adult mode off'), form: '#po-adult', kind: 'flag', value: false, locks: ['#adult-on'] },
  { key: 'shellNetwork', label: () => t('No internet for her commands'), form: '#po-net', kind: 'flag', value: false, locks: ['#shell-network'] },
  { key: 'privateLocal', label: () => t('Keep private local mode on'), form: '#po-local', kind: 'flag', value: true, locks: ['#pl-on'] },
  { key: 'store', label: () => t('Sara Store'), form: '#po-store', kind: 'choice', locks: ['#sto-community'] },
  { key: 'auditRetentionDays', label: () => t('Audit trail retention'), form: '#po-retention', kind: 'number', locks: ['#au-keep'] },
  { key: 'programInstalls', label: () => t('Program installs'), form: '#po-programs', kind: 'choice', locks: ['#prq-installs'] },
  { key: 'containerSandbox', label: () => t('Require the container sandbox'), form: '#po-container', kind: 'flag', value: true, locks: ['#iso-backend'] },
  { key: 'egressAllowlist', label: () => t('Only these sites for sandboxed work'), form: '#po-egress-on', kind: 'egress', locks: ['#eg-mode', '#eg-hosts', '#eg-save'] },
  { key: 'sharing', label: () => t('Turn off shared links'), form: '#po-sharing', kind: 'flag', value: false },
  { key: 'crews', label: () => t('Crews'), form: '#po-crews', kind: 'choice' },
  { key: 'memoryTidy', label: () => t('Overnight memory tidy'), form: '#po-tidy', kind: 'choice', locks: ['#mt-model'] },
  { key: 'externalSecrets', label: () => t('Server keys only from secret sources'), form: '#po-secrets', kind: 'flag', value: true },
  { key: 'editors', label: () => t('Turn off editors'), form: '#po-editors', kind: 'flag', value: false },
  { key: 'legalHold', label: () => t('Keep the whole server on legal hold'), form: '#po-hold', kind: 'flag', value: true },
  { key: 'personDelete', label: () => t("No deleting one person's data"), form: '#po-nodelete', kind: 'flag', value: false },
  { key: 'codeMode', label: () => t('Turn off Code mode'), form: '#po-codemode', kind: 'flag', value: false, locks: ['#lean-codemode'] },
  { key: 'parallelReplies', label: () => t('Replies at the same time'), form: '#po-parallel', kind: 'number' },
  { key: 'meetings', label: () => t('Turn off meetings'), form: '#po-meetings', kind: 'flag', value: false, locks: ['#lib-meetings-open'] },
  { key: 'phoneHelper', label: () => t('Turn off Phone as a helper'), form: '#po-phone', kind: 'flag', value: false, locks: ['#hd-on'] },
  { key: 'workMode', label: () => t('Keep work mode on everywhere'), form: '#po-workmode', kind: 'flag', value: true, locks: ['#atw-on'] },
  { key: 'triggers', label: () => t('Turn off event triggers'), form: '#po-triggers', kind: 'flag', value: false },
  { key: 'learning', label: () => t('Turn off Learn a topic'), form: '#po-learning', kind: 'flag', value: false, locks: ['#lib-topics-open'] },
  { key: 'workingStyle', label: () => t('Turn off How she works with you'), form: '#po-workstyle', kind: 'flag', value: false, locks: ['#ws-on'] },
  { key: 'spendCap', label: () => t('Hard daily spending cap'), form: '#po-spendcap', kind: 'number' },
  { key: 'deviceApproval', label: () => t('Keep new-device approval on'), form: '#po-devapproval', kind: 'flag', value: true, locks: ['#dap-on'] },
];

/** Shows `pins` in the policy form (`q` finds one element, `qa` all). */
export function fillPins(pins, q, qa) {
  for (const p of PINS) {
    const el = q(p.form);
    if (p.kind === 'providers') {
      for (const box of qa('.po-kinds input[data-kind]')) box.checked = (pins.providers ?? []).includes(box.dataset.kind);
    } else if (p.kind === 'tools') {
      if (el) el.value = pins.tools?.['group:commands'] ?? '';
      const mcp = q('#po-mcp');
      if (mcp) mcp.value = pins.tools?.['group:mcp'] ?? '';
    } else if (!el) continue;
    else if (p.kind === 'egress') {
      el.checked = Array.isArray(pins.egressAllowlist);
      const hosts = q('#po-egress');
      if (hosts) hosts.value = (pins.egressAllowlist ?? []).map((h) => (typeof h === 'string' ? h : h.host)).join('\n');
    } else if (p.kind === 'flag') el.checked = pins[p.key] === p.value;
    else if (p.kind === 'number') el.value = pins[p.key] === undefined ? '' : String(pins[p.key]);
    else el.value = pins[p.key] ?? '';
  }
}

/** Reads the policy form into pins. Single-tool ceilings from an imported file (`prev`) stay. */
export function readPins(prev, q, qa) {
  const pins = {};
  for (const p of PINS) {
    const el = q(p.form);
    if (p.kind === 'providers') {
      const providers = [...qa('.po-kinds input[data-kind]:checked')].map((b) => b.dataset.kind);
      if (providers.length) pins.providers = providers;
    } else if (p.kind === 'tools') {
      const tools = Object.fromEntries(Object.entries(prev.tools ?? {}).filter(([k]) => k !== 'group:commands' && k !== 'group:mcp'));
      if (el?.value) tools['group:commands'] = el.value;
      const mcp = q('#po-mcp');
      if (mcp?.value) tools['group:mcp'] = mcp.value;
      if (Object.keys(tools).length) pins.tools = tools;
    } else if (!el) continue;
    else if (p.kind === 'egress') {
      if (el.checked) pins.egressAllowlist = (q('#po-egress')?.value ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } else if (p.kind === 'flag') {
      if (el.checked) pins[p.key] = p.value;
    } else if (el.value !== '') pins[p.key] = p.kind === 'number' ? Number(el.value) : el.value;
  }
  return pins;
}
