// HANDSFREE (docs/desktop.md → Hands-free): the banner above the composer while she finishes a task on her
// own ("Let her finish this task"), with Stop, and the step log after. Text only (textContent), never HTML.
// The server is the source of truth: GET/DELETE /api/computer/handsfree/<conversation>.
import { currentIdentity, t } from './naming.js';

let ctx = null;
const hf = { conv: '', view: null, open: false };
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
};
const clock = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};
const WHY = { you: () => t('you stopped her'), time: () => t('the time ran out'), takeover: () => t('you used the computer yourself'), task: () => t('a new task started'), limit: () => t('she reached a hard limit') };

function paint() {
  const bar = $('#hf-banner');
  if (!bar) return;
  const v = hf.view;
  if (!v || (!v.active && !v.steps?.length)) {
    bar.hidden = true;
    return;
  }
  const name = currentIdentity().name || t('Sara');
  const text = $('#hf-text');
  text.dataset.raw = '';
  text.textContent = v.active
    ? t('{name} is finishing this task on her own until {time}. She still stops for passwords, codes and payments.', { name, time: clock(v.until) })
    : t('Hands-free ended: {why}. {n} steps.', { why: (WHY[v.ended?.why] ?? WHY.you)(), n: v.steps.length });
  bar.classList.toggle('done', !v.active);
  $('#hf-stop').hidden = !v.active;
  $('#hf-log').hidden = !v.steps?.length;
  $('#hf-log').textContent = hf.open ? t('Hide steps') : t('Steps ({n})', { n: v.steps.length });
  const list = $('#hf-steps');
  list.hidden = !hf.open;
  list.replaceChildren(...(hf.open ? v.steps.map((s) => el('li', '', `${clock(s.at)} · ${s.what}${s.where ? ` (${s.where})` : ''}`)) : []));
  bar.hidden = false;
}

/** The current conversation's stretch (on opening a chat and after each event for it). */
export async function refreshHandsFree(conversationId) {
  if (!ctx) return;
  hf.conv = conversationId || '';
  if (!hf.conv) {
    hf.view = null;
    return paint();
  }
  try {
    const v = await ctx.api(`/computer/handsfree/${encodeURIComponent(hf.conv)}`);
    if (hf.conv === conversationId) hf.view = v;
  } catch {
    hf.view = null;
  }
  paint();
}

/** A `computer` event with `handsFree` (started, renewed or ended). */
export function onHandsFreeEvent(ev) {
  if (!ctx || !ev || ev.handsFree === undefined) return false;
  if (ev.conversationId && ev.conversationId === hf.conv) void refreshHandsFree(hf.conv);
  return true;
}

export function initHandsFree(c) {
  ctx = c;
  $('#hf-stop')?.addEventListener('click', async () => {
    if (!hf.conv) return;
    try {
      hf.view = await ctx.api(`/computer/handsfree/${encodeURIComponent(hf.conv)}`, { method: 'DELETE' });
    } catch {
      /* the next refresh shows it */
    }
    ctx.stop?.();
    paint();
  });
  $('#hf-log')?.addEventListener('click', () => {
    hf.open = !hf.open;
    paint();
  });
}
