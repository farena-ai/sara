import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromFolder, hashFiles, type PackageFile } from '../src/packages.ts';
import { PluginManager, PLUGIN_LIMITS, type Origin } from '../src/plugins/manager.ts';
import { pluginToolName } from '../src/plugins/manifest.ts';
import { PluginProcess } from '../src/plugins/runtime.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const MAIN = `import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({v:1,...m})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.type==='init') send({type:'ready',tools:[{name:'probe',description:'Synthetic probe',parameters:{type:'object',properties:{}}}]});
  if(m.type==='tool') send({type:'result',id:m.id,content:'synthetic result',card:{title:'Synthetic result',lines:['Supplied fixture only.']}});
});`;
function files(version = '1.0.0', id = 'candidate-fixture'): PackageFile[] {
  const manifest = { manifest: 1, id, name: 'Synthetic fixture', version, description: 'Synthetic fixture only.', main: 'main.mjs', permissions: { tools: ['probe'], cards: true, settings: true }, settings: [{ key: 'label', type: 'text', label: 'Label', tip: 'A synthetic label for this test only.' }] };
  return [{ path: 'sara-plugin.json', data: Buffer.from(JSON.stringify(manifest)) }, { path: 'main.mjs', data: Buffer.from(MAIN) }];
}
async function rig(t: TestContext, o: Partial<ConstructorParameters<typeof PluginManager>[0]> = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-05T12:00:00Z') }); app.companionId = 'main';
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, scrub: s => s, fence: 'node-only', now: app.now, ...o });
  app.pluginManager = pm; pm.attach('main', app);
  t.after(async () => { await pm.stopAll(); app.store.close(); cleanup(); });
  return { pm, app, dir };
}
const stage = (pm: PluginManager, version = '1.0.0', id = 'candidate-fixture', origin: Origin = { kind: 'zip', where: 'synthetic.zip' }) => pm.stage(files(version, id), origin);
async function install(pm: PluginManager, version = '1.0.0', id = 'candidate-fixture') { return pm.approve(stage(pm, version, id).id, { trust: true }); }

function processes(t: TestContext) {
  const original = PluginProcess.prototype.start;
  const captured: PluginProcess[] = [];
  const ready: Promise<void>[] = [];
  t.mock.method(PluginProcess.prototype, 'start', function(this: PluginProcess, init: Record<string, unknown>) {
    captured.push(this); const signal = deferred(); ready.push(signal.promise);
    const old = this.events.onReady;
    this.events.onReady = msg => { old(msg); signal.resolve(); };
    return original.call(this, init);
  });
  return { captured, ready };
}
function holdStop(t: TestContext) {
  const entered = deferred<PluginProcess>(); const release = deferred();
  const original = PluginProcess.prototype.stop;
  t.mock.method(PluginProcess.prototype, 'stop', async function(this: PluginProcess) {
    entered.resolve(this); await original.call(this); await release.promise;
  });
  t.after(() => release.resolve()); return { entered, release };
}

test('staged baseline rejects another approval without replacing its current files', async t => {
  const { pm } = await rig(t); await install(pm);
  const v2 = stage(pm, '2.0.0'); const v3 = stage(pm, '3.0.0');
  await pm.approve(v3.id, { trust: true }); const before = pm.store.get('candidate-fixture')!;
  await assert.rejects(pm.approve(v2.id, { trust: true }), /changed|fresh review|again/i);
  assert.deepEqual(pm.store.get(before.id), before);
  assert.equal(hashFiles(fromFolder(before.dir, PLUGIN_LIMITS)), before.approved_sha);
  assert.equal(existsSync(join(pm.pluginsDir, 'candidate-fixture@2.0.0')), false);
});

test('absent baseline and identical remove/reinstall retain monotonic tombstones', async t => {
  const { pm } = await rig(t);
  const absent = stage(pm, '2.0.0'); await install(pm);
  await assert.rejects(pm.approve(absent.id, { trust: true }), /changed|fresh review|again/i);
  const before = pm.store.get('candidate-fixture')!; const stale = stage(pm, '3.0.0');
  await pm.remove(before.id); await install(pm);
  assert.deepEqual(pm.store.get(before.id), before, 'frozen clock produces identical row tuple');
  await assert.rejects(pm.approve(stale.id, { trust: true }), /changed|fresh review|again/i);
});

test('rollback ABA invalidates an old review even when approved_at and content return', async t => {
  const { pm } = await rig(t); await install(pm); const stale = stage(pm, '3.0.0');
  await pm.approve(stage(pm, '2.0.0').id, { trust: true }); await pm.rollback('candidate-fixture');
  assert.equal(pm.store.get('candidate-fixture')!.version, '1.0.0');
  await assert.rejects(pm.approve(stale.id, { trust: true }), /changed|fresh review|again/i);
});

test('relevant settings permission ABA invalidates reviews and unrelated settings do not', async t => {
  const { pm, app } = await rig(t); await install(pm);
  const fresh = stage(pm, '2.0.0'); app.settings.update({ toolPermissions: { web_search: 'never' } });
  await pm.approve(fresh.id, { trust: true }); const stale = stage(pm, '3.0.0');
  const tool = pluginToolName('candidate-fixture', 'probe');
  app.settings.update({ toolPermissions: { [tool]: 'never' } });
  app.settings.update({ toolPermissions: { [tool]: 'auto' } });
  app.settings.update({ toolPermissions: { [tool]: 'never' } });
  await assert.rejects(pm.approve(stale.id, { trust: true }), /changed|fresh review|again/i);
});

test('Off revokes immediately during awaited approval stop and prevents commit/restart', async t => {
  const p = processes(t); const { pm, app } = await rig(t); await install(pm);
  await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
  const tool = app.tools.get('candidate_fixture__probe')!; assert.ok(tool);
  const review = stage(pm, '2.0.0'); const barrier = holdStop(t);
  const approval = pm.approve(review.id, { trust: true }); const rejected = assert.rejects(approval, /changed|again|revoked/i);
  await barrier.entered.promise;
  try {
    assert.throws(() => stage(pm, '3.0.0'), /changing|busy|progress/i);
    await assert.rejects(pm.rollback('candidate-fixture'), /changing|busy|progress/i);
    await assert.rejects(pm.remove('candidate-fixture'), /changing|busy|progress/i);
    await assert.rejects(pm.approve(review.id, { trust: true }), /changing|busy|progress/i);
    await assert.rejects(pm.setEnabled('candidate-fixture', 'main', true), /changing|busy|progress/i);
    await assert.rejects(pm.putSettings('candidate-fixture', 'main', { label: 'later' }), /changing|busy|progress/i);
    await install(pm, '1.0.0', 'independent-fixture');
    const off = pm.setEnabled('candidate-fixture', 'main', false);
    assert.equal(pm.enabledFor('candidate-fixture', 'main'), false);
    assert.equal(app.tools.get(tool.spec.name), undefined); assert.equal(tool.isAvailable?.(), false);
    barrier.release.resolve(); await off;
  } finally { barrier.release.resolve(); await rejected; }
  assert.equal(pm.store.get('candidate-fixture')!.version, '1.0.0');
  assert.equal(existsSync(join(pm.pluginsDir, 'candidate-fixture@2.0.0')), false);
  assert.equal(p.captured.length, 1);
});

test('Store block preempts awaited settings restart and old callbacks cannot mutate replacement', async t => {
  const p = processes(t); const { pm, app } = await rig(t); await install(pm);
  await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
  const old = p.captured[0]; const barrier = holdStop(t);
  const saving = pm.putSettings('candidate-fixture', 'main', { label: 'saved' });
  await barrier.entered.promise; const blocking = pm.storeBlock('candidate-fixture', 'Synthetic signed block');
  assert.equal(pm.store.get('candidate-fixture')!.status, 'disabled');
  barrier.release.resolve(); await saving; await blocking;
  assert.equal(p.captured.length, 1, 'settings must not restart after block');
  await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[1];
  const before = pm.store.get('candidate-fixture'); const tools = app.tools.list().map(x => x.spec.name);
  old.events.onReady({ type: 'ready', tools: [{ name: 'probe' }] });
  old.events.onGaveUp('stale callback'); old.events.onOneWay?.({ type: 'bridge.status', state: 'connected' });
  await assert.rejects(old.events.onCall('kv.set', { type: 'call', key: 'stale', value: 1 }), /stopped|current|available/i);
  assert.deepEqual(pm.store.get('candidate-fixture'), before);
  assert.deepEqual(app.tools.list().map(x => x.spec.name), tools);
  assert.equal(pm.enabledFor('candidate-fixture', 'main'), true);
  assert.equal(pm.store.kvGet('candidate-fixture', 'main', 'stale'), undefined);
});

test('postapproval association callback is atomic and throws without leaving an installed row', async t => {
  const { pm } = await rig(t); const review = stage(pm);
  pm.opts.db.exec('CREATE TABLE synthetic_association (id TEXT)');
  await assert.rejects(pm.approve(review.id, { trust: true, onCommitted: row => {
    pm.opts.db.prepare('INSERT INTO synthetic_association VALUES (?)').run(row.id);
    throw new Error('synthetic ledger failure');
  } }), /synthetic ledger failure/);
  assert.equal(pm.store.get('candidate-fixture'), undefined);
  assert.deepEqual(pm.opts.db.prepare('SELECT * FROM synthetic_association').all(), []);
  assert.equal(existsSync(join(pm.pluginsDir, 'candidate-fixture@1.0.0')), false);
});

test('candidate source is untrusted even with genuine exact signed association', async t => {
  const { pm, app } = await rig(t);
  assert.equal(typeof pm.stageCandidate, 'function');
  const source = fromFolder(join(ROOT, 'store', 'plugins', 'daily-briefing'), PLUGIN_LIMITS); const sha = hashFiles(source);
  pm.storeMatch = h => h === sha ? { item: 'daily-briefing', version: '1.0.0', name: 'Daily briefing', trust: 'first-party' } : undefined;
  const review = pm.stageCandidate('daily-briefing');
  assert.deepEqual(review.origin, { kind: 'candidate', where: 'daily-briefing' });
  assert.equal(review.firstParty, undefined); assert.equal(review.builtin, undefined); assert.equal(review.store?.item, 'daily-briefing');
  await assert.rejects(pm.approve(review.id, { consent: true }), /I trust/);
  await pm.approve(review.id, { trust: true }); assert.equal(pm.isCandidate('daily-briefing'), true);
  assert.throws(() => pm.assertStoreAuthority('daily-briefing'), /candidate|source/i);
  assert.equal(pm.enabledFor('daily-briefing', 'main'), false); assert.deepEqual(app.tools.list().filter(x => x.source?.startsWith('Plugin:')), []);
});

test('Store authority allows an unassociated fresh install but rejects stale associated absence', async t => {
  const { pm } = await rig(t);
  assert.doesNotThrow(() => pm.assertStoreAuthority('candidate-fixture'));
  assert.throws(() => pm.assertStoreAuthority('candidate-fixture', 'a'.repeat(64)), /source|installation/i);
  const row = await install(pm);
  assert.doesNotThrow(() => pm.assertStoreAuthority(row.id, row.approved_sha));
  assert.throws(() => pm.assertStoreAuthority(row.id, 'b'.repeat(64)), /source|installation/i);
});

test('cancel during an awaited approval stop prevents any package replacement', async t => {
  const p = processes(t); const { pm } = await rig(t); await install(pm);
  await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
  const review = stage(pm, '2.0.0'); const barrier = holdStop(t);
  const approval = pm.approve(review.id, { trust: true }); const rejected = assert.rejects(approval, /expired|cancel|again/i);
  await barrier.entered.promise; pm.cancel(review.id); barrier.release.resolve(); await rejected;
  assert.equal(pm.store.get('candidate-fixture')!.version, '1.0.0');
  assert.equal(existsSync(join(pm.pluginsDir, 'candidate-fixture@2.0.0')), false);
});

test('Promise-returning commit hook is refused and both SQLite writes roll back', async t => {
  const { pm } = await rig(t); const review = stage(pm);
  pm.opts.db.exec('CREATE TABLE synthetic_association (id TEXT)');
  await assert.rejects(pm.approve(review.id, { trust: true, onCommitted: row => {
    pm.opts.db.prepare('INSERT INTO synthetic_association VALUES (?)').run(row.id);
    return Promise.resolve();
  } }), /synchronous/i);
  assert.equal(pm.store.get('candidate-fixture'), undefined);
  assert.deepEqual(pm.opts.db.prepare('SELECT * FROM synthetic_association').all(), []);
});

test('settings observer preserves prior callbacks, shared attachments, detach order and replacement', async t => {
  const { pm, app, dir } = await rig(t); await pm.detach('main');
  let calls = 0; const prior = () => { calls++; }; app.settings.onUpdated = prior;
  pm.attach('main', app); const wrapped = app.settings.onUpdated; assert.notEqual(wrapped, prior);
  mkdirSync(join(dir, 'other-app')); const other = makeApp(join(dir, 'other-app'), { now: app.now() }); other.settings = app.settings; other.companionId = 'other';
  t.after(() => other.store.close()); pm.attach('other', other); assert.equal(app.settings.onUpdated, wrapped);
  await install(pm); const review = stage(pm, '2.0.0');
  await pm.detach('main'); assert.equal(app.settings.onUpdated, wrapped);
  app.settings.update({ toolPermissions: { candidate_fixture__probe: 'never' } });
  assert.equal(calls, 1); await assert.rejects(pm.approve(review.id, { trust: true }), /changed|again/i);
  await pm.detach('other'); assert.equal(app.settings.onUpdated, prior);
  pm.attach('main', app); const replacement = () => { calls += 10; }; app.settings.onUpdated = replacement;
  await pm.detach('main'); assert.equal(app.settings.onUpdated, replacement);
  pm.attach('main', app); await pm.stopAll(); assert.equal(app.settings.onUpdated, replacement);
});

test('failed settings persistence neither notifies the observer nor invalidates the review', async t => {
  const { pm, app, dir } = await rig(t); await install(pm); const review = stage(pm, '2.0.0');
  const file = join(dir, 'settings.json');
  // A directory in place of the destination deterministically refuses atomic replacement on both OSes.
  if (existsSync(file)) rmSync(file); mkdirSync(file);
  assert.throws(() => app.settings.update({ toolPermissions: { candidate_fixture__probe: 'never' } }));
  rmSync(file, { recursive: true });
  assert.equal(app.settings.get().toolPermissions, undefined);
  await pm.approve(review.id, { trust: true }); assert.equal(pm.store.get('candidate-fixture')!.version, '2.0.0');
});

test('candidate source rejects unsafe identities and missing/changed/mismatched/oversized packages safely', async t => {
  const { dir, cleanup } = tempDir(); t.after(cleanup); const root = join(dir, 'candidates'); mkdirSync(root);
  const { pm, app } = await rig(t, { candidateDir: root });
  for (const id of [null, 4, {}, '', '../daily-briefing', '/daily-briefing', 'F:\\daily-briefing', 'unknown']) assert.throws(() => pm.stageCandidate(id), /Unknown local/);
  const source = join(ROOT, 'store/plugins/daily-briefing'); const dest = join(root, 'daily-briefing');
  const fail = () => {
    assert.throws(() => pm.stageCandidate('daily-briefing'), err => {
      assert.ok(err instanceof Error); assert.match(err.message, /missing|changed/i); assert.ok(!err.message.includes(dir)); return true;
    });
    assert.deepEqual(pm.store.all(), []); assert.equal(pm.processOf('daily-briefing', 'main'), undefined); assert.equal(app.providerCalls, 0);
  };
  fail(); cpSync(source, dest, { recursive: true }); assert.equal(pm.stageCandidate('daily-briefing').manifest.id, 'daily-briefing');
  const original = readFileSync(join(dest, 'sara-plugin.json'), 'utf8');
  for (const change of [{ id: 'wrong-id' }, { version: '9.0.0' }]) {
    writeFileSync(join(dest, 'sara-plugin.json'), JSON.stringify({ ...JSON.parse(original), ...change })); fail();
  }
  writeFileSync(join(dest, 'sara-plugin.json'), '{malformed'); fail();
  writeFileSync(join(dest, 'sara-plugin.json'), original);
  writeFileSync(join(dest, 'extra.txt'), 'unexpected'); fail(); rmSync(join(dest, 'extra.txt'));
  writeFileSync(join(dest, 'oversize.txt'), Buffer.alloc(PLUGIN_LIMITS.maxFileBytes + 1)); fail(); rmSync(join(dest, 'oversize.txt'));
  const list = pm.candidateList(); assert.equal(list.length, 36); assert.equal(list.filter(x => x.availability === 'local-candidate').length, 1);
  assert.equal(list.find(x => x.id === 'daily-briefing')!.updateAvailable, false);
});

test('candidate source refuses package, ancestor and descendant directory junctions/links', async t => {
  const { dir, cleanup } = tempDir(); t.after(cleanup);
  const actual = join(dir, 'actual'); mkdirSync(actual); cpSync(join(ROOT, 'store/plugins/daily-briefing'), join(actual, 'daily-briefing'), { recursive: true });
  const kind = process.platform === 'win32' ? 'junction' : 'dir'; const link = join(dir, 'linked'); symlinkSync(actual, link, kind);
  const { pm } = await rig(t, { candidateDir: link }); assert.throws(() => pm.stageCandidate('daily-briefing'), /missing|changed/i);
  const packages = join(dir, 'packages'); mkdirSync(packages); symlinkSync(join(actual, 'daily-briefing'), join(packages, 'daily-briefing'), kind);
  const r2 = await rig(t, { candidateDir: packages }); assert.throws(() => r2.pm.stageCandidate('daily-briefing'), /missing|changed/i);
  symlinkSync(packages, join(actual, 'daily-briefing', 'linked-subfolder'), kind);
  const r3 = await rig(t, { candidateDir: actual }); assert.throws(() => r3.pm.stageCandidate('daily-briefing'), /missing|changed/i);
});

test('candidate source migration is forbidden for all selectors in both stage and stale approval', async t => {
  const { pm } = await rig(t); const candidate = pm.stageCandidate('daily-briefing');
  await pm.approve(candidate.id, { trust: true }); const row = pm.store.get('daily-briefing')!;
  const changed = fromFolder(row.dir, PLUGIN_LIMITS).map(f => f.path === 'sara-plugin.json' ? { ...f, data: Buffer.from(JSON.stringify({ ...JSON.parse(f.data.toString()), version: '2.0.0' })) } : f);
  for (const kind of ['zip', 'git', 'folder', 'builtin', 'store'] as const) assert.throws(() => pm.stage(changed, { kind, where: 'synthetic-source' }), /candidate|source/i);
  await pm.remove(row.id);
  const laterCandidate = pm.stageCandidate(row.id); const ordinary = pm.stage(changed, { kind: 'zip', where: 'synthetic.zip' });
  await pm.approve(ordinary.id, { trust: true });
  assert.throws(() => pm.stageCandidate(row.id), /candidate|source/i);
  await assert.rejects(pm.approve(laterCandidate.id, { trust: true }), /changed|candidate|source/i);
  assert.equal(pm.isCandidate(row.id), false); assert.equal(pm.store.get(row.id)!.version, '2.0.0');
});

test('association failure after rollback preserves the already approved re-upgrade destination', async t => {
  const { pm } = await rig(t); await install(pm); await install(pm, '2.0.0'); await pm.rollback('candidate-fixture');
  const before = pm.store.get('candidate-fixture')!; const kept = JSON.parse(before.prev_version!) as { dir: string; approved_sha: string };
  const review = stage(pm, '2.0.0');
  await assert.rejects(pm.approve(review.id, { trust: true, onCommitted: () => { throw new Error('synthetic association failure'); } }), /synthetic association failure/);
  assert.deepEqual(pm.store.get(before.id), before);
  assert.equal(hashFiles(fromFolder(before.dir, PLUGIN_LIMITS)), before.approved_sha);
  assert.equal(hashFiles(fromFolder(kept.dir, PLUGIN_LIMITS)), kept.approved_sha);
  await pm.rollback(before.id); assert.equal(pm.store.get(before.id)!.version, '2.0.0');
});

test('attaching an enabled companion during update stop cannot start the obsolete package', async t => {
  const p = processes(t); const { pm, dir } = await rig(t); await install(pm);
  await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
  const review = stage(pm, '2.0.0'); const barrier = holdStop(t);
  const approval = pm.approve(review.id, { trust: true }); await barrier.entered.promise;
  mkdirSync(join(dir, 'new-companion')); const other = makeApp(join(dir, 'new-companion'), { now: new Date() });
  other.companionId = 'other'; other.settings.update({ plugins: { 'candidate-fixture': { enabled: true } } } as never);
  pm.attach('other', other); const startedDuringStop = p.captured.length;
  barrier.release.resolve(); await approval;
  t.after(() => other.store.close());
  assert.equal(startedDuringStop, 1, 'new attachment must wait for current package commit');
  assert.equal(pm.processOf('candidate-fixture', 'other')?.spec().args.some(x => x.includes('candidate-fixture@2.0.0')), true);
});

for (const [operation, revocation] of [['remove', 'off'], ['rollback', 'off'], ['approve', 'block'], ['approve', 'permission'], ['approve', 'tamper']] as const) {
  test(`${revocation} preempts ${operation} while its real process stop is held`, async t => {
    const p = processes(t); const { pm, app } = await rig(t); await install(pm);
    if (operation === 'rollback') await install(pm, '2.0.0');
    const before = pm.store.get('candidate-fixture')!;
    await pm.setEnabled(before.id, 'main', true); await p.ready[0];
    const tool = app.tools.get('candidate_fixture__probe')!;
    const review = operation === 'approve' ? stage(pm, '2.0.0') : undefined;
    const barrier = holdStop(t);
    const work = operation === 'approve' ? pm.approve(review!.id, { trust: true }) : operation === 'remove' ? pm.remove(before.id) : pm.rollback(before.id);
    const rejected = assert.rejects(work, /changed|again/i); await barrier.entered.promise;
    let revoke = Promise.resolve();
    if (revocation === 'off') revoke = pm.setEnabled(before.id, 'main', false);
    if (revocation === 'block') revoke = pm.storeBlock(before.id, 'Synthetic signed block');
    if (revocation === 'permission') {
      app.settings.update({ toolPermissions: { [tool.spec.name]: 'never' } });
      app.settings.update({ toolPermissions: {} });
    }
    if (revocation === 'tamper') {
      const main = join(before.dir, 'main.mjs'); chmodSync(main, 0o600); writeFileSync(main, MAIN + '\n// synthetic disk change');
      assert.equal(pm.verify(before.id), false);
    }
    assert.equal(tool.isAvailable?.(), false); assert.equal(app.tools.get(tool.spec.name), undefined);
    barrier.release.resolve(); await revoke; await rejected;
    const current = pm.store.get(before.id)!;
    assert.equal(current.version, before.version); assert.equal(current.origin, before.origin); assert.equal(current.approved_sha, before.approved_sha);
    assert.equal(p.captured.length, 1, 'revoked operation cannot restart');
    if (revocation === 'block' || revocation === 'tamper') assert.equal(current.status, 'disabled');
  });
}

test('a tool result completed after Off cannot attach its stale card', async t => {
  const p = processes(t); const { pm, app } = await rig(t); await install(pm);
  await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
  const proc = p.captured[0]; const original = proc.request; const arrived = deferred(); const release = deferred();
  t.after(() => release.resolve());
  t.mock.method(proc, 'request', async function(this: PluginProcess, ...args: Parameters<PluginProcess['request']>) {
    const result = await original.apply(this, args); arrived.resolve(); await release.promise; return result;
  });
  const cards: unknown[] = []; const tool = app.tools.get('candidate_fixture__probe')!;
  const result = tool.run({}, { workspaceDir: app.dataDir, sandbox: app.sandbox, signal: AbortSignal.timeout(10_000), attachCard: c => cards.push(c) });
  const rejected = assert.rejects(result, /no longer available/i); await arrived.promise;
  await pm.setEnabled('candidate-fixture', 'main', false); release.resolve(); await rejected;
  assert.deepEqual(cards, []);
});

test('candidate cancellation, expiry, fingerprint and changed same-version source stay ordinary review gates', async t => {
  const { pm } = await rig(t); const review = pm.stageCandidate('daily-briefing');
  pm.cancel(review.id); await assert.rejects(pm.approve(review.id, { trust: true }), /expired/);
  const expiring = pm.stageCandidate('daily-briefing'); const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 61 * 60_000);
  await assert.rejects(pm.approve(expiring.id, { trust: true }), /expired/); clock.mock.restore();
  const fingerprint = stage(pm); fingerprint.sha = '0'.repeat(64);
  await assert.rejects(pm.approve(fingerprint.id, { trust: true }), /files changed/i);
  const installed = pm.stageCandidate('daily-briefing'); await pm.approve(installed.id, { trust: true });
  assert.deepEqual(await pm.updateCheck('daily-briefing'), { upToDate: true, version: '1.0.0' });
  assert.throws(() => pm.stageCandidate('daily-briefing'), /already installed/);
});

test('permission invalidation includes installed and every pending manifest, including removed tools', async t => {
  const { pm, app } = await rig(t); await install(pm);
  const changed = files('2.0.0').map(f => {
    if (f.path !== 'sara-plugin.json') return f;
    const m = JSON.parse(f.data.toString()); m.permissions.tools = [];
    return { ...f, data: Buffer.from(JSON.stringify(m)) };
  });
  const review = pm.stage(changed, { kind: 'zip', where: 'synthetic.zip' });
  app.settings.update({ toolPermissions: { candidate_fixture__probe: 'never' } });
  await assert.rejects(pm.approve(review.id, { trust: true }), /changed|again/i);
});

for (const state of ['enabled', 'disabled', 'off'] as const) {
  test(`settings restart resolves the replacement attachment with current ${state} state`, async t => {
    const p = processes(t); const { pm, app, dir } = await rig(t); await install(pm);
    await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
    const barrier = holdStop(t); const saving = pm.putSettings('candidate-fixture', 'main', { label: 'saved' });
    await barrier.entered.promise;
    const replacementDir = join(dir, 'replacement-app'); mkdirSync(replacementDir);
    const replacement = makeApp(replacementDir, { now: app.now() }); replacement.companionId = 'main';
    t.after(() => replacement.store.close());
    const plugins = pm.companionSettings('main');
    if (state === 'disabled') plugins['candidate-fixture'].enabled = false;
    replacement.settings.update({ plugins } as never); pm.attach('main', replacement);
    if (state === 'off') await pm.setEnabled('candidate-fixture', 'main', false);
    const startedDuringStop = p.captured.length;
    barrier.release.resolve(); await saving;
    assert.equal(startedDuringStop, 1, 'attachment cannot launch during mutation');
    assert.equal(app.tools.get('candidate_fixture__probe'), undefined, 'detached app stays stopped');
    if (state === 'enabled') {
      assert.ok(pm.processOf('candidate-fixture', 'main'), 'current enabled replacement restarts');
      await p.ready[1];
      assert.equal(p.captured.length, 2); assert.equal(replacement.tools.get('candidate_fixture__probe')?.isAvailable?.(), true);
      assert.equal(pm.companionSettings('main')['candidate-fixture'].settings?.label, 'saved');
    } else {
      assert.equal(pm.processOf('candidate-fixture', 'main'), undefined);
      assert.equal(p.captured.length, 1); assert.equal(replacement.tools.get('candidate_fixture__probe'), undefined);
      assert.equal(pm.enabledFor('candidate-fixture', 'main'), false);
    }
  });
}

for (const failure of ['throw', 'promise'] as const) {
  test(`rollback association ${failure} restores plugin row and ledger atomically`, async t => {
    const p = processes(t); const { pm } = await rig(t); await install(pm); await install(pm, '2.0.0');
    pm.opts.db.exec('CREATE TABLE synthetic_rollback_association (version TEXT)');
    pm.opts.db.prepare('INSERT INTO synthetic_rollback_association VALUES (?)').run('2.0.0');
    const before = pm.store.get('candidate-fixture')!; const kept = JSON.parse(before.prev_version!) as { dir: string; approved_sha: string };
    await pm.setEnabled(before.id, 'main', true); await p.ready[0];
    await assert.rejects(pm.rollback(before.id, { onCommitted: row => {
      pm.opts.db.prepare('UPDATE synthetic_rollback_association SET version = ?').run(row.version);
      if (failure === 'throw') throw new Error('synthetic rollback association failure');
      return Promise.resolve();
    } }), failure === 'throw' ? /synthetic rollback association failure/ : /synchronous/i);
    assert.deepEqual(pm.store.get(before.id), before);
    assert.deepEqual(pm.opts.db.prepare('SELECT version FROM synthetic_rollback_association').all().map(row => row.version), ['2.0.0']);
    assert.equal(hashFiles(fromFolder(before.dir, PLUGIN_LIMITS)), before.approved_sha);
    assert.equal(hashFiles(fromFolder(kept.dir, PLUGIN_LIMITS)), kept.approved_sha);
    assert.ok(pm.processOf(before.id, 'main'), 'unchanged enabled package restarts after rollback rejection');
    await p.ready[1]; assert.equal(p.captured.length, 2);
    const rolled = await pm.rollback(before.id, { onCommitted: row => {
      assert.equal(row.version, '1.0.0'); assert.equal(pm.store.get(row.id)?.version, '1.0.0');
      assert.throws(() => stage(pm, '3.0.0'), /changing|busy|progress/i);
      pm.opts.db.prepare('UPDATE synthetic_rollback_association SET version = ?').run(row.version);
    } });
    assert.equal(rolled.version, '1.0.0'); assert.deepEqual(pm.opts.db.prepare('SELECT version FROM synthetic_rollback_association').all().map(row => row.version), ['1.0.0']);
  });
}

test('shutdown stops a real running plugin after the shared database already closed', { timeout: 20_000 }, async t => {
  const { dir, cleanup } = tempDir(); const p = processes(t);
  const app = makeApp(dir, { now: new Date('2026-11-05T12:00:00Z') }); app.companionId = 'main';
  const prior = () => {}; app.settings.onUpdated = prior;
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, scrub: s => s, fence: 'node-only' });
  let closed = false; let proc: PluginProcess | undefined;
  try {
    app.pluginManager = pm; pm.attach('main', app); await install(pm);
    await pm.setEnabled('candidate-fixture', 'main', true); await p.ready[0];
    proc = p.captured[0]; assert.ok(proc.pid, 'fixture owns a real child before DB close');
    const tool = app.tools.get('candidate_fixture__probe')!; assert.equal(tool.isAvailable?.(), true);
    app.store.close(); closed = true;
    await pm.stopAll(); await pm.stopAll();
    assert.equal(proc.pid, undefined); assert.equal(proc.state, 'stopped');
    assert.equal(pm.processOf('candidate-fixture', 'main'), undefined);
    assert.equal(app.tools.get(tool.spec.name), undefined); assert.equal(tool.isAvailable?.(), false);
    assert.equal(app.settings.onUpdated, prior, 'shutdown restores the exact settings observer');
    assert.doesNotThrow(() => {
      proc!.events.onLog('log', 'stale shutdown callback');
      proc!.events.onReady({ type: 'ready', tools: [{ name: 'probe' }] });
      proc!.events.onGaveUp('stale shutdown failure');
      proc!.events.onOneWay?.({ type: 'bridge.status', state: 'connected' });
    });
    await assert.rejects(proc.events.onCall('kv.set', { type: 'call', key: 'stale', value: 1 }), /no longer available/);
  } finally {
    // RED must not strand the captured real child when stopAll rejects before doing cleanup.
    try { await pm.detach('main'); } finally {
      try { await proc?.stop(); } finally {
        if (!closed) app.store.close();
        cleanup();
      }
    }
  }
});
