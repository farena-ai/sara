// Phase 119 part B (docs/design/RECALL.md §5.5, §5.9): pick a chat up in another app.
//
// A slim banner above the composer when he was just talking in another of his chats ("On Telegram
// 12 min ago: 'so which flight did we pick…'" · Continue here · Not now · ?), the chip at the top of
// the picked-up thread (↪ Continued from Telegram · Show · Undo; Show opens exactly the lines she is
// given), and Settings → Connections → Pick up across apps. Nothing is copied or merged: the pickup is
// a pointer the server checks at every turn.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, state: any, reload: (id: string) => void } | null} */
let ctx = null;
let offer = null;
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const place = (p) => (p === 'the app' ? t('the app') : p);

export function initPickup(c) {
  ctx = c;
  $('#pk-continue')?.addEventListener('click', () => void accept());
  $('#pk-not-now')?.addEventListener('click', () => void decline());
}

/** When a conversation opens (or a new chat starts): is there one to pick up? */
export async function pickupOpen(id) {
  const bar = $('#pickup-banner');
  if (!bar || !ctx) return;
  offer = null;
  bar.hidden = true;
  if (!id || document.body.classList.contains('demo')) return;
  try {
    const o = await ctx.api(`/pickup?conversationId=${encodeURIComponent(id)}`);
    if (!o?.id || id !== ctx.state.currentId) return;
    offer = { ...o, conversationId: id };
    $('#pk-text').textContent = t('On {place} {ago}: “{preview}”', { place: place(o.place), ago: o.ago, preview: o.preview });
    bar.hidden = false;
  } catch {
    /* members and off the record: nothing to offer */
  }
}

/** Her reply came while the banner was up and he didn't choose: it folds away (no pickup). */
export function pickupAfterReply() {
  const bar = $('#pickup-banner');
  if (bar && !bar.hidden) {
    bar.hidden = true;
    offer = null;
  }
}

async function accept() {
  if (!offer) return;
  const o = offer;
  $('#pickup-banner').hidden = true;
  offer = null;
  try {
    await ctx.api(`/conversations/${o.conversationId}/pickup`, { method: 'POST', body: { offerId: o.id, via: 'banner' } });
  } finally {
    ctx.reload(o.conversationId);
  }
}
async function decline() {
  if (!offer) return;
  const o = offer;
  $('#pickup-banner').hidden = true;
  offer = null;
  await ctx.api(`/pickup/${o.id}/decline`, { method: 'POST', body: {} }).catch(() => undefined);
}

/** The notice row of a pickup (`kind: 'pickup'`): the chip at the top of the thread. */
export function pickupNotice(m) {
  const p = m.meta?.pickup ?? {};
  const box = el('div', 'pickup-chip');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', t('Continued from {place}', { place: place(p.place ?? '') }));
  const ic = el('span', 'pickup-ic', '↪');
  ic.setAttribute('aria-hidden', 'true');
  const txt = el('span', 'pickup-text', `${t('Continued from {place}', { place: place(p.place ?? '') })}${p.carried?.workspace ? ` · ${t('and the folder {folder}', { folder: p.carried.workspace })}` : ''}`);
  const when = el('span', 'muted small', m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const row = el('span', 'pickup-actions');
  const show = el('button', 'ghost small', t('Show'));
  show.type = 'button';
  show.addEventListener('click', () => void showNote(m.conversationId ?? ctx.state.currentId));
  const undo = el('button', 'ghost small', t('Undo'));
  undo.type = 'button';
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    await ctx.api(`/conversations/${ctx.state.currentId}/pickup`, { method: 'DELETE' }).catch(() => undefined);
    row.replaceChildren(el('span', 'muted small', t('Undone. Nothing was copied.')));
    box.classList.add('pickup-undone');
  });
  row.append(show, undo);
  box.append(ic, txt, when, row);
  void ctx.api(`/conversations/${ctx.state.currentId}/pickup`).then((v) => {
    if (!v?.pickup || v.pickup.id !== p.id) {
      row.replaceChildren(el('span', 'muted small', t('No longer carried')));
      box.classList.add('pickup-undone');
    }
  }).catch(() => undefined);
  return box;
}

async function showNote(id) {
  const dlg = $('#pickup-dialog');
  if (!dlg) return;
  let v;
  try {
    v = await ctx.api(`/conversations/${id}/pickup`);
  } catch {
    return;
  }
  $('#pickup-note').textContent = v?.note || t('Nothing is carried here now.');
  dlg.showModal();
}

// ---------------------------------------------------------------- Settings → Connections → Pick up across apps

export async function loadPickupSettings() {
  const form = $('#pk-form');
  if (!form || !ctx) return;
  let v;
  try {
    v = await ctx.api('/pickup/settings');
  } catch {
    form.hidden = true;
    return;
  }
  form.hidden = false;
  const fill = (id, list, word) => {
    const s = $(`#${id}`);
    if (s && !s.options.length) for (const n of list) s.append(new Option(word(n), String(n)));
  };
  fill('pk-within', v.choices.within, (n) => (n >= 60 ? t('{n} h', { n: n / 60 }) : t('{n} min', { n })));
  fill('pk-lines', v.choices.lines, (n) => String(n));
  $('#pk-mode').value = v.settings.mode;
  $('#pk-within').value = String(v.settings.within);
  $('#pk-lines').value = String(v.settings.lines);
  $('#pk-folder').checked = v.settings.folder;
  const apps = $('#pk-apps');
  apps.replaceChildren(
    ...(v.apps.length
      ? v.apps.map((a) => {
          const row = el('label', 'row');
          const c = el('input');
          c.type = 'checkbox';
          c.dataset.app = a.app;
          c.checked = v.settings.apps[a.app] !== false;
          row.append(c, document.createTextNode(` ${place(a.place)}`));
          return row;
        })
      : [el('p', 'muted small', t('Link Telegram or Discord first: then your chats there can take part.'))]),
  );
  form.dataset.loaded = '1';
}

export async function savePickupSettings() {
  const form = $('#pk-form');
  if (!form?.dataset.loaded || !ctx) return;
  const apps = Object.fromEntries([...document.querySelectorAll('#pk-apps input[data-app]')].map((c) => [c.dataset.app, c.checked]));
  await ctx.api('/pickup/settings', { method: 'PUT', body: { mode: $('#pk-mode').value, within: Number($('#pk-within').value), lines: Number($('#pk-lines').value), folder: $('#pk-folder').checked, apps } });
}
