// ADULTAPPS: the desktop apps (not store-distributed) use Adult mode like a browser; the phone apps
// (store rules) keep refusing to turn it on, but show the Adult mode page with an Open in browser path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromPhoneApp, fromSaraApp } from '../src/http.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const req = (ua: string) => ({ headers: { 'user-agent': ua } }) as never;

test('adultapps: adult gating keys on the phone apps only', () => {
  assert.equal(fromPhoneApp(req('Mozilla/5.0 (Linux; Android 15) SaraPhone/1')), true);
  assert.equal(fromPhoneApp(req('Mozilla/5.0 (Windows NT 10.0) Edg/155.0 SaraDesktop/1 (Windows)')), false);
  assert.equal(fromSaraApp(req('SaraDesktop/1 (Mac)')), true, 'fromSaraApp still means any Sara app');
  for (const f of ['src/routes/her.ts', 'src/routes/connections.ts']) assert.doesNotMatch(read(f), /fromSaraApp\(req\)/, `${f}: adult checks use fromPhoneApp`);
  assert.match(read('src/server.ts'), /adultMode\?\.ask && !fromPhoneApp\(req\)/);
});

test('adultapps: the web shows the Adult mode page everywhere; adult rows are hidden in the phone apps only', () => {
  const nav = read('web/settings-nav.js');
  assert.doesNotMatch(nav, /p\.dataset\.page === 'you-adult'/, 'the page is no longer filtered out');
  const app = read('web/app.js');
  assert.match(app, /const adultOk = !\/\\bSaraPhone\\\/\\d\/\.test\(navigator\.userAgent\);/);
  assert.doesNotMatch(app, /SaraPhone\|SaraDesktop/);
});

test('adultapps: phone apps get state, Turn off and Open in browser (to this server\'s Adult mode page)', () => {
  const html = read('web/index.html');
  const page = html.slice(html.indexOf('data-page="you-adult"'), html.indexOf('</section>', html.indexOf('data-page="you-adult"')));
  for (const id of ['adult-state', 'adult-on-box', 'adult-off', 'adult-app-box', 'adult-open-browser']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.match(page, /Turning it on needs a web browser/);
  const app = read('web/app.js');
  const load = app.slice(app.indexOf('async function loadAdult()'), app.indexOf('// ---------- Today (Phase 15)'));
  assert.match(load, /\$\('#adult-on-box'\)\.hidden = !a\.on;/, 'Turn off shows whenever it is on (the apps too)');
  assert.match(load, /\$\('#adult-browser-row'\)\.hidden = a\.reason !== 'app';/, 'Open in browser only in the phone apps (not the demo)');
  assert.match(load, /`\$\{location\.origin\}\/#view=settings:you-adult`/);
  assert.match(load, /window\.SaraPhone\?\.openInBrowser/);
  const android = read('android/app/src/main/java/com/backstagecoding/sara/MainActivity.java');
  assert.match(android, /@JavascriptInterface\s+public void openInBrowser\(String url\)/);
  assert.match(android.slice(android.indexOf('public void openInBrowser')), /host\.equals\(u\.getHost\(\)\)/, 'only this server\'s pages');
});
