// D2 (docs/WEAR.md): Settings → Connections → Phone and notifications → Wear OS watch. The watch
// shows a short code; typing it here pairs that watch (a watch-only token it picks up itself). The
// list shows this person's watches with Remove. Approvals stay on the phone.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;

export function initWearPage(c) {
  ctx = c;
  $('#wear-pair')?.addEventListener('click', () => void pair());
  $('#wear-code')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void pair();
  });
}

const status = (text) => {
  const s = $('#wear-status');
  if (s) s.textContent = text;
};

/** Called when Phone and notifications opens. */
export async function loadWearPage() {
  if (!ctx || !$('#wear-list')) return;
  try {
    render((await ctx.api('/shortcuts')).watches ?? []);
  } catch (e) {
    status(e.message);
  }
}

function render(watches) {
  const list = $('#wear-list');
  list.replaceChildren();
  if (!watches.length) list.append(ctx.el('p', 'muted small', t('No watch paired yet.')));
  for (const w of watches) {
    const row = ctx.el('div', 'row ish-token');
    row.append(ctx.el('span', '', w.label), ctx.el('span', 'muted small', t('last used {date}', { date: new Date(w.lastSeen).toLocaleDateString() })));
    const rm = ctx.el('button', 'ghost small', t('Remove'));
    rm.type = 'button';
    rm.addEventListener('click', () => void remove(w));
    row.append(rm);
    list.append(row);
  }
}

async function pair() {
  const code = $('#wear-code').value.trim();
  if (!code) return status(t('Type the code your watch shows.'));
  const btn = $('#wear-pair');
  btn.disabled = true;
  try {
    const view = await ctx.api('/shortcuts/wear/claim', { method: 'POST', body: { code, label: $('#wear-label').value.trim() } });
    $('#wear-code').value = '';
    $('#wear-label').value = '';
    status(t('Paired. The watch shows it in a few seconds.'));
    render(view.watches ?? []);
  } catch (e) {
    status(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function remove(w) {
  if (!confirm(t('Remove {name}? Its tile and Talk stop working.', { name: w.label }))) return;
  try {
    const view = await ctx.api(`/shortcuts/tokens/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
    status(t('Removed.'));
    render(view.watches ?? []);
  } catch (e) {
    status(e.message);
  }
}
