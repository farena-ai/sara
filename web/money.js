// U4.20 (docs/MONEY.md): the Money place (a sidebar place). Bank and card exports (CSV with a column
// mapping saved per bank, OFX/QFX, QIF, Excel), spending by category, trends, budgets with gentle
// alerts, bills due, subscriptions (from transactions and mail, with price changes, trials ending and
// a how-to-cancel link), net worth from typed balances, categories the person edits. Tracking only:
// she never logs in to a bank, pays, transfers or cancels anything.
import { t } from './naming.js';
import { initPurchases, loadPurchases } from './purchases.js';
import { initTrim, loadTrim, markUnused } from './trim.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let data = null;
let month = '';
let pending = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#mn-status');
  if (s) s.textContent = msg;
};
const loc = () => document.documentElement.lang || undefined;
const cur = (cents) => new Intl.NumberFormat(loc(), { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(loc(), { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const monthText = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString(loc(), { month: 'short', timeZone: 'UTC' });
const CAT = () => ({ groceries: t('Groceries'), dining: t('Dining'), fuel: t('Fuel'), utilities: t('Utilities'), subscriptions: t('Subscriptions'), shopping: t('Shopping'), travel: t('Travel'), health: t('Health'), income: t('Income'), transfers: t('Transfers'), other: t('Other') });
const catName = (c) => CAT()[c] ?? c;
/** A merchant key ("blue door cafe") as a name ("Blue Door Cafe"). */
const nice = (m) => String(m ?? '').replace(/(^|\s)\p{L}/gu, (x) => x.toUpperCase());

async function call(path, method, body, done) {
  try {
    const r = await ctx.api(path, { method, body });
    if (done) say(typeof done === 'function' ? done(r) : done);
    await loadMoney();
    return r;
  } catch (err) {
    say(err.message);
    return undefined;
  }
}

export function initMoney(c) {
  ctx = c;
  initPurchases(c);
  initTrim(c);
  $('#mn-import-go')?.addEventListener('click', () => void importNow());
  $('#mn-prev')?.addEventListener('click', () => void shiftMonth(-1));
  $('#mn-next')?.addEventListener('click', () => void shiftMonth(1));
  const prefs = (body) => void call('/money/prefs', 'PUT', body, t('Saved.'));
  $('#mn-gentle')?.addEventListener('change', (e) => prefs({ gentle: e.target.checked }));
  $('#mn-suggest')?.addEventListener('change', (e) => prefs({ suggest: e.target.checked }));
  $('#mn-near')?.addEventListener('change', (e) => prefs({ nearPct: Number(e.target.value) }));
  $('#mn-bal-add')?.addEventListener('click', () => {
    const name = $('#mn-bal-name').value.trim();
    const amount = $('#mn-bal-amount').value.trim();
    void call('/money/balances', 'POST', { name, amount, kind: $('#mn-bal-kind').value }, t('Saved.')).then((r) => {
      if (r) $('#mn-bal-name').value = $('#mn-bal-amount').value = '';
    });
  });
}

async function shiftMonth(n) {
  const [y, m] = (month || data?.monthKey || '').split('-').map(Number);
  if (!y) return;
  const d = new Date(Date.UTC(y, m - 1 + n, 15));
  month = d.toISOString().slice(0, 7);
  await loadMoney();
}

const fileB64 = (file) =>
  new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] ?? '');
    r.onerror = () => bad(r.error);
    r.readAsDataURL(file);
  });

async function importNow(mapping) {
  const file = $('#mn-file')?.files?.[0];
  if (!file && !pending) return say(t('Pick a bank or card export file.'));
  if (file) pending = { name: file.name, data: await fileB64(file) };
  say(t('Reading {file}…', { file: pending.name }));
  try {
    const r = await ctx.api('/money/import', { method: 'POST', body: { ...pending, account: $('#mn-account').value.trim() || undefined, mapping } });
    if (r.needMapping) return showMapping(r);
    $('#mn-map').hidden = true;
    pending = null;
    $('#mn-file').value = '';
    say(t('{file}: {added} new, {dup} already here.', { file: r.file, added: r.added, dup: r.duplicates }));
    await loadMoney();
  } catch (err) {
    say(err.message);
  }
}

/** A CSV whose columns weren't recognized: the person says which is which, once per bank. */
function showMapping(r) {
  const box = $('#mn-map');
  box.hidden = false;
  say('');
  const pick = (label, key, optional) => {
    const row = el('label', 'mn-map-row');
    const sel = el('select');
    sel.dataset.key = key;
    if (optional) sel.append(new Option(t('(none)'), ''));
    r.columns.forEach((c, i) => sel.append(new Option(c || `#${i + 1}`, String(i))));
    if (!optional) sel.value = String({ date: 0, description: 1 }[key] ?? 0);
    // The amount: the first sample column that looks like money ("-8.25", "1,200.00").
    if (key === 'amount') sel.value = String(Math.max(0, r.columns.findIndex((_, i) => i > 1 && r.sample.some((s) => /^[-+(]?\$?\d[\d,.]*\)?$/.test(s[i] ?? '')))));
    row.append(el('span', '', label), sel);
    return row;
  };
  const bank = el('input');
  bank.placeholder = t('Bank name');
  bank.setAttribute('aria-label', t('Bank name'));
  const flip = el('label', 'mn-check');
  const fx = el('input');
  fx.type = 'checkbox';
  flip.append(fx, ` ${t('Charges are positive numbers')}`);
  const sample = el('p', 'muted small mn-sample', r.sample.map((s) => s.join(' · ')).join('\n'));
  box.replaceChildren(
    el('p', 'small', t('Which column is which? She remembers it for this bank’s next file.')),
    sample,
    pick(t('Date'), 'date'),
    pick(t('Description'), 'description'),
    pick(t('Amount'), 'amount', true),
    pick(t('Money out'), 'debit', true),
    pick(t('Money in'), 'credit', true),
    bank,
    flip,
    btn(t('Use these columns'), 'small', () => {
      const m = { bank: bank.value.trim(), flip: fx.checked };
      for (const s of box.querySelectorAll('select')) if (s.value !== '') m[s.dataset.key] = Number(s.value);
      void importNow(m);
    }),
  );
}

/** Opens Money; from an Ask hit, at the transaction. */
export async function openMoney(o) {
  await loadMoney();
  if (!$('#money').open) $('#money').showModal();
  const row = o?.tx && $(`#mn-tx [data-tx="${Number(o.tx)}"]`);
  if (row) {
    row.classList.add('ask-spot');
    row.scrollIntoView?.({ block: 'center' });
    setTimeout(() => row.classList.remove('ask-spot'), 4000);
  }
}

export async function loadMoney() {
  if (!ctx) return;
  try {
    data = await ctx.api(`/money${month ? `?month=${month}` : ''}`);
  } catch (err) {
    say(err.message);
    return;
  }
  render();
}

function bar(pct, state) {
  const b = el('span', `mn-bar mn-${state ?? 'ok'}`);
  const f = el('span', 'mn-fill');
  f.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  b.append(f);
  return b;
}

function renderMonth() {
  const m = data.month;
  $('#mn-label').textContent = m.label;
  const box = $('#mn-month');
  if (!data.hasData) return box.replaceChildren(el('p', 'muted small', t('Nothing loaded yet. Download a CSV, OFX, QFX or QIF export from your bank’s website and add it above.')));
  const head = el('p', 'mn-big');
  const diff = m.spentCents - m.previousSpentCents;
  head.append(el('strong', '', cur(m.spentCents)), el('span', 'muted small', ` ${t('spent')} · ${t('income {amount}', { amount: cur(m.incomeCents) })} · ${diff >= 0 ? '+' : '−'}${cur(Math.abs(diff))} ${t('vs the month before')}`));
  const max = Math.max(1, ...m.byCategory.map((c) => c.cents));
  const ul = el('ul', 'mn-cats');
  for (const c of m.byCategory) {
    const li = el('li', 'mn-cat');
    li.append(el('span', 'mn-cat-name', catName(c.category)), bar((c.cents / max) * 100), el('span', 'mn-amt', cur(c.cents)));
    ul.append(li);
  }
  box.replaceChildren(head, ul);
}

function renderTrends() {
  const tr = data.trends;
  const box = $('#mn-trends');
  if (!tr.categories.length) return box.replaceChildren(el('p', 'muted small', t('No spending in these months yet.')));
  const max = Math.max(1, ...tr.totals);
  const cols = el('div', 'mn-trend');
  tr.months.forEach((m, i) => {
    const col = el('div', 'mn-tcol');
    const stick = el('span', 'mn-tbar');
    stick.style.height = `${Math.round((tr.totals[i] / max) * 100)}%`;
    stick.title = cur(tr.totals[i]);
    col.append(el('span', 'small mn-tval', cur(tr.totals[i]).replace(/\.\d\d$/, '')), el('span', 'mn-tstick', ''), el('span', 'muted small', monthText(m)));
    col.children[1].append(stick);
    cols.append(col);
  });
  const top = el('ul', 'mn-tlist small');
  for (const c of tr.categories.slice(0, 5)) top.append(el('li', '', `${catName(c.category)}: ${c.cents.map((x) => cur(x).replace(/\.\d\d$/, '')).join(' → ')}`));
  box.replaceChildren(cols, top);
}

function renderBudgets() {
  const box = $('#mn-budgets');
  const ul = el('ul', 'mn-cats');
  for (const b of data.budgets) {
    const li = el('li', 'mn-cat');
    li.append(el('span', 'mn-cat-name', catName(b.category)), bar(b.pct, b.state), el('span', `mn-amt${b.state === 'over' ? ' mn-over-t' : ''}`, `${cur(b.spentCents)} / ${cur(b.limitCents)}`), btn(t('Remove'), 'ghost small', () => void call('/money/limits', 'PUT', { category: b.category, amount: 0 })));
    ul.append(li);
  }
  const add = el('div', 'mn-row');
  const sel = el('select');
  sel.setAttribute('aria-label', t('Category'));
  for (const c of data.categories.filter((x) => x !== 'income' && x !== 'transfers')) sel.append(new Option(catName(c), c));
  const amt = el('input');
  amt.inputMode = 'decimal';
  amt.placeholder = t('Monthly amount');
  amt.setAttribute('aria-label', t('Monthly amount'));
  add.append(sel, amt, btn(t('Set budget'), 'small', () => void call('/money/limits', 'PUT', { category: sel.value, amount: amt.value.trim() }, t('Saved.'))));
  box.replaceChildren(...(data.budgets.length ? [ul] : [el('p', 'muted small', t('No budgets yet.'))]), add);
}

function renderBills() {
  const box = $('#mn-bills');
  const ul = el('ul', 'mn-list');
  for (const b of data.due.bills) {
    const li = el('li', 'mn-item');
    const when = b.days < 0 ? t('was due {day}', { day: dayText(b.due) }) : b.days === 0 ? t('due today') : t('due {day} (in {n} days)', { day: dayText(b.due), n: b.days });
    li.append(el('strong', '', b.name), el('span', `small ${b.days <= 3 && !b.paid ? 'mn-over-t' : 'muted'}`, [b.amountCents === null ? '' : cur(b.amountCents), when, b.autopay ? t('autopay') : '', b.reminder ? t('reminder {n} days before', { n: b.leadDays }) : ''].filter(Boolean).join(' · ')));
    const acts = el('span', 'mn-acts');
    acts.append(btn(t('Mark paid'), 'ghost small', () => void call(`/money/bills/${b.id}/paid`, 'POST', {}, t('Marked paid.'))), btn(t('Stop tracking'), 'ghost small', () => void call(`/money/bills/${b.id}`, 'DELETE')));
    li.append(acts);
    ul.append(li);
  }
  for (const r of data.due.recurring) {
    const li = el('li', 'mn-item mn-found');
    li.append(el('strong', '', nice(r.merchant)), el('span', 'muted small', [cur(r.amountCents), t('next about {day}', { day: dayText(r.next) }), t('found in your transactions')].join(' · ')));
    li.append(btn(t('Track with a reminder'), 'ghost small', () => void call('/money/bills', 'POST', { merchant: r.merchant }, t('Tracked, with a reminder 3 days before.'))));
    ul.append(li);
  }
  const add = el('div', 'mn-row');
  const name = el('input');
  name.placeholder = t('Bill name');
  name.setAttribute('aria-label', t('Bill name'));
  const amt = el('input');
  amt.inputMode = 'decimal';
  amt.placeholder = t('Amount');
  amt.setAttribute('aria-label', t('Amount'));
  const due = el('input');
  due.type = 'number';
  due.min = '1';
  due.max = '31';
  due.placeholder = t('Day');
  due.setAttribute('aria-label', t('Day of the month'));
  add.append(name, amt, due, btn(t('Add bill'), 'small', () => void call('/money/bills', 'POST', { name: name.value.trim(), amount: amt.value.trim(), dueDay: Number(due.value) }, t('Tracked, with a reminder 3 days before.'))));
  box.replaceChildren(...(ul.childElementCount ? [ul] : [el('p', 'muted small', t('No bills yet. Bills from your inbox and repeating charges show up here.'))]), add);
}

function cancelA(url) {
  const a = el('a', 'small', t('How to cancel'));
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function renderSubs() {
  const box = $('#mn-subs');
  const ul = el('ul', 'mn-list');
  const every = { week: t('a week'), month: t('a month'), year: t('a year') };
  for (const s of data.subscriptions) {
    const li = el('li', 'mn-item');
    const top = el('div', 'mn-top');
    top.append(el('strong', '', nice(s.merchant)));
    if (s.priceChange) top.append(el('span', 'er-chip mn-chip mn-warn', t('Price went from {from} to {to}', { from: cur(s.priceChange.fromCents), to: cur(s.priceChange.toCents) })));
    if (s.maybeStopped) top.append(el('span', 'er-chip mn-chip', t('Maybe stopped')));
    li.append(top, el('span', 'muted small', [`${cur(s.amountCents)} ${every[s.every]}`, t('{amount} a year', { amount: cur(s.yearlyCents) }), t('next about {day}', { day: dayText(s.next) })].join(' · ')));
    const acts = el('span', 'mn-acts');
    acts.append(cancelA(s.cancel), btn(t('Not using it'), 'ghost small', () => void markUnused(nice(s.merchant))));
    li.append(acts);
    ul.append(li);
  }
  for (const m of data.mailSubs) {
    const li = el('li', 'mn-item mn-found');
    const top = el('div', 'mn-top');
    const kind = { trial: t('Free trial ends {day}', { day: dayText(m.ends) }), price: m.fromCents ? t('Price went from {from} to {to}', { from: cur(m.fromCents), to: cur(m.toCents) }) : t('Price change'), renewal: t('Renews {day}', { day: dayText(m.ends) }) }[m.kind];
    top.append(el('strong', '', m.merchant), el('span', `er-chip mn-chip${m.kind === 'renewal' ? '' : ' mn-warn'}`, kind));
    li.append(top, el('span', 'muted small', `${t('From your email')}: ${m.subject}`));
    const acts = el('span', 'mn-acts');
    acts.append(cancelA(m.cancel), btn(t('Not using it'), 'ghost small', () => void markUnused(m.merchant)), btn(t('Hide'), 'ghost small', () => void call(`/money/mailsubs/${m.id}`, 'DELETE')));
    li.append(acts);
    ul.append(li);
  }
  const yearly = data.subscriptions.reduce((n, s) => n + (s.maybeStopped ? 0 : s.yearlyCents), 0);
  box.replaceChildren(...(ul.childElementCount ? [el('p', 'small', t('About {amount} a year in subscriptions.', { amount: cur(yearly) })), ul] : [el('p', 'muted small', t('No subscriptions found yet.'))]));
}

function renderNet() {
  const nw = data.netWorth;
  const box = $('#mn-net');
  const head = el('p', 'mn-big');
  head.append(el('strong', '', cur(nw.netCents)), el('span', 'muted small', ` ${t('assets {a} · debts {d}', { a: cur(nw.assetsCents), d: cur(nw.debtsCents) })}`));
  const ul = el('ul', 'mn-list');
  if (nw.portfolioCents !== null) ul.append(el('li', 'mn-item muted small', t('Investments (last checked value): {amount}', { amount: cur(nw.portfolioCents) })));
  for (const b of nw.balances) {
    const li = el('li', 'mn-item mn-bal');
    const amt = el('input');
    amt.inputMode = 'decimal';
    amt.value = (b.cents / 100).toFixed(2);
    amt.setAttribute('aria-label', t('Balance of {name}', { name: b.name }));
    amt.addEventListener('change', () => void call(`/money/balances/${b.id}`, 'PATCH', { amount: amt.value.trim() }, t('Saved.')));
    li.append(el('strong', '', b.name), el('span', 'muted small', b.kind === 'debt' ? t('Debt') : t('Asset')), amt, btn(t('Remove'), 'ghost small', () => void call(`/money/balances/${b.id}`, 'DELETE')));
    ul.append(li);
  }
  const hist = nw.history.length > 1 ? el('p', 'muted small', nw.history.slice(-6).map((h) => `${dayText(h.day)} ${cur(h.netCents).replace(/\.\d\d$/, '')}`).join(' → ')) : null;
  box.replaceChildren(head, ...(hist ? [hist] : []), ul);
}

function renderRules() {
  const box = $('#mn-rules');
  const ul = el('ul', 'mn-list');
  const catSel = (value, onChange) => {
    const sel = el('select');
    const cats = [...new Set([...data.categories, value].filter(Boolean))];
    for (const c of cats) sel.append(new Option(catName(c), c));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };
  for (const r of data.rules) {
    const li = el('li', 'mn-item mn-rule');
    const sel = catSel(r.category, (v) => void call('/money/rules', 'PUT', { merchant: r.merchant, category: v }, t('Saved.')));
    sel.setAttribute('aria-label', t('Category for {merchant}', { merchant: r.merchant }));
    li.append(el('span', '', nice(r.merchant)), sel, btn(t('Remove'), 'ghost small', () => void call(`/money/rules?merchant=${encodeURIComponent(r.merchant)}`, 'DELETE')));
    ul.append(li);
  }
  const parts = [ul];
  if (data.uncategorized.length) parts.push(el('p', 'muted small', t('Not sorted yet: {list}', { list: data.uncategorized.slice(0, 8).join(', ') })));
  if (data.prefs.suggest && data.uncategorized.length)
    parts.push(
      btn(t('Suggest categories'), 'ghost small', async () => {
        say(t('Asking your model…'));
        try {
          const r = await ctx.api('/money/suggest', { method: 'POST', body: {} });
          const list = el('ul', 'mn-list');
          for (const s of r.suggestions) {
            const li = el('li', 'mn-item mn-rule');
            li.append(el('span', '', `${nice(s.merchant)} → ${catName(s.category)}`), btn(t('Use this'), 'ghost small', () => void call('/money/rules', 'PUT', s, t('Saved.'))));
            list.append(li);
          }
          box.append(list);
          say(r.suggestions.length ? '' : t('No suggestions.'));
        } catch (err) {
          say(err.message);
        }
      }),
    );
  for (const m of data.mappings) parts.push(el('p', 'muted small', t('Saved columns for {bank}', { bank: m.bank || m.columns.slice(0, 3).join(', ') })), btn(t('Forget these columns'), 'ghost small', () => void call(`/money/mappings/${encodeURIComponent(m.sig)}`, 'DELETE')));
  box.replaceChildren(...(data.rules.length ? [] : [el('p', 'muted small', t('Change a transaction’s category below and she remembers it for that merchant.'))]), ...parts);
}

function renderTx() {
  const box = $('#mn-tx');
  const ul = el('ul', 'mn-list mn-txs');
  for (const x of data.transactions.slice(0, 60)) {
    const li = el('li', 'mn-item mn-txrow');
    li.dataset.tx = String(x.id);
    const sel = el('select');
    for (const c of [...new Set([...data.categories, x.category])]) sel.append(new Option(catName(c), c));
    sel.value = x.category;
    sel.setAttribute('aria-label', t('Category for {merchant}', { merchant: x.merchant || x.description }));
    sel.addEventListener('change', () => void call(`/money/tx/${x.id}`, 'PATCH', { category: sel.value }, (r) => t('Saved. {n} more moved for this merchant.', { n: Math.max(0, r.changed - 1) })));
    li.append(el('span', 'muted small', dayText(x.date)), el('span', 'mn-desc', x.description), el('span', `mn-amt${x.amountCents > 0 ? ' mn-in' : ''}`, cur(x.amountCents)), sel);
    ul.append(li);
  }
  const imp = data.imports.length ? el('p', 'muted small', t('Last files: {list}', { list: data.imports.slice(0, 3).map((i) => `${i.name} (+${i.added}, ${i.duplicates} ${t('already here')})`).join('; ') })) : null;
  box.replaceChildren(...(ul.childElementCount ? [ul] : [el('p', 'muted small', t('No transactions this month.'))]), ...(imp ? [imp] : []));
}

function render() {
  if (!data) return;
  $('#mn-only').textContent = data.trackingOnly;
  $('#mn-gentle').checked = data.prefs.gentle;
  $('#mn-suggest').checked = data.prefs.suggest;
  $('#mn-near').value = String(data.prefs.nearPct);
  renderMonth();
  renderTrends();
  renderBudgets();
  renderBills();
  renderSubs();
  void loadTrim();
  void loadPurchases();
  renderNet();
  renderRules();
  renderTx();
}
