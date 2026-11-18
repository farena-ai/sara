// U5.32 (docs/WHATS_NEW.md): the plain-words "What's new in 3.x" page after each update: built from
// the CHANGELOG at build time into web/whats-new.json (fresh, translated in 5 languages, every link
// a real place), shown once per person after an update with the releases since the last version they
// saw, members get the members' subset, kid mode never sees it, and Help → What's new shows it again.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { CHECKS } from '../src/owner-checks.ts';
import { createSaraServer } from '../src/server.ts';
import { buildWhatsNew, firstSentence, parseChangelog, WhatsNewSeen, whatsNewStrings, whatsNewView, type WhatsNewData } from '../src/whats-new.ts';
import { allKeys, LANGS, loadLang } from '../scripts/i18n-extract.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const html = read('web/index.html');
const appJs = read('web/app.js');

const MD = `# Changelog

## Unreleased

- New: something not released yet.

## 3.2.0 (2026-11-20): pictures and fixes

- New: **Pictures** you can edit (U4.28, docs/PICTURES.md). Paint over a part and change it.
- Fixed (iPhone): the Money page no longer
  scrolls sideways on a phone. It fits now.
- Developers: tests wait less.
- Added: a Business place for clients. Owner only.

## 3.1.0 (2026-11-10): first

- New: Team recipes. After a team run finishes, "Save as a team recipe" keeps its plan (helpers, models, tools, budgets, parts and checks, never its results) under a name.
`;

test('U5.32.1 CHANGELOG sections become plain highlights: released only, New/Added/Fixed, first sentence, no doc references', () => {
  const r = parseChangelog(MD);
  assert.deepEqual(r.map((x) => x.version), ['3.2.0', '3.1.0'], 'Unreleased is never shown');
  assert.equal(r[0].title, 'pictures and fixes');
  assert.deepEqual(r[0].lines.map((l) => l.kind), ['new', 'fixed', 'new'], 'Developers: lines are left out');
  assert.equal(firstSentence(r[0].lines[0].body), 'Pictures you can edit. Paint over a part and change it.', 'short first sentences take the next one; no markdown or (U4.28, docs/…)');
  assert.equal(firstSentence(r[0].lines[1].body), 'The Money page no longer scrolls sideways on a phone.');
  const team = firstSentence(r[1].lines[0].body);
  assert.ok(team.length <= 170 && !/\([^)]*$/.test(team) && (team.match(/"/g) ?? []).length % 2 === 0, `cut cleanly: ${team}`);
  const d = buildWhatsNew(MD, { checks: [] });
  const items = d.releases[0].items;
  assert.equal(items.find((i) => i.text.startsWith('The Money'))?.link, '#view=money');
  assert.equal(items.find((i) => i.text.startsWith('A Business'))?.owner, true, 'owner-only items are marked');
  assert.equal(new Set(d.releases.flatMap((x) => x.items.map((i) => i.id))).size, d.releases.flatMap((x) => x.items).length, 'unique ids');
});

test('U5.32.2 the shipped web/whats-new.json is fresh, every link is a real place, Try it ids exist, and every line is translated', () => {
  const shipped = JSON.parse(read('web/whats-new.json')) as WhatsNewData;
  assert.deepEqual(shipped, buildWhatsNew(read('CHANGELOG.md')), 'stale: run node scripts/whats-new.ts');
  assert.ok(shipped.releases.length >= 5, 'several releases kept');
  const views = /const VIEWS = \{([^\n]+)\};/.exec(appJs)?.[1] ?? '';
  const checkIds = new Set(CHECKS.map((c) => c.id));
  for (const r of shipped.releases) {
    assert.ok(r.items.length >= 1 && r.items.length <= 6, r.version);
    for (const i of r.items) {
      assert.ok(i.text.length >= 10 && i.text.length <= 200 && !/docs\/|\*\*|`/.test(i.text), `${i.id}: ${i.text}`);
      if (i.link) {
        const m = /^#view=(?:settings:([\w-]+)|([\w-]+))$/.exec(i.link);
        assert.ok(m, `${i.id}: ${i.link}`);
        if (m[1]) assert.ok(html.includes(`data-page="${m[1]}"`), `${i.id}: no Settings page ${m[1]}`);
        else assert.match(views, new RegExp(`\\b${m[2]}: `), `${i.id}: no view ${m[2]}`);
      }
      for (const id of i.try ?? []) assert.ok(checkIds.has(id), `${i.id}: no Try these item ${id}`);
    }
  }
  assert.ok(shipped.releases.some((r) => r.items.some((i) => i.try?.length)), 'some highlights have Try it');
  const keys = allKeys();
  for (const s of whatsNewStrings(shipped)) {
    assert.ok(keys.has(s), `i18n-extract does not find: ${s}`);
    for (const lang of LANGS) {
      const tr = loadLang(lang)[s];
      assert.ok(tr && tr.trim(), `${lang}: no translation for "${s}"`);
    }
    assert.notEqual(loadLang('pt-BR')[s], s, `pt-BR must differ: ${s}`);
  }
});

test('U5.32.3 who sees what: once after an update, the releases since the last seen version, members without owner-only items, never kids', () => {
  const d = buildWhatsNew(MD, { checks: [{ id: 'x', release: '3.2.0', title: 'Edit pictures', steps: ['a'], view: '#view=library', expect: 'Paint over a part and change it' }] });
  const fresh = whatsNewView(d, { version: '3.2.0', state: { seen: null, auto: true } });
  assert.equal(fresh.show, false, 'a new install shows nothing by itself');
  const after = whatsNewView(d, { version: '3.2.0', state: { seen: '3.1.0', auto: true } });
  assert.equal(after.show, true);
  assert.deepEqual(after.releases.map((r) => r.version), ['3.2.0'], 'only what is new since 3.1.0');
  assert.equal(whatsNewView(d, { version: '3.2.0', state: { seen: '3.2.0', auto: true } }).show, false, 'once');
  assert.equal(whatsNewView(d, { version: '3.2.0', state: { seen: '3.1.0', auto: false } }).show, false, 'Show after updates off');
  assert.deepEqual(whatsNewView(d, { version: '3.2.0', state: { seen: '3.2.0', auto: true }, all: true }).releases.map((r) => r.version), ['3.2.0', '3.1.0'], 'Help shows every kept release');
  assert.deepEqual(whatsNewView(d, { version: '3.1.0', state: { seen: null, auto: true }, all: true }).releases.map((r) => r.version), ['3.1.0'], 'never a release newer than this server');
  const member = whatsNewView(d, { version: '3.2.0', state: { seen: '3.1.0', auto: true }, member: true });
  const mItems = member.releases.flatMap((r) => r.items);
  assert.ok(mItems.length && mItems.every((i) => !i.owner && !i.try?.length), 'members: no owner-only items, no Try these');
  const kid = whatsNewView(d, { version: '3.2.0', state: { seen: '3.1.0', auto: true }, kid: true, all: true });
  assert.equal(kid.show, false);
  assert.deepEqual(kid.releases, []);
});

test('U5.32.4 per person: the seen version and the auto switch survive a restart', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new WhatsNewSeen(dir);
  assert.deepEqual(s.get(), { seen: null, auto: true });
  s.set({ seen: '3.22.1' });
  s.set({ auto: false });
  assert.deepEqual(new WhatsNewSeen(dir).get(), { seen: '3.22.1', auto: false });
  s.set({ seen: 'nonsense' });
  assert.equal(new WhatsNewSeen(dir).get().seen, null, 'a bad version reads as none');
});

async function serve(t: TestContext, o: { member?: boolean; kid?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-18T12:00:00Z') });
  if (o.kid) (app as unknown as { member: unknown }).member = { child: () => ({ birthYear: 2016 }), id: 'k1' };
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const record = () => ({ id: 'm1', name: 'Kim', status: 'active', limits: { voice: false, pictures: false } });
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(o.member || o.kid ? { member: { record } } : {}) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { app, call, dir };
}

test('U5.32.5 routes: the first look only remembers the version; after an update it shows once; Got it and the switch are saved', async (t) => {
  const { call, dir } = await serve(t);
  const first = await call('GET', '/whats-new');
  assert.equal(first.status, 200);
  assert.equal(first.json.show, false, 'nothing by itself on a new install');
  assert.match(first.json.version, /^\d+\.\d+\.\d+$/);
  assert.equal(new WhatsNewSeen(dir).get().seen, first.json.version, 'the current version is remembered');
  new WhatsNewSeen(dir).set({ seen: '3.17.0' });
  const after = await call('GET', '/whats-new');
  assert.equal(after.json.show, true, 'an update since 3.17.0');
  assert.ok(after.json.releases.length >= 1 && after.json.releases.every((r: { version: string }) => r.version !== '3.17.0'));
  assert.equal((await call('POST', '/whats-new/seen', {})).json.show, false, 'Got it');
  assert.equal(new WhatsNewSeen(dir).get().seen, first.json.version);
  const all = await call('GET', '/whats-new?all=1');
  assert.ok(all.json.releases.length >= 5, 'Help → What\'s new shows the kept releases');
  assert.equal((await call('PUT', '/whats-new', { auto: false })).json.auto, false);
  assert.equal((await call('PUT', '/whats-new', { auto: 'yes' })).status, 400);
});

test('U5.32.6 members get the members\' subset; kid mode gets nothing', async (t) => {
  const m = await serve(t, { member: true });
  const v = await m.call('GET', '/whats-new?all=1');
  assert.equal(v.status, 200, 'members may read it');
  const items = v.json.releases.flatMap((r: { items: { owner?: boolean; try?: string[] }[] }) => r.items);
  assert.ok(items.length > 0 && items.every((i: { owner?: boolean; try?: string[] }) => !i.owner && !i.try), 'no owner-only items or Try these');
  const k = await serve(t, { kid: true });
  const kv = await k.call('GET', '/whats-new?all=1');
  assert.equal(kv.json.kid, true);
  assert.deepEqual(kv.json.releases, []);
  assert.equal(kv.json.show, false);
});

test('U5.32.7 the page wiring: the card, Help → What\'s new, #view=whats-new, the first-run queue, i18n-extract reads the file', () => {
  assert.match(html, /<dialog id="whats-new"[^>]*>/);
  assert.match(html, /id="help-whatsnew"/);
  assert.ok(!/id="help-whatsnew"[^>]*data-owner-only/.test(html), 'members get the Help entry too');
  assert.match(appJs, /'whats-new': /, '#view=whats-new');
  assert.match(appJs, /initWhatsNew\(/);
  const js = read('web/whats-new.js');
  assert.match(js, /queue\??\.add\('whats-new'/, 'waits for the first-run queue (no window over another)');
  assert.match(js, /\/whats-new\/seen/);
  assert.match(js, /openTryThese|ctx\.tryIt/);
  assert.match(read('scripts/i18n-extract.ts'), /whats-new\.json/);
  assert.match(read('docs/WHATS_NEW.md'), /U5\.32/);
});

test('V0.3 every shipped release has a Try it for the owner, and each Try these release is in What\'s new or older', () => {
  const shipped = JSON.parse(read('web/whats-new.json')) as WhatsNewData;
  const fromChecks = new Set(CHECKS.map((c) => c.release));
  for (const r of shipped.releases) {
    if (!fromChecks.has(r.version)) continue;
    assert.ok(r.items.some((i) => i.try?.length), `${r.version}: no highlight has a Try it`);
  }
  for (const v of ['3.19.0', '3.20.0', '3.21.0', '3.22.0', '3.22.1', '3.23.0', '3.24.0']) assert.ok(fromChecks.has(v), `Try these has nothing from ${v}`);
  // The test restore and What's new lines now have a place to open.
  const r324 = shipped.releases.find((r) => r.version === '3.24.0');
  if (r324) {
    assert.equal(r324.items.find((i) => /test restore/i.test(i.text))?.link, '#view=settings:dh-backups');
    assert.deepEqual(r324.items.find((i) => /What's new/.test(i.text))?.try, ['whats-new-help']);
  }
});
