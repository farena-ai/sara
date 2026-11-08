// PRQ (docs/ops/PRQ_DESIGN.md): the programs add-ons need on the computer where Sara runs, how to
// find them and how each platform's normal installer gets them. Declarative on purpose: every
// command, package name, URL and checksum Sara may ever use for an install is a constant here, and
// requests only ever name a program id from this list.

export type ProgramId = 'chrome' | 'uv' | 'docker' | 'node' | 'python' | 'blender' | 'ffmpeg';
export type Os = 'win32' | 'darwin' | 'linux';
export type LinuxPm = 'apt' | 'dnf' | 'yum' | 'zypper' | 'pacman';
export type Arch = 'x64' | 'arm64';

/** One install step. Tokens: `{tmp}` the job's temp folder, `{home}` the user's home, `{arch}` x64|arm64, `{uvtriple}` uv's archive name. */
export type Step =
  | { kind: 'run'; argv: string[]; root?: boolean }
  | { kind: 'download'; url: Partial<Record<Arch, string>>; sha256?: Partial<Record<Arch, string>>; file: string; maxMB: number }
  | { kind: 'file'; file: string; text: string };

export interface LinuxRecipe {
  /** Steps as root (or through `sudo -n`). */
  steps: Step[];
  /** Steps without root at all (into the user's own folders), when that works. */
  user?: Step[];
  /** Only on these distributions (os-release ID or ID_LIKE). */
  only?: string[];
  arches?: Arch[];
}

export interface Program {
  id: ProgramId;
  name: string;
  /** The vendor's own page (manual steps link here). */
  url: string;
  detect: {
    /** Command names on PATH (any one); `with` must sit in the same folder. */
    commands: string[];
    with?: string[];
    /** Known install places per OS (one `*` segment allowed). Tokens: {ProgramFiles} {ProgramFiles(x86)} {LOCALAPPDATA} {USERPROFILE} {HOME}. */
    paths: Partial<Record<Os, string[]>>;
    version?: { args: string[]; re: RegExp; min?: string };
  };
  winget?: string;
  brew?: { name: string; cask?: boolean };
  linux?: Partial<Record<LinuxPm, LinuxRecipe>> & { any?: LinuxRecipe };
  /** Install it yourself here (Sara only links out): Docker Desktop needs its licence and a restart. */
  linkOnly?: Os[];
  /** A step after the program itself (said in the app, never run). */
  after?: 'blender-addon' | 'docker-group' | 'docker-start';
}

const GOOGLE_KEY = 'https://dl.google.com/linux/linux_signing_key.pub';
const UV_VERSION = '0.13.7';
const NODE_VERSION = 'v24.22.2';
const WINGET_LINKS = '{LOCALAPPDATA}\\Microsoft\\WinGet\\Links';

const apt = (...pkgs: string[]): LinuxRecipe => ({ steps: [{ kind: 'run', argv: ['apt-get', 'update'], root: true }, { kind: 'run', argv: ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', ...pkgs], root: true }] });
const dnf = (pkg: string, only?: string[]): LinuxRecipe => ({ steps: [{ kind: 'run', argv: ['dnf', 'install', '-y', pkg], root: true }], ...(only ? { only } : {}) });
const yum = (pkg: string, only?: string[]): LinuxRecipe => ({ steps: [{ kind: 'run', argv: ['yum', 'install', '-y', pkg], root: true }], ...(only ? { only } : {}) });
const zypper = (pkg: string): LinuxRecipe => ({ steps: [{ kind: 'run', argv: ['zypper', '--non-interactive', 'install', pkg], root: true }] });
const pacman = (pkg: string): LinuxRecipe => ({ steps: [{ kind: 'run', argv: ['pacman', '-S', '--noconfirm', '--needed', pkg], root: true }] });

const CHROME_RPM_REPO = `[google-chrome]\nname=google-chrome\nbaseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64\nenabled=1\ngpgcheck=1\ngpgkey=${GOOGLE_KEY}\n`;
const chromeRpm = (pm: 'dnf' | 'yum' | 'zypper'): LinuxRecipe => ({
  arches: ['x64'],
  steps: [
    { kind: 'file', file: 'google-chrome.repo', text: CHROME_RPM_REPO },
    { kind: 'run', argv: ['install', '-m', '0644', '{tmp}/google-chrome.repo', pm === 'zypper' ? '/etc/zypp/repos.d/google-chrome.repo' : '/etc/yum.repos.d/google-chrome.repo'], root: true },
    ...(pm === 'zypper' ? [{ kind: 'run' as const, argv: ['rpm', '--import', GOOGLE_KEY], root: true }, { kind: 'run' as const, argv: ['zypper', '--non-interactive', 'install', 'google-chrome-stable'], root: true }] : [{ kind: 'run' as const, argv: [pm, 'install', '-y', 'google-chrome-stable'], root: true }]),
  ],
});

/** Pinned vendor archives (checked against these sha256 before anything is unpacked). */
const UV_ARCHIVE: Step = {
  kind: 'download',
  url: { x64: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`, arm64: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz` },
  sha256: { x64: 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83', arm64: '71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc' },
  file: 'uv.tar.gz',
  maxMB: 80,
};
const NODE_ARCHIVE: Step = {
  kind: 'download',
  url: { x64: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz`, arm64: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.gz` },
  sha256: { x64: '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9', arm64: '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2' },
  file: 'node.tar.gz',
  maxMB: 120,
};
const untar = (file: string): Step => ({ kind: 'run', argv: ['tar', '-xzf', `{tmp}/${file}`, '-C', '{tmp}'] });
const uvInto = (dir: string, root: boolean): Step[] => [
  ...(root ? [] : [{ kind: 'run' as const, argv: ['mkdir', '-p', dir] }]),
  ...['uv', 'uvx'].map((b): Step => ({ kind: 'run', argv: ['install', '-m', '0755', `{tmp}/uv-{uvtriple}/${b}`, `${dir}/${b}`], ...(root ? { root } : {}) })),
];
const nodeInto = (lib: string, bin: string, root: boolean): Step[] => [
  { kind: 'run', argv: ['mkdir', '-p', lib, bin], ...(root ? { root } : {}) },
  { kind: 'run', argv: ['cp', '-R', `{tmp}/node-${NODE_VERSION}-linux-{arch}/.`, `${lib}/`], ...(root ? { root } : {}) },
  ...['node', 'npm', 'npx'].map((b): Step => ({ kind: 'run', argv: ['ln', '-sf', `${lib}/bin/${b}`, `${bin}/${b}`], ...(root ? { root } : {}) })),
];

export const PROGRAMS: readonly Program[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    url: 'https://www.google.com/chrome/',
    detect: {
      commands: ['google-chrome-stable', 'google-chrome'],
      paths: {
        win32: ['{ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe', '{ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe', '{LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe'],
        darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '{HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        linux: ['/opt/google/chrome/chrome'],
      },
    },
    winget: 'Google.Chrome',
    brew: { name: 'google-chrome', cask: true },
    linux: {
      apt: {
        arches: ['x64'],
        steps: [
          { kind: 'download', url: { x64: GOOGLE_KEY }, file: 'google-chrome.asc', maxMB: 1 },
          { kind: 'file', file: 'google-chrome.list', text: 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main\n' },
          { kind: 'run', argv: ['install', '-D', '-m', '0644', '{tmp}/google-chrome.asc', '/etc/apt/keyrings/google-chrome.asc'], root: true },
          { kind: 'run', argv: ['install', '-m', '0644', '{tmp}/google-chrome.list', '/etc/apt/sources.list.d/google-chrome.list'], root: true },
          { kind: 'run', argv: ['apt-get', 'update'], root: true },
          { kind: 'run', argv: ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'google-chrome-stable'], root: true },
        ],
      },
      dnf: chromeRpm('dnf'),
      yum: chromeRpm('yum'),
      zypper: chromeRpm('zypper'),
    },
  },
  {
    id: 'uv',
    name: 'uv',
    url: 'https://docs.astral.sh/uv/getting-started/installation/',
    detect: {
      commands: ['uvx'],
      paths: {
        win32: ['{USERPROFILE}\\.local\\bin\\uvx.exe', `${WINGET_LINKS}\\uvx.exe`],
        darwin: ['/opt/homebrew/bin/uvx', '/usr/local/bin/uvx', '{HOME}/.local/bin/uvx'],
        linux: ['/usr/local/bin/uvx', '{HOME}/.local/bin/uvx'],
      },
      version: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
    },
    winget: 'astral-sh.uv',
    brew: { name: 'uv' },
    linux: { any: { steps: [UV_ARCHIVE, untar('uv.tar.gz'), ...uvInto('/usr/local/bin', true)], user: [UV_ARCHIVE, untar('uv.tar.gz'), ...uvInto('{home}/.local/bin', false)] } },
  },
  {
    id: 'docker',
    name: 'Docker',
    url: 'https://docs.docker.com/get-started/get-docker/',
    detect: {
      commands: ['docker'],
      paths: { win32: ['{ProgramFiles}\\Docker\\Docker\\resources\\bin\\docker.exe'], darwin: ['/usr/local/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'], linux: ['/usr/bin/docker'] },
      version: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
    },
    winget: 'Docker.DockerDesktop',
    linkOnly: ['win32', 'darwin'],
    linux: {
      apt: { steps: [...apt('docker.io').steps, { kind: 'run', argv: ['systemctl', 'enable', '--now', 'docker'], root: true }] },
      dnf: { only: ['fedora'], steps: [{ kind: 'run', argv: ['dnf', 'install', '-y', 'moby-engine'], root: true }, { kind: 'run', argv: ['systemctl', 'enable', '--now', 'docker'], root: true }] },
      zypper: { steps: [{ kind: 'run', argv: ['zypper', '--non-interactive', 'install', 'docker'], root: true }, { kind: 'run', argv: ['systemctl', 'enable', '--now', 'docker'], root: true }] },
      pacman: { steps: [{ kind: 'run', argv: ['pacman', '-S', '--noconfirm', '--needed', 'docker'], root: true }, { kind: 'run', argv: ['systemctl', 'enable', '--now', 'docker'], root: true }] },
    },
    after: 'docker-group',
  },
  {
    id: 'node',
    name: 'Node.js',
    url: 'https://nodejs.org/en/download',
    detect: {
      commands: ['node'],
      with: ['npx'],
      paths: { win32: ['{ProgramFiles}\\nodejs\\node.exe'], darwin: ['/opt/homebrew/bin/node', '/usr/local/bin/node'], linux: ['/usr/local/bin/node', '{HOME}/.local/bin/node'] },
      version: { args: ['--version'], re: /v?(\d+\.\d+\.\d+)/, min: '22.0.0' },
    },
    winget: 'OpenJS.NodeJS.LTS',
    brew: { name: 'node' },
    linux: { any: { steps: [NODE_ARCHIVE, untar('node.tar.gz'), ...nodeInto('/usr/local/lib/sara-node', '/usr/local/bin', true)], user: [NODE_ARCHIVE, untar('node.tar.gz'), ...nodeInto('{home}/.local/lib/sara-node', '{home}/.local/bin', false)] } },
  },
  {
    id: 'python',
    name: 'Python',
    url: 'https://www.python.org/downloads/',
    detect: {
      commands: ['python3', 'python'],
      paths: { win32: ['{LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe', '{ProgramFiles}\\Python312\\python.exe'], darwin: ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'], linux: ['/usr/bin/python3'] },
      version: { args: ['--version'], re: /Python (\d+\.\d+\.\d+)/, min: '3.10.0' },
    },
    winget: 'Python.Python.3.12',
    brew: { name: 'python@3.12' },
    linux: { apt: apt('python3', 'python3-venv'), dnf: dnf('python3'), yum: yum('python3'), zypper: zypper('python3'), pacman: pacman('python') },
  },
  {
    id: 'blender',
    name: 'Blender',
    url: 'https://www.blender.org/download/',
    detect: {
      commands: ['blender'],
      paths: { win32: ['{ProgramFiles}\\Blender Foundation\\*\\blender.exe'], darwin: ['/Applications/Blender.app/Contents/MacOS/Blender'], linux: ['/usr/bin/blender', '/snap/bin/blender'] },
    },
    winget: 'BlenderFoundation.Blender',
    brew: { name: 'blender', cask: true },
    linux: { apt: apt('blender'), dnf: dnf('blender', ['fedora']), zypper: zypper('blender'), pacman: pacman('blender') },
    after: 'blender-addon',
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    url: 'https://ffmpeg.org/download.html',
    detect: {
      commands: ['ffmpeg'],
      paths: { win32: [`${WINGET_LINKS}\\ffmpeg.exe`], darwin: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'], linux: ['/usr/bin/ffmpeg'] },
      version: { args: ['-version'], re: /ffmpeg version n?(\d+(?:\.\d+)*)/ },
    },
    winget: 'Gyan.FFmpeg',
    brew: { name: 'ffmpeg' },
    linux: { apt: apt('ffmpeg'), dnf: dnf('ffmpeg-free', ['fedora']), pacman: pacman('ffmpeg') },
  },
];

export const PROGRAM_IDS: readonly ProgramId[] = PROGRAMS.map((p) => p.id);
export const isProgramId = (v: unknown): v is ProgramId => typeof v === 'string' && (PROGRAM_IDS as readonly string[]).includes(v);
export const program = (id: ProgramId): Program => PROGRAMS.find((p) => p.id === id)!;

/**
 * A recipe's `needs` token (or its stdio command) as a program id. Store recipes already say
 * `node`, `uv`, `docker`, `app:Google Chrome`, `app:Blender with the add-on running`; no new
 * recipe field is needed (older Saras reject unknown recipe keys).
 */
export function programFor(token: string): ProgramId | undefined {
  const t = token.trim().toLowerCase();
  if (t === 'npx' || t === 'node' || t === 'nodejs' || t === 'npm') return 'node';
  if (t === 'uv' || t === 'uvx') return 'uv';
  if (t === 'docker') return 'docker';
  if (t === 'python' || t === 'python3') return 'python';
  if (t === 'ffmpeg') return 'ffmpeg';
  if (t === 'blender' || t.startsWith('app:blender')) return 'blender';
  if (t === 'chrome' || t.startsWith('app:google chrome') || t === 'app:chrome') return 'chrome';
  return undefined;
}
