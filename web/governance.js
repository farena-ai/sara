// EC4 + EC5 (docs/ops/EC45_DESIGN.md): Settings → Data & health → Audit trail and Policy, and the
// "Set by your admin" locks on the pages a policy pins. The server enforces every pin; the locks
// only say so before a change is refused.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openSettings: (page: string) => void } | null} */
let ctx = null;
let pol = null;
let polAt = 0;

const OUTCOME = { ok: () => t('Done'), refused: () => t('Refused'), failed: () => t('Failed'), pending: () => t('Waiting') };
const ROLE = { owner: () => t('You'), member: () => t('Household member'), device: () => t('App'), system: () => t('Sara herself') };

export function initGovernance(c) {
  ctx = c;
  for (const id of ['#au-who', '#au-action', '#au-channel', '#au-outcome', '#au-from', '#au-to']) $(id)?.addEventListener('change', () => void loadAudit());
  $('#au-verify')?.addEventListener('click', () => void verify());
  $('#au-jsonl')?.addEventListener('click', () => download('jsonl'));
  $('#au-csv')?.addEventListener('click', () => download('csv'));
  $('#au-keep')?.addEventListener('change', () => void keep());
  $('#po-save')?.addEventListener('click', () => void save());
  $('#po-export')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/policy/export';
    a.download = 'sara-policy.json';
    a.click();
  });
  $('#po-import')?.addEventListener('click', () => $('#po-file')?.click());
  $('#po-file')?.addEventListener('change', () => void importFile());
  // A Settings page coming into view loads its part: the trail, the policy, and the locks on any page.
  const seen = new MutationObserver((changes) => {
    for (const c of changes) {
      const sec = c.target;
      if (!(sec instanceof HTMLElement) || sec.hidden || !sec.classList.contains('settings-page')) continue;
      if (sec.dataset.page === 'dh-audit') void loadAudit();
      if (sec.dataset.page === 'dh-policy') void loadPolicy();
      void applyPolicyLocks();
    }
  });
  for (const sec of document.querySelectorAll('.settings-page')) seen.observe(sec, { attributes: true, attributeFilter: ['hidden'] });
}

function query() {
  const q = new URLSearchParams();
  for (const [k, id] of [['who', '#au-who'], ['action', '#au-action'], ['channel', '#au-channel'], ['outcome', '#au-outcome'], ['from', '#au-from'], ['to', '#au-to']]) {
    const v = $(id)?.value;
    if (v) q.set(k, v);
  }
  return q;
}

export async function loadAudit() {
  if (!ctx || !$('#au-list')) return;
  const status = $('#au-status');
  let d;
  try {
    d = await ctx.api(`/audit?${query()}`);
  } catch (e) {
    status.textContent = e.message;
    return;
  }
  status.textContent = chainLine(d.verify);
  const keep = $('#au-keep');
  keep.value = String(d.retentionDays);
  lock(keep, d.retentionPinned);
  const list = $('#au-list');
  if (!d.rows.length) {
    list.replaceChildren(ctx.el('p', 'muted small', t('Nothing matches these filters yet.')));
    return;
  }
  list.replaceChildren(...d.rows.slice(0, 300).map(row));
}

function row(r) {
  const el = ctx.el;
  const li = el('div', 'au-row');
  li.dataset.outcome = r.outcome;
  const when = el('time', 'au-when', new Date(r.at).toLocaleString());
  when.dateTime = r.at;
  const what = el('span', 'au-what');
  what.append(el('code', '', r.action), ...(r.target ? [document.createTextNode(' '), el('span', 'muted', r.target)] : []));
  const who = el('span', 'au-who', `${(ROLE[r.role] ?? (() => r.role))()} · ${r.channel}`);
  const out = el('span', 'au-outcome', (OUTCOME[r.outcome] ?? (() => r.outcome))());
  li.append(when, what, who, out);
  if (r.keys?.length) li.append(el('span', 'au-keys muted small', r.keys.join(', ')));
  li.title = `#${r.seq} · ${t('policy revision {rev}', { rev: r.policyRev })} · ${r.hash.slice(0, 16)}…`;
  return li;
}

function chainLine(v) {
  if (!v) return '';
  return v.ok ? t('Chain checked: {n} row(s), nothing changed.', { n: v.rows }) : t('The chain is broken at row {seq}: a row was changed, removed or cut off.', { seq: v.brokenAt });
}

async function verify() {
  try {
    $('#au-status').textContent = chainLine(await ctx.api('/audit/verify'));
  } catch (e) {
    $('#au-status').textContent = e.message;
  }
}

function download(format) {
  const q = query();
  q.set('format', format);
  if ($('#au-content')?.checked) q.set('content', '1');
  const a = document.createElement('a');
  a.href = `/api/audit/export?${q}`;
  a.download = '';
  a.click();
}

async function keep() {
  try {
    await ctx.api('/audit/settings', { method: 'PUT', body: { retentionDays: Number($('#au-keep').value) } });
    $('#au-status').textContent = t('Saved.');
  } catch (e) {
    $('#au-status').textContent = e.message;
    void loadAudit();
  }
}

// ---------- policy ----------
async function getPolicy(fresh = false) {
  if (!ctx) return null;
  if (!fresh && pol && Date.now() - polAt < 30_000) return pol;
  try {
    pol = await ctx.api('/policy');
    polAt = Date.now();
  } catch {
    pol = null;
  }
  return pol;
}

export async function loadPolicy() {
  const d = await getPolicy(true);
  if (!d || !$('#po-name')) return;
  const p = d.policy;
  const pins = p.pins ?? {};
  $('#po-state').textContent = p.rev ? t('Policy “{name}”, revision {rev}, saved {time}.', { name: p.name, rev: p.rev, time: p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '?' }) : t('No policy yet: nothing is pinned.');
  $('#po-name').value = p.name ?? '';
  for (const box of document.querySelectorAll('.po-kinds input[data-kind]')) box.checked = (pins.providers ?? []).includes(box.dataset.kind);
  $('#po-commands').value = pins.tools?.['group:commands'] ?? '';
  $('#po-mcp').value = pins.tools?.['group:mcp'] ?? '';
  $('#po-always').checked = pins.alwaysAllow === false;
  $('#po-adult').checked = pins.adultMode === false;
  $('#po-net').checked = pins.shellNetwork === false;
  $('#po-local').checked = pins.privateLocal === true;
  $('#po-store').value = pins.store ?? '';
  $('#po-retention').value = pins.auditRetentionDays === undefined ? '' : String(pins.auditRetentionDays);
  $('#po-programs').value = pins.programInstalls ?? '';
  for (const c of document.querySelectorAll('.po-page input, .po-page select, .po-page button')) c.disabled = !d.canEdit;
}

function readForm() {
  const prev = pol?.policy?.pins ?? {};
  // Tool ceilings set in an imported file (single tools) stay; the two group rows come from the form.
  const tools = Object.fromEntries(Object.entries(prev.tools ?? {}).filter(([k]) => k !== 'group:commands' && k !== 'group:mcp'));
  if ($('#po-commands').value) tools['group:commands'] = $('#po-commands').value;
  if ($('#po-mcp').value) tools['group:mcp'] = $('#po-mcp').value;
  const providers = [...document.querySelectorAll('.po-kinds input[data-kind]:checked')].map((b) => b.dataset.kind);
  const pins = {
    ...(providers.length ? { providers } : {}),
    ...(Object.keys(tools).length ? { tools } : {}),
    ...($('#po-always').checked ? { alwaysAllow: false } : {}),
    ...($('#po-adult').checked ? { adultMode: false } : {}),
    ...($('#po-net').checked ? { shellNetwork: false } : {}),
    ...($('#po-local').checked ? { privateLocal: true } : {}),
    ...($('#po-store').value ? { store: $('#po-store').value } : {}),
    ...($('#po-retention').value !== '' ? { auditRetentionDays: Number($('#po-retention').value) } : {}),
    ...($('#po-programs').value ? { programInstalls: $('#po-programs').value } : {}),
  };
  return { name: $('#po-name').value.trim() || t('Policy'), pins };
}

async function save() {
  const status = $('#po-status');
  try {
    await ctx.api('/policy', { method: 'PUT', body: readForm() });
    status.textContent = t('Saved. Everyone on this server follows it now.');
    await loadPolicy();
  } catch (e) {
    status.textContent = e.message;
  }
}

async function importFile() {
  const input = $('#po-file');
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const status = $('#po-status');
  try {
    const body = JSON.parse(await file.text());
    if (!confirm(t('Replace every pin with the policy in {file}?', { file: file.name }))) return;
    await ctx.api('/policy/import', { method: 'POST', body });
    status.textContent = t('Imported. Everyone on this server follows it now.');
    await loadPolicy();
  } catch (e) {
    status.textContent = e instanceof SyntaxError ? t('That file is not a policy (not JSON).') : e.message;
  }
}

// ---------- "Set by your admin" on the pages a pin covers ----------
const LOCKS = {
  adultMode: ['#adult-on'],
  shellNetwork: ['#shell-network'],
  privateLocal: ['#pl-on'],
  store: ['#sto-community'],
  alwaysAllow: ['#cu-level option[value="always"]'],
  auditRetentionDays: ['#au-keep'],
  programInstalls: ['#prq-installs'],
};
const NOTES = { providers: 'models-providers', tools: 'ab-tools' };

function lock(control, on) {
  if (!control) return;
  const target = control.tagName === 'OPTION' ? control.parentElement : control;
  if (control.tagName === 'OPTION') control.disabled = on;
  else control.disabled = on || control.disabled && control.dataset.poLocked !== '1';
  control.dataset.poLocked = on ? '1' : '';
  const host = target.closest('label') ?? target;
  let tag = host.querySelector(':scope > .po-lock');
  if (on && !tag) {
    tag = ctx.el('span', 'po-lock', t('Set by your admin'));
    host.append(tag);
  }
  if (tag) {
    tag.hidden = !on;
    if (on && pol?.policy) tag.title = t('Pinned by the policy “{name}”. Only its admin can change it.', { name: pol.policy.name });
  }
}

/** Marks pinned controls and pages (after a page opens); cheap: the policy is cached for 30 s. */
export async function applyPolicyLocks() {
  const d = await getPolicy();
  if (!d) return;
  const pinned = new Set(d.pinned ?? []);
  for (const [key, sels] of Object.entries(LOCKS)) for (const sel of sels) lock(document.querySelector(sel), pinned.has(key));
  for (const [key, id] of Object.entries(NOTES)) {
    const sec = document.querySelector(`.settings-page[data-page="${id}"]`);
    if (!sec) continue;
    let note = sec.querySelector(':scope > .po-banner');
    if (pinned.has(key) && !note) {
      note = ctx.el('p', 'po-banner small');
      sec.prepend(note);
    }
    if (note) {
      note.hidden = !pinned.has(key);
      note.textContent = key === 'providers' ? t('Set by your admin ({policy}): only some kinds of model provider may be used.', { policy: d.policy.name }) : t('Set by your admin ({policy}): some tools ask or stay off whatever you choose here.', { policy: d.policy.name });
    }
  }
}
