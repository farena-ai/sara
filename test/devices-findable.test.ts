// 3.0.3 (owner): the sign-in code for a new phone or computer must be easy to find. Devices and sign-in
// leads Settings → Connections, search and Ctrl K find it by the words people type, Ctrl K and Help can
// start a code straight away, and every hint names the same place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const html = read('web', 'index.html');
const nav = read('web', 'settings-nav.js');
const app = read('web', 'app.js');
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test('devices: Devices and sign-in leads Connections, its id (and every old link) unchanged', () => {
  assert.match(html, /<section class="settings-page" data-page="dh-devices" data-group="Connections" data-title="Devices and sign-in"/);
  const order = /const SETTINGS_ORDER = \[([\s\S]*?)\];/.exec(nav)![1].match(/'([\w-]+)'/g)!.map((s) => s.slice(1, -1));
  assert.equal(order[order.indexOf('co-phone') - 1], 'dh-devices', 'first in Connections, right before Phone');
  // Old deep links (settings:dh-devices, the account page's button) still land.
  assert.match(read('src', 'safety-check.ts'), /open: 'settings:dh-devices'/);
  assert.match(read('web', 'household.js'), /showSettingsTab\('dh-devices'\)/);
  assert.match(read('src', 'safety-check.ts'), /'dh-devices': 'Connections → Devices and sign-in'/);
});

test('devices: Settings search and Ctrl K find it by the words people use', async () => {
  const search: Any = await import(pathToFileURL(join(ROOT, 'web', 'settings-search.js')).href);
  const kw = search.SETTINGS_KEYWORDS['dh-devices'].map(search.foldText);
  const rec = (id: string, title: string, group: string, keywords: string[] = []) => ({ id, title: search.foldText(title), group: search.foldText(group), was: '', keywords: keywords.map(search.foldText), questions: [], head: '', body: '' });
  const recs = [
    rec('co-phone', 'Phone and notifications', 'Connections', search.SETTINGS_KEYWORDS['co-phone']),
    rec('co-signal', 'Signal', 'Chat apps', search.SETTINGS_KEYWORDS['co-signal']),
    rec('ab-projects', 'Coding projects', 'Coding', search.SETTINGS_KEYWORDS['ab-projects']),
    rec('dh-devices', 'Devices and sign-in', 'Connections', search.SETTINGS_KEYWORDS['dh-devices']),
  ];
  for (const q of ['code', 'pairing', 'pair', 'add device', 'add computer', 'add phone', 'sign in another device', 'desktop app', 'QR', 'add a phone or computer', 'código', 'emparejar', 'appairer', 'Gerät hinzufügen', 'codice', 'parear']) {
    assert.equal(search.rankPages(q, recs)[0]?.id, 'dh-devices', q);
  }
  assert.ok(kw.includes('qr'));
  // Phone still finds the phone page first.
  assert.equal(search.rankPages('notifications', recs)[0]?.id, 'co-phone');
});

test('devices: a Ctrl K action and a Help entry open the page and start the code', () => {
  assert.match(app, /add\('pair', 'phone', t\('Add a phone or computer'\), \(\) => startPairing\(\)/);
  const fn = app.slice(app.indexOf('async function startPairing()'), app.indexOf('\n}\n', app.indexOf('async function startPairing()')));
  assert.match(fn, /await openSettings\(DEVICES_PAGE\);[\s\S]*\$\('#pair-new'\)\.click\(\)/);
  assert.match(html, /<button id="help-pair" type="button" class="pick-card"><strong>Add a phone or computer<\/strong>/);
  assert.match(app, /\$\('#help-pair'\)\?\.addEventListener\('click', \(\) => \{\s*\$\('#help-menu'\)\.close\(\);\s*void startPairing\(\);/);
});

test('devices: every hint names Settings → Connections → Devices and sign-in', () => {
  assert.match(read('web', 'devices-path.js'), /t\('Settings → Connections → Devices and sign-in'\)/);
  assert.equal((read('web', 'pair.js').match(/devicesPath\(t\)/g) ?? []).length, 3);
  assert.equal((app.match(/\{ path: devicesPath\(t\) \}/g) ?? []).length, 2);
  for (const f of ['desktop/windows/src/main.cpp', 'desktop/mac/Sources/main.swift', 'desktop/windows/installer/sara.iss', 'android/app/src/main/res/values/strings.xml', 'ios/Sara/SetupView.swift', 'docs/INSTALL.md', 'web/help.html']) {
    const s = read(f);
    assert.match(s, /Settings → Connections → Devices and sign-in/, f);
    assert.doesNotMatch(s, /Data (&amp;|&) health → Devices/, f);
  }
  assert.match(read('src', 'server.ts'), /approveIn: 'Settings → Connections → Devices and sign-in'/);
});
