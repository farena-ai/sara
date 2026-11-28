// T62: Settings → Connections → Email and calendar / Gmail and Calendar, while another companion is
// open: "What {name} may use". The first companion uses every account; any other uses none until
// the owner ticks them here (saved at once). The server enforces it (src/companion-access.ts).
// Text only (textContent), never HTML.
import { t } from './naming.js';
import { api, el, tip } from './setup-card.js';

const BOX = { 'ab-mail': '#cacc-mail', 'ab-google': '#cacc-google' };

function check(label, on, save) {
  const row = el('label', 'row cacc-row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = Boolean(on);
  cb.dataset.nodirty = '';
  cb.addEventListener('change', () => void save(cb));
  row.append(cb, el('span', '', label));
  return row;
}

function render(box, page, v, msg = '') {
  if (v.main || !v.access) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const h = el('h3', '', t('What {name} may use', { name: v.name }));
  h.append(document.createTextNode(' '), tip(t('Each companion is her own: she only reads and uses the accounts you tick here. The first companion uses them all. Saved at once.')));
  const kids = [h];
  const save = async (cb, patch) => {
    cb.disabled = true;
    try {
      render(box, page, await api('/companion-access', { method: 'PUT', body: patch() }), t('Saved.'));
    } catch (err) {
      cb.checked = !cb.checked;
      cb.disabled = false;
      const p = box.querySelector('.cacc-msg');
      if (p) p.textContent = err.message;
    }
  };
  if (page === 'ab-mail') {
    if (!v.mail.length) kids.push(el('p', 'muted small', t('No mailbox is connected yet.')));
    for (const m of v.mail) {
      kids.push(check(m.address, v.access.mail.includes(m.id), (cb) => save(cb, () => ({ mail: cb.checked ? [...new Set([...v.access.mail, m.id])] : v.access.mail.filter((x) => x !== m.id) }))));
    }
  } else {
    kids.push(check(t('Google Calendar, Docs and Sheets, and calendars added by link'), v.access.google, (cb) => save(cb, () => ({ google: cb.checked }))));
    kids.push(check(t('Spotify'), v.access.spotify, (cb) => save(cb, () => ({ spotify: cb.checked }))));
    kids.push(el('p', 'muted small', t('Her Gmail is ticked per mailbox under Email and calendar.')));
  }
  const p = el('p', 'muted small cacc-msg', msg);
  p.setAttribute('role', 'status');
  kids.push(p);
  box.replaceChildren(...kids);
}

/** Fills the block on the mail or Google page (hidden for the first companion). */
export async function loadCompanionAccess(page) {
  const box = document.querySelector(BOX[page] ?? '');
  if (!box) return;
  try {
    render(box, page, await api('/companion-access'));
  } catch {
    box.hidden = true;
  }
}
