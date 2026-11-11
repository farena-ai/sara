// Phase 116 (BR2 §5.5, docs/design/BRIDGES2.md): talking to her while she works.
//
// While a turn runs the composer stays open: Send becomes a split button whose main part does the
// default (Tell her now / Interrupt now / After this, Settings → You → While she's working) and whose
// ▾ offers the four ways. Enter = the default, Alt+Enter = the other one, Ctrl/Cmd+Enter = Interrupt
// now; /steer, /now, /queue and /btw pick explicitly. Interrupt now stops what she is writing at
// once; a tool that changes things finishes first (the pill says so, with Stop the command for a
// command), and an approval card still needs Allow or Deny. What waits is shown as chips above the composer (× to cancel, Now to make a queued
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
  mode = m === 'queue' || m === 'interrupt' ? m : 'steer';
  paint();
}

const other = (k) => (k === 'queue' ? 'steer' : 'queue');
const effective = (k) => (ctx && !ctx.canSteer() && (k === 'steer' || k === 'interrupt') ? 'queue' : k);
const words = (k) => (k === 'queue' ? t('After this') : k === 'interrupt' ? t('Interrupt now') : t('Tell her now'));

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
  for (const b of document.querySelectorAll('#send-menu [data-busy="steer"], #send-menu [data-busy="interrupt"]')) b.hidden = Boolean(ctx && !ctx.canSteer());
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

/** A typed /steer, /queue, /btw or /now (with its text), or undefined for a plain message. */
export function typedBusy(text) {
  const m = /^\/(steer|queue|btw|now)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const k = m[1].toLowerCase();
  return { kind: k === 'now' ? 'interrupt' : k, text: (m[2] ?? '').trim() };
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

let lastInfo = { steerAt: null, detail: '', interrupt: null };

/** What the pill says while an interrupt waits (plain words: what she is stopping, and why it may wait). */
function interruptWhen(info) {
  const i = info.interrupt;
  if (info.steerAt === 'approval' || i?.state === 'approval') return t("She's waiting for your answer on the card. Allow or Deny it, and she reads this right after. Your message doesn't answer the card.");
  if (i?.state === 'tool' && i.stoppable) return t("Waiting for the command she's running to finish ({step}).", { step: snippet(i.summary || i.tool, 40) });
  if (i?.state === 'tool') return t("Waiting for this step to finish ({step}): it changes things, so it isn't cut off halfway.", { step: snippet(i.summary || i.tool, 40) });
  return t('Stopping her now…');
}

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
    const now = it.state === 'waiting' && it.kind === 'steer' && it.meta?.now === true;
    const say =
      now
        ? `⚡ ${t('Interrupting…')} “${text}”`
        : it.state === 'stale'
        ? `⏸ ${t('Not sent (Sara restarted): “{text}”', { text })}`
        : it.state === 'moved'
          ? `⏭ ${t('Next: “{text}”', { text })}`
          : it.kind === 'steer'
            ? `📝 ${t('Tell her now: “{text}”', { text })}`
            : `⏭ ${t('After this: “{text}”', { text })}`;
    const line = ctx.el('span', 'pending-text', say);
    chip.append(line);
    if (now) {
      chip.classList.add('interrupting');
      chip.append(ctx.el('span', 'pending-when muted small', interruptWhen(info)));
    } else if (it.state === 'waiting' && it.kind === 'steer') {
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
    const promote = async () => renderPending((await ctx.api(`/conversations/${ctx.state.currentId}/pending/${it.id}/now`, { method: 'POST', body: {} })).pending);
    const cutIn = async () => {
      await ctx.api(`/conversations/${ctx.state.currentId}/pending/${it.id}/interrupt`, { method: 'POST', body: {} });
      await refreshPending();
    };
    const stopCmd = async () => {
      await ctx.api(`/conversations/${ctx.state.currentId}/pending/stop-tool`, { method: 'POST', body: {} });
      await refreshPending();
    };
    const drop = async () => renderPending((await ctx.api(`/conversations/${ctx.state.currentId}/pending/${it.id}`, { method: 'DELETE' })).pending);
    if (it.state === 'stale') {
      btn(t('Send now'), 'small', promote);
      btn(t('Remove'), 'ghost small', drop);
    } else {
      if (it.state === 'waiting' && it.kind === 'queue' && it.sender !== 'person' && ctx.canSteer()) btn(t('Now'), 'ghost small', promote, t('Tell her now instead'));
      if (it.state === 'waiting' && it.kind === 'steer' && !now && ctx.canSteer()) btn(t('Interrupt now'), 'ghost small', cutIn, t("Stop what she's doing and read this now"));
      if (now && info.interrupt?.state === 'tool' && info.interrupt.stoppable) btn(t('Stop the command'), 'small', stopCmd, t('Stops the command she is running; she then reads your message'));
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
    renderPending(r.pending ?? [], { steerAt: r.steerAt ?? null, detail: r.detail ?? '', interrupt: r.interrupt ?? null });
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

/** Interrupt now: her reply that was cut off, folded to its first line under "She was saying…". */
export function sayingFold(b) {
  if (!b || b.querySelector(':scope > .saying-toggle')) return b;
  b.classList.add('was-saying', 'collapsed');
  const tg = ctx.el('button', 'saying-toggle linkish small', t('She was saying…'));
  tg.type = 'button';
  tg.setAttribute('aria-expanded', 'false');
  tg.addEventListener('click', () => {
    const open = b.classList.toggle('collapsed') === false;
    tg.setAttribute('aria-expanded', String(open));
  });
  b.prepend(tg);
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
