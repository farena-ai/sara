// The desktop approval card (desktop/windows/src/hands-approval.cpp) must not take activation or focus from
// the window Sara is about to act on: Edge's "Remove … from Microsoft Edge?" bubble, menus and dropdowns
// close when their window is deactivated, so an activating card made the approved control disappear.
// Source rules here; the behaviour through the test build's ApprovalCardChecks.exe (SARA_TEST_HOOKS build).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const card = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'hands-approval.cpp'), 'utf8');
const code = card.replace(/\/\/.*$/gm, '');
const EXE = process.env.SARA_APPROVAL_NATIVE ?? join(ROOT, 'desktop', 'windows', 'build-test', 'Release', 'ApprovalCardChecks.exe');
const skip = process.platform !== 'win32' ? 'Windows only' : !existsSync(EXE) ? 'build the test app first (desktop/windows: SARA_TEST_INSTALL=1 bash build.sh)' : false;

test('the approval card is shown without activation', () => {
  assert.match(code, /CreateWindowExW\(WS_EX_TOPMOST \| WS_EX_NOACTIVATE/);
  assert.match(code, /WM_MOUSEACTIVATE\) return MA_NOACTIVATE/);
  assert.match(code, /case WM_MOUSEACTIVATE: return MA_NOACTIVATE/, 'its buttons do not activate it either');
  assert.match(code, /SWP_SHOWWINDOW \| SWP_NOACTIVATE/);
  assert.doesNotMatch(code, /SetForegroundWindow|SetActiveWindow|SetFocus\(|BringWindowToTop|SW_SHOW\b|WS_TABSTOP|IsDialogMessage/);
});

test('the approval card keeps its safety rules', () => {
  assert.match(code, /HWND_TOPMOST/);
  assert.match(code, /SetTimer\(h, kTopTimer/, 'topmost is re-asserted while shown');
  assert.match(code, /SetWindowDisplayAffinity\(h, 0x11\)/, 'still left out of screen captures');
  assert.match(code, /GetMessageExtraInfo\(\) == \(LPARAM\)sarascreen::kInputTag\) return 0/, "Sara's own tagged input never presses a button");
  assert.match(code, /WM_CLOSE\) \{ DestroyWindow/);
  assert.match(code, /int answer = 0;/, 'no answer (closed, ignored) is Don\'t');
  assert.match(code, /cancel && cancel->load\(\) \? 0 : p\.answer/, 'Stop is Don\'t');
  assert.match(card, /Stop \(Ctrl\+Alt\+Esc\) still works\. Closing this window means Don't\./);
});

test('after Allow the target is only brought to the front when it (or its own popup) is not already there', () => {
  const screen = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'hands-screen.cpp'), 'utf8');
  assert.match(screen, /bool bringToFront\(HWND h\) \{\n  if \(targetInFront\(h\)\)/);
  assert.match(screen, /bool targetInFront\(HWND h\) \{ return ownPopupOf\(GetForegroundWindow\(\), h\); \}/);
  assert.match(screen, /return a == b && GetAncestor\(root, GA_ROOTOWNER\) == h;/, 'a popup counts only when the target owns it, in the same process');
  assert.match(screen, /if \(!checking && !targetInFront\(w->h\)\) return refusal\("denied_local", "The target window is not in front/);
  assert.match(screen, /if \(!checking && !ownPopupOf\(WindowFromPoint\(b\.point\), w->h\)\) return refusal\("denied_local", "Another window covers that point/);
  assert.doesNotMatch(screen, /GetForegroundWindow\(\) != w->h|w->h == GetForegroundWindow\(\)/);
});

test('ApprovalCardChecks: the card leaves the front window and its focus alone', { skip }, () => {
  const out = execFileSync(EXE, [], { encoding: 'utf8', timeout: 60000 });
  const m = /(\d+)\/(\d+) approval card checks/.exec(out);
  assert.ok(m, out);
  assert.equal(m[1], m[2], out);
});
