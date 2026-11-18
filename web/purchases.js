// V2.2 (docs/PURCHASES.md): Money → Purchases. What you bought (from receipt emails, receipt photos
// in the Library and by hand) with the last day to return it, the warranty end, Keep it / Returned /
// Start a return (an errand that asks before anything is sent), and the return reminder settings.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let data = null;
let watching = 0;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#pu-status');
  if (s) s.textContent = msg;
};
const loc = () => document.documentElement.lang || undefined;
const cur = (cents) => new Intl.NumberFormat(loc(), { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(loc(), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

async function call(path, method, body, done) {
  try {
    const r = await ctx.api(path, { method, body });
    if (done) say(typeof done === 'function' ? done(r) : done);
    await loadPurchases();
    return r;
  } catch (err) {
    say(err.message);
    return undefined;
  }
}

export function initPurchases(c) {
  ctx = c;
  $('#pu-remind')?.addEventListener('change', (e) => void call('/money/purchases/prefs', 'PUT', { remind: e.target.checked }, t('Saved.')));
  $('#pu-days')?.addEventListener('change', (e) => void call('/money/purchases/prefs', 'PUT', { days: Number(e.target.value) }, t('Saved.')));
  $('#pu-add')?.addEventListener('click', () => void addByHand());
  $('#pu-photo')?.addEventListener('change', (e) => void addPhoto(e.target));
}

async function addByHand() {
  const body = { item: $('#pu-item').value.trim(), store: $('#pu-store').value.trim(), price: $('#pu-price').value.trim(), date: $('#pu-date').value, returnBy: $('#pu-return').value };
  const r = await call('/money/purchases', 'POST', body, (p) => t('Added {item}.', { item: p.item }));
  if (r) for (const id of ['#pu-item', '#pu-store', '#pu-price', '#pu-date', '#pu-return']) $(id).value = '';
}

/** A receipt photo or PDF goes to the Library (its usual reader); it joins the list once it is read. */
async function addPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  say(t('Sending the receipt to your Library…'));
  let doc;
  try {
    const name = file.name || 'receipt.jpg';
    const res = await fetch(`/api/library?name=${encodeURIComponent(name)}&keep=1&learn=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    doc = j.doc;
  } catch (err) {
    say(err.message);
    return;
  } finally {
    input.value = '';
  }
  say(t('Reading the receipt… It joins this list in a moment.'));
  const mine = ++watching;
  for (let i = 0; i < 20 && mine === watching; i++) {
    await new Promise((ok) => setTimeout(ok, 3000));
    await loadPurchases();
    const p = data?.purchases.find((x) => x.docId === doc?.id);
    if (p) {
      say(t('Added {item} from {store}.', { item: p.item, store: p.store || t('the store') }));
      $(`#mn-buys [data-buy="${p.id}"]`)?.classList.add('ask-spot');
      return;
    }
  }
  if (mine === watching) say(t('The receipt is in your Library. If no purchase shows up, the photo could not be read as a receipt: add it by hand below.'));
}

export async function loadPurchases() {
  if (!ctx || !$('#mn-buys')) return;
  try {
    data = await ctx.api('/money/purchases');
  } catch (err) {
    say(err.message);
    return;
  }
  render();
}

const FROM = () => ({ receipt: t('from the receipt'), store: t("the store's usual window"), document: t('from the document'), you: t('you set it') });

function returnLine(p) {
  if (p.status === 'kept') return t('Kept');
  if (p.status === 'returned') return t('Returned');
  if (!p.returnBy) return p.returnFrom === 'receipt' ? t('Final sale: no returns') : t('Return window unknown: check the store');
  if (p.daysLeft < 0) return t('Return window closed {day}', { day: dayText(p.returnBy) });
  const left = p.daysLeft === 0 ? t('last day today') : t('{n} days left', { n: p.daysLeft });
  return `${t('Return by {day}', { day: dayText(p.returnBy) })} (${left}, ${FROM()[p.returnFrom] ?? ''})`;
}

function editRow(li, p) {
  const box = el('div', 'mn-row pu-edit');
  const field = (label, value) => {
    const i = el('input');
    i.type = 'date';
    i.value = value ?? '';
    i.setAttribute('aria-label', label);
    return i;
  };
  const rb = field(t('Return by'), p.returnBy);
  const wu = field(t('Warranty until'), p.warrantyUntil);
  box.append(el('span', 'small', t('Return by')), rb, el('span', 'small', t('Warranty until')), wu, btn(t('Save'), 'small', () => void call(`/money/purchases/${p.id}`, 'PATCH', { returnBy: rb.value, warrantyUntil: wu.value }, t('Saved.'))));
  li.append(box);
  rb.focus();
}

function render() {
  if (!data) return;
  $('#pu-remind').checked = data.prefs.remind;
  $('#pu-days').value = String(data.prefs.days);
  const box = $('#mn-buys');
  const ul = el('ul', 'mn-list');
  for (const p of data.purchases) {
    const li = el('li', `mn-item pu-item${p.state === 'closing' ? ' mn-found' : ''}`);
    li.dataset.buy = String(p.id);
    const top = el('div', 'mn-top');
    top.append(el('strong', '', p.item));
    if (p.state === 'closing') top.append(el('span', 'er-chip mn-chip mn-warn', t('Return window closing')));
    const src = { mail: t('From your email'), photo: t('From a receipt photo'), hand: t('Added by you') }[p.source];
    li.append(top, el('span', 'muted small', [p.store, p.priceCents !== null ? cur(p.priceCents) : '', t('bought {day}', { day: dayText(p.date) }), src].filter(Boolean).join(' · ')));
    li.append(el('span', 'small pu-when', returnLine(p)));
    if (p.warrantyUntil) li.append(el('span', 'muted small', t('Warranty until {day}', { day: dayText(p.warrantyUntil) })));
    const acts = el('span', 'mn-acts');
    if (p.status === 'open' && p.returnBy && p.daysLeft >= 0) {
      acts.append(
        btn(p.errandId ? t('Open the return') : t('Start a return'), 'small', async () => {
          const r = await call(`/money/purchases/${p.id}/return`, 'POST', {}, t('The return errand is ready in Errands. Nothing is sent until you start it.'));
          if (r?.errand) location.hash = '#view=errands';
        }),
        btn(t('Keep it'), 'ghost small', () => void call(`/money/purchases/${p.id}/status`, 'POST', { status: 'kept' }, t('Saved.'))),
        btn(t('Returned'), 'ghost small', () => void call(`/money/purchases/${p.id}/status`, 'POST', { status: 'returned' }, t('Saved.'))),
      );
    } else if (p.status !== 'open') acts.append(btn(t('Undo'), 'ghost small', () => void call(`/money/purchases/${p.id}/status`, 'POST', { status: 'open' }, t('Saved.'))));
    acts.append(
      btn(t('Edit dates'), 'ghost small', () => editRow(li, p)),
      btn(t('Remove'), 'ghost small', () => void call(`/money/purchases/${p.id}`, 'DELETE', undefined, t('Removed.'))),
    );
    li.append(acts);
    ul.append(li);
  }
  box.replaceChildren(ul.childElementCount ? ul : el('p', 'muted small', t('No purchases yet. Receipts from your email and receipt photos you add here show up with their return dates.')));
}
