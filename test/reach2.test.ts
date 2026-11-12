// 3.5.x (reach): "she can use the whole computer" within the safety model. She knows and says
// everything she can do on the owner's computer (pc_devices lists it plainly), the lean picker loads
// the desktop tools when the owner talks about the screen, apps, programs, windows or browsers, her
// file reach goes beyond Desktop/Documents/Downloads when the owner allows it (still read only, never
// system folders, other people's folders or key/credential stores), and she can bring one of the
// owner's OWN browser tabs to the front and act in it (approved on the computer; banking/password
// managers blocked; payment, account and sign-in pages always ask).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { ownBrowserPage } from '../src/computer-policy.ts';
import { HandsHub, HANDS_OPS } from '../src/hands.ts';
import { fixtureWindows, TestDesktop, type FixtureWindow } from '../src/hands-desktop.ts';
import { blockedArea, BLOCKED_AREA, FileRuleError, fileRootsOf, listFiles, matchRoot, readTextFile, rootsFor } from '../src/hands-files.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { planFor } from '../src/lean.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date();
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** A scratch "computer": the three folders, a picked Projects folder, a user folder with AppData and .ssh, and another user's folder. */
function scratch() {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const users = join(dir, 'Users');
  const home = join(users, 'alex');
  const other = join(users, 'robin');
  const base = { desktop: join(home, 'Desktop'), documents: join(home, 'Documents'), downloads: join(home, 'Downloads') };
  for (const p of [...Object.values(base), join(home, 'Projects', 'site'), join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), join(home, '.ssh'), join(other, 'Documents'), join(users, 'Public')]) mkdirSync(p, { recursive: true });
  writeFileSync(join(home, 'Projects', 'site', 'todo.md'), '# Todo\nship the site\n');
  writeFileSync(join(home, 'Projects', 'notes.txt'), 'project notes');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  writeFileSync(join(home, '.ssh', 'config.txt'), 'Host x');
  writeFileSync(join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Login Data.txt'), 'secret');
  writeFileSync(join(other, 'Documents', 'diary.txt'), 'robin private');
  writeFileSync(join(base.documents, 'plan.txt'), 'the plan');
  return { dir, users, home, other, base, projects: join(home, 'Projects') };
}

const EDGE: FixtureWindow = {
  id: 'w130',
  title: 'Inbox - Microsoft Edge',
  app: 'msedge',
  bounds: [100, 100, 800, 600],
  color: [250, 250, 250],
  origin: 'https://mail.example',
  elements: [{ role: 'text', name: 'Inbox', box: [10, 10, 200, 20] }],
  tabs: [
    { title: 'Inbox', url: 'https://mail.example/inbox', active: true },
    { title: 'Local test page', url: 'http://127.0.0.1:8235/test.html' },
    { title: 'Chase Bank - Accounts', url: 'https://chase.com/' },
    { title: 'Sign in - Example', url: 'https://accounts.example.com/signin' },
  ],
  pages: {
    'Local test page': [
      { role: 'text', name: 'Reach test page', box: [10, 10, 300, 24] },
      { role: 'button', name: 'Next page', box: [10, 50, 120, 28] },
    ],
    'Sign in - Example': [{ role: 'button', name: 'Continue', box: [10, 50, 120, 28] }],
  },
};

interface Env {
  app: TestApp;
  token: string;
  base: string;
  hub: HandsHub;
  conv?: string;
}
async function env(): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, allowed: () => true, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.settings.update({ disclosureAcceptedAt: NOW.toISOString() });
  for (const t of createComputerTools(app)) app.tools.add(t);
  const server: Server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    hub.closeAll();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    app.store.close();
    cleanup();
  });
  return { app, token, base, hub };
}
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
async function device(e: Env, opts: { name: string; files?: Record<string, string>; areas?: { home: string; usersDir: string }; scope?: 'three' | 'picked' | 'home' | 'drives'; consent?: () => Promise<'once' | 'task' | 'deny'>; prompts?: { forceOnce?: boolean; name?: string }[] }) {
  const r = await fetch(`${e.base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: opts.name, token: e.token }) });
  const { token, id } = (await r.json()) as { token: string; id: string };
  const dt = new TestDesktop({ windows: [...fixtureWindows(), structuredClone(EDGE)] });
  dt.foreground = 'w101';
  const ref = new HandsRef({
    server: e.base,
    token,
    name: opts.name,
    desktop: dt,
    desktopConsent: async (p) => {
      opts.prompts?.push({ forceOnce: p.forceOnce, name: p.target.name });
      return opts.consent ? opts.consent() : 'once';
    },
    optIn: { browser: true, desktop: true, files: Boolean(opts.files) },
    ...(opts.files ? { files: opts.files, fileScope: opts.scope ?? 'three' } : {}),
    ...(opts.areas ? { fileAreas: opts.areas } : {}),
    reconnect: false,
  });
  await ref.start();
  cleanups.push(() => ref.stop());
  await until(() => Boolean(e.hub.hello(id)));
  return { ref, id, dt };
}
const ctxFor = (app: TestApp, conversationId: string): ToolContext => ({ workspaceDir: app.dataDir, signal: new AbortController().signal, sandbox: app.sandbox, conversationId });
async function run(e: Env, name: string, args: Record<string, unknown> = {}): Promise<string> {
  if (!e.conv) {
    e.conv = e.app.store.createConversation({ title: 'Computer' }).id;
    e.app.store.addMessage(e.conv, 'user', 'use my computer');
  }
  const tool = e.app.tools.get(name)!;
  try {
    const prep = await tool.prepare?.(args, { signal: new AbortController().signal, conversationId: e.conv });
    if (prep?.refuse) return prep.refuse;
    return String(await tool.run(args, ctxFor(e.app, e.conv)));
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// ------------------------------------------------------------------------------------------------

test('pc_devices says plainly everything she can do there now, with what each needs', async () => {
  const e = await env();
  const s = scratch();
  await device(e, { name: 'Frank PC', files: rootsFor('picked', s.base, { picked: [s.projects] }), scope: 'picked' });
  const said = await run(e, 'pc_devices');
  assert.match(said, /What you can do there right now:/);
  assert.match(said, /see the whole screen and every open window, and read what is in them \(pc_look, pc_windows\): no approval needed/);
  assert.match(said, /read the owner's own browser tabs \(pc_my_tabs\) and bring one to the front \(pc_my_tabs with action "switch"; they approve on that computer\)/);
  assert.match(said, /click, type, press keys, scroll and drag in their apps and their own browser windows \(pc_click, pc_type, pc_keys, pc_scroll, pc_drag after a pc_look\)/);
  assert.match(said, /read \(never change\) their files in Desktop, Documents, Downloads and Projects \(pc_files\)/);
  assert.match(said, /answer with ALL of "What you can do there right now"/);
  assert.doesNotMatch(said, /[A-Z]:\\|\/Users\/|alex[\\/]/i, 'the server never hears a folder path');
  // The hello keeps only names.
  const dev = e.hub.devices().find((d) => d.computer === 'Frank PC') ?? e.hub.devices()[0];
  assert.deepEqual(dev.fileRoots, ['desktop', 'documents', 'downloads', 'Projects']);
  assert.equal(dev.fileScope, 'picked');
  assert.ok((HANDS_OPS as readonly string[]).includes('d.tabswitch'));
});

test('the lean picker loads the desktop tools when the owner talks about the screen, apps, programs, windows or browsers', async () => {
  const e = await env();
  await device(e, { name: 'Route PC' });
  const conv = e.app.store.createConversation({ title: 'Route' });
  e.app.settings.update({ lean: { ...(e.app.settings.get().lean ?? {}), tools: { ...(e.app.settings.get().lean?.tools ?? {}), mode: 'always' } } } as never);
  const phrases = [
    'she said she can only access 3 things. Is there a way she can actually see the whole computer, use browsers and software that is open?',
    "what's open on my screen?",
    'what am I doing in this app',
    'use notepad to write a shopping list',
    'switch to the tab with my email in chrome and click the first link',
    'which programs do I have open',
    '¿qué programas tengo abiertos en la pantalla?',
    "qu'est-ce qui est ouvert sur l'écran ? regarde les fenêtres",
    'was ist auf dem Bildschirm, welche Fenster sind offen?',
  ];
  for (const text of phrases) {
    const plan = planFor(e.app, conv, text);
    assert.ok(plan.lean, 'lean is on in this test');
    for (const name of ['pc_devices', 'pc_look', 'pc_windows', 'pc_my_tabs', 'pc_click', 'pc_type', 'pc_files']) assert.ok(plan.isOffered(name), `${text}: ${name}`);
  }
  // Unrelated chat does not pull the computer in.
  assert.ok(!planFor(e.app, conv, 'tell me a joke about cats').isOffered('pc_look'));
});

test('files beyond the three folders: picked folders, the user folder, drives; still read only and never the refused places', () => {
  const s = scratch();
  const areas = { home: s.home, usersDir: s.users };
  // Picked: the three folders plus Projects (named, never a path for the server).
  const picked = rootsFor('picked', s.base, { picked: [s.projects, join(s.dir, 'Elsewhere', 'Projects')] });
  assert.deepEqual(Object.keys(picked), ['desktop', 'documents', 'downloads', 'Projects', 'Projects 2']);
  assert.equal(matchRoot('projects', Object.keys(picked)), 'Projects');
  assert.equal(matchRoot('my Documents', Object.keys(picked)), 'documents');
  const l = listFiles(picked, { folder: 'Projects' }, areas);
  assert.deepEqual((l.entries as { name: string }[]).map((x) => x.name), ['site', 'notes.txt']);
  assert.match(String(readTextFile(picked, { folder: 'projects', path: 'site/todo.md' }, areas).text), /ship the site/);
  // The whole user folder: AppData, .ssh and other hidden places stay out of lists and reads.
  const home = rootsFor('home', s.base, { home: s.home });
  assert.ok(home.home);
  const hl = (listFiles(home, { folder: 'home' }, areas).entries as { name: string }[]).map((x) => x.name);
  assert.ok(hl.includes('Projects') && hl.includes('Documents'), hl.join(','));
  assert.ok(!hl.includes('AppData') && !hl.includes('.ssh'), hl.join(','));
  const refuse = (roots: Record<string, string>, a: Record<string, unknown>, re: RegExp) => assert.throws(() => readTextFile(roots, a, areas), (err: Error) => err instanceof FileRuleError && re.test(err.message), JSON.stringify(a));
  refuse(home, { folder: 'home', path: '.ssh/config.txt' }, /hidden|secrets/);
  refuse(home, { folder: 'home', path: 'AppData/Local/Google/Chrome/User Data/Login Data.txt' }, /system folder|keys or passwords/);
  // All drives: other people's user folders and system folders are refused; the person's own and Public are fine.
  const drives = rootsFor('drives', s.base, { home: s.home, drives: [s.dir] });
  const drive = Object.keys(drives).find((k) => k.startsWith('drive '))!;
  assert.ok(drive);
  refuse(drives, { folder: drive, path: 'Users/robin/Documents/diary.txt' }, new RegExp(BLOCKED_AREA.slice(0, 30)));
  const users = (listFiles(drives, { folder: drive, path: 'Users' }, areas).entries as { name: string }[]).map((x) => x.name);
  assert.deepEqual(users.sort(), ['Public', 'alex']);
  assert.match(String(readTextFile(drives, { folder: drive, path: 'Users/alex/Documents/plan.txt' }, areas).text), /the plan/);
  assert.ok(blockedArea(s.dir, join(s.dir, 'Windows', 'System32'), areas));
  assert.ok(blockedArea(s.dir, join(s.dir, 'Program Files', 'x'), areas));
  assert.ok(!blockedArea(s.dir, join(s.home, 'Projects'), areas));
  // An unknown root and an older app's hello.
  assert.throws(() => listFiles(picked, { folder: 'system32' }, areas), /Only these folders: Desktop, Documents, Downloads, Projects, Projects 2/);
  assert.deepEqual(fileRootsOf(undefined), ['desktop', 'documents', 'downloads']);
  assert.deepEqual(fileRootsOf(['desktop', 'C:\\Users\\alex\\Secret', 'drive C']), ['desktop', 'C Users alex Secret', 'drive C']);
});

test('pc_files reads an extra folder by name (or a path that starts with it), and says how to allow more', async () => {
  const e = await env();
  const s = scratch();
  await device(e, { name: 'Files PC', files: rootsFor('picked', s.base, { picked: [s.projects] }), scope: 'picked', areas: { home: s.home, usersDir: s.users } });
  const list = await run(e, 'pc_files', { folder: 'Projects' });
  assert.match(list, /Projects on Files PC \(2 items, read only\):\n- site\/ \(folder\)\n- notes\.txt/);
  const read = await run(e, 'pc_files', { action: 'read', path: 'Projects/site/todo.md' });
  assert.match(read, /Projects\/site\/todo\.md on Files PC/);
  assert.match(read, /ship the site/);
  assert.match(await run(e, 'pc_files', { folder: 'Pictures' }), /^Error: "Pictures" is not a folder you may read on Files PC\. folder: one of "desktop", "documents", "downloads", "Projects"\./);
  const e2 = await env();
  await device(e2, { name: 'Three PC', files: rootsFor('three', s.base) });
  assert.match(await run(e2, 'pc_files', { folder: 'Projects' }), /The owner can allow more folders in the Sara app there \(Settings \u2192 Computer use \u2192 Files \u2192 Which folders\)/);
});

test("the owner's own browser: switch to a tab (approved there), then look and click on its page; banking blocked, sign-in pages ask every time", async () => {
  const e = await env();
  const prompts: { forceOnce?: boolean; name?: string }[] = [];
  const { dt } = await device(e, { name: 'Tabs PC', prompts });
  const tabs = await run(e, 'pc_my_tabs');
  assert.match(tabs, /w130#2 Local test page \u2014 http:\/\/127\.0\.0\.1:8235\/test\.html/);
  assert.match(tabs, /To work in one: pc_my_tabs with action "switch"/);
  const sw = await run(e, 'pc_my_tabs', { action: 'switch', tab: 'local test' });
  assert.match(sw, /Switched on Tabs PC \(the owner allowed it there\): the tab \u201cLocal test page\u201d \(http:\/\/127\.0\.0\.1:8235\/test\.html\) is in front in window w130\. Next: pc_look with window "w130"/);
  assert.equal(dt.foreground, 'w130');
  assert.equal(prompts.at(-1)?.name, 'Local test page');
  const look = await run(e, 'pc_look', { window: 'w130', picture: false });
  assert.match(look, /e2 button "Next page"/);
  const click = await run(e, 'pc_click', { ref: 'e2' });
  assert.match(click, /Completed click on Tabs PC/);
  assert.equal(dt.clicked, 'Next page');
  // Banking: never switched to (hidden in the list, refused by id).
  assert.match(await run(e, 'pc_my_tabs', { action: 'switch', tab: 'w130#3' }), /^Error: That tab is hidden from you on purpose \(banking\)/);
  assert.match(await run(e, 'pc_my_tabs', { action: 'switch', tab: 'chase' }), /^Error: No open tab matches/);
  // A sign-in page: the card asks every time (no "for this task").
  const before = prompts.length;
  assert.match(await run(e, 'pc_my_tabs', { action: 'switch', tab: 'w130#4' }), /Switched on Tabs PC/);
  assert.equal(prompts.length, before + 1);
  assert.equal(prompts.at(-1)?.forceOnce, true);
  await run(e, 'pc_look', { window: 'w130', picture: false });
  const n = prompts.length;
  assert.match(await run(e, 'pc_click', { ref: 'e1' }), /Completed click/);
  assert.equal(prompts.length, n + 1);
  assert.equal(prompts.at(-1)?.forceOnce, true, 'every action on a sign-in page asks');
  // The owner says no: nothing switches.
  const e2 = await env();
  const { dt: dt2 } = await device(e2, { name: 'No PC', consent: async () => 'deny' });
  assert.match(await run(e2, 'pc_my_tabs', { action: 'switch', tab: 'w130#2' }), /did not approve/);
  assert.equal(dt2.foreground, 'w101');
});

test('page rules for the owner\u2019s own browser', () => {
  assert.equal(ownBrowserPage('Example Domain', 'https://example.com/').act, 'level');
  for (const [t, u] of [['Checkout', 'https://shop.example/checkout'], ['Sign in', 'https://accounts.google.com/'], ['x', 'https://github.com/settings/security'], ['Login', 'https://example.com/login'], ['Your account', 'https://amazon.com/gp/your-account']]) assert.equal(ownBrowserPage(t, u).act, 'once', `${t} ${u}`);
  assert.equal(ownBrowserPage('Bank', '', 'banking').act, 'block');
});

test('the Windows app: extra roots, refused places, tab switch with UI Automation and the browser page rules', () => {
  const files = readFileSync(join(ROOT, 'desktop/windows/src/hands-files.cpp'), 'utf8');
  for (const s of ['kBlockedDirs', 'L"appdata"', 'L"program files"', 'L"user data"', 'otherUser', 'setRoots', 'FOLDERID_Profile', 'GetLogicalDrives', 'DRIVE_FIXED', '\\"fileRoots\\":[', 'pickable(']) assert.ok(files.includes(s), s);
  assert.doesNotMatch(files, /DeleteFile|MoveFile|CopyFile|WriteFile|CreateFileW\([^)]*GENERIC_WRITE/, 'read only');
  const screen = readFileSync(join(ROOT, 'desktop/windows/src/hands-screen.cpp'), 'utf8');
  for (const s of ['Result tabSwitch(', 'UIA_SelectionItemPatternId', 'UIA_LegacyIAccessiblePatternId', 'sensitivePage(', 'browserAddress(']) assert.ok(screen.includes(s), s);
  const hands = readFileSync(join(ROOT, 'desktop/windows/src/hands.cpp'), 'utf8');
  for (const s of ['"d.tabswitch"', 'sarafiles::rootsJson()', 'action.tab =']) assert.ok(hands.includes(s), s);
  const main = readFileSync(join(ROOT, 'desktop/windows/src/main.cpp'), 'utf8');
  for (const s of ['handsFilesScope', 'handsFilesFolders', 'filesAddFolder', 'filesRemoveFolder']) assert.ok(main.includes(s), s);
});
