// LAGFIX (docs/design/LAGFIX.md): sending a message in a long chat made the page (and the Windows
// app around it) feel stuck. The streamed reply was parsed and drawn whole on every frame, the page
// forced a layout before and after each draw, and nothing limited how often that ran. These pin the
// pure helpers (web/smooth.js) and their use, and the native app's slow-message log.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const smooth = () => import(pathToFileURL(join(ROOT, 'web', 'smooth.js')).href);

test('stableCut: finished blocks end at the last blank line outside an open code fence', async () => {
  const { stableCut } = await smooth();
  assert.equal(stableCut(''), 0);
  assert.equal(stableCut('Hello, still typing'), 0, 'one open paragraph: nothing finished');
  const two = 'First paragraph.\n\nSecond, still';
  assert.equal(two.slice(0, stableCut(two)), 'First paragraph.\n\n');
  const fence = 'Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n';
  assert.equal(fence.slice(0, stableCut(fence)), 'Intro.\n\n', 'a blank line inside an open fence is not an end');
  const closed = 'Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter';
  assert.equal(closed.slice(0, stableCut(closed)), 'Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n', 'a closed fence is finished');
  const tilde = 'A\n\n~~~\nx\n\ny';
  assert.equal(tilde.slice(0, stableCut(tilde)), 'A\n\n');
  const list = 'Steps:\n\n- one\n\n- two';
  assert.equal(list.slice(0, stableCut(list)), 'Steps:\n\n', 'a loose list stays one block while it grows');
  const quote = '> one\n\n> two';
  assert.equal(stableCut(quote), 0, 'a quote that goes on stays open');
  const trailing = 'Done.\n\n';
  assert.equal(stableCut(trailing), 0, 'no text after the blank line yet: the block may still be a list or a fence that goes on');
});

type FakeNode = { text: string; remove: () => void };
function fakeBody() {
  const kids: FakeNode[] = [];
  const body = {
    kids,
    renders: 0,
    append(frag: { childNodes: FakeNode[] }) {
      for (const n of frag.childNodes) {
        n.remove = () => kids.splice(kids.indexOf(n), 1);
        kids.push(n);
      }
    },
    replaceChildren() {
      kids.length = 0;
    },
  };
  const render = (s: string) => {
    body.renders++;
    return { childNodes: [{ text: s, remove: () => {} }] };
  };
  return { body, render, text: () => kids.map((k) => k.text).join('') };
}

test('streamBlocks: finished blocks are drawn once and kept; only the open tail is drawn again', async () => {
  const { streamBlocks } = await smooth();
  const { body, render, text } = fakeBody();
  let raw = 'One.';
  streamBlocks(body, raw, render);
  assert.equal(text(), 'One.');
  raw += '\n\nTwo';
  streamBlocks(body, raw, render);
  assert.deepEqual(body.kids.map((k) => k.text), ['One.\n\n', 'Two']);
  const first = body.kids[0];
  const before = body.renders;
  for (const more of [' more', ' words', ' here.']) {
    raw += more;
    streamBlocks(body, raw, render);
  }
  assert.equal(body.kids[0], first, 'the finished block is the same node (not parsed or drawn again)');
  assert.equal(body.renders - before, 3, 'one small draw per update: the tail only');
  assert.equal(text(), raw);
  // A replaced reply (a safety rewrite) that is not a continuation starts over.
  streamBlocks(body, 'Something else entirely', render);
  assert.equal(text(), 'Something else entirely');
});

test('paced: a stream of tokens draws at most once per STREAM_EVERY_MS, in a frame, and never drops the last one', async () => {
  const { paced, STREAM_EVERY_MS } = await smooth();
  assert.ok(STREAM_EVERY_MS >= 40 && STREAM_EVERY_MS <= 100, 'fast enough to read along, slow enough to rest the page');
  let now = 0;
  const frames: Array<() => void> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let draws = 0;
  const go = paced(() => draws++, { every: 50, now: () => now, raf: (cb: () => void) => frames.push(cb), timer: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }) });
  const tick = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    for (const f of frames.splice(0)) f();
  };
  go();
  tick(16);
  assert.equal(draws, 1, 'the first token shows in the next frame');
  // 40 tokens over ~1 s (one every 25 ms).
  for (let i = 0; i < 40; i++) {
    go();
    tick(25);
  }
  tick(100);
  assert.ok(draws >= 15 && draws <= 22, `about 20 draws a second, not one per token or frame (got ${draws})`);
  const was = draws;
  go();
  tick(100);
  assert.equal(draws, was + 1, 'the last token is drawn');
});

test('streamFrame takes the follow decision from the scroll tracker (no layout read before the draw)', async () => {
  const { streamFrame, followTracker } = await smooth();
  let reads = 0;
  const listeners: Record<string, () => void> = {};
  const box = {
    get scrollHeight() {
      reads++;
      return 5000;
    },
    scrollTop: 4100,
    clientHeight: 900,
    addEventListener(name: string, fn: () => void) {
      listeners[name] = fn;
    },
  };
  const f = followTracker(box);
  assert.equal(f.at, true, 'a new chat follows');
  assert.equal(followTracker(box), f, 'one tracker per box');
  let drawn = 0;
  streamFrame(box, () => drawn++, f.at);
  assert.equal(drawn, 1);
  assert.equal(reads, 1, 'one read: the scroll to the newest line after the draw');
  // Our own scroll is not a reader leaving the bottom.
  listeners.scroll();
  assert.equal(f.at, true);
  // He scrolls up to read: the next frames leave the view alone.
  box.scrollTop = 1000;
  listeners.scroll();
  assert.equal(f.at, false);
  reads = 0;
  streamFrame(box, () => drawn++, f.at);
  assert.equal(reads, 0, 'scrolled up: no layout read at all');
  assert.equal(box.scrollTop, 1000);
});

test('app.js: the streamed reply uses the paced, block-by-block draw', () => {
  const app = web('app.js');
  const queue = app.slice(app.indexOf('function queueReply('), app.indexOf('function bubble('));
  assert.match(queue, /paced\(/, 'paced draws');
  assert.match(queue, /followTracker\(/, 'follow from the scroll tracker');
  assert.match(queue, /classList\.contains\('typing'\)/, 'a draw queued after the reply ended does nothing');
  const set = app.slice(app.indexOf('function setReply('), app.indexOf('// While streaming, re-render'));
  assert.match(set, /streamBlocks\(/, 'partial replies draw block by block');
  assert.match(set, /_sb = null|delete body\._sb/, 'a full draw forgets the streaming state');
});

test('while she works the page animates only on the compositor (no box-shadow keyframes on the busy pulses)', () => {
  const keyframes = (css: string, name: string) => {
    const at = css.indexOf(`@keyframes ${name} `);
    assert.ok(at >= 0, name);
    let i = css.indexOf('{', at) + 1;
    for (let d = 1; d; i++) d += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    return css.slice(at, i);
  };
  const props = (block: string) => [...new Set([...block.replace(/@keyframes [\w-]+ \{/, '').matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))];
  for (const [file, name] of [['look.css', 'step-pulse'], ['her-panel.css', 'hp-breathe'], ['her-panel.css', 'hp-pulse'], ['v4-living.css', 'v4-breathe']]) {
    assert.deepEqual(props(keyframes(web(file), name)).filter((p) => p !== 'opacity' && p !== 'transform'), [], `${name} (${file}) animates only opacity/transform`);
  }
  // Her own picture: only the header one ripples (box-shadow keyframes), the others keep a steady ring.
  const rings = web('v4-pages.css').split('\n').filter((l) => /animation: v4d-ring-/.test(l));
  assert.equal(rings.length, 3);
  for (const l of rings) assert.match(l, /\] #her-face > img\.avatar \{ animation: v4d-ring-/);
});

test('Windows app: the message loop logs a message that kept the window busy (\"slow ui\")', () => {
  const main = readFileSync(join(ROOT, 'desktop/windows/src/main.cpp'), 'utf8');
  const loop = main.slice(main.lastIndexOf('while (GetMessageW(&msg'), main.lastIndexOf('BufferedPaintUnInit'));
  assert.match(loop, /g_loopWatch\.begin\(/);
  assert.match(loop, /g_loopWatch\.end\(/);
  assert.match(main, /g_loopWatch\.stage\(L"page: "/, 'page messages say which one');
  const h = readFileSync(join(ROOT, 'desktop/windows/src/ui-watch.h'), 'utf8');
  assert.match(h, /kSlowMs = 250/);
  assert.match(h, /kSlowEveryMs = 2000/);
  assert.match(main, /#ifdef SARA_TEST_HOOKS\n\s*startUiHeartbeat\(\);/, 'the heartbeat probe is a test-build hook');
  // The page too busy to answer (WebView2 "unresponsive") is said in desktop.log, never reloaded.
  assert.match(main, /add_ProcessFailed\([\s\S]{0,400}RENDER_PROCESS_UNRESPONSIVE[\s\S]{0,200}logLine\(L"page busy:/);
  // The same face every 5 s while she works is not decoded or written again.
  assert.match(main, /png\[3\] == 'G' && png != g_facePng\) \{/);
  // Modal loops (title-bar drag, menus) are not stalls.
  assert.match(h, /msg_ == WM_NCLBUTTONDOWN/);
  assert.match(main, /g_loopWatch\.modal\(\);  \/\/ LAGFIX: the menu's own loop/);
});

test('Windows app: ui-watch rules on a fake clock (native checks, when built)', { skip: !existsSync(join(ROOT, 'desktop/windows/build-test/Release/UiWatchChecks.exe')) }, () => {
  const out = execFileSync(join(ROOT, 'desktop/windows/build-test/Release/UiWatchChecks.exe'), { encoding: 'utf8' });
  assert.match(out, /^ALL OK/m, out);
});
