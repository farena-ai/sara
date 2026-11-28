// T65 (owner, 2026-11-28: the big moving portrait on Today showed only Stacy's neck and purple hair):
// her eyes and mouth are found from where her frames differ, and every picture-edit frame redraws her
// long hair a little, in the blink frame and the "ah" frame alike. Her face is also large in the frame
// (eyes ~19 % apart), which the old pair search refused (at most 18 %), so a pair of hair changes won.
// Synthetic pictures only (never a real look).
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain JS module shared with the browser
import * as rig from '../web/avatar-rig.js';

const N = 160;
type Spot = [number, number, number, number]; // x %, y %, value, half size (px)
function pixels(spots: Spot[]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(N * N * 4).fill(120);
  for (const [xp, yp, v, r] of spots) {
    const cx = Math.round((xp / 100) * N);
    const cy = Math.round((yp / 100) * N);
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) for (let c = 0; c < 3; c++) a[(y * N + x) * 4 + c] = v;
  }
  return a;
}
// A close head-and-shoulders portrait: eyes at y 30 % (x 41 and 60), mouth at (53, 49); long hair at the
// bottom right that drifts between edits (changed in BOTH the blink and the "ah" frame, more strongly).
const EYES: Spot[] = [[41, 30, 250, 3], [60, 30, 250, 3]];
const MOUTH: Spot[] = [[53, 49, 230, 4]];
const HAIR: Spot[] = [[79, 77, 255, 4], [94, 77, 255, 4], [87, 92, 255, 4]];

async function gl() {
  // @ts-expect-error plain JS module shared with the browser
  return (await import('../web/avatar-gl.js')) as Record<string, any>;
}

test('T65 a close portrait with drifting hair: the eyes and mouth are found, not the hair', async () => {
  const { faceFromPixels } = await gl();
  const r = faceFromPixels(pixels([]), pixels([...EYES, ...HAIR]), pixels([...MOUTH, ...HAIR]), N);
  assert.ok(r, 'a face is found');
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 2.5, `${what}: ${a} vs ${b}`);
  near(r.eyeL.x, 41, 'left eye x');
  near(r.eyeR.x, 60, 'right eye x');
  near(r.eyes.y, 30, 'eyes y');
  near(r.mouth.y, 49, 'mouth y');
  assert.ok(rig.plausibleFace(r, true));
  const crop = rig.faceCrop(r, 1, 'small');
  assert.ok(crop.x <= 0.41 && crop.x + crop.w >= 0.6 && crop.y <= 0.3 && crop.y + crop.h >= 0.49, 'both eyes and the mouth in the circle');
  assert.ok(crop.w >= 0.6, `not zoomed in (${crop.w})`);
});

test('T65 only hair changes (no face to find): nothing, so the whole picture shows', async () => {
  const { faceFromPixels } = await gl();
  assert.equal(faceFromPixels(pixels([]), pixels(HAIR), pixels(HAIR), N), null);
  // Changes low in the picture that only look like eyes and a mouth are not a face either.
  assert.equal(faceFromPixels(pixels([]), pixels([[79, 77, 250, 3], [94, 77, 250, 3]]), pixels([[87, 92, 230, 4]]), N), null);
});

test('T65 plausibleFace and faceCrop: implausible regions never steer the crop', () => {
  const stacy = rig.fitRegions({ le: { x: 41, y: 30 }, re: { x: 60, y: 30 }, mouth: { x: 53, y: 49 } });
  assert.ok(rig.plausibleFace(stacy, true));
  const hair = rig.fitRegions({ le: { x: 79, y: 77 }, re: { x: 94, y: 77 }, mouth: { x: 94, y: 94 } });
  assert.ok(hair, 'a well-formed triangle…');
  assert.equal(rig.plausibleFace(hair, true), false, '…but not where a face is');
  assert.equal(rig.plausibleFace(hair), false);
  const c = rig.faceCrop(hair, 1, 'small');
  assert.ok(Math.abs(c.x + c.w / 2 - 0.5) < 0.06 && c.w >= 0.85, `a gentle centred crop (${JSON.stringify(c)})`);
  assert.equal(rig.plausibleFace({ eyes: { x: 50, y: 40 }, mouth: { x: 50, y: 38 } }), false, 'mouth above the eyes');
  assert.equal(rig.plausibleFace(null), false);
  // Wide-set eyes keep the crop wide enough for both.
  const wide = rig.fitRegions({ le: { x: 30, y: 35 }, re: { x: 70, y: 35 }, mouth: { x: 50, y: 52 } });
  const w = rig.faceCrop(wide, 1, 'tiny');
  assert.ok(w.x <= 0.3 && w.x + w.w >= 0.7, 'both eyes in a tiny circle');
  // The built-in look (face.json) is framed as before.
  const builtin = rig.fitRegions({ le: { x: 41.9, y: 32.5 }, re: { x: 52.5, y: 30.6 }, mouth: { x: 47.5, y: 42.2 } });
  const b = rig.faceCrop(builtin, 1, 'small');
  assert.ok(Math.abs(b.w - (42.2 - 31.55) / 100 * 4.2) < 0.01, `same zoom as before (${b.w})`);
});

test('T65 findFace keeps only plausible faces (source check)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/avatar-gl.js', import.meta.url), 'utf8');
  assert.match(src, /plausibleFace\(r, true\) \? r : null/);
  assert.match(src, /f && plausibleFace\(f, true\) \? f : null/, 'the older finder is checked too');
});
