// Phase 96 (ST1, docs/design/STAPLES.md §4.5, §4.6, §4.10): the skill tools and what a turn adds.
//
//   skill_use(name)            the body, wrapped in <skill …>…</skill>, with the folder's files listed
//                              (not read); a second use in the same conversation says "already loaded"
//   skill_read(name, path)     one file inside the skill folder (no links, no "..", 256 KB at most)
//   skill_find(query)          for big catalogs
//   skill_run(name, script, args)  a file under scripts/, in the workspace sandbox, asking first
//   skill_save(...)            a new or changed skill (asks: the card shows the SKILL.md)
//   skill_update(name, patch, why)  a change to one (asks: the card shows what changes)
//   recipe_save                the old tool, kept as an alias of skill_save for this release
// None of them run in partner chats, group chats or turns from other apps (chat.ts leaves them out
// there too). A skill never changes her permissions: skill_run asks like any command, and the
// allowed-tools field is shown, never trusted.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AppContext } from './chat.ts';
import { readInsideNoFollow, isPlainFileInside } from './codemap/safe-read.ts';
import { embedTarget } from './embeddings.ts';
import type { SkillStore, SkillView } from './skill-store.ts';
import { describeFrom, MAX_DESCRIPTION, slugify } from './skills.ts';
import { shq } from './tools/coding.ts';
import { runCommand, windowsShell } from './tools/sandbox.ts';
import { clip, num, str, ToolError, type Tool, type ToolContext } from './tools/types.ts';

/** skill_read returns at most this much of a file. */
export const SKILL_READ_MAX = 256 * 1024;
/** How far back a loaded skill counts as "still in use" in a conversation (messages). */
export const SKILL_KEEP_MESSAGES = 20;
/** The tools that load or use a skill (their calls keep the skill "in use"). */
export const SKILL_TOOLS = new Set(['skill_use', 'skill_read', 'skill_run', 'skill_find', 'skill_save', 'skill_update']);
/** Channels of other apps and voice assistants: no skills there. */
const OTHER_APP_CHANNELS = new Set(['api', 'mcp', 'home-assistant', 'alexa', 'a2a']);

/** Skills loaded in this conversation recently (tool loads and loads up front), by name. */
export function loadedSkills(app: AppContext, conversationId: string): Set<string> {
  const msgs = app.store.messages(conversationId).filter((m) => m.role !== 'notice').slice(-SKILL_KEEP_MESSAGES);
  const out = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'tool' && typeof m.meta?.skill === 'string') out.add(m.meta.skill);
    const auto = m.meta?.autoSkill as { name?: string } | undefined;
    if (m.role === 'user' && auto?.name) out.add(auto.name);
  }
  return out;
}

function interpreter(script: string, sh: boolean): string[] | undefined {
  const ext = extname(script).toLowerCase();
  if (ext === '.sh') return ['sh'];
  if (ext === '.py') return [process.platform === 'win32' && !sh ? 'python' : 'python3'];
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ['node'];
  if (ext === '.ts') return ['node', '--disable-warning=ExperimentalWarning'];
  if (ext === '.ps1') return process.platform === 'win32' ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] : ['pwsh', '-NoProfile', '-File'];
  return undefined;
}

/** The first lines of a script, for the approval card. */
export function scriptHead(file: string, lines = 40): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(0, lines).join('\n').slice(0, 6000);
  } catch {
    return '';
  }
}

/** A script path inside the skill's scripts/ folder ("x.sh" or "scripts/x.sh"). */
function scriptPath(raw: string): string {
  const s = String(raw ?? '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
  const rel = s.startsWith('scripts/') ? s : `scripts/${s}`;
  // eslint-disable-next-line no-control-regex
  if (!/^scripts\/[A-Za-z0-9._-][A-Za-z0-9._/-]{0,160}$/.test(rel) || rel.split('/').includes('..') || /[\u0000-\u001f]/.test(rel)) throw new ToolError('A script is a file in the skill\'s scripts/ folder, e.g. "scripts/check.sh".');
  return rel;
}

function cleanArgs(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError('args is a list of strings.');
  if (v.length > 30) throw new ToolError('At most 30 arguments.');
  // eslint-disable-next-line no-control-regex
  return v.map((x) => String(x ?? '').replace(/[\u0000\r\n]/g, ' ').slice(0, 2000));
}

interface Deps {
  /** A household member's space: no scripts (no shell in their tool set). */
  member?: boolean;
  /** The demo: only skill_use / skill_read on the built-ins. */
  demo?: boolean;
}

export function createSkillTools(app: () => AppContext, deps: Deps = {}): Tool[] {
  const skills = (): SkillStore => {
    const s = app().skills;
    if (!s) throw new ToolError('Skills are not available here.');
    return s;
  };
  const conv = (id?: string) => (id ? app().store.getConversation(id) : undefined);
  /** The notPartner pattern: no skills for other people, groups or other apps. */
  const guard = (ctx: ToolContext) => {
    const c = conv(ctx.conversationId);
    if (c?.partner) throw new ToolError('Skills are private to the owner.');
    if (c && OTHER_APP_CHANNELS.has(c.channel)) throw new ToolError('Skills are not used in conversations from other apps.');
    if (c?.channel.startsWith('group')) throw new ToolError('Skills are not used in group chats.');
  };
  const find = (name: string): SkillView => {
    const v = skills().resolve(name);
    if (!v) {
      const all = skills().effective();
      throw new ToolError(all.length ? `No skill "${name}". Her skills: ${all.map((x) => x.name).slice(0, 40).join(', ')}.` : 'There are no skills yet.');
    }
    return v;
  };
  // "Allow for this task" on a script card: this skill's scripts run without asking for the rest of the conversation.
  const taskAllowed = new Set<string>();
  const taskKey = (conversationId: string | undefined, v: SkillView) => `${conversationId ?? ''}|${v.scope}|${v.name}`;

  const tools: Tool[] = [
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().skills),
      spec: {
        name: 'skill_use',
        description:
          'Open one of your skills (a how-to listed under "Skills" in your instructions) before doing the task it covers, then follow it. Returns its steps and the list of files in it. Use the exact name from the list.',
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'The skill name, e.g. "review-a-pull-request".' } }, required: ['name'], additionalProperties: false },
      },
      summarize: (a) => `Using skill “${String(a.name ?? '').slice(0, 64)}”`,
      async run(args, ctx) {
        guard(ctx);
        const v = find(str(args, 'name'));
        if (deps.demo && v.scope !== 'builtin') throw new ToolError('Only the built-in skills are available in the demo.');
        if (ctx.conversationId && loadedSkills(app(), ctx.conversationId).has(v.name)) return `The skill "${v.name}" is already loaded in this conversation (see above); keep following it.`;
        let text: string;
        try {
          text = skills().activation(v);
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
        skills().markUsed(v.scope, v.name, 'tool', { conversationId: ctx.conversationId ?? null, runId: ctx.runId ?? null });
        return text;
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().skills),
      spec: {
        name: 'skill_read',
        description: "Read a file that belongs to one of your skills (a reference or template the skill's steps point to). Paths are relative to the skill folder, e.g. \"references/checklist.md\".",
        parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string', description: 'Relative to the skill folder.' } }, required: ['name', 'path'], additionalProperties: false },
      },
      summarize: (a) => `Reading ${String(a.path ?? '').slice(0, 80)} of skill “${String(a.name ?? '').slice(0, 64)}”`,
      async run(args, ctx) {
        guard(ctx);
        const v = find(str(args, 'name'));
        if (deps.demo && v.scope !== 'builtin') throw new ToolError('Only the built-in skills are available in the demo.');
        if (v.status !== 'ready' && v.status !== 'trial') throw new ToolError('That skill waits for a review.');
        const raw = str(args, 'path').replace(/\\/g, '/').trim();
        // eslint-disable-next-line no-control-regex
        if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.split('/').includes('..') || /[\u0000]/.test(raw)) throw new ToolError('Give a path inside the skill folder, e.g. "references/checklist.md".');
        const abs = join(v.dir, ...raw.split('/').filter((s) => s && s !== '.'));
        if (!isPlainFileInside(v.dir, abs)) throw new ToolError(`No readable file "${raw}" in that skill (links aren't followed).`);
        const buf = readInsideNoFollow(v.dir, abs, SKILL_READ_MAX + 1);
        if (!buf) throw new ToolError(`No readable file "${raw}" in that skill (links aren't followed).`);
        if (buf.subarray(0, 8000).includes(0)) return `${raw} is not a text file (${buf.length >= SKILL_READ_MAX ? 'over 256 KB' : `${buf.length} bytes`}); only text files can be read.`;
        const cut = buf.length > SKILL_READ_MAX;
        const text = buf.subarray(0, SKILL_READ_MAX).toString('utf8');
        return `${text}${cut ? `\n[… cut at ${SKILL_READ_MAX / 1024} KB]` : ''}`;
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().skills),
      spec: {
        name: 'skill_find',
        description: 'Look through all your skills by words and meaning (when your list says there are more). Returns names and what each is for; open one with skill_use.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you are about to do.' } }, required: ['query'], additionalProperties: false },
      },
      summarize: (a) => `Looking for a skill: “${String(a.query ?? '').slice(0, 60)}”`,
      async run(args, ctx) {
        guard(ctx);
        const q = str(args, 'query').trim();
        const found = await skills().find(q, { limit: 8, ...(embedTarget(app()) ? { target: embedTarget(app())! } : {}), timeoutMs: 3000 });
        const visible = deps.demo ? found.filter((v) => v.scope === 'builtin') : found;
        if (!visible.length) return skills().effective().length ? `No skill fits “${q}”.` : 'There are no skills yet.';
        return `${visible.map((v) => `- ${v.name} — ${v.description.slice(0, 300)}`).join('\n')}\nOpen one with skill_use before following it.`;
      },
    },
  ];
  if (deps.demo) return tools;

  if (!deps.member) {
    tools.push({
      // §4.6: every skill's scripts ask by default; the card shows the skill, the first 40 lines
      // and the arguments. "Allow for this task" and the owner's per-skill switch let them run on.
      defaultPermission: 'ask',
      runsCommands: true,
      isAvailable: () => Boolean(app().skills),
      spec: {
        name: 'skill_run',
        description: "Run a script that comes with one of your skills (a file in its scripts/ folder), in your workspace. The owner approves it first unless they allowed this skill's scripts. Its folder is available to the script as SKILL_DIR (read only).",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The skill name.' },
            script: { type: 'string', description: 'e.g. "scripts/check.sh" (or just "check.sh").' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the script.' },
            timeout_seconds: { type: 'integer', description: 'Default 120, at most 600.' },
          },
          required: ['name', 'script'],
          additionalProperties: false,
        },
      },
      summarize: (a) => `Run ${String(a.script ?? '').slice(0, 80)} from skill “${String(a.name ?? '').slice(0, 64)}”`,
      async prepare(args, ctx) {
        let v: SkillView;
        let rel: string;
        try {
          v = find(String(args.name ?? ''));
          rel = scriptPath(String(args.script ?? ''));
        } catch (err) {
          return { refuse: `Error: ${(err as Error).message}` };
        }
        const abs = join(v.dir, ...rel.split('/'));
        if (!isPlainFileInside(v.dir, abs)) return { refuse: `Error: the skill "${v.name}" has no script ${rel} (links aren't followed).` };
        const key = taskKey(ctx.conversationId, v);
        const standing = taskAllowed.has(key) || (v.scriptsAuto && (v.source !== 'imported' || v.approvedRuns > 0));
        return {
          summary: `Run ${rel} from skill “${v.name}”`,
          skill: {
            kind: 'skill',
            skill: v.name,
            scope: v.scope,
            source: v.source,
            script: rel,
            head: scriptHead(abs),
            args: cleanArgs(args.args),
            ...(v.allowedTools ? { allowedTools: v.allowedTools } : {}),
            choices: ['once', 'task'],
          },
          ...(standing ? { auto: true } : {}),
          answered: (allowed, how) => {
            if (!allowed) return;
            skills().noteApprovedRun(v.scope, v.name);
            if (how === 'task') taskAllowed.add(key);
          },
        };
      },
      async run(args, ctx) {
        guard(ctx);
        const v = find(str(args, 'name'));
        if (v.status !== 'ready' && v.status !== 'trial') throw new ToolError('That skill waits for a review.');
        const rel = scriptPath(str(args, 'script'));
        const abs = join(v.dir, ...rel.split('/'));
        if (!isPlainFileInside(v.dir, abs)) throw new ToolError(`The skill "${v.name}" has no script ${rel}.`);
        const bw = ctx.sandbox.mode === 'bwrap';
        const win = process.platform === 'win32' && ctx.sandbox.mode === 'none';
        const shell = win ? windowsShell() : { sh: true };
        const runner = interpreter(rel, shell.sh);
        if (!runner) throw new ToolError(`She can't run ${rel}: scripts are .sh, .py, .js, .mjs, .ts or .ps1 (chosen by the file's ending, never by its first line).`);
        const skillDir = bw ? '/skill' : v.dir;
        const target = bw ? `/skill/${rel}` : join(v.dir, ...rel.split('/'));
        const items = [...runner, target, ...cleanArgs(args.args)];
        const fwd = (s: string) => (win && shell.sh ? s.replace(/\\/g, '/') : s);
        const command = shell.sh ? items.map((x) => shq(fwd(x))).join(' ') : items.map((x) => `"${x.replace(/"/g, '')}"`).join(' ');
        const timeoutMs = Math.min(600, Math.max(1, Math.floor(num(args, 'timeout_seconds', 120)))) * 1000;
        const r = await runCommand(command, ctx.workspaceDir, ctx.sandbox, {
          timeoutMs,
          signal: ctx.signal,
          env: { SKILL_DIR: fwd(skillDir), SKILL_NAME: v.name },
          ...(bw ? { binds: [{ src: v.dir, dest: '/skill' }] } : {}),
        });
        skills().markUsed(v.scope, v.name, 'tool', { conversationId: ctx.conversationId ?? null, runId: ctx.runId ?? null });
        const head = `[skill ${v.name}: ${rel}${r.timedOut ? ', stopped after the time limit' : ''}; exit ${r.exitCode ?? 'none'}${ctx.sandbox.mode === 'none' ? '; not isolated: it ran on this computer directly' : ''}]`;
        const out = `${head}\n${clip(r.output, 30_000)}`;
        if (r.exitCode !== 0) throw new ToolError(out);
        return out;
      },
    });
  }

  const saveTool = (name: 'skill_save' | 'recipe_save'): Tool => ({
    defaultPermission: 'ask',
    isAvailable: () => Boolean(app().skills),
    spec:
      name === 'skill_save'
        ? {
            name,
            description:
              "Save a skill: how you do a kind of task, so you can follow it next time (e.g. after a tricky job went well). Name in lower-case-with-hyphens, a description of what it does AND when to use it, and the steps that worked as Markdown. Saving again with the same name changes it. The owner approves each save.",
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'e.g. "deploy-the-weather-app".' },
                description: { type: 'string', description: 'What it does and when to use it (one or two sentences).' },
                body: { type: 'string', description: 'The steps, in Markdown (commands in backticks, checks, pitfalls).' },
                files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Optional extra files under scripts/, references/ or assets/.' },
              },
              required: ['name', 'description', 'body'],
              additionalProperties: false,
            },
          }
        : {
            name,
            description: 'Save how you did a tricky job (older name of skill_save; it saves a skill). Title, when to use it, and the steps that worked. The owner approves each save.',
            parameters: {
              type: 'object',
              properties: { title: { type: 'string' }, when_to_use: { type: 'string' }, steps: { type: 'string' }, workspace: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
              required: ['title', 'when_to_use', 'steps'],
              additionalProperties: false,
            },
          },
    summarize: (a) => (name === 'skill_save' ? `Save skill “${slugify(String(a.name ?? '')).slice(0, 64)}”` : `Save recipe “${String(a.title ?? '').slice(0, 80)}”`),
    async prepare(a) {
      const input = draftOf(name, a);
      try {
        const { serializeSkill } = await import('./skills.ts');
        return { skill: { kind: 'skill-draft', skill: input.name, skillMd: serializeSkill(input).slice(0, 12_000), exists: Boolean(app().skills?.get('companion', input.name)) } };
      } catch (err) {
        return { refuse: `Error: ${(err as Error).message}` };
      }
    },
    async run(a, ctx) {
      guard(ctx);
      const input = draftOf(name, a);
      const s = skills();
      const ws = conv(ctx.conversationId)?.workspace;
      if (name === 'recipe_save' && ws && ws !== 'main' && !input.metadata?.['sara-workspace']) input.metadata = { ...input.metadata, 'sara-workspace': ws };
      const had = s.get('companion', input.name);
      try {
        const v = s.save('companion', input, { create: !had, source: had?.source ?? 'made', why: had ? 'she changed it' : 'she saved it' });
        app().events?.publish({ type: 'skills' });
        return `${had ? 'Updated' : 'Saved'} skill "${v.name}".`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  });
  tools.push(saveTool('skill_save'));
  tools.push({
    defaultPermission: 'ask',
    isAvailable: () => Boolean(app().skills),
    spec: {
      name: 'skill_update',
      description: 'Change one of your own skills when a step turned out wrong or out of date: give the new description and/or body (the whole new text) and why. The owner approves each change; the old version is kept.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, why: { type: 'string', description: 'One line: what changed and why.' } },
        required: ['name', 'why'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Change skill “${String(a.name ?? '').slice(0, 64)}”`,
    async prepare(a) {
      const s = app().skills;
      const v = s?.get('companion', String(a.name ?? '')) ?? s?.get('shared', String(a.name ?? ''));
      if (!s || !v) return { refuse: `Error: no skill "${String(a.name ?? '')}" of your own to change (built-in and project skills are read only).` };
      const cur = s.bodyOf(v);
      const next = { description: typeof a.description === 'string' && a.description.trim() ? a.description : v.description, body: typeof a.body === 'string' && a.body.trim() ? a.body : cur.body };
      return { skill: { kind: 'skill-change', skill: v.name, scope: v.scope, why: String(a.why ?? '').slice(0, 300), before: { description: v.description, body: cur.body.slice(0, 8000) }, after: { description: next.description.slice(0, MAX_DESCRIPTION), body: next.body.slice(0, 8000) } } };
    },
    async run(a, ctx) {
      guard(ctx);
      const s = skills();
      const name = str(a, 'name');
      const v = s.get('companion', name) ?? s.get('shared', name);
      if (!v) throw new ToolError(`No skill "${name}" of your own to change.`);
      const cur = s.bodyOf(v);
      try {
        const out = s.save(v.scope, { name: v.name, description: typeof a.description === 'string' && a.description.trim() ? a.description : v.description, body: typeof a.body === 'string' && a.body.trim() ? a.body : cur.body, metadata: v.metadata, ...(v.license ? { license: v.license } : {}), ...(v.compatibility ? { compatibility: v.compatibility } : {}), ...(v.allowedTools ? { allowedTools: v.allowedTools } : {}) }, { why: str(a, 'why').slice(0, 300) });
        app().events?.publish({ type: 'skills' });
        return `Changed skill "${out.name}" (the old version is kept).`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  });
  // §4.7: recipe_save stays for this release (old transcripts and evals), as an alias of skill_save.
  if (!deps.member) tools.push(saveTool('recipe_save'));
  return tools;
}

/** What a save call would write (skill_save's arguments, or recipe_save's old ones). */
function draftOf(tool: 'skill_save' | 'recipe_save', a: Record<string, unknown>): { name: string; description: string; body: string; metadata: Record<string, string>; files?: { path: string; content: string }[] } {
  if (tool === 'recipe_save') {
    const title = String(a.title ?? '').trim();
    const tags = Array.isArray(a.tags) ? (a.tags as unknown[]).map(String).filter(Boolean) : [];
    const ws = typeof a.workspace === 'string' && a.workspace.trim() && a.workspace.trim().toLowerCase() !== 'any' ? a.workspace.trim() : '';
    return { name: slugify(title), description: describeFrom(title, String(a.when_to_use ?? '')), body: `# ${title}\n\n${String(a.steps ?? '').trim()}`, metadata: { ...(ws ? { 'sara-workspace': ws } : {}), ...(tags.length ? { 'sara-tags': tags.join(' ') } : {}) } };
  }
  const files = Array.isArray(a.files) ? (a.files as { path?: unknown; content?: unknown }[]).slice(0, 20).map((f) => ({ path: String(f?.path ?? ''), content: String(f?.content ?? '') })) : undefined;
  return { name: slugify(String(a.name ?? '')), description: String(a.description ?? ''), body: String(a.body ?? ''), metadata: {}, ...(files?.length ? { files } : {}) };
}

/** The Skills section of a turn (tier 1), or undefined. */
export async function skillsSection(app: AppContext, text: string): Promise<{ text: string; listed: string[] } | undefined> {
  const s = app.skills;
  if (!s) return undefined;
  const target = embedTarget(app);
  const c = await s.catalog(text, { ...(target ? { target } : {}), timeoutMs: 1500 }).catch(() => undefined);
  return c ? { text: c.text, listed: c.listed } : undefined;
}
