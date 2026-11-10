// A1 (docs/ops/A1_AVATAR_DESIGN.md): her living picture everywhere in the new look. One "brain" (the
// rig: state and mood → eyes, gaze, brows, blinks, head, breath; her voice → mouth) drives every
// visible mount: the chat header and sidebar faces (tiny: breathe and blink), her panel, Today's hero,
// her page and the call screen (web/presence.js hands its root over). Each mount is a WebGL canvas over
// its picture (web/avatar-gl.js); the picture underneath keeps the V4d ring. One loop, ≤ 30 fps, only
// while a mount is on screen and the tab is visible; reduced motion or Background motion Off draw one
// still frame; no WebGL leaves the still picture. The 3D route (a .vrm brought by the owner) is loaded
// with import() only when chosen (web/avatar-vrm.js).
import { LivingFace } from './avatar-gl.js';
import { MouthShaper, soundFeatures } from './mouth.js';
import { avatarMotion, easeRig, faceCrop, fitRegions, frameMix, jawOpen, lidAt, mountTier, nextBlinkMs, rigTargets, tierLimits } from './avatar-rig.js';
import { currentTap } from './voice-tap.js';

export const FRAME_MS = 1000 / 30;
const root = globalThis.document?.documentElement;
const reduceQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

// ---------- what to show ----------
// motion: 'rig' | 'warp' | 'breathe' | 'vrm' | null (off: the still picture / the orb)
let config = { motion: null, expression: 'default', custom: null, version: '', fit: null };
let faceJson; // the built-in look's landmarks (web/sara/face.json), null for a custom look
const loadFaceJson = () =>
  (faceJson ??= fetch(`/sara/face.json${config.version}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null));

/** app.js: what her picture is now (Settings → Appearance → Her picture, her mood, the look). */
export function configureAvatar(next) {
  const prev = config;
  config = { ...config, ...next };
  if (next.version !== undefined && next.version !== prev.version) faceJson = undefined;
  if (config.motion !== 'vrm' && vrm) closeVrm();
  for (const m of mounts) m.refresh();
  if (config.motion === 'vrm') void openVrm();
  kick();
}
export const avatarConfig = () => config;

/** The picture set for an expression (or your picture). */
function picturesFor(x, motion) {
  if (motion === 'warp' || motion === 'breathe') return config.custom ? { base: config.custom } : null;
  const v = config.version;
  const base = x === 'default' ? `/sara-portrait.jpg${v}` : `/sara/portrait-${x}.jpg${v}`;
  const f = (n) => `/sara/frames/${x}-${n}.jpg${v}`;
  return { base, blink: f('blink'), half: f('half'), oo: f('oo'), ee: f('ee'), talk: f('talk') };
}
async function regionsFor(x, motion) {
  if (motion === 'warp') return fitRegions(config.fit);
  if (motion === 'breathe') return null;
  const j = await loadFaceJson();
  return j?.[x] ? fitRegions(j[x]) : null; // null: found from the frames
}

// ---------- the brain ----------
const brain = {
  cur: rigTargets('idle', 'default'),
  blinkAt: 0,
  blinkStart: -1e9,
  double: false,
  glanceAt: 0,
  glance: null,
  shaper: new MouthShaper({ calm: false }),
  level: 0,
  jaw: 0,
  nod: 0,
  phase: Math.random() * 10,
  out: null,
  data: null,
  freq: null,
  analyser: null,
};
let override = null; // a live call's analyser (web/presence.js listen())
export function avatarListen(analyser) {
  override = analyser ?? null;
}

function sound() {
  const an = override ?? currentTap()?.analyser ?? null;
  if (!an) return null;
  if (brain.analyser !== an) {
    brain.analyser = an;
    brain.data = new Uint8Array(an.fftSize);
    brain.freq = new Uint8Array(an.frequencyBinCount);
  }
  an.getByteTimeDomainData(brain.data);
  an.getByteFrequencyData(brain.freq);
  return soundFeatures(brain.data, brain.freq, an.context.sampleRate / an.fftSize);
}

/** One step of the rig: everything every mount needs this frame. */
function think(now, dt) {
  const state = root?.dataset.herState || 'idle';
  const mood = config.expression || 'default';
  const target = rigTargets(state, mood);
  brain.cur = easeRig(brain.cur, target, dt);
  const c = brain.cur;
  let s = sound();
  // Speaking with no way to hear her (no Web Audio tap yet, a phone's native call): a gentle mouth.
  if ((!s || s.level < 0.005) && state === 'speaking' && !brain.heard) {
    const t = now / 1000;
    s = { level: 0.05 + 0.06 * Math.abs(Math.sin(t * 8.3) * Math.sin(t * 3.1)), centroid: 1300 + 500 * Math.sin(t * 2.3), low: 0.3, high: 0.05 };
  }
  if (s && s.level > 0.03) brain.heard = now;
  if (brain.heard && now - brain.heard > 4000) brain.heard = 0;
  s ??= { level: 0, centroid: -1, low: 0, high: 0 };
  brain.level += (s.level - brain.level) * Math.min(1, (s.level > brain.level ? 20 : 7) * dt);
  const step = (jawOpen(brain.level) - brain.jaw) * Math.min(1, 14 * dt);
  brain.jaw += Math.max(-5 * dt, Math.min(5 * dt, step));
  const w = brain.shaper.update(s, dt);
  const mix = frameMix(w, Math.min(1, brain.jaw / 0.3), Math.min(1, brain.level / 0.05));
  const talking = brain.level > 0.03;
  // Blinks: on her rhythm; while she talks, only in the pauses. Sometimes a double blink.
  if (!brain.blinkAt) brain.blinkAt = now + nextBlinkMs(c, Math.random());
  if (now >= brain.blinkAt && !talking) {
    brain.blinkStart = now;
    brain.double = Math.random() < 0.15;
    brain.blinkAt = now + nextBlinkMs(c, Math.random());
  }
  let blink = lidAt(now - brain.blinkStart, c.lidMs);
  if (brain.double) blink = Math.max(blink, lidAt(now - brain.blinkStart - c.lidMs - 120, c.lidMs * 0.9));
  // Glances: now and then she looks aside or tilts her head, eased in, held, eased out.
  if (!brain.glanceAt) brain.glanceAt = now + (5000 + Math.random() * 8000) / Math.max(0.1, c.glance);
  if (!brain.glance && now >= brain.glanceAt && !talking && c.glance > 0.25) brain.glance = { at: now, dir: Math.random() < 0.5 ? -1 : 1, kind: Math.random() < 0.6 ? 'look' : 'tilt', up: (Math.random() - 0.6) * 0.5 };
  let gx = 0;
  let gy = 0;
  let gTilt = 0;
  if (brain.glance) {
    const p = (now - brain.glance.at) / 2400;
    if (p >= 1) {
      brain.glance = null;
      brain.glanceAt = now + (7000 + Math.random() * 9000) / Math.max(0.1, c.glance);
    } else {
      const e = Math.sin(Math.PI * Math.min(1, p * 1.2)) ** 2;
      if (brain.glance.kind === 'look') [gx, gy] = [0.8 * e * brain.glance.dir, brain.glance.up * e];
      else gTilt = 1.6 * e * brain.glance.dir;
    }
  }
  const t = now / 1000 + brain.phase;
  brain.nod += (Math.min(1, brain.level * 8) - brain.nod) * Math.min(1, 4 * dt);
  const tilt = c.tilt + gTilt + 0.45 * Math.sin(t * 0.37) + 0.2 * Math.sin(t * 0.91) + 0.5 * brain.nod * Math.sin(t * 1.9);
  brain.out = {
    tilt,
    headX: gx * 0.03,
    headY: 0.012 * Math.sin(t * 0.53) + 0.035 * brain.nod * (0.5 + 0.5 * Math.sin(t * 3.1)),
    breath: c.breath * Math.sin(t * Math.PI * 2 * c.breathRate),
    gazeX: Math.max(-0.7, Math.min(0.7, (c.gazeX + gx) * 1.4)),
    gazeY: Math.max(-0.8, Math.min(0.6, (c.gazeY + gy) * 1.4)),
    brow: c.brow + Math.min(0.3, brain.level * 2) * (state === 'speaking' ? 1 : 0),
    eyes: c.eyes,
    squint: c.squint,
    blink,
    mix,
    jaw: brain.jaw,
    dt,
  };
  return brain.out;
}

const STILL = { tilt: 0, headX: 0, headY: 0, breath: 0, gazeX: 0, gazeY: 0, brow: 0, eyes: 1, squint: 0, blink: 0, jaw: 0, dt: 1, mix: frameMix({}, 0, 0) };

// ---------- mounts ----------
const mounts = new Set();
let io = null;

class Mount {
  /** @param {HTMLElement} host  @param {HTMLElement|null} over  the picture the canvas covers (null: fill the host) */
  constructor(host, over, { tier = null, cover = false } = {}) {
    this.host = host;
    this.over = over;
    this.fixedTier = tier;
    this.cover = cover;
    this.expression = null; // a cue overrides her mood here (the call screen)
    this.visible = !io;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'living-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.append(this.canvas);
    this.face = null;
    this.drawnStill = '';
    io?.observe(host);
    mounts.add(this);
  }

  get tier() {
    return this.fixedTier ?? mountTier(this.box().w);
  }

  box() {
    const el = this.over ?? this.host;
    return { x: this.over ? this.over.offsetLeft : 0, y: this.over ? this.over.offsetTop : 0, w: el.offsetWidth, h: el.offsetHeight };
  }

  /** The motion this mount shows (tiny mounts never host a 3D model: they show her portrait still). */
  motion() {
    const m = config.motion;
    if (m === 'vrm') return vrmHost === this ? 'vrm' : vrmSnapshot ? 'snapshot' : 'rig';
    return m;
  }

  refresh() {
    this.key = undefined;
    this.drawnStill = '';
    if (!config.motion) this.release();
  }

  release() {
    this.face?.destroy();
    this.face = null;
    this.canvas.hidden = true;
    this.host.classList.remove('living-on');
    this.key = undefined;
  }

  async ensure() {
    const motion = this.motion();
    if (!motion || motion === 'vrm') {
      if (this.face) this.release();
      return false;
    }
    const x = this.expression ?? config.expression ?? 'default';
    const pics = motion === 'snapshot' ? { base: vrmSnapshot } : picturesFor(x, motion);
    if (!pics) return false;
    const key = JSON.stringify([motion, x, pics.base, config.fit]);
    if (key === this.key) return this.face?.ready;
    this.key = key;
    if (!this.face) {
      this.face = new LivingFace(this.canvas);
      if (!this.face.ok) return false;
      this.face.onLost = () => this.release();
    }
    const regions = motion === 'snapshot' ? null : await regionsFor(x, motion);
    if (this.key !== key || !this.face) return false;
    const ok = await this.face.setPictures(pics, regions);
    this.drawnStill = '';
    return ok;
  }

  draw(p, still) {
    const face = this.face;
    if (!face?.ready) return;
    const b = this.box();
    if (!b.w || !b.h) return;
    Object.assign(this.canvas.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    face.resize(b.w, b.h);
    const tier = this.tier;
    const lim = tierLimits(tier);
    const motion = this.motion();
    const regions = face.regions ?? { eyes: { x: 50, y: 40 }, mouth: { x: 50, y: 56 } };
    const crop = this.cover ? faceCrop(regions, b.w / b.h, 'large') : face.regions ? faceCrop(regions, b.w / b.h, tier) : { x: 0, y: 0, w: 1, h: 1 };
    const q = still ? STILL : p;
    const ok = face.draw({
      ...q,
      crop,
      tilt: q.tilt * lim.head,
      headX: q.headX * lim.head,
      headY: q.headY * lim.head,
      breath: q.breath * lim.breath,
      gazeX: q.gazeX * lim.gaze,
      gazeY: q.gazeY * lim.gaze,
      brow: q.brow * lim.brow,
      mix: lim.mouth ? q.mix : STILL.mix,
      jaw: lim.mouth ? q.jaw : 0,
      warp: motion === 'warp',
      still: motion === 'breathe' || motion === 'snapshot',
    });
    if (ok && this.canvas.hidden) {
      this.canvas.hidden = false;
      this.host.classList.add('living-on');
    }
  }

  destroy() {
    this.release();
    io?.unobserve(this.host);
    this.canvas.remove();
    mounts.delete(this);
  }
}

/** Puts a living canvas over `over` inside `host` (or over the whole host). */
export function livingMount(host, over = null, opts = {}) {
  if (!host) return null;
  for (const m of mounts) if (m.host === host) return m;
  return new Mount(host, over, opts);
}

/**
 * web/presence.js delegate: her page and the call screen hand their root over while they run. Returns
 * true when the living portrait draws (else the old layers do).
 */
export function adoptPresence(presence) {
  let mount = null;
  presence.delegate = {
    start: () => {
      if (!config.motion || !webglOk()) return false;
      mount = livingMount(presence.root, null, { cover: presence.root.id === 'call-presence' });
      mount.expression = presence.expression && presence.expression !== config.expression ? presence.expression : null;
      kick();
      return true;
    },
    stop: () => {
      mount?.destroy();
      mount = null;
      override = null;
    },
    setExpression: (x) => {
      if (!mount) return;
      mount.expression = x && x !== config.expression ? x : null;
      mount.key = undefined;
      kick();
    },
    listen: (an) => avatarListen(an),
  };
}

let glOk;
function webglOk() {
  if (glOk === undefined) {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      glOk = Boolean(gl);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      glOk = false;
    }
  }
  return glOk;
}

// ---------- the loop ----------
let raf = 0;
let last = 0;
let lastThink = 0;
const motionNow = (visible = true) => avatarMotion({ motion: root?.dataset.motion ?? '', reduce: Boolean(reduceQuery?.matches) || root?.classList.contains('reduce-motion'), hidden: globalThis.document?.hidden, visible });

async function tick(now) {
  raf = 0;
  if (document.hidden || !config.motion) return;
  // On screen and actually shown (Today covers the chat with visibility: hidden, which the observer misses).
  const active = [...mounts].filter((m) => m.visible && m.host.isConnected && (m.host.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true));
  for (const m of [...mounts]) if (!m.host.isConnected) m.destroy();
  // Nothing shown: look again in a moment (a page opening on top doesn't tell us when it closes).
  if (!active.length && !vrm) return void (mounts.size && setTimeout(kick, 700));
  if (now - last >= FRAME_MS - 1) {
    const dt = Math.min(0.1, (now - (lastThink || now)) / 1000 || FRAME_MS / 1000);
    last = now;
    lastThink = now;
    const mode = motionNow();
    const p = think(now, dt);
    for (const m of active) {
      if (!(await m.ensure())) continue;
      if (mode === 'still') {
        const k = `${m.key}|${m.box().w}`;
        if (m.drawnStill === k) continue;
        m.drawnStill = k;
        m.draw(p, true);
      } else m.draw(p, false);
    }
    if (vrm && vrmHost?.visible) vrm.update(mode === 'still' ? STILL : p, { state: root?.dataset.herState || 'idle', mood: config.expression, dt, still: mode === 'still' });
    if (mode === 'still') return; // redrawn on the next change (kick)
  }
  raf = requestAnimationFrame((t) => void tick(t));
}
export function kick() {
  if (!raf && globalThis.document && !document.hidden) raf = requestAnimationFrame((t) => void tick(t));
}
export const livingMounts = () => [...mounts];

// ---------- the 3D model (lazy) ----------
let vrm = null;
let vrmHost = null;
let vrmSnapshot = null;
let vrmLoading = null;
async function openVrm() {
  if (vrm || vrmLoading) return vrmLoading;
  vrmLoading = (async () => {
    try {
      const mod = await import('./avatar-vrm.js');
      const stored = await mod.loadStoredVrm();
      if (!stored || config.motion !== 'vrm') return;
      vrm = await mod.VrmView.create(stored.bytes);
      placeVrm();
      vrmSnapshot = vrm.snapshot();
      for (const m of mounts) m.refresh();
      document.dispatchEvent(new CustomEvent('sara-vrm', { detail: { ok: true, meta: stored.meta } }));
    } catch (err) {
      vrm = null;
      document.dispatchEvent(new CustomEvent('sara-vrm', { detail: { ok: false, error: String(err?.message ?? err) } }));
    } finally {
      vrmLoading = null;
      kick();
    }
  })();
  return vrmLoading;
}
function closeVrm() {
  vrm?.destroy();
  vrm = null;
  vrmHost = null;
  vrmSnapshot = null;
}
/** The 3D model lives in the largest visible mount (the call, her page, Today, her panel). */
function placeVrm() {
  if (!vrm) return;
  const best = [...mounts].filter((m) => m.visible && m.host.isConnected && m.tier !== 'tiny').sort((a, b) => b.box().w - a.box().w)[0] ?? null;
  if (best === vrmHost) return;
  if (vrmHost) vrmHost.refresh();
  vrmHost = best;
  if (best) {
    best.release();
    vrm.mount(best.host, best.over);
    best.host.classList.add('living-on');
  } else vrm.unmount();
}
/** app.js: a new .vrm was chosen or removed: reload it. */
export function reloadVrm() {
  closeVrm();
  for (const m of mounts) m.refresh();
  if (config.motion === 'vrm') void openVrm();
}

// ---------- start ----------
/** Mounts the standard places (header, sidebar, Today, her panel) and starts watching. */
export function initAvatar() {
  if (!globalThis.document) return;
  if ('IntersectionObserver' in globalThis) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) for (const m of mounts) if (m.host === e.target) m.visible = e.isIntersecting;
      placeVrm();
      kick();
    });
  }
  const pairs = [
    ['#her-face', '#her-face > img.avatar'],
    ['#brand-today', '#brand-today > img.avatar'],
    ['#td-face-btn', '#td-face'],
    ['#hp-open-her', '#hp-portrait'],
  ];
  for (const [h, o] of pairs) {
    const host = document.querySelector(h);
    if (host) livingMount(host, document.querySelector(o));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastThink = 0;
      kick();
    }
  });
  // State changes (data-her-state), Background motion (data-motion), the palette: wake the loop.
  new MutationObserver(() => {
    for (const m of mounts) m.drawnStill = '';
    kick();
  }).observe(root, { attributes: true, attributeFilter: ['data-her-state', 'data-motion', 'class', 'data-palette'] });
  reduceQuery?.addEventListener?.('change', () => {
    for (const m of mounts) m.drawnStill = '';
    kick();
  });
  addEventListener('resize', () => {
    for (const m of mounts) m.drawnStill = '';
    placeVrm();
    kick();
  });
}
