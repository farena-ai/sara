// V4a (docs/ops/V4_DESIGN.md): the "living system" shell. Three parts, all from data the app already
// has (nothing invented, nothing shown when there is nothing):
//   - the live status strip at the top: workers running (C10, GET /api/workers), runs and research
//     that are going (GET /api/runs, GET /api/research), triggers armed (C4, GET /api/triggers), the
//     model answering this chat (its last reply's meta, live while she streams) and spend today
//     against the daily limit (C8, GET /api/spend). Each chip opens its page.
//   - At a glance in her panel (1180 px and wider): spend today with its line, workers, V4b's memory
//     slot, and today (tasks done, waiting on you, what a trigger is watching for).
//   - the ambient field behind the app: a few faint blobs of her accent's hue that drift faster while
//     she works. At most 30 frames a second on a quarter-size canvas, paused while the tab is hidden,
//     still with reduced motion or Settings → Appearance → Background motion: Off.
// The pure helpers (stripChips, glanceToday, sparkPath, fieldPlan, frameDue) have no DOM and are
// tested in Node (test/v4a-shell.test.ts). Owner-only routes answer 403 for household members: the
// chips and cards that need them simply stay hidden.
import { t } from './naming.js';
import { renderMemorySlot } from './memory-map.js';

const $ = (s) => document.querySelector(s);
const POLL_MS = 20_000;
const TODAY_MS = 60_000;
const GLANCE_KEY = 'sara.glance';

const money = (usd) => {
  const v = Number(usd) || 0;
  return `$${v < 10 ? v.toFixed(2) : v.toFixed(v < 100 ? 1 : 0)}`;
};
const ACTIVE_RESEARCH = new Set(['planning', 'running', 'writing']);
const RESEARCH_WORD = { planning: () => t('planning'), running: () => t('reading'), writing: () => t('writing') };

/**
 * The chips to show for what the routes returned (null = not available here). Order: workers, runs,
 * research, triggers, model, spend. Each: { key, live, warn, text, title, go }.
 */
export function stripChips(d) {
  const out = [];
  const workers = d.workers?.workers ?? [];
  const running = workers.filter((w) => w.running);
  if (running.length) {
    out.push({ key: 'workers', live: true, n: running.length, text: running.length === 1 ? t('One worker running') : t('{n} workers running', { n: running.length }), title: running.map((w) => `${w.name}: ${w.running.title ?? ''}`).join(' · '), go: 'team' });
  }
  const runs = (d.runs?.runs ?? []).filter((r) => r.status === 'running' && r.kind !== 'turn');
  if (runs.length) out.push({ key: 'runs', live: true, n: runs.length, text: runs.length === 1 ? t('One run going') : t('{n} runs going', { n: runs.length }), title: runs.map((r) => r.title).filter(Boolean).join(' · '), go: 'run', id: runs[0].id, conversationId: runs[0].conversationId ?? null });
  const research = (d.research?.runs ?? []).filter((r) => ACTIVE_RESEARCH.has(r.status));
  if (research.length === 1) out.push({ key: 'research', live: true, n: 1, text: t('Research · {what}', { what: (RESEARCH_WORD[research[0].status] ?? (() => research[0].status))() }), title: String(research[0].question ?? ''), go: 'research', id: research[0].id });
  else if (research.length > 1) out.push({ key: 'research', live: true, n: research.length, text: t('{n} research runs', { n: research.length }), title: research.map((r) => r.question).join(' · '), go: 'research' });
  const armed = (d.triggers?.triggers ?? []).filter((x) => x.state === 'on');
  if (armed.length) out.push({ key: 'triggers', live: false, n: armed.length, text: armed.length === 1 ? t('One trigger armed') : t('{n} triggers armed', { n: armed.length }), title: armed.map((x) => x.name).join(' · '), go: 'triggers' });
  if (d.model?.name) out.push({ key: 'model', live: Boolean(d.model.live), second: true, text: d.model.live ? t('{model} · answering', { model: d.model.name }) : d.model.name, title: d.model.provider ? `${d.model.name} · ${d.model.provider}` : d.model.name, go: 'model', raw: true });
  const sp = d.spend;
  if (sp) {
    const day = Number(sp.spent?.day) || 0;
    const limit = Number(sp.spend?.dayUsd) || 0;
    if (day > 0 || limit > 0) {
      out.push({ key: 'spend', live: false, ok: !limit || day < limit * 0.8, warn: limit > 0 && day >= limit * 0.8, text: limit ? t('{spent} of {limit} today', { spent: money(day), limit: money(limit) }) : t('{spent} today', { spent: money(day) }), title: t('Spend today against your daily limit'), go: 'spend' });
    }
  }
  return out;
}

/** The Today card's three lines from GET /api/today?parts=day,board,needs and the triggers. */
export function glanceToday(today, triggers) {
  const done = Number(today?.agenda?.doneToday) || 0;
  const waiting = (today?.needs?.approvals?.length ?? 0) + (today?.board?.waiting?.length ?? 0);
  const watch = (triggers?.triggers ?? []).find((x) => x.state === 'on');
  return { done, waiting, watching: watch ? watch.name : '' };
}

/** An SVG path (line, and the area under it) for a series in a 260 x 46 box. */
export function sparkPath(pts) {
  const v = (pts ?? []).map(Number).filter(Number.isFinite);
  if (v.length < 2) return null;
  const max = Math.max(...v), min = Math.min(...v);
  const P = v.map((y, i) => [(i / (v.length - 1)) * 260, 42 - ((y - min) / (max - min || 1)) * 36]);
  const line = P.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return { line, area: `${line} L260 46 L0 46 Z`, end: P.at(-1) };
}

/**
 * Whether the field animates and how fast. Hidden tab: nothing at all. Reduced motion, the
 * setting, Sara Classic or Reduced decoration: one still frame. Otherwise at most 30 fps (12 when
 * she is idle), speed from how busy she is (0 idle … 1 answering).
 */
export function fieldPlan({ hidden, reduced, motion, classic, decor, busy }) {
  if (hidden) return { run: false, still: false, fps: 0, speed: 0 };
  if (classic) return { run: false, still: false, fps: 0, speed: 0 };
  if (reduced || motion === 'off' || decor === 'off') return { run: false, still: true, fps: 0, speed: 0 };
  const b = Math.max(0, Math.min(1, Number(busy) || 0));
  return { run: true, still: false, fps: b > 0.5 ? 30 : b > 0.2 ? 20 : 12, speed: 0.25 + b * 0.75 };
}
/** A frame is due when enough time passed for the frame rate (never more than 30 a second). */
export const frameDue = (last, now, fps) => fps > 0 && now - last >= 1000 / Math.min(30, fps);

// ---------- the page ----------

const ui = { ctx: null, data: {}, today: null, todayAt: 0, timer: 0, kick: 0, busy: 0, field: null };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function fetchAll() {
  const c = ui.ctx;
  if (c.isMember?.() || c.demo?.()) return {};
  const get = (p) => c.api(p).catch(() => null);
  const [workers, runs, research, triggers, spend] = await Promise.all([get('/workers'), get('/runs?limit=20'), get('/research'), get('/triggers'), get('/spend')]);
  return { workers, runs, research, triggers, spend };
}

function modelNow() {
  const c = ui.ctx;
  const msgs = c.messages?.() ?? [];
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.meta?.model);
  const live = Boolean(c.streaming?.());
  if (last) return { name: last.meta.model, provider: last.meta.provider ?? '', live };
  const m = c.model?.();
  return m ? { ...m, live } : null;
}

function go(chip) {
  const c = ui.ctx;
  if (chip.go === 'team') return c.openTeam();
  if (chip.go === 'run') return chip.conversationId ? c.openConversation(chip.conversationId) : c.openRun?.(chip.id);
  if (chip.go === 'research') return c.openResearch(chip.id);
  if (chip.go === 'triggers') return c.openSettings('co-hooks');
  if (chip.go === 'model') return c.openSettings('models-routes');
  if (chip.go === 'spend') return c.openSettings('dh-usage');
}

function renderStrip() {
  const host = $('#v4-chips');
  if (!host) return;
  const chips = stripChips({ ...ui.data, model: modelNow() });
  host.replaceChildren(
    ...chips.map((ch) => {
      const b = el('button', `v4-chip${ch.live ? ' live' : ''}${ch.ok ? ' ok' : ''}${ch.warn ? ' warn' : ''}${ch.second ? ' second' : ''}`);
      b.type = 'button';
      b.dataset.chip = ch.key;
      b.setAttribute('role', 'listitem');
      if (ch.title) b.title = ch.title;
      const dot = el('span', 'v4-dot');
      dot.setAttribute('aria-hidden', 'true');
      const words = el('span', 'v4-chip-t num', ch.text);
      if (ch.raw) words.dataset.raw = '';
      b.append(dot, words);
      b.addEventListener('click', () => void go(ch));
      return b;
    }),
  );
  document.documentElement.classList.toggle('v4-has-chips', chips.length > 0);
  const live = chips.filter((c) => c.live && c.key !== 'model').length;
  ui.busy = ui.ctx.streaming?.() ? 1 : live ? 0.6 : 0.15;
  document.documentElement.dataset.busy = ui.busy >= 1 ? 'answering' : live ? 'working' : 'idle';
}

function renderGlance() {
  if (!$('#v4-glance')) return;
  const member = ui.ctx.isMember?.();
  const { spend, workers, triggers } = ui.data;
  // Spend today.
  $('#v4-g-spend').hidden = member || !spend;
  if (spend) {
    const day = Number(spend.spent?.day) || 0;
    const limit = Number(spend.spend?.dayUsd) || 0;
    $('#v4-g-spend-big').textContent = money(day);
    const saver = spend.saver?.on ? t('Token Saver on') : t('Token Saver off');
    $('#v4-g-spend-sub').textContent = `${limit ? t('of a {limit} daily limit', { limit: money(limit) }) : t('No daily limit set')} · ${saver}`;
    const sp = sparkPath(spend.hours);
    const host = $('#v4-g-spark');
    host.replaceChildren();
    if (sp && day > 0) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 260 46');
      svg.setAttribute('preserveAspectRatio', 'none');
      host.append(svg);
      const area = document.createElementNS(NS, 'path');
      area.setAttribute('d', sp.area);
      area.setAttribute('class', 'v4-spark-area');
      const line = document.createElementNS(NS, 'path');
      line.setAttribute('d', sp.line);
      line.setAttribute('class', 'v4-spark-line');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(area, line);
    }
    host.hidden = !(sp && day > 0);
  }
  // Workers.
  $('#v4-g-workers').hidden = member || !workers;
  const list = $('#v4-g-workers-list');
  if (workers && list) {
    const ws = (workers.workers ?? []).slice().sort((a, b) => Number(Boolean(b.running)) - Number(Boolean(a.running))).slice(0, 4);
    list.replaceChildren(
      ...(ws.length
        ? ws.map((w) => {
            const row = el('button', `v4-worker${w.running ? ' on' : ''}`);
            row.type = 'button';
            const orb = el('span', 'v4-orb');
            orb.dataset.orbSize = '16';
            orb.dataset.orbName = String(w.name ?? '');
            if (w.running) orb.dataset.orbState = 'thinking';
            const name = el('span', 'v4-worker-name', w.name);
            name.dataset.raw = '';
            const state = el('span', 'v4-muted num', w.running ? t('working') : w.queued ? t('{n} waiting', { n: w.queued }) : w.paused || w.state === 'paused' ? t('paused') : t('idle'));
            row.append(orb, name, state);
            if (w.running) {
              const bar = el('span', 'v4-bar');
              bar.append(el('i'));
              row.append(bar);
              row.title = String(w.running.title ?? '');
            }
            row.addEventListener('click', () => void ui.ctx.openTeam());
            return row;
          })
        : [el('p', 'v4-muted', t('No workers yet. In Team you can name helpers that keep going.'))]),
    );
  }
  // Today.
  const g = glanceToday(ui.today, triggers);
  const dl = $('#v4-g-today-list');
  if (dl) {
    const rows = [[t('Tasks done'), String(g.done)], [t('Waiting on you'), String(g.waiting)]];
    if (g.watching) rows.push([t('Watching for'), g.watching]);
    dl.replaceChildren(...rows.flatMap(([k, v], i) => {
      const dd = el('dd', i === 2 ? '' : 'num', v);
      if (i === 2) dd.dataset.raw = '';
      return [el('dt', '', k), dd];
    }));
  }
}

/** True when At a glance is on screen (wide side panel, unfolded, owner, not Classic). */
function glanceShown() {
  const g = $('#v4-glance');
  return Boolean(g && !ui.ctx?.isMember?.() && glanceOpen() && getComputedStyle(g).display !== 'none');
}
/**
 * One Today card: while At a glance shows, her panel's own Today list (the next three things) moves
 * into the glance's Today card under the counts, and the panel's Today section steps aside; it moves
 * back when the glance folds, the panel narrows or Classic is on. Nothing is lost either way.
 */
function placeToday() {
  const list = $('#hp-today-list');
  const sec = $('#hp-today');
  const card = $('#v4-g-today');
  if (!list || !sec || !card) return;
  const merged = glanceShown();
  if (merged && list.parentElement !== card) card.append(list);
  else if (!merged && list.parentElement !== sec) sec.append(list);
  sec.classList.toggle('v4-merged', merged);
  card.classList.toggle('v4-has-next', merged);
}
/** The panel's memory map: drawn when the glance shows (forced after a reply or a change). */
function memorySlot(force = false) {
  if (glanceShown() && ui.ctx?.panelOpen?.()) void renderMemorySlot({ force });
}

function glanceOpen() {
  return localStorage.getItem(GLANCE_KEY) !== 'closed';
}
function applyGlance() {
  const open = glanceOpen();
  $('#v4-glance-h')?.setAttribute('aria-expanded', String(open));
  const body = $('#v4-glance-body');
  if (body) body.hidden = !open;
  $('#v4-glance-btn')?.setAttribute('aria-pressed', String(open && Boolean(ui.ctx.panelOpen?.())));
  placeToday();
}

async function refresh() {
  if (!ui.ctx || document.hidden) return;
  ui.data = await fetchAll();
  if (Date.now() - ui.todayAt > TODAY_MS && glanceOpen() && !ui.ctx.isMember?.()) {
    ui.todayAt = Date.now();
    ui.today = await ui.ctx.api('/today?parts=day,board,needs').catch(() => null);
  }
  renderStrip();
  renderGlance();
  applyGlance();
  memorySlot(ui.forceMem);
  ui.forceMem = false;
}

/** Something changed (a reply started or ended, a worker or a run moved): refresh soon. */
export function v4Kick() {
  if (!ui.ctx) return;
  renderStrip();
  clearTimeout(ui.kick);
  ui.forceMem = true;
  ui.kick = setTimeout(() => void refresh(), 600);
}

// ---------- accent hue for a custom colour picked after the page loaded ----------
function hexHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  }
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}
function syncHue() {
  const root = document.documentElement;
  if (root.dataset.accent !== 'custom') {
    for (const p of ['--acc-h', '--acc-s', '--acc-l']) if (root.style.getPropertyValue(p)) root.style.removeProperty(p);
    return;
  }
  const hsl = hexHsl(root.style.getPropertyValue('--accent-solid'));
  if (!hsl) return;
  const want = [String(hsl[0]), `${hsl[1]}%`, `${hsl[2]}%`];
  ['--acc-h', '--acc-s', '--acc-l'].forEach((p, i) => {
    if (root.style.getPropertyValue(p) !== want[i]) root.style.setProperty(p, want[i]);
  });
}

// ---------- the ambient field ----------
function startField() {
  const cv = $('#v4-field');
  if (!cv?.getContext) return;
  const cx = cv.getContext('2d');
  const root = document.documentElement;
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  let hue = [218, 74, 53];
  let hueAt = 0;
  let last = 0;
  let raf = 0;
  let t0 = 0;
  const size = () => {
    cv.width = Math.max(1, Math.round(innerWidth / 4));
    cv.height = Math.max(1, Math.round(innerHeight / 4));
  };
  const readHue = (now) => {
    if (now - hueAt < 1000) return;
    hueAt = now;
    const cs = getComputedStyle(root);
    hue = [parseFloat(cs.getPropertyValue('--acc-h')) || 218, parseFloat(cs.getPropertyValue('--acc-s')) || 70, parseFloat(cs.getPropertyValue('--acc-l')) || 53];
  };
  const draw = (time, speed) => {
    const W = cv.width, H = cv.height;
    const light = root.dataset.theme === 'light';
    cx.clearRect(0, 0, W, H);
    const blobs = [[0.18, 0.22, 0], [0.8, 0.3, 38], [0.55, 0.88, -20]];
    blobs.forEach(([x, y, dh], i) => {
      const k = time * (0.6 + speed);
      const px = W * (x + 0.05 * Math.sin(k / 9000 + i * 2)), py = H * (y + 0.05 * Math.cos(k / 11000 + i));
      const g = cx.createRadialGradient(px, py, 0, px, py, W * 0.45);
      const a = (light ? 0.06 : 0.075) * (0.7 + speed * 0.5);
      g.addColorStop(0, `hsl(${hue[0] + dh} ${hue[1]}% ${Math.max(50, hue[2])}% / ${a.toFixed(3)})`);
      g.addColorStop(1, `hsl(${hue[0] + dh} ${hue[1]}% ${Math.max(50, hue[2])}% / 0)`);
      cx.fillStyle = g;
      cx.fillRect(0, 0, W, H);
    });
  };
  const plan = () => fieldPlan({ hidden: document.hidden, reduced: rm.matches, motion: root.dataset.motion, classic: root.dataset.palette === 'classic', decor: root.dataset.decor, busy: ui.busy });
  const loop = (now) => {
    raf = 0;
    const p = plan();
    if (!p.run) return void settle(p);
    if (frameDue(last, now, p.fps)) {
      // Time moves faster while she works (the drift speeds up, smoothly).
      t0 += (now - (last || now)) * p.speed * 4;
      last = now;
      readHue(now);
      draw(t0, p.speed);
    }
    raf = requestAnimationFrame(loop);
  };
  const settle = (p) => {
    if (p.still) {
      readHue(performance.now() + 2000);
      draw(t0, 0);
    } else if (!p.run) cx.clearRect(0, 0, cv.width, cv.height);
  };
  const wake = () => {
    const p = plan();
    if (p.run && !raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    } else if (!p.run) settle(p);
  };
  size();
  addEventListener('resize', () => {
    size();
    wake();
  });
  document.addEventListener('visibilitychange', wake);
  rm.addEventListener?.('change', wake);
  new MutationObserver(() => {
    hueAt = 0;
    syncHue();
    wake();
  }).observe(root, { attributes: true, attributeFilter: ['data-motion', 'data-palette', 'data-theme', 'data-accent', 'data-decor', 'data-busy', 'style'] });
  ui.field = { wake };
  wake();
}

/**
 * ctx: { api, isMember, demo, messages, conv, streaming, panelOpen, openPanel, openTeam,
 * openResearch, openConversation, openRun, openSettings, openSara, openPlanner, openMemory,
 * openCommandBar }.
 */
export function initV4(ctx) {
  ui.ctx = ctx;
  $('#v4-cmd')?.addEventListener('click', () => ctx.openCommandBar());
  $('#v4-settings')?.addEventListener('click', () => ctx.openSettings());
  $('#v4-word')?.addEventListener('click', () => ctx.openSara());
  $('#v4-g-spend-go')?.addEventListener('click', () => ctx.openSettings('dh-usage'));
  $('#v4-g-workers-go')?.addEventListener('click', () => ctx.openTeam());
  $('#v4-g-mem-go')?.addEventListener('click', () => ctx.openMemory());
  $('#v4-g-today-go')?.addEventListener('click', () => ctx.openPlanner());
  $('#v4-glance-h')?.addEventListener('click', () => {
    localStorage.setItem(GLANCE_KEY, glanceOpen() ? 'closed' : 'open');
    applyGlance();
    if (glanceOpen()) void refresh();
  });
  $('#v4-glance-btn')?.addEventListener('click', () => {
    if (!ctx.panelOpen?.()) {
      localStorage.setItem(GLANCE_KEY, 'open');
      ctx.openPanel?.();
    } else {
      localStorage.setItem(GLANCE_KEY, glanceOpen() ? 'closed' : 'open');
    }
    applyGlance();
    void refresh();
  });
  // Settings → Appearance → Background motion (this device).
  const sel = $('#ap-motion');
  if (sel) {
    sel.value = localStorage.getItem('sara.motion') === 'off' ? 'off' : 'on';
    sel.addEventListener('change', () => {
      localStorage.setItem('sara.motion', sel.value);
      document.documentElement.dataset.motion = sel.value;
    });
  }
  // A conversation opened (its title changed): the model chip follows it at once.
  const title = $('#chat-title');
  if (title) new MutationObserver(() => renderStrip()).observe(title, { childList: true, characterData: true, subtree: true });
  // Her panel opened, changed mode (side, overlay, sheet) or the window crossed 1180 px: one Today
  // card, and the memory map is drawn now that it has a size.
  const panel = $('#her-panel');
  if (panel) {
    new MutationObserver(() => {
      placeToday();
      memorySlot();
    }).observe(panel, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
  globalThis.matchMedia?.('(min-width: 1180px)').addEventListener?.('change', () => placeToday());
  new MutationObserver(() => placeToday()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-palette'] });
  syncHue();
  applyGlance();
  startField();
  void refresh();
  ui.timer = setInterval(() => void refresh(), POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
}
