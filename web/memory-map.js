// V4b (docs/ops/V4_DESIGN.md → Memory map): what she remembers, drawn as a graph (GET
// /api/memories/map: this space's own notes, exactly like the Memory page; links from shared words,
// the same chat, replacements and the tidy's open contradictions; ≤ 150 notes, layout cached on the
// server). Fading notes are dimmer. Hover (or focus and arrow keys) shows a note; click or Enter
// opens it in Memory. Also a small live map in `#v4-mem-slot` when the V4 side panel has one.
// ≤ 30 fps, paused when hidden or off screen; reduced motion: no drift, one still frame.
import { t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
const KIND = { fact: () => t('About you'), date: () => t('Dates that matter'), reflection: () => t('Things she noticed'), summary: () => t('Conversation notes'), decision: () => t('Decided together'), promise: () => t('Promises'), milestone: () => t('Your story'), self: () => t('About Sara'), lesson: () => t('Lessons from her runs') };
const WHY = { words: () => t('shared words'), chat: () => t('same conversation'), replaced: () => t('replaced by'), contradicts: () => t('they disagree') };

const reduced = () => document.documentElement.dataset.motion === 'off' || Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
let deps = { api: async () => ({ nodes: [], links: [] }), openNote: () => {} };
let data = null;
let loading = null;

function colours() {
  const cs = getComputedStyle(document.documentElement);
  const h = parseFloat(cs.getPropertyValue('--acc-h'));
  const acc = Number.isFinite(h) ? `hsl(${h} ${cs.getPropertyValue('--acc-s').trim() || '76%'} 62%)` : cs.getPropertyValue('--accent-solid').trim() || '#6d8cff';
  const acc2 = Number.isFinite(h) ? `hsl(${h + 38} 70% 68%)` : cs.getPropertyValue('--accent-to').trim() || acc;
  return { acc, acc2, ink: cs.getPropertyValue('--text-2').trim() || '#b4b5bb', dim: cs.getPropertyValue('--text-3').trim() || '#8b8c94', line: cs.getPropertyValue('--hairline-strong').trim() || '#34353c', warn: cs.getPropertyValue('--warn').trim() || '#fbbf24' };
}

async function load(force = false) {
  if (data && !force) return data;
  loading ??= deps.api('/memories/map').then((d) => {
    data = { ...d, byId: new Map((d.nodes ?? []).map((n) => [n.id, n])) };
    return data;
  }).finally(() => {
    loading = null;
  });
  return loading;
}

/** One canvas view (the full map or the small panel map). */
class MapView {
  constructor(canvas, { interactive = false, onHover = () => {}, onOpen = () => {} } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.interactive = interactive;
    this.onHover = onHover;
    this.onOpen = onOpen;
    this.hover = null;
    this.focusAt = -1;
    this.visible = true;
    this.raf = 0;
    this.last = 0;
    this.drift = new Map();
    if ('IntersectionObserver' in globalThis) {
      new IntersectionObserver((es) => {
        this.visible = es.some((e) => e.isIntersecting);
        this.kick();
      }).observe(canvas);
    }
    if (interactive) this.#bind();
    document.addEventListener('visibilitychange', () => this.kick());
  }

  set(d) {
    this.d = d;
    this.drift = new Map((d?.nodes ?? []).map((n, i) => [n.id, i * 1.7]));
    this.kick(true);
  }

  #size() {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const w = Math.max(40, Math.round(this.c.clientWidth * dpr));
    const h = Math.max(40, Math.round(this.c.clientHeight * dpr));
    if (this.c.width !== w || this.c.height !== h) {
      this.c.width = w;
      this.c.height = h;
    }
    return dpr;
  }

  #xy(n, now) {
    const W = this.c.width;
    const H = this.c.height;
    const ph = this.drift.get(n.id) ?? 0;
    const m = reduced() ? 0 : 1;
    return [(n.x + m * 0.004 * Math.sin(now / 2400 + ph)) * W, (n.y + m * 0.004 * Math.cos(now / 2900 + ph)) * H];
  }

  #radius(n, dpr) {
    return (n.hub ? 7 : 3.6 + n.weight * 3) * dpr * (this.c.clientWidth < 400 ? 0.7 : 1);
  }

  draw(now = 0) {
    const { ctx } = this;
    const d = this.d;
    const dpr = this.#size();
    ctx.clearRect(0, 0, this.c.width, this.c.height);
    if (!d?.nodes?.length) return;
    const col = colours();
    const pos = new Map(d.nodes.map((n) => [n.id, this.#xy(n, now)]));
    const lit = this.hover ? new Set([this.hover.id, ...d.links.filter((l) => l.a === this.hover.id || l.b === this.hover.id).flatMap((l) => [l.a, l.b])]) : null;
    for (const l of d.links) {
      const a = pos.get(l.a);
      const b = pos.get(l.b);
      if (!a || !b) continue;
      const on = lit && lit.has(l.a) && lit.has(l.b);
      ctx.globalAlpha = lit ? (on ? 0.9 : 0.08) : l.why === 'contradicts' ? 0.7 : 0.18 + l.w * 0.3;
      ctx.strokeStyle = l.why === 'contradicts' ? col.warn : l.why === 'replaced' ? col.dim : on || d.byId.get(l.a)?.hub || d.byId.get(l.b)?.hub ? col.acc : col.ink;
      ctx.lineWidth = (l.why === 'words' ? 0.8 + l.w : 0.8) * dpr;
      ctx.setLineDash(l.why === 'replaced' || l.why === 'contradicts' ? [3 * dpr, 3 * dpr] : []);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    d.nodes.forEach((n, i) => {
      const [x, y] = pos.get(n.id);
      const r = this.#radius(n, dpr) * (n.hub && !reduced() ? 1 + 0.12 * Math.sin(now / 600 + i) : 1);
      const dimmed = lit && !lit.has(n.id);
      if (n.hub && !n.fading) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
        g.addColorStop(0, col.acc);
        g.addColorStop(1, 'transparent');
        ctx.globalAlpha = dimmed ? 0.1 : 0.35;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = dimmed ? 0.15 : n.fading ? 0.3 : 0.72 + n.weight * 0.28;
      ctx.fillStyle = n.fading ? col.dim : n.hub || n.pinned ? col.acc : i % 3 ? col.ink : col.acc2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (this.hover?.id === n.id || (this.focusAt >= 0 && d.nodes[this.focusAt]?.id === n.id)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col.acc;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, r + 4 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
  }

  kick(force = false) {
    if (force || reduced()) this.draw(performance.now());
    if (reduced() || this.raf || document.hidden || !this.visible || !this.c.isConnected) return;
    const loop = (now) => {
      this.raf = 0;
      if (document.hidden || !this.visible || !this.c.isConnected || reduced()) return;
      if (now - this.last >= 1000 / 30) {
        this.last = now;
        this.draw(now);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  #at(ev) {
    const d = this.d;
    if (!d?.nodes?.length) return null;
    const rect = this.c.getBoundingClientRect();
    const dpr = this.c.width / Math.max(1, rect.width);
    const px = (ev.clientX - rect.left) * dpr;
    const py = (ev.clientY - rect.top) * dpr;
    let best = null;
    let bestD = 14 * dpr;
    for (const n of d.nodes) {
      const [x, y] = this.#xy(n, performance.now());
      const dist = Math.hypot(x - px, y - py);
      if (dist < bestD) {
        bestD = dist;
        best = n;
      }
    }
    return best;
  }

  #bind() {
    const c = this.c;
    c.tabIndex = 0;
    c.addEventListener('pointermove', (e) => {
      const n = this.#at(e);
      if (n?.id === this.hover?.id) return;
      this.hover = n;
      c.classList.toggle('mm-pointer', Boolean(n));
      this.onHover(n, e);
      this.kick(true);
    });
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover(null);
      this.kick(true);
    });
    c.addEventListener('click', (e) => {
      const n = this.#at(e);
      if (n) this.onOpen(n);
    });
    // Keyboard: arrows move through the notes (in layout order), Enter opens one.
    c.addEventListener('keydown', (e) => {
      const nodes = this.d?.nodes ?? [];
      if (!nodes.length) return;
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        this.focusAt = (this.focusAt + step + nodes.length) % nodes.length;
        this.hover = nodes[this.focusAt];
        this.onHover(this.hover);
        this.kick(true);
      } else if (e.key === 'Enter' && this.hover) {
        e.preventDefault();
        this.onOpen(this.hover);
      }
    });
  }
}

let full = null;
let mini = null;

function fillCard(n) {
  const card = $('#mm-card');
  if (!card) return;
  if (!n) {
    card.hidden = true;
    return;
  }
  const links = (data?.links ?? []).filter((l) => l.a === n.id || l.b === n.id);
  const kinds = [...new Set(links.map((l) => WHY[l.why]?.() ?? l.why))];
  card.replaceChildren();
  const head = document.createElement('div');
  head.className = 'mm-card-head';
  head.textContent = [KIND[n.kind]?.() ?? n.kind, n.pinned ? t('pinned') : '', n.fading ? t('fading') : ''].filter(Boolean).join(' · ');
  const body = document.createElement('p');
  body.className = 'mm-card-text';
  body.textContent = n.text;
  const foot = document.createElement('div');
  foot.className = 'mm-card-foot muted small';
  foot.textContent = links.length ? `${links.length === 1 ? t('1 link') : t('{n} links', { n: links.length })}: ${kinds.join(', ')} · ${t('Click to open it in Memory')}` : t('Click to open it in Memory');
  card.append(head, body, foot);
  card.hidden = false;
}

function summary(d) {
  const parts = [d.capped ? t('Showing {shown} of {total} notes', { shown: d.shown, total: d.total }) : d.total === 1 ? t('1 note') : t('{n} notes', { n: d.total }), d.fading === 1 ? t('1 fading') : t('{n} fading', { n: d.fading }), d.links.length === 1 ? t('1 link') : t('{n} links', { n: d.links.length })];
  return parts.join(' · ');
}

/** Opens the full map (from the Memory page's "Memory map" button or the panel's small map). */
export async function openMemoryMap() {
  const dlg = $('#memmap');
  if (!dlg) return;
  $('#mm-status').textContent = t('Loading…');
  if (!dlg.open) dlg.showModal();
  try {
    const d = await load(true);
    $('#mm-status').textContent = d.nodes.length ? summary(d) : t('Nothing yet. Sara writes notes as you talk.');
    const canvas = $('#mm-canvas');
    canvas.setAttribute('aria-label', `${t('Memory map')}: ${summary(d)}. ${t('Use the arrow keys to go through the notes and Enter to open one.')}`);
    full ??= new MapView(canvas, { interactive: true, onHover: fillCard, onOpen: (n) => {
      dlg.close();
      deps.openNote(n.id);
    } });
    full.set(d);
    // Sized after the dialog lays out.
    requestAnimationFrame(() => full.kick(true));
  } catch (err) {
    $('#mm-status').textContent = err.message;
  }
}

/**
 * The small map in the V4 side panel (`#v4-mem-slot`), when the page has one. The slot stays empty
 * (and V4a's Memory card hidden) until there is at least one note. V4a calls it when the panel
 * shows, after a reply and when Memory closes; without `force` it re-reads at most once a minute.
 */
let slotAt = 0;
export async function renderMemorySlot({ force = false } = {}) {
  const slot = $('#v4-mem-slot');
  if (!slot) return;
  if (!force && slotAt && Date.now() - slotAt < 60_000) return void mini?.kick(true);
  slotAt = Date.now();
  let d = null;
  try {
    d = await load(true);
  } catch {
    /* the panel stays empty: Memory itself shows why */
  }
  if (!d?.nodes?.length) {
    slot.replaceChildren();
    mini = null;
    return;
  }
  let canvas = slot.querySelector('canvas.mm-mini');
  if (!canvas) {
    mini = null;
    canvas = document.createElement('canvas');
    canvas.className = 'mm-mini';
    canvas.setAttribute('role', 'button');
    canvas.tabIndex = 0;
    canvas.addEventListener('click', () => void openMemoryMap());
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void openMemoryMap();
      }
    });
    slot.replaceChildren(canvas);
  }
  canvas.setAttribute('aria-label', `${t('Open the memory map')}: ${summary(d)}`);
  mini ??= new MapView(canvas);
  mini.set(d);
}

/** Wires the map: `api` (the app's own), `openNote(id)` opens Memory on that note. */
export function initMemoryMap(d) {
  deps = { ...deps, ...d };
  $('#mem-map')?.addEventListener('click', () => void openMemoryMap());
  $('#memmap')?.addEventListener('close', () => fillCard(null));
  // Notes may have been added, pinned, archived or deleted in Memory: the panel map follows.
  $('#memory')?.addEventListener('close', () => void renderMemorySlot({ force: true }));
  addEventListener('resize', () => {
    full?.kick(true);
    mini?.kick(true);
  });
  void renderMemorySlot();
}
