// EC15 (docs/ops/EC1115_DESIGN.md): Settings → Household → Usage reports. A table by day, week or
// month split by person, workspace, project and model; CSV download; monthly budgets (owner only).
// The server decides who sees what (members only ever get their own rows).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, isMember: () => boolean } | null} */
let ctx = null;
let budgets = [];

const GROUP = { person: () => t('Who'), workspace: () => t('Workspace'), project: () => t('Project'), model: () => t('Model') };
const LEVEL = { ok: () => t('On track'), near: () => t('Nearly used'), reached: () => t('Reached') };

export function initUsageReport(c) {
  ctx = c;
  for (const id of ['#ur-period', '#ur-from', '#ur-to']) $(id)?.addEventListener('change', () => void loadReport());
  for (const box of document.querySelectorAll('.ur-by input[data-by]')) box.addEventListener('change', () => void loadReport());
  $('#ur-csv')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/usage/report.csv?${query()}`;
    a.download = 'sara-usage.csv';
    a.click();
  });
  $('#ur-b-add')?.addEventListener('click', () => void addBudget());
  const page = document.querySelector('.settings-page[data-page="dh-usage-report"]');
  if (page) new MutationObserver(() => !page.hidden && void (loadReport(), loadBudgets())).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

function query() {
  const q = new URLSearchParams();
  q.set('period', $('#ur-period')?.value || 'day');
  const by = [...document.querySelectorAll('.ur-by input[data-by]:checked')].map((b) => b.dataset.by);
  q.set('by', by.join(','));
  if ($('#ur-from')?.value) q.set('from', $('#ur-from').value);
  if ($('#ur-to')?.value) q.set('to', $('#ur-to').value);
  return q;
}

const money = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n) => Number(n).toLocaleString();

export async function loadReport() {
  if (!ctx || !$('#ur-table')) return;
  let d;
  try {
    d = await ctx.api(`/usage/report?${query()}`);
  } catch (e) {
    $('#ur-total').textContent = e.message;
    return;
  }
  const el = ctx.el;
  $('#ur-total').textContent = t('{calls} calls · {tokens} tokens · about {usd}', { calls: num(d.totals.calls), tokens: num(d.totals.tokens), usd: money(d.totals.usd) }) + (d.totals.unpriced ? ' · ' + t('{n} calls with no price', { n: d.totals.unpriced }) : '');
  const head = el('tr');
  for (const h of [t('Period'), ...d.by.map((g) => GROUP[g]()), t('Calls'), t('Tokens'), t('Cost')]) head.append(el('th', '', h));
  const rows = d.rows.slice(0, 1000).map((r) => {
    const tr = el('tr');
    for (const v of [r.bucket, ...d.by.map((g) => r[g] || t('(none)')), num(r.calls), num(r.tokens), money(r.usd)]) tr.append(el('td', '', v));
    return tr;
  });
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'muted small', t('No model calls in this period.'));
    td.colSpan = d.by.length + 4;
    tr.append(td);
    rows.push(tr);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  tbody.append(...rows);
  $('#ur-table').replaceChildren(thead, tbody);
}

export async function loadBudgets() {
  const box = $('#ur-budgets-box');
  if (!ctx || !box) return;
  if (ctx.isMember()) {
    box.hidden = true;
    return;
  }
  let d;
  try {
    d = await ctx.api('/usage/budgets');
  } catch {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  budgets = d.budgets;
  const el = ctx.el;
  const key = $('#ur-b-key');
  key.replaceChildren(...d.people.map((p) => new Option(t('Person: {name}', { name: p.name }), `person:${p.id}`)), ...d.workspaces.map((w) => new Option(t('Workspace: {name}', { name: w }), `workspace:${w}`)));
  const label = (s) => (s.scope === 'person' ? t('Person: {name}', { name: d.people.find((p) => p.id === s.key)?.name ?? s.key }) : t('Workspace: {name}', { name: s.key }));
  if (!d.status.length) {
    $('#ur-budgets').replaceChildren(el('p', 'muted small', t('No budgets yet.')));
    return;
  }
  $('#ur-budgets').replaceChildren(
    ...d.status.map((s) => {
      const row = el('div', 'ur-budget');
      row.dataset.level = s.level;
      const limit = [s.usd ? money(s.usd) : '', s.tokens ? t('{n} tokens', { n: num(s.tokens) }) : ''].filter(Boolean).join(' / ');
      const used = [s.usd ? money(s.spent.usd) : '', s.tokens ? t('{n} tokens', { n: num(s.spent.tokens) }) : ''].filter(Boolean).join(' / ');
      row.append(el('strong', '', label(s)), el('span', 'small', t('{used} of {limit} this month ({pct}%)', { used, limit, pct: Math.round(s.frac * 100) })), el('span', 'ur-level small', LEVEL[s.level]()));
      const remove = el('button', 'ghost small', t('Remove'));
      remove.type = 'button';
      remove.addEventListener('click', () => void save(budgets.filter((b) => !(b.scope === s.scope && b.key === s.key))));
      row.append(remove);
      return row;
    }),
  );
}

async function save(list) {
  $('#ur-b-error').textContent = '';
  try {
    await ctx.api('/usage/budgets', { method: 'PUT', body: { budgets: list } });
    await loadBudgets();
  } catch (e) {
    $('#ur-b-error').textContent = e.message;
  }
}

async function addBudget() {
  const [scope, ...rest] = String($('#ur-b-key').value).split(':');
  const key = rest.join(':');
  if (!key) return;
  const b = { scope, key, alertAt: Number($('#ur-b-alert').value) };
  if ($('#ur-b-usd').value) b.usd = Number($('#ur-b-usd').value);
  if ($('#ur-b-tokens').value) b.tokens = Number($('#ur-b-tokens').value);
  await save([...budgets.filter((x) => !(x.scope === scope && x.key === key)), b]);
  $('#ur-b-usd').value = '';
  $('#ur-b-tokens').value = '';
}
