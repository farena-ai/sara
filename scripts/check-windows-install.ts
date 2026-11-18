// U1.3: the Windows install/update matrix, run for real on this PC with ONLY the TestInstall build
// ("Sara update test", its own AppId, folder %LOCALAPPDATA%\Programs\SaraUpdTest and data folder
// %LOCALAPPDATA%\SaraUpdTest\data). A real Sara on the PC is never installed, changed or removed: its
// uninstall entries are read before the run and must be the same after every step.
//
//   SARA_TEST_INSTALL=1 SARA_APP_VERSION=3.90.0 bash desktop/windows/build-installer.sh   (and 3.90.1, 3.90.2)
//   node scripts/check-windows-install.ts [--setups outputs/windows-updtest] [--report outputs/checks/windows-<date>.md]
//
// Per-user steps: fresh install → the app updates itself to a newer test build → silent reinstall of
// the same version → downgrade (rollback) → a manual run of the downloaded Setup (no switches) →
// a simulated stale "SaraDesktop" entry → uninstall /KEEPDATA → full uninstall. After each: exactly one
// uninstall entry (HKCU + HKLM), the files, the app starts (hidden, --background), her data where
// expected. The all-users cases need an administrator: scripts/check-windows-install-admin.ps1.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signNotice, type NoticePayload } from '../src/update-notice.ts';

export const TEST_APPID = '8C1D7E52-3F0A-4B6E-9D21-5A7B3C9E0F64';
export const REAL_APPID = '6F0B2C1E-7A51-4C8B-9E2D-3B5A0C9D4E17';
const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';

export type Entry = Record<string, string>;
export interface Snapshot {
  hkcu: Entry | null;
  hklm: Entry | null;
  standalone: Entry | null;
  realHkcu: Entry | null;
  realHklm: Entry | null;
  files: Record<string, boolean>;
  /** desktop.ini in the test data folder (the app's server address and update state), or null. */
  dataIni: string | null;
  started: boolean;
}
export interface Want {
  entries: number;
  version?: string;
  files: string[];
  noFiles: string[];
  start: boolean;
  data: 'kept' | 'gone' | 'any';
}
export interface StepResult {
  id: string;
  title: string;
  problems: string[];
  notes: string[];
}

export const STEPS = [
  { id: 'fresh', title: 'Fresh per-user install' },
  { id: 'self-update', title: 'App updates itself to a newer test build' },
  { id: 'reinstall', title: 'Silent reinstall, same version' },
  { id: 'downgrade', title: 'Downgrade (rollback) to an older build' },
  { id: 'manual-setup', title: 'Manual run of the downloaded Setup (no switches)' },
  { id: 'stale-saradesktop', title: "Simulated stale 'SaraDesktop' entry" },
  { id: 'uninstall-keepdata', title: 'Uninstall /KEEPDATA' },
  { id: 'full-uninstall', title: 'Reinstall over kept data, then full uninstall' },
];
export const ADMIN_STEPS = [
  { id: 'allusers-fresh', title: 'All-users install (/ALLUSERS, the service)' },
  { id: 'duplicate-scope', title: 'A per-user copy next to the all-users one: removed on start, data kept' },
  { id: 'allusers-uninstall', title: 'All-users uninstall (service, task, PATH and folder gone)' },
];

/** `reg query <key>` output → its values (null when the key isn't there). */
export function parseRegQuery(out: string): Entry | null {
  if (!/^HKEY_/m.test(out)) return null;
  const e: Entry = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}REG_\w+\s{2,}(.*)$/.exec(line);
    if (m) e[m[1]] = m[2].trim();
  }
  return e;
}

export function checkStep(s: Snapshot, want: Want, baseline: Snapshot): string[] {
  const p: string[] = [];
  const n = (s.hkcu ? 1 : 0) + (s.hklm ? 1 : 0);
  if (n !== want.entries) p.push(`${n} uninstall entries, wanted ${want.entries}`);
  const e = s.hkcu ?? s.hklm;
  if (want.version && e && e.DisplayVersion !== want.version) p.push(`version ${e.DisplayVersion}, wanted ${want.version}`);
  for (const f of want.files) if (!s.files[f]) p.push(`${f} missing`);
  for (const f of want.noFiles) if (s.files[f]) p.push(`${f} should not be there`);
  if (want.start && !s.started) p.push('the app did not start');
  if (want.data === 'kept' && s.dataIni === null) p.push('data folder lost (desktop.ini)');
  if (want.data === 'gone' && s.dataIni !== null) p.push('data still there after a full uninstall');
  if (JSON.stringify(s.realHkcu) !== JSON.stringify(baseline.realHkcu) || JSON.stringify(s.realHklm) !== JSON.stringify(baseline.realHklm))
    p.push("the real Sara's entry changed (it must never be touched)");
  return p;
}

export function adminGuard(o: { service: boolean; task: boolean; programData: boolean; realEntry: boolean }): string[] {
  const why: string[] = [];
  if (o.service) why.push('a Windows service named Sara exists (the test build installs one of that name)');
  if (o.task) why.push('the \\Sara\\Update task exists');
  if (o.programData) why.push('C:\\ProgramData\\Sara exists');
  if (o.realEntry) why.push('a real Sara is installed for all users');
  return why;
}

export function setupArgs(log: string, server?: string): string[] {
  const a = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/MODE=remote', '/CURRENTUSER'];
  if (server) a.push(`/SERVER=${server}`);
  a.push(`/LOG=${log}`);
  return a;
}

export function renderReport(r: { date: string; elevated: boolean; versions: string[]; results: StepResult[]; skipped: string[]; cleanup: string[] }): string {
  const ok = r.results.filter((x) => x.problems.length === 0).length;
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `# Windows install/update matrix — ${r.date}`,
    '',
    `Built by \`node scripts/check-windows-install.ts\` (ROADMAP_U U1.3) with only the TestInstall build ("Sara update test", AppId \`${TEST_APPID.slice(0, 8)}…\`). Test builds: ${r.versions.join(', ')}. ${r.elevated ? 'Run as administrator.' : 'Run without administrator rights.'}`,
    '',
    `**${ok} of ${r.results.length} steps passed.**`,
    '',
    '| Step | Result | Notes |',
    '|---|---|---|',
    ...r.results.map((x) => `| ${cell(x.title)} | ${x.problems.length ? 'FAIL' : 'pass'} | ${cell([...x.problems, ...x.notes].join('; '))} |`),
    '',
  ];
  if (r.skipped.length)
    lines.push(
      '## Needs an administrator (not run)',
      '',
      ...r.skipped.map((s) => `- ${s}`),
      '',
      'Run, in an administrator PowerShell, from the repository: `powershell -ExecutionPolicy Bypass -File scripts\\check-windows-install-admin.ps1`. It refuses next to a real Sara service/task/install and writes `outputs/checks/windows-admin-<date>.md`.',
      '',
    );
  lines.push('## Cleanup', '', ...(r.cleanup.length ? r.cleanup.map((c) => `- ${c}`) : ['- nothing to clean up']), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- the live run (Windows only)

const ROOT = resolve(import.meta.dirname, '..');
const LOCAL = process.env.LOCALAPPDATA ?? '';
const INSTALL = join(LOCAL, 'Programs', 'SaraUpdTest');
const DATA = join(LOCAL, 'SaraUpdTest', 'data');
const SHORTCUT = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Sara update test.lnk');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reg = (args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
const query = (hive: string, key: string) => parseRegQuery(reg(['query', `${hive}\\${UNINSTALL}${key}`, '/reg:64']).stdout ?? '');
const ps = (cmd: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).stdout ?? '';

function testProcs(): number[] {
  const out = ps("Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\SaraUpdTest\\*' } | ForEach-Object { $_.ProcessId }");
  return out.split(/\s+/).filter(Boolean).map(Number);
}
function killTestApps(): void {
  for (const pid of testProcs()) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

/** An .ini Windows or Inno wrote: UTF-16 with a BOM, or 8-bit. */
function readText(f: string): string {
  const b = readFileSync(f);
  return b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8');
}
function snapshot(started = false): Snapshot {
  const files: Record<string, boolean> = {};
  for (const f of ['Sara.exe', 'unins000.exe', 'SaraService.exe', 'node\\node.exe']) files[f] = existsSync(join(INSTALL, f));
  files['Start-menu shortcut'] = existsSync(SHORTCUT);
  const ini = join(DATA, 'desktop.ini');
  return {
    hkcu: query('HKCU', `{${TEST_APPID}}_is1`),
    hklm: query('HKLM', `{${TEST_APPID}}_is1`),
    standalone: query('HKCU', 'SaraDesktop'),
    realHkcu: query('HKCU', `{${REAL_APPID}}_is1`),
    realHklm: query('HKLM', `{${REAL_APPID}}_is1`),
    files,
    dataIni: existsSync(ini) ? readText(ini) : null,
    started,
  };
}

function runSetup(exe: string, args: string[]): number {
  const r = spawnSync(exe, args, { windowsHide: true, timeout: 300_000 });
  return r.status ?? -1;
}
async function uninstall(args: string[]): Promise<void> {
  const unins = join(INSTALL, 'unins000.exe');
  if (!existsSync(unins)) return;
  spawnSync(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...args], { windowsHide: true, timeout: 300_000 });
  // The uninstaller runs from a copy in %TEMP%: wait for the entry and the program to go.
  for (let i = 0; i < 120 && (query('HKCU', `{${TEST_APPID}}_is1`) || existsSync(join(INSTALL, 'Sara.exe'))); i++) await sleep(500);
  await sleep(1500);
}

const appEnv = (extra: Record<string, string> = {}) => ({ ...process.env, SARA_DESKTOP_TEST_DIR: DATA, SARA_TEST_SHORTCUT: SHORTCUT, ...extra });
/** Starts the installed test app hidden; true when it is still running after `ms`. Stopped again unless `keep`.
 *  Waits for the last copy to be gone first (a copy still closing holds the single-instance lock), and
 *  tries once more when it ended early (the run report says so). */
async function startApp(ms = 8000, extra: Record<string, string> = {}, keep = false, tries = 2): Promise<boolean> {
  const exe = join(INSTALL, 'Sara.exe');
  if (!existsSync(exe)) return false;
  for (let i = 0; i < 20 && testProcs().length; i++) await sleep(500);
  const c = spawn(exe, ['--background'], { env: appEnv(extra), detached: true, stdio: 'ignore', windowsHide: true });
  let exitCode: number | null = null;
  c.on('exit', (code) => (exitCode = code ?? -1));
  c.unref();
  await sleep(ms);
  const alive = exitCode === null || testProcs().length > 0;
  if (!keep) killTestApps();
  await sleep(1000);
  if (!alive && tries > 1) {
    retried.push(`the app ended early (exit ${exitCode}); started again`);
    return startApp(ms, extra, keep, tries - 1);
  }
  return alive;
}
const retried: string[] = [];

function keyB64(): { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; pub: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64') };
}

/** A loopback server: the app's /api/health, the signed update notice and the newer Setup (at <base>v<version>/<name>, as on the release page). */
async function noticeServer(setup: string, version: string): Promise<{ srv: Server; base: string; pub: string }> {
  const { privateKey, pub } = keyB64();
  const bytes = readFileSync(setup);
  const name = `Sara-Setup-${version}.exe`;
  let notice = '';
  const srv = createServer((req, res) => {
    if (req.url === '/update-notice.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(notice);
    if (req.url === `/v${version}/${name}`) return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }).end(bytes);
    if (req.url === '/api/health') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/`;
  const payload: NoticePayload = {
    version,
    date: new Date().toISOString(),
    minSupported: '3.0.0',
    security: false,
    assets: { 'win32-x64': { name, url: `${base}v${version}/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } },
  };
  notice = JSON.stringify(signNotice(payload, privateKey));
  return { srv, base, pub };
}

function cmpVer(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
function isElevated(): boolean {
  return spawnSync('net.exe', ['session'], { windowsHide: true }).status === 0;
}

async function main(argv: string[]): Promise<number> {
  if (process.platform !== 'win32') return console.error('Windows only.'), 2;
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const setupsDir = resolve(arg('--setups') ?? join(ROOT, 'outputs', 'windows-updtest'));
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const report = resolve(arg('--report') ?? join(ROOT, 'outputs', 'checks', `windows-${date}.md`));
  const logs = join(ROOT, 'outputs', 'checks', `windows-${date}-logs`);
  mkdirSync(logs, { recursive: true });
  const setups = existsSync(setupsDir) ? readdirSync(setupsDir).map((f) => /^Sara-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(f)?.[1]).filter((v): v is string => !!v).sort(cmpVer) : [];
  if (setups.length < 2) {
    console.error(`Need at least two TestInstall builds in ${setupsDir} (SARA_TEST_INSTALL=1 SARA_APP_VERSION=x.y.z bash desktop/windows/build-installer.sh).`);
    return 2;
  }
  const exe = (v: string) => join(setupsDir, `Sara-Setup-${v}.exe`);
  const B = setups[setups.length - 1], A = setups[setups.length - 2], OLD = setups.length > 2 ? setups[setups.length - 3] : A;
  const baseline = snapshot();
  if (baseline.hkcu || baseline.hklm || existsSync(INSTALL)) {
    console.error('A test install (Sara update test) is already on this PC: remove it first (Settings → Apps, or its unins000.exe).');
    return 2;
  }
  const elevated = isElevated();
  const results: StepResult[] = [];
  const cleanup: string[] = [];
  let n = 0;
  const log = () => join(logs, `setup-${++n}.log`);
  const step = (id: string, problems: string[], notes: string[] = []) => {
    const title = STEPS.find((s) => s.id === id)?.title ?? id;
    results.push({ id, title, problems, notes: [...notes, ...retried.splice(0)] });
    console.log(`${problems.length ? 'FAIL' : 'pass'}  ${title}${problems.length ? ': ' + problems.join('; ') : ''}`);
  };
  const app = ['Sara.exe', 'unins000.exe', 'Start-menu shortcut'];
  const noServer = ['SaraService.exe', 'node\\node.exe'];
  const { srv, base, pub } = await noticeServer(exe(B), B);
  const server = base.replace(/\/$/, '');
  let madeStandalone = false;
  try {
    // 1. Fresh per-user install (the app only, connected to a loopback "server").
    let code = runSetup(exe(A), setupArgs(log(), server));
    let s = snapshot(await startApp());
    step('fresh', checkStep(s, { entries: 1, version: A, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline), [`Setup exit ${code}`, `HKCU ${s.hkcu?.DisplayVersion ?? '-'}`, s.dataIni?.includes(server) ? 'server address saved' : 'server address NOT saved']);
    if (!s.hkcu) throw new Error('the fresh install did not register; stopping');

    // 2. The app updates itself: a signed notice for B, downloaded and installed when nobody is using it.
    const env = { SARA_UPDATE_NOTICE_URL: base + 'update-notice.json', SARA_UPDATE_ASSET_BASE: base, SARA_UPDATE_KEY: pub, SARA_UPDATE_TICK_MS: '2000', SARA_UPDATE_QUIET_SECONDS: '0' };
    await startApp(1500, env, true);
    let updated = false;
    for (let i = 0; i < 240 && !updated; i++) {
      await sleep(1000);
      updated = query('HKCU', `{${TEST_APPID}}_is1`)?.DisplayVersion === B;
    }
    await sleep(8000); // the watcher starts the new app again
    const relaunched = testProcs().length > 0;
    killTestApps();
    await sleep(1000);
    s = snapshot(relaunched);
    const updLog = existsSync(join(DATA, 'desktop.log')) ? readFileSync(join(DATA, 'desktop.log'), 'utf8').split(/\r?\n/).filter((l) => /app update/.test(l)).slice(-3) : [];
    step('self-update', checkStep(s, { entries: 1, version: B, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline), [updated ? `updated ${A} → ${B} by itself` : `still ${s.hkcu?.DisplayVersion}`, relaunched ? 'started again after the update' : 'not started again', ...updLog.map((l) => l.replace(/^.*?app update: /, 'log: '))]);

    // 3. Silent reinstall of the same version: one entry, same address.
    const before = s.dataIni;
    code = runSetup(exe(B), setupArgs(log()));
    s = snapshot(await startApp());
    step('reinstall', checkStep(s, { entries: 1, version: B, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline), [`Setup exit ${code}`, s.dataIni?.includes(server) && before?.includes(server) ? 'server address kept' : 'server address changed']);

    // 4. Downgrade (rollback): an older Setup over the newer install.
    code = runSetup(exe(OLD), setupArgs(log()));
    s = snapshot(await startApp());
    step('downgrade', checkStep(s, { entries: 1, version: OLD, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline), [`Setup ${OLD} exit ${code}`, `now ${s.hkcu?.DisplayVersion ?? '-'}`]);

    // 5. A manual run of the downloaded Setup: no /MODE and no scope; it must keep "app only, this user".
    code = runSetup(exe(B), ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/LOG=${log()}`]);
    s = snapshot(await startApp());
    step('manual-setup', checkStep(s, { entries: 1, version: B, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline), [`Setup exit ${code} (shown, no switches)`, s.hklm ? 'installed for all users' : 'stayed per-user, app only']);

    // 6. A stale SaraDesktop entry (the pre-Setup app's own): only when there is none of the real kind.
    if (baseline.standalone) step('stale-saradesktop', [], ['skipped: this PC has a real SaraDesktop entry, never touched']);
    else {
      const stale = join(LOCAL, 'SaraUpdTest', 'stale-saradesktop');
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, 'Sara.exe'), 'not a program (U1.3 stale entry test)');
      const key = `HKCU\\${UNINSTALL}SaraDesktop`;
      reg(['add', key, '/v', 'DisplayName', '/d', 'Sara (U1.3 stale test)', '/f', '/reg:64']);
      reg(['add', key, '/v', 'InstallLocation', '/d', stale, '/f', '/reg:64']);
      madeStandalone = true;
      const started = await startApp();
      code = runSetup(exe(B), setupArgs(log()));
      s = snapshot(started);
      // The test build leaves the SaraDesktop entry alone by design (it may be a real one); the release
      // build's removal is covered by test/hankfix-install.test.ts.
      const p = checkStep(s, { entries: 1, version: B, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline);
      if (!s.standalone) p.push('the test build removed a SaraDesktop entry (it must leave it to the release build)');
      if (!existsSync(join(stale, 'Sara.exe'))) p.push("the test build deleted the stale entry's Sara.exe");
      step('stale-saradesktop', p, [`Setup exit ${code}`, s.standalone ? 'left alone by the test build (release-only cleanup)' : 'removed']);
      reg(['delete', key, '/f', '/reg:64']);
      madeStandalone = false;
      rmSync(stale, { recursive: true, force: true });
    }

    // 7. Uninstall keeping the data.
    await uninstall(['/KEEPDATA']);
    s = snapshot();
    step('uninstall-keepdata', checkStep(s, { entries: 0, files: [], noFiles: ['Sara.exe', 'Start-menu shortcut'], start: false, data: 'kept' }, baseline), [s.dataIni?.includes(server) ? 'desktop.ini kept with the server address' : 'desktop.ini lost']);

    // 8. Reinstall over the kept data (no /SERVER: the kept address is used), then the full uninstall.
    code = runSetup(exe(A), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/MODE=remote', '/CURRENTUSER', `/LOG=${log()}`]);
    const re = snapshot(await startApp());
    await uninstall([]);
    s = snapshot();
    const p8 = checkStep(re, { entries: 1, version: A, files: app, noFiles: noServer, start: true, data: 'kept' }, baseline).map((x) => 'reinstall: ' + x);
    p8.push(...checkStep(s, { entries: 0, files: [], noFiles: ['Sara.exe', 'unins000.exe', 'Start-menu shortcut'], start: false, data: 'gone' }, baseline));
    step('full-uninstall', p8, [`reinstall exit ${code}`, re.dataIni?.includes(server) ? 'reinstall picked up the kept address' : 'reinstall lost the address', existsSync(INSTALL) ? 'install folder left behind' : 'install folder gone']);
  } catch (e) {
    console.error((e as Error).message);
    results.push({ id: 'stopped', title: 'Run stopped', problems: [(e as Error).message], notes: [] });
  } finally {
    srv.close();
    killTestApps();
    if (madeStandalone) reg(['delete', `HKCU\\${UNINSTALL}SaraDesktop`, '/f', '/reg:64']), cleanup.push('removed the simulated SaraDesktop entry');
    if (query('HKCU', `{${TEST_APPID}}_is1`)) await uninstall([]), cleanup.push('uninstalled the leftover test install');
    for (const d of [INSTALL, join(LOCAL, 'SaraUpdTest')])
      if (existsSync(d)) rmSync(d, { recursive: true, force: true }), cleanup.push(`removed ${d.replace(LOCAL, '%LOCALAPPDATA%')}`);
    const end = snapshot();
    if (JSON.stringify([end.realHkcu, end.realHklm]) === JSON.stringify([baseline.realHkcu, baseline.realHklm])) cleanup.push("the real Sara's uninstall entries are as before the run");
    else cleanup.push("WARNING: the real Sara's uninstall entries differ from before the run");
  }
  const skipped = elevated ? [] : ADMIN_STEPS.map((s) => s.title);
  if (elevated) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'check-windows-install-admin.ps1'), '-Setups', setupsDir], { encoding: 'utf8', windowsHide: true });
    cleanup.push(`admin script exit ${r.status}: see outputs/checks/windows-admin-${date}.md`);
  }
  mkdirSync(resolve(report, '..'), { recursive: true });
  writeFileSync(report, renderReport({ date, elevated, versions: setups, results, skipped, cleanup }));
  console.log(`Report: ${report}`);
  return results.every((r) => r.problems.length === 0) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(e), process.exit(1)));
}
