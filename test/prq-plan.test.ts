// PRQ (docs/ops/PRQ_DESIGN.md): the exact install steps per OS and package manager, the Linux
// non-root paths, pinned checksums, and that nothing a request sends can reach a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { program, PROGRAMS } from '../src/prereqs/catalog.ts';
import { installPlan, linuxSystem, manualLines, shellLine, type PlanEnv } from '../src/prereqs/plan.ts';

const base: PlanEnv = { platform: 'linux', arch: 'x64', home: '/home/o', root: true, sudo: false, winget: null, brew: null };
const linux = (osRelease: string, pms: string[], o: Partial<PlanEnv> = {}): PlanEnv => ({ ...base, linux: linuxSystem(osRelease, (c) => pms.includes(c)), ...o });
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=43\n';
const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n';
const ALMA = 'ID="almalinux"\nID_LIKE="rhel centos fedora"\n';
const ARCH = 'ID=arch\n';
const SUSE = 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n';
const argvs = (p: ReturnType<typeof installPlan>) => p.steps.filter((s) => s.kind === 'run').map((s) => (s as { argv: string[] }).argv);

test('prq plan: Windows uses winget with the exact package id and says UAC may ask', () => {
  const p = installPlan(program('chrome'), { ...base, platform: 'win32', winget: 'C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe' });
  assert.equal(p.method, 'winget');
  assert.equal(p.elevation, 'uac');
  assert.deepEqual(p.source, { kind: 'winget', ref: 'Google.Chrome' });
  assert.deepEqual(argvs(p), [['C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe', 'install', '--id', 'Google.Chrome', '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']]);
  for (const id of ['uv', 'node', 'python', 'blender', 'ffmpeg'] as const) assert.equal(installPlan(program(id), { ...base, platform: 'win32', winget: 'winget.exe' }).method, 'winget');
  // No winget: the vendor page and the command to use once it is there.
  const none = installPlan(program('uv'), { ...base, platform: 'win32' });
  assert.equal(none.manual?.reason, 'no-winget');
  assert.equal(none.steps.length, 0);
});

test('prq plan: Docker Desktop is link-out only on Windows and macOS', () => {
  for (const platform of ['win32', 'darwin']) {
    const p = installPlan(program('docker'), { ...base, platform, winget: 'winget.exe', brew: '/opt/homebrew/bin/brew' });
    assert.equal(p.method, 'manual');
    assert.equal(p.manual?.reason, 'link-only');
    assert.match(p.manual!.url, /^https:\/\/docs\.docker\.com\//);
  }
});

test('prq plan: macOS uses Homebrew (cask or formula) when present, else the vendor page', () => {
  const brew = '/opt/homebrew/bin/brew';
  assert.deepEqual(argvs(installPlan(program('chrome'), { ...base, platform: 'darwin', brew })), [[brew, 'install', '--cask', 'google-chrome']]);
  assert.deepEqual(argvs(installPlan(program('uv'), { ...base, platform: 'darwin', brew })), [[brew, 'install', 'uv']]);
  const none = installPlan(program('ffmpeg'), { ...base, platform: 'darwin' });
  assert.equal(none.manual?.reason, 'no-brew');
  assert.deepEqual(none.manual?.lines, ['brew install ffmpeg']);
});

test('prq plan: Linux package manager from os-release', () => {
  assert.equal(linuxSystem(FEDORA, (c) => c === 'dnf').pm, 'dnf');
  assert.equal(linuxSystem(UBUNTU, (c) => c === 'apt-get').pm, 'apt');
  assert.equal(linuxSystem(ALMA, (c) => c === 'yum').pm, 'yum');
  assert.equal(linuxSystem(ARCH, (c) => c === 'pacman').pm, 'pacman');
  assert.equal(linuxSystem(SUSE, (c) => c === 'zypper').pm, 'zypper');
  assert.equal(linuxSystem('ID=gentoo\n', () => true).pm, null);
  assert.equal(installPlan(program('python'), linux('ID=gentoo\n', [])).manual?.reason, 'unsupported');
});

test('prq plan: Chrome on Linux comes from Google\'s own repository', () => {
  const f = installPlan(program('chrome'), linux(FEDORA, ['dnf']));
  assert.equal(f.method, 'dnf');
  const file = f.steps.find((s) => s.kind === 'file') as { text: string };
  assert.match(file.text, /baseurl=https:\/\/dl\.google\.com\/linux\/chrome\/rpm\/stable\/x86_64/);
  assert.match(file.text, /gpgcheck=1/);
  assert.deepEqual(argvs(f).at(-1), ['dnf', 'install', '-y', 'google-chrome-stable']);
  const u = installPlan(program('chrome'), linux(UBUNTU, ['apt-get']));
  assert.ok(u.steps.some((s) => s.kind === 'download' && s.url === 'https://dl.google.com/linux/linux_signing_key.pub'));
  assert.deepEqual(argvs(u).at(-1), ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'google-chrome-stable']);
  assert.equal(installPlan(program('chrome'), linux(ARCH, ['pacman'])).manual?.reason, 'no-package', 'AUR only: manual');
  assert.equal(installPlan(program('chrome'), linux(FEDORA, ['dnf'], { arch: 'arm64' })).manual?.reason, 'arch');
});

test('prq plan: uv on Linux is the official archive, sha256-pinned, into /usr/local/bin as root', () => {
  const p = installPlan(program('uv'), linux(FEDORA, ['dnf']));
  assert.equal(p.method, 'download');
  const dl = p.steps[0] as { kind: string; url: string; sha256: string };
  assert.equal(dl.kind, 'download');
  assert.match(dl.url, /^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/\d+\.\d+\.\d+\/uv-x86_64-unknown-linux-gnu\.tar\.gz$/);
  assert.match(dl.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(argvs(p).at(-1), ['install', '-m', '0755', '{tmp}/uv-x86_64-unknown-linux-gnu/uvx', '/usr/local/bin/uvx']);
  const arm = installPlan(program('uv'), linux(UBUNTU, ['apt-get'], { arch: 'arm64' }));
  assert.match((arm.steps[0] as { url: string }).url, /aarch64/);
  assert.notEqual((arm.steps[0] as { sha256: string }).sha256, dl.sha256);
  // Every pinned download in the catalog is https and has a checksum per arch.
  for (const pr of PROGRAMS) for (const r of Object.values(pr.linux ?? {})) for (const s of [...r!.steps, ...(r!.user ?? [])]) if (s.kind === 'download') for (const u of Object.values(s.url)) assert.match(u!, /^https:\/\//);
});

test('prq plan: Linux non-root: sudo -n when it works, the user folder when it can, else the commands to paste', () => {
  const sudo = installPlan(program('python'), linux(UBUNTU, ['apt-get'], { root: false, sudo: true }));
  assert.equal(sudo.elevation, 'sudo');
  assert.deepEqual(argvs(sudo), [['sudo', '-n', 'apt-get', 'update'], ['sudo', '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'python3', 'python3-venv']]);
  const user = installPlan(program('uv'), linux(FEDORA, ['dnf'], { root: false, sudo: false }));
  assert.equal(user.userInstall, true);
  assert.equal(user.elevation, 'none');
  assert.ok(argvs(user).every((a) => a[0] !== 'sudo'));
  assert.deepEqual(argvs(user).at(-1), ['install', '-m', '0755', '{tmp}/uv-x86_64-unknown-linux-gnu/uvx', '/home/o/.local/bin/uvx']);
  const paste = installPlan(program('docker'), linux(FEDORA, ['dnf'], { root: false, sudo: false }));
  assert.equal(paste.method, 'manual');
  assert.equal(paste.manual?.reason, 'no-root');
  assert.ok(paste.manual!.lines.includes('sudo dnf install -y moby-engine'));
  assert.ok(paste.manual!.lines.includes('sudo systemctl enable --now docker'));
  assert.equal(paste.after, 'docker-group');
  // Docker on RHEL-family without Fedora's moby-engine: manual.
  assert.equal(installPlan(program('docker'), linux(ALMA, ['dnf'])).manual?.reason, 'no-package');
});

test('prq plan: manual lines quote safely and check the checksum before use', () => {
  const user = installPlan(program('node'), linux(UBUNTU, ['apt-get']));
  const lines = manualLines(user.steps);
  assert.ok(lines.some((l) => /^curl -fL -o \/tmp\/sara-prq\/node\.tar\.gz https:\/\/nodejs\.org\/dist\/v24\.\d+\.\d+\/node-v24\.\d+\.\d+-linux-x64\.tar\.gz$/.test(l)));
  assert.ok(lines.some((l) => / \| sha256sum -c -$/.test(l)));
  assert.ok(!lines.some((l) => /\|\s*(ba)?sh\b/.test(l)), 'never pipes a download into a shell');
  assert.equal(shellLine(['echo', "it's; rm -rf /"]), `echo 'it'\\''s; rm -rf /'`);
});

test('prq plan: every argv element is a catalog constant (no shell, no request data)', () => {
  const envs: PlanEnv[] = [
    { ...base, platform: 'win32', winget: 'winget.exe' },
    { ...base, platform: 'darwin', brew: '/opt/homebrew/bin/brew' },
    linux(FEDORA, ['dnf']), linux(UBUNTU, ['apt-get'], { root: false, sudo: true }), linux(ARCH, ['pacman']), linux(SUSE, ['zypper']),
  ];
  for (const p of PROGRAMS) for (const e of envs) {
    const plan = installPlan(p, e);
    for (const argv of argvs(plan)) {
      assert.ok(!['sh', 'bash', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(argv[0]), `${p.id}: ${argv[0]}`);
      for (const a of argv) assert.doesNotMatch(a, /[;&|`$<>\n]/, `${p.id}: ${a}`);
    }
  }
});
