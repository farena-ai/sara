// N3 (docs/INBOX_HELPER.md): "From your inbox". The Today tile (suggestion cards with Accept,
// Dismiss, "Always do this", "File it"; done-on-its-own lines with Undo; packages; trips; filing rule
// ideas) and the Inbox helper section on Settings → Email and calendar (on/off, which mailboxes, the
// small model for unclear mail, "do it for me" per kind, filing rules). Nothing here calls a model.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, refreshToday?: () => void, openSettings?: (page: string) => void, toast?: (msg: string) => void } | null} */
let ctx = null;
export function initInboxHelper(c) {
  ctx = c;
}
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const tip = (text) => {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', t('What is this?'));
  return b;
};
const money = (a) => (a ? Number(a).toLocaleString(undefined, { style: 'currency', currency: 'USD' }) : '');
const day = (s) => (s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const when = (s) => {
  if (!s) return '';
  const wall = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!wall) return day(s);
  const d = new Date(`${wall[1]}T${wall[2]}:${wall[3]}:00`);
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** The kind's name, for "Always do this for …". */
export const KIND_WORDS = () => ({ bill: t('bills'), receipt: t('receipts'), shipping: t('packages'), trip: t('trips'), appointment: t('appointments'), invoice_paid: t('paid invoices'), file: t('attachments') });
const KIND_LABEL = () => ({ bill: t('Bill'), receipt: t('Receipt'), shipping: t('Package'), trip: t('Trip'), appointment: t('Appointment'), invoice_paid: t('Invoice paid'), file: t('Attachment') });
const STATUS = () => ({ ordered: t('ordered'), shipped: t('shipped'), in_transit: t('on the way'), out_for_delivery: t('out for delivery'), delivered: t('delivered'), problem: t('delivery problem') });

/** The card's main line and its small line, from the item's data. */
export function itemLines(it) {
  const f = it.finding ?? {};
  switch (it.kind) {
    case 'bill':
      return [`${f.payee ?? it.sender}: ${money(f.amount) || '?'}`, f.due ? t('Due {when}', { when: day(f.due) }) : t('No due date in the email')];
    case 'receipt':
      return [`${f.vendor ?? it.sender}: ${money(f.amount) || '?'}`, [f.date ? day(f.date) : '', f.items?.length ? f.items.slice(0, 3).join(', ') : f.order ? t('Order {n}', { n: f.order }) : ''].filter(Boolean).join(' · ')];
    case 'shipping':
      return [`${f.vendor ?? it.sender} · ${f.carrier ?? ''} ${f.tracking ?? ''}`.trim(), [STATUS()[f.status] ?? '', f.eta ? t('Expected {when}', { when: day(f.eta) }) : ''].filter(Boolean).join(' · ')];
    case 'trip': {
      const fl = f.flights ?? [];
      const head = fl.length ? fl.map((x) => `${x.flight}${x.from && x.to ? ` ${x.from} → ${x.to}` : ''}`).join(', ') : (f.hotel?.name ?? it.subject);
      const sub = fl[0]?.departs ? t('Departs {when}', { when: when(fl[0].departs) }) : f.hotel?.checkIn ? `${day(f.hotel.checkIn)} – ${day(f.hotel.checkOut)}` : '';
      return [head, [sub, f.confirmation ? t('Confirmation {code}', { code: f.confirmation }) : ''].filter(Boolean).join(' · ')];
    }
    case 'appointment':
      return [f.title ?? it.subject, [when(f.start), f.place ?? ''].filter(Boolean).join(' · ')];
    case 'invoice_paid':
      return [t('{n} was paid', { n: f.invoice ?? '' }), [it.sender, money(f.amount)].filter(Boolean).join(' · ')];
    default:
      return [it.attachments?.join(', ') || it.subject, ''];
  }
}

async function act(path, done) {
  try {
    const r = await ctx.api(path, { method: 'POST', body: {} });
    if (r?.item?.status === 'failed') ctx.toast?.(r.item.result ?? t('That didn’t work.'));
    done?.(r);
  } catch (e) {
    ctx.toast?.(e.message);
  }
  ctx.refreshToday?.();
  if ($('#ih-page')) void loadInboxHelper();
}

function card(it) {
  const row = el('li', 'ih-card');
  row.dataset.kind = it.kind;
  const [main, sub] = itemLines(it);
  const head = el('div', 'ih-head');
  head.append(el('span', 'ih-kind', KIND_LABEL()[it.kind] ?? it.kind), el('span', 'ih-main', main));
  row.append(head);
  if (sub) row.append(el('div', 'ih-sub muted small', sub));
  const from = el('div', 'ih-from muted small', `${it.sender} · “${it.subject}”`);
  row.append(from);
  const acts = el('div', 'ih-acts');
  const accept = btn(it.kind === 'file' ? t('File it') : t('Accept'), 'small', () => void act(`/inbox/items/${it.id}/accept`));
  accept.classList.add('ih-accept');
  acts.append(accept, btn(t('Dismiss'), 'ghost small', () => void act(`/inbox/items/${it.id}/dismiss`)));
  if (it.kind !== 'file') {
    const always = btn(t('Always for {kind}', { kind: KIND_WORDS()[it.kind] }), 'ghost small ih-always', () => void act(`/inbox/items/${it.id}/always`));
    always.title = t('From now on she does this on her own for every new one, and tells you with an Undo. You can turn it off in Settings → Email and calendar.');
    acts.append(always);
  }
  if (it.kind !== 'file' && it.attachments?.length) acts.append(btn(t('File the attachment'), 'ghost small', () => void fileIt(it)));
  row.append(acts);
  return row;
}

async function fileIt(it) {
  // "File the attachment" from any card: it goes to the Library now (the card itself stays).
  try {
    const r = await ctx.api(`/inbox/items/${it.id}/file`, { method: 'POST', body: {} });
    ctx.toast?.(r.saved.length ? t('Saved to Library/{folder}.', { folder: r.saved[0].folder }) : t('That didn’t work.'));
  } catch (e) {
    ctx.toast?.(e.message);
  }
  ctx.refreshToday?.();
}

/** Today: the "From your inbox" tile. */
export function renderInboxTile(p, tileHead, dateCard) {
  const tile = $('#td-inbox');
  if (!tile) return;
  tile.hidden = !p;
  if (!p || !ctx) return;
  const fromMail = p.pending.length || p.done.length || p.packages.length || p.trips.length || p.rules.length;
  tileHead?.(tile, fromMail ? t('From your inbox') : t('From your documents'));
  const parts = [];
  if (p.pending.length) {
    const list = el('ul', 'ih-cards');
    list.append(...p.pending.map(card));
    parts.push(list);
  }
  if (p.done.length) {
    const list = el('ul', 'ih-done');
    for (const it of p.done) {
      const li = el('li', 'small');
      li.append(el('span', 'ih-done-text', `${t('Done from your inbox:')} ${KIND_LABEL()[it.kind]} · ${itemLines(it)[0]}`));
      if (it.canUndo) li.append(btn(t('Undo'), 'ghost small', () => void act(`/inbox/items/${it.id}/undo`)));
      list.append(li);
    }
    parts.push(list);
  }
  if (p.packages.length) {
    const list = el('ul', 'ih-list');
    for (const k of p.packages) list.append(el('li', 'small', `${t('Package')} · ${k.vendor ? `${k.vendor} · ` : ''}${k.carrier} ${k.tracking} · ${STATUS()[k.status] ?? k.status}${k.eta && k.status !== 'delivered' ? ` · ${day(k.eta)}` : ''}`));
    parts.push(list);
  }
  if (p.trips.length) {
    const list = el('ul', 'ih-list');
    for (const tr of p.trips) list.append(el('li', 'small', `${t('Trip')} · ${tr.title}${tr.confirmation ? ` · ${tr.confirmation}` : ''}${tr.flights[0]?.departs ? ` · ${when(tr.flights[0].departs)}` : ''}`));
    parts.push(list);
  }
  for (const r of p.rules) {
    const box = el('div', 'ih-rule small');
    box.append(el('span', '', t('File {ext} attachments from {from} into Library/{folder}?', { ext: r.ext.toUpperCase(), from: r.from, folder: r.folder })), btn(t('Turn on'), 'ghost small', () => void act(`/inbox/rules/${r.id}/on`)), btn(t('No thanks'), 'ghost small', () => void act(`/inbox/rules/${r.id}/off`)));
    parts.push(box);
  }
  // N6: dates found in their documents (web/facts.js dateCard; Accept adds a reminder).
  if (p.docs?.length && dateCard) {
    const list = el('ul', 'ih-cards');
    list.append(...p.docs.map((s) => dateCard(s, () => ctx.refreshToday?.())));
    parts.push(list);
  }
  tile.querySelector('.td-body').replaceChildren(...parts);
}

// ------------------------------------------------------------------ Settings → Email and calendar

const AUTO = ['bill', 'receipt', 'shipping', 'trip', 'appointment', 'invoice_paid'];
export async function loadInboxHelper() {
  const host = $('#ih-page');
  if (!host || !ctx) return;
  let d;
  try {
    d = await ctx.api('/inbox');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  const save = async (body) => {
    try {
      await ctx.api('/inbox/settings', { method: 'PUT', body });
      $('#ih-status').textContent = t('Saved.');
    } catch (e) {
      $('#ih-status').textContent = e.message;
    }
    void loadInboxHelper();
  };
  const check = (id, label, on, help, onChange) => {
    const l = el('label', 'ih-check');
    const c = el('input');
    c.type = 'checkbox';
    c.id = id;
    c.checked = on;
    c.addEventListener('change', () => onChange(c.checked));
    l.append(c, document.createTextNode(` ${label} `));
    if (help) l.append(tip(help));
    return l;
  };
  const label = (text, help) => {
    const p = el('p', 'small ih-label', `${text} `);
    if (help) p.append(tip(help));
    return p;
  };
  const rows = [];
  const first = el('div', 'ih-group');
  rows.push(first);
  first.append(check('ih-on', t('Read new email and suggest what to do with it'), d.settings.on, t('About every 10 minutes she reads mail that arrived since the last look (only new mail) and turns bills, receipts, shipping, trips, appointments and paid invoices into cards on Today. Nothing happens until you tap Accept, unless you turn on “do it for me” below.'), (v) => void save({ on: v })));
  if (!d.mailboxes.length) rows.push(el('p', 'muted small', t('Connect a mailbox above first.')));
  else {
    const box = el('div', 'ih-group');
    box.append(label(t('Which mailboxes')));
    for (const m of d.mailboxes) box.append(check(`ih-mb-${m.address.replace(/[^a-z0-9]/gi, '-')}`, m.address, m.on, '', (v) => {
      const on = d.mailboxes.filter((x) => (x.address === m.address ? v : x.on)).map((x) => x.address);
      void save({ accounts: on.length === d.mailboxes.length ? null : on });
    }));
    rows.push(box);
  }
  const model = el('label', 'ih-field');
  const sel = el('select');
  sel.id = 'ih-model';
  for (const [v, label] of [['local', t('A model on this computer')], ['quick', t('My quick model (may cost a little)')], ['off', t('Rules only (no model)')]]) {
    const o = el('option', '', label);
    o.value = v;
    o.selected = d.settings.model === v;
    sel.append(o);
  }
  sel.addEventListener('change', () => void save({ model: sel.value }));
  model.append(document.createTextNode(`${t('Unclear emails')} `), tip(t('Most emails are read by rules (and by the booking data airlines, hotels and shops put in their emails). When one looks like a bill or order but the rules can’t read it, a small model may read it. In private local mode only rules are used.')), sel);
  rows.push(model);
  const auto = el('div', 'ih-group');
  auto.append(label(t('Do it for me (without asking)'), t('Off for every kind until you turn it on. When on, she does it as soon as the email arrives and puts “Done from your inbox” with Undo on Today. She never sends email or pays anything from here.')));
  const words = KIND_WORDS();
  for (const k of AUTO) auto.append(check(`ih-auto-${k}`, words[k], d.settings.auto[k] === true, '', (v) => void save({ auto: { [k]: v } })));
  rows.push(auto);
  const rules = el('div', 'ih-group');
  rules.append(label(t('Filing rules'), t('Attachments from a sender go straight to a Library folder. She suggests a rule after you file one by hand; you can also ask her (“file PDFs from my insurer into Library/Insurance”).')));
  if (!d.rules.length) rules.append(el('p', 'muted small', t('No filing rules yet.')));
  for (const r of d.rules) {
    const li = el('div', 'ih-rule-row small');
    li.append(el('span', '', `${r.ext === '*' ? t('Any file') : r.ext.toUpperCase()} · ${r.from} → Library/${r.folder}${r.filed ? ` · ${t('{n} filed', { n: r.filed })}` : ''}`));
    li.append(btn(r.status === 'on' ? t('Turn off') : t('Turn on'), 'ghost small', () => void act(`/inbox/rules/${r.id}/${r.status === 'on' ? 'off' : 'on'}`)));
    li.append(btn(t('Delete'), 'ghost small', async () => {
      await ctx.api(`/inbox/rules/${r.id}`, { method: 'DELETE' }).catch(() => undefined);
      void loadInboxHelper();
    }));
    rules.append(li);
  }
  rows.push(rules);
  const scan = btn(t('Look now'), 'ghost small', async () => {
    $('#ih-status').textContent = t('Reading new email…');
    try {
      const r = await ctx.api('/inbox/scan', { method: 'POST', body: {} });
      $('#ih-status').textContent = t('Read {n} new emails; {c} new suggestions.', { n: r.read, c: r.created });
    } catch (e) {
      $('#ih-status').textContent = e.message;
    }
    ctx.refreshToday?.();
  });
  scan.id = 'ih-scan';
  rows.push(scan);
  if (d.status.lastScan?.problems?.length) rows.push(el('p', 'muted small', d.status.lastScan.problems.join('; ')));
  host.replaceChildren(...rows);
}
