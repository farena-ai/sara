// W2.1 installers that cannot fail: one preflight in every install path (Linux one-command install,
// install.sh, Raspberry Pi, Docker, Windows Setup, a plain `node src/main.ts`), each failure a plain
// fix-it card with the exact next step, plus the install matrix harness (scripts/install-matrix.ts).
// The shell parts run the real scripts under bash (git-bash on Windows) with PF_FAKE_* facts and a
// fake root (PF_ROOT): nothing needs root and nothing outside a temp folder is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { preflight, formatCards, preflightExit, portInUseCard, LIMITS, type PfFacts } from '../src/preflight.ts';
import { TARGETS, targetDockerfile, renderMatrix, parseHarnessLog, type MatrixRow } from '../scripts/install-matrix.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const fwd = (p: string) => p.replace(/\\/g, '/');
const GB = 1024 ** 3;

function findBash(): string | null {
  const c = process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
    : ['/bin/bash', '/usr/bin/bash'];
  for (const x of c) if (existsSync(x)) return x;
  return null;
}
const BASH = findBash();
const noBash = BASH ? false : 'bash not found';
const tmp = mkdtempSync(join(tmpdir(), 'sara-w2i-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const good: PfFacts = {
  platform: 'linux', arch: 'x64', osId: 'ubuntu', osVersion: '24.04', osName: 'Ubuntu 24.04 LTS', glibc: '2.39',
  freeBytes: 40 * GB, dataDir: '/var/lib/sara', totalMem: 8 * GB, port: 7860, portBusy: false,
  existing: 'none', writable: true, network: [{ host: 'registry.npmjs.org', ok: true }], docker: false,
};
const ids = (f: Partial<PfFacts>) => preflight({ ...good, ...f }).filter((c) => c.status !== 'ok').map((c) => `${c.id}:${c.status}`);

test('W2.1 preflight: a healthy machine passes every check, and every check is there', () => {
  const cards = preflight(good);
  assert.deepEqual(cards.map((c) => c.id).sort(), ['arch', 'disk', 'existing', 'network', 'os', 'permissions', 'ports', 'ram']);
  assert.ok(cards.every((c) => c.status === 'ok'), JSON.stringify(cards));
  assert.equal(preflightExit(cards), 0);
});

test('W2.1 preflight: each failure is a fix-it card with a title, a reason and the exact next step', () => {
  const bad = preflight({ ...good, freeBytes: 0.3 * GB, totalMem: 0.3 * GB, portBusy: true, arch: 'arm', writable: false, osVersion: '18.04', glibc: '2.27', network: [{ host: 'registry.npmjs.org', ok: false }] });
  for (const c of bad.filter((x) => x.status !== 'ok')) {
    assert.ok(c.title.length > 5 && c.why.length > 10, c.id);
    assert.match(c.fix, /\S{3,}/, `${c.id} has a next step`);
    assert.doesNotMatch(c.fix, /contact support|try again later/i, `${c.id} names a real step`);
  }
  assert.equal(preflightExit(bad), 1);
  const text = formatCards(bad);
  assert.match(text, /Next step:/);
  assert.match(text, /to fix/);
});

test('W2.1 preflight: disk, RAM and port limits', () => {
  assert.deepEqual(ids({ freeBytes: 0.5 * GB }), ['disk:fail']);
  assert.deepEqual(ids({ freeBytes: 2 * GB }), ['disk:warn']);
  assert.deepEqual(ids({ totalMem: 0.4 * GB }), ['ram:fail']);
  assert.deepEqual(ids({ totalMem: 1 * GB }), ['ram:warn']);
  assert.match(preflight({ ...good, totalMem: 1 * GB }).find((c) => c.id === 'ram')!.fix, /swap/i);
  assert.deepEqual(ids({ portBusy: true }), ['ports:fail']);
  assert.match(preflight({ ...good, portBusy: true }).find((c) => c.id === 'ports')!.fix, /7861/);
  // Her own running server on that port is an update, not a clash.
  assert.deepEqual(ids({ portBusy: true, existing: 'sara' }), []);
  assert.match(preflight({ ...good, existing: 'sara' }).find((c) => c.id === 'existing')!.why, /data stays/i);
});

test('W2.1 preflight: OS versions, 32-bit Raspberry Pi OS, musl and old glibc', () => {
  assert.deepEqual(ids({ osId: 'ubuntu', osVersion: '20.04', glibc: '2.31' }), ['os:warn']);
  assert.deepEqual(ids({ osId: 'debian', osVersion: '12' }), []);
  assert.deepEqual(ids({ osId: 'debian', osVersion: '11' }), ['os:warn']);
  assert.deepEqual(ids({ osId: 'fedora', osVersion: '40' }), []);
  assert.deepEqual(ids({ osId: 'almalinux', osVersion: '9.4' }), []);
  assert.deepEqual(ids({ osId: 'ubuntu', osVersion: '18.04', glibc: '2.27' }), ['os:fail']);
  assert.deepEqual(ids({ osId: 'alpine', osVersion: '3.20', glibc: '' }), ['os:fail']);
  const pi = preflight({ ...good, arch: 'arm', osId: 'raspbian', osVersion: '12' }).find((c) => c.id === 'arch')!;
  assert.equal(pi.status, 'fail');
  assert.match(pi.fix, /Raspberry Pi OS \(64-bit\)/);
  assert.deepEqual(ids({ platform: 'win32', osId: 'windows', osVersion: '10.0.17134', glibc: undefined }), ['os:fail']);
  assert.deepEqual(ids({ platform: 'win32', osId: 'windows', osVersion: '10.0.26100', glibc: undefined }), []);
  assert.deepEqual(ids({ platform: 'darwin', osId: 'macos', osVersion: '21.6.0', glibc: undefined }), ['os:fail']);
  assert.deepEqual(ids({ platform: 'darwin', osId: 'macos', osVersion: '24.1.0', glibc: undefined }), []);
});

test('W2.1 preflight: Docker data volume not writable names the chown command; no network is only a warning for a running server', () => {
  const d = preflight({ ...good, docker: true, dataDir: '/data', writable: false, uid: 1000 }).find((c) => c.id === 'permissions')!;
  assert.equal(d.status, 'fail');
  assert.match(d.fix, /chown -R 1000/);
  assert.deepEqual(ids({ network: [{ host: 'registry.npmjs.org', ok: false }] }), ['network:warn']);
  assert.deepEqual(ids({ network: [{ host: 'registry.npmjs.org', ok: false }], needNetwork: true }), ['network:fail']);
});

test('W2.1: a port already in use at start is a fix-it card, not a stack trace', () => {
  const c = portInUseCard(7860, 'docker');
  assert.match(c.title, /7860/);
  assert.match(c.fix, /SARA_PORT|ports:/);
  const src = read('src/main.ts');
  assert.match(src, /code === 'EADDRINUSE'/);
  assert.match(src, /portInUseCard\(/);
});

test('W2.1: the shell preflight uses the same limits as src/preflight.ts', () => {
  const sh = read('deploy/lib-preflight.sh');
  const num = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(sh)?.[1]);
  assert.equal(num('PF_DISK_FAIL_MB'), LIMITS.diskFailMb);
  assert.equal(num('PF_DISK_WARN_MB'), LIMITS.diskWarnMb);
  assert.equal(num('PF_RAM_FAIL_MB'), LIMITS.ramFailMb);
  assert.equal(num('PF_RAM_WARN_MB'), LIMITS.ramWarnMb);
  const iss = read('desktop/windows/installer/sara.iss');
  assert.match(iss, new RegExp(`PF_DISK_FAIL_MB = ${LIMITS.diskFailMb};`));
  assert.match(iss, new RegExp(`PF_RAM_FAIL_MB = ${LIMITS.ramFailMb};`));
  assert.match(iss, new RegExp(`PF_MIN_WIN_BUILD = ${LIMITS.minWindowsBuild};`));
});

test('W2.1: get-sara.sh carries the preflight library verbatim (it is downloaded alone)', () => {
  const lib = read('deploy/lib-preflight.sh');
  const get = read('deploy/get-sara.sh');
  const a = get.indexOf('# >>> lib-preflight.sh');
  const b = get.indexOf('# <<< lib-preflight.sh');
  assert.ok(a > 0 && b > a, 'markers present');
  const body = get.slice(get.indexOf('\n', a) + 1, b);
  const libBody = lib.slice(lib.indexOf('# ---- body'));
  assert.equal(body, libBody, 'run: node scripts/sync-preflight.ts');
  // Runs before anything is downloaded or installed, and --preflight only checks.
  assert.ok(get.indexOf('pf_run') < get.indexOf('# ---- 1. Basic tools'));
  assert.match(get, /--preflight\)/);
  assert.match(read('deploy/install.sh'), /\. "\$SRC_DIR\/deploy\/lib-preflight\.sh"/);
  assert.match(read('deploy/install.sh'), /--preflight\)/);
});

// ---- the real shell scripts with fake facts ------------------------------------------------------
function fakeRoot(name: string, osRelease: string, memKb: number): string {
  const r = join(tmp, name);
  mkdirSync(join(r, 'etc'), { recursive: true });
  mkdirSync(join(r, 'proc'), { recursive: true });
  writeFileSync(join(r, 'etc', 'os-release'), osRelease);
  writeFileSync(join(r, 'proc', 'meminfo'), `MemTotal:       ${memKb} kB\nMemFree:        1000 kB\n`);
  return r;
}
const UBUNTU = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';
function sh(script: string, env: Record<string, string>): { code: number; out: string } {
  const r = spawnSync(BASH!, ['-c', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', NO_COLOR: '1', SARA_PORT: '', SARA_INSTANCE: '', ...env } });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const fakes = (root: string, extra: Record<string, string> = {}) => ({
  PF_ROOT: fwd(root), PF_FAKE_ARCH: 'x86_64', PF_FAKE_EUID: '0', PF_FAKE_SYSTEMD: '1', PF_FAKE_GLIBC: '2.39',
  PF_FAKE_DF_KB: String(40 * 1024 * 1024), PF_FAKE_BUSY_PORTS: '', PF_FAKE_NET: 'up', ...extra,
});

test('W2.1 shell: get-sara.sh --preflight on a good server passes and changes nothing', { skip: noBash }, () => {
  const r = fakeRoot('good', UBUNTU, 8 * 1024 * 1024);
  const out = sh('bash deploy/get-sara.sh --preflight', fakes(r));
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /Preflight: 8 OK/);
  assert.match(out.out, /Ubuntu 24\.04/);
  assert.ok(!existsSync(join(r, 'opt')), 'nothing installed');
});

test('W2.1 shell: each problem prints a fix-it card and stops before any change', { skip: noBash }, () => {
  const r = fakeRoot('bad', UBUNTU, 300 * 1024);
  const out = sh('bash deploy/get-sara.sh --preflight', fakes(r, { PF_FAKE_DF_KB: String(400 * 1024), PF_FAKE_BUSY_PORTS: '7860', PF_FAKE_NET: 'down', PF_FAKE_EUID: '1000' }));
  assert.equal(out.code, 1, out.out);
  for (const t of [/Not enough free disk space/, /Not enough memory/, /Port 7860 is already in use/, /Can't reach the internet/, /Needs administrator rights/]) assert.match(out.out, t);
  assert.match(out.out, /Next step: .*sudo/);
  assert.match(out.out, /--port 7861/);
  assert.match(out.out, /Nothing was changed/);
});

test('W2.1 shell: 32-bit Raspberry Pi OS, no systemd, old Ubuntu, musl', { skip: noBash }, () => {
  const pi = fakeRoot('pi32', 'ID=raspbian\nVERSION_ID="12"\nPRETTY_NAME="Raspbian GNU/Linux 12 (bookworm)"\n', 4 * 1024 * 1024);
  let out = sh('bash deploy/get-sara.sh --preflight', fakes(pi, { PF_FAKE_ARCH: 'armv7l' }));
  assert.equal(out.code, 1);
  assert.match(out.out, /Raspberry Pi OS \(64-bit\)/);
  const r = fakeRoot('nosd', UBUNTU, 4 * 1024 * 1024);
  out = sh('bash deploy/get-sara.sh --preflight', fakes(r, { PF_FAKE_SYSTEMD: '0' }));
  assert.equal(out.code, 1);
  assert.match(out.out, /Docker Compose/);
  const old = fakeRoot('old', 'ID=ubuntu\nVERSION_ID="18.04"\nPRETTY_NAME="Ubuntu 18.04.6 LTS"\n', 4 * 1024 * 1024);
  out = sh('bash deploy/get-sara.sh --preflight', fakes(old, { PF_FAKE_GLIBC: '2.27' }));
  assert.equal(out.code, 1);
  assert.match(out.out, /too old/i);
  const alp = fakeRoot('alpine', 'ID=alpine\nVERSION_ID=3.20.1\nPRETTY_NAME="Alpine Linux v3.20"\n', 4 * 1024 * 1024);
  out = sh('bash deploy/get-sara.sh --preflight', fakes(alp, { PF_FAKE_GLIBC: '' }));
  assert.equal(out.code, 1);
  assert.match(out.out, /Docker/);
});

test('W2.1 shell: an existing Sara on her own port is an update; --source skips the GitHub check', { skip: noBash }, () => {
  const r = fakeRoot('existing', UBUNTU, 4 * 1024 * 1024);
  mkdirSync(join(r, 'etc', 'sara'), { recursive: true });
  writeFileSync(join(r, 'etc', 'sara', 'sara.env'), 'SARA_PORT=7860\n');
  const out = sh('bash deploy/get-sara.sh --preflight', fakes(r, { PF_FAKE_BUSY_PORTS: '7860' }));
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /already installed/);
  const tar = join(tmp, 'sara.tar');
  writeFileSync(tar, '');
  const src = sh(`bash deploy/get-sara.sh --preflight --source "${fwd(tar)}"`, fakes(r, { PF_FAKE_BUSY_PORTS: '7860', PF_FAKE_NET_DOWN_HOSTS: 'github.com' }));
  assert.equal(src.code, 0, src.out);
  assert.doesNotMatch(src.out, /github\.com/);
});

test('W2.1 shell: install.sh --preflight runs the same checks', { skip: noBash }, () => {
  const r = fakeRoot('inst', UBUNTU, 300 * 1024);
  const out = sh('bash deploy/install.sh --preflight', fakes(r));
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /Not enough memory/);
});

test('W2.1 Windows Setup: disk, memory and Windows version are checked with fix-it messages; a TestInstall can simulate each', () => {
  const iss = read('desktop/windows/installer/sara.iss');
  assert.match(iss, /function GlobalMemoryStatusEx\(var Buf: TMemoryStatusEx\): BOOL;\s*external 'GlobalMemoryStatusEx@kernel32\.dll stdcall';/);
  assert.match(iss, /function PreflightProblem\(/);
  assert.match(iss, /GetSpaceOnDisk64\(/);
  assert.match(iss, /Next step:/);
  // The simulation switch exists only in the TestInstall build.
  const sim = iss.indexOf("{param:PFTEST|}");
  assert.ok(sim > 0);
  const before = iss.lastIndexOf('#ifdef TestInstall', sim);
  const endif = iss.indexOf('#endif', before);
  assert.ok(before > 0 && endif > sim, 'PFTEST is inside #ifdef TestInstall');
  // Runs in InitializeSetup (memory, Windows) and before files are copied (disk).
  assert.match(iss.slice(iss.indexOf('function InitializeSetup')), /PreflightProblem\('start'\)/);
  assert.match(iss.slice(iss.indexOf('function PrepareToInstall')), /PreflightProblem\('disk'\)/);
});

test('W2.1 matrix harness: the targets, a systemd image per distro, report rendering', () => {
  assert.deepEqual(TARGETS.map((t) => t.id), ['ubuntu-22.04', 'ubuntu-24.04', 'debian-12', 'fedora-40', 'almalinux-9', 'ubuntu-24.04-arm64', 'docker-compose']);
  const df = targetDockerfile(TARGETS.find((t) => t.id === 'fedora-40')!);
  assert.match(df, /^FROM fedora:40/m);
  assert.match(df, /dnf install -y .*systemd/);
  assert.match(df, /\/sbin\/init|\/usr\/sbin\/init|lib\/systemd\/systemd/);
  assert.match(targetDockerfile(TARGETS.find((t) => t.id === 'debian-12')!), /apt-get install -y .*systemd/);
  assert.equal(TARGETS.find((t) => t.id === 'ubuntu-24.04-arm64')!.platform, 'linux/arm64');
  const log = '##step preflight ok 3s\n##step install ok 61s\n##step health ok 1s\n##step reinstall fail 20s Port 7860\n';
  assert.deepEqual(parseHarnessLog(log).map((s) => `${s.step}:${s.ok}`), ['preflight:true', 'install:true', 'health:true', 'reinstall:false']);
  const rows: MatrixRow[] = [
    { target: 'ubuntu-24.04', result: 'pass', steps: parseHarnessLog(log).slice(0, 3), note: '' },
    { target: 'ubuntu-24.04-arm64', result: 'unverified', steps: [], note: 'Docker is not available on the test PC' },
  ];
  const md = renderMatrix({ date: '2026-11-19', commit: 'abc1234', rows });
  assert.match(md, /\| ubuntu-24\.04 \| pass \|/);
  assert.match(md, /\| ubuntu-24\.04-arm64 \| unverified \|/);
  assert.match(md, /abc1234/);
});

test('W2.1: docs/INSTALL_MATRIX.md exists with a row per target, and INSTALL.md explains the preflight', () => {
  const m = read('docs/INSTALL_MATRIX.md');
  for (const t of TARGETS) assert.match(m, new RegExp(`\\| ${t.id.replace(/\./g, '\\.')} \\|`), t.id);
  assert.match(m, /\| windows-11 /);
  assert.match(read('docs/INSTALL.md'), /--preflight/);
});

test('W2.1: node src/main.ts --preflight checks without creating a data folder', () => {
  const data = join(tmp, 'never-made');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts', '--preflight', '--json', '--offline'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, SARA_DATA: data, SARA_PORT: '7999' }, timeout: 60_000,
  });
  const cards = JSON.parse(r.stdout) as { id: string }[];
  assert.ok(cards.some((c) => c.id === 'disk') && cards.some((c) => c.id === 'ports'), r.stderr);
  assert.ok(!existsSync(data), 'no data folder made');
});
