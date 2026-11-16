// HANDSFREE 3a (docs/CALENDAR_LINKS.md): Settings → Email and calendar → "Add a calendar by link". The easiest
// way to give her a calendar: paste its private iCal address. Read only, read again every 15 minutes, shown on
// Today, in the briefing and to her calendar tools under the name you give it. The address is kept in the
// vault and never shown again (only its host). Text only (textContent), never HTML.
import { t } from './naming.js';
import { api, btn, el, field, okLine } from './setup-card.js';

const HOW = () => [
  [t('Google Calendar'), t('On a computer: calendar.google.com → Settings (gear) → under “Settings for my calendars” pick the calendar → Integrate calendar → copy “Secret address in iCal format”.')],
  [t('Outlook'), t('outlook.com or Outlook on the web → Settings → Calendar → Shared calendars → Publish a calendar → pick it, “Can view all details” → Publish → copy the ICS link.')],
  [t('iCloud'), t('iCloud.com → Calendar → the share icon next to the calendar → Public Calendar on → copy the link (it starts with webcal://).')],
];

let box = null;
let busy = false;
function render(links, msg = '', ok = false) {
  if (!box) return;
  const kids = [];
  kids.push(el('p', 'muted small', t('Read only: she sees the events, never changes them. Anyone with the link can read that calendar, so it is kept locked in your vault and never shown again.')));
  const list = el('ul', 'cl-list');
  for (const l of links) {
    const li = el('li', 'cl-item');
    const head = el('span', 'cl-name', l.name);
    const meta = el('span', 'muted small', l.problem ? t('Couldn’t read it last time: {why}', { why: l.problem }) : l.lastRead ? t('{host} · {n} events · read {time}', { host: l.host, n: l.events ?? 0, time: new Date(l.lastRead).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }) : l.host);
    li.append(head, meta, btn(t('Remove'), 'ghost small', async () => {
      try {
        const r = await api(`/mail/calendar-links/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
        render(r.links, t('Removed.'), true);
      } catch (err) {
        render(links, err.message);
      }
    }));
    list.append(li);
  }
  if (links.length) kids.push(list);
  else kids.push(el('p', 'muted small', t('No calendars added by link yet.')));
  const name = field('cl-name', t('Name'), t('How she calls it on Today and in answers, like “Family” or “Work”.'), { placeholder: t('Family') });
  const url = field('cl-url', t('Calendar link'), t('The private iCal (.ics) address from your calendar app. It starts with https:// or webcal://.'), { type: 'password', placeholder: 'https://…/basic.ics' });
  const add = btn(t('Add calendar'), '', async () => {
    if (busy) return;
    busy = true;
    add.disabled = true;
    try {
      const r = await api('/mail/calendar-links', { method: 'POST', body: { name: box.querySelector('#cl-name').value, url: box.querySelector('#cl-url').value } });
      render(r.links, t('Added “{name}”: {n} events found. It shows on Today in a moment.', { name: r.link.name, n: r.link.events ?? 0 }), true);
    } catch (err) {
      render(links, err.message);
    } finally {
      busy = false;
    }
  });
  const row = el('div', 'add-row cl-add');
  row.append(name, url, add);
  kids.push(row);
  if (msg) kids.push(ok ? okLine(msg) : Object.assign(el('p', 'muted small', msg), { role: 'status' }));
  const how = el('details', 'cl-how');
  how.append(el('summary', '', t('Where do I find the link?')));
  const ol = el('ol', 'small setup-steps');
  for (const [who, steps] of HOW()) {
    const li = el('li', '');
    li.append(el('strong', '', who), document.createTextNode(` ${steps}`));
    ol.append(li);
  }
  how.append(ol, el('p', 'muted small', t('Want her to add and change events too? Use Google sign-in (Settings → Gmail and Calendar), or an iCloud or Fastmail account with an app password.')));
  kids.push(how);
  box.replaceChildren(...kids);
}

export async function loadCalendarLinks() {
  box = document.querySelector('#cl-page');
  if (!box) return;
  try {
    const r = await api('/mail/calendar-links');
    render(r.links ?? []);
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
  }
}
