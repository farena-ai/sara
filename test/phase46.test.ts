// Phase 46: Sara's server on Windows and macOS: the macOS sandbox profile, asking before every
// command without a sandbox, updates from the release page, how you reach her, Tailscale, the
// admin flags' status report, and doctor's plain words.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { LinkedToolRegistry } from '../src/companions.ts';
import { runDoctor } from '../src/doctor.ts';
import { accessInfo, adminHint, agentInstallHint, localVoiceMissing, systemName } from '../src/platform.ts';
import { createSaraServer } from '../src/server.ts';
import { folderBytes, humanBytes, statusReport } from '../src/status.ts';
import { findTailscale, onPath, parseTailscaleStatus, tailscaleStatus } from '../src/tailscale.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { commandPath, detectSandbox, noSandboxNote, runCommand, sbplString, seatbeltProfile, windowsShell } from '../src/tools/sandbox.ts';
import type { Tool } from '../src/tools/types.ts';
import { compareVersions, DOWNLOAD_PAGE, Updater } from '../src/updates.ts';
import { createBackup, inspectBackup, restoreBackup } from '../src/backup.ts';
import { call as toolCall, makeApp, ROOT, tempDir, text } from './helpers.ts';

// ---- macOS sandbox profile ----

test('seatbelt: reads allowed broadly, Sara data and secrets hidden, writes only in workspace and run temp', () => {
  const p = seatbeltProfile({ workspace: '/Users/o/Sara/workspaces/main', tmp: '/private/var/folders/x/sara-run-1', dataDir: '/Users/o/Sara', home: '/Users/o' }, false);
  const lines = p.split('\n');
  assert.equal(lines[0], '(version 1)');
  assert.equal(lines[1], '(deny default)', 'everything not allowed is refused');
  const readAll = lines.indexOf('(allow file-read*)');
  const hide = lines.findIndex((l) => l.startsWith('(deny file-read* file-write*'));
  const write = lines.findIndex((l) => l.startsWith('(allow file-read* file-write*'));
  assert.ok(readAll > 0 && hide > readAll && write > hide, 'later rules win: read all, then hide, then the workspace again');
  // The whole home folder is hidden (documents, keys, mail), not only a list of secret folders.
  for (const d of ['/Users/o/Sara', '/Users/o']) assert.ok(lines[hide].includes(`(subpath "${d}")`), `${d} hidden`);
  for (const d of ['/Users/o/Sara/workspaces/main', '/private/var/folders/x/sara-run-1']) assert.ok(lines[write].includes(`(subpath "${d}")`), `${d} writable`);
  assert.ok(!lines.some((l) => /^\(allow file-write\* \(subpath "\/(Users|usr|System)/.test(l)), 'no other folder is writable');
  assert.ok(!p.includes('(allow network*)'), 'network off: no network');
  assert.match(p, /mDNSResponder/, 'only the name lookup socket');
  // M6: a short list of system services, never LaunchServices, Apple Events, the pasteboard or the keychain.
  assert.ok(!lines.includes('(allow mach-lookup)'), 'not every Mach service');
  const mach = lines.find((l) => l.startsWith('(allow mach-lookup '))!;
  assert.match(mach, /com\.apple\.system\.opendirectoryd\.libinfo/);
  assert.match(mach, /trustd/);
  assert.doesNotMatch(mach, /launchservicesd|appleevents|pasteboard|securityd|coreservices/);
  // Backup drives, everyone's home folders and the per-user temp folders are hidden; this run's temp comes back.
  for (const d of ['/Volumes', '/Users', '/var/folders']) assert.ok(lines[hide].includes(`(subpath "${d}")`), `${d} hidden`);
  const on = seatbeltProfile({ workspace: '/w', tmp: '/t', home: '/Users/o' }, true);
  assert.ok(on.split('\n').includes('(allow network*)'), 'network on');
  assert.ok(!on.includes('(subpath "/Users/o/Sara")'), 'no data folder given: nothing extra hidden');
});

test('seatbelt: folders above the workspace can be looked up (git needs it), never listed or read', () => {
  const p = seatbeltProfile({ workspace: '/Users/o/Library/Application Support/Sara/workspaces/main', tmp: '/private/var/folders/x/T/sara-run-1', dataDir: '/Users/o/Library/Application Support/Sara', home: '/Users/o' }, false);
  const lines = p.split('\n');
  const meta = lines.findIndex((l) => l.startsWith('(allow file-read-metadata '));
  const hide = lines.findIndex((l) => l.startsWith('(deny file-read* file-write*'));
  assert.ok(meta > hide, 'after the rule that hides the data folder');
  for (const d of ['/Users/o/Library/Application Support/Sara', '/Users/o/Library/Application Support/Sara/workspaces']) {
    assert.ok(lines[meta].includes(`(literal "${d}")`), `${d}: metadata only`);
    assert.ok(!lines[meta].includes(`(subpath "${d}")`), `${d}: not its contents`);
  }
  assert.ok(!/\(allow file-read\* [^\n]*\(literal "\/Users\/o\/Library\/Application Support\/Sara"\)/.test(p), 'the data folder itself is never readable (listing)');
  assert.ok(!p.includes('xcrun_db'), "Apple's tool cache stays unwritable (a planted cache could redirect the owner's tools)");
});

test('backups leave out the Mac service folder; a restore keeps it, the logs and the backups in place', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const data = join(dir, 'data');
  mkdirSync(join(data, 'service'), { recursive: true });
  mkdirSync(join(data, 'logs'), { recursive: true });
  writeFileSync(join(data, 'service', 'server.env'), 'SARA_PORT=7860\n');
  writeFileSync(join(data, 'service', 'stopped'), '');
  writeFileSync(join(data, 'settings.json'), '{"ownerName":"A"}');
  const file = join(dir, 'b.tar.gz');
  createBackup(data, file, { saraVersion: '0.46.0' });
  const names = inspectBackup(file).entries.map((e) => e.path);
  assert.ok(names.includes('settings.json'));
  assert.ok(!names.some((n) => n.startsWith('service/')), 'no pid files or stop switch in a backup');
  writeFileSync(join(data, 'service', 'server.env'), 'SARA_PORT=7999\n');
  writeFileSync(join(data, 'logs', 'service.log'), 'x');
  writeFileSync(join(data, 'settings.json'), '{"ownerName":"B"}');
  restoreBackup(file, data);
  assert.equal(readFileSync(join(data, 'service', 'server.env'), 'utf8'), 'SARA_PORT=7999\n', "this Mac's settings stay");
  assert.ok(existsSync(join(data, 'logs', 'service.log')), 'logs stay');
  assert.match(readFileSync(join(data, 'settings.json'), 'utf8'), /"A"/, 'her data is restored');
});

test('seatbelt: paths are quoted safely; extra folders read-only unless asked', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\n(allow default)'), /line breaks/);
  const p = seatbeltProfile({ workspace: '/w"x', tmp: '/t', home: '/h', binds: [{ src: '/opt/agents', dest: '/opt/agents' }, { src: '/h/agent-home', dest: '/h/agent-home', rw: true }] }, false);
  assert.ok(p.includes('(subpath "/w\\"x")'), 'a quote in a folder name cannot end the string');
  assert.match(p, /\(allow file-read\* \(subpath "\/opt\/agents"\)\)/);
  assert.match(p, /\(allow file-read\* file-write\* [^\n]*\(subpath "\/h\/agent-home"\)/);
  assert.ok(!/\(allow file-read\* file-write\* [^\n]*\/opt\/agents/.test(p));
});

test('sandbox: what each system uses, in plain words', () => {
  assert.equal(noSandboxNote('win32'), 'No sandbox on Windows: she asks before every command.');
  assert.match(noSandboxNote('darwin'), /asks before every command/);
  assert.equal(commandPath('darwin', '/Applications/Sara.app/node/bin/node').split(':')[0], '/Applications/Sara.app/node/bin', "Sara's own Node first");
  assert.ok(commandPath('darwin').includes('/opt/homebrew/bin'));
  const git = windowsShell({ ProgramFiles: 'C:\\Program Files' }, (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual([git.file, git.sh, git.args('ls')], ['C:\\Program Files\\Git\\bin\\bash.exe', true, ['-c', 'ls']]);
  const cmd = windowsShell({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, () => false);
  assert.deepEqual([cmd.file, cmd.sh, cmd.args('dir')], ['C:\\Windows\\system32\\cmd.exe', false, ['/d', '/s', '/c', 'dir']]);
  const none = detectSandbox('none');
  assert.equal(none.mode, 'none');
  assert.match(none.detail, /asks before every command/);
  if (process.platform === 'win32') {
    const auto = detectSandbox('auto');
    assert.equal(auto.mode, 'none');
    assert.match(auto.detail, /No sandbox on Windows: she asks before every command/);
    assert.throws(() => detectSandbox('bwrap'), /no command sandbox on Windows/, 'a required sandbox is never silently skipped');
  }
});

test('runCommand without a sandbox: runs in the workspace with its own temp folder, removed afterwards', async (t) => {
  if (process.platform === 'linux') return t.skip('Linux keeps its own behaviour (covered by the sandbox tests)');
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const sh = process.platform === 'win32' ? windowsShell() : { sh: true };
  const cmd = sh.sh ? 'echo x > "$TMPDIR/probe"; echo "tmp:$(ls -A "$TMPDIR" | tr "\\n" " ")"; echo "dir:$(cd "$TMPDIR" && (pwd -W 2>/dev/null || pwd))"; echo hi > made.txt; echo SECRET=$SARA_MASTER_KEY' : 'echo x> "%TMPDIR%\\probe" & for /f %f in (\'dir /b "%TMPDIR%"\') do @echo tmp:%f & echo dir:%TMPDIR% & echo hi> made.txt & echo SECRET=%SARA_MASTER_KEY%';
  process.env.SARA_MASTER_KEY = 'should-not-leak';
  t.after(() => delete process.env.SARA_MASTER_KEY);
  const r = await runCommand(cmd, ws, { mode: 'none', network: true, detail: '' }, { timeoutMs: 30_000, signal: new AbortController().signal });
  const runDir = /dir:(.+)/.exec(r.output)?.[1]?.trim() ?? '';
  assert.match(runDir, /sara-run-/, r.output);
  assert.ok(!existsSync(runDir), 'removed after the run');
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(readFileSync(join(ws, 'made.txt'), 'utf8').trim(), 'hi');
  assert.equal(/tmp:(.*)/.exec(r.output)?.[1]?.trim(), 'probe', 'its own, empty temp folder (Git Bash shows it as /tmp)');
  assert.doesNotMatch(r.output, /should-not-leak/, "Sara's own environment never reaches commands");
});

// ---- asking before every command ----

const fakeCommandTool = (defaultPermission: 'auto' | 'ask'): Tool => ({ spec: { name: 'runner', description: '', parameters: { type: 'object', properties: {} } }, defaultPermission, runsCommands: true, summarize: () => '', run: async () => '' });

test('no sandbox: command tools ask first by default; an explicit choice still wins; others unchanged', () => {
  const reg = new ToolRegistry();
  reg.add(fakeCommandTool('auto'));
  assert.equal(reg.permission('runner', undefined), 'auto', 'with a sandbox: its own default');
  assert.equal(reg.permission('shell', undefined), 'ask');
  reg.unsandboxed = true;
  assert.equal(reg.permission('runner', undefined), 'ask', 'without one: asks');
  assert.equal(reg.permission('shell', undefined), 'ask');
  assert.equal(reg.permission('read_file', undefined), 'auto', 'tools that run no commands keep their default');
  assert.equal(reg.permission('runner', { runner: 'auto' }), 'auto', 'the owner may still choose Allowed');
  assert.equal(reg.permission('shell', { shell: 'never' }), 'never');
  const linked = new LinkedToolRegistry(reg);
  linked.add(fakeCommandTool('auto'));
  assert.equal(linked.unsandboxed, true, "other companions follow the server's sandbox");
  assert.equal(linked.permission('runner', undefined), 'ask');
});

async function drain(gen: AsyncGenerator<ChatEvent>, onApproval: (ev: Extract<ChatEvent, { type: 'approval' }>) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval(ev);
  }
  return out;
}

test('no sandbox: a shell command from the model waits for the owner (approved runs, denied does not)', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-26T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.tools.unsandboxed = true;
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  const conv = app.store.createConversation();
  app.script.push([toolCall('s1', 'shell', { command: 'echo approved-run' })], text('Ran it.'), [toolCall('s2', 'shell', { command: 'echo second' })], text('Okay.'));
  let asked = 0;
  const first = await drain(runTurn(app, conv.id, 'say hi in the shell'), (ev) => {
    asked++;
    assert.equal(ev.name, 'shell');
    app.approvals.decide(ev.approvalId, true);
  });
  assert.equal(asked, 1, 'asked before the command');
  const r1 = first.find((e) => e.type === 'tool_result');
  assert.equal(r1?.type === 'tool_result' && r1.status, 'ok');
  const second = await drain(runTurn(app, conv.id, 'again'), (ev) => app.approvals.decide(ev.approvalId, false));
  const r2 = second.find((e) => e.type === 'tool_result');
  assert.equal(r2?.type === 'tool_result' && r2.status, 'denied');
});

// ---- server routes: access, tools note, updates from the release page ----

const { dir: sdir, cleanup: scleanup } = tempDir();
const clock = { now: new Date('2026-10-26T15:00:00Z') };
const sapp = makeApp(sdir, clock);
sapp.tools.unsandboxed = true;
const auth = new OwnerAuth(sdir, () => clock.now);
const token = auth.newToken!;
let release: { status: number; body: unknown } | 'down' = { status: 404, body: { message: 'Not Found' } };
const fetched: string[] = [];
const stubFetch = (async (url: string | URL | Request) => {
  fetched.push(String(url));
  if (release === 'down') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(release.body), { status: release.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const server = createSaraServer({ app: sapp, auth, webDir: join(ROOT, 'web'), updaterPlatform: 'win32', updaterFetch: stubFetch, info: { version: '0.46.0', revision: null, startedAt: clock.now.toISOString() } } as never);
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  sapp.store.close();
  scleanup();
});
const api = async (path: string, body?: unknown, signedIn = true): Promise<Response> => {
  const go = () => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(signedIn ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return go().catch((err: Error & { cause?: { code?: string } }) => (err.cause?.code === 'ECONNRESET' ? go() : Promise.reject(err)));
};

test('access: the installer\'s choice and address, with a QR code; owner only', async (t) => {
  const saved = { a: process.env.SARA_ACCESS, u: process.env.SARA_PUBLIC_URL };
  t.after(() => {
    for (const [k, v] of [['SARA_ACCESS', saved.a], ['SARA_PUBLIC_URL', saved.u]] as const) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  delete process.env.SARA_ACCESS;
  delete process.env.SARA_PUBLIC_URL;
  const none = await (await api('/api/access')).json();
  assert.deepEqual([none.mode, none.url, none.qr], [null, null, undefined]);
  assert.match(none.label, /Not set up by an installer/);
  process.env.SARA_ACCESS = 'tailscale';
  process.env.SARA_PUBLIC_URL = 'https://box.tailnet-1234.ts.net/';
  const ts = await (await api('/api/access')).json();
  assert.deepEqual([ts.mode, ts.label, ts.url, ts.warning], ['tailscale', 'Tailscale (your private network)', 'https://box.tailnet-1234.ts.net', undefined]);
  assert.match(ts.qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(ts.qr.split(',')[1], 'base64').toString('utf8'), /<svg/);
  assert.equal((await api('/api/access', undefined, false)).status, 401, 'signed-out visitors get nothing');
  const s = await (await api('/api/settings')).json();
  assert.equal(s.access.mode, 'tailscale', 'also in the settings block (read-only)');
});

test('tools page: says plainly that there is no sandbox and she asks first', async () => {
  const r = await (await api('/api/tools')).json();
  assert.equal(r.sandbox.mode, 'none');
  assert.match(r.sandbox.note, /asks before every command/);
  assert.equal(r.tools.find((x: { name: string }) => x.name === 'shell').permission, 'ask');
});

test('updates on Windows/macOS: a private or missing release page is a plain message, not a crash', async () => {
  const view = await (await api('/api/update')).json();
  assert.deepEqual([view.available, view.how, view.version], [true, 'release', '0.46.0']);
  for (const r of [{ status: 404, body: { message: 'Not Found' } }, { status: 401, body: {} }, 'down' as const, { status: 200, body: { message: 'odd' } }]) {
    release = r;
    const res = await api('/api/update', { action: 'check' });
    assert.equal(res.status, 200);
    const st = (await res.json()).status;
    assert.equal(st.state, 'failed');
    assert.match(st.message, /^Couldn't check for updates/);
    assert.equal(st.downloadUrl, DOWNLOAD_PAGE);
  }
  assert.ok(fetched.every((u) => u === 'https://api.github.com/repos/farena-ai/sara/releases/latest'));
});

test('updates on Windows/macOS: newer release → the download page; Update answers with the link', async () => {
  release = { status: 200, body: { tag_name: 'v0.47.0', html_url: 'https://github.com/farena-ai/sara/releases/tag/v0.47.0', body: '## What\'s new\n- Works with other bots\n- Faster start' } };
  const st = (await (await api('/api/update', { action: 'check' })).json()).status;
  assert.deepEqual([st.state, st.latest, st.downloadUrl], ['available', '0.47.0', 'https://github.com/farena-ai/sara/releases/tag/v0.47.0']);
  assert.deepEqual(st.changes, ["What's new", 'Works with other bots', 'Faster start']);
  const up = (await (await api('/api/update', { action: 'update' })).json()).status;
  assert.match(up.message, /^Download Sara 0\.47\.0 from https:\/\/github\.com\/farena-ai\/sara\/releases\/tag\/v0\.47\.0/);
  assert.ok(!existsSync(join(sdir, 'update-request')), 'no request file for a root helper');
  release = { status: 200, body: { tag_name: 'v0.46.0', html_url: 'https://evil.example/x' } };
  const cur = (await (await api('/api/update', { action: 'check' })).json()).status;
  assert.deepEqual([cur.state, cur.downloadUrl], ['current', DOWNLOAD_PAGE], 'only GitHub links are passed on');
});

test('updates: versions compare by number; Linux keeps the root helper', () => {
  assert.ok(compareVersions('v0.46.10', '0.46.9') > 0);
  assert.equal(compareVersions('0.46.0', 'v0.46.0'), 0);
  assert.ok(compareVersions('0.45.3', '0.46.0') < 0);
  assert.equal(new Updater({ dataDir: sdir, platform: 'linux', unitDir: join(sdir, 'none') }).how, 'helper');
  assert.equal(new Updater({ dataDir: sdir, platform: 'darwin' }).how, 'release');
  assert.throws(() => new Updater({ dataDir: sdir, platform: 'linux', unitDir: join(sdir, 'none') }).request('check'), /sudo sara update/);
});

// ---- Tailscale ----

test('tailscale: reads its status JSON (name, state, addresses)', () => {
  const fixture = readFileSync(join(ROOT, 'test', 'fixtures', 'tailscale-status.json'), 'utf8');
  const s = parseTailscaleStatus(fixture, 'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.deepEqual([s.installed, s.running, s.state, s.dnsName, s.url, s.error], [true, true, 'Running', 'box.tailnet-1234.ts.net', 'https://box.tailnet-1234.ts.net', undefined]);
  assert.deepEqual(s.ips, ['100.101.102.103', 'fd7a:115c:a1e0::1']);
  const out = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }));
  assert.deepEqual([out.running, out.dnsName, out.url], [false, null, null]);
  assert.match(out.error!, /not signed in/);
  assert.match(parseTailscaleStatus('not json').error!, /couldn't be read/);
});

test('tailscale: found where each system installs it, else on the PATH', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);
  assert.equal(findTailscale({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', PATH: '' }, exists: has('C:\\Program Files\\Tailscale\\tailscale.exe') }), 'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.equal(findTailscale({ platform: 'win32', env: { PATH: 'C:\\Tools;D:\\bin\\', PATHEXT: '.COM;.EXE' }, exists: has('D:\\bin\\tailscale.exe') }), 'D:\\bin\\tailscale.exe');
  assert.equal(findTailscale({ platform: 'darwin', env: { PATH: '/usr/bin' }, exists: has('/Applications/Tailscale.app/Contents/MacOS/Tailscale') }), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(findTailscale({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, exists: has('/usr/bin/tailscale') }), '/usr/bin/tailscale');
  assert.equal(findTailscale({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has() }), null);
  assert.equal(onPath('git', { platform: 'linux', env: { PATH: '/a/:/b' }, exists: has('/b/git') }), '/b/git');
  const missing = tailscaleStatus({ platform: 'linux', env: { PATH: '' }, exists: has() });
  assert.deepEqual([missing.installed, missing.running], [false, false]);
  assert.match(missing.error!, /not installed/);
  const stopped = tailscaleStatus({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/tailscale'), run: () => ({ status: 1, stdout: JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'box.t.ts.net.' } }), stderr: '' }) });
  assert.deepEqual([stopped.installed, stopped.running, stopped.dnsName], [true, false, 'box.t.ts.net']);
  const dead = tailscaleStatus({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/tailscale'), run: () => ({ status: 1, stdout: '', stderr: 'failed to connect to local tailscaled\n' }) });
  assert.match(dead.error!, /didn't answer \(failed to connect to local tailscaled\)/);
});

// ---- platform words, access, status ----

test('platform: admin hints and voice words for each system', () => {
  assert.equal(systemName('win32'), 'Windows');
  assert.equal(adminHint('reset-token', { platform: 'linux', env: {}, exists: (p) => p === '/usr/local/bin/sara' }), 'sudo sara reset-token');
  assert.equal(adminHint('reset-token', { platform: 'win32', env: { SARA_INSTALLED: '1' } }), 'sara reset-token');
  assert.equal(adminHint('doctor', { platform: 'darwin', env: { SARA_INSTALLED: '1' } }), 'sara doctor', 'the Mac app runs her as the user: no sudo');
  assert.match(adminHint('stop', { platform: 'darwin', env: { SARA_INSTALLED: '1' } }), /^sara stop/);
  assert.equal(adminHint('reset-token', { platform: 'win32', env: {} }), 'node src/main.ts --reset-token');
  assert.equal(adminHint('reset-token', { platform: 'linux', env: { SARA_DATA: '/data' }, exists: () => false }), 'docker compose exec sara node src/main.ts --reset-token');
  // 2.59 (Phase 126 part C): local voice installs on Windows from Settings.
  assert.match(localVoiceMissing('win32'), /not installed yet \(Settings → Voice → Install/);
  assert.match(localVoiceMissing('darwin'), /not installed yet \(Settings → Voice → Install/);
  assert.match(localVoiceMissing('linux'), /install-voice\.sh/);
  assert.match(agentInstallHint('win32'), /PATH/);
});

test('access: only known modes and real web addresses; plain HTTP on the home network warns', () => {
  assert.equal(accessInfo({ SARA_ACCESS: 'everywhere' }).mode, null);
  assert.equal(accessInfo({ SARA_ACCESS: 'domain', SARA_PUBLIC_URL: 'javascript:alert(1)' }).url, null);
  assert.equal(accessInfo({ SARA_ACCESS: 'domain', SARA_PUBLIC_URL: 'https://user:pw@sara.example.com' }).url, null, 'no passwords in addresses');
  assert.equal(accessInfo({ SARA_ACCESS: 'domain', SARA_PUBLIC_URL: 'https://sara.example.com' }).label, 'Your own web address');
  const lan = accessInfo({ SARA_ACCESS: 'LAN', SARA_PUBLIC_URL: 'http://192.168.1.20:7860' });
  assert.deepEqual([lan.mode, lan.url], ['lan', 'http://192.168.1.20:7860']);
  assert.match(lan.warning!, /no HTTPS/);
  assert.equal(accessInfo({ SARA_ACCESS: 'local', SARA_PUBLIC_URL: 'http://127.0.0.1:7860' }).warning, undefined);
});

test('status: version, running, data folder size, last backup', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'backups'));
  writeFileSync(join(dir, 'sara.db'), Buffer.alloc(2048));
  writeFileSync(join(dir, 'backups', 'sara-2026-10-26-10-00-00-auto.tar.gz'), Buffer.alloc(1024));
  assert.equal(folderBytes(dir), 3072);
  assert.equal(humanBytes(3072), '3.0 KB');
  assert.equal(humanBytes(5 * 1024 ** 3), '5.0 GB');
  const out = statusReport({ version: '0.46.0', dataDir: dir, port: 7860, running: false, now: new Date(Date.now() + 2 * 3600_000), access: accessInfo({ SARA_ACCESS: 'local', SARA_PUBLIC_URL: 'http://127.0.0.1:7860' }) });
  const lines = out.split('\n');
  assert.equal(lines[0], 'Sara 0.46.0');
  assert.match(out, /Running: +no \(port 7860\)/);
  assert.ok(out.includes(`Data folder:  ${dir} (3.0 KB)`));
  assert.match(out, /Last backup: +sara-2026-10-26-10-00-00-auto\.tar\.gz \(2 h ago\)/);
  assert.match(out, /Reach her at: Just this computer — http:\/\/127\.0\.0\.1:7860/);
  assert.match(statusReport({ version: '1', dataDir: join(tmpdir(), 'sara-not-there-46'), port: 1, running: true }), /not created yet[\s\S]*Last backup: +none yet/);
});

test('doctor: honest about no sandbox and about local voice on Windows/macOS', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-26T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const tools = new ToolRegistry();
  tools.unsandboxed = true;
  const sandbox = { mode: 'none' as const, network: true, detail: 'x' };
  const win = await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, sandbox, tools, platform: 'win32' });
  const sb = win.find((c) => c.name === 'Tool sandbox')!;
  assert.deepEqual([sb.status, sb.detail], ['warn', 'No execution isolation. Commands run directly on this computer.']);
  const voice = win.find((c) => c.name === 'Voice (optional)')!;
  assert.match(voice.detail, /not installed yet \(Settings → Voice → Install/);
  assert.doesNotMatch(voice.detail, /install-voice/);
  app.settings.update({ toolPermissions: { shell: 'auto' } });
  const risky = (await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, sandbox, tools, platform: 'win32' })).find((c) => c.name === 'Tool sandbox')!;
  assert.equal(risky.status, 'warn');
  assert.equal(risky.detail, 'No execution isolation. Commands run directly on this computer.');
  const approvals = (await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, sandbox, tools, platform: 'win32' })).find((c) => c.name === 'Command approvals')!;
  assert.equal(approvals.status, 'warn');
  assert.match(approvals.detail, /shell.*run without asking/);
  const mac = (await runDoctor({ dataDir: dir, settings: app.settings, vault: app.vault, sandbox: { mode: 'seatbelt', network: true, detail: 'macOS sandbox' }, tools, platform: 'darwin' })).find((c) => c.name === 'Voice (optional)')!;
  assert.match(mac.detail, /not installed yet \(Settings → Voice → Install/);
});

test('runCommand: a program left running in the background (holding the output open) does not hang the tool', async () => {
  const ws = join(tmpdir(), `sara-bg-${process.pid}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  // node keeps the inherited stdout open for 20 s after the shell itself has ended.
  const script = join(ws, 'linger.cjs');
  writeFileSync(script, 'setTimeout(() => {}, 20000);');
  const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
  const started = Date.now();
  const r = await runCommand(`echo started; ${node} linger.cjs &`, ws, detectSandbox('none'), { timeoutMs: 15_000, signal: new AbortController().signal });
  assert.ok(Date.now() - started < 10_000, `returned after ${Date.now() - started} ms`);
  assert.match(r.output, /started/);
});
