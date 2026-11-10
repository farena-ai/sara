// A1 (docs/ops/A1_AVATAR_DESIGN.md): her living picture. The pure parts of the rig (state and mood →
// parameters, lids, lip-sync mix, motion switches, crop, the face fit), VRM checks, the setting and
// lazy loading of the 3D route.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// @ts-expect-error plain JS module shared with the browser
import * as rig from '../web/avatar-rig.js';
// @ts-expect-error plain JS module shared with the browser
import { herPictureMode, pictureMotion } from '../web/v4-picture.js';

const R = rig as Record<string, any>;
const web = (f: string) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('state → parameters: each presence state looks different, and sensibly so', () => {
  const idle = R.rigTargets('idle', 'default');
  const listening = R.rigTargets('listening', 'default');
  const thinking = R.rigTargets('thinking', 'default');
  const speaking = R.rigTargets('speaking', 'default');
  assert.ok(listening.eyes > idle.eyes, 'listening: a little more open (attentive)');
  assert.ok(listening.brow > idle.brow, 'listening: brows up');
  assert.equal(listening.gazeX, 0, 'listening: looks at you');
  assert.ok(thinking.gazeY < 0 && Math.abs(thinking.gazeX) > 0.2, 'thinking: looks up and aside');
  assert.ok(thinking.blinkMin > idle.blinkMin, 'thinking: fewer blinks');
  assert.equal(speaking.gazeX, 0, 'speaking: looks at you');
  assert.ok(speaking.glance < idle.glance, 'speaking: no wandering glances');
  for (const t of [idle, listening, thinking, speaking]) {
    assert.ok(t.blinkMin > 1000 && t.blinkMax > t.blinkMin, 'blinks every few seconds');
    assert.ok(Math.abs(t.tilt) <= 3, 'subtle head tilt (degrees)');
    assert.ok(t.eyes > 0.6 && t.eyes <= 1.1);
  }
  assert.deepEqual(R.rigTargets('nonsense', 'nonsense'), idle, 'unknown state/mood: idle, default');
});

test('mood → parameters: sleepy, hurt, happy, playful, caring', () => {
  const d = R.rigTargets('idle', 'default');
  const sleepy = R.rigTargets('idle', 'sleepy');
  assert.ok(sleepy.eyes < d.eyes - 0.1, 'sleepy: heavy lids');
  assert.ok(sleepy.lidMs > d.lidMs, 'sleepy: slow blinks');
  assert.ok(sleepy.breathRate < d.breathRate && sleepy.breath > d.breath, 'sleepy: slow deep breaths');
  assert.ok(R.rigTargets('idle', 'hurt').gazeY > 0, 'hurt: looks down');
  assert.ok(R.rigTargets('idle', 'happy').squint > d.squint, 'happy: smiling eyes');
  assert.ok(R.rigTargets('idle', 'playful').glance > d.glance, 'playful: glances more');
  assert.ok(Math.abs(R.rigTargets('idle', 'caring').tilt) > Math.abs(d.tilt), 'caring: head tilted');
  // State and mood combine: thinking while sleepy still looks away, with heavy lids.
  const ts = R.rigTargets('thinking', 'sleepy');
  assert.ok(ts.gazeY < 0 && ts.eyes < d.eyes);
});

test('easing: time-based and bounded (60 and 120 Hz end in the same place)', () => {
  const a = R.rigTargets('idle', 'default');
  const b = R.rigTargets('thinking', 'default');
  let x60 = { ...a };
  for (let i = 0; i < 60; i++) x60 = R.easeRig(x60, b, 1 / 60);
  let x120 = { ...a };
  for (let i = 0; i < 120; i++) x120 = R.easeRig(x120, b, 1 / 120);
  assert.ok(Math.abs(x60.gazeX - x120.gazeX) < 0.02);
  assert.ok(Math.abs(x60.gazeX - b.gazeX) < 0.05, 'reached within a second');
  const one = R.easeRig(a, b, 1 / 30);
  assert.ok(Math.abs(one.gazeX - a.gazeX) < Math.abs(b.gazeX - a.gazeX) * 0.5, 'no snapping in one frame');
  assert.ok(Object.values(R.easeRig(a, b, 5)).every(Number.isFinite), 'a long pause (tab back) stays finite');
});

test('lids: a blink closes fast and opens slower, never more than shut', () => {
  assert.equal(R.lidAt(0, 160), 0);
  assert.equal(R.lidAt(-5, 160), 0);
  assert.equal(R.lidAt(400, 160), 0, 'over');
  const peak = Math.max(...Array.from({ length: 160 }, (_, i) => R.lidAt(i, 160)));
  assert.ok(peak > 0.98 && peak <= 1);
  const tClose = Array.from({ length: 160 }, (_, i) => i).find((i) => R.lidAt(i, 160) > 0.98) ?? 0;
  assert.ok(tClose < 80, `closes within the first half (${tClose} ms)`);
  const t = R.rigTargets('idle', 'default');
  const gaps = [0, 0.5, 0.999].map((r) => R.nextBlinkMs(t, r));
  assert.ok(gaps[0] >= t.blinkMin && gaps[2] <= t.blinkMax && gaps[1] > gaps[0]);
});

test('lip-sync: loudness → jaw, mouth shapes → frame weights with their squeeze', () => {
  assert.equal(R.jawOpen(0), 0);
  assert.equal(R.jawOpen(0.02), 0, 'silence stays closed');
  assert.ok(R.jawOpen(0.1) > 0.3 && R.jawOpen(0.1) < R.jawOpen(0.2));
  assert.ok(R.jawOpen(5) <= 0.9, 'never fully open');
  const silent = R.frameMix({ rest: 1 }, 0, 0);
  for (const f of ['half', 'oo', 'ee', 'talk', 'base']) assert.equal(silent[f].w, 0, `${f} hidden at rest`);
  const ah = R.frameMix({ open: 1 }, 1, 1);
  assert.equal(ah.talk.w, 1);
  assert.equal(ah.talk.sx, 1);
  const wide = R.frameMix({ wide: 1 }, 1, 1);
  assert.equal(wide.talk.w, 1);
  assert.ok(wide.talk.sy > 1, 'wide = the ah frame stretched');
  const mixed = R.frameMix({ open: 0.5, wide: 0.5 }, 1, 1);
  assert.ok(mixed.talk.sy > 1 && mixed.talk.sy < wide.talk.sy, 'the squeeze blends with the weights');
  const half = R.frameMix({ round: 1 }, 0.5, 1);
  assert.ok(half.oo.w > 0.45 && half.oo.w < 0.55, 'open shapes show as far as the jaw is open');
  const mbp = R.frameMix({ mbp: 1 }, 0, 1);
  assert.equal(mbp.base.w, 1, 'pressed lips are voiced, not jaw-driven');
  const shapes = R.frameMix({ teeth: 1, fv: 0.5 }, 0, 1);
  assert.ok(shapes.ee.w > 0 && shapes.half.w > 0);
});

test('motion switches: reduced motion and Background motion Off show a still picture; hidden pauses', () => {
  assert.equal(R.avatarMotion({ motion: '', reduce: false, hidden: false }), 'run');
  assert.equal(R.avatarMotion({ motion: 'off', reduce: false, hidden: false }), 'still');
  assert.equal(R.avatarMotion({ motion: '', reduce: true, hidden: false }), 'still');
  assert.equal(R.avatarMotion({ motion: '', reduce: false, hidden: true }), 'pause');
  assert.equal(R.avatarMotion({ motion: '', reduce: false, hidden: false, visible: false }), 'pause', 'off screen');
  assert.equal(R.avatarMotion({ motion: 'off', reduce: true, hidden: true }), 'pause');
});

test('size tiers: tiny mounts only breathe and blink', () => {
  assert.equal(R.mountTier(26), 'tiny');
  assert.equal(R.mountTier(38), 'tiny');
  assert.equal(R.mountTier(112), 'small');
  assert.equal(R.mountTier(360), 'large');
  const t = R.tierLimits('tiny');
  assert.equal(t.gaze, 0);
  assert.equal(t.mouth, 0);
  assert.ok(t.breath > 0 && t.blink);
  assert.equal(R.tierLimits('large').mouth, 1);
});

test('face crop: round mounts centre on her face, the call shows the whole picture', () => {
  const regions = { eyes: { x: 47, y: 30, rx: 8, ry: 3 }, mouth: { x: 47, y: 40, rx: 4, ry: 2.5 } };
  const c = R.faceCrop(regions, 1, 'small');
  assert.ok(c.w > 0.15 && c.w < 0.6 && Math.abs(c.w - c.h) < 1e-9, 'square');
  assert.ok(c.x <= 0.47 && c.x + c.w >= 0.47 && c.y <= 0.3 && c.y + c.h >= 0.4, 'eyes and mouth inside');
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1 && c.y + c.h <= 1, 'inside the picture');
  const wide = R.faceCrop(regions, 16 / 9, 'large');
  assert.ok(Math.abs(wide.w / wide.h - 16 / 9) < 1e-6 && wide.w <= 1 && wide.h <= 1, 'covers a wide screen');
  const edge = R.faceCrop({ eyes: { x: 5, y: 5, rx: 4, ry: 2 }, mouth: { x: 5, y: 12, rx: 3, ry: 2 } }, 1, 'small');
  assert.ok(edge.x >= 0 && edge.y >= 0, 'clamped at the edges');
});

test('fit the face: three dots → regions; nonsense is refused', () => {
  const r = R.fitRegions({ le: { x: 40, y: 40 }, re: { x: 60, y: 40 }, mouth: { x: 50, y: 62 } });
  assert.ok(r);
  assert.equal(r.eyes.x, 50);
  assert.equal(r.eyeL.x, 40);
  assert.ok(r.mouth.y === 62 && r.mouth.rx > 3 && r.eyes.rx > 10);
  assert.equal(R.fitRegions({ le: { x: 60, y: 40 }, re: { x: 40, y: 40 }, mouth: { x: 50, y: 62 } })?.eyeL.x, 40, 'swapped eyes are sorted');
  assert.equal(R.fitRegions({ le: { x: 40, y: 40 }, re: { x: 60, y: 40 }, mouth: { x: 50, y: 30 } }), null, 'mouth above the eyes');
  assert.equal(R.fitRegions({ le: { x: 49, y: 40 }, re: { x: 50, y: 40 }, mouth: { x: 50, y: 60 } }), null, 'eyes on one spot');
  assert.equal(R.fitRegions({ le: { x: 'a' } }), null);
  assert.equal(R.fitRegions(null), null);
});

// ---------- VRM ----------
function glb(json: unknown, total?: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  const jlen = text.length + pad;
  const len = total ?? 12 + 8 + jlen;
  const out = new Uint8Array(12 + 8 + jlen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, len, true);
  dv.setUint32(12, jlen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length);
  return out;
}

test('VRM: a real-looking VRM 1.0 and 0.x pass and say who made them', () => {
  const v1 = R.validateVrm(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { meta: { name: 'Mika', authors: ['Ana'], licenseUrl: 'https://vrm.dev/licenses/1.0/' } } } }));
  assert.equal(v1.ok, true, v1.error);
  assert.equal(v1.version, '1.0');
  assert.equal(v1.meta.name, 'Mika');
  assert.equal(v1.meta.author, 'Ana');
  const v0 = R.validateVrm(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRM'], extensions: { VRM: { meta: { title: 'Old', author: 'Bo', licenseName: 'CC_BY' } } } }));
  assert.equal(v0.ok, true);
  assert.equal(v0.version, '0.x');
  assert.equal(v0.meta.licence, 'CC_BY');
});

test('VRM: size limit, wrong files, external links and broken headers are refused', () => {
  const ok = { asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { meta: { name: 'x' } } } };
  assert.match(R.validateVrm(glb(ok), { max: 10 }).error, /too big/i);
  assert.ok(R.VRM_MAX_BYTES >= 30 * 1024 * 1024 && R.VRM_MAX_BYTES <= 100 * 1024 * 1024);
  assert.match(R.validateVrm(new TextEncoder().encode('<html>hello</html>')).error, /not a vrm/i);
  assert.match(R.validateVrm(glb({ asset: { version: '2.0' } })).error, /not a vrm/i, 'plain glTF without VRM');
  assert.match(R.validateVrm(glb({ ...ok, images: [{ uri: 'https://evil.example/x.png' }] })).error, /outside/i, 'no network fetches');
  assert.match(R.validateVrm(glb({ ...ok, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }] })).error, /outside/i, 'only embedded data');
  assert.match(R.validateVrm(glb(ok, 999999)).error, /broken|incomplete/i, 'declared length mismatch');
  const bad = glb(ok);
  bad[20] = 0x7b;
  bad[21] = 0x7b;
  assert.match(R.validateVrm(bad).error, /broken/i, 'invalid JSON');
  assert.match(R.validateVrm(new Uint8Array(4)).error, /not a vrm/i);
});

test('VRM: visemes and mood expressions from the same rig', () => {
  const ah = R.vrmVisemes(R.frameMix({ open: 1 }, 1, 1));
  assert.ok(ah.aa > 0.9 && ah.ou === 0);
  const oo = R.vrmVisemes(R.frameMix({ round: 1 }, 1, 1));
  assert.ok(oo.ou > 0.9);
  const ee = R.vrmVisemes(R.frameMix({ ee: 1 }, 1, 1));
  assert.ok(ee.ee > 0.9);
  const rest = R.vrmVisemes(R.frameMix({ rest: 1 }, 0, 0));
  assert.ok(Object.values(rest).every((v) => v === 0));
  assert.ok(R.vrmMood('happy').happy > 0.3);
  assert.ok(R.vrmMood('hurt').sad > 0.3);
  assert.ok(R.vrmMood('sleepy').relaxed > 0.2);
  assert.ok(Object.values(R.vrmMood('default')).every((v) => v === 0));
  for (const m of ['happy', 'caring', 'playful', 'sleepy', 'hurt']) assert.ok(Object.values(R.vrmMood(m)).every((v) => (v as number) <= 0.7), 'subtle, never a full grin');
});

// ---------- the setting ----------
test('setting: her picture choices, the default stays the orb', () => {
  assert.equal(herPictureMode(null, false), 'orb', 'new installs: the orb');
  assert.equal(herPictureMode('portrait', false), 'portrait', 'her portrait = the animated one');
  assert.equal(herPictureMode('portrait-still', true), 'still');
  assert.equal(herPictureMode('vrm', false), 'vrm');
  assert.equal(pictureMotion('portrait', {}), 'rig');
  assert.equal(pictureMotion('still', {}), null);
  assert.equal(pictureMotion('orb', {}), null);
  assert.equal(pictureMotion('own', { fitted: false }), 'breathe', 'your picture breathes before it is fitted');
  assert.equal(pictureMotion('own', { fitted: true }), 'warp');
  assert.equal(pictureMotion('vrm', { vrm: true }), 'vrm');
  assert.equal(pictureMotion('vrm', { vrm: false }), 'rig', 'no model stored: her animated portrait');
  const html = web('index.html');
  assert.match(html, /<select id="ap-herpic"><option value="orb">Presence orb \(default\)<\/option><option value="portrait">Her portrait, animated<\/option><option value="portrait-still">Her portrait, still<\/option><option value="own">Your picture<\/option><option value="vrm">A 3D model \(\.vrm\)<\/option><\/select>/);
  for (const id of ['ap-vrm-file', 'ap-fit-open']) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(JSON.stringify(JSON.parse(web('tips.json'))).includes('"ap-vrm-file"'), 'a tip for the model file');
});

test('lazy loading: three.js only comes with a chosen 3D model', () => {
  const html = web('index.html');
  assert.doesNotMatch(html, /vendor\/three-vrm|avatar-vrm/, 'not in the page');
  const app = web('app.js');
  assert.doesNotMatch(app, /^import[^;]*(avatar-vrm|three-vrm)/m, 'no static import in app.js');
  const av = web('avatar.js');
  assert.doesNotMatch(av, /^import[^;]*(avatar-vrm|three-vrm)/m, 'no static import in avatar.js');
  assert.match(av, /import\('\.\/avatar-vrm\.js'\)/, 'loaded on demand');
  const vrm = web('avatar-vrm.js');
  assert.match(vrm, /import\('\/vendor\/three-vrm\/sara-vrm\.js'\)/);
  const lic = readFileSync(new URL('../web/vendor/three-vrm/LICENSE-three.txt', import.meta.url), 'utf8');
  assert.match(lic, /MIT License/);
  assert.match(readFileSync(new URL('../web/vendor/three-vrm/LICENSE-three-vrm.txt', import.meta.url), 'utf8'), /MIT License/);
  assert.match(readFileSync(new URL('../web/vendor/three-vrm/VERSIONS.json', import.meta.url), 'utf8'), /"three": "0\.187\.0"/);
});

test('budget: the living loop is capped at 30 fps and pauses when hidden', () => {
  const av = web('avatar.js');
  assert.match(av, /FRAME_MS = 1000 \/ 30/);
  assert.match(av, /visibilitychange/);
  assert.match(av, /IntersectionObserver/);
  const gl = web('avatar-gl.js');
  assert.match(gl, /MAX_PX = 768/);
  assert.match(gl, /loseContext/);
});

test('landmarks from frames: the two strongest blink changes side by side are the eyes', async () => {
  // @ts-expect-error plain JS module shared with the browser
  const gl = (await import('../web/avatar-gl.js')) as Record<string, any>;
  const n = 128;
  const px = (spots: [number, number, number][]) => {
    const a = new Uint8ClampedArray(n * n * 4).fill(120);
    for (const [cx, cy, v] of spots) for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) a[(y * n + x) * 4] = v;
    return a;
  };
  const base = px([]);
  const blink = px([[48, 40, 250], [80, 40, 250], [64, 80, 200]]);
  const d = gl.diffMap(base, blink, n, 1);
  const peaks = gl.localPeaks(d, n, [0, 100, 0, 100], 5);
  assert.ok(peaks.length >= 3);
  const xs = peaks.slice(0, 2).map((p: { x: number }) => Math.round((p.x / 100) * n)).sort((a: number, b: number) => a - b);
  assert.ok(Math.abs(xs[0] - 48) <= 1 && Math.abs(xs[1] - 80) <= 1, `the two eyes first (${xs})`);
  const b = gl.blob(d, n, [40, 60, 50, 75], 0.5);
  assert.ok(Math.abs((b.px / 100) * n - 64) <= 1 && Math.abs((b.py / 100) * n - 80) <= 1, 'the mouth in its box');
});
