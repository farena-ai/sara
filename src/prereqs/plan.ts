// PRQ: the exact steps that would install one catalog program on this computer, or the manual
// steps when Sara can't (no winget/Homebrew, no root or password-less sudo, link-only, unsupported
// system). Pure: the environment is passed in, so every OS and package manager is testable here.
import type { Arch, LinuxPm, LinuxRecipe, Os, Program, ProgramId, Step } from './catalog.ts';

export interface PlanEnv {
  platform: Os | string;
  arch: string;
  home: string;
  /** Linux: os-release ID + ID_LIKE, and the package manager found. */
  linux?: { ids: string[]; pm: LinuxPm | null };
  root: boolean;
  /** `sudo -n true` worked (no password prompt). */
  sudo: boolean;
  winget: string | null;
  brew: string | null;
}

export type PlanStep =
  | { kind: 'run'; argv: string[] }
  | { kind: 'download'; url: string; sha256?: string; file: string; maxBytes: number }
  | { kind: 'file'; file: string; text: string };
export type Method = 'winget' | 'brew' | LinuxPm | 'download' | 'manual';
export type ManualReason = 'no-winget' | 'no-brew' | 'link-only' | 'unsupported' | 'no-package' | 'no-root' | 'arch';

export interface InstallPlan {
  program: ProgramId;
  name: string;
  method: Method;
  /** What the installer is, as data the page puts in words (e.g. winget + Google.Chrome). */
  source: { kind: Method; ref: string };
  steps: PlanStep[];
  /** uac: Windows may ask; root: Sara runs as root; sudo: through sudo -n; none. */
  elevation: 'uac' | 'root' | 'sudo' | 'none';
  /** Installed into the user's own folders (no root). */
  userInstall?: boolean;
  manual?: { reason: ManualReason; url: string; lines: string[] };
  after?: Program['after'];
}

const SAFE = /^[\w@%+=:,./-]+$/;
/** POSIX quoting for display and manual steps (never passed to a shell by Sara). */
export const shellQuote = (a: string): string => (a && SAFE.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const shellLine = (argv: readonly string[]): string => argv.map(shellQuote).join(' ');
/** Windows display form (cmd quoting). */
export const winLine = (argv: readonly string[]): string => argv.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)).join(' ');

/** The package manager from /etc/os-release and the commands present. */
export function linuxSystem(osRelease: string, has: (cmd: string) => boolean): { ids: string[]; pm: LinuxPm | null } {
  const field = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(osRelease)?.[1] ?? '').replace(/^["']|["']$/g, '').toLowerCase();
  const ids = [field('ID'), ...field('ID_LIKE').split(/\s+/)].filter(Boolean);
  const is = (...names: string[]) => ids.some((i) => names.includes(i));
  let pm: LinuxPm | null = null;
  if (is('debian', 'ubuntu') && has('apt-get')) pm = 'apt';
  else if (is('fedora', 'rhel', 'centos') && has('dnf')) pm = 'dnf';
  else if (is('fedora', 'rhel', 'centos') && has('yum')) pm = 'yum';
  else if (is('suse', 'opensuse', 'sles', 'opensuse-leap', 'opensuse-tumbleweed') && has('zypper')) pm = 'zypper';
  else if (is('arch', 'manjaro', 'endeavouros') && has('pacman')) pm = 'pacman';
  return { ids, pm };
}

const WINGET_FLAGS = ['--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
const MANUAL_TMP = '/tmp/sara-prq';

function manual(p: Program, reason: ManualReason, lines: string[] = []): InstallPlan {
  return { program: p.id, name: p.name, method: 'manual', source: { kind: 'manual', ref: p.url }, steps: [], elevation: 'none', manual: { reason, url: p.url, lines }, ...(p.after ? { after: p.after } : {}) };
}

function archOf(a: string): Arch | undefined {
  return a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : undefined;
}

/** Catalog steps with {home}, {arch} and {uvtriple} filled; {tmp} stays for the runner. */
function resolve(steps: Step[], arch: Arch, home: string, sudo: boolean): PlanStep[] | undefined {
  const fill = (s: string) => s.replace(/\{home\}/g, home).replace(/\{arch\}/g, arch).replace(/\{uvtriple\}/g, arch === 'x64' ? 'x86_64-unknown-linux-gnu' : 'aarch64-unknown-linux-gnu');
  const out: PlanStep[] = [];
  for (const s of steps) {
    if (s.kind === 'run') out.push({ kind: 'run', argv: [...(s.root && sudo ? ['sudo', '-n'] : []), ...s.argv.map(fill)] });
    else if (s.kind === 'file') out.push({ kind: 'file', file: s.file, text: s.text });
    else {
      const url = s.url[arch];
      if (!url) return undefined;
      const sha = s.sha256?.[arch];
      out.push({ kind: 'download', url, ...(sha ? { sha256: sha } : {}), file: s.file, maxBytes: s.maxMB * 1024 * 1024 });
    }
  }
  return out;
}

/** The lines an owner pastes when Sara can't run it (root steps with sudo). */
export function manualLines(steps: PlanStep[]): string[] {
  const lines: string[] = [`mkdir -p ${MANUAL_TMP}`];
  for (const s of steps) {
    if (s.kind === 'run') lines.push(shellLine(s.argv.map((a) => a.replace(/\{tmp\}/g, MANUAL_TMP))));
    else if (s.kind === 'download') {
      lines.push(shellLine(['curl', '-fL', '-o', `${MANUAL_TMP}/${s.file}`, s.url]));
      if (s.sha256) lines.push(`echo ${shellQuote(`${s.sha256}  ${MANUAL_TMP}/${s.file}`)} | sha256sum -c -`);
    } else lines.push(`cat > ${MANUAL_TMP}/${s.file} <<'EOF'\n${s.text.replace(/\n$/, '')}\nEOF`);
  }
  return lines;
}

export function installPlan(p: Program, env: PlanEnv): InstallPlan {
  const after = p.after ? { after: p.after } : {};
  if (env.platform === 'win32') {
    if (p.linkOnly?.includes('win32')) return manual(p, 'link-only');
    if (!p.winget) return manual(p, 'no-package');
    if (!env.winget) return manual(p, 'no-winget', [winLine(['winget', 'install', '--id', p.winget, ...WINGET_FLAGS.slice(0, 3)])]);
    return { program: p.id, name: p.name, method: 'winget', source: { kind: 'winget', ref: p.winget }, steps: [{ kind: 'run', argv: [env.winget, 'install', '--id', p.winget, ...WINGET_FLAGS] }], elevation: 'uac', ...after };
  }
  if (env.platform === 'darwin') {
    if (p.linkOnly?.includes('darwin')) return manual(p, 'link-only');
    if (!p.brew) return manual(p, 'no-package');
    const args = ['install', ...(p.brew.cask ? ['--cask'] : []), p.brew.name];
    if (!env.brew) return manual(p, 'no-brew', [shellLine(['brew', ...args])]);
    return { program: p.id, name: p.name, method: 'brew', source: { kind: 'brew', ref: p.brew.cask ? `--cask ${p.brew.name}` : p.brew.name }, steps: [{ kind: 'run', argv: [env.brew, ...args] }], elevation: 'none', ...after };
  }
  if (env.platform !== 'linux' || !env.linux) return manual(p, 'unsupported');
  const pm = env.linux.pm;
  const pick = (r?: LinuxRecipe) => (r && (!r.only || r.only.includes(env.linux!.ids[0] ?? '')) ? r : undefined);
  const recipe = (pm ? pick(p.linux?.[pm]) : undefined) ?? pick(p.linux?.any);
  if (!recipe) return manual(p, pm ? 'no-package' : 'unsupported');
  const arch = archOf(env.arch);
  if (!arch || (recipe.arches && !recipe.arches.includes(arch))) return manual(p, 'arch');
  const method: Method = recipe === p.linux?.any ? 'download' : pm!;
  const ref = recipe.steps.find((s): s is Extract<Step, { kind: 'download' }> => s.kind === 'download' && Boolean(s.sha256))?.url[arch] ?? (method === 'download' ? p.url : (recipe.steps.filter((s) => s.kind === 'run').at(-1) as { argv: string[] } | undefined)?.argv.at(-1) ?? p.id);
  const base = { program: p.id, name: p.name, method, source: { kind: method, ref }, ...after };
  if (env.root) {
    const steps = resolve(recipe.steps, arch, env.home, false);
    return steps ? { ...base, steps, elevation: 'root' } : manual(p, 'arch');
  }
  if (env.sudo) {
    const steps = resolve(recipe.steps, arch, env.home, true);
    return steps ? { ...base, steps, elevation: 'sudo' } : manual(p, 'arch');
  }
  if (recipe.user) {
    const steps = resolve(recipe.user, arch, env.home, false);
    if (steps) return { ...base, steps, elevation: 'none', userInstall: true };
  }
  const shown = resolve(recipe.steps, arch, env.home, false) ?? [];
  // No root and no password-less sudo: the exact commands for the owner, root steps with sudo.
  const withSudo = shown.map((s, i) => (s.kind === 'run' && (recipe.steps[i] as { root?: boolean }).root ? { ...s, argv: ['sudo', ...s.argv] } : s));
  return manual(p, 'no-root', manualLines(withSudo));
}
