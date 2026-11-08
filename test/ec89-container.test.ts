// EC8 (docs/ops/EC89_DESIGN.md): the container sandbox. Engine detection and the backend choice
// are pure over an injected probe, so every OS is checked here; command construction is an argv
// array spawned without a shell (Docker and Podman are not installed on the build PC: a fake
// runner stands in, and real-container acceptance on Linux is an owner check).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContainerRefused, containerRunArgv, detectEngine, egressPlan, selectBackend, type EngineInfo, type Probe } from '../src/container.ts';
import type { SandboxInfo } from '../src/tools/sandbox.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { setEgressSource } from '../src/egress-run.ts';
import { parseAllowlist } from '../src/egress.ts';
import { runCommand } from '../src/tools/sandbox.ts';

const IMAGE = 'node:24-slim';
/** A fake engine CLI: answers by "exe args…" prefix. */
function fakeProbe(answers: Record<string, { status: number; stdout?: string }>): Probe & { calls: string[] } {
  const calls: string[] = [];
  const p = ((file: string, args: string[]) => {
    const k = [file, ...args].join(' ');
    calls.push(k);
    const hit = Object.entries(answers).find(([pre]) => k.startsWith(pre));
    return hit ? { status: hit[1].status, stdout: hit[1].stdout ?? '' } : { status: null, stdout: '' };
  }) as Probe & { calls: string[] };
  p.calls = calls;
  return p;
}

const podmanOk = {
  'podman version': { status: 0, stdout: '5.2.1\n' },
  'podman info': { status: 0, stdout: 'true\n' },
  [`podman image inspect --format {{.Id}} ${IMAGE}`]: { status: 0, stdout: 'abc\n' },
};
const dockerOk = {
  'docker version': { status: 0, stdout: '27.1.0\n' },
  'docker info': { status: 0, stdout: '["name=seccomp,profile=builtin"]\n' },
  [`docker image inspect --format {{.Id}} ${IMAGE}`]: { status: 0, stdout: 'def\n' },
};

test('engine detection: rootless Podman first, then Docker; a missing image or a stopped daemon is not usable', () => {
  let r = detectEngine({ image: IMAGE, probe: fakeProbe({ ...podmanOk, ...dockerOk }) });
  assert.deepEqual(r.found && [r.found.engine, r.found.rootless, r.found.version, r.found.imagePresent], ['podman', true, '5.2.1', true]);
  r = detectEngine({ image: IMAGE, prefer: 'docker', probe: fakeProbe({ ...podmanOk, ...dockerOk }) });
  assert.deepEqual(r.found && [r.found.engine, r.found.rootless], ['docker', false]);
  r = detectEngine({ image: IMAGE, probe: fakeProbe(dockerOk) });
  assert.equal(r.found?.engine, 'docker');
  assert.equal(r.tried[0].engine, 'podman');
  assert.equal(r.tried[0].ok, false);
  r = detectEngine({ image: IMAGE, probe: fakeProbe({ 'docker version': { status: 1 } }) });
  assert.equal(r.found, undefined, 'the CLI is there but the daemon does not answer');
  r = detectEngine({ image: IMAGE, probe: fakeProbe({ 'docker version': { status: 0, stdout: '27\n' }, 'docker info': { status: 0, stdout: '["name=rootless"]' }, 'docker image inspect': { status: 1 } }) });
  assert.equal(r.found, undefined);
  assert.match(r.tried.find((x) => x.engine === 'docker')!.why!, /node:24-slim/, 'says which image is missing');
  const rootless = detectEngine({ image: IMAGE, probe: fakeProbe({ 'docker version': { status: 0, stdout: '27\n' }, 'docker info': { status: 0, stdout: '["name=rootless"]' }, 'docker image inspect': { status: 0 } }) });
  assert.equal(rootless.found?.rootless, true);
  assert.throws(() => detectEngine({ image: '--privileged', probe: fakeProbe({}) }), ContainerRefused, 'never probes with a flag as the image');
});

const engine: EngineInfo = { engine: 'podman', exe: 'podman', rootless: true, version: '5', image: IMAGE, imagePresent: true };
const bwrap: SandboxInfo = { mode: 'bwrap', network: true, detail: 'bubblewrap' };
const seatbelt: SandboxInfo = { mode: 'seatbelt', network: true, detail: 'macOS' };
const none: SandboxInfo = { mode: 'none', network: true, detail: 'none' };

test('backend choice: bubblewrap stays the Linux default; containers when chosen or when nothing else isolates', () => {
  const pick = (platform: NodeJS.Platform, native: SandboxInfo, pref: 'auto' | 'native' | 'container', e?: EngineInfo, required = false) => selectBackend({ platform, native, engine: e, pref, required });
  assert.equal(pick('linux', bwrap, 'auto', engine).mode, 'bwrap');
  assert.equal(pick('linux', bwrap, 'native', engine).mode, 'bwrap');
  assert.equal(pick('linux', bwrap, 'container', engine).mode, 'container');
  assert.equal(pick('linux', none, 'auto', engine).mode, 'container');
  assert.equal(pick('darwin', seatbelt, 'auto', engine).mode, 'seatbelt');
  assert.equal(pick('darwin', seatbelt, 'container', engine).mode, 'container');
  const win = pick('win32', none, 'auto', engine);
  assert.equal(win.mode, 'container');
  assert.deepEqual(win.container, { engine: 'podman', exe: 'podman', rootless: true, image: IMAGE });
  assert.match(win.detail, /Podman/);
  assert.equal(pick('win32', none, 'auto').mode, 'none');
  assert.equal(pick('win32', none, 'native', engine).mode, 'none', 'the owner may keep the Windows default');
  const fallback = pick('linux', bwrap, 'container');
  assert.equal(fallback.mode, 'bwrap');
  assert.match(fallback.detail, /no working Podman or Docker/i);
  assert.equal(fallback.refuse, undefined);
  // The policy pin: no engine → refused, never an unisolated run.
  const refused = pick('linux', bwrap, 'auto', undefined, true);
  assert.equal(refused.mode, 'none');
  assert.match(refused.refuse ?? '', /container sandbox/);
  assert.equal(pick('win32', none, 'native', engine, true).mode, 'container', 'the pin wins over the owner\'s choice');
  assert.equal(pick('win32', none, 'auto', { ...engine, imagePresent: false }).mode, 'none');
});

test('container command: an argv array, the command one argument inside, hardening flags, env by name only', () => {
  const evil = `x'; rm -rf / #"$(touch /tmp/pwned)\`id\``;
  const argv = containerRunArgv({ name: 'sara-abc', image: IMAGE, workspace: 'C:\\Users\\me\\ws one', mounts: [{ src: '/home/me/node_modules', dest: '/workspace/node_modules' }], network: 'none', env: ['HOME', 'GIT_AUTHOR_NAME'], user: 'keep-id', argv: ['/bin/sh', '-c', evil] });
  const img = argv.indexOf(IMAGE);
  assert.deepEqual(argv.slice(img + 1), ['/bin/sh', '-c', evil], 'the command is exactly one argument after the image');
  assert.equal(argv[0], 'run');
  for (const f of ['--rm', '--init', '--pull=never', '--read-only', '--userns=keep-id']) assert.ok(argv.includes(f), f);
  assert.deepEqual(argv.slice(argv.indexOf('--network'), argv.indexOf('--network') + 2), ['--network', 'none']);
  assert.deepEqual(argv.slice(argv.indexOf('--cap-drop'), argv.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.ok(argv.includes('no-new-privileges'));
  assert.ok(argv.includes('type=bind,source=C:\\Users\\me\\ws one,target=/workspace'));
  assert.ok(argv.includes('type=bind,source=/home/me/node_modules,target=/workspace/node_modules,readonly'), 'extra mounts are read-only unless rw');
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '-e'), ['HOME', 'GIT_AUTHOR_NAME'], 'names only: values travel in the CLI process environment');
  assert.ok(!argv.some((a) => /privileged|docker\.sock|podman\.sock/.test(a)));
  assert.ok(!argv.slice(0, img).some((a) => a.includes(evil)));
  // Open network: no --network flag (the engine's default). A named sidecar network: that name.
  assert.ok(!containerRunArgv({ name: 'sara-a', image: IMAGE, workspace: '/w', network: 'default', env: [], argv: ['true'] }).includes('--network'));
  const eg = containerRunArgv({ name: 'sara-a', image: IMAGE, workspace: '/w', network: 'sara-eg-a', env: [], user: '1000:1000', argv: ['true'] });
  assert.deepEqual(eg.slice(eg.indexOf('--network'), eg.indexOf('--network') + 2), ['--network', 'sara-eg-a']);
  assert.deepEqual(eg.slice(eg.indexOf('--user'), eg.indexOf('--user') + 2), ['--user', '1000:1000']);
  // Refused: anything that could become another flag, another mount option or another variable.
  const base = { name: 'sara-a', image: IMAGE, workspace: '/w', network: 'none', env: [] as string[], argv: ['true'] };
  for (const bad of [
    { image: '--privileged' },
    { image: 'node:24 --privileged' },
    { name: '--rm' },
    { name: 'other' },
    { workspace: '/w,readonly=false,source=/' },
    { workspace: 'relative/ws' },
    { workspace: '/w\nx' },
    { mounts: [{ src: '/x', dest: '/workspace/../etc' }] },
    { mounts: [{ src: '/x', dest: 'workspace' }] },
    { mounts: [{ src: '/var/run/docker.sock', dest: '/var/run/docker.sock' }] },
    { env: ['A=B'] },
    { env: ['1A'] },
    { network: 'host' },
    { network: 'container:other' },
    { argv: [] },
    { argv: ['a\0b'] },
    { user: 'root' },
  ])
    assert.throws(() => containerRunArgv({ ...base, ...bad } as Parameters<typeof containerRunArgv>[0]), ContainerRefused, JSON.stringify(bad));
});

test('egress sidecar plan: an internal network, the proxy as its only way out, cleanup of both', () => {
  const p = egressPlan({ id: 'abc123', image: IMAGE, proxyFile: 'C:\\sara\\src\\egress.ts' });
  assert.equal(p.network, 'sara-eg-abc123');
  assert.equal(p.proxyName, 'sara-eg-abc123-proxy');
  assert.equal(p.proxyUrl, 'http://sara-eg-abc123-proxy:3128');
  assert.deepEqual(p.create, ['network', 'create', '--internal', 'sara-eg-abc123']);
  assert.equal(p.sidecar[0], 'run');
  assert.ok(p.sidecar.includes('-d'));
  assert.ok(p.sidecar.includes('--read-only'));
  assert.ok(p.sidecar.includes('type=bind,source=C:\\sara\\src\\egress.ts,target=/sara/egress.ts,readonly'));
  assert.deepEqual(p.sidecar.slice(p.sidecar.indexOf(IMAGE)), [IMAGE, 'node', '/sara/egress.ts', 'serve']);
  assert.deepEqual(p.sidecar.filter((a, i) => p.sidecar[i - 1] === '-e'), ['SARA_EGRESS_ALLOW', 'SARA_EGRESS_PORT', 'SARA_EGRESS_SECRETS']);
  assert.deepEqual(p.connect, ['network', 'connect', 'sara-eg-abc123', 'sara-eg-abc123-proxy']);
  assert.deepEqual(p.logs, ['logs', 'sara-eg-abc123-proxy']);
  assert.deepEqual(p.cleanup, [['rm', '-f', 'sara-eg-abc123-proxy'], ['network', 'rm', 'sara-eg-abc123']]);
  assert.throws(() => egressPlan({ id: 'A;B', image: IMAGE, proxyFile: '/x' }), ContainerRefused);
  // Podman: both networks at start, no connect step, the proxy's address read back for --add-host.
  const q = egressPlan({ id: 'abc123', image: IMAGE, proxyFile: '/sara/src/egress.ts', engine: 'podman' });
  assert.deepEqual(q.sidecar.filter((a, i) => q.sidecar[i - 1] === '--network'), ['sara-eg-abc123', 'podman']);
  assert.deepEqual(q.connect, []);
  assert.deepEqual(q.address, ['inspect', '--format', '{{(index .NetworkSettings.Networks "sara-eg-abc123").IPAddress}}', 'sara-eg-abc123-proxy']);
  assert.equal(p.address, undefined, 'Docker keeps network connect and its DNS');
  const argv = containerRunArgv({ name: 'sara-x', image: IMAGE, workspace: '/w', network: 'sara-eg-abc123', env: [], hosts: ['sara-eg-abc123-proxy:10.89.0.2'], argv: ['true'] });
  assert.deepEqual(argv.slice(argv.indexOf('--add-host'), argv.indexOf('--add-host') + 2), ['--add-host', 'sara-eg-abc123-proxy:10.89.0.2']);
  assert.throws(() => containerRunArgv({ name: 'sara-x', image: IMAGE, workspace: '/w', network: 'none', env: [], hosts: ['evil.com:1.2.3.4 --privileged'], argv: ['true'] }), ContainerRefused);
});

// ---- running through the engine (a fake CLI) ----

const FAKE = join(import.meta.dirname, 'fixtures', 'ec89', 'fake-engine.mjs');
function fakeSandbox(t: { after: (fn: () => void) => void }, network: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ec89-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'engine.log');
  writeFileSync(log, '');
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const sb: SandboxInfo = { mode: 'container', network, detail: 'fake', container: { engine: 'podman', exe: process.execPath, pre: [FAKE, log], rootless: true, image: IMAGE } };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; envFile?: string; leaked: string[] });
  return { dir, ws, sb, calls };
}

test('a command runs in the container: the text is one argument, values only in the env file, no host shell', async (t) => {
  const f = fakeSandbox(t, false);
  process.env.SARA_TEST_SECRET_KEY = 'sk-should-never-leave';
  t.after(() => delete process.env.SARA_TEST_SECRET_KEY);
  const cmd = `echo "hi $HOME"; rm -r "$X" ; $(touch /pwned) \`id\` | tee a & b`;
  const r = await runCommand(cmd, f.ws, f.sb, { timeoutMs: 20_000, signal: new AbortController().signal, gitName: 'Sara', env: { EXTRA: 'one' } });
  assert.equal(r.exitCode, 0, r.output);
  const [call] = f.calls();
  const img = call.args.indexOf(IMAGE);
  assert.equal(call.args[img + 1], '/bin/sh');
  assert.equal(call.args[img + 2], '-c');
  assert.equal(call.args.length, img + 4, 'exactly one command argument');
  assert.ok(call.args[img + 3].endsWith(cmd));
  assert.deepEqual(call.args.slice(call.args.indexOf('--network'), call.args.indexOf('--network') + 2), ['--network', 'none']);
  assert.ok(call.args.includes(`type=bind,source=${f.ws},target=/workspace`));
  assert.ok(call.args.includes('--userns=keep-id'));
  assert.match(call.envFile!, /^HOME=\/workspace$/m);
  assert.match(call.envFile!, /^GIT_AUTHOR_NAME=Sara$/m);
  assert.match(call.envFile!, /^EXTRA=one$/m);
  assert.ok(!call.envFile!.includes('sk-should-never-leave'));
  assert.deepEqual(call.leaked, [], "Sara's own environment never reaches the engine CLI");
  assert.ok(!call.args.slice(0, img).some((a) => a.includes('=Sara') || a.includes('EXTRA')), 'no values in argv');
  // Network on (no allowlist): the engine's default network.
  const g = fakeSandbox(t, true);
  await runCommand('true', g.ws, g.sb, { timeoutMs: 20_000, signal: new AbortController().signal });
  assert.ok(!g.calls()[0].args.includes('--network'));
});

test('a stop kills the container by name, not just the CLI', async (t) => {
  const f = fakeSandbox(t, false);
  const ac = new AbortController();
  const p = runCommand('sleep-forever', f.ws, f.sb, { timeoutMs: 30_000, signal: ac.signal });
  for (let i = 0; i < 100 && !f.calls().length; i++) await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await p;
  for (let i = 0; i < 100 && !f.calls().some((c) => c.args[0] === 'kill'); i++) await new Promise((r) => setTimeout(r, 50));
  const name = f.calls()[0].args[f.calls()[0].args.indexOf('--name') + 1];
  assert.match(name, /^sara-[a-f0-9-]+$/);
  assert.ok(f.calls().some((c) => c.args[0] === 'kill' && c.args[1] === name));
});

test('egress allowlist in a container: internal network, proxy sidecar, refusals audited, all cleaned up', async (t) => {
  const f = fakeSandbox(t, true);
  const trail = new AuditTrail(f.dir, { key: () => 'k' });
  setAuditTrail(trail);
  setEgressSource(() => parseAllowlist(['registry.npmjs.org']));
  t.after(() => {
    setEgressSource(() => undefined);
    setAuditTrail(undefined);
  });
  const r = await runCommand('npm view left-pad', f.ws, f.sb, { timeoutMs: 20_000, signal: new AbortController().signal });
  assert.equal(r.exitCode, 0, r.output);
  const calls = f.calls().map((c) => c.args);
  const kinds = calls.filter((a) => a[0] !== 'logs').map((a) => (a[0] === 'run' ? (a.includes('-d') ? 'sidecar' : 'run') : a[0] === 'inspect' ? 'inspect' : a.slice(0, 2).join(' ')));
  // C1 (real rootless Podman 4.9, CNI): `network connect` fails on a slirp4netns container and internal
  // networks have no DNS, so Podman joins both networks at start and the run gets the proxy as --add-host.
  assert.deepEqual(kinds, ['network create', 'sidecar', 'inspect', 'run', 'rm -f', 'network rm']);
  const net = calls[0][3];
  assert.match(net, /^sara-eg-[a-f0-9]{12}$/);
  assert.deepEqual(calls[0], ['network', 'create', '--internal', net]);
  const run = f.calls().find((c) => c.args[0] === 'run' && !c.args.includes('-d'))!;
  assert.deepEqual(run.args.slice(run.args.indexOf('--network'), run.args.indexOf('--network') + 2), ['--network', net]);
  assert.deepEqual(run.args.slice(run.args.indexOf('--add-host'), run.args.indexOf('--add-host') + 2), ['--add-host', `${net}-proxy:10.89.0.2`]);
  const side = calls.find((a) => a[0] === 'run' && a.includes('-d'))!;
  assert.deepEqual(side.filter((a, i) => side[i - 1] === '--network'), [net, 'podman'], 'the sidecar starts on the internal network and the default one');
  assert.match(run.envFile!, new RegExp(`^HTTPS_PROXY=http://${net}-proxy:3128$`, 'm'));
  const rows = trail.list({ action: 'egress.refused' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, 'blocked.example.org:443');
  assert.equal(rows[0].outcome, 'refused');
});

test('a refused sandbox (pinned containers, none found) runs nothing', async () => {
  const r = await runCommand('echo should-not-run', tmpdir(), { mode: 'none', network: true, detail: 'x', refuse: 'Your admin requires the container sandbox.' }, { timeoutMs: 5000, signal: new AbortController().signal });
  assert.equal(r.exitCode, null);
  assert.equal(r.output, 'Your admin requires the container sandbox.');
});

test('plugin jobs on the container fence: npm allowed, the copy mounted, the program and args as argv', async (t) => {
  const { jobFenceFor, parsePlan, runJob } = await import('../src/plugins/exec-job.ts');
  const f = fakeSandbox(t, false);
  assert.equal(jobFenceFor(f.sb), 'container');
  assert.equal(jobFenceFor({ ...f.sb, container: undefined }), 'node-only');
  const src = join(f.dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'package.json'), '{"scripts":{"test":"node -e 1"}}');
  const plan = parsePlan({ program: 'npm', args: ['test', '--', `--grep=$(id)`] }, { programs: ['node', 'npm'], sources: ['data'], network: false }, 'container');
  const r = await runJob(plan, { sourceDir: src, cacheDir: join(f.dir, 'cache'), fence: 'container', container: f.sb.container!, signal: new AbortController().signal });
  assert.equal(r.exitCode, 0, `${r.stderr}${r.error ?? ''}`);
  assert.equal(r.isolated, true);
  assert.equal(r.egress, 'off');
  const call = f.calls().find((c) => c.args[0] === 'run')!;
  const img = call.args.indexOf(IMAGE);
  assert.deepEqual(call.args.slice(img + 1, img + 3), ['/bin/sh', '-c']);
  assert.deepEqual(call.args.slice(img + 4), ['sara-job', 'npm', 'test', '--', '--grep=$(id)']);
  assert.deepEqual(call.args.slice(call.args.indexOf('--network'), call.args.indexOf('--network') + 2), ['--network', 'none']);
  assert.ok(call.args.some((a) => /^type=bind,source=.*[\\/]ws,target=\/workspace$/.test(a)), 'the disposable copy, never the source folder');
  assert.ok(!call.args.some((a) => a.includes(`source=${src},`)));
  assert.match(call.envFile!, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:9$/m, 'no-network variables too');
  assert.equal(r.deleted, true);
});

test('with containers for commands, plugin processes, tool servers and coding agents keep the native sandbox', async () => {
  const { fenceFor } = await import('../src/plugins/runtime.ts');
  const { nativeOf } = await import('../src/tools/sandbox.ts');
  const sb = selectBackend({ platform: 'linux', native: bwrap, engine, pref: 'container' });
  assert.equal(sb.mode, 'container');
  assert.equal(nativeOf(sb).mode, 'bwrap');
  assert.equal(fenceFor(sb), 'bwrap', 'plugin host processes are still fenced by bubblewrap');
  assert.equal(nativeOf({ ...sb, network: false }).network, false, 'the caller\'s network choice is kept');
  assert.equal(nativeOf(none), none);
});
