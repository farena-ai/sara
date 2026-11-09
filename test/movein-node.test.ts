// 3.1.1 move-in: the Node collector (scripts/sara-movein.mjs, for computers with Node but no Python)
// makes the same bundle as the Python one for the same input: the same files with the same bytes, the
// same rows, the same manifest and plan (apart from who made it and when). It is one file with no
// dependencies, never opens secrets, and Sara reads its bundle like any other.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './helpers.ts';
import { ALL_FAKE, makeHermesHome, makeOpenClawHome } from './movein-fixtures.ts';
import { PY, app, cleanupScratch, openclaw2611, realisticHermes, scratch } from './movein-real-fixtures.ts';
import { MoveIn } from '../src/movein/index.ts';

const NODE_COLLECTOR = join(ROOT, 'scripts', 'sara-movein.mjs');
const PY_COLLECTOR = join(ROOT, 'scripts', 'sara-movein.py');
after(cleanupScratch);
const NO_PY = PY ? false : 'no python3 here (parity needs both collectors)';

function run(which: 'py' | 'node', args: string[], cwd: string) {
  const r = which === 'py' ? spawnSync(PY!, [PY_COLLECTOR, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', HERMES_HOME: '' }, timeout: 120_000 }) : spawnSync(process.execPath, ['--no-warnings', NODE_COLLECTOR, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HERMES_HOME: '' }, timeout: 120_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** Every entry of a zip, inflated (Node's own reader in the collector). */
async function entries(file: string): Promise<Map<string, Buffer>> {
  const { readZip } = (await import(`file:///${NODE_COLLECTOR.replace(/\\/g, '/')}`)) as { readZip: (f: string) => Map<string, Buffer> };
  return readZip(file);
}
const jsonl = (b?: Buffer) => (b ? b.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The bundle's meaning: files by bytes, rows per table (parts merged), manifest/plan minus maker and time. */
async function meaning(file: string) {
  const z = await entries(file);
  const files: Record<string, string> = {};
  const rows: Record<string, unknown[]> = {};
  for (const [name, body] of z) {
    if (name.startsWith('files/')) files[name] = body.toString('base64');
    else if (/\/rows\/.+\.\d+\.jsonl$/.test(name)) {
      const key = name.replace(/\.\d+\.jsonl$/, '');
      rows[key] = [...(rows[key] ?? []), ...jsonl(body)];
    } else if (/\/samples\/|schema\.sql$/.test(name)) files[name] = name.endsWith('.sql') ? body.toString('utf8') : JSON.stringify(jsonl(body));
    else if (name.endsWith('/schema.json')) {
      const s = JSON.parse(body.toString('utf8'));
      delete s.client;
      for (const t of s.tables) delete t.avgRowBytes;
      files[name] = JSON.stringify(s);
    }
  }
  const m = JSON.parse(z.get('manifest.json')!.toString('utf8'));
  delete m.collector;
  delete m.createdAt;
  delete m.timeZone;
  const plan = JSON.parse(z.get('plan.json')!.toString('utf8'));
  delete plan.collector;
  delete plan.estimateBytes;
  return { names: [...z.keys()].filter((n) => !/\/rows\//.test(n)).sort(), files, rows, manifest: m, plan };
}

async function both(home: string[], root: string, extra: string[] = []) {
  const out: Record<string, string> = {};
  for (const which of ['py', 'node'] as const) {
    const dir = join(root, `out-${which}`);
    mkdirSync(dir);
    const r = run(which, ['collect', ...home, '--yes', '--out', dir, '--lang', 'en', '--progress', 'off', ...extra], root);
    assert.equal(r.status, 0, `${which}: ${r.err}${r.out}`);
    out[which] = join(dir, readdirSync(dir).find((f) => f.endsWith('.saramove'))!);
  }
  return { py: await meaning(out.py), node: await meaning(out.node), files: out };
}

function same(a: Awaited<ReturnType<typeof meaning>>, b: Awaited<ReturnType<typeof meaning>>) {
  assert.deepEqual(b.names, a.names, 'the same entries');
  for (const k of Object.keys(a.files)) assert.equal(b.files[k], a.files[k], `the same bytes: ${k}`);
  assert.deepEqual(b.rows, a.rows, 'the same rows');
  assert.deepEqual(b.manifest, a.manifest, 'the same manifest');
  assert.deepEqual(b.plan, a.plan, 'the same plan');
}

test('Node collector: one file, no dependencies, the same version as the Python one', () => {
  const src = readFileSync(NODE_COLLECTOR, 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env node/);
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  for (const i of imports) assert.match(i, /^node:/, `only node: built-ins (${i})`);
  const py = readFileSync(PY_COLLECTOR, 'utf8');
  assert.equal(/VERSION = '([^']+)'/.exec(src)![1], /VERSION = '([^']+)'/.exec(py)![1]);
});

test('the Node collector ships with every install (server, Docker, Windows, Mac) next to the Python one', () => {
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  assert.match(read('deploy', 'install.sh'), /cp "\$SRC_DIR\/scripts\/sara-movein\.mjs" "\$APP_DIR\/scripts\/"/);
  assert.match(read('Dockerfile'), /\nCOPY scripts\/sara-movein\.mjs \.\/scripts\/sara-movein\.mjs\n/);
  assert.match(read('desktop', 'windows', 'build-installer.sh'), /cp "\$ROOT\/scripts\/sara-movein\.mjs" "\$STAGE\/server\/scripts\/"/);
  assert.match(read('desktop', 'mac', 'build.sh'), /cp "\$ROOT\/scripts\/sara-movein\.mjs" "\$S\/scripts\/"/);
});

test('parity: a Hermes Agent home gives the same bundle from Python and Node', { skip: NO_PY }, async () => {
  const root = scratch('hermes');
  const home = makeHermesHome(root);
  const r = await both(['--hermes-home', home], root, ['--include-category', 'medical']);
  same(r.py, r.node);
  const text = Object.values(r.node.files).map((b) => Buffer.from(b, 'base64').toString('utf8')).join('\n');
  for (const f of ALL_FAKE) assert.ok(!text.includes(f), 'no secret in the Node bundle');
});

test('parity: an OpenClaw state + workspace gives the same bundle from Python and Node', { skip: NO_PY }, async () => {
  const root = scratch('openclaw');
  const oc = makeOpenClawHome(root, { live: true });
  const r = await both(['--openclaw-state', oc.state], root);
  same(r.py, r.node);
});

test('parity: an OpenClaw 2026.11 home (chats in the agent database, cron_jobs) gives the same bundle', { skip: NO_PY }, async () => {
  const root = scratch('oc2611');
  const oc = openclaw2611(root);
  const r = await both(['--openclaw-state', oc.state], root);
  same(r.py, r.node);
});

test('parity: a real-shaped Hermes home (installs, caches, helpers, --max-chats) gives the same bundle', { skip: NO_PY }, async () => {
  const root = scratch('real');
  const home = realisticHermes(root, { bulk: 300 });
  const r = await both(['--hermes-home', home], root, ['--max-chats', '2']);
  same(r.py, r.node);
  const sessions = Object.entries(r.node.rows).find(([k]) => k.endsWith('/rows/sessions'))![1];
  assert.equal(sessions.length, 2, 'only the two newest chats');
});

test('Sara reads a Node-made bundle: the preview counts it like the Python one', async () => {
  const root = scratch('read');
  const home = realisticHermes(root, { bulk: 5 });
  const dir = join(root, 'out');
  mkdirSync(dir);
  const r = run('node', ['collect', '--hermes-home', home, '--yes', '--out', dir, '--progress', 'off'], root);
  assert.equal(r.status, 0, r.err);
  const a = app('node-read');
  const mi = new MoveIn(() => a);
  try {
    const s = await mi.addFile(join(dir, readdirSync(dir)[0]));
    assert.equal(s.state, 'ready', s.error);
    const pv = mi.preview(s.id) as Record<string, any>;
    assert.equal(pv.conversations.count, 3);
    assert.equal(pv.sections.memories.found, 2);
    assert.equal(pv.sections.profile.found, 2);
  } finally {
    a.historyImport?.stop();
    mi.close();
    a.store.close();
  }
});
