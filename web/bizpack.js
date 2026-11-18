// U4.29 (docs/BUSINESS_PACK.md): the Business place (a sidebar place). Timer and added time, clients
// with rate and terms, invoices and quotes (mark sent/paid, quote → invoice, Email it in chat so the
// person approves the exact email), expenses (also from Money rows), the client portal link and the
// bookkeeping CSV. She never charges a card or takes a payment.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, ask?: (text: string) => Promise<void> } | null} */
let ctx = null;
let data = null;
let editing = 0;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#bp-status');
  if (s) s.textContent = msg;
};
const loc = () => document.documentElement.lang || undefined;
const cur = (cents, c) => new Intl.NumberFormat(loc(), { style: 'currency', currency: c || data?.details?.currency || 'USD' }).format((cents ?? 0) / 100);
const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(loc(), { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const hrs = (h) => t('{n} h', { n: new Intl.NumberFormat(loc(), { maximumFractionDigits: 2 }).format(h ?? 0) });
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const STATUS = () => ({ draft: t('Draft'), sent: t('Sent'), overdue: t('Overdue'), paid: t('Paid'), accepted: t('Accepted'), void: t('Void') });
const CAT = () => ({ Meals: t('Meals'), Travel: t('Travel'), Lodging: t('Lodging'), Fuel: t('Fuel'), 'Office supplies': t('Office supplies'), Software: t('Software'), Equipment: t('Equipment'), 'Phone and internet': t('Phone and internet'), Advertising: t('Advertising'), 'Professional services': t('Professional services'), Shipping: t('Shipping'), Other: t('Other') });
const catName = (c) => CAT()[c] ?? c;

async function call(path, method, body, done) {
  try {
    const r = await ctx.api(path, { method, body });
    if (r && r.clients) {
      data = r;
      render();
    } else await loadBizPack();
    if (done) say(typeof done === 'function' ? done(r) : done);
    return r;
  } catch (err) {
    say(err.message);
    return undefined;
  }
}

export function initBizPack(c) {
  ctx = c;
  $('#bp-t-start')?.addEventListener('click', () => void call('/bizpack/timer', 'POST', { action: 'start', client: $('#bp-t-client').value.trim(), project: $('#bp-t-project').value.trim() }, t('Timer started.')));
  $('#bp-t-stop')?.addEventListener('click', () => void call('/bizpack/timer', 'POST', { action: 'stop' }, t('Timer stopped.')));
  $('#bp-h-add')?.addEventListener('click', () => {
    const body = { day: $('#bp-h-day').value || localDay(), hours: $('#bp-h-hours').value.trim(), client: $('#bp-h-client').value.trim(), project: $('#bp-h-project').value.trim() };
    void call('/bizpack/time', 'POST', body, t('Time added.')).then((r) => {
      if (r) $('#bp-h-hours').value = '';
    });
  });
  $('#bp-c-save')?.addEventListener('click', () => {
    const body = { ...(editing ? { id: editing } : {}), name: $('#bp-c-name').value.trim(), email: $('#bp-c-email').value.trim(), rate: $('#bp-c-rate').value.trim(), termsDays: $('#bp-c-terms').value.trim(), phone: $('#bp-c-phone').value.trim(), address: $('#bp-c-address').value.trim() };
    void call('/bizpack/clients', 'POST', body, t('Saved.')).then((r) => {
      if (r) editClient(null);
    });
  });
  $('#bp-c-new')?.addEventListener('click', () => editClient(null));
  $('#bp-e-add')?.addEventListener('click', () => {
    const body = { vendor: $('#bp-e-vendor').value.trim(), total: $('#bp-e-total').value.trim(), category: $('#bp-e-cat').value, date: $('#bp-e-date').value || localDay() };
    void call('/bizpack/expenses', 'POST', body, t('Expense added.')).then((r) => {
      if (r) $('#bp-e-vendor').value = $('#bp-e-total').value = '';
    });
  });
  $('#bp-p-make')?.addEventListener('click', () => void makeLink());
  $('#bp-x-go')?.addEventListener('click', () => {
    const q = new URLSearchParams({ from: $('#bp-x-from').value, to: $('#bp-x-to').value, format: $('#bp-x-format').value, what: $('#bp-x-what').value });
    const a = document.createElement('a');
    a.href = `/api/bizpack/export?${q}`;
    a.rel = 'noopener';
    a.click();
  });
}

export async function openBizPack() {
  if (!ctx) return;
  await loadBizPack();
  const d = $('#bizpack');
  if (d && !d.open) d.showModal();
}

export async function loadBizPack() {
  if (!ctx) return;
  try {
    data = await ctx.api('/bizpack');
  } catch (err) {
    say(err.message);
    return;
  }
  render();
}

function editClient(c) {
  editing = c?.id ?? 0;
  $('#bp-c-name').value = c?.name ?? '';
  $('#bp-c-email').value = c?.email ?? '';
  $('#bp-c-rate').value = c?.rateCents ? (c.rateCents / 100).toFixed(2) : '';
  $('#bp-c-terms').value = c?.termsDays ?? '';
  $('#bp-c-phone').value = c?.phone ?? '';
  $('#bp-c-address').value = c?.address ?? '';
  $('#bp-c-save').textContent = editing ? t('Save client') : t('Add client');
  $('#bp-c-new').hidden = !editing;
  if (editing) $('#bp-c-name').focus();
}

async function makeLink() {
  const client = $('#bp-p-client').value;
  if (!client) return say(t('Add a client first.'));
  const r = await call('/bizpack/portal', 'POST', { client, expires: $('#bp-p-exp').value }, t('Link made. Anyone with it can see this page until it expires.'));
  if (!r?.link) return;
  const p = $('#bp-p-link');
  const input = Object.assign(el('input', 'bp-link-in'), { value: r.link, readOnly: true });
  input.setAttribute('aria-label', t('Portal link'));
  p.replaceChildren(input, btn(t('Copy'), 'ghost small', () => void navigator.clipboard?.writeText(r.link).then(() => say(t('Copied.')))));
  p.hidden = false;
}

const empty = (text) => el('p', 'muted small', text);
const item = (...kids) => {
  const li = el('li', 'bp-item');
  li.append(...kids.filter(Boolean));
  return li;
};
const list = (rows) => {
  const ul = el('ul', 'bp-list');
  ul.append(...rows);
  return ul;
};
const chip = (text, warn) => el('span', `chip bp-chip${warn ? ' bp-warn' : ''}`, text);

function renderTimer() {
  const run = data.timer;
  $('#bp-running').hidden = !run;
  if (run) $('#bp-running').textContent = t('Running: {who} since {time} ({h} so far)', { who: [run.client, run.project].filter(Boolean).join(' · ') || t('work'), time: new Date(run.start).toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit' }), h: hrs(run.hours) });
  $('#bp-t-stop').hidden = !run;
  $('#bp-clients').replaceChildren(...data.clients.map((c) => Object.assign(el('option'), { value: c.name })));
  const rows = data.entries.slice(0, 12).map((e) => {
    const top = el('span', 'bp-desc', `${dayText(e.day)} · ${[e.client, e.project].filter(Boolean).join(' · ') || t('work')}`);
    const acts = el('span', 'bp-acts');
    acts.append(el('span', 'bp-amt', e.running ? t('running') : hrs(e.hours)));
    if (e.billed) acts.append(chip(t('Billed')));
    else if (!e.running) acts.append(btn(t('Remove'), 'ghost small', () => void call(`/bizpack/time/${e.id}`, 'DELETE', undefined, t('Removed.'))));
    return item(top, acts);
  });
  $('#bp-entries').replaceChildren(rows.length ? list(rows) : empty(t('No time in the last weeks.')));
}

function renderClients() {
  const rows = data.clients.map((c) => {
    const top = el('span', 'bp-desc');
    top.append(el('strong', '', c.name), el('span', 'muted small', [c.email, c.rateCents ? t('{rate}/h', { rate: cur(c.rateCents, c.currency) }) : '', c.termsDays !== null && c.termsDays !== undefined ? t('due in {n} days', { n: c.termsDays }) : ''].filter(Boolean).join(' · ')));
    const acts = el('span', 'bp-acts');
    if (c.unbilled > 0) acts.append(btn(t('Invoice {h}', { h: hrs(c.unbilled) }), 'small', () => void bill(c)));
    acts.append(btn(t('Edit'), 'ghost small', () => editClient(c)));
    return item(top, acts);
  });
  $('#bp-clist').replaceChildren(rows.length ? list(rows) : empty(t('No clients yet. Add one below, or ask her to.')));
  const pick = $('#bp-p-client');
  const was = pick.value;
  pick.replaceChildren(...data.clients.map((c) => Object.assign(el('option', '', c.name), { value: c.name })));
  if (was) pick.value = was;
}

async function bill(c) {
  await call('/bizpack/bill', 'POST', { client: c.name }, (x) => x?.said ?? t('Invoice made.'));
}

function renderInvoices() {
  const S = STATUS();
  const rows = data.invoices.map((i) => {
    const top = el('span', 'bp-desc');
    top.append(el('strong', '', `${i.number} · ${i.client}`), el('span', 'muted small', `${dayText(i.issued)}${i.due ? ` · ${i.kind === 'quote' ? t('valid until {date}', { date: dayText(i.due) }) : t('due {date}', { date: dayText(i.due) })}` : ''}${i.invoiced ? ` · ${t('invoiced as {n}', { n: i.invoiced })}` : ''}`));
    const acts = el('span', 'bp-acts');
    acts.append(el('span', 'bp-amt', cur(i.totalCents, i.currency)), chip(S[i.status] ?? i.status, i.status === 'overdue'));
    if (i.file) {
      const a = Object.assign(el('a', 'bp-open small', t('Open')), { href: `/api/library/made/${i.file}/file?inline=1`, target: '_blank', rel: 'noopener' });
      acts.append(a);
    }
    const mark = (status, label) => btn(label, 'ghost small', () => void call(`/bizpack/invoices/${i.id}`, 'POST', { status }, t('Saved.')));
    if (i.status !== 'void' && i.status !== 'paid' && (i.kind === 'invoice' || i.status !== 'accepted') && ctx.ask && i.email) acts.append(btn(t('Email it'), 'ghost small', () => void emailIt(i)));
    if (i.status === 'draft') acts.append(mark('sent', t('Mark sent')));
    if (i.kind === 'invoice' && (i.status === 'sent' || i.status === 'overdue')) acts.append(mark('paid', t('Mark paid')));
    if (i.kind === 'quote' && !i.invoiced && i.status !== 'void') acts.append(btn(t('Make invoice'), 'ghost small', () => void call(`/bizpack/invoices/${i.id}`, 'POST', { action: 'invoice' }, (r) => t('Made {n}.', { n: r?.made ?? '' }))));
    return item(top, acts);
  });
  $('#bp-invoices').replaceChildren(rows.length ? list(rows) : empty(t('No invoices or quotes yet. Ask her: “make an invoice for Rivera: 10 hours at $85”.')));
}

async function emailIt(i) {
  $('#bizpack')?.close();
  await ctx.ask(i.kind === 'quote' ? t('Email quote {n} to {client}.', { n: i.number, client: i.client }) : t('Email invoice {n} to {client}.', { n: i.number, client: i.client }));
}

function renderExpenses() {
  const cat = $('#bp-e-cat');
  if (!cat.options.length) cat.replaceChildren(...data.categories.map((c) => Object.assign(el('option', '', catName(c)), { value: c })));
  const rows = data.expenses.slice(0, 15).map((e) => {
    const acts = el('span', 'bp-acts');
    acts.append(el('span', 'bp-amt', cur(e.totalCents, e.currency)));
    if (e.billed) acts.append(chip(t('Billed')));
    return item(el('span', 'bp-desc', `${dayText(e.date)} · ${e.vendor} · ${catName(e.category)}`), acts);
  });
  $('#bp-expenses').replaceChildren(rows.length ? list(rows) : empty(t('No expenses yet.')));
  const m = data.money.slice(0, 10).map((x) => {
    const acts = el('span', 'bp-acts');
    acts.append(el('span', 'bp-amt', cur(x.amountCents)), btn(t('Add as {cat}', { cat: catName(x.bizCategory) }), 'ghost small', () => void call('/bizpack/expenses', 'POST', { fromMoney: x.id }, t('Expense added.'))));
    return item(el('span', 'bp-desc', `${dayText(x.date)} · ${x.merchant}`), acts);
  });
  const box = $('#bp-money');
  if (!m.length) return box.replaceChildren();
  box.replaceChildren(el('p', 'muted small', t('From your bank exports in Money (last 90 days): add the business ones.')), list(m));
}

function renderPortals() {
  $('#bp-p-make').disabled = !data.sharing;
  const rows = data.portals.map((p) => {
    const acts = el('span', 'bp-acts');
    acts.append(el('span', 'muted small', t('{n} views', { n: p.views })), btn(t('Revoke'), 'ghost small', () => void call(`/bizpack/portal/${p.id}`, 'DELETE', undefined, t('Revoked: the link no longer works.'))));
    return item(el('span', 'bp-desc', `${p.client} · ${t('until {date}', { date: dayText(p.expiresAt.slice(0, 10)) })}`), acts);
  });
  $('#bp-portals').replaceChildren(...(rows.length ? [list(rows)] : []), ...(data.sharing ? [] : [empty(t('Share links are off here (private mode, the policy or the demo).'))]));
}

function render() {
  if (!data) return;
  const today = localDay();
  if (!$('#bp-h-day').value) $('#bp-h-day').value = today;
  if (!$('#bp-e-date').value) $('#bp-e-date').value = today;
  if (!$('#bp-x-from').value) $('#bp-x-from').value = `${today.slice(0, 7)}-01`;
  if (!$('#bp-x-to').value) $('#bp-x-to').value = today;
  renderTimer();
  renderClients();
  renderInvoices();
  renderExpenses();
  renderPortals();
}
