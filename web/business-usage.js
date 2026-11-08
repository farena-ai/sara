// EC15: Usage reports for organization administrators: the spending ledger per person, workspace and model.
import { t, attachTips } from './business-i18n.js';

const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const select = (id, label, tip, options) => {
  const wrapper = element('label', label); const input = element('select'); input.id = id; input.dataset.tip = tip;
  for (const [value, text] of options) { const option = element('option', text); option.value = value; input.append(option); }
  wrapper.append(input); return { wrapper, input };
};
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

export async function renderUsageReport({ api, host, run, current }) {
  const section = element('section'); section.className = 'sso-settings usage-report'; section.id = 'business-usage';
  section.append(element('h2', t('Usage reports')));
  section.append(element('p', t('What the model calls in this organization used and cost, from the spending ledger. Message contents are never part of this report.')));
  const period = select('usage-period', t('Period'), t('Adds up each day, each week (starting Monday) or each month, in your browser’s time zone.'), [['day', t('Daily')], ['week', t('Weekly')], ['month', t('Monthly')]]);
  const by = select('usage-by', t('Group by'), t('One row per person, workspace or model, or every combination of the three.'), [['person', t('Person')], ['workspace', t('Workspace')], ['model', t('Model')], ['person,workspace,model', t('Person, workspace and model')]]);
  const controls = element('div'); controls.className = 'usage-controls'; controls.append(period.wrapper, by.wrapper);
  const csv = element('a', t('Download CSV')); csv.className = 'button'; csv.id = 'usage-csv';
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const wrap = element('div'); wrap.className = 'usage-table';
  const totals = element('p'); totals.className = 'muted';
  const note = element('p', t('Unknown cost: requests held for the operator to reconcile, so their usage isn’t settled yet.')); note.className = 'muted';
  section.append(controls, csv, status, wrap, totals, note);
  host.append(section); attachTips(section);
  const money = value => `$${Number(value).toFixed(value < 1 ? 4 : 2)}`;
  const load = () => run(async () => {
    const query = `period=${encodeURIComponent(period.input.value)}&by=${encodeURIComponent(by.input.value)}&tz=${encodeURIComponent(zone())}`;
    csv.href = `/api/business/usage/report.csv?${query}`; csv.setAttribute('download', '');
    const report = await api(`/usage/report?${query}`); if (!current()) return;
    const groups = report.by;
    const names = { person: t('Person'), workspace: t('Workspace'), model: t('Model') };
    const table = element('table'); const head = element('tr');
    for (const text of [t('Period'), ...groups.map(group => names[group]), t('Calls'), t('Tokens'), t('Cost'), t('Unknown cost')]) head.append(element('th', text));
    const thead = element('thead'); thead.append(head); const body = element('tbody');
    for (const row of report.rows) {
      const line = element('tr');
      for (const text of [row.bucket, ...groups.map(group => row[group] || (group === 'model' ? t('(unknown)') : '')), String(row.calls), row.tokens.toLocaleString(), money(row.usd), String(row.unpriced)]) line.append(element('td', text));
      body.append(line);
    }
    table.append(thead, body); wrap.replaceChildren(report.rows.length ? table : element('p', t('No model calls in the last 30 days.')));
    totals.textContent = t('Last 30 days: {calls} calls, {tokens} tokens, {usd}.', { calls: report.totals.calls, tokens: report.totals.tokens.toLocaleString(), usd: money(report.totals.usd) });
  }, period.input);
  period.input.onchange = load; by.input.onchange = load;
  await load();
}
