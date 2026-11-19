// W2.1: the install preflight. Checks disk, memory, port, OS version, CPU, an existing install,
// permissions and the network before anything is changed, and turns every problem into a fix-it
// card: what is wrong, why it matters, and the exact next step. The same checks (and limits) live in
// deploy/lib-preflight.sh for the Linux installers (Node isn't there yet when they start) and in
// desktop/windows/installer/sara.iss for Windows Setup; test/w2-install.test.ts keeps the limits equal.
//
//   node src/main.ts --preflight [--json] [--offline]     (Docker: docker compose run --rm sara node src/main.ts --preflight)
//
// Read-only: it never creates the data folder. Plain English like the rest of the command line.
import { accessSync, constants, existsSync, readFileSync, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch as osArch, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type PfId = 'disk' | 'ram' | 'ports' | 'os' | 'arch' | 'existing' | 'permissions' | 'network';
export type PfStatus = 'ok' | 'warn' | 'fail';
export interface PfCard {
  id: PfId;
  status: PfStatus;
  title: string;
  why: string;
  /** The exact next step (empty for a passing check). */
  fix: string;
}
export interface PfFacts {
  platform: NodeJS.Platform;
  /** node's os.arch(): x64, arm64, arm, ia32... */
  arch: string;
  /** linux: /etc/os-release ID; 'windows' / 'macos' elsewhere. */
  osId: string;
  /** linux: VERSION_ID; windows: os.release() (10.0.BUILD); macos: Darwin release (24.1.0). */
  osVersion: string;
  osName?: string;
  /** linux only: '' = not glibc (musl), undefined = unknown. */
  glibc?: string;
  freeBytes: number | null;
  dataDir: string;
  totalMem: number;
  port: number;
  portBusy: boolean | null;
  existing: 'none' | 'sara';
  writable: boolean | null;
  uid?: number;
  /** null = not checked (--offline). */
  network: { host: string; ok: boolean }[] | null;
  /** Downloads are needed (an installer), so no network is a failure, not a warning. */
  needNetwork?: boolean;
  docker: boolean;
}

/** Shared with deploy/lib-preflight.sh and sara.iss (test/w2-install.test.ts compares them). */
export const LIMITS = {
  diskFailMb: 1024,
  diskWarnMb: 3072,
  ramFailMb: 450,
  ramWarnMb: 1536,
  /** Windows 10 1809: the oldest build Node 24 and WebView2 both support. */
  minWindowsBuild: 17763,
  /** Darwin 22 = macOS 13 Ventura. */
  minDarwin: 22,
  minGlibc: '2.28',
};
/** Oldest supported release per Linux distribution (older ones still get a warning, not a stop). */
const MIN_OS: Record<string, number> = { ubuntu: 22.04, debian: 12, raspbian: 12, fedora: 39, almalinux: 9, rocky: 9, rhel: 9, centos: 9, ol: 9, opensuse: 15.5, 'opensuse-leap': 15.5 };

const mb = (b: number) => Math.round(b / 1024 / 1024);
const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
const verLess = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};
const ok = (id: PfId, title: string, why = ''): PfCard => ({ id, status: 'ok', title, why, fix: '' });

/** The card for a port that is taken: also shown when the server itself can't listen (EADDRINUSE). */
export function portInUseCard(port: number, where: 'docker' | 'windows' | 'mac' | 'linux' | 'other' = 'other'): PfCard {
  const next = port + 1;
  const fix = where === 'docker'
    ? `In docker-compose.yml change "ports:" to "${next}:7860" (or start with -p ${next}:7860), then docker compose up -d. To see what holds ${port}: docker ps.`
    : where === 'windows'
      ? `See what uses it: netstat -ano | findstr :${port}. Close that program, or start Sara on another port: set SARA_PORT=${next} (installer: choose another port).`
      : where === 'linux'
        ? `See what uses it: sudo ss -ltnp 'sport = :${port}'. Stop that program, or install on another port: --port ${next}.`
        : `See what uses it: lsof -i :${port}. Stop that program, or start Sara on another port: SARA_PORT=${next} node src/main.ts.`;
  return { id: 'ports', status: 'fail', title: `Port ${port} is already in use`, why: `Another program (maybe another Sara) is listening on port ${port}, so Sara can't use it.`, fix };
}

export function preflight(f: PfFacts): PfCard[] {
  const cards: PfCard[] = [];
  const where = f.docker ? 'docker' : f.platform === 'win32' ? 'windows' : f.platform === 'darwin' ? 'mac' : f.platform === 'linux' ? 'linux' : 'other';

  // CPU
  if (f.arch === 'x64' || f.arch === 'arm64') cards.push(ok('arch', `CPU: ${f.arch}`));
  else if (f.arch === 'arm' && f.platform === 'linux') {
    cards.push({ id: 'arch', status: 'fail', title: 'This is a 32-bit system', why: 'Sara needs a 64-bit system (Node.js 24 has no 32-bit ARM build). A Raspberry Pi 3, 4 or 5 can run 64-bit.', fix: 'Write "Raspberry Pi OS (64-bit)" to the card with Raspberry Pi Imager (Choose OS → Raspberry Pi OS (other)), boot it, then run the installer again.' });
  } else cards.push({ id: 'arch', status: 'fail', title: `Unsupported CPU: ${f.arch}`, why: 'Sara runs on 64-bit Intel/AMD (x86_64) and 64-bit ARM computers.', fix: 'Install her on a 64-bit computer or server instead (any PC from the last 15 years, a Raspberry Pi 4/5 with 64-bit Raspberry Pi OS, or a small cloud server).' });

  // OS version
  cards.push(osCard(f));

  // Memory
  const ram = mb(f.totalMem);
  if (ram < LIMITS.ramFailMb) cards.push({ id: 'ram', status: 'fail', title: 'Not enough memory', why: `This machine has ${ram} MB of memory; Sara needs at least ${LIMITS.ramFailMb} MB (2 GB or more is comfortable).`, fix: f.platform === 'linux' ? 'Use a machine with at least 1 GB of memory (a Raspberry Pi 4/5 with 2 GB or more, or a bigger cloud plan).' : 'Use a computer with at least 2 GB of memory.' });
  else if (ram < LIMITS.ramWarnMb) cards.push({ id: 'ram', status: 'warn', title: 'Memory is tight', why: `This machine has ${ram} MB of memory. Sara runs, but big imports and local voice may be slow or stop.`, fix: f.platform === 'linux' ? 'Add 2 GB of swap: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile (and add "/swapfile none swap sw 0 0" to /etc/fstab).' : 'Close other big programs while she works, or use a computer with more memory.' });
  else cards.push(ok('ram', `Memory: ${gb(f.totalMem)} GB`));

  // Disk
  if (f.freeBytes === null) cards.push({ id: 'disk', status: 'warn', title: 'Free disk space unknown', why: `Couldn't read the free space for ${f.dataDir}.`, fix: `Check by hand that at least ${LIMITS.diskFailMb / 1024} GB is free there (df -h, or File Explorer).` });
  else if (mb(f.freeBytes) < LIMITS.diskFailMb) cards.push({ id: 'disk', status: 'fail', title: 'Not enough free disk space', why: `${f.dataDir} has ${gb(f.freeBytes)} GB free; Sara needs at least ${LIMITS.diskFailMb / 1024} GB (${LIMITS.diskWarnMb / 1024} GB with local voice and backups).`, fix: diskFix(where) });
  else if (mb(f.freeBytes) < LIMITS.diskWarnMb) cards.push({ id: 'disk', status: 'warn', title: 'Disk space is low', why: `${f.dataDir} has ${gb(f.freeBytes)} GB free: enough to start, but backups and local voice need about ${LIMITS.diskWarnMb / 1024} GB.`, fix: diskFix(where) });
  else cards.push(ok('disk', `Disk: ${gb(f.freeBytes)} GB free`));

  // Existing install
  cards.push(f.existing === 'sara'
    ? ok('existing', 'Sara is already installed here', 'This updates her; her data stays where it is.')
    : ok('existing', 'No earlier install found'));

  // Port (her own running server on it is an update, not a clash)
  if (f.portBusy === true && f.existing !== 'sara') cards.push(portInUseCard(f.port, where));
  else if (f.portBusy === null) cards.push({ id: 'ports', status: 'warn', title: `Couldn't check port ${f.port}`, why: 'The check itself failed.', fix: `If Sara doesn't start, see what uses the port (${where === 'windows' ? `netstat -ano | findstr :${f.port}` : `ss -ltnp 'sport = :${f.port}'`}) and pick another one.` });
  else cards.push(ok('ports', `Port ${f.port} is free`));

  // Permissions (the data folder, or its nearest existing parent, must be writable)
  if (f.writable === false) {
    const fix = f.docker
      ? `On the computer that runs Docker: sudo chown -R ${f.uid ?? 1000} <the folder mounted at /data> (or leave out "user:" in docker-compose.yml), then docker compose up -d.`
      : where === 'windows'
        ? `Choose a data folder you own (for example under your user folder), or run the installer as administrator for an all-users install.`
        : `Run it with sudo, or make the folder yours: sudo chown -R "$USER" ${f.dataDir}`;
    cards.push({ id: 'permissions', status: 'fail', title: "Can't write to the data folder", why: `Sara keeps your data in ${f.dataDir}, and this user can't write there.`, fix });
  } else if (f.writable === null) cards.push({ id: 'permissions', status: 'warn', title: "Couldn't check the data folder", why: `Couldn't test writing to ${f.dataDir}.`, fix: 'If Sara stops at start with "permission denied", make that folder writable for her user.' });
  else cards.push(ok('permissions', `Data folder is writable (${f.dataDir})`));

  // Network
  if (f.network === null) cards.push(ok('network', 'Network not checked (offline)'));
  else {
    const down = f.network.filter((n) => !n.ok).map((n) => n.host);
    if (!down.length) cards.push(ok('network', 'Internet reachable'));
    else cards.push({
      id: 'network', status: f.needNetwork ? 'fail' : 'warn', title: `Can't reach ${down.join(', ')}`,
      why: f.needNetwork ? 'The installer downloads Node.js and Sara\'s parts from there.' : 'Sara runs without the internet (local models), but cloud models, updates and web search need it.',
      fix: 'Check the connection and DNS (try: curl -I https://registry.npmjs.org). Behind a proxy: export https_proxy=http://<proxy>:<port> before running it.',
    });
  }
  return cards;
}

function osCard(f: PfFacts): PfCard {
  const name = f.osName || `${f.osId} ${f.osVersion}`;
  if (f.platform === 'win32') {
    const build = Number(f.osVersion.split('.')[2] ?? 0);
    return build >= LIMITS.minWindowsBuild ? ok('os', `Windows build ${build}`) : { id: 'os', status: 'fail', title: 'Windows is too old', why: `This is Windows build ${build}; Sara needs Windows 10 version 1809 (build ${LIMITS.minWindowsBuild}) or newer.`, fix: 'Open Settings → Windows Update and install the updates (or the newest feature update), then run Setup again.' };
  }
  if (f.platform === 'darwin') {
    const major = Number(f.osVersion.split('.')[0] ?? 0);
    return major >= LIMITS.minDarwin ? ok('os', `macOS (Darwin ${f.osVersion})`) : { id: 'os', status: 'fail', title: 'macOS is too old', why: 'Sara needs macOS 13 Ventura or newer.', fix: 'Apple menu → System Settings → General → Software Update, then try again.' };
  }
  if (f.platform !== 'linux') return { id: 'os', status: 'warn', title: `Untested system: ${f.platform}`, why: 'Sara is tested on Linux, Windows and macOS.', fix: 'If something fails, use Docker Compose (docs/INSTALL.md, "Docker Compose").' };
  if (f.glibc === '') return { id: 'os', status: 'fail', title: `${name} isn't supported by the native installer`, why: 'It uses musl instead of glibc, and Sara\'s Node.js build needs glibc.', fix: 'Use Docker Compose on this machine (docs/INSTALL.md, "Docker Compose"), or a Debian/Ubuntu/Fedora system.' };
  if (f.glibc && verLess(f.glibc, LIMITS.minGlibc)) return { id: 'os', status: 'fail', title: `${name} is too old`, why: `Its C library (glibc ${f.glibc}) is older than the ${LIMITS.minGlibc} that Node.js 24 needs.`, fix: 'Upgrade the system (Ubuntu: sudo do-release-upgrade) or use a current release (Ubuntu 24.04, Debian 12), then run the installer again.' };
  const min = MIN_OS[f.osId];
  if (min !== undefined && Number.parseFloat(f.osVersion) < min) return { id: 'os', status: 'warn', title: `${name} is older than the tested releases`, why: `Sara is tested on ${f.osId} ${min} and newer; older ones usually work but aren't checked.`, fix: 'If something fails, upgrade the system or use Docker Compose.' };
  return ok('os', name);
}

function diskFix(where: string): string {
  if (where === 'windows') return 'Free space with Settings → System → Storage → Cleanup recommendations, or install to another drive, then run Setup again.';
  if (where === 'mac') return 'Free space with Apple menu → System Settings → General → Storage, then try again.';
  if (where === 'docker') return 'Free space on the Docker host (docker system prune removes unused images), or put the /data volume on a bigger disk.';
  return 'Free some space (sudo apt clean or sudo dnf clean all; sudo journalctl --vacuum-size=200M), or use a bigger disk, then run this again.';
}

export function preflightExit(cards: PfCard[]): 0 | 1 {
  return cards.some((c) => c.status === 'fail') ? 1 : 0;
}

/** Terminal text: a summary line, one line per passing check, a full card per problem. */
export function formatCards(cards: PfCard[]): string {
  const okN = cards.filter((c) => c.status === 'ok').length;
  const warnN = cards.filter((c) => c.status === 'warn').length;
  const failN = cards.filter((c) => c.status === 'fail').length;
  const lines = [`Preflight: ${okN} OK, ${warnN} to look at, ${failN} to fix`];
  for (const c of cards) {
    const mark = c.status === 'ok' ? 'OK  ' : c.status === 'warn' ? 'LOOK' : 'FIX ';
    lines.push(`  ${mark} ${c.title}`);
    if (c.status !== 'ok') {
      lines.push(`       ${c.why}`);
      lines.push(`       Next step: ${c.fix}`);
    }
  }
  if (failN) lines.push('Nothing was changed. Fix the items marked FIX, then run this again.');
  return lines.join('\n');
}

// ---- gathering the facts on this machine ------------------------------------------------------
function nearestExisting(p: string): string {
  let d = resolve(p);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}
function osRelease(): Record<string, string> {
  try {
    const o: Record<string, string> = {};
    for (const line of readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
      if (m) o[m[1]] = m[3];
    }
    return o;
  } catch {
    return {};
  }
}
function portBusy(port: number, host: string): Promise<boolean | null> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'EADDRINUSE' ? true : e.code === 'EACCES' ? true : null));
    s.listen(port, host, () => s.close(() => done(false)));
  });
}
async function reach(host: string): Promise<boolean> {
  try {
    // Through the guard like every outgoing request (private local mode refuses it: shown as down).
    const { netFetch } = await import('./net-guard.ts');
    await netFetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
    return true;
  } catch {
    return false;
  }
}

export async function gatherFacts(o: { dataDir: string; port: number; host?: string; offline?: boolean; env?: NodeJS.ProcessEnv }): Promise<PfFacts> {
  const env = o.env ?? process.env;
  const platform = process.platform;
  const rel = platform === 'linux' ? osRelease() : {};
  const glibc = platform === 'linux' ? ((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime ?? '') : undefined;
  const base = nearestExisting(o.dataDir);
  let freeBytes: number | null = null;
  try {
    const s = statfsSync(base);
    freeBytes = s.bavail * s.bsize;
  } catch {
    freeBytes = null;
  }
  let writable: boolean | null = null;
  try {
    accessSync(base, constants.W_OK);
    writable = true;
  } catch (e) {
    writable = (e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EROFS' ? false : null;
  }
  const docker = platform === 'linux' && (existsSync('/.dockerenv') || env.SARA_DOCKER === '1');
  return {
    platform, arch: osArch(),
    osId: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : rel.ID ?? platform,
    osVersion: platform === 'linux' ? rel.VERSION_ID ?? '' : release(),
    osName: rel.PRETTY_NAME,
    glibc,
    freeBytes, dataDir: o.dataDir, totalMem: totalmem(), port: o.port,
    portBusy: await portBusy(o.port, o.host ?? '127.0.0.1'),
    existing: existsSync(join(o.dataDir, 'owner.json')) ? 'sara' : 'none',
    writable, uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    network: o.offline ? null : await Promise.all(['registry.npmjs.org', 'github.com'].map(async (host) => ({ host, ok: await reach(host) }))),
    docker,
  };
}
