// V4d (docs/ops/V4_DESIGN.md → V4d): her picture in the new look (orb, her portrait or your picture,
// with the orb's state as a ring), the memory step's words ("Used n memories", what she already knew),
// and run cards folded by default (open for approvals, failures and live runs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'];
const i18n = (l: string) => JSON.parse(web(`i18n/${l}.json`)) as Record<string, string>;
const stub = String.raw`const t = (s, p = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));`;
async function webModule<T>(file: string): Promise<T> {
  const src = web(file).replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/from '\.\/(run-model|icons)\.js'/g, (_m, f) => `from '${new URL(`file:///${join(ROOT, 'web', `${f}.js`).replace(/\\/g, '/')}`).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as T;
}

test('V4d her picture: Presence orb (default), Her portrait or Your picture, per device, with a living ring', async () => {
  const html = web('index.html');
  assert.match(html, /<select id="ap-herpic"><option value="orb">Presence orb \(default\)<\/option><option value="portrait">Her portrait<\/option><option value="own">Your picture<\/option><\/select>/);
  assert.match(html, /id="ap-herpic-upload"/, 'a link to the upload');
  assert.match(html, /id="avatar-ap-link"/, 'her page points at the setting');
  const tips = JSON.parse(web('tips.json')) as Record<string, Record<string, unknown>>;
  assert.ok(JSON.stringify(tips).includes('"ap-herpic"'));
  const app = web('app.js');
  assert.match(app, /const AP_KEYS = \[[^\]]*'sara\.herPicture'/);
  // Default: the orb, unless a picture was uploaded before (then it stays, as in 3.0.0).
  const { herPictureMode } = await webModule<{ herPictureMode: (stored: string | null, custom: boolean) => string }>('v4-picture.js');
  assert.equal(herPictureMode(null, false), 'orb');
  assert.equal(herPictureMode(null, true), 'own');
  assert.equal(herPictureMode('portrait', true), 'portrait');
  assert.equal(herPictureMode('own', false), 'portrait', 'no upload yet: her portrait');
  assert.equal(herPictureMode('orb', true), 'orb');
  assert.equal(herPictureMode('nonsense', false), 'orb');
  assert.match(app, /const pic = localStorage\.getItem\('sara\.palette'\) === 'classic' \? \(own \? 'own' : 'orb'\) : herPictureMode\(localStorage\.getItem\('sara\.herPicture'\), Boolean\(own\)\);/);
  assert.match(app, /document\.documentElement\.classList\.toggle\('v4-own-face', pic !== 'orb'\);/);
  const css = web('v4-pages.css');
  // The ring follows her state (idle, listening, thinking, speaking) and stops with Motion off.
  for (const s of ['listening', 'thinking', 'speaking']) assert.ok(css.includes(`[data-her-state="${s}"]`), s);
  assert.match(css, /\.v4-own-face/);
  assert.match(css, /v4-own-face[^{]*\[data-motion="off"\][^{]*\{[^}]*animation: none/);
  for (const l of LANGS) for (const k of ['Presence orb (default)', 'Her portrait', 'Your picture']) assert.ok(i18n(l)[k], `${l}: ${k}`);
});

test('V4d memory step: "Used n memories" with what it means, opening those notes', () => {
  const steps = web('steps.js');
  assert.match(steps, /count === 1 \? t\('Used 1 memory'\) : t\('Used \{n\} memories', \{ n: count \}\)/);
  assert.doesNotMatch(steps, /Remembered \{n\} things/);
  assert.match(steps, /t\('Things she already knew about you that shaped this reply\.'\)/);
  assert.match(steps, /export function memoryStep\(box, count, \{ ids = \[\], open \} = \{\}\)/);
  assert.match(steps, /if \(ids\.length && open\)/);
  const app = web('app.js');
  assert.match(app, /memoryStep\(\(turn\.steps \?\?= newSteps\(\)\), turn\.mem\.size, \{ ids: \[\.\.\.turn\.mem\], open: \(ids\) => void openMemory\(\{ focusIds: ids \}\) \}\);/);
  assert.match(app, /opts\.focusIds/);
  for (const l of LANGS) for (const k of ['Used 1 memory', 'Used {n} memories', 'Things she already knew about you that shaped this reply.']) assert.ok(i18n(l)[k], `${l}: ${k}`);
});

test('V4d run cards: folded by default, open for approvals, failures and live runs; a setting and per-card memory', async () => {
  const tl = web('run-timeline.js');
  const { foldStart } = await webModule<{ foldStart: (o: Record<string, unknown>) => boolean }>('run-timeline.js');
  assert.equal(foldStart({ pref: 'folded' }), false, 'folded by default');
  assert.equal(foldStart({ pref: '' }), false);
  assert.equal(foldStart({ pref: 'open' }), true);
  assert.equal(foldStart({ pref: 'folded', live: true }), true, 'live runs open');
  assert.equal(foldStart({ pref: 'folded', waiting: true }), true, 'an approval opens it');
  assert.equal(foldStart({ pref: 'folded', errors: 1 }), true, 'a failed or denied step opens it');
  assert.equal(foldStart({ pref: 'open', card: 'folded' }), false, 'the card’s own choice this session wins');
  assert.equal(foldStart({ pref: 'folded', card: 'open' }), true);
  assert.equal(foldStart({ pref: 'folded', card: 'folded', waiting: true }), true, 'nothing that needs you is hidden');
  assert.match(tl, /sessionStorage/);
  assert.match(tl, /sara\.v4\.runFold\.\$\{who\}/);
  assert.match(tl, /localStorage\.getItem\('sara\.runDetails'\)/);
  assert.match(tl, /sum\.setAttribute\('aria-expanded', String\(box\.open\)\)/);
  assert.match(tl, /'v4-run-chev'/);
  const html = web('index.html');
  assert.match(html, /<select id="ap-runs"><option value="folded">Folded \(default\)<\/option><option value="open">Open<\/option><\/select>/);
  assert.match(web('app.js'), /'sara\.runDetails'/);
  for (const l of LANGS) for (const k of ['Show run details', 'Folded (default)']) assert.ok(i18n(l)[k], `${l}: ${k}`);
});
