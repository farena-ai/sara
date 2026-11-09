// 3.1.1 move-in, same computer = one button, another computer = one paste. Sara finds an old agent in
// the standard places on her own computer (read-only, owner only, counts only, no path from the browser),
// packs it herself with progress, and reads it like any upload. For another computer: one line per
// system with a one-time code; the line's scripts are served here; a bundle sent with the code arrives
// by itself (the page moves on when it does). All data is made up (owner "Alex").
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ROOT } from './helpers.ts';
import { makeOpenClawHome } from './movein-fixtures.ts';
import { PY, app, cleanupScratch, realisticHermes, scratch } from './movein-real-fixtures.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { findLocalAgents, goPs1, goSh, oneLine } from '../src/movein/local.ts';

after(cleanupScratch);

/** A child process without blocking this one (the test server answers it). */
function runAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (b) => (stdout += b));
    c.stderr.on('data', (b) => (stderr += b));
    const timer = setTimeout(() => c.kill(), 120_000);
    c.on('close', (status) => {
      clearTimeout(timer);
      res({ status, stdout, stderr });
    });
  });
}

/** A home folder with Hermes Agent in ~/.hermes and OpenClaw in ~/.openclaw, and nothing else. */
function fakeHome() {
  const home = scratch('home');
  const h = realisticHermes(home, { bulk: 20 });
  const dot = join(home, '.hermes');
  // realisticHermes made <home>/hermes: the standard place is ~/.hermes.
  spawnSync(process.platform === 'win32' ? 'cmd' : 'mv', process.platform === 'win32' ? ['/c', 'move', h, dot] : [h, dot]);
  const oc = makeOpenClawHome(home, { live: true });
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), HERMES_HOME: '', OPENCLAW_STATE_DIR: oc.state, OPENCLAW_PROFILE: '', OPENCLAW_WORKSPACE_DIR: '', OPENCLAW_CONFIG_PATH: '' };
  return { home, env, oc };
}

async function rig(t: { after: (fn: () => void) => void }) {
  const a = app('local-rig');
  a.settings.update({ disclosureAcceptedAt: new Date().toISOString() });
  const auth = new OwnerAuth(a.dataDir);
  const owner = auth.newToken!;
  const server = createSaraServer({ app: a, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    a.moveIn?.close();
    a.historyImport?.stop();
    server.close();
    a.store.close();
  });
  const call = async (method: string, path: string, body?: unknown, token: string | null = owner) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, text, json };
  };
  return { a, base, call };
}

test('detection: Hermes Agent and OpenClaw in the standard places, with counts of what would come over', async () => {
  const { env } = fakeHome();
  const found = await findLocalAgents({ fresh: true, env });
  const h = found.find((x) => x.kind === 'hermes')!;
  assert.ok(h, JSON.stringify(found));
  assert.equal(h.where.replace(/\\/g, '/'), '~/.hermes');
  assert.deepEqual(h.counts, { memories: 4, skills: 2, chats: 3 }, 'helpers and bundled skills are not counted; the compression chain is one chat');
  assert.equal(h.name, 'Wren');
  const o = found.find((x) => x.kind === 'openclaw')!;
  assert.ok(o && o.counts.chats >= 1 && o.counts.skills >= 1, JSON.stringify(o));
  // Nothing found: an empty list, no error.
  const empty = scratch('empty');
  assert.deepEqual(await findLocalAgents({ fresh: true, env: { HOME: empty, USERPROFILE: empty, LOCALAPPDATA: empty, HERMES_HOME: '', OPENCLAW_STATE_DIR: '' } }), []);
});

test('one button: the owner sees what was found (no paths), Sara packs it with progress, the preview follows', async (t) => {
  const { env } = fakeHome();
  const r = await rig(t);
  await findLocalAgents({ fresh: true, env });
  const list = await r.call('GET', '/api/movein/local');
  assert.equal(list.status, 200, list.text);
  const h = list.json.agents.find((x: { kind: string }) => x.kind === 'hermes');
  assert.ok(h && !('root' in h), 'the page never gets the full path');
  assert.equal((await r.call('GET', '/api/movein/local', undefined, null)).status, 401, 'owner only');
  assert.equal((await r.call('POST', '/api/movein/local/collect', { key: 'not-a-key' })).status, 404);
  const go = await r.call('POST', '/api/movein/local/collect', { key: h.key });
  assert.equal(go.status, 202, go.text);
  assert.equal(go.json.state, 'collecting');
  const seen = new Set<string>();
  for (let i = 0; i < 600; i++) {
    const b = (await r.call('GET', '/api/movein')).json.bundles.find((x: { id: string }) => x.id === go.json.id);
    seen.add(b.state);
    if (b.state === 'ready' || b.state === 'failed') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const pv = await r.call('GET', `/api/movein/bundles/${go.json.id}`);
  assert.equal(pv.json.state, 'ready', pv.text);
  assert.equal(pv.json.conversations.count, 3);
  assert.ok(seen.has('collecting') || seen.has('checking') || seen.has('ready'));
  const listed = (await r.call('GET', '/api/movein')).json.bundles.find((x: { id: string }) => x.id === go.json.id);
  assert.equal(listed.via, 'local');
  // The medical skill came along but waits for a yes (held), like every sensitive item.
  assert.ok(pv.json.held.medical >= 1, JSON.stringify(pv.json.held));
  assert.equal(readdirSync(r.a.moveIn!.dir).filter((f) => f.includes('.collect.')).length, 0, 'no packing leftovers');
});

test('one paste: a code and one line per system; the scripts are served; a bundle sent with the code arrives by itself', async (t) => {
  const r = await rig(t);
  const one = await r.call('POST', '/api/movein/oneline', { system: 'windows' });
  assert.equal(one.status, 200, one.text);
  const code = one.json.code as string;
  const dashed = code.replace(/ /g, '-');
  assert.equal(one.json.lines.windows, `irm "${r.base}/movein/go.ps1?c=${dashed}" | iex`);
  assert.equal(one.json.lines.mac, `curl -fsSL "${r.base}/movein/go.sh" | sh -s -- ${dashed}`);
  assert.equal(one.json.lines.linux, one.json.lines.mac);
  assert.equal(one.json.line, one.json.lines.windows);
  assert.equal(one.json.reachable, false, 'opened as 127.0.0.1 and Sara listens only here: the page warns that another computer cannot reach it');
  assert.equal((await r.call('POST', '/api/movein/oneline', { system: 'mac' }, null)).status, 401, 'owner only');
  const sh = await (await fetch(`${r.base}/movein/go.sh`)).text();
  assert.match(sh, new RegExp(`SARA='${r.base.replace(/[.]/g, '\\.')}'`));
  assert.match(sh, /python3 .*--send-to \$SARA|ARGS="collect --yes .*--send-to \$SARA"/);
  assert.match(sh, /elif node -e/);
  assert.match(sh, /neither Python 3 nor Node/);
  const ps = await (await fetch(`${r.base}/movein/go.ps1?c=${dashed}`)).text();
  assert.ok(ps.includes(`$code = '${code}'`), ps.slice(0, 400));
  assert.match(ps, /Invoke-WebRequest -UseBasicParsing "\$sara\/movein\/sara-movein\.py"/);
  const mjs = await fetch(`${r.base}/movein/sara-movein.mjs`);
  assert.equal(mjs.status, 200);
  assert.equal((await mjs.text()).length, readFileSync(join(ROOT, 'scripts', 'sara-movein.mjs'), 'utf8').length);
  // The old computer runs the collector with --send-to and the code (here: the Node one, as go.sh would without Python).
  const { home } = fakeHome();
  const out = join(home, 'tmp-out');
  mkdirSync(out);
  const run = await runAsync(process.execPath, ['--no-warnings', join(ROOT, 'scripts', 'sara-movein.mjs'), 'collect', '--yes', '--hermes-home', join(home, '.hermes'), '--out', out, '--send-to', r.base, '--code', code, '--progress', 'off']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Sent to Sara/);
  assert.deepEqual(readdirSync(out), [], 'the bundle is deleted on the old computer after it is sent');
  const arrived = (await r.call('GET', '/api/movein')).json.bundles.filter((b: { createdAt: string; via: string }) => b.createdAt >= one.json.since && b.via === 'code');
  assert.equal(arrived.length, 1, 'the page sees it arrive');
  await r.a.moveIn!.idle(arrived[0].id);
  assert.equal((await r.call('GET', `/api/movein/bundles/${arrived[0].id}`)).json.state, 'ready');
  // A wrong code: a clear message, the file stays for an upload.
  const bad = await runAsync(process.execPath, ['--no-warnings', join(ROOT, 'scripts', 'sara-movein.mjs'), 'collect', '--yes', '--hermes-home', join(home, '.hermes'), '--out', out, '--send-to', r.base, '--code', 'wrong words here', '--progress', 'off']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /move-in code is wrong or has expired/);
  assert.match(bad.stdout, /Upload a file/);
});

test('one paste with Python: the same --send-to works from the Python collector', { skip: PY ? false : 'no python3' }, async (t) => {
  const r = await rig(t);
  const { code, since } = (await r.call('POST', '/api/movein/oneline', { system: 'linux' })).json;
  const { home } = fakeHome();
  const out = join(home, 'py-out');
  mkdirSync(out);
  const run = await runAsync(PY!, [join(ROOT, 'scripts', 'sara-movein.py'), 'collect', '--yes', '--hermes-home', join(home, '.hermes'), '--out', out, '--send-to', r.base, '--code', code, '--progress', 'off'], { ...process.env, PYTHONIOENCODING: 'utf-8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(readdirSync(out), []);
  const arrived = (await r.call('GET', '/api/movein')).json.bundles.filter((b: { createdAt: string; via: string }) => b.createdAt >= since && b.via === 'code');
  assert.equal(arrived.length, 1);
});

test('the one line and its scripts: short, the code inside, nothing secret, never more than the move-in', () => {
  const line = oneLine('https://sara.example.com', 'apple river stone cloud lamp tiger', 'mac');
  assert.ok(line.length < 120, line);
  assert.equal(oneLine('https://sara.example.com', 'apple river stone cloud lamp tiger', 'windows'), 'irm "https://sara.example.com/movein/go.ps1?c=apple-river-stone-cloud-lamp-tiger" | iex');
  const ps = goPs1('https://sara.example.com', "apple-river'; rm -rf /");
  assert.ok(!ps.includes("rm -rf"), 'only letters and dashes from the code reach the script');
  const sh = goSh("https://x.example.com'; echo pwned; '");
  assert.match(sh, /SARA='https:\/\/x\.example\.com'\\''; echo pwned; '\\'''/, 'the address is quoted');
});
