// Phase 52: starter projects. "Build me a Telegram bot / landing page / API" begins from a small,
// tested template (templates/starters/<name>/) copied into the workspace; its own tests then run
// as a background job, so she starts from something that works and says so with a receipt.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppContext } from './chat.ts';
import { shq } from './tools/coding.ts';
import { str, ToolError, type Tool } from './tools/types.ts';
import { resolveInside, workspaceDir, workspacesBase } from './tools/workspace.ts';

export const STARTERS_DIR = resolve(import.meta.dirname, '..', 'templates', 'starters');

export interface Starter {
  name: string;
  title: string;
  description: string;
  language: string;
  /** The command that runs its tests (inside the project folder). */
  test: string;
  /** How to start it. */
  run: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Project folder names: letters, digits, dot, dash, underscore; no leading dot. */
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function listStarters(dir = STARTERS_DIR, platform = process.platform): Starter[] {
  if (!existsSync(dir)) return [];
  const out: Starter[] = [];
  const nativePython = (command: string) => platform === 'win32' ? command.replace(/^python3(?=\s|$)/, 'python') : command;
  for (const name of readdirSync(dir).sort()) {
    if (!NAME_RE.test(name)) continue;
    const meta = join(dir, name, 'starter.json');
    if (!existsSync(meta)) continue;
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8')) as Partial<Starter>;
      out.push({ name, title: String(m.title ?? name), description: String(m.description ?? ''), language: String(m.language ?? ''), test: nativePython(String(m.test ?? 'node --test')), run: nativePython(String(m.run ?? '')) });
    } catch {
      /* a broken template is left out */
    }
  }
  return out;
}

/** Text files get the project name filled in (`__PROJECT_NAME__`). */
const TEXT = /\.(js|mjs|cjs|ts|json|md|html|css|svg|txt|py|toml|yml|yaml)$/i;

function fillNames(dir: string, project: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) fillNames(p, project);
    else if (e.isFile() && TEXT.test(e.name) && statSync(p).size < 1_000_000) {
      const s = readFileSync(p, 'utf8');
      if (s.includes('__PROJECT_NAME__')) writeFileSync(p, s.replaceAll('__PROJECT_NAME__', project));
    }
  }
}

/** The npm-safe form of a project name (package.json "name"). */
export const packageName = (project: string) => project.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'my-project';

/**
 * Copies a starter into `<workspace>/<project>`. Refuses an existing folder (nothing is
 * overwritten). Returns the folder (absolute) and the starter.
 */
export function copyStarter(wsDir: string, name: string, project: string, dir = STARTERS_DIR): { folder: string; starter: Starter } {
  const starter = listStarters(dir).find((s) => s.name === name);
  if (!starter) {
    const names = listStarters(dir).map((s) => s.name);
    throw new ToolError(names.length ? `No starter called "${name}". There are: ${names.join(', ')}.` : 'The starter templates are not installed on this server.');
  }
  if (!PROJECT_RE.test(project)) throw new ToolError('Name the project folder with letters, digits, dots, dashes or underscores (up to 64), e.g. "weather-bot".');
  const folder = resolveInside(wsDir, project);
  if (existsSync(folder)) throw new ToolError(`There is already a "${project}" in this workspace. Pick another name.`);
  cpSync(join(dir, name), folder, { recursive: true, errorOnExist: true, force: false, filter: (src) => !/starter\.json$/.test(src) });
  fillNames(folder, project);
  // package.json names must be lower case without spaces.
  const pkg = join(folder, 'package.json');
  if (existsSync(pkg)) {
    const s = readFileSync(pkg, 'utf8');
    writeFileSync(pkg, s.replace(/"name": "([^"]*)"/, (_m, n: string) => `"name": "${packageName(n)}"`).replace(/("bin": \{\s*")([^"]*)(")/, (_m, a: string, n: string, b: string) => `${a}${packageName(n)}${b}`));
  }
  return { folder, starter };
}

/** Copies a starter and runs its tests as a background job in the conversation. */
export function createFromStarter(app: AppContext, opts: { conversationId: string; workspace?: string; name: string; project: string }): { folder: string; starter: Starter; jobId: number | null; message: string } {
  const conv = app.store.getConversation(opts.conversationId);
  if (!conv) throw new ToolError('No conversation for this project.');
  const ws = opts.workspace || conv.workspace;
  let wsDir: string;
  try {
    wsDir = workspaceDir(workspacesBase(app), ws);
  } catch {
    throw new ToolError(`"${ws}" isn't a workspace name.`);
  }
  const { folder, starter } = copyStarter(wsDir, opts.name, opts.project);
  let jobId: number | null = null;
  let note = '';
  if (app.jobs) {
    try {
      // The server's own Node runs the tests (a service user may not have `node` on its PATH).
      const test = starter.test.replace(/^node(?=\s)/, shq(process.execPath.replace(/\\/g, '/')));
      const { job } = app.jobs.start({ conversationId: conv.id, workspace: ws, label: `tests of the new ${starter.title.toLowerCase()} (${opts.project})`, command: `cd ${shq(opts.project)} && ${test}`, timeoutMs: 5 * 60_000 });
      jobId = job.id;
    } catch (err) {
      note = ` (The tests didn't start: ${(err as Error).message})`;
    }
  }
  const message = `Made "${opts.project}" from the ${starter.title} starter in the ${ws} workspace.${jobId ? ` Its tests are running as background job #${jobId}; the result comes back here.` : note || ' Run its tests with: ' + starter.test} Read its CUSTOMISE.md before changing it. How to run it: ${starter.run || 'see its README.md'}.`;
  return { folder, starter, jobId, message };
}

export function createStarterTool(app: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'starter_create',
      description: `Start a new project from a tested starter template (copied into a new folder in the workspace; its tests then run as a background job). Starters: ${listStarters().map((s) => `${s.name} (${s.title}: ${s.description})`).join('; ') || 'none installed'}. Use one when the owner asks for a new bot, landing page, API or command-line tool, then customise it (its CUSTOMISE.md says how).`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: listStarters().map((s) => s.name), description: 'Which starter' },
          projectName: { type: 'string', description: 'The new folder name, e.g. "weather-bot"' },
          workspace: { type: 'string', description: "Workspace name (default: this conversation's)" },
        },
        required: ['name', 'projectName'],
        additionalProperties: false,
      },
    },
    isAvailable: () => listStarters().length > 0,
    summarize: (a) => `new project "${String(a.projectName ?? '')}" from the ${String(a.name ?? '')} starter`,
    async run(args, ctx) {
      if (!ctx.conversationId) throw new ToolError('No conversation for this project.');
      const r = createFromStarter(app(), { conversationId: ctx.conversationId, name: str(args, 'name'), project: str(args, 'projectName'), ...(args.workspace ? { workspace: String(args.workspace) } : {}) });
      return r.message;
    },
  };
}
