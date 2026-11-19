// V5.4 (docs/design/V5CARE.md): the caregiver sections of Health: the daily check-in, who may see
// what (the person's own consent, per caregiver), the people you care for (only what each shared,
// read fresh every time) and the family to call from Simple home. Drawn by web/health.js.
import { renderShared } from './health-coach.js';
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let page = null;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#hl-status');
  if (s) s.textContent = msg;
};
async function call(path, o, ok) {
  try {
    const r = await ctx.api(path, o);
    if (ok) say(ok);
    return r;
  } catch (err) {
    say(err?.message ?? String(err));
    return undefined;
  }
}

/** The words for a check-in answer. */
export const checkinWord = (s) => ({ ok: t("I'm OK"), notgreat: t('Not great'), help: t('I need help') })[s] ?? s;
const dayWord = (day) => {
  try {
    return new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return day;
  }
};
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function initCare(c) {
  ctx = c;
  for (const b of document.querySelectorAll('#hl-checkin [data-ci]')) b.addEventListener('click', () => void checkIn(b.dataset.ci));
  $('#hl-care-share')?.addEventListener('click', () => void share());
  $('#hl-contact-add')?.addEventListener('click', () => void addContact());
}

/** Sends today's check-in (Health and Simple home share it). */
export async function checkIn(status) {
  if (!ctx) return undefined;
  const r = await call('/health-log/care/checkin', { method: 'POST', body: { status } }, status === 'help' ? t('Your caregivers were told.') : t('Checked in. Thank you.'));
  if (r && page) {
    page.checkins = r.checkins;
    renderCheckin();
  }
  return r;
}

export async function loadCare() {
  if (!ctx) return;
  const r = await ctx.api('/health-log/care').catch(() => undefined);
  const box = $('#hl-care');
  if (!r || r.child) {
    if (box) box.hidden = true;
    return;
  }
  page = r;
  if (box) box.hidden = false;
  render();
}

function render() {
  renderCheckin();
  renderGrants();
  renderContacts();
  void renderCaring();
  const start = $('#sh-start');
  if (start) start.checked = localStorage.getItem('sara.simpleHome') === '1';
}

function renderCheckin() {
  const last = page.checkins?.[0];
  const today = last && last.day === localDay() ? last : undefined;
  $('#hl-checkin-last').textContent = today ? t('Today: {answer}', { answer: checkinWord(today.status) }) : t('No check-in yet today.');
}

function renderGrants() {
  const list = $('#hl-care-grants');
  list.replaceChildren();
  const nameOf = (id) => page.people.find((p) => p.id === id)?.name ?? id;
  for (const g of page.grants) {
    const row = el('div', 'hl-card');
    const top = el('div', 'hl-row');
    const what = [g.doses ? t('Missed doses') : '', g.checkins ? t('Check-ins') : '', g.summary ? t('Weekly summary') : ''].filter(Boolean).join(' · ');
    const main = el('div', 'hl-row-main');
    main.append(el('strong', '', nameOf(g.person)), el('span', 'muted small', ` ${t('sees: {what}', { what })}`));
    top.append(main, btn(t('Stop sharing'), 'small ghost', () => void stop(g.person)));
    row.append(top);
    list.append(row);
  }
  if (!page.grants.length) list.append(el('p', 'muted small', t('Nobody sees anything of your health log.')));
  const sel = $('#hl-care-person');
  sel.replaceChildren(...page.people.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name })));
  $('#hl-care-add').hidden = !page.people.length;
  $('#hl-care-none').hidden = !!page.people.length;
}

async function share() {
  const person = $('#hl-care-person').value;
  if (!person) return;
  const doses = $('#hl-care-doses').checked;
  const checkins = $('#hl-care-checkins').checked;
  const summary = !!$('#hl-care-summary')?.checked;
  if (!doses && !checkins && !summary) return say(t('Pick at least one thing to share.'));
  const r = await call('/health-log/care/grants', { method: 'PUT', body: { person, doses, checkins, summary } }, t('Shared.'));
  if (r) {
    page = r;
    render();
  }
}
async function stop(person) {
  const r = await call(`/health-log/care/grants/${encodeURIComponent(person)}`, { method: 'DELETE' }, t('Stopped sharing. They no longer see it.'));
  if (r) {
    page = r;
    render();
  }
}

async function renderCaring() {
  const box = $('#hl-caring');
  const list = $('#hl-caring-list');
  box.hidden = !page.caringFor.length;
  list.replaceChildren();
  for (const p of page.caringFor) {
    const v = await ctx.api(`/health-log/care/of/${encodeURIComponent(p.id)}`).catch(() => undefined);
    if (!v) continue;
    const card = el('div', 'hl-card');
    card.append(el('strong', '', v.name));
    if (v.doses) {
      const d = v.doses.today;
      card.append(el('p', 'small', t('Today: {taken} taken, {skipped} skipped, {open} open', d)));
      if (v.doses.missed.length) {
        card.append(el('p', 'small hl-soon', t('Missed doses in the last 7 days: {n}', { n: v.doses.missed.length })));
        const ul = el('ul', 'hl-qs small');
        for (const m of v.doses.missed.slice(0, 6)) ul.append(el('li', '', `${m.med} · ${new Date(m.due).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`));
        card.append(ul);
      } else card.append(el('p', 'muted small', t('No missed doses in the last 7 days.')));
    }
    if (v.checkins) {
      const today = v.checkins.find((c) => c.day === localDay());
      card.append(el('p', `small${today?.status === 'help' ? ' hl-soon' : ''}`, today ? t('Check-in today: {answer}', { answer: checkinWord(today.status) }) : t('No check-in yet today.')));
      const past = v.checkins.filter((c) => c !== today).slice(0, 6);
      if (past.length) card.append(el('p', 'muted small', past.map((c) => `${dayWord(c.day)}: ${checkinWord(c.status)}`).join(' · ')));
    }
    if (v.summary) renderShared(card, v.summary, el); // W4.4
    list.append(card);
  }
}

function renderContacts() {
  const list = $('#hl-contacts');
  list.replaceChildren();
  page.contacts.forEach((c, i) => {
    const row = el('div', 'hl-row');
    row.append(el('span', 'hl-row-main', `${c.name} · ${c.phone}`), btn(t('Remove'), 'small ghost', () => void saveContacts(page.contacts.filter((_, j) => j !== i))));
    list.append(row);
  });
}
async function addContact() {
  const name = $('#hl-contact-name').value.trim();
  const phone = $('#hl-contact-phone').value.trim();
  if (!name || !phone) return say(t('Add a name and a phone number.'));
  const before = page.contacts.length;
  const ok = await saveContacts([...page.contacts, { name, phone }]);
  if (ok && page.contacts.length === before) return say(t('That phone number does not look right.'));
  if (ok) {
    $('#hl-contact-name').value = '';
    $('#hl-contact-phone').value = '';
  }
}
async function saveContacts(contacts) {
  const r = await call('/health-log/care/contacts', { method: 'PUT', body: { contacts } }, t('Saved.'));
  if (!r) return false;
  page.contacts = r.contacts;
  renderContacts();
  return true;
}
