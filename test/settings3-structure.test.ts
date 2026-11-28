// SETTINGS3 S2 (docs/design/SETTINGS3.md): 6 groups + Household with merged pages as sections of a host and
// tile pages under Apps and services. Every old page id still opens the right place (links, tips, tours and
// How do I…? answers use them). Runs showSettingsTab from web/app.js in a small sandbox (like test/q2-ui).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
const heads = [...html.matchAll(/<section class="settings-page[^"]*" data-page="([\w-]+)" data-group="([^"]+)" data-title="([^"]+)"([^>]*)>/g)].map((m) => ({
  page: m[1],
  group: m[2],
  title: m[3],
  host: /data-host="([\w-]+)"/.exec(m[4])?.[1],
  tile: /data-tile="(\w+)"/.exec(m[4])?.[1],
}));

/** Runs the real showSettingsTab over every page of index.html; returns what is on screen. */
function open(id: string) {
  const app = web('app.js');
  const start = app.indexOf('function showSettingsTab(');
  const end = app.indexOf('\n}\n', start) + 2;
  const pages = heads.map((h) => ({ dataset: { page: h.page, title: h.title, group: h.group, ...(h.host ? { host: h.host } : {}), ...(h.tile ? { tile: h.tile } : {}) }, hidden: true, querySelector: () => null }));
  const node = () => ({ hidden: false, textContent: '', scrollTop: 0, value: '', classList: { add() {} }, toggleAttribute() {}, focus() {} });
  const nodes: Record<string, ReturnType<typeof node>> = {};
  const $ = (q: string) => (nodes[q] ??= node());
  const nav = [...new Set(heads.filter((h) => !h.host && !h.tile).map((h) => h.page)), 'co-services'].map((page) => ({ dataset: { page }, current: '', setAttribute(_k: string, v: string) { this.current = v; } }));
  const stored: Record<string, string> = {};
  const calls: string[] = [];
  runInNewContext(`${app.slice(start, end)}\nshowSettingsTab(${JSON.stringify(id)});`, {
    OLD_TABS: {}, OWN_PAGES: {}, OWN_RELOAD: {}, settingsPages: () => pages, $, t: (s: string) => s,
    document: { querySelectorAll: (q: string) => (q.includes('settings-nav-list') ? nav : []), getElementById: () => null },
    showSettingsHelp() {}, openGroupOf() {}, paintCrumbs() {}, showServices: () => calls.push('services'), setTimeout() {}, requestAnimationFrame() {},
    localStorage: { setItem: (k: string, v: string) => (stored[k] = v), getItem: (k: string) => stored[k] ?? null },
    inPhoneApp: () => false, navigator: { userAgent: '' }, isMember: () => true,
    ...Object.fromEntries([...app.slice(start, end).matchAll(/(?<![.\w])([a-z]\w*)\(/g)].filter((m) => !['showSettingsTab', 'function', 'if', 'for', 'String', 'settingsPages', 'showServices', 'setTimeout', 'requestAnimationFrame'].includes(m[1])).map((m) => [m[1], () => calls.push(m[1])])),
    readiness: { refresh() {} }, recovery: { refresh() {} }, operations: { refresh() {} }, monitoring: { refresh() {} }, secretSourcesView: { refresh() {} },
  });
  return { shown: pages.filter((p) => !p.hidden).map((p) => p.dataset.page), current: nav.filter((b) => b.current === 'true').map((b) => b.dataset.page), stored: stored['sara.settingsPage'], calls };
}

test('S2: the 13 merged pages open their host with every section of it, the rail marks the host, the old id is remembered', () => {
  const merged = heads.filter((h) => h.host);
  assert.equal(merged.length, 13); // V2.6 adds you-upkeep (under My details); V5.1 dh-timeline (under Reports)
  for (const m of merged) {
    const r = open(m.page);
    const parts = heads.filter((h) => h.host === m.host).map((h) => h.page);
    assert.deepEqual(r.shown.sort(), [m.host!, ...parts].sort(), m.page);
    const entry = heads.find((h) => h.page === m.host)!.tile ? 'co-services' : m.host;
    assert.deepEqual(r.current, [entry], `${m.page}: the rail marks ${entry}`);
    assert.equal(r.stored, m.page, `${m.page} is remembered as itself`);
  }
  // A host opens with its sections and their loaders (Health loads How she did, Recovery and Operations).
  const health = open('dh-health');
  assert.deepEqual(health.shown.sort(), ['dh-health', 'dh-operations', 'dh-quality', 'dh-recovery']);
  for (const l of ['loadQuality']) assert.ok(health.calls.includes(l), l);
  assert.ok(open('you-briefing').calls.includes('loadWhenSettings'), 'When it comes up loads on Briefing and reminders');
  assert.ok(open('dh-usage').calls.includes('loadBudgets'), 'Budgets load on Usage and costs');
});

test('S2: every tile page opens on its own with Apps and services marked; co-services opens the hub; every other page opens itself', () => {
  for (const h of heads.filter((x) => x.tile)) {
    const r = open(h.page);
    assert.deepEqual(r.shown.sort(), [h.page, ...heads.filter((x) => x.host === h.page).map((x) => x.page)].sort(), h.page);
    assert.deepEqual(r.current, ['co-services'], h.page);
  }
  assert.deepEqual(open('co-services').calls, ['services']);
  for (const h of heads.filter((x) => !x.tile && !x.host && !heads.some((y) => y.host === x.page))) assert.deepEqual(open(h.page).shown, [h.page], h.page);
});

test('S2: names, aliases and translations of the new structure', () => {
  const nav = web('settings-nav.js');
  // Coding is a sub-heading inside Skills & tools (owner decision 1), the first group is named after her (2).
  assert.match(nav, /const SETTINGS_SUB = \{ 'ab-projects': 'Coding' \};/);
  assert.match(nav, /\{ name: 'Sara', icon:/);
  // Renamed hosts keep their old names as search words.
  const search = web('settings-search.js');
  for (const [id, old] of [['you-briefing', 'morning briefing'], ['models-providers', 'model providers'], ['dh-data', 'export and import']]) assert.match(search, new RegExp(`'${id}': \\[[^\\]]*'${old}'`), id);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${l}.json`)) as Record<string, string>;
    for (const k of ['Models & usage', 'Skills & tools', 'Privacy & system', 'Apps and services', 'Briefing and reminders', 'Providers and plans', 'Move in and export', '{old} is gone: its pages are now in {groups}.']) assert.ok(d[k] && d[k] !== k, `${l}: ${k}`);
  }
});
