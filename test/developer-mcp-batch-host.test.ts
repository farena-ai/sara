// Opt-in fixture acceptance for the READY developer MCP recipes (MCP_BATCH_QUALIFY=1).
// Each test starts the exact pinned upstream from its store/mcp recipe through Sara's real
// McpManager/ToolRegistry/SettingsStore against an owned local fixture. No account, key or paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { McpManager, mcpToolName } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { SettingsStore } from '../src/settings.ts';
import { parseRecipe } from '../src/store/format.ts';
import type { Permission } from '../src/tools/types.ts';

const QUALIFY = process.env.MCP_BATCH_QUALIFY === '1';
const out = resolve('outputs/developer-addons/mcp-batch');
const pause = (n: number) => new Promise(r => setTimeout(r, n));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const sandbox = { mode: 'none' as const, network: true, detail: 'Windows owned fixture only; no OS fence' };
const ctx = (root: string) => ({ workspaceDir: root, sandbox, signal: AbortSignal.timeout(120_000) });
const recipe = (id: string) => JSON.parse(readFileSync(resolve(`store/mcp/${id}.json`), 'utf8'));
function treeHash(dir: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else rows[p.slice(dir.length + 1).replaceAll('\\', '/')] = sha(readFileSync(p)); } };
  walk(dir); return rows;
}
/** Hash once the stopped server has released its files (Windows keeps them locked until exit). */
async function settledHash(dir: string): Promise<Record<string, string>> {
  let last: unknown;
  for (let i = 0; i < 40; i++) { try { return treeHash(dir); } catch (e) { last = e; await pause(500); } }
  throw last;
}
function scratch(): string {
  assert.match(tmpdir().replaceAll('\\', '/'), /hermes\/cache\/scratch\//i, 'Set TMPDIR/TEMP/TMP to an owned Hermes scratch folder.');
  mkdirSync(out, { recursive: true }); return mkdtempSync(join(tmpdir(), 'mcp-batch-'));
}
/** The recipe's stdio config and the env its field defaults produce (what the add form would carry). */
function stdioFromRecipe(id: string, overrides: Record<string, string> = {}) {
  const r = parseRecipe(recipe(id).mcp);
  const env = Object.fromEntries(r.fields.map(f => [f.key, f.default ?? '']));
  return { config: { name: r.name, transport: 'stdio' as const, command: r.command!, args: r.args! }, env: { ...env, ...overrides }, recipe: r };
}
async function lifecycle(name: string, config: any, env: Record<string, string>, reads: string[], offRaw: string[], root: string, receipt: any) {
  const registry = new ToolRegistry([]);
  const manager = new McpManager(registry, { dataDir: root, sandbox, secrets: () => ({ env }) });
  const permissions: Record<string, Permission> = {};
  for (const raw of reads) permissions[mcpToolName(name, raw)] = 'ask';
  for (const raw of [...offRaw, 'unreviewed-new-tool']) permissions[mcpToolName(name, raw)] = 'never';
  const store = new SettingsStore(root);
  store.update({ mcpServers: [{ ...config, enabled: false }], toolPermissions: permissions });
  // Saved disabled: nothing starts or registers.
  await manager.start(new SettingsStore(root).get().mcpServers![0]);
  assert.equal(registry.list().length, 0);
  store.update({ mcpServers: [{ ...config, enabled: true }] });
  const saved = new SettingsStore(root).get();
  assert.deepEqual(saved.toolPermissions, permissions, 'permissions read back before any feature call');
  const conn = await manager.start(saved.mcpServers![0]);
  assert.equal(conn.status, 'ready', conn.error);
  receipt.tools = conn.tools;
  for (const t of registry.list()) {
    const raw = t.spec.name.slice(`mcp_${name}_`.length);
    assert.ok(reads.includes(raw) || offRaw.includes(raw), `unreviewed upstream tool ${raw}`);
    assert.equal(registry.permission(t.spec.name, saved.toolPermissions), permissions[t.spec.name]);
  }
  assert.deepEqual(registry.enabled(saved.toolPermissions).map(t => t.spec.name).sort(), reads.map(r => mcpToolName(name, r)).sort());
  receipt.policy = { readBackBeforeFeatures: true, disabledStartRegisteredZero: true, saved: permissions };
  const call = async (raw: string, args: Record<string, unknown>) => {
    assert.ok(reads.includes(raw), `${raw} is not an approved read`);
    const tool = registry.get(mcpToolName(name, raw))!;
    const result = await tool.run(args, ctx(root));
    assert.ok(result.length < 30_000, 'output below the host clipping boundary');
    receipt.calls.push({ raw, args, result: result.slice(0, 4000) });
    return result;
  };
  const reconnect = async () => {
    const first = receipt.calls[0];
    const stale = registry.get(mcpToolName(name, first.raw))!;
    manager.stopAll(); assert.equal(registry.list().length, 0);
    await assert.rejects(stale.run(first.args, ctx(root)), /not connected/);
    const again = new SettingsStore(root).get();
    assert.deepEqual(again.toolPermissions, permissions);
    const c = await manager.start(again.mcpServers![0]);
    assert.equal(c.status, 'ready', c.error);
    assert.deepEqual(c.tools, receipt.tools, 'exact names and schemas after reconnect');
    await assert.rejects(stale.run(first.args, ctx(root)), /not connected/);
    store.update({ mcpServers: [{ ...config, enabled: false }] });
    manager.stopAll();
    await manager.start(new SettingsStore(root).get().mcpServers![0]);
    assert.equal(registry.list().length, 0);
    receipt.reconnect = { persisted: true, staleReferenceRefused: true, disabledReadback: true, registryEmpty: true };
  };
  return { registry, manager, call, reconnect };
}
function rmOwned(root: string, receipt: any) {
  // Embedded stores and caches hold open files on Windows; a clean removal shows the child exited.
  let last: unknown;
  for (let i = 0; i < 20; i++) { try { rmSync(root, { recursive: true, force: true }); break; } catch (e) { last = e; } }
  receipt.cleanup = { rootRemoved: !existsSync(root), error: existsSync(root) ? String(last) : null };
  assert.equal(existsSync(root), false, 'owned root removed after the server stopped');
}

const NOTES = [
  'Banana bread: mash three ripe bananas, mix with flour, sugar and butter, and bake for an hour.',
  'Payment service runbook: page the on-call engineer when card authorisations fail for five minutes.',
  'Kubernetes pod in CrashLoopBackOff: read the previous container log before restarting the deployment.',
];
test('Qdrant: pinned official server stores fixture notes, then a read-only start finds the expected one', { skip: !QUALIFY, timeout: 900_000 }, async () => {
  const root = scratch(); const receipt: any = { runtime: process.version, calls: [] };
  let seed: any; let h: any;
  try {
    const base = stdioFromRecipe('qdrant');
    // Paths are relative to the server's own folder (its working directory), exactly as the recipe defaults.
    const store = join(root, 'mcp', base.config.name);
    // Seeding is an operator step with the same pinned server and read-only explicitly off.
    seed = await lifecycle(base.config.name, base.config, { ...base.env, QDRANT_READ_ONLY: 'false' }, ['qdrant-store'], ['qdrant-find'], root, { calls: [] });
    for (const information of NOTES) {
      const t = seed.registry.get(mcpToolName('qdrant', 'qdrant-store'))!;
      assert.match(await t.run({ information }, ctx(root)), /Remembered/i);
    }
    seed.manager.stopAll(); await pause(1500);
    const before = await settledHash(join(store, 'qdrant-store'));
    assert.ok(Object.keys(before).length > 0, 'embedded collection exists on disk');
    receipt.recipeArgs = base.config.args; receipt.recipeEnv = base.env;
    h = await lifecycle(base.config.name, base.config, base.env, ['qdrant-find'], ['qdrant-store'], root, receipt);
    assert.deepEqual(receipt.tools.map((t: any) => t.name), ['qdrant-find'], 'read-only mode exposes no store tool');
    assert.deepEqual(Object.keys(receipt.tools[0].inputSchema.properties), ['query'], 'collection is fixed by the operator, not the caller');
    const found = await h.call('qdrant-find', { query: 'how do I bake bread at home' });
    const first = found.indexOf('Banana bread'); assert.ok(first >= 0, found);
    for (const other of ['Payment service', 'CrashLoopBackOff']) { const i = found.indexOf(other); assert.ok(i < 0 || i > first, 'expected note ranks first'); }
    const k8s = await h.call('qdrant-find', { query: 'container keeps restarting' });
    const k = k8s.indexOf('CrashLoopBackOff'); assert.ok(k >= 0, k8s);
    const bread = k8s.indexOf('Banana bread'); assert.ok(bread < 0 || bread > k);
    await h.reconnect();
    assert.deepEqual(await settledHash(join(store, 'qdrant-store')), before, 'read-only search left the collection bytes unchanged');
    receipt.featurePassed = true;
  } catch (e) { receipt.failure = String(e); throw e; }
  finally { seed?.manager.stopAll(); h?.manager.stopAll(); await pause(2500); writeFileSync(join(out, 'qdrant-receipt.json'), JSON.stringify(receipt, null, 2)); rmOwned(root, receipt); writeFileSync(join(out, 'qdrant-receipt.json'), JSON.stringify(receipt, null, 2)); }
});

test('Storybook: pinned addon in an owned Storybook finds the component, previews and renders the selected story', { skip: !QUALIFY, timeout: 300_000 }, async () => {
  const pwPath = process.env.MCP_BATCH_PLAYWRIGHT; assert.ok(pwPath, 'MCP_BATCH_PLAYWRIGHT must name an existing playwright-core index.mjs');
  const tool = resolve('tools/developer-mcp-public');
  const lock = JSON.parse(readFileSync(join(tool, 'package-lock.json'), 'utf8'));
  for (const pkg of ['storybook', '@storybook/addon-mcp']) {
    const installed = JSON.parse(readFileSync(join(tool, 'node_modules', pkg, 'package.json'), 'utf8'));
    assert.equal(installed.version, '10.6.6'); assert.equal(lock.packages[`node_modules/${pkg}`].version, '10.6.6');
  }
  const root = scratch(); const receipt: any = { runtime: process.version, calls: [] };
  const fixture = resolve('test/fixtures/developer/mcp-public');
  const snap = () => Object.fromEntries(['Button.js', 'Button.stories.js'].map(f => [f, sha(readFileSync(join(fixture, f)))]));
  const before = snap();
  let child: any; let h: any; let browser: any; let port = 0;
  try {
    const l = createServer(); await new Promise<void>(r => l.listen(0, '127.0.0.1', r)); port = (l.address() as any).port; await new Promise<void>(r => l.close(() => r()));
    child = spawn(process.execPath, [join(tool, 'node_modules/storybook/dist/bin/dispatcher.js'), 'dev', '--port', String(port), '--host', '127.0.0.1', '--config-dir', join(tool, 'fixture/.storybook'), '--ci', '--no-open', '--disable-telemetry', '--no-version-updates'],
      { cwd: tool, env: { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, CI: 'true', STORYBOOK_DISABLE_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d: Buffer) => { log += d; }); child.stderr.on('data', (d: Buffer) => { log += d; });
    let index: any;
    for (let i = 0; i < 150 && !index; i++) { if (child.exitCode !== null) throw Error('Storybook exited: ' + log.slice(-2000)); try { const res = await fetch(`http://127.0.0.1:${port}/index.json`); if (res.ok) index = await res.json(); } catch { /* starting */ } if (!index) await pause(400); }
    assert.ok(index, 'Storybook ready');
    const stories = Object.keys(index.entries).sort(); assert.deepEqual(stories, ['owned-button--disabled', 'owned-button--primary']);
    // The recipe's exact URL with only the owned fixture's free port substituted for 6006.
    const r = parseRecipe(recipe('storybook').mcp); assert.equal(r.url, 'http://127.0.0.1:6006/mcp');
    const url = r.url!.replace(':6006/', `:${port}/`);
    h = await lifecycle('storybook', { name: 'storybook', transport: 'http', url }, {}, ['stories-find-by-component', 'stories-preview'], ['get-storybook-story-instructions'], root, receipt);
    assert.deepEqual(receipt.tools.map((t: any) => t.name).sort(), ['get-storybook-story-instructions', 'stories-find-by-component', 'stories-preview']);
    const found = await h.call('stories-find-by-component', { componentPaths: [join(fixture, 'Button.js')] });
    assert.match(found, /owned-button--primary/); assert.match(found, /owned-button--disabled/);
    const preview = await h.call('stories-preview', { stories: [{ storyId: 'owned-button--disabled' }] });
    const urls = [...preview.matchAll(/http:\/\/[^\s"<>)]+/g)].map(m => m[0].replace(/[),.]$/, ''));
    assert.ok(urls.length >= 1, preview);
    const pw = await import(pathToFileURL(pwPath).href);
    browser = await pw.chromium.launchPersistentContext(join(root, 'profile'), { headless: true });
    const blocked: string[] = [];
    await browser.route('**/*', async (route: any) => { const u = new URL(route.request().url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== String(port)) { blocked.push(u.origin); await route.abort(); } else await route.continue(); });
    receipt.rendered = [];
    for (const u of new Set(urls)) {
      const parsed = new URL(u); assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === String(port) && parsed.protocol === 'http:', `preview link stays on the owned Storybook: ${u}`);
      const page = await browser.newPage(); await page.goto(u, { waitUntil: 'domcontentloaded' });
      const frame = parsed.pathname.endsWith('iframe.html') ? page : page.frameLocator('#storybook-preview-iframe');
      const button = frame.getByRole('button', { name: 'SARA PUBLIC MCP DISABLED', exact: true });
      await button.waitFor({ timeout: 30_000 });
      receipt.rendered.push({ url: u, label: await button.textContent(), disabled: await button.isDisabled() });
      await page.close();
    }
    assert.ok(receipt.rendered.length >= 1 && receipt.rendered.every((x: any) => x.disabled === true && x.label === 'SARA PUBLIC MCP DISABLED'), 'actual selected story state rendered');
    receipt.blockedExternalOrigins = [...new Set(blocked)];
    await browser.close(); browser = undefined;
    assert.equal(await h.call('stories-preview', { stories: [{ storyId: 'owned-button--missing' }] }), 'No story found for story ID "owned-button--missing"');
    await h.reconnect();
    assert.deepEqual(snap(), before, 'fixture sources unchanged');
    receipt.featurePassed = true;
  } catch (e) { receipt.failure = String(e); throw e; }
  finally {
    await browser?.close(); h?.manager.stopAll(); child?.kill(); await pause(2500);
    if (port) await assert.rejects(fetch(`http://127.0.0.1:${port}/index.json`), 'Storybook listener closed');
    receipt.listenerClosed = Boolean(port);
    writeFileSync(join(out, 'storybook-receipt.json'), JSON.stringify(receipt, null, 2)); rmOwned(root, receipt);
    writeFileSync(join(out, 'storybook-receipt.json'), JSON.stringify(receipt, null, 2));
  }
});
