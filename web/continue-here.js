// W1.3 (docs/design/W1CONTINUE.md): continue on another device. This device tells the server where
// the person is (open chat, unsent draft, the message at the top of the screen, Talk on, the live
// view in sight); another device opened within a short window shows one card: "Continue where you
// left off on your PC — 2 minutes ago" (the age comes from the server's W0.6 words) with Continue /
// Not now. The ⋯ chips row has "Continue on my phone", which pushes the chat to the person's phone.
// Settings → Connections → Phone and notifications → Continue on another device. Per person: the
// server keeps it in each person's own space.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: Function, el: Function, state: any, open: (id: string) => Promise<void> | void, jump: (id: number) => Promise<void> | void, talkOn: () => boolean, startTalk: () => void, notice: (s: string) => void } | null} */
let ctx = null;
let timer = 0;
let last = '';
let shown = null;

const KEY = 'sara.device.id';
/** A random id for this browser / app (no fingerprinting: nothing about the device is in it). */
export function deviceId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id || !/^[\w-]{6,64}$/.test(id)) {
      id = `d-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'd-nostorage';
  }
}
/** Same rules as src/continue-here.ts deviceKind. */
export function kindOf(ua) {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile|SaraPhone/i.test(ua))) return 'tablet';
  if (/SaraPhone|iPhone|Android|Mobile/i.test(ua)) return 'phone';
  if (/Windows/i.test(ua)) return 'pc';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  return 'computer';
}
export function deviceName(kind) {
  return { phone: t('your phone'), tablet: t('your tablet'), pc: t('your PC'), mac: t('your Mac') }[kind] ?? t('another computer');
}
const myKind = () => kindOf(navigator.userAgent);

/** The message at the top of the chat (0 = at the end). */
function scrollSpot() {
  const box = $('#messages');
  if (!box || box.scrollHeight - box.scrollTop - box.clientHeight < 60) return 0;
  const top = box.getBoundingClientRect().top;
  for (const m of box.querySelectorAll('[data-id]')) {
    if (m.getBoundingClientRect().bottom > top + 8) return Number(m.dataset.id) || 0;
  }
  return 0;
}
function canvasSpot() {
  const box = $('#messages');
  if (!box) return 0;
  const r = box.getBoundingClientRect();
  for (const c of box.querySelectorAll('.rcard-canvas[data-canvas]')) {
    const b = c.getBoundingClientRect();
    if (b.bottom > r.top && b.top < r.bottom) return Number(c.dataset.canvas) || 0;
  }
  return 0;
}
function spot() {
  const id = ctx?.state?.currentId;
  if (!id) return null;
  return { device: deviceId(), kind: myKind(), conversationId: id, draft: $('#input')?.value ?? '', scroll: scrollSpot(), talk: Boolean(ctx.talkOn?.()), canvas: canvasSpot() };
}

/** Tell the server where this device is (debounced; `now` for page hide). */
export function noteHere(now = false) {
  if (!ctx || document.body.classList.contains('demo')) return;
  clearTimeout(timer);
  const go = () => {
    const s = spot();
    if (!s) return;
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    if (now) void fetch('/api/continue-here', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: key, keepalive: true }).catch(() => {});
    else ctx.api('/continue-here', { method: 'PUT', body: s }).catch(() => {});
  };
  if (now) go();
  else timer = setTimeout(go, 1500);
}

export function initContinueHere(c) {
  ctx = c;
  document.addEventListener('input', (e) => e.target?.id === 'input' && noteHere());
  $('#messages')?.addEventListener('scroll', () => noteHere(), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) noteHere(true);
    else void checkOffer();
  });
  window.addEventListener('pagehide', () => noteHere(true));
  const btn = $('#cnt-phone');
  if (btn) {
    btn.hidden = myKind() === 'phone';
    btn.title = t('Continue on my phone');
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', () => void toPhone());
  }
  $('#cnt-on')?.addEventListener('change', () => void saveSettings());
  $('#cnt-within')?.addEventListener('change', () => void saveSettings());
  setTimeout(() => void checkOffer(), 1800);
}

/** A chat opened on this device. */
export function continueOpen() {
  noteHere();
}

async function checkOffer() {
  if (!ctx || document.body.classList.contains('demo')) return;
  let r;
  try {
    r = await ctx.api(`/continue-here?device=${encodeURIComponent(deviceId())}&lang=${encodeURIComponent(document.documentElement.lang || 'en')}`);
  } catch {
    return;
  }
  const o = r?.offer;
  if (!o) return hideCard();
  // Already here with the same words: nothing to offer.
  if (o.conversationId === ctx.state.currentId && ($('#input')?.value ?? '') === o.draft) return hideCard();
  showCard(o);
}

function host() {
  let h = $('#cnt-pop');
  if (!h) {
    h = ctx.el('div', 'cnt-pop');
    h.id = 'cnt-pop';
    h.setAttribute('role', 'region');
    h.setAttribute('aria-label', t('Continue on another device'));
    if (typeof h.showPopover === 'function') h.popover = 'manual';
    document.body.append(h);
  }
  // A modal dialog (Today) makes everything outside it inert: move into the top one.
  const modal = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal')).pop() ?? document.body;
  if (h.parentElement !== modal) {
    if (h.matches?.(':popover-open')) h.hidePopover();
    modal.append(h);
  }
  if (h.popover && !h.matches(':popover-open')) h.showPopover();
  return h;
}
function hideCard() {
  shown = null;
  const h = $('#cnt-pop');
  if (!h) return;
  h.replaceChildren();
  if (h.popover && h.matches(':popover-open')) h.hidePopover();
}
const button = (text, cls, fn) => {
  const b = ctx.el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};

function showCard(o) {
  shown = o;
  const card = ctx.el('div', 'cnt-card');
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const icon = ctx.el('span', 'cnt-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = o.kind === 'phone' || o.kind === 'tablet' ? '📱' : '💻';
  const text = ctx.el('div', 'cnt-text');
  const head = ctx.el('strong', 'cnt-title', t('Continue where you left off on {device}', { device: deviceName(o.kind) }));
  head.append(ctx.el('span', 'cnt-ago', ` — ${o.ago}`));
  text.append(head, ctx.el('span', 'cnt-chat', o.title));
  if (o.draft) text.append(ctx.el('span', 'cnt-draft', `“${o.draft.length > 140 ? `${o.draft.slice(0, 137)}…` : o.draft}”`));
  const tags = [];
  if (o.talk) tags.push(t('Talk was on'));
  if (o.canvas) tags.push(t('Live view open'));
  if (tags.length) text.append(ctx.el('span', 'cnt-tags', tags.join(' · ')));
  const acts = ctx.el('div', 'cnt-acts');
  acts.append(
    button(t('Not now'), 'ghost cnt-later', () => {
      void ctx.api('/continue-here/dismiss', { method: 'POST', body: { device: deviceId(), at: o.at } }).catch(() => {});
      hideCard();
    }),
    button(t('Continue'), 'primary cnt-go', () => void accept(o)),
  );
  card.append(icon, text, acts);
  host().replaceChildren(card);
}

async function accept(o) {
  hideCard();
  await ctx.open(o.conversationId);
  const input = $('#input');
  if (input && o.draft && !input.value.trim()) {
    input.value = o.draft;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  }
  if (o.canvas) {
    const c = document.querySelector(`#messages .rcard-canvas[data-canvas="${o.canvas}"]`);
    if (c) c.scrollIntoView({ block: 'center' });
    else if (o.scroll) await ctx.jump(o.scroll);
  } else if (o.scroll) await ctx.jump(o.scroll);
  // The tap on Continue is the gesture Talk needs for the microphone.
  if (o.talk && !ctx.talkOn()) ctx.startTalk();
  noteHere(true);
}

async function toPhone() {
  const s = spot();
  if (!s) return ctx.notice(t('Open a chat first.'));
  try {
    const r = await ctx.api('/continue-here/phone', { method: 'POST', body: s });
    ctx.notice(r.sent ? t('Sent to your phone. Open the notification to continue there.') : r.phones ? t('Your phone did not answer. Open Sara on it within the next half hour and it offers this chat.') : t('No phone gets notifications from Sara yet. Open Sara on your phone within the next half hour and it offers this chat, or turn on notifications there.'));
  } catch (err) {
    ctx.notice(String(err?.message ?? err));
  }
}

/** Settings → Phone and notifications → Continue on another device. */
export async function loadContinueSettings() {
  if (!ctx || !$('#cnt-on')) return;
  const r = await ctx.api('/continue-here/settings').catch(() => null);
  if (!r) return;
  $('#cnt-on').checked = r.settings.on;
  const sel = $('#cnt-within');
  if (!sel.options.length) {
    for (const m of [5, 15, 30, 60, 120, 240]) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = m < 60 ? t('{n} minutes', { n: m }) : m === 60 ? t('1 hour') : t('{n} hours', { n: m / 60 });
      sel.append(o);
    }
  }
  sel.value = String(r.settings.withinMin);
  sel.disabled = !r.settings.on;
}
async function saveSettings() {
  const on = $('#cnt-on').checked;
  const r = await ctx.api('/continue-here/settings', { method: 'PUT', body: { on, withinMin: Number($('#cnt-within').value) || 30 } }).catch(() => null);
  if (r) $('#cnt-within').disabled = !r.settings.on;
  const st = $('#cnt-status');
  if (st) st.textContent = r ? (r.settings.on ? t('Saved.') : t('Off. Where each device was is forgotten.')) : t('Could not save.');
}

/** For tests and the live check. */
export const _shown = () => shown;
