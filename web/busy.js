// Phase 116 (BR2 §5.5, docs/design/BRIDGES2.md): talking to her while she works.
//
// While a turn runs the composer stays open: Send becomes a split button whose main part does the
// default (Tell her now / After this, Settings → You → While she's working) and whose ▾ offers the
// three ways. Enter = the default, Alt+Enter = the other one; /steer, /queue and /btw pick
// explicitly. What waits is shown as chips above the composer (× to cancel, Now to make a queued
// one a steer, Send now / Remove after a restart). A side question's answer appears in a small card
// that is gone after a reload: it was never stored.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, state: any, append: (n: Node) => void, bubble: (...a: any[]) => HTMLElement, el: (tag: string, cls?: string, text?: string) => HTMLElement, canSteer: () => boolean, allowed: () => boolean, sendNow: (text: string) => void } | null} */
let ctx = null;
let mode = 'steer';
let busy = false;

/** The default from Settings → You → While she's working. */
export function setBusyDefault(m) {
  mode = m === 'queue' ? 'queue' : 'steer';
  paint();
}

const other = (k) => (k === 'steer' ? 'queue' : 'steer');
const effective = (k) => (ctx && !ctx.canSteer() && k === 'steer' ? 'queue' : k);
const words = (k) => (k === 'queue' ? t('After this') : t('Tell her now'));

function paint() {
  const send = $('#send');
  const label = $('#send-label');
  const more = $('#send-more');
  if (!send || !label || !more) return;
  const on = busy && Boolean(ctx?.allowed());
  send.hidden = busy && !on;
  send.classList.toggle('busy-send', on);
  label.hidden = !on;
  label.textContent = on ? words(effective(mode)) : '';
  send.setAttribute('aria-label', on ? t('Send: {how}', { how: words(effective(mode)) }) : t('Send'));
  // On a phone the label is hidden (busy.css): the tooltip still names the choice.
  if (on) send.title = t('Send: {how}', { how: words(effective(mode)) });
  else send.removeAttribute('title');
  more.hidden = !on;
  if (!on) closeMenu();
  for (const b of document.querySelectorAll('#send-menu [data-busy="steer"]')) b.hidden = Boolean(ctx && !ctx.canSteer());
}

/** Called by setComposerBusy: the split button while she works, the plain Send otherwise. */
export function setBusy(on) {
  busy = Boolean(on);
  paint();
}
export const isBusy = () => busy;

function closeMenu() {
  const m = $('#send-menu');
  if (m) m.hidden = true;
  $('#send-more')?.setAttribute('aria-expanded', 'false');
}

/** A typed /steer, /queue or /btw (with its text), or undefined for a plain message. */
export function typedBusy(text) {
  const m = /^\/(steer|queue|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { kind: m[1].toLowerCase(), text: (m[2] ?? '').trim() } : undefined;
}

/**
 * Sends a message while she works: `kind` = 'steer' | 'queue' | 'btw' (or the default when
 * undefined; `alt` = the other one). Returns true when it was handled here.
 */
export async function sendBusy(text, o = {}) {
  if (!ctx) return false;
  const typed = typedBusy(text);
  const kind = typed?.kind ?? o.kind ?? (o.alt ? other(mode) : mode);
  const body = typed ? typed.text : text;
  if (kind === 'btw') {
    await askAside(body);
    return true;
  }
  if (!busy) {
    ctx.sendNow(body);
    return true;
  }
  if (!body && !o.images?.length) return true;
  try {
    const r = await ctx.api(`/conversations/${ctx.state.currentId}/messages`, { method: 'POST', body: { content: body, whileBusy: effective(kind), ...(o.images?.length ? { images: o.images } : {}) } });
    renderPending(r.items ?? []);
  } catch (err) {
    ctx.append(ctx.bubble('error', err.message));
  }
  return true;
}

/** Asks a side question (nothing is stored; the answer is shown in the side card). */
export async function askAside(question) {
  if (!ctx) return;
  const q = question.trim();
  const card = $('#aside-card');
  if (!q) {
    showAside('', t('Ask your side question after /btw.'));
    return;
  }
  if (!ctx.state.currentId) return;
  showAside(q, t('Thinking…'), true);
  try {
    const r = await ctx.api(`/conversations/${ctx.state.currentId}/btw`, { method: 'POST', body: { question: q } });
    showAside(q, r.text);
  } catch (err) {
    showAside(q, err.message);
  }
  card?.scrollIntoView?.({ block: 'nearest' });
}

function showAside(q, answer, waiting = false) {
  const card = $('#aside-card');
  if (!card) return;
  $('#aside-q').textContent = q ? `“${q}”` : '';
  $('#aside-a').textContent = answer;
  card.classList.toggle('waiting', waiting);
  card.hidden = false;
}

const snippet = (s, n = 60) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

let lastInfo = { steerAt: null, detail: '' };

/** The chips above the composer (waiting, moved and stale items, in order). */
export function renderPending(items, info = lastInfo) {
  lastInfo = info;
  const box = $('#pending-chips');
  if (!box || !ctx) return;
  box.replaceChildren();
  const list = (items ?? []).filter((x) => x && ['waiting', 'moved', 'stale'].includes(x.state));
  box.hidden = !list.length;
  for (const it of list) {
    const chip = ctx.el('div', `pending-chip ${it.state} ${it.kind}`);
    chip.setAttribute('role', 'listitem');
    chip.dataset.id = it.id;
    const text = snippet(it.content);
    const say =
      it.state === 'stale'
        ? `⏸ ${t('Not sent (Sara restarted): “{text}”', { text })}`
        : it.state === 'moved'
          ? `⏭ ${t('Next: “{text}”', { text })}`
          : it.kind === 'steer'
            ? `📝 ${t('Tell her now: “{text}”', { text })}`
            : `⏭ ${t('After this: “{text}”', { text })}`;
    const line = ctx.el('span', 'pending-text', say);
    chip.append(line);
    if (it.state === 'waiting' && it.kind === 'steer') {
      const when = info.steerAt === 'approval' ? t('Answer the card first: Allow or Deny.') : info.steerAt === 'step' && info.detail ? t("She'll read it after this step ({step})", { step: snippet(info.detail, 40) }) : t('waiting for the next step');
      chip.append(ctx.el('span', 'pending-when muted small', when));
    }
    const btn = (label, cls, fn, title) => {
      const b = ctx.el('button', `pending-btn ${cls}`, label);
      b.type = 'button';
      if (title) {
        b.title = title;
        b.setAttribute('aria-label', title);
      }
      b.addEventListener('click', () => void fn().catch((err) => ctx.append(ctx.bubble('error', err.message))));
      chip.append(b);
    };
    const now = async () => renderPending((await ctx.api(`/conversations/${ctx.state.currentId}/pending/${it.id}/now`, { method: 'POST', body: {} })).pending);
    const drop = async () => renderPending((await ctx.api(`/conversations/${ctx.state.currentId}/pending/${it.id}`, { method: 'DELETE' })).pending);
    if (it.state === 'stale') {
      btn(t('Send now'), 'small', now);
      btn(t('Remove'), 'ghost small', drop);
    } else {
      if (it.state === 'waiting' && it.kind === 'queue' && it.sender !== 'person' && ctx.canSteer()) btn(t('Now'), 'ghost small', now, t('Tell her now instead'));
      btn('×', 'ghost small icon-x', drop, t('Remove'));
    }
    box.append(chip);
  }
}

/** Reloads the chips of the open conversation (after a hub `pending` event, a reload, a step). */
export async function refreshPending() {
  if (!ctx?.state.currentId) return;
  try {
    const r = await ctx.api(`/conversations/${ctx.state.currentId}/pending`);
    renderPending(r.pending ?? [], { steerAt: r.steerAt ?? null, detail: r.detail ?? '' });
  } catch {
    /* keep what is shown */
  }
}

/** A steer she took: drawn inside the running turn ("You, while she worked: …"). */
export function steerBubble(ev) {
  const b = ctx.bubble('user', ev.text, 'steer', ev.messageId);
  b.prepend(ctx.el('span', 'msg-from muted small steer-from', t('You, while she worked:')));
  return b;
}

/** The loop guard's line in the turn (a blocked repeat; tools paused). */
export function guardLine(ev) {
  const text = ev.paused ? t('Tools are paused for this turn: she kept trying a blocked step.') : ev.kind === 'declined' ? t('Not asked again: you said no twice') : t('Blocked a repeat (failed {n} times)', { n: ev.count });
  return ctx.el('div', 'guard-flag muted small', `🔁 ${text}`);
}

export function initBusy(c) {
  ctx = c;
  $('#send-more')?.addEventListener('click', (e) => {
    e.preventDefault();
    const m = $('#send-menu');
    if (!m) return;
    m.hidden = !m.hidden;
    $('#send-more').setAttribute('aria-expanded', String(!m.hidden));
    if (!m.hidden) m.querySelector('[data-busy]:not([hidden])')?.focus();
  });
  for (const b of document.querySelectorAll('#send-menu [data-busy]')) {
    b.addEventListener('click', () => {
      closeMenu();
      const input = $('#input');
      const text = input.value.trim();
      if (!text) return input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input'));
      void sendBusy(text, { kind: b.dataset.busy });
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#send-menu')?.hidden) closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || e.target.closest('.send-more-wrap')) return;
    closeMenu();
  });
  $('#aside-close')?.addEventListener('click', () => ($('#aside-card').hidden = true));
  paint();
}
