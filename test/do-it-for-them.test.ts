// 3.6.x (do it for them): if the person could do it on their computer, she can do it for them with an approval on
// that computer. The hard "do it yourself" refusals became approved desktop actions / commands, and every "I can't"
// says what is missing. Policy (browser settings pages, extension Remove, address-bar typing), the lean words that
// load the computer tools, the persona rule, and the Windows app's own mirror of the rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserInternalPage, desktopActionVerdict, extensionsAddress, extensionsWindow, ownBrowserPage } from '../src/computer-policy.ts';
import { runPlan, RunRuleError } from '../src/hands-run.ts';
import { CHECKUP_REF, DO_WORDS, fold, PC_THINGS } from '../src/lean.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

test('browser settings pages: extensions and add-ons ask every time; passwords, payments, sync and accounts never', () => {
  for (const a of ['edge://extensions', 'chrome://extensions/?id=abc', 'about:addons', 'brave://extensions', 'edge://settings/clearBrowserData']) assert.equal(browserInternalPage(a), 'settings', a);
  for (const a of ['edge://settings/passwords', 'chrome://password-manager/passwords', 'edge://settings/payments', 'chrome://settings/syncSetup', 'edge://settings/profiles', 'about:logins', 'chrome://settings/security', 'edge://wallet']) assert.equal(browserInternalPage(a), 'blocked', a);
  assert.equal(browserInternalPage('https://example.com/extensions'), '', 'a web page is not the browser itself');
  assert.equal(ownBrowserPage('Extensions', 'edge://extensions').act, 'once');
  assert.equal(ownBrowserPage('Passwords', 'edge://settings/passwords').act, 'block');
  assert.equal(extensionsAddress('edge'), 'edge://extensions');
  assert.equal(extensionsAddress('Chrome'), 'chrome://extensions');
  assert.equal(extensionsAddress('firefox'), 'about:addons');
});

test('Remove on the browser extensions page asks once; elsewhere Remove and file deletions stay refused', () => {
  const page = { app: 'msedge', title: 'Extensions - Personal - Microsoft Edge' };
  assert.ok(extensionsWindow(page.app, page.title));
  assert.ok(extensionsWindow('msedge', 'Remove \u201cMcAfee WebAdvisor\u201d?'), 'the confirmation');
  assert.ok(!extensionsWindow('notepad', 'Extensions.txt - Notepad'), 'only a browser');
  assert.ok(!extensionsWindow('msedge', 'Passwords - Microsoft Edge'));
  const v = desktopActionVerdict({ site: 'desktop:x', kind: 'click', target: { role: 'button', name: 'Remove' }, level: 'always', window: page });
  assert.equal(v.act, 'ask');
  assert.deepEqual(v.act === 'ask' ? v.choices : [], ['once'], 'every time, never "for this task"');
  assert.equal(desktopActionVerdict({ site: 'desktop:x', kind: 'click', target: { role: 'button', name: 'Remove' }, level: 'always', window: { app: 'explorer', title: 'Documents' } }).act, 'block');
  assert.equal(desktopActionVerdict({ site: 'desktop:x', kind: 'click', target: { role: 'button', name: 'Remove' }, level: 'always' }).act, 'block');
  assert.equal(desktopActionVerdict({ site: 'desktop:x', kind: 'click', target: { role: 'button', name: 'Delete file' }, level: 'always', window: page }).act, 'block');
  assert.equal(desktopActionVerdict({ site: 'desktop:x', kind: 'type', target: { role: 'edit', name: 'Password', secret: true }, level: 'always', window: page }).act, 'block');
});

test('administrator rights: never asked for by a command, and the refusal says how the owner allows it', () => {
  assert.throws(() => runPlan({ command: 'Start-Process powershell -Verb RunAs' }), (e: RunRuleError) => /Windows shows its own prompt/.test(e.message) && !/themselves\./.test(e.message));
  assert.equal(runPlan({ command: "winget uninstall --name 'McAfee WebAdvisor'" }).command, "winget uninstall --name 'McAfee WebAdvisor'");
});

test('lean: a doing word about something on the computer (or a check-up number) loads her computer tools', () => {
  const hit = (t: string) => {
    const p = fold(t).replace(/[^\p{L}\p{N}@:_]+/gu, ' ');
    return DO_WORDS.test(p) && (PC_THINGS.test(p) || CHECKUP_REF.test(fold(t)));
  };
  for (const t of ['take care of #3 and remove them', 'uninstall McAfee WebAdvisor', 'remove the McAfee extension from my browser', 'clean up my disk', 'disable the startup apps', 'please delete the temp files', 'quitar la extensión del navegador', 'supprimer l\u2019extension', 'entfernen Sie die Erweiterung', 'remover a extensão', 'rimuovere l\u2019estensione', 'do s2 and remove it'])
    assert.ok(hit(t), t);
  for (const t of ['fix the bug in this function', 'remove the second paragraph', 'what is the weather']) assert.ok(!hit(t), t);
});

test('the persona and pc_devices say the do-it-for-them rule and name the hard limits', () => {
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date() });
    const prompt = buildSystemPrompt(app.persona, { tools: ['pc_devices', 'pc_look', 'pc_click', 'pc_run'] } as never);
    assert.match(prompt, /offer to do it for them with their approval there/);
    assert.match(prompt, /Never say they must do it themselves unless it's a hard limit/);
    assert.match(prompt, /say exactly what's missing \(a switch: its name and where; an older app: update it; a hard limit: which one\)/);
    assert.match(prompt, /Windows shows its own prompt there and .+ presses Yes/);
    app.store.close();
  } finally {
    cleanup();
  }
  const src = readFileSync(join(ROOT, 'src/tools/computer.ts'), 'utf8');
  assert.match(src, /const DO_FOR_THEM = /);
  assert.doesNotMatch(src, /This one is for the owner to do themselves/);
});

test('the Windows app mirrors the rules: browser settings pages, address bar, extension Remove, Settings pages, the admin prompt', () => {
  const cpp = readFileSync(join(ROOT, 'desktop/windows/src/hands-screen.cpp'), 'utf8');
  assert.match(cpp, /std::string internalPage\(const std::string& address\)/);
  assert.match(cpp, /password\|passkey\|autofill\|payment\|wallet\|sync\|profile\|people\|sign-\?in\|account\|security\|credential\|logins/);
  assert.match(cpp, /b\.sensitive = sensitivePage\(w->title \+ " " \+ address\) \|\| internal == "settings";/);
  assert.match(cpp, /neverAction\(b\.item\.name, b\.extensions\)/);
  assert.match(cpp, /if \(act->op == "d\.type"\) return addressOk\(act->text, own\);/);
  assert.match(cpp, /settingsWindow\(w->app, w->title\)/);
  assert.match(cpp, /bitlocker\|firewall/);
  assert.match(cpp, /consent\.exe/);
  assert.match(cpp, /the person presses Yes there/);
  // Terminals and Windows Security stay refused as desktop targets.
  assert.match(cpp, /explorer\|cmd\|powershell\|pwsh\|terminal\|windowsterminal\|conhost\|bash\|wsl\|regedit\|mmc\|control\|systemsettings\|sara/);
  assert.match(cpp, /"security settings", \{"windows security"/);
});
