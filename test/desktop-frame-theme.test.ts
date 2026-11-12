// 3.5.2: a white bar above a dark page in the Windows app (a friend's Windows 11 Home in dark mode).
// The frame colour is kept per theme (frameNight / frameDay); the app picked the slot by its own
// reading of the registry, the page by its own prefers-color-scheme. When they disagreed, the
// page's light top colour went into the Night slot and stayed there. Now the page says what it
// shows, stale or contradicting colours are dropped, a Mica choice left by an older page isn't
// restored, and desktop.log / the check-in say enough to tell from afar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appInstallView, cleanCheckin } from '../src/app-installs.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const cpp = read('desktop', 'windows', 'src', 'main.cpp');
const app = read('web', 'app.js');

test('the page says what it really shows; the app follows it over the registry', () => {
  assert.match(app, /const shown = root\.dataset\.theme === 'light' \? 'day' : 'night';/);
  assert.match(app, /saraShellSay\?\.\(\{ type: 'theme', theme: shellTheme, shown, \.\.\.\(frame \? \{ frame \} : \{\}\), \.\.\.\(titlebar \? \{ titlebar: true \} : \{\}\) \}\)/);
  assert.match(cpp, /static void setTheme\(std::wstring pref, const std::wstring& shown = L""\)/);
  assert.match(cpp, /bool day = shown == L"day" \? true : shown == L"night" \? false : resolveDay\(pref\);/);
  assert.match(cpp, /setTheme\(m\[L"theme"\], m\[L"shown"\]\);\s*\/\/ wintop[^\n]*\n\s*setFrameColor\(m\[L"frame"\]\);/, 'the theme first, so the frame lands in the slot of the theme shown');
});

test('a light Night frame (or a dark Day frame) kept from before is not used', () => {
  const load = cpp.slice(cpp.indexOf('static void loadFrameColors()'), cpp.indexOf('static UINT windowDpi()'));
  assert.match(load, /i == 0 \? luma > 140 : luma < 110/);
  assert.match(load, /g_frameSet\[i\] = false;/);
});

test('Mica only when a page asks for it in this run (not from desktop.ini)', () => {
  assert.match(cpp, /g_wantMica = false;\n/);
  assert.doesNotMatch(cpp, /g_wantMica = getPref\(L"backdrop"\) == L"mica"/);
});

test('desktop.log: the system, its light/dark, accent title bars, high contrast, and every frame decision', () => {
  assert.match(cpp, /static std::wstring osLabel\(\)/);
  assert.match(cpp, /EditionID/);
  assert.match(cpp, /osLabel\(\) \+ L", system " \+ \(systemUsesLight\(\) \? L"light" : L"dark"\)/);
  assert.match(cpp, /ColorPrevalence/);
  assert.match(cpp, /SPI_GETHIGHCONTRAST/);
  assert.match(cpp, /static void logThemeState\(\)/);
  assert.match(cpp, /g_captionHr = DwmSetWindowAttribute\(g_wnd, DWMWA_CAPTION_COLOR/);
  const apply = cpp.slice(cpp.indexOf('static void applyTheme()'), cpp.indexOf('static void setTheme('));
  assert.match(apply, /logThemeState\(\);\n\}/);
});

test('test builds only: another Windows build and system light/dark without touching the PC', () => {
  for (const env of ['SARA_TEST_WINBUILD', 'SARA_TEST_SYSTEM_THEME']) {
    const i = cpp.indexOf(`L"${env}"`);
    assert.ok(i > 0, env);
    const before = cpp.slice(0, i);
    assert.ok(before.lastIndexOf('#ifdef SARA_TEST_HOOKS') > before.lastIndexOf('#endif'), `${env} only in test builds`);
  }
});

test('check-in: the app says its system; Settings → Devices shows it', () => {
  assert.match(cpp, /\\"os\\":\\"" \+ jsonEscape\(osLabel\(\)\)/);
  assert.match(app, /os: p\.os \?\? ''/);
  assert.match(app, /\$\{a\.os \? ` \(\$\{a\.os\}\)` : ''\}/);
  const c = cleanCheckin({ platform: 'windows', version: '3.5.1', computer: 'SheltonLaptop', os: 'Windows 11 Home (26100.4061)\n', how: 'remote' });
  assert.equal(c.os, 'Windows 11 Home (26100.4061)');
  assert.equal(cleanCheckin({ platform: 'windows', version: '3.5.1' }).os, undefined, 'older apps say nothing');
  assert.equal(cleanCheckin({ platform: 'windows', version: '3.5.1', os: 'x'.repeat(200) }).os?.length, 60);
  const v = appInstallView('d1', { ...c, seenAt: new Date().toISOString() }, '3.5.1');
  assert.equal(v.os, 'Windows 11 Home (26100.4061)');
});

// Fred fix A (3.6.1+): the white bar stayed on a friend's Windows 11 Home (26200) in dark mode after
// 3.6.0 and could not be seen on the owner's PC (nor on this PC with the test hooks: dark, Windows
// 11 Home's build, the app's frame and Windows' frame). The app now says how it draws its window's
// top in its check-in, and every theme message says again that the page draws the title strip.
test('the check-in carries the frame decision: who draws the strip, its colour, the theme shown, what the page said', () => {
  assert.match(cpp, /static std::wstring frameReport\(\)/);
  const r = cpp.slice(cpp.indexOf('static std::wstring frameReport()'), cpp.indexOf('/** Title bar colours, Mica'));
  for (const part of ['L"strip "', 'hexOfColor(themeColor())', 'L", shown "', 'L", page said "', 'L", regions "', 'L", mica "', 'L", caption "']) assert.ok(r.includes(part), part);
  assert.match(cpp, /\\"frame\\":\\"" \+ jsonEscape\(frameReport\(\)\)/);
  assert.match(app, /frame: p\.frame \?\? ''/);
  const c = cleanCheckin({ platform: 'windows', version: '3.6.1', os: 'Windows 11 Home (26200.9711)', frame: 'strip app, #0f0d17 builtin, shown night, pref night, page said 0x, regions yes, mica off, caption ok, dpi 144\n' });
  assert.equal(c.frame, 'strip app, #0f0d17 builtin, shown night, pref night, page said 0x, regions yes, mica off, caption ok, dpi 144');
  assert.equal(appInstallView('d1', { ...c, seenAt: new Date().toISOString() }, '3.6.1').frame, c.frame);
  assert.equal(cleanCheckin({ platform: 'windows', version: '3.6.0' }).frame, undefined, 'older apps say nothing');
});

test('every theme message re-says the page draws the title strip; the app takes it from there too', () => {
  const theme = cpp.slice(cpp.indexOf('if (m[L"type"] == L"theme" || kind == L"theme")'), cpp.indexOf('setFrameColor(m[L"frame"]);'));
  assert.match(theme, /if \(m\[L"titlebar"\] == L"true"\) \{\s*g_pageTitleSaid\+\+;\s*setPageTitle\(true, pageOrigin\(source\)\);/);
  const boot = read('web', 'theme-boot.js');
  assert.match(boot, /addEventListener\('pageshow'[\s\S]*?e\.persisted[\s\S]*?type: 'shell', titlebar: true/);
  assert.match(cpp, /g_regions = regions;/);
  assert.match(cpp, /buffered paint failed/);
});
