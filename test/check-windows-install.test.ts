// U1.3: the Windows install/update matrix check (scripts/check-windows-install.ts) and the TestInstall
// build's isolation from a real Sara on the same PC (desktop/windows/installer/sara.iss).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  TEST_APPID,
  REAL_APPID,
  parseRegQuery,
  checkStep,
  adminGuard,
  renderReport,
  STEPS,
  ADMIN_STEPS,
  setupArgs,
  type Snapshot,
} from '../scripts/check-windows-install.ts';

const ROOT = join(import.meta.dirname, '..');
const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
const testBlock = iss.slice(iss.indexOf('#ifdef TestInstall'), iss.indexOf('#else', iss.indexOf('#ifdef TestInstall')));
const releaseBlock = iss.slice(iss.indexOf('#else', iss.indexOf('#ifdef TestInstall')), iss.indexOf('#endif', iss.indexOf('#ifdef TestInstall')));

test('TestInstall: her server data and sign-in start never share a real Sara\'s', () => {
  // A test install "on this computer" used the real data folders and the real Run value before U1.3.
  assert.match(testBlock, /#define AppUserData "\{localappdata\}\\SaraUpdTest\\server-data"/);
  assert.match(testBlock, /#define AppAllData "\{commonappdata\}\\SaraUpdTest"/);
  assert.match(testBlock, /#define AppRunName "Sara update test server"/);
  assert.match(releaseBlock, /#define AppUserData "\{localappdata\}\\Sara\\data"/);
  assert.match(releaseBlock, /#define AppAllData "\{commonappdata\}\\Sara"/);
  assert.match(releaseBlock, /#define AppRunName "Sara server"/);
  assert.match(iss, /ValueName: "\{#AppRunName\}"/);
  assert.doesNotMatch(iss, /ValueName: "Sara server"/);
  assert.match(iss, /ExpandConstant\('\{#AppAllData\}'\)/);
  assert.match(iss, /ExpandConstant\('\{#AppUserData\}'\)/);
});

const fakeLoc = (v: string) => `C:\\Users\\tester\\AppData\\Local\\Programs\\SaraUpdTest${v}`;
const regOut = (ver: string, loc: string) =>
  [
    '',
    `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${TEST_APPID}}_is1`,
    '    DisplayName    REG_SZ    Sara update test',
    `    DisplayVersion    REG_SZ    ${ver}`,
    `    InstallLocation    REG_SZ    ${loc}\\`,
    `    UninstallString    REG_SZ    "${loc}\\unins000.exe"`,
    '',
  ].join('\r\n');

test('reg query output is read into an uninstall entry', () => {
  const e = parseRegQuery(regOut('3.90.2', fakeLoc('')));
  assert.equal(e?.DisplayVersion, '3.90.2');
  assert.equal(e?.InstallLocation, fakeLoc('') + '\\');
  assert.equal(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.notEqual(TEST_APPID, REAL_APPID);
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  hkcu: { DisplayVersion: '3.90.1', InstallLocation: fakeLoc('') + '\\' },
  hklm: null,
  standalone: null,
  realHkcu: null,
  realHklm: null,
  files: { 'Sara.exe': true, 'unins000.exe': true, 'SaraService.exe': false },
  dataIni: 'server=http://127.0.0.1:1',
  started: true,
  ...over,
});

test('each step: exactly one entry, its version, files, start, data where expected', () => {
  const want = { entries: 1, version: '3.90.1', files: ['Sara.exe', 'unins000.exe'], noFiles: ['SaraService.exe'], start: true, data: 'kept' as const };
  assert.deepEqual(checkStep(snap(), want, snap()), []);
  assert.match(checkStep(snap({ hklm: { DisplayVersion: '3.90.1' } }), want, snap()).join(' '), /2 uninstall entries/);
  assert.match(checkStep(snap({ hkcu: { DisplayVersion: '3.90.2' } }), want, snap()).join(' '), /version 3\.90\.2, wanted 3\.90\.1/);
  assert.match(checkStep(snap({ files: { 'Sara.exe': false, 'unins000.exe': true } }), want, snap()).join(' '), /Sara\.exe missing/);
  assert.match(checkStep(snap({ files: { 'Sara.exe': true, 'unins000.exe': true, 'SaraService.exe': true } }), want, snap()).join(' '), /SaraService\.exe should not be there/);
  assert.match(checkStep(snap({ started: false }), want, snap()).join(' '), /did not start/);
  assert.match(checkStep(snap({ dataIni: null }), want, snap()).join(' '), /data folder lost/);
  // The real Sara's entries must stay exactly as they were before the run.
  assert.match(checkStep(snap({ realHkcu: { DisplayVersion: '9.9.9' } }), want, snap()).join(' '), /real Sara's entry changed/);
  // Gone: no entry, no files, data deleted (full uninstall) or kept (/KEEPDATA).
  const gone = { entries: 0, files: [], noFiles: ['Sara.exe'], start: false, data: 'gone' as const };
  assert.deepEqual(checkStep(snap({ hkcu: null, files: { 'Sara.exe': false }, dataIni: null, started: false }), gone, snap()), []);
  assert.match(checkStep(snap({ hkcu: null, files: { 'Sara.exe': false }, started: false }), gone, snap()).join(' '), /data still there/);
});

test('the matrix covers every case the roadmap names, the all-users ones in the admin script', () => {
  const ids = STEPS.map((s) => s.id);
  for (const id of ['fresh', 'self-update', 'reinstall', 'downgrade', 'manual-setup', 'stale-saradesktop', 'uninstall-keepdata', 'full-uninstall']) assert.ok(ids.includes(id), id);
  const admin = ADMIN_STEPS.map((s) => s.id);
  for (const id of ['allusers-fresh', 'duplicate-scope', 'allusers-uninstall']) assert.ok(admin.includes(id), id);
  // Every per-user Setup run is the test build, this user, the app only and silent.
  const a = setupArgs('C:\\x\\log.txt', 'http://127.0.0.1:5');
  for (const s of ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/MODE=remote', '/CURRENTUSER', '/SERVER=http://127.0.0.1:5']) assert.ok(a.includes(s), s);
  assert.ok(!a.includes('/ALLUSERS'));
});

test('the admin script refuses when anything of a real Sara is on the PC', () => {
  assert.deepEqual(adminGuard({ service: false, task: false, programData: false, realEntry: false }), []);
  const why = adminGuard({ service: true, task: true, programData: true, realEntry: true }).join(' ');
  for (const w of [/service/, /Update task/, /ProgramData/, /real Sara/]) assert.match(why, w);
  const ps1 = readFileSync(join(ROOT, 'scripts', 'check-windows-install-admin.ps1'), 'utf8');
  assert.match(ps1, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/, 'checks it is elevated');
  assert.match(ps1, /\/DATA=/, 'never the real ProgramData\\Sara');
  assert.match(ps1, /Get-Service -Name Sara/, 'refuses next to a real Sara service');
  assert.doesNotMatch(ps1, /6F0B2C1E-7A51-4C8B-9E2D-3B5A0C9D4E17\}_is1['"]\s*\|\s*Remove/, 'never removes the real entry');
});

test('the report says pass/fail per step and lists what needs an administrator', () => {
  const md = renderReport({
    date: '2026-11-17',
    elevated: false,
    versions: ['3.90.0', '3.90.1', '3.90.2'],
    results: [
      { id: 'fresh', title: 'Fresh install', problems: [], notes: ['entry HKCU 3.90.1'] },
      { id: 'downgrade', title: 'Downgrade', problems: ['version 3.90.2, wanted 3.90.0'], notes: [] },
    ],
    skipped: ADMIN_STEPS.map((s) => s.title),
    cleanup: ['removed the test install folder'],
  });
  assert.match(md, /# Windows install\/update matrix — 2026-11-17/);
  assert.match(md, /\| Fresh install \| pass \|/);
  assert.match(md, /\| Downgrade \| FAIL \|/);
  assert.match(md, /check-windows-install-admin\.ps1/);
  assert.match(md, /1 of 2 steps passed/);
});
