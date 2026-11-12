// 3.5.2: her face as the desktop apps' icon. The server says which picture is the companion's face
// (/api/session → face), the quick-ask page draws it and hands it to the Windows app, which makes
// the window, tray, notification, taskbar and shortcut icons from it (desktop/windows/src/main.cpp).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { appFaceOf } from '../src/app-face.ts';
import { OwnerAuth } from '../src/auth.ts';
import { defaultLookFile, defaultLookFor } from '../src/default-look.ts';
import { LookBuilder } from '../src/look.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const WEB = join(ROOT, 'web');
const { dir, cleanup } = tempDir();
const app = makeApp(dir, { now: new Date('2026-11-11T12:00:00Z') });
app.look = new LookBuilder({ dataDir: dir, key: async () => undefined, builtin: (rel) => defaultLookFile(WEB, rel, defaultLookFor(app.settings.get().defaultLook, app.persona.pronouns)) }) as never;
const auth = new OwnerAuth(dir);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: WEB });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const session = async (auth = true) => (await (await fetch(`${base}/api/session`, auth ? { headers: { authorization: `Bearer ${token}` } } : {})).json()) as { face?: { kind: string; src: string; tag: string } };
const bytes = async (p: string) => Buffer.from(await (await fetch(base + p, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer());

test('Sara with her own default look: builtin (the app keeps its icon); signed out: nothing', async () => {
  app.persona = { ...app.persona, name: 'Sara', pronouns: 'she' };
  assert.deepEqual((await session()).face, { kind: 'builtin', src: '/sara-avatar.jpg', tag: 'b' });
  assert.equal((await session(false)).face, undefined, 'her face is private to the signed-in owner');
});

test('renamed to Fred (he): his default look, and the address serves his face', async () => {
  app.persona = { ...app.persona, name: 'Fred', pronouns: 'he' };
  const f = (await session()).face!;
  assert.equal(f.kind, 'look');
  assert.equal(f.src, '/sara-avatar.jpg');
  assert.deepEqual(await bytes(f.src), readFileSync(join(WEB, 'looks', 'he', 'sara-avatar.jpg')));
  // A picked default look wins over the pronouns; the tag changes with it.
  app.settings.update({ defaultLook: 'they' } as never);
  const g = (await session()).face!;
  assert.equal(g.kind, 'look');
  assert.notEqual(g.tag, f.tag);
  assert.deepEqual(await bytes(g.src), readFileSync(join(WEB, 'looks', 'they', 'sara-avatar.jpg')));
  app.settings.update({ defaultLook: 'auto' } as never);
});

test('an uploaded picture of him wins (custom), and a new one changes the tag', async () => {
  const png = readFileSync(join(WEB, 'looks', 'he', 'sara-avatar.jpg'));
  writeFileSync(join(dir, 'avatar.jpg'), png);
  const f = (await session()).face!;
  assert.equal(f.kind, 'custom');
  assert.equal(f.src, '/api/sara/avatar');
  writeFileSync(join(dir, 'avatar.jpg'), Buffer.concat([png, Buffer.from([0])]));
  assert.notEqual((await session()).face!.tag, f.tag);
});

test('another companion without a look: her initial; a custom look: the look', () => {
  const look = { custom: false, fileOrDefault: () => undefined };
  assert.equal(appFaceOf({ dataDir: join(dir, 'none'), companionId: 'c2', persona: { name: 'Mia' }, look }).kind, 'initial');
  assert.equal(appFaceOf({ dataDir: join(dir, 'none'), companionId: 'main', persona: { name: 'Sara' }, look }).kind, 'builtin');
  const custom = { custom: true, fileOrDefault: (rel: string) => (rel === 'sara-avatar.jpg' ? join(WEB, 'sara-avatar.jpg') : undefined) };
  assert.equal(appFaceOf({ dataDir: join(dir, 'none'), companionId: 'c2', persona: { name: 'Mia' }, look: custom }).kind, 'look');
});

test('Windows app: the face becomes every icon; Sara keeps the built-in one; names follow her', () => {
  const cpp = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'main.cpp'), 'utf8');
  const qa = readFileSync(join(ROOT, 'desktop', 'shared', 'quick-ask.html'), 'utf8');
  // The page: once per server tag, 256 px, or 'builtin'; older servers say nothing.
  assert.match(qa, /const icon = f\.kind === 'builtin' \? 'builtin' : await makeIcon\(/);
  assert.match(qa, /c\.width = c\.height = 256;/);
  assert.match(qa, /const icon = await iconFor\(session\.face\);\s*post\(\{ a: 'state'[^}]*\bicon,/);
  assert.match(qa, /const faceKey = url \+ ' ' \+/, 'the tray menu face follows a new look too');
  // The app: cached per server, every icon, the built-in one for Sara.
  assert.match(cpp, /static std::wstring iconCachePath\(\) \{ return dataDir\(\) \+ L"\\\\icon-" \+ serverTag\(\) \+ L"\.png"; \}/);
  assert.match(cpp, /if \(icon == L"builtin"\) \{[\s\S]{0,120}g_iconPng\.clear\(\);[\s\S]{0,80}DeleteFileW\(iconCachePath\(\)\.c_str\(\)\);/);
  const apply = cpp.slice(cpp.indexOf('static void applyCompanionIcon() {'), cpp.indexOf('/** At start and after a switch'));
  assert.match(apply, /WM_SETICON, ICON_BIG/);
  assert.match(apply, /WM_SETICON, ICON_SMALL/);
  assert.match(apply, /rebuildTrayIcons\(\);/);
  assert.match(apply, /saratoast::registerApp\(aumid\(\), toastClsidText\(\), companionName\(\)/);
  assert.match(apply, /setRelaunchIcon\(ico\);\s*setShortcutIcons\(ico\);/);
  assert.match(cpp, /PKEY_AppUserModel_RelaunchIconResource, ico \+ L",0"/);
  assert.match(cpp, /case WM_DESTROY:\s*UnregisterHotKey\(h, kHotkeyId\);\s*setRelaunchIcon\(L""\);/, 'removed before the window closes');
  // The tray's dot variants are made from her face.
  assert.match(cpp, /HICON base = baseIcon\(cx\);/);
  // Shortcuts: only the app's own (this exe and AUMID); test builds never touch the real ones.
  const links = cpp.slice(cpp.indexOf('static void setShortcutIcons('), cpp.indexOf('static void rebuildTrayIcons();'));
  assert.match(links, /if \(testRun\(\)\) \{[\s\S]{0,200}SARA_TEST_SHORTCUT/);
  assert.match(links, /_wcsicmp\(path, exe\.c_str\(\)\) != 0\)\s*continue;/);
  assert.match(links, /wcscmp\(v\.pwszVal, aumid\(\)\) == 0;/);
  assert.match(links, /bool fromUs = /, 'back to the exe icon only from one of ours');
  assert.match(links, /SHChangeNotify\(SHCNE_UPDATEITEM/);
  // Switching servers switches the face; the start shows the cached one.
  assert.match(cpp, /loadCachedIcon\(\);\s*applyCompanionIcon\(\);\s*applyCompanionName\(companionName\(\)\);/);
  // Her name: the window title, the app's own title strip, the tray when Hey Sara is off.
  assert.match(cpp, /SetWindowTextW\(g_wnd, title\.c_str\(\)\)/);
  assert.match(cpp, /DrawTextW\(t, companionName\(\)\.c_str\(\)/);
  assert.match(cpp, /st == L"off" \? companionName\(\)/);
  assert.match(cpp, /FindWindowW\(kWindowClass, nullptr\)\) \{  \/\/ 3\.5\.2/, 'uninstall finds the window whatever its title');
});
