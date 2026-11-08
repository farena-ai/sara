// 2.18: the update experience. The on-open check (12 hours, never in the demo, for a household
// member or in private local mode), "Sara X is available" with "Don't remind me about this version",
// the sidebar footer's "Update available" link, and the reload onto a new version.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { Updater } from '../src/updates.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
type Status = { state?: string; at?: string; pending?: string; latest?: string } | null;
interface Rules {
  CHECK_EVERY_MS: number;
  shouldCheck: (o: { demo?: boolean; member?: boolean; privateLocal?: boolean; available?: boolean; inFlight?: boolean; status?: Status; now?: number }) => boolean;
  shouldRemind: (o: { status?: Status; version?: string; dismissed?: string | null; later?: string | null }) => boolean;
  updatesShown: (o: { demo?: boolean; member?: boolean; available?: boolean }) => boolean;
  versionChanged: (a: string, b: string) => boolean;
  reloadNow: (o: { composer?: string; dialogOpen?: boolean; startedHere?: boolean }) => boolean;
  updatedNote: (seen: string | null, version: string) => boolean;
}
const rules = async (): Promise<Rules> => (await import(`data:text/javascript;base64,${Buffer.from(web('update-check.js')).toString('base64')}`)) as Rules;

const NOW = Date.parse('2026-10-30T12:00:00Z');
const H = 60 * 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('on-open check: at most every 12 hours, one at a time, never in the demo, for members or in private local mode', async () => {
  const { shouldCheck, CHECK_EVERY_MS } = await rules();
  assert.equal(CHECK_EVERY_MS, 12 * H);
  const owner = { available: true, now: NOW };
  assert.equal(shouldCheck({ ...owner, status: { state: 'idle' } }), true, 'never checked: check');
  assert.equal(shouldCheck({ ...owner, status: null }), true);
  assert.equal(shouldCheck({ ...owner, status: { state: 'current', at: ago(2 * H) } }), false, 'checked 2 hours ago: reuse');
  assert.equal(shouldCheck({ ...owner, status: { state: 'available', at: ago(11.9 * H) } }), false);
  assert.equal(shouldCheck({ ...owner, status: { state: 'current', at: ago(12 * H) } }), true, '12 hours old: check again');
  assert.equal(shouldCheck({ ...owner, status: { state: 'failed', at: ago(13 * H) } }), true);
  assert.equal(shouldCheck({ ...owner, status: { state: 'checking', at: ago(13 * H) } }), false, 'one check in flight (server)');
  assert.equal(shouldCheck({ ...owner, status: { state: 'idle', pending: 'check' } }), false);
  assert.equal(shouldCheck({ ...owner, inFlight: true, status: null }), false, 'one check in flight (page)');
  assert.equal(shouldCheck({ ...owner, status: { state: 'updating' } }), false);
  assert.equal(shouldCheck({ ...owner, demo: true, status: null }), false, 'never in the demo');
  assert.equal(shouldCheck({ ...owner, member: true, status: null }), false, 'never for a household member');
  assert.equal(shouldCheck({ ...owner, privateLocal: true, status: null }), false, 'never in private local mode');
  assert.equal(shouldCheck({ available: false, now: NOW, status: null }), false, 'a server without updates (Docker, dev)');
  assert.equal(shouldCheck({ ...owner, status: { state: 'current', at: new Date(NOW + 5 * H).toISOString() } }), true, 'a clock that jumped back does not block checks for ever');
});

test('"Sara X is available": a dismissed version is remembered, a newer one shows again; Later is for this session', async () => {
  const { shouldRemind } = await rules();
  const avail = (latest: string) => ({ state: 'available', latest });
  assert.equal(shouldRemind({ status: avail('2.18.0'), version: '2.17.2' }), true);
  assert.equal(shouldRemind({ status: { state: 'current', latest: '2.17.2' }, version: '2.17.2' }), false);
  assert.equal(shouldRemind({ status: avail('2.17.2'), version: '2.17.2' }), false, 'not this version again');
  assert.equal(shouldRemind({ status: avail('2.18.0'), version: '2.17.2', dismissed: '2.18.0' }), false, "Don't remind me about this version");
  assert.equal(shouldRemind({ status: avail('v2.18.0'), version: '2.17.2', dismissed: '2.18.0' }), false);
  assert.equal(shouldRemind({ status: avail('2.18.1'), version: '2.17.2', dismissed: '2.18.0' }), true, 'a newer version shows again');
  assert.equal(shouldRemind({ status: avail('2.18.0'), version: '2.17.2', later: '2.18.0' }), false, 'Later: not again this session');
  assert.equal(shouldRemind({ status: avail('2.19.0'), version: '2.17.2', later: '2.18.0' }), true);
  assert.equal(shouldRemind({ status: null }), false);
  // The app stores them per version on this device (localStorage) and per session (sessionStorage).
  const app = web('app.js');
  assert.match(app, /store\(\$\('#upp-dismiss'\)\.checked \? localStorage : sessionStorage, \$\('#upp-dismiss'\)\.checked \? DISMISS_KEY : LATER_KEY, latest\)/);
  assert.match(app, /dismissed: store\(localStorage, DISMISS_KEY\), later: store\(sessionStorage, LATER_KEY\)/);
});

test('the update UI is the owner\'s only, never in the demo; the page wires it up only then', async () => {
  const { updatesShown } = await rules();
  assert.equal(updatesShown({ available: true }), true);
  assert.equal(updatesShown({ available: true, member: true }), false);
  assert.equal(updatesShown({ available: true, demo: true }), false);
  assert.equal(updatesShown({ available: false }), false);
  const app = web('app.js');
  assert.match(app, /import \{ DISMISS_KEY, SEEN_KEY, reloadNow, shouldCheck, shouldRemind, updatedNote, updatesShown, updateTone, versionChanged \} from '\.\/update-check\.js';/);
  const init = app.slice(app.indexOf('function startUpdateChecks'), app.indexOf('async function updateTick'));
  assert.match(init, /if \(!upx\.version \|\| upx\.demo \|\| upx\.member \|\| upx\.tick\) return;/, 'no checks for members or in the demo; started once');
  assert.match(app, /initUpdates\(session\);/);
  assert.match(app, /startUpdateChecks\(\);/);
  // The popup never covers another window, and its link is owner-only markup.
  assert.match(app, /if \(document\.querySelector\('dialog\[open\]:not\(\.today-view\)'\)\) return;/);
});

test('reload after an update: version change detection, and no reload under the owner\'s feet', async () => {
  const { versionChanged, reloadNow, updatedNote } = await rules();
  assert.equal(versionChanged('2.17.2', '2.18.0'), true);
  assert.equal(versionChanged('2.17.2', '2.17.2'), false);
  assert.equal(versionChanged('2.17.2', ''), false, 'the server is still restarting');
  assert.equal(versionChanged('', '2.18.0'), false, 'the demo has no version');
  assert.equal(versionChanged('2.18.0', '2.17.2'), true, 'went back (rollback) also reloads');
  assert.equal(reloadNow({ composer: '', dialogOpen: false }), true);
  assert.equal(reloadNow({ composer: 'half a sentence', dialogOpen: false }), false, 'typing: show the bar instead');
  assert.equal(reloadNow({ composer: '  ', dialogOpen: true }), false, 'a window is open: show the bar instead');
  assert.equal(reloadNow({ composer: 'x', dialogOpen: true, startedHere: true }), true, 'the page that pressed Update now reloads');
  assert.equal(updatedNote('2.17.2', '2.18.0'), true, '"Sara was updated to 2.18.0"');
  assert.equal(updatedNote(null, '2.18.0'), false, 'first visit on this device');
  assert.equal(updatedNote('2.18.0', '2.18.0'), false);
  const app = web('app.js');
  // The events stream reconnecting after the restart looks at the server's version.
  assert.match(app, /es\.addEventListener\('open', \(\) => void checkServerVersion\(\)\);/);
  assert.match(app, /location\.reload\(\);/);
  assert.match(app, /\$\('#update-note-reload'\)\.addEventListener\('click', \(\) => location\.reload\(\)\);/, 'the manual Reload now');
  assert.match(app, /navigator\.serviceWorker\?\.getRegistration\(\)\)\?\.update\(\)/, 'the new service worker first');
});

test('the sidebar footer link: under Sara / Help / Settings, amber at Night, blue by Day; the popup is a dialog', () => {
  const html = web('index.html');
  const foot = html.indexOf('class="side-foot-row"');
  const link = html.indexOf('id="side-update"');
  assert.ok(foot > 0 && link > foot && link < html.indexOf('</nav>', foot), 'below the footer row, inside the sidebar nav (the phone opens it from More)');
  assert.match(html, /<button id="side-update" type="button" class="side-update" data-owner-only hidden/);
  assert.match(html, /<dialog id="update-pop" class="update-pop"/);
  assert.match(html, /<input id="upp-dismiss" type="checkbox"> <span>Don't remind me about this version <button type="button" class="tip"/);
  assert.match(html, /<button id="update-note-reload" type="button" hidden>Reload now<\/button>/);
  const css = web('ui-tidy.css');
  assert.match(css, /\.side-update \{[^}]*min-height: 44px;[^}]*color: var\(--update-accent\);/);
  const theme = web('theme.css');
  const night = theme.slice(theme.indexOf(':root[data-theme="dark"]'), theme.indexOf(':root[data-theme="light"]'));
  const day = theme.slice(theme.indexOf(':root[data-theme="light"]'));
  assert.match(night, /--update-accent: #f5b452;/, 'amber at Night');
  assert.match(day, /--update-accent: #2456c0;/, 'blue by Day');
  assert.doesNotMatch(css.slice(css.indexOf('/* 2.18: updates.')), /#[0-9a-f]{3,8}\b/i, 'colours only through tokens');
  assert.match(web('icons.js'), /\n {2}update: '/);
});

test('the service worker cache was bumped for 2.18 (older caches are deleted)', () => {
  const sw = web('sw.js');
  assert.match(sw, /caches\.open\('sara-shell-v19'\)/);
  assert.match(sw, /k !== 'sara-shell-v19'/);
  assert.match(sw, /sara-shell-v18 from Phase 85/);
  assert.match(sw, /Phase 85 had caches\.open\('sara-shell-v18'\)/);
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});

// The server side: the session says which version runs (not in the demo); the release check is shared.
const { dir, cleanup } = tempDir();
const app = makeApp(dir, { now: new Date() });
const auth = new OwnerAuth(dir);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), updaterPlatform: 'win32', updaterFetch: (async () => new Response(JSON.stringify({ tag_name: 'v9.0.0', body: '- One\n- Two' }))) as never, info: { version: '2.17.2', revision: null, startedAt: new Date().toISOString() } } as never);
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  setPrivateLocal(false);
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('the session tells the page which version runs (signed in only)', async () => {
  assert.equal((await (await call('/api/session')).json()).version, '2.17.2');
  assert.equal((await (await fetch(`${base}/api/session`)).json()).version, undefined, 'not before sign-in');
});

test('checking: refused in private local mode; on Windows/macOS several pages at once share one request', async () => {
  setPrivateLocal(true);
  assert.equal((await call('/api/update', { action: 'check' })).status, 409);
  setPrivateLocal(false);
  const r = await (await call('/api/update', { action: 'check' })).json();
  assert.equal(r.status.state, 'available');
  assert.equal(r.status.latest, '9.0.0');
  assert.deepEqual(r.status.changes, ['One', 'Two']);
  let calls = 0;
  const u = new Updater({ dataDir: dir, platform: 'win32', version: '2.17.2', fetch: (async (url: string) => {
    // C9: the signed notice is asked first; this counts the GitHub requests.
    if (!String(url).endsWith('/update-notice.json')) calls++;
    await new Promise((res) => setTimeout(res, 20));
    return new Response(JSON.stringify({ tag_name: 'v2.18.0' }));
  }) as never });
  const [a, b] = await Promise.all([u.check(), u.check()]);
  assert.equal(calls, 1, 'one request to GitHub');
  assert.equal(a.latest, '2.18.0');
  assert.equal(b.latest, '2.18.0');
  await u.check();
  assert.equal(calls, 2, 'a later check asks again');
});
