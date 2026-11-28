// T62 (owner, 2026-11-28: companions are fully separate identities): her picture and the appearance set
// are kept per companion on a device (web/companion-keys.js). The main companion keeps the plain keys
// (a device with one companion sees no change); another keeps `<key>@<id>`, starting from the device's
// look until her first change of her own. Her picture defaults to her portrait when she has her own look.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';
import '../web/companion-keys.js';
// @ts-expect-error plain JS module shared with the browser
import { herPictureMode } from '../web/v4-picture.js';

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
type Keys = {
  MAIN: string;
  KEYS: string[];
  companionFromCookie(c: string): string;
  suffix(name: string, id: string): string;
  scoped(key: string, id: string): string;
  read(s: Store, key: string, id: string): string | null;
  write(s: Store, key: string, value: string, id: string): void;
  remove(s: Store, key: string, id: string): void;
};
const K = (globalThis as unknown as { saraKeys: Keys }).saraKeys;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
function mem(init: Record<string, string> = {}): Store & { all: Map<string, string> } {
  const all = new Map(Object.entries(init));
  return { all, getItem: (k) => all.get(k) ?? null, setItem: (k, v) => void all.set(k, String(v)), removeItem: (k) => void all.delete(k) };
}

test('T62: the companion comes from the sara_companion cookie (main when absent or main)', () => {
  assert.equal(K.companionFromCookie(''), 'main');
  assert.equal(K.companionFromCookie('other=1'), 'main');
  assert.equal(K.companionFromCookie('sara_companion=main'), 'main');
  assert.equal(K.companionFromCookie('sara_companion='), 'main');
  assert.equal(K.companionFromCookie('a=1; sara_companion=ana; b=2'), 'ana');
  assert.equal(K.companionFromCookie('sara_companion=r%C3%A9a'), 'réa');
  assert.equal(K.companionFromCookie('xsara_companion=ana'), 'main', 'only the exact cookie name');
});

test('T62: keys are scoped for a non-main companion only, and only the look keys', () => {
  for (const k of ['sara.herPicture', 'sara.palette', 'sara.vrm', 'sara.faceFit', 'sara.portrait', 'sara.decor', 'sara.theme', 'sara.accent', 'sara.accentPicked', 'sara.accentCustom', 'sara.density', 'sara.glass', 'sara.chatbg', 'sara.textSize', 'sara.runDetails']) {
    assert.ok(K.KEYS.includes(k), k);
    assert.equal(K.scoped(k, 'main'), k, `main keeps ${k}`);
    assert.equal(K.scoped(k, 'ana'), `${k}@ana`);
  }
  for (const k of ['sara.typing', 'sara.v1Notice', 'sara.lang', 'sara.a11y', 'sara.read']) assert.equal(K.scoped(k, 'ana'), k, `${k} stays shared`);
  assert.equal(K.suffix('model', 'main'), 'model');
  assert.equal(K.suffix('model', 'ana'), 'model@ana');
});

test('T62: the main companion reads and writes the plain keys, exactly as before', () => {
  const s = mem({ 'sara.herPicture': 'orb', 'sara.palette': 'nord' });
  assert.equal(K.read(s, 'sara.herPicture', 'main'), 'orb');
  K.write(s, 'sara.palette', 'ember', 'main');
  K.remove(s, 'sara.herPicture', 'main');
  assert.deepEqual([...s.all], [['sara.palette', 'ember']], 'nothing else is written');
});

test('T62: another companion starts from the device look, then keeps her own', () => {
  const s = mem({ 'sara.palette': 'nord', 'sara.theme': 'light', 'sara.typing': 'instant' });
  assert.equal(K.read(s, 'sara.palette', 'ana'), 'nord', 'nothing of her own yet: the device look');
  assert.equal(K.read(s, 'sara.herPicture', 'ana'), null);
  // Her first change: the device look is copied into her keys, the plain keys stay untouched.
  K.write(s, 'sara.herPicture', 'portrait', 'ana');
  assert.equal(s.getItem('sara.herPicture'), null, 'the main companion keeps no pick');
  assert.equal(s.getItem('sara.herPicture@ana'), 'portrait');
  assert.equal(s.getItem('sara.palette@ana'), 'nord');
  assert.equal(s.getItem('sara.theme@ana'), 'light');
  assert.equal(s.getItem('sara.typing@ana'), null, 'shared keys are not copied');
  assert.equal(s.getItem('sara.lookOwn@ana'), '1');
  // A later change for the main companion no longer reaches her.
  K.write(s, 'sara.palette', 'ember', 'main');
  assert.equal(K.read(s, 'sara.palette', 'ana'), 'nord');
  assert.equal(K.read(s, 'sara.palette', 'main'), 'ember');
  // Reset (removing her keys) gives her the defaults, not the main companion's look.
  K.remove(s, 'sara.palette', 'ana');
  assert.equal(K.read(s, 'sara.palette', 'ana'), null);
  assert.equal(s.getItem('sara.palette'), 'ember');
  // Two other companions stay apart.
  K.write(s, 'sara.herPicture', 'orb', 'bea');
  assert.equal(K.read(s, 'sara.herPicture', 'ana'), 'portrait');
  assert.equal(K.read(s, 'sara.herPicture', 'bea'), 'orb');
});

test('T62: her picture defaults to her portrait when she has her own look; a pick is kept', () => {
  assert.equal(herPictureMode(null, false, true), 'portrait');
  assert.equal(herPictureMode(null, false, false), 'orb');
  assert.equal(herPictureMode(null, true, true), 'own', 'an uploaded picture stays the default, as before');
  assert.equal(herPictureMode('orb', false, true), 'orb');
  const app = read('web/app.js');
  assert.match(app, /function herOwnLook\(\) \{\n\s*if \(look\.current\(\) === look\.MAIN\) return true;\n\s*const me = state\.companions\?\.companions\.find\(\(c\) => c\.current\);\n\s*if \(me\) return Boolean\(me\.main \|\| me\.ownLook\);/);
  assert.match(read('web/index.html'), /<option value="orb">Presence orb<\/option>/);
  assert.doesNotMatch(read('web/index.html'), /Presence orb \(default\)/);
});

test('T62: every reader goes through the helper; theme-boot knows the companion before the first paint', () => {
  for (const page of ['index', 'help', 'offline', 'device', 'download', 'family-screen', 'pair', 'privacy', 'support']) {
    assert.match(read(`web/${page}.html`), /<script src="\/companion-keys\.js"><\/script>\n\s*<script src="\/theme-boot\.js"><\/script>/, page);
  }
  assert.match(read('web/theme-boot.js'), /return keys \? keys\.get\(k\) : localStorage\.getItem\(k\);/);
  assert.match(read('web/sw.js'), /'\/companion-keys\.js', '\/theme-boot\.js'/);
  const look = new RegExp(String.raw`localStorage\.(getItem|setItem|removeItem)\(['\`]sara\.(${K.KEYS.map((k) => k.slice(5)).join('|')})\b`);
  for (const f of ['app.js', 'avatar-settings.js', 'a11y-mode.js', 'v4-picture.js']) assert.doesNotMatch(read(`web/${f}`), look, f);
  assert.match(read('web/app.js'), /import '\.\/companion-keys\.js';\n.*\nconst look = globalThis\.saraKeys;/);
  assert.match(read('web/app.js'), /for \(const k of AP_KEYS\) look\.del\(k\);/);
  assert.match(read('web/avatar-settings.js'), /look\.set\('sara\.vrm', '1'\)/);
  assert.match(read('web/avatar-vrm.js'), /suffix\('model', globalThis\.saraKeys\.current\(\)\)/);
  assert.match(read('web/run-timeline.js'), /globalThis\.saraKeys\.get\('sara\.runDetails'\)/);
});
