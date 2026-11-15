// SETTINGS3 S5 (docs/design/SETTINGS3.md): Connections › Apps and services. Every tile page is reachable from
// the hub (its id unchanged); statuses come from endpoints the pages already use.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hub: any = await import(pathToFileURL(join(ROOT, 'web', 'settings-services.js')).href);
const tiles = [...html.matchAll(/<section class="settings-page[^"]*" data-page="([\w-]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*data-tile="(\w+)"/g)].map((m) => ({ dataset: { page: m[1], group: m[2], title: m[3], tile: m[4] } }));

test('S5: every tile page is on the hub once, in its section; tiles are Connections pages', () => {
  assert.equal(tiles.length, 20);
  const model = hub.servicesModel(tiles);
  assert.deepEqual(model.map((g: { id: string }) => g.id), ['chat', 'accounts', 'sources', 'dev']);
  const on = model.flatMap((g: { tiles: { id: string }[] }) => g.tiles.map((x) => x.id));
  assert.deepEqual([...on].sort(), tiles.map((p) => p.dataset.page).sort());
  for (const p of tiles) assert.equal(p.dataset.group, 'Connections', p.dataset.page);
  // Her own mailbox reads "Her own email" on its tile; its page keeps its title.
  assert.equal(model[0].tiles.find((x: { id: string }) => x.id === 'co-email').title, 'Her own email');
  for (const p of tiles) assert.ok(hub.tileMark(p.dataset.page, p.dataset.title).length <= 2, p.dataset.page);
});

test('S5: tile states: not set up by default, connected and needs-you from what the pages load', () => {
  assert.deepEqual(hub.tileState('co-telegram', {}), { state: 'off', line: 'Not set up' });
  assert.deepEqual(hub.tileState('co-telegram', { 'co-telegram': { state: 'on', line: 'Connected · @alex' } }), { state: 'on', line: 'Connected · @alex' });
  assert.deepEqual(hub.tileState('ab-home', { 'ab-home': { state: 'warn' } }), { state: 'warn', line: 'Needs you' });
  const app = web('app.js');
  for (const p of ['/bridges/telegram', '/bridges/discord', '/github', '/google', '/home', '/spotify', '/search', '/data-sources', '/mail/accounts', '/agents', '/hooks', '/other-apps']) assert.ok(app.includes(`'${p}'`), p);
  assert.match(app, /async function refreshServiceFacts\(\) \{\s*if \(isMember\(\)\) return false;/);
});

test('S6: quick settings drive the real controls (one source of truth); the window autosaves once, on the quick switch', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ov: any = await import(pathToFileURL(join(ROOT, 'web', 'settings-overview.js')).href);
  for (const q of ov.QUICK) {
    const sec = new RegExp(`<section class="settings-page[^"]*" data-page="${q.page}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
    assert.ok(sec?.[1].includes(`id="${q.id}"`), `#${q.id} is on ${q.page}`);
  }
  const events: { type: string; bubbles: boolean }[] = [];
  const real = { checked: false, value: 'dark', dispatchEvent: (e: Event) => events.push({ type: e.type, bubbles: e.bubbles }) };
  const doc = { getElementById: () => real };
  assert.equal(ov.applyQuick(ov.QUICK[1], true, doc), true);
  assert.equal(real.checked, true);
  assert.equal(ov.applyQuick(ov.QUICK[0], 'light', doc), true);
  assert.equal(real.value, 'light');
  // The real control hears a change that does not bubble: its own listeners run, the window's autosave
  // (which only acts on trusted, bubbling changes) saves once for the quick switch itself.
  assert.deepEqual(events, [{ type: 'change', bubbles: false }, { type: 'change', bubbles: false }]);
  assert.equal(ov.applyQuick(ov.QUICK[1], true, { getElementById: () => null }), false);
  // The overview sits inside the Settings window, so the quick switch's own change reaches autoSave.
  assert.match(html, /<div id="settings-overview" class="s3-overview" hidden><\/div>\s*<section id="settings-home"/);
});
