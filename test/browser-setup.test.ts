// Sara's own browser (src/browser-setup.ts, docs/BROWSER.md): the download, the Linux library check
// and its no-root fallback, the self-test, the states the add-on card shows, and how the Playwright
// add-on and her testing browser are pointed at it. Also the owner report behind it: Settings told a
// cPanel/AlmaLinux 8 owner to "upgrade Python" (and Docker) while adding the Browser add-on.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adminCommand, BrowserSetup, distroRepos, isPlaywrightMcp, ownNpx, packagesFor, parseLdd, parseProgress, playwrightLaunch, PLAYWRIGHT_CORE, setBrowserSetup, shellIn, type LineRun, type SetupDeps } from '../src/browser-setup.ts';
import { findBrowser } from '../src/browser.ts';
import { program } from '../src/prereqs/catalog.ts';
import { detect, type DetectEnv } from '../src/prereqs/detect.ts';
import { installPlan, linuxSystem } from '../src/prereqs/plan.ts';
import { PrereqService } from '../src/prereqs/service.ts';

const ALMA8 = 'NAME="AlmaLinux"\nVERSION="8.10 (Cerulean Leopard)"\nID="almalinux"\nID_LIKE="rhel centos fedora"\n';
// `ldd chrome-headless-shell` on a stock AlmaLinux 8 cPanel server (before Google Chrome pulled these in).
const LDD_ALMA8 = [
  '\tlinux-vdso.so.1 (0x00007ffd5b3f2000)',
  '\tlibdl.so.2 => /lib64/libdl.so.2 (0x00007f2a1c000000)',
  '\tlibnss3.so => /lib64/libnss3.so (0x00007f2a1bc00000)',
  '\tlibatk-1.0.so.0 => /lib64/libatk-1.0.so.0 (0x00007f2a1b800000)',
  '\tlibatk-bridge-2.0.so.0 => not found',
  '\tlibgbm.so.1 => not found',
  '\tlibasound.so.2 => not found',
  '\tlibatspi.so.0 => not found',
  '\tlibgbm.so.1 => not found',
  '\tlibc.so.6 => /lib64/libc.so.6 (0x00007f2a1a000000)',
].join('\n');

test('ldd output: the missing libraries, once each, and their packages per distro', () => {
  assert.deepEqual(parseLdd(LDD_ALMA8), ['libasound.so.2', 'libatk-bridge-2.0.so.0', 'libatspi.so.0', 'libgbm.so.1']);
  assert.deepEqual(parseLdd('\tlibc.so.6 => /lib64/libc.so.6 (0x1)\n'), []);
  const rpm = packagesFor(parseLdd(LDD_ALMA8), 'dnf');
  assert.deepEqual(rpm.packages, ['alsa-lib', 'at-spi2-atk', 'at-spi2-core', 'mesa-libgbm']);
  assert.equal(adminCommand('dnf', rpm.packages), 'sudo dnf install -y alsa-lib at-spi2-atk at-spi2-core mesa-libgbm');
  const deb = packagesFor(['libnss3.so', 'libnssutil3.so', 'libgbm.so.1', 'libmystery.so.9'], 'apt');
  assert.deepEqual(deb.packages, ['libgbm1', 'libnss3']);
  assert.deepEqual(deb.unknown, ['libmystery.so.9']);
  assert.equal(adminCommand('apt', deb.packages), 'sudo apt-get install -y libgbm1 libnss3');
  assert.equal(adminCommand(null, ['x']), undefined);
  assert.equal(adminCommand('dnf', []), undefined);
  // dnf download may use only the distribution's own repositories (cPanel/PostgreSQL ones are left out).
  assert.deepEqual(distroRepos('appstream   AlmaLinux 8 - AppStream\nbaseos   AlmaLinux 8 - BaseOS\nEA4   EasyApache 4\npgdg-common  PostgreSQL common\nextras  AlmaLinux 8 - Extras\n'), ['appstream', 'baseos']);
});

test('download progress and the headless shell inside a Playwright browsers folder', () => {
  assert.equal(parseProgress('|■■■■■■■■                    |  45% of 110.2 MiB'), 45);
  assert.equal(parseProgress('Chrome Headless Shell downloaded to /x'), undefined);
  const files = new Set(['/d/chromium_headless_shell-1252/INSTALLATION_COMPLETE', '/d/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell', '/d/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell']);
  const list = () => ['ffmpeg-1013', 'chromium_headless_shell-1252', 'chromium_headless_shell-1300', 'chromium-1252'];
  // 1300 is newer but its download never completed: 1252 is used.
  assert.equal(shellIn('/d', 'linux', list, (f) => files.has(f.replace(/\\/g, '/'))), join('/d', 'chromium_headless_shell-1252', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
  const win = new Set(['C:/d/chromium_headless_shell-1252/INSTALLATION_COMPLETE', 'C:/d/chromium_headless_shell-1252/chrome-headless-shell-win64/chrome-headless-shell.exe']);
  assert.match(shellIn('C:/d', 'win32', list, (f) => win.has(f.replace(/\\/g, '/'))) ?? '', /chrome-headless-shell-win64[\\/]chrome-headless-shell\.exe$/);
  assert.equal(shellIn('/none', 'linux', () => { throw new Error('ENOENT'); }), undefined);
  assert.match(PLAYWRIGHT_CORE, /^1\.65\.0/);
});

test('Sara\'s own npx is found beside her Node (Windows and Linux layouts)', () => {
  assert.deepEqual(ownNpx('C:\\node\\node.exe', 'win32', (f) => f.replace(/\\/g, '/') === 'C:/node/node_modules/npm/bin/npx-cli.js')?.[0], 'C:\\node\\node.exe');
  assert.equal(ownNpx('/opt/sara/node/bin/node', 'linux', (f) => f.replace(/\\/g, '/') === '/opt/sara/node/lib/node_modules/npm/bin/npx-cli.js')?.[1].replace(/\\/g, '/'), '/opt/sara/node/lib/node_modules/npm/bin/npx-cli.js');
  assert.equal(ownNpx('/usr/bin/node', 'linux', () => false), undefined);
});

test('the Playwright add-on is pointed at Sara\'s browser; the owner\'s own choice wins', () => {
  assert.ok(isPlaywrightMcp({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.84'] }));
  assert.ok(isPlaywrightMcp({ command: 'C:\\x\\node_modules\\.bin\\playwright-mcp.cmd' }));
  assert.ok(!isPlaywrightMcp({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@1'] }));
  const base = ['-y', '@playwright/mcp@0.0.84'];
  const shell = { kind: 'shell' as const, path: '/var/lib/sara/cache/browsers/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell', source: 'download' as const, libDir: '/var/lib/sara/cache/browsers/libs/root/usr/lib64' };
  const dl = playwrightLaunch(base, shell, '/var/lib/sara/cache/browsers');
  assert.deepEqual(dl.args, [...base, '--browser', 'chromium', '--executable-path', shell.path, '--headless', '--isolated']);
  assert.deepEqual(dl.env, { PLAYWRIGHT_BROWSERS_PATH: '/var/lib/sara/cache/browsers', LD_LIBRARY_PATH: shell.libDir });
  // Inside bubblewrap the data folder is hidden: the browsers folder is shown read-only.
  assert.deepEqual(dl.binds, [{ src: '/var/lib/sara/cache/browsers', dest: '/var/lib/sara/cache/browsers', rw: false }]);
  const edge = playwrightLaunch(base, { kind: 'edge', path: 'C:\\Edge\\msedge.exe', source: 'system' }, 'C:\\data\\cache\\browsers');
  assert.deepEqual(edge.args, [...base, '--browser', 'msedge', '--isolated']);
  assert.deepEqual(playwrightLaunch(base, { kind: 'chrome', path: '/Applications/Google Chrome.app', source: 'system' }, undefined).args, [...base, '--browser', 'chrome', '--isolated']);
  // The owner's own flags stay; nothing is added twice.
  const own = playwrightLaunch([...base, '--browser=firefox', '--user-data-dir', '/p'], shell, '/b');
  assert.deepEqual(own.args, [...base, '--browser=firefox', '--user-data-dir', '/p']);
  // Not ready yet: the folder is still set (a later download is found), no executable path.
  assert.deepEqual(playwrightLaunch(base, undefined, '/b').args, [...base, '--isolated']);
});

/** A fake computer for the setup service: the download writes a real shell file, ldd answers from a script. */
function rig(o: { ldd?: string[]; userLibs?: boolean; test?: (noSandbox: boolean) => boolean; platform?: NodeJS.Platform; musl?: boolean; system?: boolean; privateLocal?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sara-bsetup-'));
  const ran: string[][] = [];
  const tests: boolean[] = [];
  const plat = o.platform ?? 'linux';
  const sub = plat === 'win32' ? ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'] : ['chrome-headless-shell-linux64', 'chrome-headless-shell'];
  let lddCall = 0;
  const run: NonNullable<SetupDeps['run']> = async (argv, x): Promise<LineRun> => {
    ran.push(argv);
    if (argv.includes('install')) {
      x.onLine?.('|■■■■■■■■■                         |  25% of 110.2 MiB');
      const b = join(x.env.PLAYWRIGHT_BROWSERS_PATH!, 'chromium_headless_shell-1252');
      mkdirSync(join(b, sub[0]), { recursive: true });
      writeFileSync(join(b, sub[0], sub[1]), '');
      writeFileSync(join(b, 'INSTALLATION_COMPLETE'), '');
      return { code: 0, out: 'Chrome Headless Shell downloaded' };
    }
    if (argv[0] === 'ldd') return { code: 0, out: o.ldd?.[Math.min(lddCall++, o.ldd.length - 1)] ?? '\tlibc.so.6 => /lib64/libc.so.6 (0x1)' };
    if (argv[0] === 'dnf' && argv[1] === '-q') return { code: 0, out: 'appstream AlmaLinux 8 - AppStream\nbaseos AlmaLinux 8 - BaseOS\nEA4 EasyApache\n' };
    if (argv[0] === 'dnf' && argv[1] === 'download') {
      if (o.userLibs) {
        const rpms = argv[argv.indexOf('--destdir') + 1];
        writeFileSync(join(rpms, 'alsa-lib-1.2.10-2.el8.x86_64.rpm'), '');
      }
      return { code: 0, out: '' };
    }
    if (argv[0] === 'rpm') return { code: 0, out: `${argv[2]}: digests signatures OK` };
    if (argv[0] === '/bin/sh') {
      mkdirSync(join(x.cwd, 'usr', 'lib64'), { recursive: true });
      return { code: 0, out: '' };
    }
    return { code: 1, out: 'unexpected' };
  };
  const setup = new BrowserSetup({
    dataDir: dir,
    platform: plat,
    arch: 'x64',
    env: { PATH: '/usr/bin' },
    npx: ['/opt/sara/node/bin/node', '/opt/sara/node/lib/node_modules/npm/bin/npx-cli.js'],
    run,
    selfTest: async (_b, x) => (tests.push(x.noSandbox), { ok: o.test ? o.test(x.noSandbox) : true, error: 'No usable sandbox!' }),
    linux: () => ({ pm: 'dnf', ids: ['almalinux', 'rhel'], musl: o.musl === true }),
    systemBrowser: () => (o.system ? { kind: 'edge', path: 'C:\\Edge\\msedge.exe' } : undefined),
    privateLocal: () => o.privateLocal === true,
  });
  return { dir, setup, ran, tests, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('one click on a server: download with Sara\'s own npx into her data folder, library check, self-test, Ready', async () => {
  const r = rig();
  try {
    assert.equal(r.setup.status().state, 'missing');
    assert.equal(r.setup.ensure().state, 'downloading');
    const s = await r.setup.wait();
    assert.equal(s.state, 'ready');
    assert.equal(s.browser?.source, 'download');
    assert.match(s.browser!.path.replace(/\\/g, '/'), /\/cache\/browsers\/chromium_headless_shell-1252\/chrome-headless-shell-linux64\/chrome-headless-shell$/);
    // The pinned Playwright, Sara's own Node (never a system npx), the data folder as PLAYWRIGHT_BROWSERS_PATH.
    assert.deepEqual(r.ran[0], ['/opt/sara/node/bin/node', '/opt/sara/node/lib/node_modules/npm/bin/npx-cli.js', '-y', `playwright-core@${PLAYWRIGHT_CORE}`, 'install', 'chromium-headless-shell']);
    assert.deepEqual(r.tests, [false], 'tested once, with Chrome\'s own sandbox');
    // Kept across restarts, and a second ensure downloads nothing.
    assert.equal(new BrowserSetup({ dataDir: r.dir, platform: 'linux', arch: 'x64', linux: () => ({ pm: 'dnf', ids: [], musl: false }) }).status().state, 'ready');
    const before = r.ran.length;
    assert.equal(r.setup.ensure().state, 'ready');
    assert.equal(r.ran.length, before);
    // Her testing browser finds the same download (no second copy).
    const info = findBrowser('linux', {}, (p) => p === s.browser!.path, s.browser);
    assert.equal(info.found, true);
    assert.equal(info.managed, true);
    assert.equal(info.kind, 'shell');
  } finally {
    r.done();
  }
});

test('missing libraries: fetched into Sara\'s folder without root; if that fails, the exact admin command', async () => {
  // The system's own packages fetched and unpacked into her folder (ldd then finds everything).
  // Round 2 finds what a fetched library needs itself (libgbm → libwayland-server), as on AlmaLinux 8.
  const ok = rig({ ldd: [LDD_ALMA8, '\tlibwayland-server.so.0 => not found', '\tlibc.so.6 => /lib64/libc.so.6 (0x1)'], userLibs: true });
  try {
    ok.setup.ensure();
    const s = await ok.setup.wait();
    assert.equal(s.state, 'ready');
    assert.match(s.browser?.libDir?.replace(/\\/g, '/') ?? '', /cache\/browsers\/libs\/root\/usr\/lib64$/);
    const dl = ok.ran.find((a) => a[0] === 'dnf' && a[1] === 'download')!;
    assert.ok(dl.includes('--disablerepo=*') && dl.includes('--enablerepo=baseos') && dl.includes('--enablerepo=appstream') && !dl.includes('--enablerepo=EA4'));
    assert.ok(dl.includes('alsa-lib') && dl.includes('mesa-libgbm'));
    assert.ok(ok.ran.some((a) => a[0] === 'rpm' && a[1] === '-K'), 'signatures checked before unpacking');
    const rounds = ok.ran.filter((a) => a[0] === 'dnf' && a[1] === 'download');
    assert.equal(rounds.length, 2);
    assert.ok(rounds[1].includes('libwayland-server'));
  } finally {
    ok.done();
  }
  const no = rig({ ldd: [LDD_ALMA8] });
  try {
    no.setup.ensure();
    const s = await no.setup.wait();
    assert.equal(s.state, 'needs-admin');
    assert.deepEqual(s.missing, ['libasound.so.2', 'libatk-bridge-2.0.so.0', 'libatspi.so.0', 'libgbm.so.1']);
    assert.equal(s.command, 'sudo dnf install -y alsa-lib at-spi2-atk at-spi2-core mesa-libgbm');
    assert.deepEqual(no.tests, [], 'no launch while libraries are missing');
  } finally {
    no.done();
  }
});

test('self-test without Chrome\'s sandbox only when the sandboxed launch fails (Linux), and the other states', async () => {
  const ns = rig({ test: (noSandbox) => noSandbox });
  try {
    ns.setup.ensure();
    const s = await ns.setup.wait();
    assert.equal(s.state, 'ready');
    assert.equal(s.noSandbox, true);
    assert.deepEqual(ns.tests, [false, true]);
  } finally {
    ns.done();
  }
  const bad = rig({ test: () => false });
  try {
    bad.setup.ensure();
    const s = await bad.setup.wait();
    assert.equal(s.state, 'failed');
    assert.match(s.error ?? '', /sandbox/);
  } finally {
    bad.done();
  }
  const alpine = rig({ musl: true });
  try {
    assert.deepEqual(alpine.setup.status(), { state: 'unsupported', why: 'musl' });
    assert.equal(alpine.setup.ensure().state, 'unsupported');
    assert.equal(alpine.ran.length, 0);
  } finally {
    alpine.done();
  }
  const priv = rig({ privateLocal: true });
  try {
    assert.deepEqual(priv.setup.ensure(), { state: 'missing', why: 'private' });
    assert.equal(priv.ran.length, 0, 'nothing downloaded in private local mode');
  } finally {
    priv.done();
  }
  // Windows desktop with Edge: ready at once, nothing downloaded, no prompt.
  const edge = rig({ platform: 'win32', system: true });
  try {
    assert.equal(edge.setup.status().state, 'ready');
    assert.deepEqual(edge.setup.ready(), { kind: 'edge', path: 'C:\\Edge\\msedge.exe', source: 'system' });
    assert.equal(edge.ran.length, 0);
  } finally {
    edge.done();
  }
  // Windows without Chrome/Edge: the headless shell is downloaded, no ldd.
  const bare = rig({ platform: 'win32' });
  try {
    bare.setup.ensure();
    const s = await bare.setup.wait();
    assert.equal(s.state, 'ready');
    assert.match(s.browser!.path, /chrome-headless-shell\.exe$/);
    assert.ok(!bare.ran.some((a) => a[0] === 'ldd'));
  } finally {
    bare.done();
  }
});

// ---- The owner report: "it tells the user to upgrade PHP and something else" ----
// It was Python and Docker: Settings → Add-ons → Other programs (GET /api/prereqs) lists every
// catalog program. On AlmaLinux 8, python3 is the platform's 3.6.8 (dnf and cPanel need it), so it
// said "Found, but too old (3.6.8)" with `sudo dnf install -y python3`, a command that changes
// nothing; Docker said "Not found". Neither has anything to do with the Browser add-on.

function almaEnv(files: string[], versions: Record<string, string>): DetectEnv {
  const set = new Set(files);
  return { platform: 'linux', pathVar: '/usr/local/bin:/usr/bin', vars: { HOME: '/var/lib/sara' }, exists: (f) => set.has(f.replace(/\\/g, '/')), list: () => [], version: (f) => versions[f.replace(/\\/g, '/')] };
}

test('PHP root cause: Python on AlmaLinux 8 is the system 3.6; a python3.12 beside it counts, and the fix installs python3.12', () => {
  const old = detect(program('python'), almaEnv(['/usr/bin/python3'], { '/usr/bin/python3': 'Python 3.6.8' }));
  assert.equal(old.old, true);
  const plan = installPlan(program('python'), { platform: 'linux', arch: 'x64', home: '/var/lib/sara', linux: linuxSystem(ALMA8, (c) => c === 'dnf'), root: false, sudo: false, winget: null, brew: null });
  assert.equal(plan.manual?.reason, 'no-root');
  assert.ok(plan.manual!.lines.includes('sudo dnf install -y python3.12'), plan.manual!.lines.join(' | '));
  assert.ok(!plan.manual!.lines.some((l) => /install -y python3$/.test(l)), 'never the no-op `dnf install python3`');
  const both = detect(program('python'), almaEnv(['/usr/bin/python3', '/usr/bin/python3.12'], { '/usr/bin/python3': 'Python 3.6.8', '/usr/bin/python3.12': 'Python 3.12.12' }));
  assert.equal(both.version, '3.12.12');
  assert.ok(!both.old);
});

test('node is satisfied by Sara\'s own Node, whatever old Node the system has', () => {
  const sys = new PrereqService({ platform: 'linux', env: { PATH: '/usr/bin', HOME: '/var/lib/sara' }, exists: (f) => f === '/usr/bin/node' || f === '/usr/bin/npx', list: () => [], version: () => 'v10.24.0', tmpRoot: '', setting: () => 'off' });
  assert.equal(sys.detect('node').old, true, 'the system Node alone is too old');
  const own = new PrereqService({ platform: 'linux', env: { PATH: '/usr/bin', HOME: '/var/lib/sara' }, exists: (f) => f === '/usr/bin/node' || f === '/usr/bin/npx', list: () => [], version: () => 'v10.24.0', tmpRoot: '', setting: () => 'off', ownNode: () => ({ id: 'node', found: true, path: '/opt/sara/node/bin/node', dir: '/opt/sara/node/bin', onPath: false, version: '24.22.1' }) });
  const d = own.detect('node');
  assert.equal(d.found, true);
  assert.ok(!d.old);
  assert.equal(d.path, '/opt/sara/node/bin/node');
});

test('the Store card for the Browser add-on asks for no Chrome when Sara gets the browser herself', async () => {
  const { StoreInstaller } = await import('../src/store/install.ts');
  const dir = mkdtempSync(join(tmpdir(), 'sara-bsetup-store-'));
  const recipe = { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.84'], needs: ['node', 'app:Google Chrome'], name: 'playwright', fields: [], secrets: [], tools: { readOnly: [], ask: [] } };
  const programs = { detect: (id: string) => ({ id, found: id === 'node', ...(id === 'node' ? { version: '24.22.1' } : {}) }) };
  const ins = new StoreInstaller({ app: { dataDir: dir, settings: { get: () => ({}) } }, client: {}, installs: { get: () => undefined }, programs } as never);
  setBrowserSetup(new BrowserSetup({ dataDir: dir, platform: 'linux', arch: 'x64', linux: () => ({ pm: 'dnf', ids: [], musl: false }) }));
  try {
    const got = ins.needsOf(recipe as never);
    assert.deepEqual(got.map((n) => n.what), ['node']);
    assert.equal(got[0].found, true);
  } finally {
    setBrowserSetup(undefined);
  }
  // Without Sara's own browser (a tool that runs no server), Chrome is still asked for.
  const plain = ins.needsOf(recipe as never);
  assert.deepEqual(plain.map((n) => n.what), ['node', 'app:Google Chrome']);
  rmSync(dir, { recursive: true, force: true });
});
