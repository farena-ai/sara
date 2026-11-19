// V4.5 Screen companion (docs/design/V4SCREEN.md): opt-in, local only. The Windows app looks at the
// window in front every few seconds (its title and short texts, read on the computer), and when an
// error dialog or a stuck form shows, offers help in one small bubble. Off by default, a pause button,
// one offer per thing seen, nothing kept or sent. The rules live in src/screen-companion.ts (reference)
// and are ported as fixed lists to desktop/windows/src/screen-watch.cpp; fake screens only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ERROR_WORDS, FORM_WORDS, HANG_WORDS, SCREEN_WATCH, ScreenWatch, hasWord, screenFinding } from '../src/screen-companion.ts';
import { FAKE_SCREENS } from './fixtures/fake-screens.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const look = (name: string) => FAKE_SCREENS.find((s) => s.name === name)!.look;

test('every fake screen gives the expected finding', () => {
  for (const s of FAKE_SCREENS) {
    const f = screenFinding(s.look);
    assert.equal(f?.kind ?? '', s.kind, s.name);
    if (s.line) assert.equal(f?.line, s.line, s.name);
  }
});

test('words match whole words only, accents and case folded', () => {
  assert.ok(hasWord('Error: disk full', ERROR_WORDS));
  assert.ok(!hasWord('Terrorbird', ERROR_WORDS));
  assert.ok(hasWord('ÉCHEC de connexion', ERROR_WORDS));
  assert.ok(hasWord('Word (Not Responding)', HANG_WORDS));
  assert.ok(hasWord('Dieses Feld ist erforderlich', FORM_WORDS));
});

test('off by default: nothing is offered until switched on', () => {
  const w = new ScreenWatch();
  assert.equal(w.on, false);
  assert.equal(w.check(look('error dialog'), 0), undefined);
});

test('a fake screen with an error text triggers ONE offer', () => {
  const w = new ScreenWatch();
  w.on = true;
  const offers = [];
  for (let i = 0; i < 20; i++) {
    const o = w.check(look('error dialog'), i * SCREEN_WATCH.everyMs);
    if (o) offers.push(o);
  }
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0], { kind: 'error', app: 'Invoice Maker', line: 'Could not save "march.inv": the disk is full.' });
  // Even after the cool-down the same error is not offered again.
  assert.equal(w.check(look('error dialog'), 60 * 60_000), undefined);
});

test('a stuck form is offered only after it stays for a while', () => {
  const w = new ScreenWatch();
  w.on = true;
  const form = look('stuck form');
  assert.equal(w.check(form, 0), undefined);
  assert.equal(w.check(form, 5000), undefined);
  const o = w.check(form, 10_000);
  assert.equal(o?.kind, 'form');
  // Fixed in between (another look) starts the count again.
  const w2 = new ScreenWatch();
  w2.on = true;
  w2.check(form, 0);
  w2.check(form, 5000);
  w2.check(look('plain document mentioning errors'), 10_000);
  assert.equal(w2.check(form, 15_000), undefined);
});

test('pause stops offers until it ends; a cool-down spaces two offers', () => {
  const w = new ScreenWatch();
  w.on = true;
  w.pause(60 * 60_000, 0);
  assert.equal(w.check(look('error dialog'), 1000), undefined);
  assert.ok(w.pausedFor(1000) > 0);
  assert.ok(w.check(look('error dialog'), 60 * 60_000 + 1));
  assert.equal(w.check(look('german error dialog'), 60 * 60_000 + 5000), undefined, 'cool-down');
  assert.ok(w.check(look('german error dialog'), 60 * 60_000 + 1 + SCREEN_WATCH.cooldownMs));
  w.pause(0, 0);
  assert.equal(w.pausedFor(0), 0);
});

test('hidden and Sara\'s own windows are never offered', () => {
  const w = new ScreenWatch();
  w.on = true;
  assert.equal(w.check(look('hidden window (password manager)'), 0), undefined);
  assert.equal(w.check(look('Sara\'s own window'), 200_000), undefined);
});

test('nothing is kept: the watch holds numbers only, and the module has no files or network', () => {
  const w = new ScreenWatch();
  w.on = true;
  w.check(look('error dialog'), 0);
  w.check(look('stuck form'), 5000);
  const kept = JSON.stringify(w.memory());
  assert.doesNotMatch(kept, /march|Invoice|Email|required/i);
  assert.match(kept, /^\{"offered":\[\d+(,\d+)*\],"streak":\{"fp":\d+,"n":\d+\}/);
  const src = read('src', 'screen-companion.ts');
  assert.doesNotMatch(src, /from 'node:fs'|netFetch|fetch\(|writeFile|appendFile|audit\(/);
  for (let i = 0; i < 200; i++) w.check({ title: 'X', app: 'A' + i, dialog: true, texts: ['Error ' + i] }, 1e9 + i * SCREEN_WATCH.cooldownMs);
  assert.ok(w.memory().offered.length <= SCREEN_WATCH.remember, 'a short list of hashes');
});

// ---------- the Windows app's port ----------
const cpp = () => read('desktop', 'windows', 'src', 'screen-watch.cpp');
const main = () => read('desktop', 'windows', 'src', 'main.cpp');

test('the Windows port has the same word lists and limits', () => {
  const c = cpp();
  for (const w of [...ERROR_WORDS, ...FORM_WORDS, ...HANG_WORDS]) assert.ok(c.includes(`L"${w.replace(/"/g, '\\"')}"`), `missing in screen-watch.cpp: ${w}`);
  const list = (name: string) => (c.match(new RegExp(`${name}\\[\\] = \\{([^}]*)\\}`))?.[1].match(/L"/g) ?? []).length;
  assert.equal(list('kErrorWords'), ERROR_WORDS.length);
  assert.equal(list('kFormWords'), FORM_WORDS.length);
  assert.equal(list('kHangWords'), HANG_WORDS.length);
  for (const [k, v] of Object.entries(SCREEN_WATCH)) assert.match(read('desktop', 'windows', 'src', 'screen-watch.h'), new RegExp(`k${k[0].toUpperCase()}${k.slice(1)} = ${v}\\b`), k);
  assert.match(read('desktop', 'windows', 'CMakeLists.txt'), /src\/screen-watch\.cpp/);
});

test('the Windows port reads locally, skips hidden/own windows and password fields, never writes', () => {
  const c = cpp();
  assert.match(c, /sarascreen::hiddenKindOf\(/);
  assert.match(c, /get_CurrentIsPassword/);
  assert.match(c, /sarascreen::maskSecrets/);
  assert.match(c, /#32770/, 'classic dialogs');
  assert.doesNotMatch(c, /WinHttp|WritePrivateProfile|CreateFileW|fopen|ofstream|logLine/);
  // The app: off by default, pause, the bubble is the quick-ask page; the text is never logged.
  const m = main();
  assert.match(m, /prefOn\(L"screenCompanion", false\)/);
  assert.match(m, /key == L"screenCompanion"/);
  assert.match(m, /key == L"screenPause"/);
  assert.match(m, /saraQuick\.offer/);
  assert.match(m, /SW_SHOWNOACTIVATE/, 'the bubble never takes the focus');
  assert.doesNotMatch(m, /logLine\([^;]*offer\.line/);
  assert.match(m, /\\"screenCompanion\\":/, 'getPrefs tells the page');
  // Live checks look at a fake window by title, in test builds only (never the window in front).
  assert.match(m, /#ifdef SARA_TEST_HOOKS\n  \/\/ Test builds: SARA_TEST_SCREEN_TITLE[\s\S]{0,300}FindWindowW\(nullptr, testTitle\);\n#endif/);
  // The look runs on a worker thread; the bubble goes away by itself.
  assert.match(m, /std::thread\(\[fg, to\][\s\S]{0,200}sarawatch::lookAt\(fg\)/);
  assert.match(m, /SetTimer\(g_wnd, kScreenHideTimer, 30000, nullptr\)/);
});

test('the bubble in the quick-ask page: help, not now, pause', () => {
  const p = read('desktop', 'shared', 'quick-ask.html');
  assert.match(p, /id="offer"/);
  assert.match(p, /offer\(o = \{\}\)/);
  for (const act of ['help', 'dismiss', 'pause']) assert.match(p, new RegExp(`act: '${act}'`));
  assert.match(p, /Help with this/);
  assert.match(p, /Pause for 1 hour/);
});

test('Settings → This computer has the switch and the pause, with tips', () => {
  const h = read('web', 'index.html');
  const page = h.slice(h.indexOf('data-page="desktop-app"'), h.indexOf('</section>', h.indexOf('data-page="desktop-app"')));
  assert.match(page, /<h3>Screen companion <button type="button" class="tip"/);
  assert.match(page, /id="dk-screen" type="checkbox"/);
  assert.match(page, /id="dk-screen-pause"/);
  // The page module: the bridge keys the app knows, and a note where the app has no screen companion.
  const js = read('web', 'screen-companion.js');
  assert.match(js, /setPref', \{ key, value \}/);
  assert.match(js, /set\('screenCompanion'/);
  assert.match(js, /set\('screenPause', Number\(p\?\.screenPausedMin\) > 0 \? '0' : '60'\)/);
  assert.match(js, /Update the Sara app to use this\./); // W0.5: the Mac app has it too (test/w0-mac.test.ts)
  assert.match(read('web', 'app.js'), /fillScreen\(p\);/);
  const tips = JSON.parse(read('web', 'tips.json'));
  assert.ok(tips['dk-screen'] || /id="dk-screen" type="checkbox"[^>]*> [^<]+<button type="button" class="tip"/.test(page));
});

// ---------- the Windows port, run (needs the test build: desktop/windows cmake -B build-test -DSARA_TEST_HOOKS=ON) ----------
const BIN = join(ROOT, 'desktop', 'windows', 'build-test', 'Release');
const EXE = process.env.SARA_SCREEN_NATIVE ?? join(BIN, 'ScreenWatchChecks.exe');
const nativeSkip = process.platform !== 'win32' ? 'Windows only' : !existsSync(EXE) ? 'build the test app first (desktop/windows: cmake -B build-test -DSARA_TEST_HOOKS=ON, target ScreenWatchChecks)' : false;
const U = '\x1f', R = '\x1e';
const fields = (l: { title: string; app: string; dialog: boolean; hidden?: string; own?: boolean; texts: string[] }) => [l.title, l.app, l.dialog ? '1' : '0', l.hidden ?? '', l.own ? '1' : '0', l.texts.join(R)].join(U);
const run = (lines: string[]) => execFileSync(EXE, [], { input: lines.join('\n') + '\n', encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

test('native: the same findings on every fake screen', { skip: nativeSkip }, () => {
  const out = run(FAKE_SCREENS.map((s) => 'F' + U + fields(s.look)));
  FAKE_SCREENS.forEach((s, i) => {
    const want = screenFinding(s.look);
    assert.equal(out[i], (want?.kind ?? '') + U + (want?.line ?? ''), s.name);
  });
});

test('native: the same offers, pause and cool-down as the reference', { skip: nativeSkip }, () => {
  const w = new ScreenWatch();
  w.on = true;
  const seq: [number, string][] = [];
  const steps = ['error dialog', 'error dialog', 'stuck form', 'stuck form', 'stuck form', 'german error dialog', 'stuck form', 'german error dialog'];
  steps.forEach((n, i) => seq.push([i * 50_000, n]));
  const lines = ['ON', ...seq.map(([at, n]) => 'C' + U + at + U + fields(look(n)))];
  const out = run(lines);
  assert.equal(out[0], 'ok');
  seq.forEach(([at, n], i) => {
    const o = w.check(look(n), at);
    assert.equal(out[i + 1], o ? [o.kind, o.app, o.line].join(U) : '-', `${i}: ${n}`);
  });
  assert.ok(out.filter((x) => x !== '-' && x !== 'ok').length >= 2);
  assert.equal(run(['P' + U + '3600000' + U + '1000'])[0], '3600000');
});

test('native: the real reader on fake windows (off-screen, found by title): one offer each, no typed value or password', { skip: nativeSkip }, () => {
  const out = execFileSync(EXE, ['--live', join(BIN, 'ScreenWatchFixture.exe')], { encoding: 'utf8', timeout: 30_000 }).split(/\r?\n/).filter(Boolean).map((l) => l.split(U));
  const by = Object.fromEntries(out.map((f) => [f[0], f]));
  assert.deepEqual(by.error.slice(1, 7), ['error', 'Could not save "march.inv": the disk is full.', '1', '0', '0', '1']);
  assert.deepEqual(by.form.slice(1, 7), ['form', 'Email is required.', '0', '0', '0', '1']);
});
