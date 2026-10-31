// UI cleanup (wave 1): the scrapbook's photo actions on the server (remove from the scrapbook only,
// bring back, delete everywhere after a confirm; refused in the demo; per companion), and static
// checks on the web app: the sidebar keeps every place's button id, Settings keeps every page id,
// and every built-in tool has a plain name and a group on Tools and approvals.
// Wave 2: the shared window pieces (cards, empty states, folded intros, ⋯ menus), the approval card
// in plain words, the offline page in the app's colours, and the old sidebar CSS gone.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { memberRouteCheck, type MemberRecord } from '../src/household.ts';
import { MomentsStore, MomentsWorker } from '../src/moments.ts';
import { Scrapbook } from '../src/scrapbook.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-10-29T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: now.toISOString() });
  const moments = new MomentsStore(app.store.db, () => now);
  app.moments = moments;
  app.momentsWorker = new MomentsWorker(app, moments);
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const c of closers) c();
    app.store.close();
    cleanup();
  });
  return { app, closers };
}

async function serve(app: TestApp, closers: (() => void)[], opts: { demo?: boolean } = {}) {
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(opts.demo ? { demo: true } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.unshift(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
}

test('scrapbook photos: remove from the scrapbook only, put back, delete everywhere after a confirm', async (t) => {
  const { app, closers } = setup(t);
  const j = await serve(app, closers);
  const a = app.uploads!.save(PNG).id;
  const b = app.uploads!.save(PNG2).id;
  const conv = app.store.createConversation({ title: 'Beach day' });
  const ma = app.store.addMessage(conv.id, 'user', 'The sunset!', { images: [a] });
  const mb = app.store.addMessage(conv.id, 'assistant', 'And me.', { images: [b] });
  let d = (await j('GET', '/scrapbook')).body;
  assert.deepEqual(d.photos.map((p: { image: string }) => p.image).sort(), [a, b].sort());
  assert.deepEqual(d.hiddenPhotos, []);

  // Wrong or unknown names are refused before anything happens.
  assert.equal((await j('POST', '/scrapbook/photos/hide', { image: '../secret.png' })).status, 400);
  assert.equal((await j('POST', '/scrapbook/photos/hide', { image: `${'f'.repeat(32)}.png` })).status, 404);

  // Remove from the scrapbook: gone from the list, the message and the file stay.
  assert.equal((await j('POST', '/scrapbook/photos/hide', { image: a })).body.changed, true);
  d = (await j('GET', '/scrapbook')).body;
  assert.deepEqual(d.photos.map((p: { image: string }) => p.image), [b]);
  assert.deepEqual(d.hiddenPhotos.map((p: { image: string }) => p.image), [a]);
  assert.deepEqual(app.store.messageById(ma.id)!.meta!.images, [a]);
  assert.ok(existsSync(join(app.dataDir, 'uploads', a)));
  assert.equal((await j('POST', '/scrapbook/photos/hide', { image: a })).body.changed, false, 'twice is fine');
  // Put back.
  assert.equal((await j('POST', '/scrapbook/photos/unhide', { image: a })).body.changed, true);
  assert.equal((await j('GET', '/scrapbook')).body.photos.length, 2);

  // Delete everywhere asks first, then takes it out of the message (words stay) and deletes the file.
  assert.equal((await j('POST', '/scrapbook/photos/delete', { image: b })).status, 400);
  assert.ok(existsSync(join(app.dataDir, 'uploads', b)));
  const del = await j('POST', '/scrapbook/photos/delete', { image: b, confirm: true });
  assert.equal(del.status, 200);
  assert.equal(del.body.messages, 1);
  const after = app.store.messageById(mb.id)!;
  assert.equal(after.content, 'And me.');
  assert.deepEqual(after.meta!.images, []);
  assert.equal(existsSync(join(app.dataDir, 'uploads', b)), false);
  d = (await j('GET', '/scrapbook')).body;
  assert.deepEqual(d.photos.map((p: { image: string }) => p.image), [a]);
  // A photo removed from the scrapbook can still be deleted everywhere.
  await j('POST', '/scrapbook/photos/hide', { image: a });
  assert.equal((await j('POST', '/scrapbook/photos/delete', { image: a, confirm: true })).status, 200);
  d = (await j('GET', '/scrapbook')).body;
  assert.deepEqual([d.photos.length, d.hiddenPhotos.length], [0, 0]);

  // Moments and jokes: delete removes the entry only.
  const joke = (await j('POST', '/scrapbook', { kind: 'joke', text: 'Never trust a waffle.' })).body;
  assert.equal((await j('DELETE', `/scrapbook/${joke.id}`)).status, 200);
  assert.equal((await j('DELETE', `/scrapbook/${joke.id}`)).status, 404);
});

test('scrapbook photos: the demo refuses every photo action', async (t) => {
  const { app, closers } = setup(t);
  const j = await serve(app, closers, { demo: true });
  const a = app.uploads!.save(PNG).id;
  const conv = app.store.createConversation({ title: 'x' });
  app.store.addMessage(conv.id, 'user', 'hi', { images: [a] });
  for (const c of ['hide', 'unhide', 'delete']) assert.equal((await j('POST', `/scrapbook/photos/${c}`, { image: a, confirm: true })).status, 403, c);
  assert.ok(existsSync(join(app.dataDir, 'uploads', a)));
});

test('scrapbook photos: removed photos are kept per companion (each has its own database)', () => {
  const one = new DatabaseSync(':memory:');
  const two = new DatabaseSync(':memory:');
  const a = new Scrapbook(one);
  const b = new Scrapbook(two);
  const img = `${'a'.repeat(32)}.jpg`;
  assert.equal(a.hidePhoto(img), true);
  assert.deepEqual([...a.hiddenImages()], [img]);
  assert.deepEqual([...b.hiddenImages()], []);
  assert.throws(() => a.hidePhoto('nope.exe'));
  // Household members reach the scrapbook routes in their own space.
  const rec = { id: 'm1', status: 'active', limits: { voice: true, pictures: true } } as unknown as MemberRecord;
  assert.equal(memberRouteCheck(rec, 'POST', ['scrapbook', 'photos', 'hide']), undefined);
  one.close();
  two.close();
});

const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
const nav = readFileSync(join(ROOT, 'web', 'nav.js'), 'utf8');

test('sidebar: every place keeps its button id, More holds the rest, her and Settings/Help sit below', () => {
  assert.match(html, /<link rel="stylesheet" href="\/style.css">\s*<link rel="stylesheet" href="\/ui-tidy.css">/);
  for (const id of ['open-today', 'open-planner', 'open-memory', 'open-library', 'open-scrapbook', 'open-moments', 'open-story', 'open-team', 'open-sara', 'open-settings', 'open-help', 'side-more', 'side-more-menu', 'side-pinned', 'toggle-sidebar', 'team-dot']) assert.match(html, new RegExp(`id="${id}"`), id);
  const dests = [...html.matchAll(/class="side-dest" data-dest="(\w+)"/g)].map((m) => m[1]);
  const listed = /export const DESTS = \[([^\]]+)\]/.exec(nav)![1].match(/\w+/g);
  assert.deepEqual(dests, listed, 'nav.js lists every place in the page');
  assert.match(nav, /export const DEFAULT_PINS = \['today', 'planner', 'library', 'moments'\]/);
  // The More button says what it does; icon-only buttons have names.
  assert.match(html, /id="side-more"[^>]*aria-expanded="false"[^>]*aria-controls="side-more-menu"/);
  assert.match(html, /id="open-help"[^>]*aria-label="Help"/);
  assert.match(html, /id="open-settings"[^>]*aria-label="Settings"/);
  // The tour opens More for places that live there.
  for (const id of ['open-today', 'open-planner', 'open-memory', 'open-library', 'open-team']) assert.match(app, new RegExp(`before: navStep\\('#${id}'\\), sel: '#${id}'`), id);
  // Links and shortcuts still click the same buttons.
  for (const v of ['today', 'planner', 'memory', 'library', 'scrapbook', 'moments', 'story', 'her', 'team', 'help']) assert.match(app, new RegExp(`\\b${v}: `), v);
});

test('settings: groups and order cover every page; page ids unchanged', () => {
  const pages = [...html.matchAll(/class="settings-page[^"]*" data-page="([\w-]+)" data-group="([^"]+)"/g)].map((m) => ({ page: m[1], group: m[2] }));
  assert.equal(pages.length, 48); // Phase 79: + Abilities → Budgets; Phase 87: + Connections → Computer use; Phase 96: + Abilities → Skills; Phase 98: + Abilities → Plugins; Phase 100: + Connections → Other agents; Phase 102: + Connections → Webhooks; Phase 104: + Data & health → Move in from another agent
  const order = /const SETTINGS_ORDER = \[([\s\S]*?)\];/.exec(app)![1].match(/'([\w-]+)'/g)!.map((s) => s.slice(1, -1));
  assert.deepEqual([...order].sort(), pages.map((p) => p.page).sort(), 'SETTINGS_ORDER lists every page once');
  const groups = [...(/const SETTINGS_GROUPS = \[([\s\S]*?)\];/.exec(app)![1].matchAll(/name: '([^']+)'/g))].map((m) => m[1]);
  for (const p of pages) assert.ok(groups.includes(p.group), `group ${p.group} has a header`);
  // Every page has its one-line description.
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')).pages as Record<string, [string, string]>;
  for (const p of pages) assert.ok(tips[p.page]?.[0], p.page);
  assert.match(html, /id="settings-page-desc"/);
});

test('tools: every built-in tool has a plain name, a description and a group', () => {
  const map = (name: string) => {
    const body = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(app)![1];
    return new Map([...body.matchAll(/(\w+): '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]));
  };
  const words = map('TOOL_WORDS');
  const names = map('TOOL_NAME');
  const groupOf = map('TOOL_GROUP_OF');
  const groupText = map('TOOL_GROUP_TEXT');
  const about = map('TOOL_GROUP_ABOUT');
  assert.ok(words.size > 60);
  for (const tool of words.keys()) {
    assert.ok(names.has(tool), `TOOL_NAME.${tool}`);
    assert.ok(groupOf.has(tool), `TOOL_GROUP_OF.${tool}`);
  }
  for (const g of new Set(groupOf.values())) assert.ok(groupText.has(g) && about.has(g), g);
  const order = /const TOOL_GROUP_ORDER = \[([^\]]+)\]/.exec(app)![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1));
  for (const g of groupText.keys()) assert.ok(order.includes(g), g);
});

const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
const tidyCss = readFileSync(join(ROOT, 'web', 'ui-tidy.css'), 'utf8');
const tidy = readFileSync(join(ROOT, 'web', 'tidy.js'), 'utf8');

test('wave 2: shared window pieces are defined once and used by the windows', () => {
  for (const sel of ['.tidy-card', '.tidy-stack', '.tidy-section-head', '.tidy-toolbar', '.tidy-pill', '.empty-state', '.tidy-foot', 'button.danger', '.dlg-intro', '.tidy-overflow', '.tidy-more-btn']) {
    assert.ok(tidyCss.includes(sel), `ui-tidy.css defines ${sel}`);
  }
  // Folded intros: every window listed exists and has a title followed by its paragraph.
  const wins = /export const INTRO_WINDOWS = \[([^\]]+)\]/.exec(tidy)![1].match(/'#([\w-]+)'/g)!.map((s) => s.slice(2, -1));
  assert.ok(wins.length >= 6);
  for (const id of wins) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /import \{ emptyState, initTidy, overflowMenu \} from '\.\/tidy\.js';/);
  assert.match(app, /\ninitTidy\(\);\n/);
  // Empty lists use the shared empty state.
  for (const f of ['app.js', 'library.js', 'moments.js']) assert.match(readFileSync(join(ROOT, 'web', f), 'utf8'), /emptyState\(/, f);
});

test('wave 2: the document page keeps its button ids behind ⋯, and the approval card speaks plainly', () => {
  // The real buttons stay in the page (with their ids and handlers); the ⋯ menu clicks them.
  const more = /<button type="button" class="ghost small tidy-more-btn"[^>]*>⋯<\/button>\s*<span class="tidy-overflow">([\s\S]*?)<\/span>/.exec(html);
  assert.ok(more, 'the document page has a ⋯ with its overflow box');
  for (const id of ['lib-doc-reread', 'lib-doc-relearn', 'lib-doc-delete']) assert.match(more![1], new RegExp(`id="${id}"`), id);
  assert.match(tidy, /b\.click\(\)/);
  // A built-in tool's approval shows its plain name, its sentence and the raw name in small print.
  const card = /function approvalCard\(ev, block\) \{([\s\S]*?)\n\}/.exec(app)![1];
  assert.match(card, /TOOL_NAME\[ev\.name\]/);
  assert.match(card, /t\('\{app\} wants to: \{what\}'/);
  assert.match(card, /TOOL_WORDS\[ev\.name\]/);
  assert.match(card, /approval-raw/);
});

test('wave 2: the offline page matches the app and the old sidebar CSS is gone', () => {
  const offline = readFileSync(join(ROOT, 'web', 'offline.html'), 'utf8');
  const offlineCss = readFileSync(join(ROOT, 'web', 'offline.css'), 'utf8');
  assert.match(offline, /Can't reach your Sara/);
  assert.doesNotMatch(offlineCss, /#c76b98/i, 'no old pink');
  // Phase 75 (stage 3): the app's own tokens and theme (Night / Day) instead of a copy of the colours.
  assert.match(offline, /<script src="\/theme-boot.js"><\/script>\s*<link rel="stylesheet" href="\/theme.css">\s*<link rel="stylesheet" href="\/offline.css">/);
  assert.doesNotMatch(offlineCss, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no colours of its own');
  for (const v of ['var(--surface-0)', 'var(--text-1)', 'var(--btn-fill)']) assert.ok(offlineCss.includes(v), v);
  // v3 cached the new offline page; later versions (Phase 75: v4, v6 with the theme files) only bump it.
  const sw = readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8');
  assert.ok(Number(/sara-shell-v(\d+)/.exec(sw)?.[1]) >= 6, 'the service worker caches the new offline page');
  for (const f of ['/offline.css', '/theme.css', '/theme-boot.js']) assert.ok(sw.includes(`'${f}'`), `cached: ${f}`);
  // Removed with the wave 1 sidebar: no rules for classes the page no longer has.
  for (const gone of ['.side-bar', '.side-foot ', '.help-box', '.help-btn', '.route-help', 'section.settings-tab']) assert.ok(!css.includes(gone), gone);
});
