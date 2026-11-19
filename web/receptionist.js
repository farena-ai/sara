// V3.5 (docs/RECEPTION.md): Settings → You → Business details → Website receptionist. The owner turns
// it on, picks the Library documents it may answer from, writes the business rules, and copies one
// <script> line into their own website. Booking requests land in the Booking page's list above.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
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
const field = (label, control, help) => {
  const l = el('label', 'wa-field');
  const head = el('span', 'wa-lab');
  head.append(el('span', '', label), ...(help ? [tip(help)] : []));
  l.append(head, control);
  return l;
};
const check = (id, checked, label, help) => {
  const l = el('label', 'wa-check');
  const c = el('input');
  c.type = 'checkbox';
  c.id = id;
  c.checked = Boolean(checked);
  l.append(c, el('span', '', label), ...(help ? [tip(help)] : []));
  return { l, c };
};
const KIND = () => ({ answer: t('answered'), off: t('refused: not about the business'), booking: t('asked for a time'), greeting: t('said hello'), limit: t('daily limit reached'), error: t('model error') });
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Draws the section (called from web/workapps.js with its ctx when Business details opens). */
export async function loadReception(c) {
  if (c) ctx = c;
  const host = $('#rc-box');
  if (!ctx || !host) return;
  const status = $('#rc-status');
  let d;
  try {
    d = await ctx.api('/booking/reception');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  const s = d.settings;
  const say = (msg) => {
    if (status) status.textContent = msg;
  };
  const save = async (body) => {
    try {
      await ctx.api('/booking/reception', { method: 'PUT', body });
      say(t('Saved.'));
    } catch (e) {
      say(e.message);
    }
    void loadReception();
  };
  const on = check('rc-on', s.on, t('Turn on the website receptionist'), t('A chat on your own website that answers from the documents you pick and offers free times. Off by default; it never uses tools and always says it is an AI.'));
  const warn = [];
  if (!d.business) warn.push(t('Add your business name at the top of this page first: visitors see it.'));
  const sites = el('textarea');
  sites.id = 'rc-sites';
  sites.rows = 2;
  sites.maxLength = 600;
  sites.placeholder = 'https://www.example.com';
  sites.value = s.sites.join('\n');
  const docs = el('div', 'rc-docs');
  if (!d.docs.length) docs.append(el('p', 'muted small', t('Keep a few documents in your Library first (prices, opening hours, questions people ask).')));
  const boxes = d.docs.map((doc) => {
    const x = check(`rc-doc-${doc.id}`, s.docs.includes(doc.id), doc.name);
    docs.append(x.l);
    return { id: doc.id, c: x.c };
  });
  const rules = el('textarea');
  rules.id = 'rc-rules';
  rules.rows = 4;
  rules.maxLength = 2000;
  rules.placeholder = t('e.g. Never quote a price for roofs; say we visit first. Be brief and friendly.');
  rules.value = s.rules;
  const greeting = el('input');
  greeting.id = 'rc-greeting';
  greeting.maxLength = 200;
  greeting.placeholder = t('Hi! I can answer questions about {name}.', { name: d.business || t('this business') });
  greeting.value = s.greeting;
  const booking = check('rc-booking', s.booking, t('Offer free times from my booking page'), t('Visitors pick a free time and leave a request. Every request waits for your OK in the list above, even when the booking page confirms on its own.'));
  if (s.booking && !d.calendars.length) warn.push(t('Connect a calendar first (Gmail and Calendar, or Email and calendar): confirmed bookings become events there.'));
  const perDay = el('input');
  perDay.id = 'rc-perday';
  perDay.type = 'number';
  perDay.min = '10';
  perDay.max = '2000';
  perDay.value = String(s.perDay);
  const collect = () => ({ on: on.c.checked, sites: sites.value, docs: boxes.filter((b) => b.c.checked).map((b) => b.id), rules: rules.value, greeting: greeting.value, booking: booking.c.checked, perDay: Number(perDay.value) });
  on.c.addEventListener('change', () => void save(collect()));
  const grid = el('div', 'wa-grid rc-grid');
  grid.append(
    field(t('Your websites'), sites, t('The addresses of the sites that may show the chat, one per line (like https://www.example.com). Other sites cannot show it.')),
    field(t('Questions a day'), perDay, t('At most this many visitor questions a day go to the model; after that visitors are asked to contact you.')),
  );
  const parts = [
    on.l,
    ...warn.map((w) => el('p', 'muted small', w)),
    el('p', 'small wa-sub', t('Documents it may answer from')),
    docs,
    grid,
    el('div', 'rc-fields'),
    booking.l,
  ];
  parts[parts.length - 2].append(field(t('Your business rules'), rules, t('What it must and must not say, in your own words. It answers only from your documents and business details, and refuses other topics.')), field(t('First line visitors see'), greeting));
  const row = el('div', 'add-row');
  row.append(btn(t('Save receptionist'), '', () => void save(collect())));
  parts.push(row);
  // The line to paste into the website.
  const code = el('textarea', 'rc-embed');
  code.id = 'rc-embed';
  code.rows = 2;
  code.readOnly = true;
  code.value = d.embed;
  const links = el('div', 'add-row');
  links.append(
    btn(t('Copy'), 'ghost small', () => void navigator.clipboard?.writeText(d.embed).then(() => say(t('Copied.')))),
    ...(s.on ? [btn(t('Try it'), 'ghost small', () => window.open(d.url, '_blank', 'noopener'))] : []),
    btn(t('New code'), 'ghost small', async () => {
      if (!confirm(t('Make a new code? The chat stops working on sites that still use the old line until you paste the new one.'))) return;
      try {
        await ctx.api('/booking/reception/new-id', { method: 'POST', body: {} });
      } catch (e) {
        say(e.message);
      }
      void loadReception();
    }),
  );
  const embedBox = el('div', 'rc-fields');
  embedBox.append(field(t('Paste this line into your website'), code, t('Put it near the end of every page that should show the chat button. It loads the chat from this server; nothing else on your site is read.')));
  parts.push(embedBox, links);
  if (!s.on) parts.push(el('p', 'muted small', t('Off. The line shows nothing until you turn the receptionist on.')));
  // What visitors asked.
  if (d.log.length) {
    const kinds = KIND();
    const list = el('ul', 'wa-reqs rc-log');
    for (const r of d.log) {
      const li = el('li', 'wa-req');
      li.append(el('strong', '', r.question), el('span', 'muted small', ` · ${when(r.at)} · ${kinds[r.kind] ?? r.kind}`));
      list.append(li);
    }
    const clear = el('div', 'add-row');
    clear.append(
      btn(t('Clear the list'), 'ghost small', async () => {
        await ctx.api('/booking/reception/clear-log', { method: 'POST', body: {} }).catch((e) => say(e.message));
        void loadReception();
      }),
    );
    parts.push(el('p', 'small wa-sub', t('What visitors asked lately')), list, clear);
  }
  host.replaceChildren(...parts);
}
