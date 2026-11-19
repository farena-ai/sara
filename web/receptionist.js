// V3.5 (docs/RECEPTION.md): Settings → You → Business details → Website receptionist. The owner turns
// it on, picks the Library documents it may answer from, writes the business rules, and copies one
// <script> line into their own website. Booking requests land in the Booking page's list above.
// W3.5: payment links, and the Receptionist conversations section (follow-ups, corrections).
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
const KIND = () => ({ answer: t('answered'), off: t('refused: not about the business'), booking: t('asked for a time'), greeting: t('said hello'), limit: t('daily limit reached'), error: t('model error'), pay: t('got your payment links'), contact: t('left an email'), approved: t('your approved answer') });
const langName = (code) => {
  try {
    return new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};
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
  // W3.5: payment links the owner pasted (it shares them; it never takes a payment).
  const pay = el('textarea');
  pay.id = 'rc-pay';
  pay.rows = 3;
  pay.maxLength = 3000;
  pay.placeholder = t('Deposit https://… (one link per line)');
  pay.value = (s.payLinks ?? []).map((l) => `${l.label} ${l.url}`).join('\n');
  const collect = () => ({ on: on.c.checked, sites: sites.value, docs: boxes.filter((b) => b.c.checked).map((b) => b.id), rules: rules.value, greeting: greeting.value, booking: booking.c.checked, perDay: Number(perDay.value), payLinks: pay.value });
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
  parts[parts.length - 2].append(field(t('Payment links'), pay, t('Links from your own payment page (Stripe, Square, PayPal…), one per line with a name first. Visitors who ask how to pay get them; it never takes card details.')));
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
  host.replaceChildren(...parts);
  drawInbox(d);
}

// W3.5 (docs/RECEPTION.md "Version 2"): follow-ups waiting for the owner's OK, the conversations (fix a
// wrong answer → an approved answer used next time) and the approved answers.
function drawInbox(d) {
  const host = $('#rcv-box');
  if (!host) return;
  const status = $('#rcv-status');
  const say = (msg) => {
    if (status) status.textContent = msg;
  };
  const act = async (path, body, done, method = 'POST') => {
    try {
      await ctx.api(path, { method, body: body ?? {} });
      say(done);
    } catch (e) {
      say(e.message);
    }
    void loadReception();
  };
  const parts = [];
  // Follow-ups waiting (actionable, so first).
  const waiting = (d.followups ?? []).filter((f) => f.status === 'pending');
  parts.push(el('p', 'small wa-sub', t('Follow-up emails waiting for your OK ({n})', { n: waiting.length })));
  if (!waiting.length) parts.push(el('p', 'muted small', t('None. When a visitor leaves an email address, a draft reply in their language waits here; nothing is sent before you press Send.')));
  for (const f of waiting) {
    const card = el('div', 'rcv-card');
    const to = el('p', 'small', t('To {email} · {lang} · {when}', { email: f.email, lang: langName(f.lang), when: when(f.at) }));
    const subj = el('input');
    subj.id = `rcv-subj-${f.id}`;
    subj.maxLength = 200;
    subj.value = f.subject;
    subj.setAttribute('aria-label', t('Subject'));
    const body = el('textarea');
    body.id = `rcv-body-${f.id}`;
    body.rows = 7;
    body.maxLength = 5000;
    body.value = f.body;
    body.setAttribute('aria-label', t('Email text'));
    const row = el('div', 'add-row');
    row.append(
      btn(t('Send'), '', () => void act(`/booking/reception/followups/${f.id}/send`, { subject: subj.value, body: body.value }, t('Sent to {email}.', { email: f.email }))),
      btn(t('Dismiss'), 'ghost small', () => void act(`/booking/reception/followups/${f.id}/dismiss`, {}, t('Dismissed. Nothing was sent.'))),
    );
    card.append(to, subj, body, row);
    if (f.outcome) card.append(el('p', 'muted small', f.outcome));
    parts.push(card);
  }
  const doneOnes = (d.followups ?? []).filter((f) => f.status !== 'pending').slice(0, 5);
  if (doneOnes.length) {
    const later = el('details', 'rcv-later');
    later.append(el('summary', 'small', t('Sent and dismissed ({n})', { n: doneOnes.length })));
    const ul = el('ul', 'wa-reqs');
    for (const f of doneOnes) ul.append(el('li', 'wa-req small', `${f.status === 'sent' ? t('Sent') : t('Dismissed')} · ${f.email} · ${f.subject}`));
    later.append(ul);
    parts.push(later);
  }
  // Conversations.
  parts.push(el('p', 'small wa-sub', t('What visitors asked lately')));
  const chats = d.chats ?? [];
  if (!chats.length) parts.push(el('p', 'muted small', t('No visitor questions yet.')));
  const kinds = KIND();
  chats.forEach((c, i) => {
    const box = el('details', 'rcv-chat');
    if (i === 0) box.open = true;
    const first = c.turns[0];
    box.append(el('summary', 'small', `${when(first?.at ?? c.at)} · ${t('{n} questions', { n: c.turns.length })}${c.lang ? ` · ${langName(c.lang)}` : ''}`));
    for (const r of c.turns) {
      const turn = el('div', 'rcv-turn');
      turn.append(el('strong', '', r.question));
      if (r.reply) turn.append(el('p', 'rcv-reply', r.reply));
      const meta = el('p', 'muted small', `${kinds[r.kind] ?? r.kind}${r.fixed ? ` · ${t('corrected')}` : ''}`);
      turn.append(meta);
      if (r.reply && (r.kind === 'answer' || r.kind === 'off' || r.kind === 'approved')) {
        const fix = btn(r.fixed ? t('Change the right answer') : t('Wrong? Write the right answer'), 'ghost small', () => {
          fix.hidden = true;
          const form = el('div', 'rcv-fix');
          const ans = el('textarea');
          ans.id = `rcv-fix-${r.id}`;
          ans.rows = 3;
          ans.maxLength = 1500;
          ans.setAttribute('aria-label', t('The right answer'));
          ans.placeholder = t('The right answer, as you want visitors to hear it');
          const save = el('div', 'add-row');
          save.append(
            btn(t('Save the right answer'), '', () => void act('/booking/reception/correct', { log: r.id, answer: ans.value }, t('Saved. It uses your answer next time someone asks this.'))),
            btn(t('Cancel'), 'ghost small', () => {
              form.remove();
              fix.hidden = false;
            }),
          );
          form.append(ans, save);
          turn.append(form);
          ans.focus();
        });
        turn.append(fix);
      }
      box.append(turn);
    }
    parts.push(box);
  });
  if (chats.length) {
    const clear = el('div', 'add-row');
    clear.append(btn(t('Clear the list'), 'ghost small', () => void act('/booking/reception/clear-log', {}, t('Saved.'))));
    parts.push(clear);
  }
  // Approved answers.
  const approved = d.approved ?? [];
  parts.push(el('p', 'small wa-sub', t('Your approved answers ({n})', { n: approved.length })));
  if (!approved.length) parts.push(el('p', 'muted small', t('None yet. Fix a wrong answer above and it is kept here; the receptionist uses it next time, in any language.')));
  const list = el('ul', 'wa-reqs rcv-approved');
  for (const a of approved) {
    const li = el('li', 'wa-req');
    li.append(el('strong', '', a.question), el('p', 'rcv-reply', a.answer), el('span', 'muted small', t('Used {n} times', { n: a.uses })));
    li.append(btn(t('Delete'), 'ghost small', () => void act(`/booking/reception/approved/${a.id}`, undefined, t('Deleted.'), 'DELETE')));
    list.append(li);
  }
  if (approved.length) parts.push(list);
  host.replaceChildren(...parts);
}
