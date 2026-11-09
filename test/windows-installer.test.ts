// Phase 46c: the Windows installer's pieces that run on any system: the `sara` command's settings
// file handling, the ways to reach her, Tailscale serve ports, the admin hints the web app shows,
// the clean stop the Windows service host relies on, and the installer files themselves.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adminHelp } from '../src/platform.ts';
import { accessEnv, cleanDomain, formatLogLine, parseEnv, pickServePort, serveIsOurs, updateEnv, validDomain, validPort } from '../src/sara-windows.ts';
import { ROOT, tempDir } from './helpers.ts';

test('sara.env: read with comments, quotes and a BOM; updated in place, unknown keys kept', () => {
  const text = '\uFEFF# Sara settings\r\nSARA_MODE=service\r\nSARA_DATA="C:\\ProgramData\\Sara"\r\nSARA_OWN=keep me\r\nSARA_PORT=7860\r\n';
  assert.deepEqual(parseEnv(text), { SARA_MODE: 'service', SARA_DATA: 'C:\\ProgramData\\Sara', SARA_OWN: 'keep me', SARA_PORT: '7860' });
  const out = updateEnv(text, { SARA_PORT: '7871', SARA_ACCESS: 'local', SARA_TS_HTTPS_PORT: undefined, SARA_MODE: undefined });
  assert.equal(out, '# Sara settings\r\nSARA_DATA="C:\\ProgramData\\Sara"\r\nSARA_OWN=keep me\r\nSARA_PORT=7871\r\nSARA_ACCESS=local\r\n');
  assert.deepEqual(parseEnv(updateEnv('', { A: '1' })), { A: '1' });
});

test('ways to reach her: the right host, cookies, proxy trust and address for each', () => {
  assert.deepEqual(accessEnv({ mode: 'local', port: 7860 }), { SARA_PORT: '7860', SARA_ACCESS: 'local', SARA_TS_HTTPS_PORT: undefined, SARA_HOST: '127.0.0.1', SARA_SECURE_COOKIES: '0', SARA_TRUST_PROXY: '0', SARA_PUBLIC_URL: 'http://127.0.0.1:7860' });
  const lan = accessEnv({ mode: 'lan', port: 7860, lanIp: '192.168.1.20' });
  assert.equal(lan.SARA_HOST, '0.0.0.0', 'every address, so the app on this computer keeps 127.0.0.1');
  assert.equal(lan.SARA_PUBLIC_URL, 'http://192.168.1.20:7860');
  assert.throws(() => accessEnv({ mode: 'lan', port: 7860 }), /home network/);
  const tsDefault = accessEnv({ mode: 'tailscale', port: 7860, tsName: 'pc.tail1234.ts.net', tsPort: 443 });
  assert.equal(tsDefault.SARA_PUBLIC_URL, 'https://pc.tail1234.ts.net');
  assert.equal(tsDefault.SARA_SECURE_COOKIES, '1');
  assert.equal(tsDefault.SARA_TRUST_PROXY, '1');
  assert.equal(tsDefault.SARA_HOST, '127.0.0.1');
  assert.equal(accessEnv({ mode: 'tailscale', port: 7860, tsName: 'pc.tail1234.ts.net', tsPort: 10443 }).SARA_PUBLIC_URL, 'https://pc.tail1234.ts.net:10443');
  assert.equal(accessEnv({ mode: 'domain', port: 7860, domain: 'sara.example.com' }).SARA_PUBLIC_URL, 'https://sara.example.com');
  assert.throws(() => accessEnv({ mode: 'domain', port: 7860, domain: 'not a domain' }), /web address/);
  assert.equal(cleanDomain(' HTTPS://Sara.Example.com/ '), 'sara.example.com');
  assert.ok(validDomain('sara.example.com') && !validDomain('localhost') && !validDomain('a b.com'));
  assert.ok(validPort(7860) && validPort('65535') && !validPort(80) && !validPort('7860x') && !validPort(70000));
});

test("tailscale serve: 443 when free, never someone else's port, her own entry reused", () => {
  const name = 'pc.tail1234.ts.net';
  const target = 'http://127.0.0.1:7860';
  assert.deepEqual(pickServePort('{}', name, target), { port: 443, ours: false });
  assert.deepEqual(pickServePort('', name, target), { port: 443, ours: false });
  const busy = JSON.stringify({
    TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '11434': { TCPForward: '127.0.0.1:11434' } },
    Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } }, [`${name}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9001' } } } },
  });
  assert.deepEqual(pickServePort(busy, name, target), { port: 10443, ours: false }, "the owner's 443 and 8443 stay as they are");
  const mine = JSON.stringify({ TCP: { '443': { HTTPS: true }, '10443': { HTTPS: true } }, Web: { [`${name}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } }, [`${name}:10443`]: { Handlers: { '/': { Proxy: `${target}/` } } } } });
  assert.deepEqual(pickServePort(mine, name, target), { port: 10443, ours: true });
  assert.equal(serveIsOurs(mine, 10443, target), true);
  assert.equal(serveIsOurs(mine, 443, target), false, 'turning off only touches her own port');
  assert.equal(serveIsOurs('not json', 443, target), false);
});

test('sara logs: JSON log lines read as plain text', () => {
  assert.equal(formatLogLine('{"t":"2026-10-27T03:47:46.000Z","level":"warn","msg":"Hello"}'), '2026-10-27 03:47:46 WARN  Hello');
  assert.equal(formatLogLine('2026-10-26 22:47:45 [service] Started Sara'), '2026-10-26 22:47:45 [service] Started Sara');
});

test('admin hints in the web app follow the system she runs on', () => {
  const win = adminHelp({ platform: 'win32', env: { SARA_INSTALLED: '1' } });
  assert.equal(win.system, 'Windows');
  assert.equal(win.resetToken, 'sara reset-token');
  assert.equal(win.doctor, 'sara doctor');
  assert.equal(win.restore, 'sara restore <file>');
  assert.match(win.update, /installer/);
  assert.doesNotMatch(JSON.stringify(win), /sudo|journalctl|install-agents/);
  const linux = adminHelp({ platform: 'linux', env: {}, exists: (p) => p === '/usr/local/bin/sara' });
  assert.equal(linux.resetToken, 'sudo sara reset-token');
  assert.equal(linux.update, 'sudo sara update');
  assert.match(linux.agents, /install-agents/);
  const docker = adminHelp({ platform: 'linux', env: { SARA_DATA: '/data' }, exists: () => false });
  assert.match(docker.resetToken, /^docker compose exec sara/);
  assert.match(docker.update, /docker compose pull/);
  const mac = adminHelp({ platform: 'darwin', env: { SARA_INSTALLED: '1' } });
  assert.match(mac.resetToken, /sara reset-token$/);
  assert.match(mac.update, /macOS/);
  assert.equal(adminHelp({ platform: 'win32', env: {} }).resetToken, 'node src/main.ts --reset-token');
});

test('web: no Linux-only admin commands left without the system-aware hint', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  for (const key of ['doctor', 'resetToken', 'restore', 'update']) assert.match(html, new RegExp(`data-admin="${key}"`), key);
  // Every `sudo sara …` in the settings pages sits in an element the app rewrites, or names Linux.
  // (The fallback shown before the app knows the system is in data-admin-when="unknown".)
  const settings = html.slice(html.indexOf('<dialog id="settings"')).replace(/<span data-admin-when="unknown">[\s\S]*?<\/span><\/p>/g, '');
  for (const m of settings.matchAll(/<code([^>]*)>sudo sara [^<]*<\/code>/g)) assert.match(m[1], /data-admin=/, m[0]);
  assert.doesNotMatch(app, /run deploy\/install-agents\.sh\)/);
  assert.match(app, /applyAdminHelp\(s\.admin\)/);
});

test('the service host stops her cleanly by closing her stdin (SARA_STOP_ON_STDIN_END)', async (t) => {
  const tmp = tempDir();
  const data = tmp.dir;
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'main.ts')], {
    cwd: ROOT,
    env: { ...process.env, SARA_DATA: data, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_STOP_ON_STDIN_END: '1' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  t.after(() => {
    child.kill();
    tmp.cleanup();
  });
  let up = false;
  // Generous: on a loaded machine (the whole suite running) her start can take a while.
  for (let i = 0; i < 240 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(up, 'she answered');
  assert.ok(existsSync(join(data, 'first-token.txt')), 'the installer can show the first token from her data folder');
  const started = Date.now();
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  child.stdin!.end();
  const code = await exited;
  assert.equal(code, 0, 'a clean exit, not a kill');
  assert.ok(Date.now() - started < 10_000, 'within the service host\'s 20 s');
});

test('installer files: pinned downloads, every question and silent switch, data kept by default', () => {
  const dir = join(ROOT, 'desktop', 'windows');
  const build = readFileSync(join(dir, 'build-installer.sh'), 'utf8');
  assert.match(build, /NODE_VER=24\.22\.1/);
  assert.match(build, /NODE_SHA=[0-9a-f]{64}/);
  assert.match(build, /INNO_SHA=[0-9a-f]{64}/);
  assert.match(build, /sha256sum -c/);
  const install = readFileSync(join(ROOT, 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /24\.22\.1/, 'the same Node version as the Linux installer');
  const iss = readFileSync(join(dir, 'installer', 'sara.iss'), 'utf8');
  for (const p of ['{param:ACCESS|}', '{param:PORT|7860}', '{param:DOMAIN|}', '{param:DATA|}', '{param:MODE|}', '{param:DELETEDATA|0}']) assert.ok(iss.includes(p), p);
  // Phase 55: Setup starts per-user so its first question comes before any administrator prompt;
  // the service (still the recommended answer) starts Setup again elevated with /ALLUSERS.
  assert.match(iss, /PrivilegesRequired=lowest/);
  assert.match(iss, /PrivilegesRequiredOverridesAllowed=commandline/);
  assert.match(iss, /RunPage\.Add\('From when the computer starts, as a Windows service \(recommended; needs an administrator\)'\)/);
  assert.match(iss, /ShellExec\('runas', ExpandConstant\('\{srcexe\}'\), '\/ALLUSERS \/MODE=service'/);
  assert.match(iss, /she asks you before every command/);
  assert.match(iss, /Also delete her data \(a last backup goes to your Desktop first\)/);
  assert.match(iss, /'--backup'/, 'a backup before an update replaces anything');
  assert.match(iss, /NT SERVICE\\Sara:\(OI\)\(CI\)M/);
  // M5: a pre-made data folder owned by someone else is moved aside; ownership taken, protected list.
  assert.match(iss, /\/setowner \*S-1-5-32-544 \/T/);
  assert.match(iss, /\/inheritance:r \/grant:r "\*S-1-5-18:\(OI\)\(CI\)F" "\*S-1-5-32-544:\(OI\)\(CI\)F"/);
  assert.match(iss, /'\\Sara-untrusted-' \+ GetDateTimeString/);
  assert.match(iss, /Result := PrepareServiceDataDir;/);
  const svc = readFileSync(join(dir, 'src', 'service.cpp'), 'utf8');
  for (const s of ['SERVICE_CONTROL_STOP', 'SERVICE_CONTROL_SHUTDOWN', 'NT SERVICE\\\\Sara', 'SERVICE_CONFIG_DELAYED_AUTO_START_INFO', 'SERVICE_CONFIG_FAILURE_ACTIONS', 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'SARA_STOP_ON_STDIN_END']) assert.ok(svc.includes(s), s);
  assert.match(readFileSync(join(dir, 'installer', 'sara.cmd'), 'utf8'), /sara-windows\.ts/);
});

// ---- Phase 55: "Connect to a Sara somewhere else" (the app only) ----

/** The [Section] of sara.iss, up to the next section. */
function section(iss: string, name: string): string {
  const start = iss.indexOf(`[${name}]`);
  assert.ok(start >= 0, name);
  const next = iss.indexOf('\n[', start + 1);
  return iss.slice(start, next < 0 ? undefined : next);
}

test('installer: the first question, worded for beginners, and the remote page', () => {
  const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
  assert.match(iss, /'How do you want to use Sara\?'/);
  assert.match(iss, /UseRadio\(UsePage, 'Run Sara on this computer'/);
  assert.match(iss, /UseRadio\(UsePage, 'Connect to a Sara somewhere else'/);
  assert.match(iss, /DisableWelcomePage=yes/, 'the first page is the question');
  assert.match(iss, /'Where is your Sara\?'/);
  assert.match(iss, /sara\.example\.com/);
  assert.match(iss, /Settings → Connections → Devices and sign-in → Add a phone or computer/, 'the finished page says what to do next');
  // Silent: /MODE=remote /SERVER=<address>, checked; never with /ALLUSERS.
  assert.ok(iss.includes("{param:SERVER|}"));
  assert.match(iss, /\/MODE=remote needs \/SERVER=<address>/);
  assert.match(iss, /\/MODE=remote installs only the app for you: leave out \/ALLUSERS/);
  assert.match(iss, /\/MODE must be service, user or remote/);
});

test('installer: remote mode installs only the app (no server, Node, service, PATH, data or firewall)', () => {
  const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
  const files = section(iss, 'Files').split('\n').filter((l) => l.startsWith('Source:'));
  for (const l of files) {
    if (/Sara\.exe"; DestDir/.test(l) || /dontcopy/.test(l)) continue;
    assert.match(l, /Check: not IsRemote$/, `only on a server install: ${l}`);
  }
  assert.ok(files.some((l) => /\\Sara\.exe"; DestDir: "\{app\}"; Flags: ignoreversion$/.test(l)), 'the app in both modes');
  for (const f of ['SaraService.exe"; DestDir', 'node\\node.exe', 'bin\\sara.cmd', 'server\\*']) assert.ok(files.some((l) => l.includes(f) && l.endsWith('Check: not IsRemote')), f);
  assert.match(section(iss, 'Registry'), /"Sara server".*Check: \(not IsAdminInstallMode\) and \(not IsRemote\)/);
  assert.match(section(iss, 'Run'), /Parameters: "\{code:OpenParams\}"/);
  const code = iss.slice(iss.indexOf('[Code]'));
  // The post-install step returns before the server setup (sara.env, service, PATH, firewall).
  const post = code.slice(code.indexOf('procedure CurStepChanged'));
  const remote = post.indexOf('SetUpRemoteApp(App);');
  assert.ok(remote > 0 && remote < post.indexOf('sara-windows.ts') && remote < post.indexOf('AddToPath') && remote < post.indexOf('--install-service'));
  assert.match(post.slice(remote, remote + 40), /SetUpRemoteApp\(App\);\s+exit;/);
  // PrepareToInstall: the remote branch exits before backups, data folders and ports.
  const prep = code.slice(code.indexOf('function PrepareToInstall'));
  assert.ok(prep.indexOf('if IsRemote then begin') < prep.indexOf('PrepareServiceDataDir'));
  // Where Sara.exe reads its address, with a first start straight to pairing.
  assert.match(code, /SetIniString\('sara', 'server', Srv, AppIni\)/);
  assert.match(code, /SetIniString\('sara', 'pairNext', '1', AppIni\)/);
  assert.match(code, /SetPreviousData\(PreviousDataKey, 'Mode', ChosenMode\)/, 'updates keep the mode');
  // Uninstall: the app only; no data checkbox, no server commands, no PATH change.
  assert.match(code, /function UninstallingAppOnly/);
  assert.match(code, /Box\.Visible := not UninstallingAppOnly/);
  assert.match(code, /DeleteData := \(ExpandConstant\('\{param:DELETEDATA\|0\}'\) = '1'\) and not UninstallingAppOnly/);
  assert.match(code, /if not UninstallingAppOnly then begin\s+\/\/ Out of Tailscale serve/);
});

test('installer and apps: the same address rule (https unless home network, IP or localhost)', () => {
  const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
  const cpp = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'main.cpp'), 'utf8');
  const swift = readFileSync(join(ROOT, 'desktop', 'mac', 'Sources', 'main.swift'), 'utf8');
  assert.match(iss, /if \(Name = 'localhost'\) or IsIPv4\(Name\) or .*'\.local'\)+ then Sch := 'http'/);
  assert.match(cpp, /static bool plainHttpHost/);
  assert.match(cpp, /\(plainHttpHost\(host\) \? L"http:\/\/" : L"https:\/\/"\)/);
  assert.match(swift, /func plainHTTPHost/);
  assert.match(swift, /\(plainHTTPHost\(host\) \? "http:\/\/" : "https:\/\/"\)/);
});

test('Windows app: several servers, each in its own WebView2 profile; removing one clears only its sign-in; a clear unreachable page', () => {
  const cpp = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'main.cpp'), 'utf8');
  // Phase 68: "Add a Sara…" replaces "Connect to a different Sara…" (which signed out of the old one).
  assert.match(cpp, /L"Add a Sara…"/);
  assert.doesNotMatch(cpp, /Connect to a different Sara/);
  assert.match(cpp, /case ID_CHANGE: changeServerFromMenu\(\)/);
  // s1 keeps the default profile (the sign-in from before 1.8); the others get their own.
  assert.match(cpp, /g_profile != L"s1"[\s\S]{0,400}put_ProfileName\(\(L"sara-" \+ g_profile\)/);
  assert.match(cpp, /static void migrateProfiles\(\)/);
  const remove = cpp.slice(cpp.indexOf('static void finishRemove()'), cpp.indexOf('static void removeServer('));
  assert.match(remove, /ClearBrowsingDataAll/);
  assert.match(cpp, /fetch\('\/api\/logout',\{method:'POST',headers:\{'content-type':'application\/json'\}/, 'signs out on the server first');
  assert.match(cpp, /<h1>Can't reach your Sara<\/h1>/);
  assert.match(cpp, /id=s>Add a Sara<\/button>/);
  assert.match(cpp, /htmlEscape\(g_server\)/, 'the address is shown');
  assert.doesNotMatch(cpp, /AppendMenuW\([^)]*L"(Start|Stop|Logs)/, 'no server items in the tray menu');
  assert.match(cpp, /installedBySetup\(\)/);
  // The page only gets names and hosts.
  const json = cpp.slice(cpp.indexOf('static std::wstring serversJson()'), cpp.indexOf('// ---------- start with Windows'));
  assert.doesNotMatch(json, /jsonEscape\(p\.url\)/);
  assert.match(json, /hostOfUrl\(p\.url\)/);
});

test('Mac: no LaunchDaemon left; the two choices and switching both ways', () => {
  const mac = join(ROOT, 'desktop', 'mac');
  assert.ok(!existsSync(join(mac, 'LaunchDaemon.plist')));
  const build = readFileSync(join(mac, 'build.sh'), 'utf8');
  assert.doesNotMatch(build, /LaunchDaemon/i);
  const server = readFileSync(join(mac, 'Sources', 'Server.swift'), 'utf8');
  const setup = readFileSync(join(mac, 'Sources', 'Setup.swift'), 'utf8');
  const main = readFileSync(join(mac, 'Sources', 'main.swift'), 'utf8');
  const all = server + setup + main;
  assert.doesNotMatch(all, /RunMode|case daemon|runDaemon|setuid|initgroups|SecStaticCode|"From startup, even before/);
  // Only the migration still names the old daemon: unregister it, move to the agent.
  assert.match(server, /func migrateFromDaemon\(\)/);
  assert.match(server, /SMAppService\.daemon\(plistName: legacyDaemonPlistName\)/);
  assert.match(server, /if getuid\(\) == 0 \{[\s\S]{0,400}exit\(0\)/, 'refuses to run as root');
  assert.match(server, /\(--mode daemon\) was removed/);
  assert.match(setup, /Run Sara on this Mac/);
  assert.match(setup, /Connect to a Sara somewhere else/);
  // Phase 68: the saved servers and "Add a Sara…" (Servers.swift) replace "Connect to a different Sara…".
  const servers = readFileSync(join(mac, 'Sources', 'Servers.swift'), 'utf8');
  assert.match(servers, /"Add a Sara…"/);
  assert.match(setup, /addServerItems\(to: m\)/);
  assert.match(servers, /WKWebsiteDataStore\(forIdentifier: uuid\)/);
  assert.match(setup, /"Set up Sara on this Mac…"/);
  assert.match(setup, /"Connect to a Sara somewhere else instead…"/);
  assert.match(setup, /Her data stays in ~\/Library\/Application Support\/Sara until you uninstall with sara uninstall --delete-data/);
  assert.match(main, /<h1>Can't reach your Sara<\/h1>/);
});
