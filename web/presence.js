// Sara's animated portrait (Phase 9): stacked frames of the same picture (base, eyes closed, mouth
// shapes) per expression. She breathes, blinks every few seconds, and while her voice plays the
// mouth follows the loudness of the audio (Web Audio analyser on the voice element). Phase 11: three
// mouth shapes ("ah", rounded "oo", wide "ee") picked from the sound's brightness, and a gentle
// head sway with small nods while talking (none when the system asks for reduced motion).
// Phase 63: nine mouth shapes (closed, pressed m/b/p, f/v, teeth s/z, half-open, "ah", wide "aa",
// rounded "oo", "ee") chosen from the sound (web/mouth.js) and drawn from the same frames: each shape
// is a frame, sometimes squeezed or stretched around the mouth (no new pictures needed, so custom
// looks get them too). Reduced motion: only closed / half / open, changing slowly.
// No external libraries; a custom uploaded picture just breathes and glows (no frames for it).

import { MouthShaper, soundFeatures } from './mouth.js';
import { voiceTap } from './voice-tap.js';

const EXPRESSIONS = ['default', 'happy', 'caring', 'sleepy', 'hurt', 'playful'];
const all = new Set();
let version = '';
/** After the owner changes the look: reload every portrait's pictures. */
export function setLookVersion(v) {
  version = `?v=${v}`;
  for (const p of all) {
    const [x, c] = [p.expression, p.custom];
    p.expression = null;
    p.setExpression(x, c);
  }
}

// Where the eyes and mouth are, found by comparing each frame with the face (blink differs at the
// eyes, talk at the mouth). Each frame is then shown only in its own soft-edged area, so a generated
// frame that also changed other details can't make the expression flicker. Cached per picture set.
const regionCache = new Map();
const FALLBACK = { eyes: { x: 50, y: 38, rx: 24, ry: 9 }, mouth: { x: 50, y: 63, rx: 13, ry: 8 } };

function pixels(src, n) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, n, n);
      try {
        resolve(g.getImageData(0, 0, n, n).data);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Area (percent of the picture) where `frame` differs most from `base`, optionally below a line. */
function changedArea(base, frame, n, minY = 0, maxY = n) {
  const d = new Float32Array(n * n);
  let sum = 0;
  let cnt = 0;
  for (let y = minY; y < maxY; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const v = Math.abs(base[i] - frame[i]) + Math.abs(base[i + 1] - frame[i + 1]) + Math.abs(base[i + 2] - frame[i + 2]);
      d[y * n + x] = v;
      sum += v;
      cnt++;
    }
  const mean = sum / cnt;
  let sq = 0;
  for (let y = minY; y < maxY; y++) for (let x = 0; x < n; x++) sq += (d[y * n + x] - mean) ** 2;
  const cut = mean + 2 * Math.sqrt(sq / cnt);
  const xs = [];
  const ys = [];
  for (let y = minY; y < maxY; y++)
    for (let x = 0; x < n; x++)
      if (d[y * n + x] > cut) {
        xs.push(x);
        ys.push(y);
      }
  if (xs.length < 6) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const [x0, x1, y0, y1] = [q(xs, 0.15), q(xs, 0.85), q(ys, 0.15), q(ys, 0.85)];
  return { x: ((x0 + x1) / 2 / n) * 100, y: ((y0 + y1) / 2 / n) * 100, rx: Math.max(6, ((x1 - x0) / 2 / n) * 100), ry: Math.max(4, ((y1 - y0) / 2 / n) * 100), bottom: y1 };
}

/** Eyes and mouth areas of a picture set (also used by the A1 living renderer, web/avatar-gl.js). */
export async function findRegions(base, blink, talk) {
  const key = `${base}|${blink}|${talk}`;
  if (!regionCache.has(key)) {
    regionCache.set(
      key,
      (async () => {
        const n = 96;
        const [b, k, t] = await Promise.all([pixels(base, n), pixels(blink, n), pixels(talk, n)]);
        if (!b || !k || !t) return FALLBACK;
        const found = changedArea(b, k, n, Math.floor(n * 0.1), Math.floor(n * 0.75));
        const eyes = found && found.rx < 30 && found.ry < 15 ? found : FALLBACK.eyes;
        // The mouth sits below the eyes, about one eye-span down, roughly under their middle.
        const span = Math.max(6, eyes.rx * 2);
        const top = Math.floor(((eyes.y + eyes.ry * 0.8) / 100) * n);
        const bottom = Math.min(n, Math.floor(((eyes.y + span * 1.6) / 100) * n));
        const m = changedArea(b, t, n, top, bottom);
        const guess = { x: eyes.x, y: eyes.y + span * 0.95, rx: span * 0.42, ry: span * 0.24 };
        const mouth = m && Math.abs(m.x - eyes.x) < span * 0.6 && m.rx < span * 0.9 && m.ry < span * 0.6 ? m : guess;
        return { eyes, mouth };
      })(),
    );
  }
  return regionCache.get(key);
}

/**
 * How each mouth shape is drawn: which frame, and how it is squeezed or stretched around the mouth
 * (sx/sy scale; oy moves the anchor: -1 = the upper lip, so a squeeze lifts the lower lip; grow = how far
 * around the mouth the frame shows, smaller for reshaped frames).
 * A frame a custom look doesn't have falls back to the "ah" frame, reshaped (FRAME_STANDIN).
 */
const DRAW = {
  mbp: { frame: 'base', sx: 1.03, sy: 0.92, grow: 1.25 },
  fv: { frame: 'half', sy: 0.78, oy: -1, grow: 1.35 },
  teeth: { frame: 'ee', sy: 0.82, grow: 1.4 },
  half: { frame: 'half' },
  round: { frame: 'oo', sx: 0.95, sy: 1.03, grow: 1.5 },
  ee: { frame: 'ee' },
  open: { frame: 'talk' },
  wide: { frame: 'talk', sx: 1.03, sy: 1.08, oy: -1, grow: 1.4 },
};
const FRAME_STANDIN = { half: { sy: 0.6, oy: -1 }, oo: { sx: 0.86 }, ee: { sx: 1.08, sy: 0.8 } };

function maskTo(img, r, grow) {
  const m = `radial-gradient(ellipse ${(r.rx * grow).toFixed(1)}% ${(r.ry * grow * 1.15).toFixed(1)}% at ${r.x.toFixed(1)}% ${r.y.toFixed(1)}%, #000 60%, transparent 100%)`;
  img.style.maskImage = m;
  img.style.webkitMaskImage = m;
}

export class Presence {
  /** @param {HTMLElement} root  container; gets three <img> layers and a ring. */
  constructor(root) {
    this.root = root;
    root.classList.add('presence');
    this.ring = document.createElement('div');
    this.ring.className = 'presence-ring';
    this.head = document.createElement('div');
    this.head.className = 'presence-head';
    this.base = this.#layer('presence-base');
    this.blinkImg = this.#layer('presence-blink');
    // Phase 63: one layer per mouth shape (see DRAW).
    this.mouths = {};
    // Each shape is a frame inside a box: the box is masked to the mouth (and fades), the frame
    // inside is squeezed or stretched, so the reshaping never drags the chin or nose along.
    const boxes = [];
    for (const shape of Object.keys(DRAW)) {
      const box = document.createElement('div');
      box.className = `presence-mouth presence-${shape}`;
      const img = this.#layer('');
      img.dataset.shape = shape;
      box.append(img);
      boxes.push(box);
      // A custom look made before a frame existed doesn't have it: the "ah" frame stands in, reshaped.
      img.addEventListener('error', () => {
        if (img.dataset.frame === 'talk' || img.dataset.frame === 'base' || !img.getAttribute('src')) return void (img.dataset.missing = '1');
        img.dataset.standin = img.dataset.frame;
        this.#shapeLayer(img, 'talk');
      });
      img.addEventListener('load', () => delete img.dataset.missing);
      this.mouths[shape] = img;
    }
    this.head.append(this.base, this.blinkImg, ...boxes);
    root.append(this.ring, this.head);
    this.nod = 0;
    this.phase = Math.random() * 10;
    this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.shaper = new MouthShaper({ calm: this.still });
    this.expression = null;
    this.custom = null;
    this.level = 0;
    this.running = false;
    this.analyser = null;
    this.data = null;
    all.add(this);
    this.setExpression('default');
  }

  #layer(cls) {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.decoding = 'async';
    return img;
  }

  /** Expression name, or a custom picture URL (then no blink/talk frames). */
  setExpression(expression, customUrl = null) {
    const x = EXPRESSIONS.includes(expression) ? expression : 'default';
    this.delegate?.setExpression?.(x, customUrl);
    if (x === this.expression && customUrl === this.custom) return;
    this.expression = x;
    this.custom = customUrl;
    if (customUrl) {
      this.base.src = customUrl;
      for (const img of [this.blinkImg, ...Object.values(this.mouths)]) img.removeAttribute('src');
    } else {
      this.base.src = (x === 'default' ? '/sara-portrait.jpg' : `/sara/portrait-${x}.jpg`) + version;
      this.blinkImg.src = `/sara/frames/${x}-blink.jpg${version}`;
      this.regions = null;
      for (const img of Object.values(this.mouths)) {
        delete img.dataset.standin;
        delete img.dataset.missing;
        this.#shapeLayer(img, DRAW[img.dataset.shape].frame);
      }
      const want = this.base.src;
      findRegions(this.base.src, this.blinkImg.src, this.#frameSrc('talk')).then((r) => {
        if (this.base.src !== want) return;
        this.regions = r;
        maskTo(this.blinkImg, r.eyes, 1.6);
        for (const img of Object.values(this.mouths)) {
          maskTo(img.parentElement, r.mouth, DRAW[img.dataset.shape].grow ?? 1.7);
          this.#shapeLayer(img);
        }
      });
    }
  }

  #frameSrc(frame) {
    if (frame === 'base') return this.base.src;
    return `/sara/frames/${this.expression}-${frame}.jpg${version}`;
  }

  /** Points a mouth layer at its frame (or a stand-in) and squeezes/stretches it around the mouth. */
  #shapeLayer(img, frame) {
    if (frame) {
      img.dataset.frame = frame;
      const src = this.#frameSrc(frame);
      if (img.getAttribute('src') !== src) img.src = src;
    }
    const d = DRAW[img.dataset.shape];
    const fix = img.dataset.standin ? FRAME_STANDIN[img.dataset.standin] ?? {} : {};
    const sx = (d.sx ?? 1) * (fix.sx ?? 1);
    const sy = (d.sy ?? 1) * (fix.sy ?? 1);
    const oy = fix.oy ?? d.oy ?? 0;
    const r = this.regions?.mouth ?? FALLBACK.mouth;
    img.style.transformOrigin = `${r.x.toFixed(1)}% ${(r.y + oy * r.ry * 0.45).toFixed(1)}%`;
    img.style.transform = sx === 1 && sy === 1 ? '' : `scale(${sx}, ${sy})`;
  }

  /** Listens to an <audio> element (Sara's voice). Needs a user gesture first (e.g. starting a call). */
  attach(audio) {
    if (this.analyser) return;
    // A1: one shared tap on her voice (web/voice-tap.js), so the living portrait elsewhere hears it too.
    const tap = voiceTap(audio);
    if (!tap) return; /* no Web Audio: she still breathes and blinks */
    this.vol = tap.vol;
    this.ctx = tap.ctx;
    this.analyser = tap.analyser;
    this.data = new Uint8Array(tap.analyser.fftSize);
    this.freq = new Uint8Array(tap.analyser.frequencyBinCount);
  }

  /** Listens to a Web Audio analyser instead (live calls); null goes back to the <audio> element. */
  listen(analyser) {
    this.delegate?.listen?.(analyser);
    if (analyser) {
      this.saved ??= { ctx: this.ctx, analyser: this.analyser, data: this.data };
      this.ctx = analyser.context;
      this.analyser = analyser;
      this.data = new Uint8Array(analyser.fftSize);
      this.freq = new Uint8Array(analyser.frequencyBinCount);
    } else if (this.saved) {
      ({ ctx: this.ctx, analyser: this.analyser, data: this.data } = this.saved);
      this.freq = this.analyser ? new Uint8Array(this.analyser.frequencyBinCount) : null;
      this.saved = undefined;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.ctx?.resume?.();
    // A1: the living portrait (web/avatar.js) draws her instead of the layers when it can.
    if (this.delegate?.start?.()) {
      this.living = true;
      this.root.classList.add('alive', 'living-on');
      return;
    }
    this.root.classList.add('alive');
    this.#scheduleBlink();
    const tick = () => {
      if (!this.running) return;
      this.#frame();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.living) {
      this.living = false;
      this.delegate?.stop?.();
      this.root.classList.remove('living-on');
    }
    cancelAnimationFrame(this.raf);
    clearTimeout(this.blinkTimer);
    this.root.classList.remove('alive', 'talking');
    this.mouth = 0;
    this.level = 0;
    this.lastFrame = undefined;
    this.shaper = new MouthShaper({ calm: this.still });
    for (const el of [...Object.values(this.mouths).map((img) => img.parentElement), this.blinkImg]) el.style.opacity = '0';
    this.head.style.transform = '';
  }

  /** Status line under the portrait (listening, thinking, …). */
  set status(s) {
    this.root.dataset.status = s ?? '';
  }

  #frame() {
    const now = performance.now();
    const dt = Math.min(0.1, ((now - (this.lastFrame ?? now)) || 16) / 1000);
    this.lastFrame = now;
    let sound = { level: 0, centroid: -1, low: 0, high: 0 };
    if (this.analyser) {
      this.analyser.getByteTimeDomainData(this.data);
      if (this.freq) this.analyser.getByteFrequencyData(this.freq);
      sound = soundFeatures(this.data, this.freq, this.analyser.context.sampleRate / this.analyser.fftSize);
    }
    const level = sound.level;
    // Envelope: opens over ~3 frames, closes over ~8, so syllables blend instead of snapping.
    this.level += (level - this.level) * Math.min(1, (level > this.level ? 20 : 7) * dt);
    const talking = this.level > 0.03;
    this.root.classList.toggle('talking', talking);
    if (!this.custom) {
      // Openness follows loudness continuously, eased, and never fully open on quiet sounds.
      const target = Math.min(1, Math.max(0, (this.level - 0.025) / 0.16)) ** 0.85 * 0.9;
      // Ease toward it, no faster than a jaw: fully open or closed takes at least ~180 ms
      // (time-based, so 60 Hz and 120 Hz screens look the same).
      const step = (target - (this.mouth ?? 0)) * Math.min(1, 14 * dt);
      const max = 5 * dt;
      this.mouth = (this.mouth ?? 0) + Math.max(-max, Math.min(max, step));
      // Phase 63: the shape (web/mouth.js), held and blended so it never flickers. Open shapes show
      // as far as the jaw is open; the near-closed ones (m/b/p, f/v, teeth) as long as she's talking.
      const w = this.shaper.update(sound, dt);
      const open = Math.min(1, this.mouth / 0.3);
      const voiced = Math.min(1, this.level / 0.05);
      for (const [shape, img] of Object.entries(this.mouths)) {
        const v = img.dataset.missing ? 0 : w[shape] * (shape === 'mbp' || shape === 'fv' || shape === 'teeth' ? voiced : open);
        img.parentElement.style.opacity = v < 0.02 ? '0' : v.toFixed(3);
      }
      this.root.dataset.mouth = this.shaper.shape;
    }
    // Head: a slow, slightly irregular sway, and small nods with the voice.
    if (!this.still) {
      const t = now / 1000 + this.phase;
      this.nod += (Math.min(1, this.level * 8) - this.nod) * Math.min(1, 4 * dt);
      // Phase 36: small idle moments while she isn't talking: a head tilt or a glance aside,
      // eased in, held a moment, eased out (every 7 to 16 seconds).
      let tilt = 0;
      let gx = 0;
      if (this.level < 0.03) {
        this.nextIdle ??= now + 7000 + Math.random() * 9000;
        if (!this.idle && now >= this.nextIdle) this.idle = { at: now, kind: Math.random() < 0.55 ? 'tilt' : 'glance', dir: Math.random() < 0.5 ? -1 : 1 };
      }
      if (this.idle) {
        const p = (now - this.idle.at) / 2600;
        if (p >= 1) {
          this.idle = null;
          this.nextIdle = now + 7000 + Math.random() * 9000;
        } else {
          const e = Math.sin(Math.PI * Math.min(1, p * 1.25)) ** 2;
          if (this.idle.kind === 'tilt') tilt = 2.2 * e * this.idle.dir;
          else gx = 2.2 * e * this.idle.dir;
        }
      }
      const rot = 0.45 * Math.sin(t * 0.37) + 0.2 * Math.sin(t * 0.91) + 0.5 * this.nod * Math.sin(t * 1.9) + tilt;
      const y = 0.7 * Math.sin(t * 0.53) + 1.6 * this.nod * (0.5 + 0.5 * Math.sin(t * 3.1));
      this.head.style.transform = `translate(${gx.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${rot.toFixed(3)}deg)`;
    }
    this.ring.style.transform = `scale(${1 + Math.min(0.08, this.level * 0.6)})`;
    this.ring.style.opacity = String(Math.min(0.9, 0.25 + this.level * 4));
  }

  #scheduleBlink() {
    clearTimeout(this.blinkTimer);
    this.blinkTimer = setTimeout(() => {
      if (!this.running) return;
      if (!this.custom && this.level < 0.06) {
        this.blinkImg.style.opacity = '1';
        setTimeout(() => (this.blinkImg.style.opacity = '0'), 130);
        // Sometimes a double blink.
        if (Math.random() < 0.18) setTimeout(() => {
          this.blinkImg.style.opacity = '1';
          setTimeout(() => (this.blinkImg.style.opacity = '0'), 120);
        }, 320);
      }
      this.#scheduleBlink();
    }, 2600 + Math.random() * 3800);
  }
}
