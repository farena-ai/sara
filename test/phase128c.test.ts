// Phase 128 slice PL2c (2.61.2, docs/design/POLISH2.md §5 PL2c): forms into choices, the Store and
// packs. Keep going presets (Careful, Normal = today's numbers, Long jobs; the raw numbers under
// Fine-tune, Custom for anything else), the Store's first screen (each item once, a kind icon on every
// card, Browse · My add-ons · Submit), one calm line for Sara's own plugins where nothing can be fenced
// in (third-party plugins keep every amber line), Share her (dials ticked, routine chips, "Check it
// first"), and the smaller PL2c items. Runs as 2.61.2 until the release bumps package.json (like
// phase122b). The server parts through the real HTTP routes with a fake clock; the page parts as
// static checks plus the pure helpers in Node.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fromFolder } from '../src/packages.ts';
import { DEFAULT_PERSIST, GOAL_CHOICES, LOOP_CHOICES, PERSIST_PRESETS, PRESET_IDS, persistSettings, presetOf } from '../src/persist.ts';
import { satisfies } from '../src/plugins/manifest.ts';
import { PLUGIN_LIMITS, PluginManager } from '../src/plugins/manager.ts';
import { parsePackManifest } from '../src/packs/format.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// PL2c ships in 2.61.2; until the release bumps package.json the test runs as 2.61.2.
const V = satisfies(PKG_VERSION, '>=2.61.2') ? PKG_VERSION : '2.61.2';
const START = new Date('2026-11-02T15:00:00Z');
const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
// naming.js imports ./identity.js, which the server serves from src/identity.ts; Node gets the same file.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './identity.js' && ctx.parentURL?.endsWith('/web/naming.js')) return { url: pathToFileURL(join(ROOT, 'src', 'identity.ts')).href, shortCircuit: true };
    return next(spec, ctx);
  },
});
const presetsJs: Any = await import(pathToFileURL(join(ROOT, 'web', 'persist-presets.js')).href);
const notice: Any = await import(pathToFileURL(join(ROOT, 'web', 'plugin-notice.js')).href);
const icons: Any = await import(pathToFileURL(join(ROOT, 'web', 'icons.js')).href);

/** A real Sara server on a free port, an owner token and a fake clock. */
async function server(t: { after: (fn: () => void | Promise<void>) => void }, settings: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(START) };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: START.toISOString(), ...settings } as never);
  const { OwnerAuth } = await import('../src/auth.ts');
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: START.toISOString() } });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    app.store.close();
    cleanup();
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Any };
  };
  return { app, api };
}

const numbersOf = (s: Any) => ({ goals: { rounds: s.goals.rounds, minutes: s.goals.minutes, tokens: s.goals.tokens, usd: s.goals.usd, stuckAfter: s.goals.stuckAfter, checkMinutes: s.goals.checkMinutes }, loops: { minEvery: s.loops.minEvery, defaultFor: s.loops.defaultFor, maxFor: s.loops.maxFor, maxTicks: s.loops.maxTicks, tick: { tokens: s.loops.tick.tokens, steps: s.loops.tick.steps }, dailyTokens: s.loops.dailyTokens, dailyUsd: s.loops.dailyUsd, stuckAfter: s.loops.stuckAfter, failAfter: s.loops.failAfter, maxActive: s.loops.maxActive } });

test('128c.1 N17/Q4: Normal is exactly today’s defaults; every preset number is an offered choice', () => {
  assert.equal(V.startsWith('2.61') || satisfies(V, '>=2.61.2'), true);
  assert.deepEqual(PRESET_IDS, ['careful', 'normal', 'long']);
  // The numbers 2.60 used (DEFAULT_PERSIST, PERSIST.md §3.3), written out so a change can't slip by.
  assert.deepEqual(PERSIST_PRESETS.normal, {
    goals: { rounds: 5, minutes: 60, tokens: 1_000_000, usd: 0, stuckAfter: 2, checkMinutes: 10 },
    loops: { minEvery: 5, defaultFor: 4, maxFor: 24, maxTicks: 48, tick: { tokens: 50_000, steps: 10 }, dailyTokens: 300_000, dailyUsd: 0.5, stuckAfter: 6, failAfter: 2, maxActive: 3 },
  });
  assert.deepEqual(PERSIST_PRESETS.normal, numbersOf(DEFAULT_PERSIST));
  for (const id of PRESET_IDS) {
    const p = PERSIST_PRESETS[id];
    for (const [k, v] of Object.entries(p.goals)) assert.ok((GOAL_CHOICES as Any)[k].includes(v), `${id}.goals.${k} = ${v} is a choice`);
    const L = LOOP_CHOICES as Any;
    for (const [k, v] of Object.entries(p.loops)) if (k !== 'tick') assert.ok(L[k].includes(v), `${id}.loops.${k} = ${v} is a choice`);
    assert.ok(L.tickTokens.includes(p.loops.tick.tokens) && L.tickSteps.includes(p.loops.tick.steps), `${id}.loops.tick`);
    assert.equal(presetOf({ ...DEFAULT_PERSIST, goals: { ...DEFAULT_PERSIST.goals, ...p.goals }, loops: { ...DEFAULT_PERSIST.loops, ...p.loops } }), id);
  }
  // Careful is below Normal and Long jobs above it, on every goal cap.
  for (const k of ['rounds', 'minutes', 'tokens'] as const) assert.ok(PERSIST_PRESETS.careful.goals[k] < PERSIST_PRESETS.normal.goals[k] && PERSIST_PRESETS.normal.goals[k] < PERSIST_PRESETS.long.goals[k], k);
});

test('128c.2 N17: each preset card says its exact numbers in words (rounds, minutes, tokens, dollars)', () => {
  const words = (id: string) => presetsJs.presetSummary((PERSIST_PRESETS as Any)[id]);
  const n = (v: number) => v.toLocaleString();
  const want: Record<string, { goal: string[]; repeats: string[] }> = {
    careful: { goal: ['3 rounds', '30 minutes', `${n(200_000)} tokens`, 'at most $0.25'], repeats: ['every 15 min', '1 at once', `${n(100_000)} tokens a day`, 'at most $0.1'] },
    normal: { goal: ['5 rounds', 'an hour', `${n(1_000_000)} tokens`, 'no dollar cap'], repeats: ['every 5 min', '3 at once', `${n(300_000)} tokens a day`, 'at most $0.5'] },
    long: { goal: ['20 rounds', '4 hours', `${n(2_000_000)} tokens`, 'no dollar cap'], repeats: ['every 5 min', '5 at once', `${n(1_000_000)} tokens a day`, 'at most $2'] },
  };
  for (const [id, w] of Object.entries(want)) {
    const s = words(id);
    for (const x of w.goal) assert.ok(s.goal.includes(x), `${id}: “${s.goal}” says ${x}`);
    for (const x of w.repeats) assert.ok(s.repeats.includes(x), `${id}: “${s.repeats}” says ${x}`);
  }
  assert.equal(presetsJs.timeWords(60), 'an hour');
  assert.equal(presetsJs.timeWords(120), '2 hours');
  assert.equal(presetsJs.timeWords(15), '15 minutes');
  // The page's own helper agrees with the server on which preset a set of numbers is.
  for (const id of PRESET_IDS) assert.equal(presetsJs.whichPreset(PERSIST_PRESETS, { ...(PERSIST_PRESETS as Any)[id], goals: { ...(PERSIST_PRESETS as Any)[id].goals, on: true, reviewer: 'quick' } }), id);
  assert.equal(presetsJs.whichPreset(PERSIST_PRESETS, { ...PERSIST_PRESETS.normal, goals: { ...PERSIST_PRESETS.normal.goals, rounds: 10 } }), 'custom');
  for (const id of ['careful', 'normal', 'long', 'custom']) assert.ok(icons.ICONS[presetsJs.PRESET_ICON[id]], `${id} has a line icon`);
});

test('128c.3 N17: the page has the cards, one intro, and Fine-tune keeps every old field and id', () => {
  const page = /<section class="settings-page" data-page="ab-persist"[\s\S]*?<\/section>/.exec(html)![0];
  for (const id of ['careful', 'normal', 'long', 'custom']) assert.match(page, new RegExp(`<label class="ps-preset" data-preset="${id}"><input type="radio" name="ps-preset" value="${id}">`));
  const fine = /<details id="ps-fine" class="ps-fine">([\s\S]*?)<\/details>/.exec(page)![1];
  for (const id of ['ps-g-rounds', 'ps-g-minutes', 'ps-g-tokens', 'ps-g-usd', 'ps-g-stuck', 'ps-g-check', 'ps-g-reviewer', 'ps-l-min', 'ps-l-default', 'ps-l-max', 'ps-l-ticks', 'ps-l-tick-tokens', 'ps-l-tick-steps', 'ps-l-daily', 'ps-l-usd', 'ps-l-quiet', 'ps-l-fail', 'ps-l-stuck', 'ps-l-active']) assert.match(fine, new RegExp(`id="${id}"`), `${id} is under Fine-tune`);
  // The two switches stay outside, above the cards.
  assert.ok(page.indexOf('id="ps-g-on"') < page.indexOf('id="ps-presets"') && page.indexOf('id="ps-l-on"') < page.indexOf('id="ps-presets"'));
  // One intro: the page description only (the old lead paragraph said the same again).
  assert.doesNotMatch(page, /page-lead/);
  const persist = web('persist.js');
  assert.match(persist, /import \{ presetSummary, whichPreset \} from '\.\/persist-presets\.js';/);
  assert.match(persist, /applyPreset\(v\);/);
  // The save is unchanged: every field is sent, so a preset saves exactly its numbers.
  assert.match(persist, /export async function savePersistSettings\(\) \{[\s\S]*?for \(const \[id, path\] of Object\.entries\(IDS\)\)/);
});

test('128c.4 N17: picking a preset saves its numbers through the real route; 2.60 settings load unchanged and show Custom', async (t) => {
  const s = await server(t);
  const first = await s.api('GET', '/persist');
  assert.equal(first.status, 200);
  assert.equal(first.json.preset, 'normal', 'a fresh install is Normal');
  assert.deepEqual(first.json.presets, JSON.parse(JSON.stringify(PERSIST_PRESETS)));
  for (const id of ['careful', 'long', 'normal'] as const) {
    const r = await s.api('PUT', '/persist', { preset: id });
    assert.equal(r.json.preset, id);
    assert.deepEqual(numbersOf(r.json.settings), JSON.parse(JSON.stringify(PERSIST_PRESETS[id])), id);
    // The switches, the reviewer and At night are not part of a preset.
    assert.equal(r.json.settings.goals.on, true);
    assert.equal(r.json.settings.loops.quiet, 'pause');
  }
  // Normal saves exactly what 2.60 had by default.
  assert.deepEqual(persistSettings(s.app), DEFAULT_PERSIST);
  // The page's way (every field's number) gives the same result.
  const page = await s.api('PUT', '/persist', { goals: { ...PERSIST_PRESETS.careful.goals }, loops: { ...PERSIST_PRESETS.careful.loops } });
  assert.equal(page.json.preset, 'careful');

  // Settings a 2.60 owner set by hand: loaded as they are, shown as Custom.
  const old = { goals: { on: true, rounds: 10, minutes: 120, tokens: 500_000, usd: 1, stuckAfter: 3, checkMinutes: 20, reviewer: 'quick' }, loops: { on: false, minEvery: 10, defaultFor: 8, maxFor: 72, maxTicks: 24, tick: { tokens: 20_000, steps: 5 }, dailyTokens: 1_000_000, dailyUsd: 1, quiet: 'hold', stuckAfter: 3, failAfter: 3, maxActive: 1 } };
  const s2 = await server(t, { persist: old });
  const got = await s2.api('GET', '/persist');
  assert.deepEqual(got.json.settings, old, 'nothing changed on load');
  assert.equal(got.json.preset, 'custom');
  // A 2.60 owner who never touched the page has the defaults: Normal.
  const s3 = await server(t, { persist: JSON.parse(JSON.stringify(DEFAULT_PERSIST)) });
  assert.equal((await s3.api('GET', '/persist')).json.preset, 'normal');
  // An unknown preset name changes nothing.
  const bad = await s2.api('PUT', '/persist', { preset: 'turbo' });
  assert.deepEqual(bad.json.settings, old);
});

test('128c.5 N9–N12: the Store’s first screen lists each item id once; every card has a kind icon; a real segmented control', async () => {
  const store = web('store.js');
  // shelfGroups is a pure function; run it on a list shaped like the signed store list.
  const fn = /export function shelfGroups\(items, q = ''\) \{[\s\S]*?\n\}/.exec(store)![0].replace('export ', '');
  const shelfOf = /const shelfOf = [^\n]+/.exec(store)![0];
  const shelfGroups = new Function(`${shelfOf}\n${fn}\nreturn shelfGroups;`)() as (items: Any[], q?: string) => Map<string, Any[]>;
  const items = [
    { id: 'weather-alerts', kind: 'plugin', trust: 'first-party', category: 'everyday' },
    { id: 'focus', kind: 'plugin', trust: 'first-party', category: 'everyday' },
    { id: 'comfyui', kind: 'mcp', trust: 'first-party', category: 'creative' },
    { id: 'github-digest', kind: 'plugin', trust: 'first-party', category: 'coding' },
    { id: 'playwright', kind: 'mcp', trust: 'reviewed', category: 'coding' },
    { id: 'mira', kind: 'companion', trust: 'first-party', category: 'companions' },
    { id: 'tidy', kind: 'skill', trust: 'reviewed', category: 'more' },
    { id: 'odd', kind: 'plugin', trust: 'community', category: 'everyday' },
  ];
  const ids = [...shelfGroups(items).values()].flat().map((i) => i.id);
  assert.equal(ids.length, new Set(ids).size, `each id once: ${ids.join(', ')}`);
  assert.deepEqual([...ids].sort(), items.map((i) => i.id).sort(), 'and none lost');
  assert.deepEqual(shelfGroups(items).get('popular')!.map((i) => i.id), ['weather-alerts', 'focus', 'comfyui']);
  assert.ok(!shelfGroups(items).get('everyday')?.some((i) => i.id === 'weather-alerts'), 'Popular takes it out of Everyday');
  // Each shelf shows 3 (a wrapping grid) and See all for the rest; no sideways scroller.
  assert.match(store, /\(open \? list : list\.slice\(0, 3\)\)\.map\(card\)/);
  assert.match(store, /t\('See all \{n\}', \{ n: list\.length \}\)/);
  assert.match(web('store.css'), /\.sto-row \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  // A kind icon on every card (a line icon from icons.js), whatever its own picture.
  const kinds = /export const KIND_ICON = (\{[^}]+\})/.exec(store)![1];
  const KIND_ICON = new Function(`return ${kinds}`)() as Record<string, string>;
  for (const k of ['plugin', 'skill', 'mcp', 'companion']) assert.ok(icons.ICONS[KIND_ICON[k]], `${k}: ${KIND_ICON[k]} is a line icon`);
  assert.match(store, /open\.append\(head, el\('span', 'sto-summary small', i\.summary\), kindTag\(i\.kind\),/);
  assert.doesNotMatch(store, /GLYPH\[/, 'the generic square glyphs are gone');
  // N9: Browse · My add-ons · Submit with Browse selected; My submissions inside Submit.
  assert.match(html, /<div class="sto-seg" role="tablist" aria-label="Get more">\s*<button id="sto-browse-open" type="button" role="tab" aria-selected="true"[^>]*>Browse<\/button>\s*<button id="sto-mine-open" type="button" role="tab" aria-selected="false"[^>]*>My add-ons<\/button>\s*<button id="sto-submit-open" type="button" role="tab" aria-selected="false"[^>]*>Submit<\/button>/);
  assert.doesNotMatch(html, /id="sto-subs-open"/);
  assert.match(store, /subs\.id = 'sto-subs-open';/);
  assert.match(store, /b\.setAttribute\('aria-selected', on \? 'true' : 'false'\);/);
  // N12: the key under Details; the window says what it adds.
  assert.doesNotMatch(store, /author key \{key\}/);
  assert.match(store, /el\('summary', '', t\('Details'\)\), el\('p', 'muted small stp-key', t\('Author key: \{key\}'/);
  assert.match(store, /t\('Add \{name\}', \{ name: r\.manifest\.name \}\)/);
});

/** Sara's own plugins folder (a copy) and a third-party copy of WhatsApp, like phase128a. */
function rig(t: { after: (fn: () => Promise<void> | void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date(START) });
  app.companionId = 'main';
  const builtinDir = join(dir, 'builtin');
  cpSync(join(ROOT, 'plugins', 'whatsapp'), join(builtinDir, 'whatsapp'), { recursive: true });
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => x, fence: 'node-only', saraVersion: V, builtinDir });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    app.store.close();
    cleanup();
  });
  const fake = join(dir, 'fake-whatsapp');
  cpSync(join(ROOT, 'plugins', 'whatsapp'), fake, { recursive: true });
  writeFileSync(join(fake, 'main.mjs'), `${readFileSync(join(fake, 'main.mjs'), 'utf8')}\n// changed by someone else\n`);
  return { pm, fake };
}

test('128c.6 N13: Sara’s own plugin on Windows shows one calm line; a third-party one, or one whose permissions changed, keeps the amber box', async (t) => {
  const { pm, fake } = rig(t);
  const seen: string[] = [];
  const orig = pm.checkFingerprint.bind(pm);
  pm.checkFingerprint = (files, sha) => {
    seen.push(sha);
    return orig(files, sha);
  };
  const own = pm.stageBuiltin('whatsapp') as Any;
  assert.equal(own.firstParty, true);
  assert.equal(own.os, process.platform);
  const calm = notice.reviewNotices(own, { windows: true });
  assert.equal(calm.calm, 'Runs with Node’s permission limits; no sandbox on Windows. Made and checked by the Sara team.');
  assert.deepEqual(calm.warn, [], 'no amber box for Sara’s own plugin');
  assert.equal(calm.amberChip, false);
  // Honest on other systems too: it still says there is no sandbox.
  assert.match(notice.reviewNotices(own, { windows: false }).calm, /no sandbox on this computer/);
  // The fingerprint check is unchanged: it runs at approve, calm wording or not.
  await pm.approve(own.id, { consent: true });
  assert.deepEqual(seen, [own.sha]);
  await pm.remove('whatsapp');

  // A third-party copy (a folder, a zip, git): every amber line stays.
  const third = pm.stage(fromFolder(fake, PLUGIN_LIMITS), { kind: 'folder', where: fake }) as Any;
  assert.equal(third.firstParty, undefined);
  const loud = notice.reviewNotices(third, { windows: true });
  assert.equal(loud.calm, null);
  assert.ok(loud.warn.includes("This computer can't fence the plugin in. Only add plugins you trust."));
  assert.equal(loud.amberChip, true);
  // Sara's own, but an update that asks for more: amber again.
  const more = notice.reviewNotices({ ...own, kind: 'update', added: ['network:evil.example.com'] }, { windows: true });
  assert.equal(more.calm, null);
  assert.ok(more.warn.length >= 1 && more.amberChip);
  // Sara's own with a scan finding the manifest doesn't declare: amber, with the finding.
  const odd = notice.reviewNotices({ ...own, findings: [{ kind: 'egress', file: 'main.mjs', host: 'tracker.example.com' }] }, { windows: true });
  assert.equal(odd.calm, null);
  assert.ok(odd.warn.some((w: string) => w.includes('tracker.example.com')));
  // A declared host is already in What it can do: it folds away for Sara's own plugin only.
  const host = (own.manifest.permissions?.network ?? [])[0];
  if (host) {
    assert.equal(notice.reviewNotices({ ...own, findings: [{ kind: 'egress', file: 'main.mjs', host }] }, { windows: true }).warn.length, 0);
    assert.ok(notice.reviewNotices({ ...third, findings: [{ kind: 'egress', file: 'main.mjs', host }] }, { windows: true }).warn.some((w: string) => w.includes(host)));
  }
  // The card uses it; the store's reviewed-but-third-party items are not "first-party".
  const plugins = web('plugins.js');
  assert.match(plugins, /const notes = reviewNotices\(r\);/);
  assert.match(plugins, /if \(notes\.calm\) body\.push\(el\('p', 'muted small plg-calm', notes\.calm\)\);/);
  assert.equal(notice.calmReview({ ...third, store: { trust: 'reviewed', item: 'whatsapp' } }), false);
});

test('128c.7 N14: the Plugins page opens without the amber box; Comes with Sara chat apps link to their own page', () => {
  const plugins = web('plugins.js');
  assert.match(plugins, /\$\('#plg-fence-note'\)\.hidden = state\.fence !== 'node-only' \|\| !\(state\.plugins \?\? \[\]\)\.some\(\(p\) => p\.origin && p\.origin !== 'builtin' && p\.origin !== 'store'\);/);
  assert.match(plugins, /const CHAT_APP_PAGE = \{ email: 'co-email', signal: 'co-signal', whatsapp: 'co-whatsapp', matrix: 'co-matrix', imessage: 'co-imessage' \};/);
  for (const id of ['co-email', 'co-signal', 'co-whatsapp', 'co-matrix', 'co-imessage']) assert.match(html, new RegExp(`data-page="${id}"`));
  assert.match(plugins, /t\('Set up in Chat apps → \{name\}', \{ name: b\.name \}\)/);
});

test('128c.8 N15: Share her ticks dials by default; routine chips write the pack format’s ids; Save the file says why it waits', async () => {
  const packs: Any = await import(pathToFileURL(join(ROOT, 'web', 'packs.js')).href);
  assert.deepEqual(packs.routinePicks(new Set(['bedtime', 'weekly-review'])), [{ id: 'bedtime' }, { id: 'weekly-review' }]);
  assert.equal(packs.routinePicks(['a', 'b', 'c', 'd', 'e', 'f']).length, 5, 'at most 5 (docs/PACKS.md)');
  assert.deepEqual(packs.routinePicks(['Bad Id', '../x', 'ok-1']), [{ id: 'ok-1' }]);
  // Exactly what the pack format reads: a manifest with these routines parses (docs/PACKS.md).
  const catalog = readFileSync(join(ROOT, 'templates', 'routines', 'bedtime.json'), 'utf8');
  assert.match(catalog, /"id": "bedtime"/);
  const manifest = { format: 'sara-companion', v: 1, id: 'mira', version: '1.0.0', sara: '>=2.60.0', name: 'Mira', summary: 'A warm companion who likes long walks.', author: { name: 'Alex' }, license: 'CC-BY-4.0', remix: 'yes', rating: 'general', romance: false, language: 'en', tags: [], includes: { persona: true, dials: false, look: 'none', closet: 0, reference: 0, voice: false, greeting: false }, routines: packs.routinePicks(['bedtime', 'weekly-review']) };
  assert.deepEqual(parsePackManifest(manifest, { personaName: 'Mira' }).routines, [{ id: 'bedtime' }, { id: 'weekly-review' }]);
  // The old typed-in strings were not entries at all.
  assert.throws(() => parsePackManifest({ ...manifest, routines: ['bedtime'] }, { personaName: 'Mira' }), /routines/);
  const src = web('packs.js');
  assert.match(src, /add\('dials', [^\n]+, true\);/, 'dials ticked, never switched off');
  assert.match(src, /t\('Her personality dials \(she uses the defaults\)'\)/);
  assert.match(src, /routines: routinePicks\(picked\),/);
  assert.doesNotMatch(src, /placeholder = 'bedtime, weekly-review'/, 'no ids typed by hand');
  assert.match(src, /saveB\.textContent = ready \? t\('Save the file'\) : t\('Save the file: check it first'\);/);
  assert.match(src, /waitCheck\(false\);\n  const checkB/);
});

test('128c.9 N18, N21–N24, N31, N33: wording, the Planner how-tos, the Repeats empty state, Set up first, line icons, one heading', async () => {
  // N18: no developer leftovers; "Wait up to 20 s".
  assert.doesNotMatch(html, /Language servers \(typescript-language-server/);
  assert.match(web('refs.js'), /key === 'waitS' \? t\('Wait up to \{n\} s', \{ n \}\)/);
  // N24: words first, the numbers under the ?.
  const lean = web('lean.js');
  assert.match(lean, /t\('She gets the tools that fit each step \(saves about \{pct\}%\)\.'/);
  assert.match(lean, /q\.dataset\.tip = t\('Right now: \{n\} tools/);
  assert.match(html, /<option value="auto">Automatic \(fits each step\)<\/option>/);
  // N21: a How do I…? per Planner tab, and the one empty state on Repeats.
  const howto = JSON.parse(web('howto.json'));
  const { VIEW_HOWTO } = await import(pathToFileURL(join(ROOT, 'web', 'howto.js')).href);
  for (const tab of ['reminders', 'repeats', 'routines']) {
    assert.ok(howto[`planner-${tab}`]?.length >= 2, `planner-${tab} questions`);
    assert.equal(VIEW_HOWTO[`planner-${tab}`], `#planner .tab-panel[data-panel="${tab}"]`);
    assert.match(html, new RegExp(`<div class="tab-panel" data-panel="${tab}"`));
  }
  const persist = web('persist.js');
  assert.match(persist, /emptyState\(\{ icon: 'update', text: t\('No repeats yet\.'\), why: [^\n]+action: \{ label: t\('Repeat something in a chat'\)/);
  assert.ok(icons.ICONS.update);
  // N22: When it comes up in its own card, full-width field, a words / person switch, a short placeholder.
  assert.match(html, /<section id="wm-section" class="when-section kit-card" hidden>/);
  assert.match(html, /<input id="wm-text" class="wm-full" placeholder="Remind me…"/);
  assert.match(html, /<div class="seg wm-by" role="radiogroup" aria-label="Listen for">/);
  assert.match(html, /placeholder="Words to listen for"/);
  // N23: Set up first, enabled, opens the first missing need.
  const routines = web('routines.js');
  assert.match(routines, /btn\(t\('Set up first'\), 'rt-setup-first', \(\) => ctx\.openSettings\(first\.open\.replace\('settings:', ''\)\)\)/);
  assert.doesNotMatch(routines, /go\.disabled = blocked/);
  // N31: line icons for every routine in the gallery (emoji stay in her messages).
  const ROUTINE_ICON = new Function(`return ${/export const ROUTINE_ICON = (\{[^}]+\})/.exec(routines)![1]}`)() as Record<string, string>;
  for (const f of ['backup-check', 'bedtime', 'ci-watch', 'inbox-triage', 'leave-on-time', 'morning-brief', 'new-issues', 'price-watch', 'stretch', 'weekly-review']) {
    assert.ok(JSON.parse(readFileSync(join(ROOT, 'templates', 'routines', `${f}.json`), 'utf8')).id === f);
    assert.ok(icons.ICONS[ROUTINE_ICON[f]], `${f}: ${ROUTINE_ICON[f]}`);
  }
  assert.doesNotMatch(routines, /r\.icon \|\|/, 'no emoji on the cards or Today’s Add a routine');
  // N33: Today reads each section name once.
  assert.match(html, /<h3 id="td-calendar-h" aria-hidden="true">Your day<\/h3>/);
  assert.match(html, /<h3 id="td-needs-h" aria-hidden="true">Needs you<\/h3>/);
});

test('128c.10 no inline styles, one ✕ per panel, the service worker moved on', () => {
  for (const f of ['persist.js', 'persist-presets.js', 'plugin-notice.js', 'store.js', 'packs.js', 'routines.js', 'recall-when.js', 'lean.js']) {
    const src = web(f);
    assert.doesNotMatch(src, /style=|\.style\./, `${f}: no inline styles`);
  }
  assert.doesNotMatch(/<section class="settings-page" data-page="ab-persist"[\s\S]*?<\/section>/.exec(html)![0], /style="/);
  // The Store's panel keeps one ✕ and ← Back.
  assert.equal((/<dialog id="store-panel"[\s\S]*?<\/dialog>/.exec(html)![0].match(/✕/g) ?? []).length, 1);
  const sw = web('sw.js');
  assert.match(sw, /event\.waitUntil\(caches\.open\('sara-shell-v(7[1-9]|[89]\d)'\)/); // v71 or later (PL2d is v72)
  assert.match(sw, /v71 \(PL2c, 2\.61\.2\)/);
  assert.match(sw, /sara-shell-v70 from 2\.61\.1/);
});
