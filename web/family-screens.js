// W4.5 (docs/FAMILY_SCREEN.md): Settings → Household → People on this server → Family screen. The
// owner makes a one-time code for a tablet (it opens /family-screen and types it) and manages the
// screens it paired: name, night dimming, the kid-safe Talk button, his own reminders, remove.
// Loaded by web/household.js loadHousehold (no app.js change).
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
async function api(path, opts = {}) {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const res = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, t('Something went wrong. Try again.')));
  return data;
}

let wired = false;
function wire() {
  if (wired || !$('#fsc-code')) return;
  wired = true;
  $('#fsc-code').addEventListener('click', async () => {
    const status = $('#fsc-status');
    status.textContent = '';
    try {
      const r = await api('/family/screens/code', { body: { name: $('#fsc-name').value } });
      $('#fsc-url').textContent = `${location.origin}/family-screen`;
      $('#fsc-new-code').textContent = r.code;
      $('#fsc-new').hidden = false;
      $('#fsc-name').value = '';
      setTimeout(() => void loadFamilyScreens(), 15_000);
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

const seen = (iso) => (iso ? t('Last seen {when}', { when: new Date(iso).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) }) : t('Not seen yet'));

function row(s) {
  const box = el('div', 'hh-member fsc-screen');
  const head = el('p', 'fsc-head');
  head.append(el('strong', '', s.name), el('span', 'muted small', ` · ${seen(s.lastSeen)}`));
  const save = async (patch, status) => {
    try {
      await api(`/family/screens/${s.id}`, { method: 'PATCH', body: patch });
      status.textContent = t('Saved.');
    } catch (err) {
      status.textContent = err.message;
    }
  };
  const status = el('p', 'small fsc-row-status');
  status.setAttribute('role', 'status');
  const dim = el('label', 'fsc-field');
  const from = el('input');
  from.type = 'time';
  from.value = s.prefs.dimFrom;
  from.setAttribute('aria-label', t('Dims from'));
  const to = el('input');
  to.type = 'time';
  to.value = s.prefs.dimTo;
  to.setAttribute('aria-label', t('Dims until'));
  dim.append(el('span', '', t('Dims at night from')), from, el('span', '', t('to')), to);
  for (const i of [from, to]) i.addEventListener('change', () => void save({ dimFrom: from.value, dimTo: to.value }, status));
  const check = (key, label, help) => {
    const l = el('label', 'fsc-check');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = Boolean(s.prefs[key]);
    c.addEventListener('change', () => void save({ [key]: c.checked }, status));
    const txt = el('span', '', label);
    l.append(c, txt);
    const p = el('p', 'muted small fsc-help', help);
    return [l, p];
  };
  const rm = el('button', 'ghost small danger', t('Remove this screen'));
  rm.type = 'button';
  rm.addEventListener('click', async () => {
    if (!confirm(t('Remove {name}? It is signed out at once.', { name: s.name }))) return;
    try {
      await api(`/family/screens/${s.id}`, { method: 'DELETE' });
      void loadFamilyScreens();
    } catch (err) {
      status.textContent = err.message;
    }
  });
  box.append(
    head,
    dim,
    el('p', 'muted small fsc-help', t('Leave both empty to never dim. Talk rests while it is dimmed.')),
    ...check('talk', t('Kid-safe Talk button'), t('Kids talk in their own space with their own limits. Everyone else talks off the record. Never tools, shopping, money or computer use.')),
    ...check('myReminders', t('Show my reminders'), t('Your own reminders due today, on this screen for everyone to see. Off unless you turn it on.')),
    rm,
    status,
  );
  return box;
}

export async function loadFamilyScreens() {
  wire();
  const list = $('#fsc-list');
  if (!list) return;
  try {
    const r = await api('/family/screens');
    list.replaceChildren(...(r.screens.length ? r.screens.map(row) : [el('p', 'muted small', t('No family screens yet.'))]));
  } catch (err) {
    $('#fsc-status').textContent = err.message;
  }
}
