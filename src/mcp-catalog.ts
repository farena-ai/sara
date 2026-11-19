// W3.2: a catalog of popular FREE MCP servers the owner can add with one click (Settings → Skills &
// tools → Other programs (MCP) → Popular free tool servers). Data plus three pure helpers: the
// config an install saves (sandboxed to the chosen folder, network off unless the server needs it),
// the approval card shown before it (exactly what it can do), and whether its runner is here.
// Installing goes through the normal mcpServers path (src/routes/admin.ts); per-tool permissions
// after install are the existing Tools and approvals choices. docs/design/W3MCP.md.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { ownNpx } from './browser-setup.ts';
import { en } from './i18n.ts';
import { mcpCacheEnv, windowsCommand, type McpServerConfig } from './tools/mcp.ts';

export interface CatalogItem {
  /** Also the server's name once installed. */
  id: string;
  name: string;
  summary: string;
  /** Source repository (where the code lives). */
  repo: string;
  license: string;
  /** npx / uvx run it on this computer; remote = a service on the internet (the person's own account). */
  runner: 'npx' | 'uvx' | 'remote';
  /** npm or PyPI package, pinned to `version` (never "latest"). */
  package?: string;
  version?: string;
  /** remote: the streamable HTTP address. */
  url?: string;
  /** The one folder (or database file) it may use; nothing else on the computer. */
  path?: 'folder' | 'file';
  /** Whether it needs the internet; false = it runs with the network off. */
  network: boolean;
  /** The person's own key, sent as a header (remote) or set in its environment. */
  secret?: { key: string; label: string; help: string; header?: string; prefix?: string };
  /** Fixed, public environment values. */
  env?: Record<string, string>;
  /** Plain words: what it can see and do. Shown on the approval card. */
  touches: string[];
  /** Extra arguments after the package (before the path). */
  args?: string[];
  /** How the path is passed: as the last argument (default) or after this flag. */
  pathFlag?: string;
}

const SERVERS = 'https://github.com/modelcontextprotocol/servers';
const MCP_LICENSE = 'Apache-2.0 / MIT';

export const MCP_CATALOG: readonly CatalogItem[] = [
  {
    id: 'filesystem', name: en('Files in one folder'), runner: 'npx', package: '@modelcontextprotocol/server-filesystem', version: '2.4.0',
    summary: en('Lets her read, search and edit the files in one folder you pick.'),
    repo: SERVERS, license: MCP_LICENSE, path: 'folder', network: false,
    touches: [en('Read, list and search the files in the folder you pick'), en('Create, edit and move files in that folder (each change asks you first)'), en('Nothing outside that folder')],
  },
  {
    id: 'git', name: en('Git history of one project'), runner: 'uvx', package: 'mcp-server-git', version: '2026.11.18', pathFlag: '--repository',
    summary: en('Lets her look at the history, changes and branches of one Git project.'),
    repo: SERVERS, license: MCP_LICENSE, path: 'folder', network: false,
    touches: [en('Read the history, changes and branches of the project folder you pick'), en('Stage and commit changes there (each change asks you first)'), en('No pushing: it has no internet')],
  },
  {
    id: 'fetch', name: en('Read web pages'), runner: 'uvx', package: 'mcp-server-fetch', version: '2026.11.18',
    summary: en('Lets her download a public web page and read it as text.'),
    repo: SERVERS, license: MCP_LICENSE, network: true,
    touches: [en('Download public web pages and turn them into text'), en('No access to your files')],
  },
  {
    id: 'sqlite', name: en('A SQLite database'), runner: 'uvx', package: 'mcp-server-sqlite', version: '2025.4.25', pathFlag: '--db-path',
    summary: en('Lets her look up and change data in one SQLite database file.'),
    repo: 'https://github.com/modelcontextprotocol/servers-archived', license: 'MIT', path: 'file', network: false,
    touches: [en('Read the tables in the database file you pick'), en('Change data in it (each change asks you first)'), en('Only that file\'s folder; no internet')],
  },
  {
    id: 'time', name: en('Time and time zones'), runner: 'uvx', package: 'mcp-server-time', version: '2026.11.18',
    summary: en('Tells the current time anywhere and converts between time zones.'),
    repo: SERVERS, license: MCP_LICENSE, network: false,
    touches: [en('Tell the time and convert time zones'), en('No access to your files and no internet')],
  },
  {
    id: 'memory', name: en('Notes graph'), runner: 'npx', package: '@modelcontextprotocol/server-memory', version: '2.2.1',
    summary: en('A small notes graph of people and things, kept in its own folder (separate from her memory).'),
    repo: SERVERS, license: MCP_LICENSE, network: false, env: { MEMORY_FILE_PATH: 'memory.jsonl' },
    touches: [en('Keep and change a notes graph in its own folder'), en('No access to your other files and no internet')],
  },
  {
    id: 'sequential-thinking', name: en('Step-by-step thinking'), runner: 'npx', package: '@modelcontextprotocol/server-sequential-thinking', version: '2.2.0',
    summary: en('Helps her plan hard problems in written steps.'),
    repo: SERVERS, license: MCP_LICENSE, network: false,
    touches: [en('Only writes down her thinking steps'), en('No access to your files and no internet')],
  },
  {
    id: 'playwright', name: en('Browser (Playwright)'), runner: 'npx', package: '@playwright/mcp', version: '0.0.86',
    summary: en('Opens web pages in a separate browser and clicks and types on them.'),
    repo: 'https://github.com/microsoft/playwright-mcp', license: 'Apache-2.0', network: true,
    touches: [en('Open web pages in a separate browser, click and type on them'), en('Downloads go to its own folder'), en('Not your own browser or its sign-ins')],
  },
  {
    id: 'github', name: 'GitHub', runner: 'remote', url: 'https://api.githubcopilot.com/mcp/',
    summary: en('Your repositories, issues and pull requests on GitHub, with your own token.'),
    repo: 'https://github.com/github/github-mcp-server', license: 'MIT', network: true,
    secret: { key: 'GITHUB_TOKEN', label: en('Your GitHub token'), help: en('Make a fine-grained token at github.com → Settings → Developer settings, with only the repositories and rights you want her to have.'), header: 'Authorization', prefix: 'Bearer ' },
    touches: [en('What your token allows: read repositories, issues and pull requests'), en('Open issues, pull requests and comments (each change asks you first)'), en('Runs on GitHub\'s servers, not on this computer')],
  },
];

export interface CatalogInput {
  /** The folder (or file) for items with `path`. */
  path?: string;
  /** The person's key for items with `secret`. */
  secret?: string;
}

/** A path the owner typed: absolute, not a drive or file-system root. Throws plain words. */
function cleanPath(item: CatalogItem, raw: unknown): string {
  const p = String(raw ?? '').trim().replace(/[\\/]+$/, '');
  const what = item.path === 'file' ? en('Pick the database file (its full path).') : en('Pick a folder (its full path), not a whole drive.');
  if (!p || !(isAbsolute(p) || win32.isAbsolute(p)) || /^([A-Za-z]:)?[\\/]*$/.test(p)) throw new Error(what);
  return p;
}

const spec = (item: CatalogItem) => (item.runner === 'uvx' ? `${item.package}==${item.version}` : `${item.package}@${item.version}`);

function argsOf(item: CatalogItem, path: string | undefined): string[] {
  const base = item.runner === 'npx' ? ['-y', spec(item)] : [spec(item)];
  const tail = path ? (item.pathFlag ? [item.pathFlag, path] : [path]) : [];
  return [...base, ...(item.args ?? []), ...tail];
}

/** The config, vault environment and headers an install saves. Throws plain words on a missing folder or key. */
export function catalogConfig(item: CatalogItem, input: CatalogInput): { cfg: McpServerConfig; env: Record<string, string>; headers: Record<string, string> } {
  const path = item.path ? cleanPath(item, input.path) : undefined;
  const secret = String(input.secret ?? '').trim();
  if (item.secret && !secret) throw new Error(en('Paste your token first: it is kept in her vault and only sent to this service.'));
  const headers: Record<string, string> = item.secret?.header && secret ? { [item.secret.header]: `${item.secret.prefix ?? ''}${secret}` } : {};
  const env: Record<string, string> = { ...(item.env ?? {}), ...(item.secret && !item.secret.header && secret ? { [item.secret.key]: secret } : {}) };
  if (item.runner === 'remote') return { cfg: { name: item.id, enabled: true, transport: 'http', url: item.url! }, env, headers };
  const folder = path ? (item.path === 'file' ? dirname(path) : path) : undefined;
  const cfg: McpServerConfig = { name: item.id, enabled: true, transport: 'stdio', command: item.runner, args: argsOf(item, path), ...(folder ? { folders: [folder] } : {}), ...(item.network ? {} : { network: false }) };
  return { cfg, env, headers };
}

export interface CatalogCard {
  id: string;
  name: string;
  /** The exact command (or address) that will run. */
  command: string;
  folder: string | null;
  network: boolean;
  touches: string[];
  repo: string;
  license: string;
  runner: CatalogItem['runner'];
  /** The key it needs (label only; the value is never on the card). */
  secret: string | null;
}

/** The approval card: exactly what the server can do, before anything is installed. Never holds a secret. */
export function catalogCard(item: CatalogItem, input: CatalogInput): CatalogCard {
  const { cfg } = catalogConfig(item, { ...input, ...(item.secret ? { secret: 'x' } : {}) });
  return {
    id: item.id,
    name: item.name,
    command: cfg.transport === 'http' ? cfg.url! : [cfg.command, ...(cfg.args ?? [])].join(' '),
    folder: cfg.folders?.[0] ?? null,
    network: item.network,
    touches: [...item.touches],
    repo: item.repo,
    license: item.license,
    runner: item.runner,
    secret: item.secret?.label ?? null,
  };
}

/** Whether the item's runner is on this computer (npx comes with Sara's own Node; remote needs nothing). */
export function runnerFound(runner: CatalogItem['runner'], pathVar: string = process.env.PATH ?? ''): boolean {
  if (runner === 'remote') return true;
  if (runner === 'npx' && ownNpx()) return true;
  const names = process.platform === 'win32' ? [`${runner}.exe`, `${runner}.cmd`, runner] : [runner];
  return pathVar.split(delimiter).filter(Boolean).some((d) => names.some((n) => existsSync(join(d, n))));
}

/** Seams for tests (no real downloads). */
export const catalogDeps = {
  /**
   * Fills a network-off server's package cache in its own folder once, with the network, so it can
   * then start offline (src/tools/mcp.ts mcpCacheEnv). Resolves with an error text or ''.
   */
  prefetch: (item: CatalogItem, dataDir: string): Promise<string> => prefetch(item, dataDir),
};

function prefetch(item: CatalogItem, dataDir: string): Promise<string> {
  if (item.runner === 'remote' || item.network) return Promise.resolve('');
  const home = join(dataDir, 'mcp', item.id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // npm: put the pinned package in the cache; uv: run its --help once (installs it into the cache).
  const [cmd, args] = item.runner === 'npx' ? ['npm', ['cache', 'add', spec(item)]] : ['uvx', [spec(item), '--help']];
  const env: NodeJS.ProcessEnv = { ...process.env, ...mcpCacheEnv(item.runner, home) };
  if (cmd === 'npm' && ownNpx()) env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`;
  const [file, argv] = windowsCommand(cmd, args, env.PATH);
  return new Promise((done) => {
    let err = '';
    const child = spawn(file, argv, { cwd: resolve(home), env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-400)));
    child.on('error', (e) => {
      clearTimeout(timer);
      done(e.message);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      done(code === 0 ? '' : err.trim().split('\n').pop() || `exit ${code}`);
    });
  });
}
