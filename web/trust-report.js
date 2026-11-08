// EC25 (docs/ops/EC2527_DESIGN.md): Settings → Household → Trust report. What Sara said against what
// ran, for a week, one run or one project; downloads as Markdown, PDF or Word. Owner only (the
// server refuses everyone else).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;

const PROBLEM = { missing: () => t('no receipt'), contradicted: () => t('a receipt says otherwise') };
const WHY = { policy: () => t('policy or never allowed'), loop: () => t('loop guard'), declined: () => t('declined before') };
const OUTCOME = { ok: () => t('Done'), refused: () => t('Refused'), failed: () => t('Failed'), pending: () => t('Waiting') };

export function initTrustReport(c) {
  ctx = c;
  $('#tr-scope')?.addEventListener('change', () => void scopeChanged());
  $('#tr-show')?.addEventListener('click', () => void load());
  for (const f of ['md', 'pdf', 'docx']) $(`#tr-${f}`)?.addEventListener('click', () => download(f));
  const page = document.querySelector('.settings-page[data-page="dh-trust"]');
  if (page) new MutationObserver(() => !page.hidden && void load()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

async function scopeChanged() {
  const scope = $('#tr-scope')?.value || 'week';
  $('#tr-from-box').hidden = scope !== 'week';
  $('#tr-run-box').hidden = scope !== 'run';
  $('#tr-project-box').hidden = scope !== 'project';
  if (scope === 'project' && ctx && !$('#tr-project').options.length) {
    try {
      const d = await ctx.api('/trust/projects');
      $('#tr-project').replaceChildren(...d.projects.map((p) => new Option(p.name, String(p.id))));
      if (!d.projects.length) $('#tr-status').textContent = t('No projects yet.');
    } catch (e) {
      $('#tr-status').textContent = e.message;
    }
  }
  if (scope === 'week') void load();
}

function query() {
  const q = new URLSearchParams();
  const scope = $('#tr-scope')?.value || 'week';
  q.set('scope', scope);
  if (scope === 'week' && $('#tr-from')?.value) q.set('from', $('#tr-from').value);
  if (scope === 'run') q.set('id', $('#tr-run')?.value || '');
  if (scope === 'project') q.set('id', $('#tr-project')?.value || '');
  return q;
}

function download(format) {
  const a = document.createElement('a');
  a.href = `/api/trust/report.${format}?${query()}`;
  a.download = `sara-trust.${format}`;
  a.click();
}

const money = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

function card(title, items, empty, more = 0) {
  const el = ctx.el;
  const box = el('section', 'tr-card');
  box.append(el('h4', '', title));
  if (!items.length) box.append(el('p', 'muted small', empty));
  else {
    const ul = el('ul', 'small');
    ul.append(...items);
    box.append(ul);
  }
  if (more) box.append(el('p', 'muted small', t('…and {n} more (in the download).', { n: more })));
  return box;
}

export async function load() {
  if (!ctx || !$('#tr-report')) return;
  const scope = $('#tr-scope')?.value || 'week';
  if ((scope === 'run' || scope === 'project') && !query().get('id')) {
    $('#tr-status').textContent = scope === 'run' ? t('Enter a run number.') : t('Pick a project.');
    return;
  }
  let d;
  try {
    d = await ctx.api(`/trust/report?${query()}`);
  } catch (e) {
    $('#tr-status').textContent = e.message;
    $('#tr-report').replaceChildren();
    return;
  }
  const el = ctx.el;
  const s = d.summary;
  $('#tr-status').textContent = d.scope.kind === 'week' ? t('Seven days from {day}.', { day: d.from.slice(0, 10) }) : d.scope.kind === 'run' ? t('Run {n}.', { n: d.scope.id }) : t('Project: {name}', { name: d.title.replace(/^Project: /, '') });
  const li = (text, cls = '') => el('li', cls, text);
  const sum = el('section', 'tr-card');
  sum.append(el('h4', '', t('Summary')));
  const nums = el('div', 'tr-nums small');
  nums.append(
    el('span', '', t('{n} runs', { n: s.runs })),
    el('span', '', t('{n} model calls', { n: s.modelCalls })),
    el('span', '', t('{n} tool calls', { n: s.toolCalls })),
    el('span', s.failedTools ? 'tr-flag' : '', t('{n} failed', { n: s.failedTools })),
    el('span', d.claims.length ? 'tr-flag' : '', t('{n} claims flagged', { n: d.claims.length + d.more.claims })),
    el('span', '', t('about {usd}', { usd: money(s.usd) }) + (s.unpricedCalls ? ` · ${t('{n} calls with no price', { n: s.unpricedCalls })}` : '')),
  );
  sum.append(nums);
  const a = d.approvals;
  $('#tr-report').replaceChildren(
    sum,
    card(t('Claims checked'), d.claims.map((c) => li(t('Run {run}: "{sentence}" ({problem})', { run: c.run, sentence: c.sentence, problem: PROBLEM[c.problem]?.() ?? c.problem }), 'tr-flag')), t('No claim was flagged: every claim the receipts check looks for had a tool receipt.'), d.more.claims),
    card(t('Tool calls'), d.tools.map((x) => li(t('{name}: {ok} done, {error} failed, {denied} not run', { name: x.name, ok: x.ok, error: x.error, denied: x.denied }))), t('No tool calls.')),
    card(t('Failed tools'), d.failed.map((f) => li(t('Run {run}, {name}: {output}', { run: f.run, name: f.name, output: f.output || f.summary }))), t('None.'), d.more.failed),
    card(t('Approvals'), [li(t('Ran without asking: {n}', { n: a.auto })), li(t('Allowed by a person: {n}', { n: a.allowed })), li(t('Denied by a person: {n}', { n: a.denied })), li(t('Refused: {n}', { n: a.refused }))], ''),
    card(t('Policy refusals'), [...d.refusals.map((f) => li(t('Run {run}, {name} ({why})', { run: f.run, name: f.name, why: WHY[f.why]?.() ?? f.why }))), ...(d.auditRefused ? [li(t('Refused in the audit trail: {n}', { n: d.auditRefused }))] : [])], t('None.'), d.more.refusals),
    card(t('Sandbox'), d.sandbox.map((x) => li(t('Run {run}, {name}: {isolation}, {choice}', x))), t('No sandbox tries.'), d.more.sandbox),
    card(t('Sources cited'), [...d.sources.map((x) => li(`${x.status === 'read' ? t('Read') : t('Failed')}: ${x.url}`)), ...d.searches.map((q) => li(t('Searched: {q}', { q })))], t('No web sources.'), d.more.sources + d.more.searches),
    card(t('Audit trail'), d.audit.map((r) => li(`${r.at.slice(0, 16).replace('T', ' ')} · ${r.action}${r.target ? ` ${r.target}` : ''} · ${r.who} · ${OUTCOME[r.outcome]?.() ?? r.outcome}`)), d.scope.kind === 'project' ? t('A project has no time window: see a week or a run for audit rows.') : t('No audit rows in this window.'), d.more.audit),
  );
}
