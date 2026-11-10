// A1 (docs/ops/A1_AVATAR_DESIGN.md): the living portrait renderer. One WebGL quad per visible mount draws
// her portrait through a small analytic warp field (breathing, head sway/tilt/nod about the neck, gaze
// inside each eye, brow lift, eye openness) and blends the look's real frames (eyes closed, four mouth
// shapes) inside soft masks at the warped position, so a blink or an "oo" is a drawn picture, never a
// stretched one. A picture without frames (your own, fitted) gets a soft blink (lids narrowing) and no
// mouth: a warped jaw or a full warp blink looked smeared on real photos (docs/ops/A1_AVATAR_DESIGN.md).
// Mood changes cross-fade. The canvas is at most 2 device pixels per CSS pixel and MAX_PX long;
// destroy() releases the context (loseContext) so leaving a page frees the GPU.
import { fitRegions } from './avatar-rig.js';
import { findRegions } from './presence.js';

export const MAX_PX = 768;
const FRAMES = ['base', 'blink', 'half', 'oo', 'ee', 'talk'];
// A look made before a frame existed: the "ah" frame stands in, reshaped (as web/presence.js does).
const STANDIN = { half: { sy: 0.6, oy: -1 }, oo: { sx: 0.86 }, ee: { sx: 1.08, sy: 0.8 } };

const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = vec2(aPos.x * .5 + .5, .5 - aPos.y * .5); gl_Position = vec4(aPos, 0., 1.); }`;
const FRAG = `precision mediump float;
varying vec2 vUv;
uniform sampler2D tBase, tBlink, tHalf, tOo, tEe, tTalk, tPrev;
uniform vec4 uCrop, uEyeL, uEyeR, uEyes, uMouth;
uniform vec4 uHead;      // tilt (rad), y offset, x offset, breath (-1..1)
uniform vec2 uGaze;      // in eye radii
uniform vec4 uLook;      // brow, eye openness, squint, blink 0..1
uniform vec4 uFlags;     // has frames, soft blink (no frames), unused, cross-fade 0..1
uniform float uAspect;   // picture width / height
uniform float uStill;    // 1: no warp at all (breathe-only pictures use uHead.w as a zoom)
uniform vec4 uMixBase, uMixHalf, uMixOo, uMixEe, uMixTalk;   // weight, sx, sy, oy
uniform vec4 uGrow;      // grow for half, oo, ee, talk (base uses 1.25)
vec2 M(vec2 v){ return vec2(v.x * uAspect, v.y); }
float ell(vec2 p, vec4 e, float g){ vec2 d = (M(p) - M(e.xy)) / (M(e.zw) * g); return dot(d, d); }
float soft(vec2 p, vec4 e, float g){ vec2 d = (M(p) - M(e.xy)) / (M(e.zw) * vec2(g, g * 1.15)); return 1. - smoothstep(.6, 1., length(d)); }
vec2 eyeWarp(vec2 q, vec4 e){
  vec2 d = (q - e.xy) / e.zw;
  // A flat core (the iris and its sclera move together) fading to the lids, which stay.
  float f = 1. - smoothstep(.3, 1., length(d));
  q -= clamp(uGaze, -1., 1.) * e.zw * vec2(.34, .22) * f;
  vec2 d2 = (q - e.xy) / (e.zw * vec2(1.25, 1.6));
  float f2 = max(0., 1. - dot(d2, d2));
  f2 *= f2;
  float s = uLook.y;                                   // openness (1 = as drawn)
  if (uFlags.y > .5) s *= 1. - .45 * uLook.w;           // soft blink for pictures without frames (a full warp blink smears)
  q.y = mix(q.y, e.y + (q.y - e.y) / max(.12, s), f2);
  q.y += uLook.z * e.w * .22 * f2 * step(e.y, q.y);    // smiling eyes: the lower lid rises
  vec2 b = (q - vec2(e.x, e.y - e.w * 2.3)) / (e.zw * vec2(1.7, 1.9));
  float fb = max(0., 1. - dot(b, b));
  q.y += uLook.x * e.w * .42 * fb * fb;                // brow lift
  return q;
}
vec4 mouthLayer(sampler2D t, vec2 q, vec4 mix4, float grow){
  vec2 a = vec2(uMouth.x, uMouth.y + mix4.w * uMouth.w * .45);
  vec2 uv = a + (q - a) / mix4.yz;
  return vec4(texture2D(t, uv).rgb, mix4.x * soft(q, uMouth, grow));
}
void main(){
  vec2 p = uCrop.xy + vUv * uCrop.zw;
  vec2 q = p;
  float eyesY = uEyes.y;
  float unit = max(.02, uMouth.y - eyesY);
  if (uStill > .5) {
    q = vec2(.5) + (p - vec2(.5)) / (1. + .006 * uHead.w);
  } else {
    float chin = uMouth.y + unit * .95;
    // breathing: chest and shoulders rise a little, the chest widens a touch
    float below = smoothstep(chin - unit * .2, chin + unit * 1.6, p.y);
    q.y += uHead.w * unit * .045 * below;
    q.x = uEyes.x + (q.x - uEyes.x) * (1. - uHead.w * .006 * below);
    // head: rotation about the neck with a soft head mask, plus small offsets (nods, glances)
    vec2 hc = vec2(uEyes.x, eyesY + unit * .25);
    float hr = unit * 2.6;
    float wH = 1. - smoothstep(hr * .75, hr * 1.3, length(M(p) - M(hc)));
    wH *= 1. - smoothstep(chin, chin + unit * .9, p.y);
    vec2 piv = M(vec2(uEyes.x, chin + unit * .35));
    vec2 r = M(q) - piv;
    float c = cos(-uHead.x), s = sin(-uHead.x);
    vec2 rot = vec2(c * r.x - s * r.y, s * r.x + c * r.y) + piv;
    rot.x /= uAspect;
    q = mix(q, rot - vec2(uHead.z, uHead.y) * unit, wH);
    q = eyeWarp(q, uEyeL);
    q = eyeWarp(q, uEyeR);
  }
  vec3 col = texture2D(tBase, q).rgb;
  if (uFlags.x > .5) {
    col = mix(col, texture2D(tBlink, q).rgb, uLook.w * soft(q, uEyes, 1.6));
    vec4 l = mouthLayer(tBase, q, uMixBase, 1.25); col = mix(col, l.rgb, l.a);
    l = mouthLayer(tHalf, q, uMixHalf, uGrow.x); col = mix(col, l.rgb, l.a);
    l = mouthLayer(tOo, q, uMixOo, uGrow.y); col = mix(col, l.rgb, l.a);
    l = mouthLayer(tEe, q, uMixEe, uGrow.z); col = mix(col, l.rgb, l.a);
    l = mouthLayer(tTalk, q, uMixTalk, uGrow.w); col = mix(col, l.rgb, l.a);
  }
  if (uFlags.w < 1.) col = mix(texture2D(tPrev, q).rgb, col, uFlags.w);
  gl_FragColor = vec4(col, 1.);
}`;

function pixelsOf(src, n) {
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

/** |a − b| per pixel, box-blurred (radius r), so the strongest change is a blob, not JPEG noise. */
export function diffMap(a, b, n, r = 3) {
  const d = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) d[i] = Math.abs(a[i * 4] - b[i * 4]) + Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + Math.abs(a[i * 4 + 2] - b[i * 4 + 2]);
  const t = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += d[y * n + Math.max(0, Math.min(n - 1, x + k))];
      t[y * n + x] = s;
    }
  const o = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += t[Math.max(0, Math.min(n - 1, y + k)) * n + x];
      o[y * n + x] = s / ((2 * r + 1) * (2 * r + 1));
    }
  return o;
}

/** The strongest change inside a box (percent): its peak and the extent above `cut` × peak. */
export function blob(d, n, box, cut = 0.45) {
  const [x0, x1, y0, y1] = box.map((v) => Math.max(0, Math.min(n - 1, Math.round((v / 100) * n))));
  let best = -1;
  let px = 0;
  let py = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (d[y * n + x] > best) {
        best = d[y * n + x];
        px = x;
        py = y;
      }
  if (best <= 0) return null;
  let [ax, bx, ay, by] = [px, px, py, py];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (d[y * n + x] >= best * cut) {
        ax = Math.min(ax, x);
        bx = Math.max(bx, x);
        ay = Math.min(ay, y);
        by = Math.max(by, y);
      }
  const p = (v) => (v / n) * 100;
  return { px: p(px), py: p(py), x: p((ax + bx) / 2), y: p((ay + by) / 2), rx: p((bx - ax) / 2 + 0.5), ry: p((by - ay) / 2 + 0.5), peak: best };
}

/** The strongest local maxima inside a box (percent), at least ~3 % apart. */
export function localPeaks(d, n, box, count) {
  const [x0, x1, y0, y1] = box.map((v) => Math.max(1, Math.min(n - 2, Math.round((v / 100) * n))));
  const all = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const v = d[y * n + x];
      if (v > 0 && v >= d[y * n + x - 1] && v >= d[y * n + x + 1] && v >= d[(y - 1) * n + x] && v >= d[(y + 1) * n + x]) all.push({ x: (x / n) * 100, y: (y / n) * 100, v });
    }
  all.sort((a, b) => b.v - a.v);
  const out = [];
  for (const p of all) {
    if (out.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 3)) continue;
    out.push(p);
    if (out.length >= count) break;
  }
  return out;
}

/** Eyes, each eye and mouth (percent) of a picture set, found from where its frames differ. */
export async function findFace(base, blink, talk) {
  const n = 160;
  const [b, k, t] = await Promise.all([pixelsOf(base, n), pixelsOf(blink, n), pixelsOf(talk, n)]);
  if (!b || !k || !t) return findRegions(base, blink, talk).then(legacyFace);
  const eyesDiff = diffMap(b, k, n, 2);
  const talkDiff = diffMap(b, t, n, 2);
  // The mouth moves most between the face and "ah"; the eyes are the pair above it that changes most
  // when she blinks (a generated blink frame may also have touched the mouth, so the pair is searched
  // above the mouth only, two blobs at about the same height).
  const peaks = localPeaks(eyesDiff, n, [5, 95, 5, 85], 16);
  const talkMax = Math.max(1, ...talkDiff);
  let pair = null;
  for (let i = 0; i < peaks.length; i++)
    for (let j = i + 1; j < peaks.length; j++) {
      const [a, c] = [peaks[i], peaks[j]];
      const dx = Math.abs(a.x - c.x);
      if (Math.abs(a.y - c.y) > dx * 0.3 || dx < 3.5 || dx > 18) continue;
      // A real pair of eyes has a mouth below its middle that moves when she talks.
      const mx = (a.x + c.x) / 2;
      const my = (a.y + c.y) / 2;
      const below = blob(talkDiff, n, [mx - dx * 0.5, mx + dx * 0.5, my + dx * 0.6, my + dx * 1.7], 0.5);
      const score = Math.min(a.v, c.v) * ((below?.peak ?? 0) / talkMax) * (1 - Math.abs(a.v - c.v) / Math.max(a.v, c.v) * 0.5);
      if (!pair || score > pair.score) pair = { a, c, score };
    }
  if (!pair) return findRegions(base, blink, talk).then(legacyFace);
  let [L, R] = [pair.a, pair.c];
  if (L.x > R.x) [L, R] = [R, L];
  const dist = Math.max(3, Math.hypot(R.x - L.x, R.y - L.y));
  const ey = (L.y + R.y) / 2;
  const ex = (L.x + R.x) / 2;
  // The mouth: the strongest "ah" change where a mouth can be (about one eye distance below).
  const want = ey + dist * 1.1;
  const prior = Float32Array.from(talkDiff, (v, i) => v * Math.exp(-((((Math.floor(i / n) / n) * 100 - want) / (dist * 0.4)) ** 2)));
  const mouthBlob = blob(prior, n, [ex - dist * 0.8, ex + dist * 0.8, ey + dist * 0.5, ey + dist * 1.8], 0.5);
  const my = mouthBlob ? mouthBlob.py : want;
  const mx = mouthBlob && Math.abs(mouthBlob.px - ex) < dist * 0.5 ? mouthBlob.px : ex;
  return fitRegions({ le: L, re: R, mouth: { x: mx, y: my } }) ?? findRegions(base, blink, talk).then(legacyFace);
}
function legacyFace(r) {
  const eyes = r.eyes;
  const one = (dir) => ({ x: eyes.x + dir * eyes.rx * 0.56, y: eyes.y, rx: Math.max(2.2, eyes.rx * 0.36), ry: Math.max(1.4, eyes.ry * 0.85) });
  return { eyes, mouth: r.mouth, eyeL: one(-1), eyeR: one(1) };
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export class LivingFace {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.textures = {};
    this.missing = new Set();
    this.fade = 1;
    this.aspect = 1;
    this.regions = null;
    this.ready = false;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) return;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ok = false;
      this.onLost?.();
    });
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
      gl.useProgram(prog);
      this.prog = prog;
    } catch (err) {
      this.error = String(err?.message ?? err);
      return;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uCrop', 'uEyeL', 'uEyeR', 'uEyes', 'uMouth', 'uHead', 'uGaze', 'uLook', 'uFlags', 'uAspect', 'uStill', 'uMixBase', 'uMixHalf', 'uMixOo', 'uMixEe', 'uMixTalk', 'uGrow']) this.u[n] = gl.getUniformLocation(this.prog, n);
    const units = ['tBase', 'tBlink', 'tHalf', 'tOo', 'tEe', 'tTalk', 'tPrev'];
    units.forEach((n, i) => gl.uniform1i(gl.getUniformLocation(this.prog, n), i));
    for (let i = 0; i < units.length; i++) this.#bind(i, this.#texture(null));
    this.ok = true;
  }

  #texture(img) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128]));
    return t;
  }

  #bind(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /**
   * Loads a picture set. `srcs`: { base, blink?, half?, oo?, ee?, talk? }; `regions` (percent, optional:
   * found from the frames when missing). Resolves true when drawable. The previous base cross-fades out.
   */
  async setPictures(srcs, regions = null) {
    if (!this.ok) return false;
    const key = JSON.stringify([srcs, regions]);
    if (key === this.key) return this.ready;
    this.key = key;
    const imgs = await Promise.all(FRAMES.map((f) => loadImage(srcs[f])));
    if (key !== this.key || !this.ok) return false;
    const [base] = imgs;
    if (!base) return false;
    const gl = this.gl;
    const hasFrames = Boolean(imgs[1] && imgs[5]);
    let found = regions;
    if (!found && hasFrames) found = await findFace(srcs.base, srcs.blink, srcs.talk);
    if (key !== this.key || !this.ok) return false;
    // The old base becomes the cross-fade source.
    if (this.textures.base && this.ready) {
      if (this.textures.prev) gl.deleteTexture(this.textures.prev);
      this.textures.prev = this.textures.base;
      this.textures.base = null;
      this.fade = 0;
    }
    for (const t of Object.entries(this.textures)) if (t[0] !== 'prev' && t[1]) gl.deleteTexture(t[1]);
    const keepPrev = this.textures.prev;
    this.textures = { prev: keepPrev };
    this.missing = new Set();
    FRAMES.forEach((f, i) => {
      if (!imgs[i]) this.missing.add(f);
      this.textures[f] = this.#texture(imgs[i]);
    });
    this.aspect = base.naturalWidth / Math.max(1, base.naturalHeight);
    this.hasFrames = hasFrames;
    this.regions = found;
    this.ready = true;
    return true;
  }

  /** Canvas pixels for a CSS size (≤ 2 per CSS pixel, ≤ MAX_PX). */
  resize(cssW, cssH) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const k = Math.min(dpr, MAX_PX / Math.max(1, cssW, cssH));
    const w = Math.max(8, Math.round(cssW * k));
    const h = Math.max(8, Math.round(cssH * k));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /**
   * Draws one frame. `p`: { crop {x,y,w,h}, tilt (deg), headX, headY (face units), breath (-1..1),
   * gazeX, gazeY, brow, eyes, squint, blink 0..1, mix (avatar-rig frameMix), jaw 0..1, warp (no frames:
   * warp blink), still (breathe only), dt }.
   */
  draw(p) {
    if (!this.ok || !this.ready) return false;
    const gl = this.gl;
    const u = this.u;
    const R = this.regions ?? { eyes: { x: 50, y: 40, rx: 12, ry: 4 }, mouth: { x: 50, y: 58, rx: 6, ry: 3 }, eyeL: { x: 44, y: 40, rx: 4, ry: 2.5 }, eyeR: { x: 56, y: 40, rx: 4, ry: 2.5 } };
    const v4 = (loc, r) => gl.uniform4f(loc, r.x / 100, r.y / 100, r.rx / 100, r.ry / 100);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const c = p.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    gl.uniform4f(u.uCrop, c.x, c.y, c.w, c.h);
    v4(u.uEyeL, R.eyeL);
    v4(u.uEyeR, R.eyeR);
    v4(u.uEyes, R.eyes);
    v4(u.uMouth, R.mouth);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uStill, p.still || !this.regions ? 1 : 0);
    gl.uniform4f(u.uHead, ((p.tilt ?? 0) * Math.PI) / 180, p.headY ?? 0, p.headX ?? 0, p.breath ?? 0);
    gl.uniform2f(u.uGaze, p.gazeX ?? 0, p.gazeY ?? 0);
    gl.uniform4f(u.uLook, p.brow ?? 0, p.eyes ?? 1, p.squint ?? 0, p.blink ?? 0);
    if (this.fade < 1) this.fade = Math.min(1, this.fade + (p.dt ?? 1 / 30) / 0.6);
    gl.uniform4f(u.uFlags, this.hasFrames ? 1 : 0, p.warp ? 1 : 0, 0, this.textures.prev ? this.fade : 1);
    const mix = this.#mix(p.mix);
    const set = (loc, m) => gl.uniform4f(loc, m.w, m.sx, m.sy, m.oy);
    set(u.uMixBase, mix.base);
    set(u.uMixHalf, mix.half);
    set(u.uMixOo, mix.oo);
    set(u.uMixEe, mix.ee);
    set(u.uMixTalk, mix.talk);
    gl.uniform4f(u.uGrow, mix.half.grow, mix.oo.grow, mix.ee.grow, mix.talk.grow);
    FRAMES.forEach((f, i) => this.#bind(i, this.textures[f]));
    this.#bind(6, this.textures.prev ?? this.textures.base);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this.fade >= 1 && this.textures.prev) {
      gl.deleteTexture(this.textures.prev);
      this.textures.prev = null;
    }
    return true;
  }

  /** Frames this look lacks hand their weight to the "ah" frame, reshaped. */
  #mix(m) {
    const none = { w: 0, sx: 1, sy: 1, oy: 0, grow: 1.7 };
    const out = { base: m?.base ?? none, half: m?.half ?? none, oo: m?.oo ?? none, ee: m?.ee ?? none, talk: { ...(m?.talk ?? none) } };
    for (const f of ['half', 'oo', 'ee']) {
      if (!this.missing.has(f) || !out[f].w) continue;
      const s = STANDIN[f];
      if (!out.talk.w) Object.assign(out.talk, { sx: out[f].sx * (s.sx ?? 1), sy: out[f].sy * (s.sy ?? 1), oy: s.oy ?? out[f].oy, grow: out[f].grow });
      out.talk.w = Math.min(1, out.talk.w + out[f].w);
      out[f] = none;
    }
    return out;
  }

  destroy() {
    this.ok = false;
    this.key = undefined;
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
  }
}
