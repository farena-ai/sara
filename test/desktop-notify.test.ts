// Phase 75 stage 3 (native): the Windows and Mac apps' notifications with buttons (approvals:
// Allow / Deny / Open; reminders: Done / Snooze 10 min), files given to her from Explorer's Send To,
// a second start or the Dock icon, the dark tray menu, and talking in the quick-ask window
// (docs/design/NEW_LOOK.md → Native apps). Static checks on the sources: Windows knows who Sara is
// (AUMID on the process and the shortcut), the buttons go to the same approval route as the tray and
// the chat's card, nothing is ever allowed by itself, the demo and signed-out states show nothing,
// one event never makes two notifications, and files only land in the message box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const cpp = () => read('desktop', 'windows', 'src', 'main.cpp');
const toast = () => read('desktop', 'windows', 'src', 'toast.h');
const iss = () => read('desktop', 'windows', 'installer', 'sara.iss');
const page = () => read('desktop', 'shared', 'quick-ask.html');
const notify = () => read('desktop', 'mac', 'Sources', 'Notify.swift');
const quick = () => read('desktop', 'mac', 'Sources', 'QuickAsk.swift');
const mainSwift = () => read('desktop', 'mac', 'Sources', 'main.swift');
const fn = (src: string, start: string, end: string) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing ${start}`);
  const b = src.indexOf(end, a + start.length);
  return src.slice(a, b < 0 ? undefined : b);
};

test('Windows: the AUMID is set on the process and on the shortcuts, with the toast activator', () => {
  const c = cpp();
  assert.match(c, /kAumid = L"BackstageCoding\.Sara"/);
  assert.match(c, /SetCurrentProcessExplicitAppUserModelID\(aumid\(\)\);/);
  // Set at the very start of wWinMain, before any window exists.
  const main = fn(c, 'int WINAPI wWinMain(', 'CreateWindowExW(0, kWindowClass');
  assert.ok(main.indexOf('SetCurrentProcessExplicitAppUserModelID') < main.indexOf('CreateMutexW'));
  // The same CLSID in the app (text and struct) and the installer's Start-menu shortcut.
  const clsid = '57448757-B168-47CE-9852-892129855C82';
  assert.ok(c.includes(`L"{${clsid}}"`));
  assert.match(c, /\{0x57448757, 0xb168, 0x47ce, \{0x98, 0x52, 0x89, 0x21, 0x29, 0x85, 0x5c, 0x82\}\}/);
  assert.match(iss(), new RegExp(`Name: "\\{autoprograms\\}\\\\Sara";.*AppUserModelID: "BackstageCoding\\.Sara"; AppUserModelToastActivatorCLSID: "${clsid}"`));
  // The app's own Start-menu shortcut (self-install) and older shortcuts / taskbar pins get both too.
  assert.match(c, /PKEY_AppUserModel_ID/);
  assert.match(c, /PKEY_AppUserModel_ToastActivatorCLSID/);
  assert.match(fn(c, 'static bool installIfNeeded()', 'static void uninstall()'), /stampLink\(link\.Get\(\)\);/);
  assert.match(c, /User Pinned\\\\TaskBar\\\\Sara\.lnk/);
  // Registration (per user) and the COM class that takes clicks, also when Sara wasn't running.
  const t = toast();
  assert.match(t, /Software\\\\Classes\\\\AppUserModelId\\\\/);
  assert.match(t, /L"CustomActivator", clsidText/);
  assert.match(t, /LocalServer32", nullptr, L"\\"" \+ exe \+ L"\\" -ToastActivated"/);
  assert.match(t, /CoRegisterClassObject\(clsid, f\.Get\(\), CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE/);
  assert.match(t, /class Activator : public RuntimeClass<RuntimeClassFlags<ClassicCom>, INotificationActivationCallback>/);
  assert.match(c, /wcsstr\(cmd, L"-ToastActivated"\)/);
  // Only the Windows SDK: raw WinRT ABI, no C++/WinRT, no NuGet package.
  assert.match(t, /#include <windows\.ui\.notifications\.h>/);
  assert.doesNotMatch(t, /winrt\/|cppwinrt|Microsoft\.Toolkit/);
  assert.match(read('desktop', 'windows', 'CMakeLists.txt'), /runtimeobject propsys/);
  // Uninstall removes what the app registered (the app's own uninstall and the installer's).
  assert.match(fn(c, 'static void uninstall()', '// ---------- window, tray'), /saratoast::unregisterApp\(aumid\(\), toastClsidText\(\)\);/);
  assert.match(iss(), /Subkey: "Software\\Classes\\AppUserModelId\\BackstageCoding\.Sara"; Flags: uninsdeletekey dontcreatekey/);
  // A test run never uses the real app's AUMID, activator, lock or Send To entry.
  assert.match(c, /testRun\(\) \? L"BackstageCoding\.Sara\.Test" : kAumid/);
  assert.match(fn(c, 'static bool testRun()', '}\n'), /#ifdef SARA_TEST_HOOKS/);
});

test('Windows: approvals: a toast with the command, Allow / Deny wired to the tray\'s approval route', () => {
  const c = cpp();
  const n = fn(c, 'static void notifyApprovals(const std::wstring& lines) {', '/** {a:\'reminder\'');
  assert.match(n, /<action content=\\"Allow\\" arguments=\\"" \+ saratoast::xml\(L"a=allow" \+ base\)/);
  assert.match(n, /<action content=\\"Deny\\" arguments=\\"" \+ saratoast::xml\(L"a=deny" \+ base\)/);
  assert.match(n, /<action content=\\"Open in Sara\\"/);
  // The text shows what she wants to run (summary and the command) so the OK is informed.
  assert.match(n, /saratoast::xml\(clip\(f\[2\], 160\)\)/);
  assert.match(n, /saratoast::xml\(clip\(f\[3\], 300\)\)/);
  assert.match(n, /if \(g_toastApprovals\.count\(id\) \|\| !notifyNow\(\)\) continue;/, 'once each, and not while the owner is looking at Sara');
  assert.match(n, /saratoast::remove\(it->second, L"approval"\);/, 'decided elsewhere: the toast goes away');
  // The page sends the command with each approval waiting.
  const p = page();
  assert.match(p, /asks\.push\(\[clean\(ap\.approvalId, 80\), clean\(c\.id, 60\), clean\(ap\.summary \|\| ap\.name, 160\), detailOf\(ap\)\]\.join\('\\t'\)\)/);
  assert.match(p, /const v = a\.command \|\| a\.cmd \|\| a\.script/);
  // Allow / Deny: the same call as the tray menu's (saraQuick.decide → POST /api/approvals/<id>).
  const h = fn(c, 'static bool handleToast(const std::wstring& args) {', 'static void runToastQueue()');
  assert.match(h, /decideFromTray\(id, a == L"allow"\);/);
  assert.match(fn(c, 'static void decideFromTray(', '}\n'), /saraQuick\.decide\(/);
  assert.match(p, /decide\(id, ok\) \{\s+return api\('\/approvals\/' \+ encodeURIComponent\(id\), \{ method: 'POST', body: \{ approved: Boolean\(ok\) \} \}\)/);
});

test('never allowed by itself: only a press on a toast this app showed, still waiting, for the server in use', () => {
  const c = cpp();
  // decideFromTray is called from exactly two places: the tray menu's Allow / Deny and a toast's button.
  const calls = c.match(/decideFromTray\(/g) ?? [];
  assert.equal(calls.length, 3, 'definition + tray menu + toast button');
  assert.match(c, /if \(i < g_menuNow\.size\(\) && g_menuNow\[i\]\.kind == L"approval"\) decideFromTray\(g_menuNow\[i\]\.id, allow\);/);
  const h = fn(c, 'static bool handleToast(const std::wstring& args) {', 'static void runToastQueue()');
  assert.match(h, /if \(here && it != g_toastApprovals\.end\(\) && stillWaiting\) \{/);
  assert.match(h, /bool here = !p\.empty\(\) && p == g_profile;/);
  // Anything else (a click after a restart, another server, a forged activation) only opens the chat.
  assert.match(h, /showWindow\(\);\s+if \(!conv\.empty\(\)\) openConversation\(conv\);/);
  // The page never decides on its own: only the card's buttons and saraQuick.decide call the route.
  const p = page();
  assert.equal((p.match(/'\/approvals\/' \+ encodeURIComponent/g) ?? []).length, 2);
  // Mac: the same rule.
  const n = notify();
  assert.match(n, /if here, !aid\.isEmpty, notes\.approvals\[aid\] != nil, still, quick\?\.ready \?\? false \{/);
  assert.equal((n.match(/quick\?\.decide\(/g) ?? []).length, 1);
  assert.equal((quick().match(/quick\?\.decide\(/g) ?? []).length, 2, 'the menu bar\'s Allow and Deny');
});

test('reminders: Done / Snooze 10 min through the normal reminders route', () => {
  const c = cpp();
  const r = fn(c, 'static void notifyReminder(', '/** "a=allow&id');
  assert.match(r, /scenario=\\"reminder\\"/);
  assert.match(r, /<action content=\\"Done\\"/);
  assert.match(r, /<action content=\\"Snooze 10 min\\"/);
  assert.match(c, /saraQuick\.snooze\(/);
  const p = page();
  assert.match(p, /d\.reason !== 'reminder'/);
  assert.match(p, /post\(\{ a: 'reminder', conv: String\(d\.conversationId \|\| ''\), rid, text:/);
  assert.match(p, /api\('\/reminders', \{ method: 'POST', body: Object\.assign\(\{ text: t, when: 'in 10 minutes' \}/);
  // Mac: categories with the same buttons.
  const n = notify();
  assert.match(n, /UNNotificationCategory\(identifier: "approval", actions: \[allow, deny, open\]/);
  assert.match(n, /UNNotificationCategory\(identifier: "reminder", actions: \[done, snooze\]/);
  assert.match(n, /title: "Snooze 10 min"/);
  assert.match(quick(), /saraQuick\.snooze\(\.\.\./);
});

test('one event, one notification: the page\'s own notification is replaced, never doubled', () => {
  const c = cpp();
  // The page's SaraDesktop.notify() and web Notifications go through one function…
  assert.match(c, /if \(kind == L"notify"\) return notifyFromPage\(m\[L"title"\], m\[L"body"\], m\[L"conv"\]\);/);
  assert.match(c, /add_NotificationReceived\(/);
  assert.match(c, /a->put_Handled\(TRUE\);/);
  // …which is dropped when our reminder toast (with buttons) for the same event is there, and
  // ours carries the same tag, so it replaces the page's when it comes second.
  const f = fn(c, 'static void notifyFromPage(', '/** Approvals waiting');
  assert.match(f, /std::wstring tag = messageTag\(plainId\(conv, 64\), body\);/);
  assert.match(f, /if \(r != g_toastReminders\.end\(\) && GetTickCount\(\) - r->second\.at < kSameEventMs\) return;/);
  assert.match(fn(c, 'static void notifyReminder(', '/** "a=allow&id'), /std::wstring tag = messageTag\(conv, text\);/);
  // The same text on both sides: the web app's body for a reminder is the message without "Reminder: ".
  assert.match(page(), /text: String\(d\.message\.content \|\| ''\)\.replace\(\/\^Reminder: \/, ''\)/);
  assert.match(read('web', 'app.js'), /ev\.message\.content\.replace\(\/\^Reminder: \/, ''\)/);
  // Mac: the same identifier rule.
  const n = notify();
  assert.match(n, /let id = messageNoteId\(plainId\(conv, 64\), body\)/);
  assert.match(n, /if let r = notes\.reminders\[id\], Date\(\)\.timeIntervalSince\(r\.at\) < 300 \{ return \}/);
  assert.match(mainSwift(), /case "notify":\s+notifyFromPage\(/);
});

test('demo, signed out, the Notifications switch: nothing shown', () => {
  const c = cpp();
  assert.match(c, /notifyApprovals\(n\.signedIn && !n\.demo \? m\[L"asks"\] : L""\);/);
  assert.match(fn(c, 'static void notifyReminder(', '/** "a=allow&id'), /if \(!g_now\.signedIn \|\| g_now\.demo \|\| !notifyNow\(\)\) return;/);
  assert.match(c, /static bool notifyNow\(\) \{ return prefOn\(L"notifications", true\) && !windowInFront\(\)/);
  assert.match(fn(c, 'static void notifyFromPage(', '/** Approvals waiting'), /if \(!prefOn\(L"notifications", true\) \|\| windowInFront\(\)\) return;/);
  // The page doesn't listen for events (reminders) on the demo or signed out.
  assert.match(page(), /if \(es \|\| !session \|\| !session\.authenticated \|\| session\.demo\) return;/);
  const q = quick();
  assert.match(q, /app\?\.notifyApprovals\(signedIn && !demo \? b\["asks"\] as\? String \?\? "" : ""\)/);
  assert.match(notify(), /guard let q = quick, q\.signedIn, !q\.demo, notifyNow else \{ return \}/);
  assert.match(notify(), /var notifyNow: Bool \{ notificationsOn &&/);
});

test('Mac: permission is asked on first use, not at start', () => {
  const m = mainSwift();
  assert.doesNotMatch(m, /requestAuthorization/);
  assert.match(m, /registerNoteCategories\(\)/);
  const n = notify();
  assert.match(n, /case \.notDetermined:\s+c\.requestAuthorization\(options: \[\.alert, \.sound, \.badge\]\)/);
  assert.match(m, /handleNoteResponse\(r\)/);
});

test('Windows: a second start forwards its files (WM_COPYDATA) and Send To is offered and removable', () => {
  const c = cpp();
  const main = fn(c, 'int WINAPI wWinMain(', 'CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);\n  if (!portable');
  assert.match(main, /if \(GetLastError\(\) == ERROR_ALREADY_EXISTS\) \{/);
  assert.match(main, /COPYDATASTRUCT cd\{kCopyFiles,/);
  assert.match(main, /SendMessageTimeoutW\(other, WM_COPYDATA, 0, \(LPARAM\)&cd, SMTO_ABORTIFHUNG, 5000, &r\);/);
  assert.match(main, /testRun\(\) \? L"Local\\\\SaraDesktopAppTest" : L"Local\\\\SaraDesktopApp"/);
  // The running app finds the window it shared (never another app's of the same class in a test run).
  assert.match(c, /if \(!w && !testRun\(\)\) w = FindWindowW\(kWindowClass, nullptr\);/);
  const cd = fn(c, 'case WM_COPYDATA: {', 'return TRUE;');
  assert.match(cd, /cd->dwData != kCopyFiles/);
  assert.match(cd, /cd->cbData > 64 \* 1024/);
  assert.match(cd, /takeFiles\(paths\);/);
  assert.match(fn(c, 'static std::vector<std::wstring> realFiles(', 'static void deliverFiles()'), /FILE_ATTRIBUTE_DIRECTORY/);
  // Send To: made on the first start, a tray switch, removed by uninstall (app and installer).
  assert.match(c, /FOLDERID_SendTo/);
  assert.match(c, /if \(getPref\(L"sendTo"\)\.empty\(\)\) return setSendTo\(true\);/);
  assert.match(c, /L"Send to Sara in Explorer"/);
  assert.match(c, /case ID_SENDTO: setSendTo\(!sendToOn\(\)\); break;/);
  assert.match(fn(c, 'static void uninstall()', '// ---------- window, tray'), /DeleteFileW\(sendToPath\(\)\.c_str\(\)\)/);
  assert.match(iss(), /Type: files; Name: "\{usersendto\}\\Sara\.lnk"/);
});

test('files go into the message box (the page\'s own attach), never sent by themselves', () => {
  const c = cpp();
  const d = fn(c, 'static void deliverFiles() {', 'static void filesAttached(');
  assert.match(d, /CreateWebFileSystemFileHandle\(f\.c_str\(\), COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_ONLY/);
  assert.match(d, /PostWebMessageAsJsonWithAdditionalObjects\(L"\{\\"attach\\":true\}"/);
  assert.match(d, /sameOrigin\(src\)/, 'only to her own page');
  const shim = fn(c, 'static const wchar_t* kShim = LR"JS(', ')JS";');
  assert.match(shim, /window\.saraDesktopAttach/);
  assert.match(shim, /document\.getElementById\('attach-file'\)/);
  assert.match(shim, /input\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  for (const src of [shim, read('desktop', 'mac', 'Sources', 'Notify.swift')]) {
    assert.doesNotMatch(src, /requestSubmit|\.submit\(|'#send'|getElementById\('send'\)/, 'no send');
    assert.doesNotMatch(src, /\/api\/(library|uploads|conversations)/, 'no upload of its own');
  }
  // Mac: Dock icon drops, never the default app for any file type, a size cap for the bridge.
  const n = notify();
  assert.match(n, /func application\(_ application: NSApplication, open urls: \[URL\]\)/);
  assert.match(n, /size <= kMaxDockFile/);
  assert.match(n, /input\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  const plist = read('desktop', 'mac', 'Info.plist');
  assert.match(plist, /<key>CFBundleDocumentTypes<\/key>/);
  assert.match(plist, /<key>LSHandlerRank<\/key><string>Alternate<\/string>/);
});

test('Windows: the tray menu is dark in Night, with a graceful fallback', () => {
  const c = cpp();
  const t = fn(c, 'static void themeMenus() {', '/** The tray menu, the same order');
  assert.match(t, /if \(windowsBuild\(\) < 18362\) return;/);
  assert.match(t, /MAKEINTRESOURCEA\(135\)/);
  assert.match(t, /MAKEINTRESOURCEA\(133\)/);
  assert.match(t, /MAKEINTRESOURCEA\(136\)/);
  assert.match(t, /if \(!setMode\) return;/);
  assert.match(t, /setMode\(g_day \? 3 : 2\);/);
  assert.match(fn(c, 'static void trayMenu() {', '// ---------- pages shown'), /themeMenus\(\);\s+refreshNow\(\);/);
  assert.match(fn(c, 'static void applyTheme() {', '/** The page said which theme'), /themeMenus\(\);/);
});

test('quick ask: talking instead of typing, through the server\'s own hearing', () => {
  const p = page();
  assert.match(p, /<button id="mic" class="icon" type="button" hidden/);
  assert.match(p, /fetch\('\/api\/voice\/transcribe', \{ method: 'POST', credentials: 'same-origin', headers: \{ 'content-type': 'audio\/wav' \}/);
  assert.match(p, /st\.stt === 'openai' \|\| \(st\.stt === 'local' && local\.stt\)/, 'shown only when her hearing is set up');
  assert.match(p, /setTimeout\(\(\) => stopMic\(true\), 120000\)/, 'at most 2 minutes');
  assert.match(p, /hidden\(\) \{ stopMic\(false\);/, 'hiding the window stops a recording (2.59: and ends a wake)');
  assert.doesNotMatch(p, /\sstyle=["']/);
  // The microphone for the quick-ask page only (Windows) / its server origin only (Mac).
  const c = cpp();
  assert.match(c, /bool mic = k == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && !g_qaServer\.empty\(\) && u\.rfind\(g_qaServer \+ kQuickPath, 0\) == 0;/);
  assert.match(quick(), /decisionHandler\(type == \.microphone && o != nil && o == app\?\.server && o == pageServer && frame\.isMainFrame \? \.grant : \.deny\)/);
});
