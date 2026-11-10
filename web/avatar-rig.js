// A1 (docs/ops/A1_AVATAR_DESIGN.md): the living portrait's rig, as pure functions (no DOM, tested in
// test/a1-avatar.test.ts). Her presence state (idle / listening / thinking / speaking, web/orb.js) and
// her mood (the expression system: happy, caring, playful, sleepy, hurt) → animation parameters: eye
// openness, smiling eyes, brows, gaze, blink rhythm, head tilt, breathing. Plus the lip-sync mix (the
// mouth shapes of web/mouth.js → the frames each look ships), motion switches, size tiers, the face
// crop for round pictures, the "fit the face" dots for your own picture and the checks a .vrm file must
// pass before anything parses it.

export const RIG_STATES = ['idle', 'listening', 'thinking', 'speaking'];
export const RIG_MOODS = ['default', 'happy', 'caring', 'playful', 'sleepy', 'hurt'];

const BASE = Object.freeze({ eyes: 1, squint: 0, brow: 0, gazeX: 0, gazeY: 0, blinkMin: 2600, blinkMax: 6400, lidMs: 170, tilt: 0, breath: 1, breathRate: 0.23, glance: 1 });

// Each state changes a few things on top of the base (deltas, except the blink window and glance factor).
const STATE = {
  idle: {},
  listening: { eyes: 0.04, brow: 0.25, tilt: 1.6, glance: 0.3, blinkMin: 3000, blinkMax: 6000 },
  thinking: { eyes: -0.06, brow: 0.12, gazeX: 0.5, gazeY: -0.45, tilt: -0.8, glance: 0.2, blinkMin: 4000, blinkMax: 8000 },
  speaking: { glance: 0.15, blinkMin: 2200, blinkMax: 4800 },
};
// Moods: added on top of the state (deltas; *Rate/lidMs/breath/glance multiply).
const MOOD = {
  default: {},
  happy: { squint: 0.25, brow: 0.1, tilt: 0.6 },
  caring: { tilt: 1.8, eyes: -0.03, squint: 0.1, breathRate: 0.85 },
  playful: { glance: 1.8, tilt: -1, brow: 0.15 },
  sleepy: { eyes: -0.22, brow: -0.1, lidMs: 1.8, breath: 1.4, breathRate: 0.7, blinkMin: 2000, blinkMax: 4200 },
  hurt: { gazeY: 0.35, glance: 0.5, brow: -0.15, eyes: -0.06 },
};
const MULTIPLY = new Set(['lidMs', 'breath', 'breathRate', 'glance']);
const WINDOW = new Set(['blinkMin', 'blinkMax']);

/** The parameters to ease toward for a state and a mood (unknown ones: idle, default). */
export function rigTargets(state, mood) {
  const s = STATE[state] ?? STATE.idle;
  const m = MOOD[mood] ?? MOOD.default;
  const out = { ...BASE };
  for (const layer of [s, m])
    for (const [k, v] of Object.entries(layer)) {
      if (WINDOW.has(k)) out[k] = v;
      else if (MULTIPLY.has(k)) out[k] *= v;
      else out[k] += v;
    }
  out.tilt = Math.max(-3, Math.min(3, out.tilt));
  out.eyes = Math.max(0.65, Math.min(1.08, out.eyes));
  return out;
}

/** Eases every parameter toward its target, time-based (same result at 60 and 120 Hz). */
export function easeRig(cur, target, dt, rate = 4) {
  const k = 1 - Math.exp(-Math.max(0, Math.min(10, dt)) * rate);
  const out = {};
  for (const key of Object.keys(target)) {
    const a = Number.isFinite(cur?.[key]) ? cur[key] : target[key];
    out[key] = a + (target[key] - a) * k;
  }
  return out;
}

/** How shut the lids are `ms` into a blink lasting `lidMs`: closes fast, holds a moment, opens slower. */
export function lidAt(ms, lidMs) {
  if (!(ms > 0) || ms >= lidMs) return 0;
  const p = ms / lidMs;
  if (p < 0.35) return Math.sin((p / 0.35) * (Math.PI / 2));
  if (p < 0.45) return 1;
  const q = (p - 0.45) / 0.55;
  return 1 - q * q * (3 - 2 * q);
}

/** Milliseconds until the next blink (`r` = a random number 0..1). */
export const nextBlinkMs = (t, r) => t.blinkMin + Math.max(0, Math.min(1, r)) * (t.blinkMax - t.blinkMin);

/** Jaw openness for an eased loudness: closed in silence, never fully open (Phase 9's curve). */
export const jawOpen = (level) => Math.min(1, Math.max(0, (level - 0.025) / 0.16)) ** 0.85 * 0.9;

/**
 * Mouth shapes (web/mouth.js weights) → the frames each look ships, with the squeeze/stretch each shape
 * draws its frame with (sx/sy scale around the mouth, oy -1 = anchored at the upper lip, grow = how far
 * around the mouth the frame shows). Open shapes show as far as the jaw is open (`open` 0..1); the
 * near-closed ones (m/b/p, f/v, teeth) as long as she is voicing (`voiced` 0..1).
 */
export const MOUTH_DRAW = {
  mbp: { frame: 'base', sx: 1.03, sy: 0.92, grow: 1.25, voiced: true },
  fv: { frame: 'half', sy: 0.78, oy: -1, grow: 1.35, voiced: true },
  teeth: { frame: 'ee', sy: 0.82, grow: 1.4, voiced: true },
  half: { frame: 'half' },
  // A wide mask: the rounded frame's own mouth corners replace the smile around them (no double smile).
  round: { frame: 'oo', sx: 0.95, sy: 1.03, grow: 1.9 },
  ee: { frame: 'ee' },
  open: { frame: 'talk' },
  wide: { frame: 'talk', sx: 1.03, sy: 1.08, oy: -1, grow: 1.4 },
};
export const MOUTH_FRAMES = ['base', 'half', 'oo', 'ee', 'talk'];

export function frameMix(weights, open, voiced) {
  const acc = Object.fromEntries(MOUTH_FRAMES.map((f) => [f, { w: 0, sx: 0, sy: 0, oy: 0, grow: 0 }]));
  for (const [shape, d] of Object.entries(MOUTH_DRAW)) {
    const v = Math.max(0, Number(weights?.[shape]) || 0) * Math.max(0, Math.min(1, d.voiced ? voiced : open));
    if (!v) continue;
    const a = acc[d.frame];
    a.w += v;
    a.sx += v * (d.sx ?? 1);
    a.sy += v * (d.sy ?? 1);
    a.oy += v * (d.oy ?? 0);
    a.grow += v * (d.grow ?? 1.7);
  }
  const out = {};
  for (const [f, a] of Object.entries(acc))
    out[f] = a.w ? { w: Math.min(1, a.w), sx: a.sx / a.w, sy: a.sy / a.w, oy: a.oy / a.w, grow: a.grow / a.w } : { w: 0, sx: 1, sy: 1, oy: 0, grow: 1.7 };
  return out;
}

/** 'run', 'still' (reduced motion or Background motion Off: one still frame) or 'pause' (not seen). */
export function avatarMotion({ motion, reduce, hidden, visible = true }) {
  if (hidden || visible === false) return 'pause';
  if (motion === 'off' || reduce) return 'still';
  return 'run';
}

/** Tiny mounts (the chat header, the sidebar) only breathe and blink; bigger ones do everything. */
export const mountTier = (px) => (px < 48 ? 'tiny' : px < 200 ? 'small' : 'large');
const LIMITS = {
  tiny: { gaze: 0, mouth: 0, brow: 0, breath: 0.6, head: 0.5, blink: true },
  small: { gaze: 1, mouth: 1, brow: 1, breath: 1, head: 1, blink: true },
  large: { gaze: 1, mouth: 1, brow: 1, breath: 1, head: 1, blink: true },
};
export const tierLimits = (tier) => LIMITS[tier] ?? LIMITS.small;

/**
 * The part of the picture a mount shows, in 0..1 picture coordinates: round mounts are centred on her
 * face (tighter when tiny); large ones cover the mount with the whole picture, centred on the face.
 * `regions` are in percent (see fitRegions / web/avatar-gl.js findFace).
 */
export function faceCrop(regions, aspect, tier) {
  const cx = regions.eyes.x / 100;
  const cy = (regions.eyes.y * 0.55 + regions.mouth.y * 0.45) / 100;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let w;
  let h;
  if (tier === 'large') {
    if (aspect >= 1) [w, h] = [1, 1 / aspect];
    else [w, h] = [aspect, 1];
  } else {
    const unit = Math.max(2, regions.mouth.y - regions.eyes.y) / 100;
    const s = clamp(unit * (tier === 'tiny' ? 3.6 : 4.2), 0.15, 1);
    if (aspect >= 1) [w, h] = [s, s / aspect];
    else [w, h] = [s * aspect, s];
  }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

/** Your picture's "fit the face" dots (percent: left eye, right eye, mouth) → regions, or null. */
export function fitRegions(p) {
  const pt = (v) => (v && Number.isFinite(v.x) && Number.isFinite(v.y) && v.x >= 0 && v.x <= 100 && v.y >= 0 && v.y <= 100 ? { x: v.x, y: v.y } : null);
  if (!p || typeof p !== 'object') return null;
  let [a, b, m] = [pt(p.le), pt(p.re), pt(p.mouth)];
  if (!a || !b || !m) return null;
  if (a.x > b.x) [a, b] = [b, a];
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const ey = (a.y + b.y) / 2;
  if (d < 4 || m.y - ey < d * 0.4 || m.y - ey > d * 2.2) return null;
  const eye = (e) => ({ x: e.x, y: e.y, rx: d * 0.28, ry: d * 0.16 });
  return { eyeL: eye(a), eyeR: eye(b), eyes: { x: (a.x + b.x) / 2, y: ey, rx: d * 0.85, ry: d * 0.3 }, mouth: { x: m.x, y: m.y, rx: d * 0.42, ry: d * 0.26 } };
}

// ---------- VRM ----------
export const VRM_MAX_BYTES = 50 * 1024 * 1024;
const JSON_MAX = 8 * 1024 * 1024;
const fail = (code, error) => ({ ok: false, code, error });
const NOT_VRM = () => fail('type', 'This is not a VRM model (.vrm).');
const BROKEN = () => fail('broken', 'The file is broken or incomplete.');

/**
 * Checks a .vrm (binary glTF) before anything parses it: size, header, the JSON chunk, a VRM 0.x or 1.0
 * extension, and no `uri` anywhere (everything embedded, so loading it fetches nothing). glTF is data
 * only; no scripts can run. Returns { ok, version, meta: { name, author, licence } } or { ok:false, code, error }.
 */
export function validateVrm(bytes, { max = VRM_MAX_BYTES } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(0);
  if (bytes.length > max) return fail('big', `This model is too big (limit ${Math.round(max / 1048576)} MB).`);
  if (bytes.length < 20) return NOT_VRM();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) return NOT_VRM();
  if (dv.getUint32(8, true) !== bytes.length) return BROKEN();
  const jlen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || jlen > JSON_MAX || 20 + jlen > bytes.length) return BROKEN();
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jlen)));
  } catch {
    return BROKEN();
  }
  if (!doc || typeof doc !== 'object') return BROKEN();
  const used = Array.isArray(doc.extensionsUsed) ? doc.extensionsUsed : [];
  const v1 = used.includes('VRMC_vrm') && doc.extensions?.VRMC_vrm;
  const v0 = used.includes('VRM') && doc.extensions?.VRM;
  if (!v1 && !v0) return NOT_VRM();
  for (const list of [doc.buffers, doc.images])
    if (Array.isArray(list) && list.some((x) => x && typeof x === 'object' && 'uri' in x)) return fail('external', 'It links to files outside the model; only self-contained .vrm files work.');
  const str = (v) => (typeof v === 'string' ? v.slice(0, 120) : '');
  const meta = v1
    ? { name: str(v1.meta?.name), author: str(Array.isArray(v1.meta?.authors) ? v1.meta.authors[0] : ''), licence: str(v1.meta?.licenseUrl) }
    : { name: str(v0.meta?.title), author: str(v0.meta?.author), licence: str(v0.meta?.licenseName === 'Other' ? v0.meta?.otherLicenseUrl : v0.meta?.licenseName) };
  return { ok: true, version: v1 ? '1.0' : '0.x', meta };
}

/** The frame mix → VRM viseme expressions (aa, ih, ou, ee, oh). */
export function vrmVisemes(mix) {
  const c = (v) => Math.max(0, Math.min(1, v));
  return { aa: c(mix.talk.w + mix.half.w * 0.35), ih: c(mix.half.w * 0.3), ou: c(mix.oo.w), ee: c(mix.ee.w), oh: c(mix.oo.w * 0.25) };
}

/** Her mood → VRM expressions (subtle: never above 0.7). */
export function vrmMood(mood) {
  const base = { happy: 0, relaxed: 0, sad: 0, surprised: 0, angry: 0 };
  const m = { happy: { happy: 0.5 }, caring: { relaxed: 0.4, happy: 0.15 }, playful: { happy: 0.35, surprised: 0.1 }, sleepy: { relaxed: 0.35 }, hurt: { sad: 0.45 } }[mood];
  return { ...base, ...m };
}
