// U2.10 (iPhone web app fixes): the phone-app card speaks to the device it is shown on (no Android
// text on an iPhone), and errands waiting on you count in the app badge (GET /api/phone/badge and
// every web push's data.badge, which the service worker passes to setAppBadge).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { Errands } from '../src/errands.ts';
import { PushService } from '../src/push.ts';
import { createSaraServer } from '../src/server.ts';
import { badgeCount, waitingCount } from '../src/shortcuts.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function reachModule() {
  const { registerHooks } = await import('node:module');
  registerHooks({ resolve: (spec, ctx, next) => (spec === './identity.js' ? next(new URL('../src/identity.ts', import.meta.url).href, ctx) : next(spec, ctx)) });
  // @ts-ignore: a plain browser module without types
  return (await import('../web/reach.js')) as { appLines: (o: { ua: string; maxTouchPoints?: number; standalone?: boolean }) => { strong: string; text?: string; link?: [string, string] }[] };
}
const flat = (lines: { strong: string; text?: string; link?: [string, string] }[]) => lines.map((l) => [l.strong, l.text ?? '', ...(l.link ?? [])].join(' ')).join('\n');

test('reach: the phone-app card on an iPhone says Home Screen, never Android or Google Play', async () => {
  const { appLines } = await reachModule();
  const ios = flat(appLines({ ua: IPHONE }));
  assert.match(ios, /Add to Home Screen/);
  assert.match(ios, /Safari/);
  assert.doesNotMatch(ios, /Android|Google Play|play\.google\.com/);
  // iPadOS asks for the desktop site: a touch screen still makes it an iPhone/iPad.
  const ipad = flat(appLines({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', maxTouchPoints: 5 }));
  assert.doesNotMatch(ipad, /Android|Google Play/);
  // Already opened from the Home Screen: nothing to install.
  const home = flat(appLines({ ua: IPHONE, standalone: true }));
  assert.match(home, /already on your Home Screen/);
  assert.doesNotMatch(home, /Android|Google Play/);
});

test('reach: Android gets Google Play; a computer shows both phones', async () => {
  const { appLines } = await reachModule();
  const android = appLines({ ua: ANDROID });
  assert.equal(android.length, 1);
  assert.match(flat(android), /Android[\s\S]*play\.google\.com\/store\/apps\/details\?id=com\.backstagecoding\.sara/);
  assert.doesNotMatch(flat(android), /Home Screen/);
  const pc = flat(appLines({ ua: WINDOWS }));
  assert.match(pc, /Google Play/);
  assert.match(pc, /iPhone[\s\S]*Home Screen/);
});

test('reach: renderPhoneConnect uses the device-aware lines (static wiring)', () => {
  const reach = read('web', 'reach.js');
  assert.match(reach, /appLines\(\{ ua: navigator\.userAgent, maxTouchPoints: navigator\.maxTouchPoints, standalone: isStandalone\(\) \}\)/);
  assert.doesNotMatch(reach, /function getTheApp\(\)/, 'the old Android-only step is gone');
});

test('badge: errands waiting on you count (badgeCount and the widget line)', () => {
  const active = new Map([['c1', { approvals: new Map([['a', 1]]) }]]);
  const app = { inbox: { list: () => [{ id: 1 }] }, messages: { unread: () => 2 }, errands: { waitingOnYou: () => 3 } };
  // @ts-expect-error: a partial app is enough for the counts
  assert.equal(waitingCount(active, app), 5);
  // @ts-expect-error: a partial app is enough for the counts
  assert.equal(badgeCount(active, app), 7);
  // Older stubs without errands still count.
  // @ts-expect-error: partial app
  assert.equal(badgeCount(new Map(), { inbox: { list: () => [] } }), 0);
  // A throwing errands store never breaks the badge.
  // @ts-expect-error: partial app
  assert.equal(badgeCount(new Map(), { errands: { waitingOnYou: () => { throw new Error('closed'); } } }), 0);
});

const { dir, cleanup } = tempDir();
const app = makeApp(dir, { now: new Date() });
after(() => {
  app.store.close();
  cleanup();
});

test('badge: a real errand waiting on you shows in GET /api/phone/badge and in the push badge', async () => {
  const errands = new Errands(app, app.store.db, { notify: async () => {}, quiet: () => false });
  app.errands = errands;
  const e = errands.start({ goal: 'Get the Acme charge refunded', facts: { merchant: 'Acme Store' } }, { by: 'page' });
  assert.equal(errands.waitingOnYou(), e.status === 'waiting_you' ? 1 : 0);
  app.store.db.prepare("UPDATE errands SET status = 'waiting_you' WHERE id = ?").run(e.id);
  const other = errands.start({ goal: 'Find a plumber', facts: {} }, { by: 'page' });
  app.store.db.prepare("UPDATE errands SET status = 'working' WHERE id = ?").run(other.id);
  assert.equal(errands.waitingOnYou(), 1);

  app.push = new PushService(app.store.db, app.vault, app.settings, { now: () => new Date() });
  const auth = new OwnerAuth(dir, () => new Date());
  const owner = { authorization: `Bearer ${auth.newToken}` };
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await (await fetch(`${base}/api/phone/badge`, { headers: owner })).json()).count, 1);
    assert.equal(app.push.badge?.(), 1, 'every web push carries data.badge with the errand in it');
    app.store.db.prepare("UPDATE errands SET status = 'done' WHERE id = ?").run(e.id);
    assert.equal((await (await fetch(`${base}/api/phone/badge`, { headers: owner })).json()).count, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('badge: the service worker passes data.badge to setAppBadge; the page refreshes when errands change', () => {
  const sw = read('web', 'sw.js');
  assert.match(sw, /typeof data\.badge === 'number' && self\.navigator\?\.setAppBadge/);
  assert.match(read('web', 'app.js'), /part === 'needs' \|\| part === 'errands'\) void refreshBadge\(\)/);
});

test('phone layout: 44 px targets on the new screens, safe areas on the full-screen ones, no nowrap overflow', () => {
  const tidy = read('web', 'ui-tidy.css');
  const block = tidy.slice(tidy.indexOf('---------- U2.10'), tidy.indexOf('#lib-doc-studio button') + 200);
  assert.match(block, /@media \(pointer: coarse\)/);
  for (const id of ['#goals', '#errands', '#trips', '#meetings', '#msgs', '#library', '#ask-all', '#hz-view', '#memory', '#team', '#try-these', '#settings']) assert.ok(block.includes(id), id);
  assert.match(block, /min-height: 44px/);
  assert.match(block, /dialog \.dialog-x[^{]*\{ min-width: 44px; min-height: 44px; \}/);
  assert.match(block, /\.tip:not\(#_\)::before \{ position: absolute; inset: -14px;/);
  // Settings tips draw their "i" in ::before: the hit-area rule must not blank it there.
  assert.doesNotMatch(block, /#settings\) \.tip:not\(#_\)::before \{ content: ""/);
  // Full-screen phone dialogs keep clear of the notch and the home indicator (never env() directly).
  assert.match(read('web', 'ask-everything.css'), /dialog#ask-all:not\(#_\) \{ padding-top: calc\(16px \+ var\(--safe-t\)\); padding-bottom: calc\(16px \+ var\(--safe-b\)\); \}/);
  assert.match(read('web', 'doc-card.css'), /dialog#hz-view:not\(#_\) \{[^}]*padding: calc\(12px \+ var\(--safe-t\)\) 12px calc\(12px \+ var\(--safe-b\)\)/);
  assert.match(read('web', 'today.css'), /@media \(max-width: 720px\) \{ #ih-page label\.ih-check \{ white-space: normal; \} \}/);
});
