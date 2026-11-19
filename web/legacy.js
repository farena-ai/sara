// V5.3 (docs/LEGACY.md): Settings → Privacy & system → Privacy → Legacy and emergency access.
// Name one trusted person, pick what they get, and how long Sara waits. Any sign-in or chat cancels.
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, confirmProof: () => Promise<object>, copyText?: (text: string, btn?: HTMLElement) => Promise<void> } | null} */
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
/** A labelled block that holds several controls (a <label> would forward clicks to the first one). */
const group = (label, inner, help) => {
  const g = el('div', 'wa-field');
  const head = el('span', 'wa-lab');
  head.append(el('span', '', label), ...(help ? [tip(help)] : []));
  g.append(head, inner);
  return g;
};
const input = (id, type, value, extra = {}) => {
  const i = el(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') i.type = type;
  i.id = id;
  i.value = value ?? '';
  Object.assign(i, extra);
  return i;
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
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

/** Lends the page helpers (web/app.js, once). */
export function initLegacy(c) {
  ctx = c;
}

function statusText(d) {
  const c = d.config;
  if (d.stage === 'off') return t('Off. Name someone you trust and pick what they get if you stop using Sara.');
  if (d.request && d.stage === 'waiting') return t('{name} asked for emergency access. Their page opens on {date} unless you press I\'m here.', { name: c.name, date: day(d.opensAt) });
  if (d.stage === 'reminding' || d.stage === 'waiting') return t('Counting down: you have not been here for {days} days. The page for {name} opens on {date}.', { days: d.idleDays, name: c.name, date: day(d.opensAt) });
  if (d.stage === 'open') return t('The page for {name} is open until {date} (seen {n} times). Press I\'m here to close it.', { name: c.name, date: day(d.expiresAt), n: d.views });
  if (d.stage === 'closed') return t('The page for {name} closed on {date}. Press I\'m here to start again.', { name: c.name, date: day(d.expiresAt) });
  return t('On. If you don\'t sign in or chat for {days} days, {name} gets a page after reminders and a {wait}-day wait. Last here: {date}.', { days: c.days, name: c.name, wait: c.waitDays, date: day(d.lastActive) });
}

/** Draws the section (from showSettingsTab when Privacy opens). */
export async function loadLegacy() {
  const host = $('#lg-box');
  if (!ctx || !host) return;
  let d;
  try {
    d = await ctx.api('/data-rights/legacy');
  } catch (e) {
    host.replaceChildren(el('p', 'muted small', e.message));
    return;
  }
  draw(host, d);
}

function draw(host, d, link) {
  const c = d.config;
  const status = $('#lg-status');
  if (status) status.textContent = statusText(d);
  const say = (msg) => {
    if (status) status.textContent = msg;
  };
  const top = el('div', 'add-row lg-now');
  if (d.stage !== 'off' && d.stage !== 'watching') top.append(btn(t('I\'m here'), '', () => send('/data-rights/legacy/here', { method: 'POST', body: {} })), tip(t('Cancels the countdown or closes the page at once. Signing in or chatting with her does the same.')));
  const on = check('lg-on', c.on, t('Turn on legacy access'), t('Off by default. Turning it on or giving them more asks for your passkey or owner token. Turning it off never does.'));
  const name = input('lg-name', 'text', c.name, { maxLength: 80, autocomplete: 'off' });
  const email = input('lg-email', 'email', c.email, { maxLength: 254, autocomplete: 'off' });
  const mailThem = check('lg-email-them', c.emailThem, t('Email them the link when it opens'), d.mail ? t('Sent once from your default mail account, only when the page opens.') : t('Connect a mail account first. Without it, give them the link yourself.'));
  if (!d.mail) mailThem.c.disabled = true;
  const days = input('lg-days', 'number', c.days, { min: 14, max: 365 });
  const wait = input('lg-wait', 'number', c.waitDays, { min: 3, max: 60 });
  const open = input('lg-open-days', 'number', c.linkDays, { min: 1, max: 90 });
  const ask = check('lg-ask', c.allowAsk, t('Let them ask for access early'), t('An emergency button on their page. You are told at once and the page still waits the waiting period. One request a week.'));
  const letter = input('lg-letter', 'textarea', c.gets.letter, { rows: 4, maxLength: 8000 });
  const notes = input('lg-notes', 'textarea', c.gets.notes.join('\n'), { rows: 3 });
  const details = check('lg-details', c.gets.details, t('My details'), t('Your emergency contact, addresses and the other cards under You → My details. Off by default.'));
  const pick = (id, list, chosen, label, help) => {
    const box = el('details', 'lg-pick');
    box.id = id;
    const sum = el('summary', '', t('{label} ({n} picked)', { label, n: chosen.length }));
    box.append(sum);
    if (!list.length) box.append(el('p', 'muted small', t('Nothing to pick yet.')));
    for (const x of list) {
      const r = check(`${id}-${x.id}`, chosen.includes(x.id), x.title || String(x.id));
      r.c.value = String(x.id);
      r.c.addEventListener('change', () => (sum.textContent = t('{label} ({n} picked)', { label, n: box.querySelectorAll('input:checked').length })));
      box.append(r.l);
    }
    return group(label, box, help);
  };
  const docs = pick('lg-docs', d.choices?.docs ?? [], c.gets.docs, t('Documents'), t('Kept Library documents they may download while the page is open.'));
  const chats = pick('lg-chats', d.choices?.chats ?? [], c.gets.chats, t('Chats'), t('None by default. A picked chat is shown with keys, passwords and addresses blanked out.'));
  // Sealed notes: kept encrypted in the vault, shown only on the open page.
  const sealedBox = el('div', 'lg-sealed');
  const rows = [];
  const addRow = (s) => {
    const r = el('div', 'lg-sealed-row');
    const lab = input('', 'text', s?.label ?? '', { maxLength: 60, placeholder: t('What it is') });
    lab.setAttribute('aria-label', t('What it is'));
    const val = input('', 'password', '', { maxLength: 4000, autocomplete: 'new-password', placeholder: s ? t('Kept sealed (type to replace)') : t('What it says') });
    val.setAttribute('aria-label', t('What it says'));
    const row = { lab, val, name: s?.name };
    r.append(lab, val, btn(t('Remove'), 'ghost', () => (rows.splice(rows.indexOf(row), 1), r.remove())));
    rows.push(row);
    sealedBox.append(r);
  };
  for (const s of d.sealed ?? []) addRow(s);
  const vaultOk = check('lg-vault-ok', false, t('I want them to see these sealed notes'), t('Sealed notes are kept encrypted in the vault and appear only on the open page. Sara never hands out her own keys.'));
  const sealed = group(t('Sealed notes'), el('div'), t('For a password manager hint, a safe code or bank contacts. Each new note needs the box below.'));
  sealed.lastChild.append(sealedBox, btn(t('Add a sealed note'), 'ghost', () => addRow()), vaultOk.l);

  const body = () => ({
    on: on.c.checked,
    name: name.value,
    email: email.value,
    emailThem: mailThem.c.checked,
    days: Number(days.value),
    waitDays: Number(wait.value),
    linkDays: Number(open.value),
    allowAsk: ask.c.checked,
    gets: {
      letter: letter.value,
      notes: notes.value.split('\n').map((x) => x.trim()).filter(Boolean),
      details: details.c.checked,
      docs: [...host.querySelectorAll('#lg-docs input:checked')].map((x) => Number(x.value)),
      chats: [...host.querySelectorAll('#lg-chats input:checked')].map((x) => x.value),
    },
    sealed: rows.filter((r) => r.lab.value.trim()).map((r) => ({ label: r.lab.value.trim(), ...(r.val.value ? { value: r.val.value } : {}) })),
    vaultConfirm: vaultOk.c.checked,
  });
  async function send(path, o, proofAsked = false) {
    try {
      const r = await ctx.api(path, o);
      const fresh = await ctx.api('/data-rights/legacy');
      draw(host, fresh, r.link);
      if (!r.link) say(statusText(fresh));
    } catch (e) {
      if ((e.status === 401 || e.status === 403) && !proofAsked && o.method !== 'DELETE') {
        let proof;
        try {
          proof = await ctx.confirmProof();
        } catch {
          return say(t('Cancelled.'));
        }
        return send(path, { ...o, body: { ...(o.body ?? {}), ...proof } }, true);
      }
      say(e.message);
    }
  }
  const linkBox = el('div', 'lg-link');
  linkBox.id = 'lg-link-box';
  if (link) {
    const out = input('lg-link', 'text', link, { readOnly: true });
    out.setAttribute('aria-label', t('Their link'));
    linkBox.append(
      el('p', 'small', t('Their link, shown only now. Give it to {name} on paper or in a message only they read. Before it opens, it shows nothing about you.', { name: c.name })),
      out,
      btn(t('Copy'), 'ghost', (e) => (ctx.copyText ? ctx.copyText(link, e.currentTarget) : navigator.clipboard?.writeText(link))),
    );
  }
  const actions = el('div', 'add-row');
  actions.append(btn(t('Save'), '', () => send('/data-rights/legacy', { method: 'PUT', body: body() })));
  if (d.hasLink) actions.append(btn(t('Make a new link'), 'ghost', () => send('/data-rights/legacy/link', { method: 'POST', body: {} })), tip(t('The old link stops working at once.')));
  if (c.on) actions.append(btn(t('Turn off'), 'ghost', () => send('/data-rights/legacy', { method: 'DELETE' })));
  const who = el('div', 'rc-fields lg-fields');
  who.append(
    field(t('Person you trust'), name, t('Their name, shown on their page.')),
    field(t('Their email (optional)'), email, t('Only used to send them the link when the page opens, if you tick the box below.')),
  );
  const when = el('div', 'rc-fields lg-fields');
  when.append(
    field(t('Days without you'), days, t('How long without a sign-in or a chat you typed before reminders start: 14 to 365 days. Then 3 days of reminders.')),
    field(t('Waiting period (days)'), wait, t('After the reminders Sara waits this long, reminding you every 2 days, before the page opens: 3 to 60.')),
    field(t('Page stays open (days)'), open, t('The page closes for good after this many days: 1 to 90.')),
  );
  const what = el('div', 'lg-what');
  what.append(field(t('A letter for them'), letter, t('Shown at the top of their page.')), field(t('Notes (one per line)'), notes, t('Short practical notes, for example where the spare key is or who to call.')), details.l, docs, chats, sealed);
  const hist = el('p', 'muted small lg-hist');
  const last = d.history?.at(-1);
  const WHAT = { on: t('turned on'), changed: t('changed'), 'new-link': t('new link'), off: t('turned off'), asked: t('they asked for access'), opened: t('page opened'), closed: t('page closed'), 'mail-failed': t('the email failed') };
  hist.textContent = last ? t('Last change: {what} on {date}.', { what: last.what.startsWith('cancelled') ? t('cancelled') : (WHAT[last.what] ?? last.what), date: day(last.at) }) : '';
  host.replaceChildren(top, on.l, linkBox, el('h4', '', t('Who')), who, mailThem.l, el('h4', '', t('When')), when, ask.l, el('h4', '', t('What they get')), what, actions, hist);
}
