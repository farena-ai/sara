// Smooth long sessions (docs/PERFORMANCE.md): the pure helpers behind a steady chat while she
// streams (follow the newest text only when the reader is at the bottom, at most one layout read
// and one scroll a frame, a window that never re-blurs every frame) and the static guards that keep
// the costly patterns out (root :has() anchors, a full-window drift under the glass, per-token layout).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const smooth = () => import(pathToFileURL(join(ROOT, 'web', 'smooth.js')).href);

test('nearBottom: follows only a reader who is at (or close to) the newest line', async () => {
  const { nearBottom, NEAR_BOTTOM_PX } = await smooth();
  assert.equal(NEAR_BOTTOM_PX, 160);
  assert.equal(nearBottom({ scrollHeight: 5000, scrollTop: 4100, clientHeight: 900 }), true, 'at the bottom');
  assert.equal(nearBottom({ scrollHeight: 5000, scrollTop: 3990, clientHeight: 900 }), true, 'a few lines up still follows');
  assert.equal(nearBottom({ scrollHeight: 5000, scrollTop: 3000, clientHeight: 900 }), false, 'scrolled up to read: left alone');
  assert.equal(nearBottom({ scrollHeight: 5000, scrollTop: 3000, clientHeight: 900 }, 2000), true, 'own threshold');
  assert.equal(nearBottom(null), true, 'no box: nothing to keep');
});

test('frameBatch: any number of calls in one frame run the work once, in the next frame', async () => {
  const { frameBatch } = await smooth();
  const frames: Array<() => void> = [];
  let runs = 0;
  const go = frameBatch(() => runs++, (cb: () => void) => frames.push(cb));
  for (let i = 0; i < 50; i++) go();
  assert.equal(frames.length, 1, 'one frame asked for');
  assert.equal(runs, 0, 'nothing runs before the frame');
  frames.shift()!();
  assert.equal(runs, 1);
  go();
  go();
  assert.equal(frames.length, 1, 'the next burst asks for one more frame');
  frames.shift()!();
  assert.equal(runs, 2);
});

test('streamFrame: one layout read and at most one scroll per frame, before and after the new text', async () => {
  const { streamFrame } = await smooth();
  const log: string[] = [];
  const box = {
    get scrollHeight() { log.push('read'); return 5000; },
    get clientHeight() { return 900; },
    scrollTop: 4100,
  };
  streamFrame(box, () => log.push('render'));
  assert.deepEqual(log, ['read', 'render', 'read']);
  assert.equal(box.scrollTop, 5000, 'followed the new text');
  log.length = 0;
  box.scrollTop = 2000;
  streamFrame(box, () => log.push('render'));
  assert.deepEqual(log, ['read', 'render'], 'scrolled up: no second read, no scroll');
  assert.equal(box.scrollTop, 2000);
});

test('the streamed reply renders once a frame and never forces layout per token', () => {
  const app = web('app.js');
  const token = app.slice(app.indexOf("} else if (ev.type === 'token') {"), app.indexOf("} else if (ev.type === 'claim_check') {"));
  assert.ok(token.length > 100);
  assert.doesNotMatch(token, /scrollHeight|getBoundingClientRect|offsetHeight/, 'no layout read per token');
  const queue = app.slice(app.indexOf('function queueReply('), app.indexOf('function bubble('));
  assert.match(queue, /requestAnimationFrame\(/);
  assert.match(queue, /streamFrame\(\$\('#messages'\), \(\) => setReply\(div, div\._raw\)\)/);
});

test('after a turn the chat keeps a window of PAGE messages when he is at the bottom (flat page over a long session)', () => {
  const app = web('app.js');
  assert.match(app, /\?limit=\$\{nearBottom\(\$\('#messages'\)\) \? PAGE : Math\.max\(PAGE, \(state\.messages\?\.length \?\? 0\) \+ 10\)\}/);
  assert.match(app, /const PAGE = 150;/);
});

test('no root-anchored :has() (every DOM change would re-check the whole page)', () => {
  for (const f of ['polish.css', 'kit.css', 'v4.css', 'v4-pages.css', 'v4-living.css', 'look.css', 'style.css', 'screens.css', 'her-panel.css']) {
    const css = web(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /(^|[\s,{}])(html|body|:root)(\.[\w-]+|\[[^\]]+\])*:has\(/m, `${f}: html/body/:root :has()`);
  }
  // today.css keeps its phone-only rules (inside a max-width media query, never active on a computer).
  assert.match(web('kit.css'), /html\.today-open #hp-open-her \{ display: none; \}/);
  assert.match(web('polish.css'), /html\.modal-open \.aurora > i \{ animation-play-state: paused; \}/);
});

test('V4 keeps the aurora still (the light field is the one moving layer under the glass)', () => {
  const polish = web('polish.css');
  assert.match(polish, /:root:not\(\[data-palette="classic"\]\) \.aurora > i \{ animation: none; \}/);
});

test('her orbs: no layout read per frame, and only real changes touch the page', () => {
  const orb = web('orb.js');
  const size = orb.slice(orb.indexOf('function sizeOrb('), orb.indexOf('function label('));
  assert.doesNotMatch(size, /getBoundingClientRect/, 'sizes come from a ResizeObserver');
  assert.match(orb, /new ResizeObserver\(/);
  assert.match(orb, /attributeFilter: \['class', 'style', 'data-theme', 'data-palette', 'data-accent'\]/, 'her state changes are not a recolour');
  assert.match(orb, /if \(root\.dataset\.herState !== now\) root\.dataset\.herState = now;/);
  // A long chat has a face per reply: only the newest one (and the header's) moves.
  assert.match(orb, /const stillOrb = \(o, latest\) => o\.msg && o !== latest;/);
  assert.match(orb, /msg: Boolean\(el\.closest\?\.\('#messages'\)\)/);
  assert.match(orb, /\[\.\.\.orbs\]\.some\(\(o\) => o\.visible && !stillOrb\(o, latest\)\)/, 'the loop sleeps when only still faces are in view');
});

test('glassPlan: blur behind panels is on, except in Firefox on Auto (each frame re-blurred the moving page there)', async () => {
  const { glassPlan, isFirefox } = await smooth();
  const FF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';
  const CH = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
  assert.equal(isFirefox(FF), true);
  assert.equal(isFirefox(CH), false);
  assert.equal(glassPlan(null, FF), 'off', 'Auto in Firefox: solid panels');
  assert.equal(glassPlan('auto', CH), 'on', 'Auto elsewhere: the glass');
  assert.equal(glassPlan('on', FF), 'on', 'his choice wins');
  assert.equal(glassPlan('off', CH), 'off');
  assert.equal(glassPlan('weird', CH), 'on', 'unknown values are Auto');
  const css = web('polish.css');
  assert.match(css, /html\[data-glass="off"\] \*, html\[data-glass="off"\] \*::before, html\[data-glass="off"\] \*::after, html\[data-glass="off"\] dialog::backdrop \{ -webkit-backdrop-filter: none !important; backdrop-filter: none !important; \}/);
  const html = web('index.html');
  assert.match(html, /<select id="ap-glass"><option value="auto">/);
  const tips = JSON.parse(web('tips.json'));
  assert.ok((tips.tips ?? tips)['ap-glass']?.[0], 'a ? tip');
  assert.match(web('app.js'), /root\.dataset\.glass = glassPlan\(localStorage\.getItem\('sara\.glass'\), navigator\.userAgent\);/);
});

test('watchModal: html.modal-open follows open windows (no :has() needed)', async () => {
  const { modalOpen } = await smooth();
  assert.equal(modalOpen({ querySelector: () => null }), false);
  assert.equal(modalOpen({ querySelector: (s: string) => (s === 'dialog:modal' ? {} : null) }), true);
  assert.equal(modalOpen({ querySelector: () => { throw new Error('old browser'); } }), false);
});
