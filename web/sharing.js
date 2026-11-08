// EC11 (docs/ops/EC1115_DESIGN.md): share a conversation as a read-only, expiring link (the dialog
// from a chat's settings) and Settings → Household → Shared links (list, revoke, private chats).
// The server builds, scrubs and refuses; this page only shows what it says.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let conv = null;

export function initSharing(c) {
  ctx = c;
  $('#shd-tools')?.addEventListener('change', () => void preview());
  $('#shd-pictures')?.addEventListener('change', () => void preview());
  $('#shd-create')?.addEventListener('click', () => void create());
  $('#shd-copy')?.addEventListener('click', () => {
    const v = $('#shd-link').value;
    void navigator.clipboard?.writeText(v).then(() => ($('#shd-copy').textContent = t('Copied')));
  });
  $('#sl-private')?.addEventListener('change', () => void ctx.api('/shares/settings', { method: 'PUT', body: { allowPrivate: $('#sl-private').checked } }).catch((e) => alert(e.message)));
  const page = document.querySelector('.settings-page[data-page="dh-shares"]');
  if (page) new MutationObserver(() => !page.hidden && void loadShares()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

const opts = () => ({ tools: Boolean($('#shd-tools')?.checked), pictures: Boolean($('#shd-pictures')?.checked) });

/** Opens the share dialog for a conversation (from its settings). */
export async function openShare(c) {
  if (!ctx || !c) return;
  conv = c;
  $('#shd-tools').checked = false;
  $('#shd-pictures').checked = false;
  $('#shd-expires').value = '7d';
  $('#shd-result').hidden = true;
  $('#shd-create').hidden = false;
  $('#shd-copy').textContent = t('Copy');
  $('#share-dialog').showModal();
  await preview();
}

function hiddenLine(h) {
  const parts = [];
  if (h.scrubbed) parts.push(t('{n} hidden (keys, e-mail addresses, phone numbers)', { n: h.scrubbed }));
  if (h.tools) parts.push(t('{n} tool results left out', { n: h.tools }));
  if (h.pictures) parts.push(t('{n} pictures left out', { n: h.pictures }));
  return parts.length ? parts.join(' · ') : t('Nothing was hidden.');
}

async function preview() {
  if (!conv) return;
  const box = $('#shd-preview');
  $('#shd-error').textContent = '';
  try {
    const d = await ctx.api(`/conversations/${encodeURIComponent(conv.id)}/share/preview`, { method: 'POST', body: opts() });
    $('#shd-hidden').textContent = hiddenLine(d.snapshot.hidden);
    const el = ctx.el;
    box.replaceChildren(
      ...d.snapshot.messages.slice(0, 200).map((m) => {
        const row = el('div', `shd-msg shd-${m.role}`);
        row.append(el('strong', 'shd-who', m.role === 'user' ? t('You') : m.role === 'tool' ? t('Tool result: {name}', { name: m.name ?? '' }) : d.snapshot.companion), el('div', 'shd-text', m.text));
        if (m.pics?.length) row.append(el('span', 'muted small', t('{n} pictures', { n: m.pics.length })));
        return row;
      }),
    );
    $('#shd-create').disabled = false;
  } catch (e) {
    box.replaceChildren();
    $('#shd-hidden').textContent = '';
    $('#shd-error').textContent = e.message;
    $('#shd-create').disabled = true;
  }
}

async function create() {
  if (!conv) return;
  $('#shd-error').textContent = '';
  try {
    const d = await ctx.api('/shares', { method: 'POST', body: { conversationId: conv.id, expires: $('#shd-expires').value, ...opts() } });
    $('#shd-link').value = d.link;
    $('#shd-result').hidden = false;
    $('#shd-create').hidden = true;
    $('#shd-link').select();
  } catch (e) {
    $('#shd-error').textContent = e.message;
  }
}

export async function loadShares() {
  if (!ctx || !$('#sl-list')) return;
  let d;
  try {
    d = await ctx.api('/shares');
  } catch (e) {
    $('#sl-list').replaceChildren(ctx.el('p', 'error', e.message));
    return;
  }
  $('#sl-private').checked = Boolean(d.allowPrivate);
  $('#sl-pinned').hidden = d.sharing !== false;
  const el = ctx.el;
  if (!d.shares.length) {
    $('#sl-list').replaceChildren(el('p', 'muted small', t('No shared links right now.')));
    return;
  }
  $('#sl-list').replaceChildren(
    ...d.shares.map((s) => {
      const row = el('div', 'sl-row');
      const info = el('div', 'sl-info');
      info.append(el('strong', '', s.title), el('span', 'muted small', t('Shared {made} · expires {ends} · opened {n} times', { made: new Date(s.createdAt).toLocaleString(), ends: new Date(s.expiresAt).toLocaleString(), n: s.views })));
      const revoke = el('button', 'ghost small danger-text', t('Revoke'));
      revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        if (!confirm(t('Revoke this link? It stops working at once.'))) return;
        await ctx.api(`/shares/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch((e) => alert(e.message));
        void loadShares();
      });
      row.append(info, revoke);
      return row;
    }),
  );
}
