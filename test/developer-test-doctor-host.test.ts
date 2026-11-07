// N03 Test Doctor through the official pack/smoke and the real PluginManager: trust, Off until
// enabled, plan, the owner's job card with the exact command, a real run in a disposable copy,
// result.card in every language, disable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginManager } from '../src/plugins/manager.ts';
import { pluginToolName } from '../src/plugins/manifest.ts';
import { fromFolder, fromZip, hashFiles } from '../src/packages.ts';
import { packPath } from '../src/store/pack.ts';
import { splitListing } from '../src/store/checks.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function until(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, 'deadline');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('test-doctor: official pack/smoke, real manager trust/enable/plan/approved job/result.card/disable', { timeout: 180_000 }, async () => {
  const id = 'test-doctor', { dir, cleanup } = tempDir(), app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.providerFactory = () => { throw Error('No model'); };
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (s) => s, fence: 'node-only', jobFence: 'node-only', saraVersion: '2.68.0', lookup: async () => { throw Error('No DNS'); }, httpGet: async () => { throw Error('No HTTP'); } });
  app.pluginManager = pm;
  pm.attach('main', app);
  try {
    const source = join(ROOT, 'store/plugins', id);
    const packed = await packPath(source, { saraVersion: '2.68.0', smoke: 'node-only', scratch: dir, watchMs: 80, readyMs: 10000 });
    assert.equal(packed.report.ready, true, JSON.stringify(packed.report.results));
    assert.equal(packed.report.smoke, 'ran');
    const runtime = (f: ReturnType<typeof fromFolder>) => splitListing(f).pkg.filter((x) => !['CHANGES.md', 'icon.png'].includes(x.path));
    const files = runtime(fromZip(packed.zip));
    assert.equal(hashFiles(files), hashFiles(runtime(fromFolder(source))));
    const review = pm.stage(files, { kind: 'zip', where: 'synthetic-test-doctor.zip' });
    assert.ok(review.lines.some((l) => l.id === 'run:node:data'), 'the review lists the job permission');
    await assert.rejects(pm.approve(review.id), /trust this plugin.s author/i);
    const row = await pm.approve(review.id, { trust: true });
    assert.equal(pm.enabledFor(id, 'main'), false);
    const home = pm.dataDirFor(id, 'main');
    cpSync(join(ROOT, 'test/fixtures/developer/test-doctor/repo'), join(home, 'projects', 'shop'), { recursive: true }); // trusted operator staging while disabled
    const full = pluginToolName(id, 'diagnose'), cards: any[] = [];
    const ctx = { workspaceDir: dir, sandbox: app.sandbox, signal: AbortSignal.timeout(60_000), attachCard: (c: any) => cards.push(c) };
    const args = { project: 'shop', file: 'test/price.test.mjs', test: 'total applies the discount once' };
    const labelsAll = JSON.parse(readFileSync(join(source, 'labels.json'), 'utf8'));
    for (const language of ['en', 'es', 'fr', 'de', 'pt-BR', 'it']) {
      app.settings.update({ language } as never);
      await pm.setEnabled(id, 'main', true);
      await until(() => app.tools.get(full)?.isAvailable?.() === true);
      const tool = app.tools.get(full)!;
      assert.deepEqual(tool.spec.parameters, JSON.parse(readFileSync(join(source, 'schema.json'), 'utf8')));
      assert.equal(tool.defaultPermission, 'ask');
      const plan = JSON.parse(await tool.run({ operation: 'plan', ...args }, ctx));
      assert.deepEqual(pm.waiting(), [], 'planning runs nothing and asks nothing');
      const p = tool.run({ operation: 'run', ...args, planSha: plan.planSha }, ctx);
      await until(() => pm.waiting().length === 1);
      const w = pm.waiting()[0];
      assert.equal(w.job?.command, plan.command);
      assert.match(w.summary, /disposable copy of its own files/);
      assert.equal(pm.callDecision(w.id, true), 'decided');
      const d = JSON.parse(await p);
      assert.equal(d.status, 'assertion-failed');
      assert.equal(d.assertion.line, 12);
      assert.equal(d.source[0].file, 'src/price.mjs');
      assert.equal(d.copyDeleted, true);
      assert.equal(cards.at(-1).title, labelsAll[language].title);
      assert.equal(cards.at(-1).lines[0], labelsAll[language]['assertion-failed']);
      await pm.setEnabled(id, 'main', false);
      assert.equal(app.tools.get(full), undefined);
    }
    assert.equal(cards.length, 12);
    assert.equal(app.providerCalls, 0);
    assert.equal(existsSync(join(home, 'projects', 'shop', 'report.txt')), false);
    assert.equal(hashFiles(fromFolder(row.dir)), pm.store.get(id)!.approved_sha);
  } finally {
    await pm.stopAll();
    app.store.close();
    cleanup();
  }
});
