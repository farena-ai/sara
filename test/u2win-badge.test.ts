// ROADMAP_U U2.8 (Windows) + U2.11: the taskbar message count and one desktop app for several servers.
// Contract tests for the page side (what the page tells the app) and text pins for the Windows app,
// plus the native checks of the count icon when the test build exists (docs/design/U2WIN.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const main = read('desktop/windows/src/main.cpp');
const counts = read('desktop/windows/src/server-counts.cpp');
const countsH = read('desktop/windows/src/server-counts.h');
const messages = read('web/messages.js');
const app = read('web/app.js');

const notice = await import(pathToFileURL(join(root, 'web/msg-notice.js')).href);

test('U2.8: the taskbar count is the sidebar count, and 0 when the person turned the popup off', () => {
  assert.equal(notice.desktopBadge(3, { popup: true }), 3);
  assert.equal(notice.desktopBadge(3, {}), 3, 'popup on is the default');
  assert.equal(notice.desktopBadge(3, { popup: false }), 0);
  assert.equal(notice.desktopBadge(0, {}), 0);
  assert.equal(notice.desktopBadge(-2, {}), 0);
  assert.equal(notice.desktopBadge(Number.NaN, {}), 0);
  assert.equal(notice.desktopBadge(2.7, {}), 2);
});

test('U2.8: the page sends the count to the Windows app from the same place as the sidebar pill', () => {
  const paint = messages.slice(messages.indexOf('function paintBadge('), messages.indexOf('// The tab title keeps'));
  assert.match(paint, /sentBadge = desktopBadge\(n, prefs\)/);
  assert.match(paint, /SaraDesktop\?\.call\?\.\('badge', \{ n: sentBadge \}\)/);
  assert.match(messages, /import \{[^}]*desktopBadge[^}]*\} from '\.\/msg-notice\.js'/);
  // Sent again when only the popup setting changed (the count itself did not).
  assert.match(paint, /desktopBadge\(n, prefs\) !== sentBadge/);
});

test('U2.8: the overlay icon on the taskbar button (ITaskbarList3), cleared at 0, with words for screen readers', () => {
  assert.match(main, /RegisterWindowMessageW\(L"TaskbarButtonCreated"\)/);
  assert.match(main, /CLSID_TaskbarList/);
  assert.match(main, /SetOverlayIcon\(g_wnd, icon, desc\.c_str\(\)\)/);
  assert.match(main, /SetOverlayIcon\(g_wnd, nullptr, L""\)/);
  // Only her own page may set it, never the address or offline page.
  const guard = main.indexOf('if (!fromServer) return;  // everything else only from the owner');
  const badge = main.indexOf('if (kind == L"badge")');
  assert.ok(guard > 0 && badge > guard, 'the badge message is taken only from her own server');
  // Drawn at run time: 1–9, then 9+.
  assert.match(counts, /n > 9 \? L"9\+"/);
  assert.match(counts, /unread message/);
  assert.match(countsH, /HICON makeBadgeIcon\(int n, int size\)/);
});

test('U2.11: every saved server has its unread count; the badge sums them', () => {
  assert.match(main, /static std::map<std::wstring, int> g_unread;/);
  assert.match(main, /\\"unread\\":" \+ std::to_wstring\(unreadOf\(p\.id\)\)/, 'serversJson carries each server\'s count');
  assert.match(main, /saracounts::total\(g_unread\)/);
  assert.match(main, /g_unread\.erase\(id\)/, 'a removed server leaves the sum');
  // The tray's Your Saras list shows the count next to each one.
  assert.match(main, /serverLabel\(list\[i\]\) \+ saracounts::menuCount\(unreadOf\(list\[i\]\.id\)\)/);
});

test('U2.11: the servers not in use are asked in their own WebView2 profile, through a page the app answers itself', () => {
  assert.match(main, /kCountsPath = L"\/__sara_desktop\/counts"/);
  const poll = main.slice(main.indexOf('// ---------- U2.11: counts from the servers not in use'), main.indexOf('// ---------- U2.11 end'));
  assert.ok(poll.length > 500, 'the poller section exists');
  assert.match(poll, /put_ProfileName\(\(L"sara-" \+ id\)\.c_str\(\)\)/, 'each server its own profile (s1 = the default one)');
  assert.match(poll, /setBypassServiceWorker/, 'her service worker would answer the page otherwise');
  assert.match(poll, /put_IsVisible\(FALSE\)/);
  assert.match(poll, /Close\(\)/, 'the web view is closed after each ask');
  assert.match(poll, /id != g_profile/, 'the server in use reports through its own page');
  // A message from a server not in use: a toast that opens that server.
  assert.match(poll, /a=open&p=" \+ plainId\(id\)/);
  // Each message is told once (its key kept per server), and never for what was on screen before a switch.
  assert.match(poll, /key != getIni\(sec, L"told"\)/);
  assert.match(poll, /bool quiet = g_countsQuiet\.erase\(id\) > 0;/);
  assert.match(main, /if \(!g_profile\.empty\(\) && g_profile != id\) g_countsQuiet\.insert\(g_profile\);/);
  // The page: only her /api/messages, same origin, no other request.
  assert.match(counts, /fetch\('\/api\/messages', \{ credentials: 'same-origin' \}\)/);
  assert.match(counts, /connect-src 'self'/);
  assert.match(counts, /popup === false/);
});

test('U2.11: the ⇄ menu shows each server\'s unread count and the switch button the others\'', () => {
  const r = app.slice(app.indexOf('async function renderServers()'), app.indexOf('function openServers()'));
  assert.match(r, /x\.unread > 0/);
  assert.match(r, /t\('\{n\} unread', \{ n: x\.unread \}\)/);
  assert.match(r, /#server-btn-count/);
  assert.match(read('web/index.html'), /<span id="server-btn-count" class="srv-count" hidden><\/span>/);
});

test('U2.11: the old single server still becomes the first entry (Phase 68 migration kept)', () => {
  assert.match(main, /static void migrateProfiles\(\) \{\n  if \(!profileIds\(\)\.empty\(\) \|\| g_server\.empty\(\)\) return;/);
});

const EXE = process.env.SARA_COUNTS_NATIVE ?? join(root, 'desktop', 'windows', 'build-test', 'Release', 'ServerCountsChecks.exe');
const skip = process.platform !== 'win32' ? 'Windows only' : !existsSync(EXE) ? 'build the test app first (desktop/windows: cmake -B build-test -DSARA_TEST_HOOKS=ON)' : false;

test('U2.8 native: the count icon and its words', { skip }, () => {
  const r = spawnSync(EXE, [], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.text, ['', '1', '9', '9+', '9+']);
  assert.deepEqual(out.desc, ['', '1 unread message', '9 unread messages', '10 unread messages', '120 unread messages']);
  assert.equal(out.total, 7);
  assert.deepEqual(out.menu, ['', '  (3)', '  (99+)']);
  // A real icon at 16 and 32 px: transparent corners, a filled middle.
  for (const s of out.icons) {
    assert.equal(s.ok, true);
    assert.equal(s.corner, 0, 'corner is transparent');
    assert.ok(s.middle > 200, 'middle is opaque');
  }
});
