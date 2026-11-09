// PRQ (docs/ops/PRQ_DESIGN.md): approval first, owner only, policy (setting and EC5 pin), one audit
// row per outcome, private local mode asks for the internet, Stop and timeout settle, the re-check
// continues the store install. A fake runner and file system: nothing is installed.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { memberRouteCheck, type MemberRecord } from '../src/household.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { policy, PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { PrereqService, installerEnv, setPrereqOverrides, spawnStep, type InstallsSetting, type StepRunner } from '../src/prereqs/service.ts';
import { usePrereqService } from '../src/routes/prereqs.ts';
import { createSaraServer } from '../src/server.ts';
import { StoreInstaller } from '../src/store/install.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
setAuditTrail(new AuditTrail(dir, { key: () => 'k', policyRev: () => policy().get().rev }));
const pol = new PolicyStore(dir);
setPolicy(pol);
let base = '';

/** A fake Windows computer: files that exist, winget present, a runner that "installs" by adding files. */
function rig(o: { setting?: InstallsSetting; fromApp?: boolean; runner?: StepRunner; timeoutMs?: number; platform?: NodeJS.Platform } = {}) {
  const files = new Set<string>(['C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe']);
  const ran: string[][] = [];
  let setting: InstallsSetting | undefined = o.setting;
  const added: string[] = [];
  const svc = new PrereqService({
    platform: o.platform ?? 'win32',
    arch: 'x64',
    env: { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\o', SARA_TOKEN: 'never-passed', GITHUB_TOKEN: 'never-passed' },
    exists: (f) => files.has(f),
    list: () => [],
    version: () => undefined,
    tmpRoot: join(dir, 'cache', 'prereqs'),
    setting: () => (o.fromApp ? (app.settings.get() as { prereqs?: { installs?: InstallsSetting } }).prereqs?.installs : setting),
    addPath: (d) => added.push(d),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    runner:
      o.runner ??
      (async (argv, r) => {
        ran.push(argv);
        assert.doesNotMatch(JSON.stringify(r.env), /never-passed/, 'no secrets in the installer environment');
        r.onLine('Found Google Chrome [Google.Chrome]');
        r.onLine('Successfully installed');
        files.add('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
        files.add('C:\\Users\\o\\AppData\\Local\\Microsoft\\WinGet\\Links\\uvx.exe');
        return { code: 0 };
      }),
  });
  return { svc, files, ran, added, set: (v: InstallsSetting | undefined) => (setting = v) };
}
const rows = (target?: string) => auditTrail()!.list({ action: 'prereq.install' }).filter((r) => !target || r.target === target);

before(async () => {
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown; bearer?: string } = {}) =>
  fetch(base + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${o.bearer ?? token}`, origin: base, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });

test('prq service: the card comes first and names the exact command; nothing runs until approved', async () => {
  const r = rig();
  const st = r.svc.status(['chrome', 'docker']);
  assert.deepEqual(st.map((x) => [x.id, x.found, x.method]), [['chrome', false, 'winget'], ['docker', false, 'manual']]);
  const card = r.svc.propose('chrome');
  assert.ok('id' in card);
  assert.equal(card.source.ref, 'Google.Chrome');
  assert.equal(card.elevation, 'uac');
  assert.deepEqual(card.steps, [{ kind: 'run', line: 'C:\\Users\\o\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe install --id Google.Chrome --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity' }]);
  assert.equal(r.ran.length, 0, 'nothing ran before approve');
  const n = rows().length;
  const job = r.svc.approve(card.id);
  const done = await r.svc.settled(job.id);
  assert.equal(done?.state, 'ok');
  assert.equal(done?.found, true, 're-checked after the job');
  assert.deepEqual(r.ran[0].slice(1, 4), ['install', '--id', 'Google.Chrome']);
  assert.ok(done!.lines.includes('Successfully installed'));
  assert.deepEqual(r.added, ['C:\\Program Files\\Google\\Chrome\\Application'], 'a found folder off PATH is added to Sara\'s own PATH');
  const row = rows('chrome')[0];
  assert.equal(rows().length, n + 1, 'one audit row per install');
  assert.deepEqual([row.outcome, row.who, row.role, row.keys], ['ok', 'owner', 'owner', ['winget']]);
  // A used card can't run twice; an unknown id is refused before anything.
  assert.throws(() => r.svc.approve(card.id), /expired/);
  assert.throws(() => r.svc.propose('chrome && calc'), /does not know/);
  assert.throws(() => r.svc.propose('chrome'), /already/);
});

test('prq service: off refuses on the server (setting or EC5 pin) and writes a refused row', () => {
  const r = rig({ setting: 'off' });
  assert.throws(() => r.svc.propose('uv'), /off on this server/);
  assert.equal(rows('uv')[0].outcome, 'refused');
  r.set('allowed');
  const card = r.svc.propose('uv');
  pol.set({ name: 'House', pins: { programInstalls: 'off' } });
  try {
    assert.equal(r.svc.setting(), 'off', 'the pin beats the owner setting');
    assert.throws(() => r.svc.approve((card as { id: string }).id), /off on this server/, 'checked again at approve');
    pol.set({ name: 'House', pins: { programInstalls: 'ask' } });
    assert.equal(r.svc.setting(), 'ask', 'a pin only tightens: allowed becomes ask');
  } finally {
    pol.set({ name: 'House', pins: {} });
  }
  assert.equal(r.ran.length, 0);
});

test('prq service: private local mode says installing needs the internet and never bypasses the guard', async () => {
  const r = rig();
  setPrivateLocal(true);
  let card: { id: string; privateLocal: boolean };
  try {
    card = r.svc.propose('uv') as { id: string; privateLocal: boolean };
    assert.equal(card.privateLocal, true, 'the card says so before anything');
    assert.throws(() => r.svc.approve(card.id), /needs the internet/);
    assert.deepEqual([rows('uv')[0].outcome, rows('uv')[0].keys], ['refused', ['private']]);
    assert.equal(r.ran.length, 0);
  } finally {
    setPrivateLocal(false);
  }
  // Turned off for the install: the same card runs.
  const job = r.svc.approve(card.id);
  assert.equal((await r.svc.settled(job.id))?.state, 'ok');
});

test('prq service: Stop and the timeout end a hanging installer and settle', async () => {
  const hang: StepRunner = (_argv, o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve({ code: null, error: 'killed' }), { once: true }));
  const r = rig({ runner: hang });
  const job = r.svc.approve((r.svc.propose('ffmpeg') as { id: string }).id);
  assert.throws(() => r.svc.approve((r.svc.propose('python') as { id: string }).id), /Another program/);
  r.svc.stop(job.id);
  const s = await r.svc.settled(job.id);
  assert.equal(s?.state, 'stopped');
  assert.equal(s?.found, false);
  assert.ok(rows('ffmpeg')[0].keys?.includes('stopped'));
  const t = rig({ runner: hang, timeoutMs: 50 });
  const j2 = t.svc.approve((t.svc.propose('python') as { id: string }).id);
  assert.equal((await t.svc.settled(j2.id))?.state, 'timeout');
});

test('prq service: a failed step says why; downloads are checked against the pinned sha256', async () => {
  const fail = rig({ runner: async () => ({ code: 1603 }) });
  const j = fail.svc.approve((fail.svc.propose('blender') as { id: string }).id);
  const s = await fail.svc.settled(j.id);
  assert.deepEqual([s?.state, s?.error], ['failed', 'exit 1603']);
  assert.equal(rows('blender')[0].outcome, 'failed');
  // Linux as root: the uv archive with a wrong checksum stops before anything is unpacked.
  const ran: string[][] = [];
  const lx = new PrereqService({ platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin', HOME: '/root' }, exists: () => false, list: () => [], version: () => undefined, read: () => 'ID=fedora\n', isRoot: () => true, sudoOk: () => false, tmpRoot: join(dir, 'cache', 'prereqs'), setting: () => 'ask', runner: async (a) => (ran.push(a), { code: 0 }), fetch: async () => new Response('not the archive') });
  const card = lx.propose('uv') as { id: string; method: string; steps: { kind: string; sha256?: string }[] };
  assert.equal(card.method, 'download');
  assert.match(card.steps[0].sha256 ?? '', /^[0-9a-f]{64}$/);
  const lj = await lx.settled(lx.approve(card.id).id);
  assert.deepEqual([lj?.state, lj?.error], ['failed', 'checksum mismatch']);
  assert.equal(ran.length, 0, 'tar never ran');
});

test('prq service: Linux without root or sudo -n shows the commands instead of running', () => {
  const lx = new PrereqService({ platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin', HOME: '/home/o' }, exists: (f) => f === '/usr/bin/dnf', list: () => [], version: () => undefined, read: () => 'ID=fedora\n', isRoot: () => false, sudoOk: () => false, tmpRoot: join(dir, 'cache', 'prereqs'), setting: () => 'ask' });
  const out = lx.propose('docker') as { manual?: { reason: string; lines: string[] } };
  assert.equal(out.manual?.reason, 'no-root');
  assert.ok(out.manual?.lines.includes('sudo dnf install -y moby-engine'));
  const user = lx.propose('uv') as { userInstall?: boolean; steps: { kind: string; line?: string }[] };
  assert.equal(user.userInstall, true, 'uv goes to ~/.local/bin without root');
  assert.ok(user.steps.every((s) => !s.line?.startsWith('sudo')));
  const sudo = new PrereqService({ platform: 'linux', arch: 'x64', env: { PATH: '/usr/bin', HOME: '/home/o' }, exists: (f) => f === '/usr/bin/dnf', list: () => [], version: () => undefined, read: () => 'ID=fedora\n', isRoot: () => false, sudoOk: () => true, tmpRoot: join(dir, 'cache', 'prereqs'), setting: () => 'ask' });
  const c = sudo.propose('docker') as { elevation: string; steps: { line: string }[] };
  assert.equal(c.elevation, 'sudo');
  assert.equal(c.steps[0].line, 'sudo -n dnf install -y moby-engine');
});

test('prq service: the real step runner streams lines, uses no shell, and Stop ends a running process at once', async () => {
  const lines: string[] = [];
  const ctl = new AbortController();
  const ok = await spawnStep([process.execPath, '-e', 'console.log("one"); console.error("two")'], { cwd: dir, env: installerEnv(process.env), signal: ctl.signal, onLine: (l) => lines.push(l) });
  assert.equal(ok.code, 0);
  assert.deepEqual(lines.sort(), ['one', 'two']);
  const meta = await spawnStep([process.execPath, '-e', 'console.log(process.argv[1])', 'a && echo b; $(x)'], { cwd: dir, env: {}, signal: ctl.signal, onLine: (l) => lines.push(l) });
  assert.equal(meta.code, 0);
  assert.equal(lines.at(-1), 'a && echo b; $(x)', 'arguments reach the program literally');
  const t0 = Date.now();
  const run = spawnStep([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { cwd: dir, env: {}, signal: ctl.signal, onLine: () => {} });
  setTimeout(() => ctl.abort(), 300);
  const stopped = await run;
  assert.notEqual(stopped.code, 0);
  assert.ok(Date.now() - t0 < 5000, 'stopped within seconds');
  assert.deepEqual(await spawnStep([process.execPath], { cwd: dir, env: {}, signal: ctl.signal, onLine: () => {} }), { code: null, error: 'stopped' }, 'nothing starts after Stop');
});

test('prq service: the installer environment drops secrets and Sara\'s own variables', () => {
  assert.deepEqual(Object.keys(installerEnv({ PATH: 'x', SARA_DATA: 'd', OPENAI_API_KEY: 'k', GH_TOKEN: 't', HOME: 'h', DB_PASSWORD: 'p' })).sort(), ['HOME', 'PATH']);
});

test('prq routes: owner only (member, device code, demo refused); settings respect the pin', async () => {
  const r = rig({ fromApp: true });
  usePrereqService(app, r.svc);
  const st = await (await req('/api/prereqs?ids=chrome,uv,nope')).json();
  assert.deepEqual(st.programs.map((p: { id: string }) => p.id), ['chrome', 'uv']);
  assert.equal(st.installs, 'ask');
  const dev = auth.createDeviceToken('Terminal');
  assert.equal((await req('/api/prereqs', { bearer: dev.token })).status, 403);
  assert.equal((await req('/api/prereqs/chrome/plan', { method: 'POST', body: {}, bearer: dev.token })).status, 403);
  const rec = { id: 'm1', name: 'Kim', status: 'active', limits: { voice: true, pictures: true, models: [] } } as unknown as MemberRecord;
  assert.equal(memberRouteCheck(rec, 'POST', ['prereqs', 'chrome', 'plan'])?.status, 403);
  const demo = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>((ok) => demo.listen(0, '127.0.0.1', ok));
  try {
    const db = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${db}/api/prereqs/chrome/plan`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: db }, body: '{}' })).status, 403);
  } finally {
    demo.close();
  }
  assert.equal((await req('/api/prereqs/settings', { method: 'PUT', body: { installs: 'sometimes' } })).status, 400);
  assert.equal((await (await req('/api/prereqs/settings', { method: 'PUT', body: { installs: 'off' } })).json()).installs, 'off');
  const off = await req('/api/prereqs/chrome/plan', { method: 'POST', body: {} });
  assert.equal(off.status, 409);
  assert.equal((await off.json()).code, 'policy');
  pol.set({ name: 'House', pins: { programInstalls: 'ask' } });
  try {
    assert.equal((await req('/api/prereqs/settings', { method: 'PUT', body: { installs: 'allowed' } })).status, 409, 'the pin refuses loosening');
    assert.equal((await (await req('/api/prereqs/settings', { method: 'PUT', body: { installs: 'ask' } })).json()).pinned, true);
  } finally {
    pol.set({ name: 'House', pins: {} });
  }
  // Ask: the card, then Run; Allowed: the one click starts the job.
  const card = (await (await req('/api/prereqs/chrome/plan', { method: 'POST', body: {} })).json()).card;
  assert.ok(card.id);
  const started = (await (await req(`/api/prereqs/plans/${card.id}/approve`, { method: 'POST', body: {} })).json()).job;
  await r.svc.settled(started.id);
  const view = (await (await req(`/api/prereqs/jobs/${started.id}`)).json()).job;
  assert.deepEqual([view.state, view.found], ['ok', true]);
  await req('/api/prereqs/settings', { method: 'PUT', body: { installs: 'allowed' } });
  const one = await (await req('/api/prereqs/python/plan', { method: 'POST', body: {} })).json();
  assert.ok(one.job?.id, 'allowed: one click runs');
  await r.svc.settled(one.job.id);
  assert.equal((await req('/api/prereqs/jobs/nope/stop', { method: 'POST', body: {} })).status, 404);
});

test('prq store: the card offers the missing program; after the install the re-check continues the add-on install', async () => {
  const r = rig();
  const recipe = { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.84'], name: 'playwright', fields: [], secrets: [], reaches: ['the web pages she opens'], tools: { readOnly: [], ask: [] }, needs: ['node', 'app:Google Chrome'], guide: [] };
  const entry = { name: 'Browser (Playwright)', mcp: recipe, tested: [] };
  const upserts: unknown[] = [];
  const ins = new StoreInstaller({ app, client: { entry: async () => entry } as never, installs: { get: () => undefined, upsert: (x: unknown) => upserts.push(x) } as never, programs: r.svc });
  r.files.add('C:\\Program Files\\nodejs\\node.exe');
  r.files.add('C:\\Program Files\\nodejs\\npx.cmd');
  const review = await ins.mcpReview({ id: 'playwright', trust: 'first-party' } as never, { version: '1.0.1', entrySha: 'x' } as never);
  assert.deepEqual(review.needs, [{ what: 'node', found: true, program: 'node' }, { what: 'app:Google Chrome', found: false, program: 'chrome' }]);
  const card = r.svc.propose(review.needs[1].program!) as { id: string };
  await r.svc.settled(r.svc.approve(card.id).id);
  const again = ins.mcpRecheck(review.id);
  assert.equal(again?.needs[1].found, true, 'Chrome found on the re-check');
  const done = await ins.mcpApprove(review.id, { trust: true });
  assert.equal(done.server, 'playwright', 'Continue install adds the tool server');
  assert.equal(upserts.length, 1);
  assert.equal(ins.mcpRecheck('gone'), undefined);
});

test('prq store: an install card built without the server\'s service (a companion\'s suggested add-on, a plugin\'s Store install) still detects Chrome through the catalog, on Linux too, never found: null', async () => {
  const recipe = { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.84'], name: 'playwright', fields: [], secrets: [], reaches: ['the web pages she opens'], tools: { readOnly: [], ask: [] }, needs: ['node', 'app:Google Chrome'], guide: [] };
  const entry = { name: 'Browser (Playwright)', mcp: recipe, tested: [] };
  // A fake Linux computer (the throwaway-instance hook): only these files exist.
  const files = new Set<string>();
  setPrereqOverrides({ exists: (f) => files.has(f.replace(/\\/g, '/')), list: () => [] });
  try {
    const card = async () => {
      const ins = new StoreInstaller({ app, client: { entry: async () => entry } as never, installs: { get: () => undefined, upsert: () => {} } as never, platform: 'linux', pathVar: '/usr/local/bin:/usr/bin' });
      return (await ins.mcpReview({ id: 'playwright', trust: 'first-party' } as never, { version: '1.0.1', entrySha: 'x' } as never)).needs.find((n) => n.what === 'app:Google Chrome');
    };
    assert.deepEqual(await card(), { what: 'app:Google Chrome', found: false, program: 'chrome' }, 'not there: false, with the catalog program (Install it for me)');
    files.add('/opt/google/chrome/chrome');
    assert.deepEqual(await card(), { what: 'app:Google Chrome', found: true, program: 'chrome' }, "Google's package folder");
    files.clear();
    files.add('/usr/bin/google-chrome-stable');
    assert.deepEqual(await card(), { what: 'app:Google Chrome', found: true, program: 'chrome' }, 'google-chrome-stable on PATH');
  } finally {
    setPrereqOverrides({});
  }
});
