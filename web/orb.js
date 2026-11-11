// V4b (docs/ops/V4_DESIGN.md → Living parts): her presence orb. A glass sphere drawn on a canvas in
// every `.v4-orb[data-orb-size]` mount (chat header, sidebar brand, her message avatar, call screen,
// worker rows). Four states, each from a real signal and nothing else:
//   idle       nothing is happening
//   listening  a microphone is open (push to talk, a call, Hey Sara): ripples and a waveform that
//              follows the mic level when we have it (a gentle synthetic level otherwise)
//   thinking   a turn is streaming or a tool step is running: swirling filaments
//   speaking   her voice is playing (TTS or a live call): a bright ring that pulses
// Colours follow the user's accent (--acc-h/--acc-s/--acc-l when the V4 palette sets them, else the
// palette's --accent-solid), re-read when the page's theme changes. ≤ 30 fps, devicePixelRatio aware,
// paused when the tab is hidden or the orb is off screen (IntersectionObserver); reduced motion
// (the system setting or Sara's own) draws one still frame per state. role=img with
// "<her name>: <state>" (t() swaps in her chosen name).
import { t } from './naming.js';

export const ORB_STATES = ['idle', 'listening', 'thinking', 'speaking'];
const STATE_WORDS = { idle: () => t('here'), listening: () => t('listening'), thinking: () => t('thinking'), speaking: () => t('speaking') };
const THINKING = new Set(['thinking', 'writing', 'running', 'waiting', 'answering']);
const LISTENING = new Set(['listening', 'hearing']);

/** The signals the orb reads (pure state; app.js feeds it through orbSignal()). */
export const newSignals = () => ({ activity: '', speaking: false, mic: false, level: 0, levelAt: 0 });

/** One signal event → the next signals (pure: tests replay recorded event streams through it). */
export function reduceSignal(sig, ev) {
  const s = { ...sig };
  if (!ev || typeof ev !== 'object') return s;
  if (ev.type === 'activity') s.activity = typeof ev.status === 'string' ? ev.status : '';
  else if (ev.type === 'speaking') s.speaking = Boolean(ev.on);
  else if (ev.type === 'mic') {
    s.mic = Boolean(ev.on);
    if (!s.mic) s.level = 0;
  } else if (ev.type === 'level' && Number.isFinite(ev.value)) {
    s.level = Math.max(0, Math.min(1, ev.value));
    s.levelAt = Number.isFinite(ev.at) ? ev.at : Date.now();
  }
  return s;
}

/** Signals → one of the four states. Her voice wins, then an open mic, then work, else idle. */
export function orbState(sig) {
  if (sig?.speaking) return 'speaking';
  if (sig?.mic || LISTENING.has(sig?.activity)) return 'listening';
  if (THINKING.has(sig?.activity)) return 'thinking';
  return 'idle';
}

/** The level the waveform uses: the real mic level if it is fresh (< 400 ms), else synthetic. */
export function voiceLevel(sig, now, tick = now) {
  if (sig.levelAt && now - sig.levelAt < 400) return Math.min(1, Math.sqrt(sig.level) * 2.2);
  return 0.4 + 0.6 * Math.abs(Math.sin(tick / 230) * Math.sin(tick / 97));
}

export const orbLabel = (state, name = '') => {
  const words = (STATE_WORDS[state] ?? STATE_WORDS.idle)();
  return `${name || t('Sara')}: ${words}`;
};

const isReduced = () => {
  const root = document.documentElement;
  return root.dataset.motion === 'off' || root.classList.contains('reduce-motion') || Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
};

// ---------- colour ----------
let accent = { h: 218, s: 76, l: 53 };
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
/** Reads the accent from CSS: V4's --acc-h/s/l, else the computed --accent-solid colour. */
export function readAccent(style = getComputedStyle(document.documentElement)) {
  const h = parseFloat(style.getPropertyValue('--acc-h'));
  const s = parseFloat(style.getPropertyValue('--acc-s'));
  const l = parseFloat(style.getPropertyValue('--acc-l'));
  if (Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l)) return { h, s, l };
  const raw = style.getPropertyValue('--accent-solid').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex) return rgbToHsl(parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16));
  const rgb = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(raw);
  if (rgb) return rgbToHsl(+rgb[1], +rgb[2], +rgb[3]);
  return { h: 218, s: 76, l: 53 };
}
const acc = (a, dh = 0, l = null) => `hsl(${accent.h + dh} ${accent.s}% ${l ?? Math.max(55, accent.l + 8)}% / ${a})`;

// ---------- drawing (the approved mockup's drawOrb, per orb, in device pixels) ----------
function drawOrb(o, st, tick, motion, level) {
  const { ctx, W } = o;
  const R = W / 2;
  const big = o.css >= 28;
  const small = o.css < 48;
  const m = motion ? 1 : 0;
  ctx.clearRect(0, 0, W, W);
  const breath = 1 + m * (st === 'idle' ? 0.03 * Math.sin(tick / 900) : st === 'speaking' ? 0.05 * Math.abs(Math.sin(tick / 160)) : 0.015 * Math.sin(tick / 500));
  // Small mounts (avatars, the header): a larger body and a softer halo, so the glass reads.
  const r = R * (small ? 0.78 : 0.62) * breath;
  const g = ctx.createRadialGradient(R, R, r * 0.2, R, R, R);
  g.addColorStop(0, acc(0.35));
  g.addColorStop(0.6, acc(0.12));
  g.addColorStop(1, acc(0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(R, R, R, 0, Math.PI * 2);
  ctx.fill();
  if (st === 'listening' && big) {
    for (let i = 0; i < 3; i++) {
      const p = (motion ? tick / 1400 + i / 3 : 0.2 + i / 3.5) % 1;
      ctx.strokeStyle = acc(0.5 * (1 - p));
      ctx.lineWidth = Math.max(1, W / 80);
      ctx.beginPath();
      ctx.arc(R, R, r + p * (R - r), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const body = ctx.createRadialGradient(R - r * 0.35, R - r * 0.45, r * 0.1, R, R, r);
  body.addColorStop(0, 'rgba(255,255,255,.22)');
  body.addColorStop(0.35, acc(0.18));
  body.addColorStop(1, 'rgba(10,12,16,.85)');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(R, R, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(R, R, r * 0.98, 0, Math.PI * 2);
  ctx.clip();
  const core = ctx.createRadialGradient(R, R + r * 0.25, 0, R, R + r * 0.25, r * 0.9);
  core.addColorStop(0, acc(0.95, 0, 72));
  core.addColorStop(0.4, acc(0.4));
  core.addColorStop(1, acc(0));
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, W, W);
  if (st === 'thinking') {
    ctx.globalCompositeOperation = 'lighter';
    const strands = small ? 3 : 7;
    for (let k = 0; k < strands; k++) {
      const a0 = small ? 0.38 : 0.28 + 0.06 * (k % 3);
      ctx.strokeStyle = k % 2 ? acc(a0, 38, 70) : acc(a0 + 0.08);
      ctx.lineWidth = Math.max(1, W / (small ? 80 : 120));
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 2.2; a += 0.08) {
        const rr = (a / (Math.PI * 2.2)) * r * 0.92;
        const ang = a + (tick / (700 + k * 140)) * m + k * (small ? 2.1 : 0.9);
        const x = R + Math.cos(ang) * rr;
        const y = R + Math.sin(ang) * rr * 0.85;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  if (st === 'listening') {
    o.voice += ((motion ? level : 0.6) - o.voice) * 0.2;
    ctx.strokeStyle = acc(0.95, 0, 80);
    ctx.lineWidth = Math.max(1, W / 60);
    const n = big ? 15 : 7;
    for (let i = 0; i < n; i++) {
      const x = R - r * 0.7 + (i / (n - 1)) * r * 1.4;
      const env = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
      const h = r * 0.65 * env * o.voice * (motion ? 0.5 + 0.5 * Math.abs(Math.sin(tick / 120 + i * 1.7)) : 0.7) + r * 0.05;
      ctx.beginPath();
      ctx.moveTo(x, R - h);
      ctx.lineTo(x, R + h);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.strokeStyle = small ? acc(0.55, 0, 75) : 'rgba(255,255,255,.22)';
  ctx.lineWidth = Math.max(small ? 1 : 0.6, W / 100);
  ctx.beginPath();
  ctx.arc(R, R, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath();
  ctx.ellipse(R - r * 0.32, R - r * 0.5, r * 0.32, r * 0.14, -0.5, 0, Math.PI * 2);
  ctx.fill();
  if (st === 'speaking') {
    ctx.strokeStyle = acc(0.85, 0, 82);
    ctx.lineWidth = Math.max(1, W / 70);
    ctx.beginPath();
    ctx.ellipse(R, R + r * 0.1, Math.min(R * 0.98, r * 1.32 * breath), r * 0.34 * breath, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- mounts and the shared loop ----------
let signals = newSignals();
const orbs = new Set();
let io = null;
let ro = null;
let raf = 0;
let lastFrame = 0;
let shownState = '';
const FRAME_MS = 1000 / 30;

function stateOf(o) {
  const own = o.el.dataset.orbState;
  return ORB_STATES.includes(own) ? own : orbState(signals);
}

function sizeOrb(o) {
  // The width comes from the ResizeObserver (docs/PERFORMANCE.md: no layout read in the frame loop).
  const css = Math.round(o.box || Number(o.el.dataset.orbSize) || 28);
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const W = Math.max(8, Math.round(css * dpr));
  if (o.W === W && o.css === css) return;
  o.css = css;
  o.W = W;
  o.canvas.width = W;
  o.canvas.height = W;
}

function label(o) {
  const text = orbLabel(stateOf(o), o.el.dataset.orbName ?? '');
  if (o.el.getAttribute('aria-label') !== text) o.el.setAttribute('aria-label', text);
  const st = stateOf(o);
  if (o.el.dataset.orbNow !== st) o.el.dataset.orbNow = st;
}

/** The newest face in the chat (orbs mount in page order, so the last connected one). */
function latestMsgOrb() {
  let last = null;
  for (const o of orbs) if (o.msg && o.el.isConnected) last = o;
  return last;
}
/** docs/PERFORMANCE.md: only her live faces move; earlier replies' faces hold one still frame. */
const stillOrb = (o, latest) => o.msg && o !== latest;

function paint(now, force = false) {
  const reduced = isReduced();
  const level = voiceLevel(signals, Date.now(), now);
  const latest = latestMsgOrb();
  for (const o of orbs) {
    if (!o.el.isConnected) {
      unmount(o);
      continue;
    }
    if (!force && !o.visible) continue;
    const st = stateOf(o);
    const motion = !reduced && !stillOrb(o, latest);
    // Reduced motion (and earlier replies): one still frame per state (and per resize/recolour).
    if (!motion && !force && !o.live && o.drawn === st && o.drawnW === o.W) continue;
    sizeOrb(o);
    drawOrb(o, st, motion ? now : 0, motion, level);
    o.drawn = st;
    o.drawnW = o.W;
    o.live = motion;
  }
}

function loop(now) {
  raf = 0;
  if (document.hidden) return;
  if (now - lastFrame >= FRAME_MS) {
    lastFrame = now;
    paint(now);
  }
  const latest = latestMsgOrb();
  if (!isReduced() && [...orbs].some((o) => o.visible && !stillOrb(o, latest))) raf = requestAnimationFrame(loop);
}
function kick() {
  if (!raf && !document.hidden && !isReduced()) raf = requestAnimationFrame(loop);
}

function unmount(o) {
  io?.unobserve(o.el);
  ro?.unobserve(o.el);
  orbs.delete(o);
}

/** Mounts every `.v4-orb[data-orb-size]` under `root` that has no canvas yet (safe to call often). */
export function mountOrbs(root = document) {
  const list = root instanceof Element && root.matches('.v4-orb[data-orb-size]') ? [root] : [...(root.querySelectorAll?.('.v4-orb[data-orb-size]') ?? [])];
  for (const el of list) {
    if (el._orb) continue;
    const canvas = document.createElement('canvas');
    canvas.className = 'v4-orb-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    el.replaceChildren(canvas);
    el.setAttribute('role', 'img');
    const o = { el, canvas, ctx: canvas.getContext('2d'), W: 0, css: 0, box: 0, msg: Boolean(el.closest?.('#messages')), voice: 0, visible: !io, drawn: '' };
    if (!o.ctx) continue;
    el._orb = o;
    orbs.add(o);
    io?.observe(el);
    ro?.observe(el);
    sizeOrb(o);
    label(o);
    drawOrb(o, stateOf(o), 0, false, 0.6);
  }
  kick();
}

/** Feeds a signal ({type:'activity'|'speaking'|'mic'|'level', …}); relabels and wakes the loop. */
export function orbSignal(ev) {
  signals = reduceSignal(signals, ev);
  const now = orbState(signals);
  if (now !== shownState || ev?.type !== 'level') {
    shownState = now;
    const root = document.documentElement;
    if (root.dataset.herState !== now) root.dataset.herState = now;
    for (const o of orbs) label(o);
    if (isReduced()) paint(performance.now(), true);
  }
  kick();
}
export const currentOrbState = () => orbState(signals);

/** Starts the orbs: mounts, watches new mounts, visibility, theme and accent changes. */
export function initOrbs() {
  accent = readAccent();
  if ('IntersectionObserver' in globalThis) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target._orb) e.target._orb.visible = e.isIntersecting;
      kick();
    });
  }
  if ('ResizeObserver' in globalThis) {
    ro = new ResizeObserver((entries) => {
      for (const e of entries) if (e.target._orb) e.target._orb.box = e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width;
      kick();
    });
  }
  mountOrbs(document);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches?.('.v4-orb') || n.querySelector?.('.v4-orb'))) mountOrbs(n);
  }).observe(document.body, { childList: true, subtree: true });
  // The accent or theme changed (Appearance writes on <html>): recolour, redraw still frames.
  const recolourNow = () => {
    const next = readAccent();
    if (next.h === accent.h && next.s === accent.s && next.l === accent.l) return;
    accent = next;
    paint(performance.now(), true);
  };
  // Once a frame at most: each read of the computed style forced the page's style work mid-turn.
  let recolourQueued = false;
  const recolour = () => {
    if (typeof requestAnimationFrame !== 'function') return recolourNow();
    if (recolourQueued) return;
    recolourQueued = true;
    requestAnimationFrame(() => {
      recolourQueued = false;
      recolourNow();
    });
  };
  // Only what can change the colour (her state and busy flags change often and never recolour).
  new MutationObserver(recolour).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-palette', 'data-accent'] });
  new MutationObserver(recolour).observe(document.head, { childList: true, subtree: true, attributes: true });
  addEventListener('sara-accent', recolour);
  document.addEventListener('visibilitychange', kick);
  // She was renamed (Settings → Name, web/naming.js): every label says her new name at once.
  document.addEventListener('sara-identity', () => {
    for (const o of orbs) label(o);
  });
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => {
    paint(performance.now(), true);
    kick();
  });
  addEventListener('resize', () => paint(performance.now(), true));
  // Push to talk / call mics publish their level (web/voice.js Mic).
  addEventListener('sara-mic-level', (e) => orbSignal({ type: 'level', value: Number(e.detail) || 0 }));
}

/** A small orb mount (a span the loop finds); `state` pins it (worker rows), else it follows her. */
export function orbMount(size, { state, cls = '', name = '' } = {}) {
  const span = document.createElement('span');
  span.className = `v4-orb${cls ? ` ${cls}` : ''}`;
  span.dataset.orbSize = String(size);
  if (state) span.dataset.orbState = state;
  if (name) span.dataset.orbName = name;
  return span;
}
