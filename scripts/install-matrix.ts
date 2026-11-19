// W2.1: the Linux/Docker install matrix. Each target is a throwaway container with systemd running,
// where the REAL deploy/get-sara.sh installs Sara from a tarball of this checkout's committed HEAD
// (`--source`, so nothing is downloaded from GitHub and nothing is published), then checks health,
// an update over the existing install, and the preflight's port card. Docker Compose is checked by
// building the real Dockerfile. Without Docker every row is recorded as unverified, never as passed.
//
//   node scripts/install-matrix.ts [--only ubuntu-24.04,debian-12] [--write]   (writes docs/INSTALL_MATRIX.md)
//
// Needs Docker (Docker Desktop on Windows/macOS) and, for the arm64 row, qemu binfmt (Docker Desktop
// has it; on Linux: docker run --privileged --rm tonistiigi/binfmt --install arm64).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Target {
  id: string;
  kind: 'systemd' | 'compose';
  image?: string;
  platform?: string;
  pkg?: 'apt' | 'dnf';
}
export const TARGETS: Target[] = [
  { id: 'ubuntu-22.04', kind: 'systemd', image: 'ubuntu:22.04', pkg: 'apt' },
  { id: 'ubuntu-24.04', kind: 'systemd', image: 'ubuntu:24.04', pkg: 'apt' },
  { id: 'debian-12', kind: 'systemd', image: 'debian:12', pkg: 'apt' },
  { id: 'fedora-40', kind: 'systemd', image: 'fedora:40', pkg: 'dnf' },
  { id: 'almalinux-9', kind: 'systemd', image: 'almalinux:9', pkg: 'dnf' },
  { id: 'ubuntu-24.04-arm64', kind: 'systemd', image: 'ubuntu:24.04', pkg: 'apt', platform: 'linux/arm64' },
  { id: 'docker-compose', kind: 'compose' },
];

export interface Step { step: string; ok: boolean; seconds: number; note: string }
export interface MatrixRow { target: string; result: 'pass' | 'fail' | 'unverified'; steps: Step[]; note: string }

/** A systemd image for one distribution (systemd as PID 1, plus what a minimal server has). */
export function targetDockerfile(t: Target): string {
  const install = t.pkg === 'dnf'
    ? 'RUN dnf install -y systemd curl ca-certificates git tar gzip iproute procps-ng sudo && dnf clean all'
    : 'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y systemd systemd-sysv curl ca-certificates git iproute2 procps sudo && rm -rf /var/lib/apt/lists/*';
  const init = t.pkg === 'dnf' ? '/usr/sbin/init' : '/lib/systemd/systemd';
  return [`FROM ${t.image}`, install, 'STOPSIGNAL SIGRTMIN+3', `CMD ["${init}"]`, ''].join('\n');
}

/** Lines "##step <name> ok|fail <n>s [note]" printed by the in-container script. */
export function parseHarnessLog(log: string): Step[] {
  const out: Step[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^##step (\S+) (ok|fail) (\d+)s ?(.*)$/.exec(line.trim());
    if (m) out.push({ step: m[1], ok: m[2] === 'ok', seconds: Number(m[3]), note: m[4] });
  }
  return out;
}

const WIN_START = '<!-- windows -->';
const WIN_END = '<!-- /windows -->';
export function renderMatrix(r: { date: string; commit: string; rows: MatrixRow[]; windows?: string }): string {
  const lines = [
    '# Install matrix',
    '',
    `Last run: ${r.date}, commit \`${r.commit}\`. Made by \`node scripts/install-matrix.ts --write\` (Linux and Docker) and`,
    '`node scripts/check-windows-install.ts` (Windows, TestInstall build only). "unverified" means the run could not',
    'happen on the test PC (the reason is in the note); it is never counted as a pass.',
    '',
    'Each Linux row: a throwaway container with systemd, the real `deploy/get-sara.sh --yes --access local --source <tarball>`',
    'from a tarball of the commit above (no download from GitHub, nothing published), then `/api/health`, an update over',
    'the existing install (data kept), and the preflight port card.',
    '',
    '| Target | Result | Steps | Note |',
    '|---|---|---|---|',
    ...r.rows.map((x) => `| ${x.target} | ${x.result} | ${x.steps.map((s) => `${s.step} ${s.ok ? 'ok' : 'FAIL'} (${s.seconds}s)`).join(', ') || '-'} | ${x.note || ''} |`),
    '',
    '## Windows',
    '',
    WIN_START,
    r.windows?.trim() || '| Target | Result | Steps | Note |\n|---|---|---|---|\n| windows-11 | unverified | - | not run yet |',
    WIN_END,
    '',
    '## Checked on every test run (no Docker needed)',
    '',
    'test/w2-install.test.ts runs the real `get-sara.sh --preflight` and `install.sh --preflight` under bash with',
    'faked facts (a fake /etc/os-release and /proc/meminfo, CPU, free space, busy ports, network): Ubuntu 24.04',
    'healthy, low disk/memory/port in use/no network/no root, 32-bit Raspberry Pi OS, no systemd, Ubuntu 18.04',
    '(glibc 2.27), Alpine (musl), an existing install on her own port, and `--source` without GitHub. It also checks',
    'that `node src/main.ts --preflight` creates no data folder and that the limits are the same in the shell,',
    'Node and Windows Setup checks.',
    '',
  ];
  return lines.join('\n');
}

// ---- running it ------------------------------------------------------------------------------
const ROOT = join(import.meta.dirname, '..');
function run(cmd: string, args: string[], opts: { input?: string; timeout?: number } = {}): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', input: opts.input, timeout: opts.timeout ?? 1_200_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The steps run inside a systemd container (prints ##step lines). */
export const IN_CONTAINER = String.raw`set -u
step() { local name=$1; shift; local t0=$(date +%s); local out; if out="$("$@" 2>&1)"; then echo "##step $name ok $(( $(date +%s) - t0 ))s"; else echo "##step $name fail $(( $(date +%s) - t0 ))s $(printf '%s' "$out" | tail -n 3 | tr '\n|' '  ')"; fi; printf '%s\n' "$out" >> /tmp/harness.log; }
mkdir -p /tmp/s && tar -xzf /src/sara.tar.gz -C /tmp/s
step preflight bash /tmp/s/deploy/get-sara.sh --preflight --source /src/sara.tar.gz
step install bash /tmp/s/deploy/get-sara.sh --yes --access local --no-sandbox --no-voice --source /src/sara.tar.gz
step health curl -fsS http://127.0.0.1:7860/api/health
step update bash -c 'bash /opt/sara-src/deploy/get-sara.sh --yes --access local --no-sandbox --no-voice --source /src/sara.tar.gz && test -f /var/lib/sara/owner.json && curl -fsS http://127.0.0.1:7860/api/health'
step port-card bash -c '( /opt/sara/node/bin/node -e "require(\"net\").createServer().listen(7870,\"127.0.0.1\")" & echo $! > /tmp/l.pid; sleep 1; out=$(bash /opt/sara-src/deploy/get-sara.sh --preflight --instance work --port 7870 --source /src/sara.tar.gz); code=$?; kill $(cat /tmp/l.pid); [ $code -eq 1 ] && printf "%s" "$out" | grep -q "Port 7870 is already in use" )'
`;

function dockerOk(): boolean {
  return run('docker', ['info'], { timeout: 30_000 }).code === 0;
}
function arm64Ok(): boolean {
  const r = run('docker', ['run', '--rm', '--platform', 'linux/arm64', 'alpine:3.20', 'uname', '-m'], { timeout: 180_000 });
  return r.code === 0 && /aarch64/.test(r.out);
}

function runSystemd(t: Target, tarball: string): MatrixRow {
  const tag = `sara-matrix-${t.id}`;
  const plat = t.platform ? ['--platform', t.platform] : [];
  const b = run('docker', ['build', ...plat, '-t', tag, '-'], { input: targetDockerfile(t) });
  if (b.code !== 0) return { target: t.id, result: 'fail', steps: [], note: `image build failed: ${b.out.trim().split('\n').at(-1)}` };
  run('docker', ['rm', '-f', tag]);
  const up = run('docker', ['run', '-d', '--name', tag, ...plat, '--privileged', '--cgroupns=host', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', `${tarball}:/src/sara.tar.gz:ro`, tag]);
  if (up.code !== 0) return { target: t.id, result: 'fail', steps: [], note: `container did not start: ${up.out.trim().split('\n').at(-1)}` };
  try {
    for (let i = 0; i < 60; i++) {
      const s = run('docker', ['exec', tag, 'systemctl', 'is-system-running'], { timeout: 20_000 }).out.trim();
      if (/running|degraded/.test(s)) break;
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
    const r = run('docker', ['exec', '-i', tag, 'bash', '-s'], { input: IN_CONTAINER, timeout: 1_800_000 });
    const steps = parseHarnessLog(r.out);
    const failed = steps.filter((s) => !s.ok);
    return { target: t.id, result: steps.length >= 5 && !failed.length ? 'pass' : 'fail', steps, note: failed.map((s) => `${s.step}: ${s.note}`).join('; ').slice(0, 300) };
  } finally {
    run('docker', ['rm', '-f', tag]);
  }
}

function runCompose(): MatrixRow {
  const tag = 'sara-matrix-compose';
  const steps: Step[] = [];
  const time = (name: string, f: () => { ok: boolean; note?: string }) => {
    const t0 = Date.now();
    const r = f();
    steps.push({ step: name, ok: r.ok, seconds: Math.round((Date.now() - t0) / 1000), note: r.note ?? '' });
  };
  time('build', () => { const r = run('docker', ['build', '-t', tag, '.']); return { ok: r.code === 0, note: r.code ? r.out.trim().split('\n').at(-1) : '' }; });
  time('preflight', () => { const r = run('docker', ['run', '--rm', tag, 'node', 'src/main.ts', '--preflight', '--offline']); return { ok: r.code === 0, note: r.code ? r.out.slice(-200) : '' }; });
  run('docker', ['rm', '-f', tag]);
  time('start', () => ({ ok: run('docker', ['run', '-d', '--name', tag, '-p', '127.0.0.1:17860:7860', tag]).code === 0 }));
  time('health', () => {
    for (let i = 0; i < 30; i++) {
      if (run('docker', ['exec', tag, 'curl', '-fsS', 'http://127.0.0.1:7860/api/health'], { timeout: 15_000 }).code === 0) return { ok: true };
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
    return { ok: false, note: 'no /api/health after 30 s' };
  });
  time('port-card', () => {
    const r = run('docker', ['exec', '-e', 'SARA_DATA=/tmp/second', tag, 'node', 'src/main.ts']);
    return { ok: r.code !== 0 && /Port 7860 is already in use/.test(r.out), note: r.out.slice(-160) };
  });
  run('docker', ['rm', '-f', tag]);
  const failed = steps.filter((s) => !s.ok);
  return { target: 'docker-compose', result: failed.length ? 'fail' : 'pass', steps, note: failed.map((s) => `${s.step}: ${s.note}`).join('; ').slice(0, 300) };
}

if (import.meta.main) {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
  const targets = TARGETS.filter((t) => !only || only.includes(t.id));
  const commit = run('git', ['rev-parse', '--short', 'HEAD']).out.trim();
  const rows: MatrixRow[] = [];
  if (!dockerOk()) {
    for (const t of targets) rows.push({ target: t.id, result: 'unverified', steps: [], note: 'Docker is not available on the test PC (docker info failed)' });
  } else {
    const dir = join(process.env.TMPDIR ?? tmpdir(), 'sara-install-matrix');
    mkdirSync(dir, { recursive: true });
    const tarball = join(dir, 'sara-src.tar.gz');
    const a = run('git', ['archive', '--format=tar.gz', '-o', tarball, 'HEAD']);
    if (a.code !== 0) throw new Error(`git archive failed: ${a.out}`);
    const arm = targets.some((t) => t.platform === 'linux/arm64') ? arm64Ok() : false;
    for (const t of targets) {
      if (t.platform === 'linux/arm64' && !arm) { rows.push({ target: t.id, result: 'unverified', steps: [], note: 'no arm64 emulation (qemu binfmt) on the test PC' }); continue; }
      const row = t.kind === 'compose' ? runCompose() : runSystemd(t, tarball);
      console.log(`${row.target}: ${row.result} ${row.note}`);
      rows.push(row);
    }
  }
  const file = join(ROOT, 'docs', 'INSTALL_MATRIX.md');
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const win = old.includes(WIN_START) ? old.slice(old.indexOf(WIN_START) + WIN_START.length, old.indexOf(WIN_END)) : undefined;
  const md = renderMatrix({ date: new Date().toISOString().slice(0, 10), commit, rows, windows: win });
  if (process.argv.includes('--write')) writeFileSync(file, md);
  else console.log(md);
  process.exit(rows.some((r) => r.result === 'fail') ? 1 : 0);
}
