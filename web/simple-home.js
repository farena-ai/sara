// V5.4 (docs/design/V5CARE.md): Simple home, a plain full-screen page with four big buttons (talk,
// medicines, check in, call family). "Open Simple home when Sara starts" is this device's own switch
// (localStorage sara.simpleHome), like text size. Opened from Health, `#view=simple`, or on start.
import { checkIn, checkinWord } from './care.js';
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
const KEY = 'sara.simpleHome';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const big = (label, cls, onClick) => {
  const b = el('button', `sh-wide ${cls}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const on = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
const setOn = (v) => {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
};

export function initSimpleHome(c) {
  ctx = c;
  $('#hl-simple-open')?.addEventListener('click', () => {
    $('#health')?.close();
    void openSimpleHome();
  });
  $('#sh-start')?.addEventListener('change', (e) => setOn(e.target.checked));
  $('#sh-talk')?.addEventListener('click', talk);
  $('#sh-meds')?.addEventListener('click', () => void meds());
  $('#sh-checkin')?.addEventListener('click', checkinPanel);
  $('#sh-call')?.addEventListener('click', () => void callPanel());
  $('#sh-exit')?.addEventListener('click', () => {
    if (on() && confirm(t('Keep opening Simple home when Sara starts on this device?')) === false) setOn(false);
    $('#simple-home')?.close();
  });
  if (on()) setTimeout(() => void openSimpleHome(), 800);
}

export async function openSimpleHome() {
  const d = $('#simple-home');
  if (!d || !ctx) return;
  if (!d.open) d.showModal();
  panel();
  const h = new Date().getHours();
  $('#sh-hello').textContent = h < 12 ? t('Good morning.') : h < 18 ? t('Good afternoon.') : t('Good evening.');
}

/** Shows (or hides, with no children) the panel under the buttons. */
function panel(title, ...children) {
  const p = $('#sh-panel');
  if (!p) return;
  p.replaceChildren();
  p.hidden = !title;
  if (!title) return;
  p.append(el('h3', '', title), ...children);
  p.scrollIntoView?.({ block: 'nearest' });
}

function talk() {
  $('#simple-home')?.close();
  const b = $('#talk-btn');
  if (b && !b.hidden) b.click();
  else $('#input')?.focus();
}

async function meds() {
  let r;
  try {
    r = await ctx.api('/health-log');
  } catch (err) {
    return panel(t('Medicines'), el('p', '', err?.message ?? String(err)));
  }
  const due = (r.doses ?? []).filter((d) => d.status === 'due');
  const name = (id) => r.meds.find((m) => m.id === id)?.name ?? t('Medicine');
  const rows = due.map((d) => {
    const row = el('div', 'sh-row');
    row.append(
      el('span', 'sh-row-main', `${name(d.medId)} · ${new Date(d.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`),
      big(t('Taken'), '', async () => {
        await ctx.api(`/health-log/doses/${d.id}`, { method: 'POST', body: { status: 'taken' } }).catch(() => undefined);
        void meds();
      }),
    );
    return row;
  });
  const next = r.meds.filter((m) => m.active !== false && m.times.length).map((m) => `${m.name}: ${m.times.join(', ')}`);
  panel(
    t('Medicines'),
    ...(rows.length ? rows : [el('p', '', t('Nothing due right now.'))]),
    ...(next.length ? [el('p', 'sh-muted', next.join(' · '))] : [el('p', 'sh-muted', t('No medicines yet. Add them in Health.'))]),
  );
}

function checkinPanel() {
  const status = el('p', 'sh-muted');
  status.setAttribute('role', 'status');
  const ans = (s) =>
    big(checkinWord(s), s === 'help' ? 'sh-help' : s === 'ok' ? '' : 'ghost', async () => {
      const r = await checkIn(s);
      status.textContent = r ? (s === 'help' ? t('Your caregivers were told.') : t('Checked in. Thank you.')) : t('That did not work. Try again.');
    });
  panel(t('How are you today?'), el('div', 'sh-answers'), status);
  $('#sh-panel .sh-answers').append(ans('ok'), ans('notgreat'), ans('help'));
}

async function callPanel() {
  const r = await ctx.api('/health-log/care').catch(() => undefined);
  const contacts = r?.contacts ?? [];
  if (!contacts.length) return panel(t('Call family'), el('p', '', t('Add people to call in Health, under Simple home.')));
  const links = contacts.map((c) => {
    const a = el('a', 'sh-wide sh-call', `${c.name}`);
    a.href = `tel:${c.phone.replace(/[^\d+]/g, '')}`;
    a.append(el('span', 'sh-muted', ` ${c.phone}`));
    return a;
  });
  panel(t('Call family'), ...links);
}
