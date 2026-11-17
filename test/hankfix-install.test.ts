// HANKFIX (docs/desktop.md "One Sara in Settings → Apps"): an update or reinstall always lands on
// the existing install. The scope (all users / this user) comes from the install that owns the app
// folder; a second entry for Sara (the other scope, or the old self-installed SaraDesktop entry) is
// found and the stale one (the one not running) is named for removal. No real installs here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { duplicateInstalls, installsFromReg, SARA_APP_ID, scopeFor, type InstallEntry } from '../src/install-scope.ts';
import { windowsDriver } from '../src/update-apply.ts';
import { ROOT } from './helpers.ts';

const HKCU_LOC = 'C:\\Users\\hank\\AppData\\Local\\Programs\\Sara';
const HKLM_LOC = 'C:\\Program Files\\Sara';
const user: InstallEntry = { scope: 'user', kind: 'setup', location: HKCU_LOC, uninstall: `"${HKCU_LOC}\\unins000.exe"`, version: '3.17.0' };
const all: InstallEntry = { scope: 'all', kind: 'setup', location: HKLM_LOC, uninstall: `"${HKLM_LOC}\\unins000.exe"`, version: '3.18.0' };
const standalone: InstallEntry = { scope: 'user', kind: 'standalone', location: HKCU_LOC, uninstall: `"${HKCU_LOC}\\Sara.exe" --uninstall`, version: '3.10.0' };

test('reg query output: Inno entries for both scopes and the old self-installed SaraDesktop entry', () => {
  const out = (loc: string, ver: string, unins: string) =>
    `\r\nHKEY_X\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${SARA_APP_ID}}_is1\r\n    InstallLocation    REG_SZ    ${loc}\\\r\n    DisplayVersion    REG_SZ    ${ver}\r\n    UninstallString    REG_SZ    ${unins}\r\n    DisplayName    REG_SZ    Sara\r\n`;
  const entries = installsFromReg({ hkcu: out(HKCU_LOC, '3.17.0', `"${HKCU_LOC}\\unins000.exe"`), hklm: out(HKLM_LOC, '3.18.0', `"${HKLM_LOC}\\unins000.exe"`), standalone: '' });
  assert.deepEqual(entries.map((e) => [e.scope, e.kind, e.location, e.version]), [
    ['all', 'setup', HKLM_LOC, '3.18.0'],
    ['user', 'setup', HKCU_LOC, '3.17.0'],
  ]);
  assert.equal(entries[0].uninstall, `"${HKLM_LOC}\\unins000.exe"`);
  assert.deepEqual(installsFromReg({ hkcu: '', hklm: 'ERROR: The system was unable to find the specified registry key or value.', standalone: out(HKCU_LOC, '3.10.0', `"${HKCU_LOC}\\Sara.exe" --uninstall`) }).map((e) => e.kind), ['standalone']);
});

test('the scope of an update is the scope of the install that owns the app folder', () => {
  assert.equal(scopeFor([user, all], HKLM_LOC), 'all');
  assert.equal(scopeFor([user, all], `${HKCU_LOC.toUpperCase()}\\`), 'user', 'case and a trailing backslash do not matter');
  assert.equal(scopeFor([all], 'D:\\elsewhere'), undefined, 'a folder Setup does not own: the caller decides (no guess)');
  assert.equal(scopeFor([user, all], 'D:\\elsewhere'), undefined, 'two installs and neither owns the folder: no guess');
  assert.equal(scopeFor([], HKLM_LOC), undefined);
  assert.equal(scopeFor([standalone], HKCU_LOC), undefined, 'the self-installed app has no Setup scope');
});

test('duplicates: the install not running is stale; the old SaraDesktop entry goes when Setup owns Sara', () => {
  assert.deepEqual(duplicateInstalls([user], HKCU_LOC), []);
  assert.deepEqual(duplicateInstalls([user, all], HKLM_LOC).map((d) => [d.entry.scope, d.how]), [['user', 'uninstall']]);
  assert.deepEqual(duplicateInstalls([user, all], HKCU_LOC).map((d) => [d.entry.scope, d.how]), [['all', 'admin']], 'an all-users copy needs an administrator: the person is told');
  // Both Setup installs and Sara runs from neither (a portable copy): nothing is removed.
  assert.deepEqual(duplicateInstalls([user, all], 'D:\\portable'), []);
  // SaraDesktop listed for the same folder Setup owns: only its entry goes (never the files).
  assert.deepEqual(duplicateInstalls([user, standalone], HKCU_LOC).map((d) => [d.entry.kind, d.how]), [['standalone', 'entry']]);
  // SaraDesktop in another folder: the entry and its copy of Sara.exe go.
  const elsewhere = { ...standalone, location: 'C:\\Users\\hank\\Apps\\Sara' };
  assert.deepEqual(duplicateInstalls([user, elsewhere], HKCU_LOC).map((d) => [d.entry.kind, d.how]), [['standalone', 'files']]);
  // Without any Setup install the self-installed app is the only Sara: kept.
  assert.deepEqual(duplicateInstalls([standalone], HKCU_LOC), []);
});

test('update-apply: the installer runs in the scope of the existing install, never the other one', async () => {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), '');
  const plan = { appDir: HKLM_LOC, port: 7860, resultFile: 'C:\\ProgramData\\Sara\\updates\\update-result.json' };
  await windowsDriver(plan, run, undefined, () => [user, all]).install('Sara-Setup-3.18.1.exe');
  assert.ok(calls[0].includes('/ALLUSERS') && calls[0].includes('/MODE=service'), calls[0].join(' '));
  await windowsDriver({ ...plan, appDir: HKCU_LOC }, run, undefined, () => [user, all]).install('Sara-Setup-3.18.1.exe');
  assert.ok(calls[1].includes('/CURRENTUSER') && !calls[1].includes('/ALLUSERS'), calls[1].join(' '));
  // Nothing found (a scripted test install): as before, this user.
  await windowsDriver({ ...plan, appDir: 'D:\\x' }, run, undefined, () => []).install('Sara-Setup-3.18.1.exe');
  assert.ok(calls[2].includes('/CURRENTUSER'));
  // The service's update task says 'all' itself.
  await windowsDriver(plan, run, 'all', () => []).install('Sara-Setup-3.18.1.exe');
  assert.ok(calls[3].includes('/ALLUSERS'));
});

test('the Windows app and Setup: same scope on update, no second entry, the stale one removed on start', () => {
  const upd = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'app-update.cpp'), 'utf8');
  assert.match(upd, /\/MODE=remote \/CURRENTUSER/, 'the app-only update names its scope (always this user)');
  const main = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'main.cpp'), 'utf8');
  assert.match(main, /static bool setupInstalled\(\)/, 'the app knows when Setup installed Sara');
  assert.match(main, /!installedBySetup\(\) && !setupInstalled\(\) && installIfNeeded\(\)/, 'a downloaded Sara.exe never adds a second Sara next to Setup\'s');
  assert.match(main, /removeDuplicateInstalls\(\)/, 'on start the stale install is removed');
  assert.match(main, /\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/KEEPDATA/, 'silently, keeping her data');
  const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
  assert.match(iss, /procedure TakeOverStandaloneApp[\s\S]*?RegDeleteKeyIncludingSubkeys\(HKCU, STANDALONE_KEY\)/);
  assert.doesNotMatch(iss.slice(iss.indexOf('procedure TakeOverStandaloneApp'), iss.indexOf('procedure SetUpRemoteApp')), /CompareText\(RemoveBackslashUnlessRoot\(Loc\), RemoveBackslashUnlessRoot\(App\)\) = 0\) then\s*RegDeleteKey/, 'the old entry goes wherever it pointed');
  assert.match(iss, /'\/KEEPDATA'/, 'the silent uninstall a duplicate cleanup runs keeps her data');
  assert.match(iss, /if not WizardSilent and not HttpOk\(D \+ '\/api\/health'\) then/, 'a silent update never waits on a question about a server that is briefly down');
  assert.match(iss, /procedure TakeOverStandaloneApp[\s\S]*?#ifdef TestInstall\s*\/\/[^\n]*\s*exit;/, 'the update test never touches a real entry');
});
