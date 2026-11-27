// T55 (coding correctness): two guards on her file tools, in code, for every model.
//
// 1. Stale and blind writes. write_file used to overwrite any file, read or not, and edit_file wrote
//    into a file that had changed since she last saw it. Now: both tools refuse when the file changed
//    on disk since she last read or wrote it ("read it again"), and overwriting an existing file she
//    has not read says so in the result (not refused: team parts and scripts replace files they were
//    handed). A new file needs nothing. edit_file on a file she has not read is allowed: its
//    old_string must match the file exactly, which is the proof.
// 2. Syntax. After a write the file is parsed (never run): JSON, JavaScript, TypeScript, Python.
//    When it does not parse, the tool result says so with the parser's own line, at once, instead
//    of the mistake surfacing many steps later. Needs nothing installed in the project and no
//    approval, because nothing of the project is executed.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { extname } from 'node:path';
import { ToolError, type ToolContext } from './types.ts';

interface Seen {
  mtimeMs: number;
  size: number;
}
const seen = new Map<string, Seen>();
const SEEN_MAX = 5_000;
const keyOf = (ctx: Pick<ToolContext, 'conversationId'>, file: string): string | undefined => (ctx.conversationId ? `${ctx.conversationId}|${process.platform === 'win32' ? file.toLowerCase() : file}` : undefined);

/** She has the file's current content in front of her (read it, or just wrote it). */
export async function noteSeen(ctx: Pick<ToolContext, 'conversationId'>, file: string): Promise<void> {
  const key = keyOf(ctx, file);
  if (!key) return;
  const s = await stat(file).catch(() => undefined);
  if (!s) return void seen.delete(key);
  seen.delete(key);
  seen.set(key, { mtimeMs: s.mtimeMs, size: s.size });
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
}

/**
 * Before a change. `overwrite`: the whole file is replaced (write_file), so she must have read it.
 * Calls without a conversation (scripts, other tools reusing these) are not guarded.
 */
export async function assertFresh(ctx: Pick<ToolContext, 'conversationId'>, file: string, shown: string, o: { overwrite: boolean }): Promise<string> {
  const key = keyOf(ctx, file);
  if (!key) return '';
  const s = await stat(file).catch(() => undefined);
  if (!s?.isFile()) return '';
  const was = seen.get(key);
  if (!was) {
    // Not refused (team parts and scripts replace files they were handed), but never silent.
    return o.overwrite && s.size > 0 ? `
Note: ${shown} already existed (${s.size} bytes) and you had not read it in this conversation; its old content is replaced. If that was not intended, restore it (git) and read the file first.` : '';
  }
  if (was.mtimeMs !== s.mtimeMs || was.size !== s.size) throw new ToolError(`${shown} changed since you last read it (something else wrote to it). Read it again with read_file, then make your change.`);
  return '';
}

/** Tests: forget what was read. */
export function resetEditGuard(): void {
  seen.clear();
}

const run = (file: string, args: string[], ms: number): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: ms, windowsHide: true, maxBuffer: 200_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : null) : 0;
      resolve({ code: err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : code, out: `${stderr}${stdout}` });
    });
  });

const PY_PARSE = "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1])";
let python: string | null | undefined;
async function pythonExe(): Promise<string | null> {
  if (python !== undefined) return python;
  for (const exe of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    const r = await run(exe, ['-c', 'import ast'], 5_000);
    if (r.code === 0) return (python = exe);
  }
  return (python = null);
}

export const SYNTAX_CHECK = { maxBytes: 600_000, ms: 6_000 };
const short = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Parses the file as it is now. Returns the parser's complaint, or undefined when it parses, the
 * kind of file is not checked, or the parser is not there. Never throws and never runs the file.
 */
export async function syntaxProblem(file: string, content: string): Promise<string | undefined> {
  if (Buffer.byteLength(content) > SYNTAX_CHECK.maxBytes) return undefined;
  const ext = extname(file).toLowerCase();
  try {
    if (ext === '.json') {
      try {
        JSON.parse(content);
        return undefined;
      } catch (err) {
        return short((err as Error).message);
      }
    }
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
      const strip = (nodeModule as unknown as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;
      if (!strip) return undefined;
      try {
        strip(content);
        return undefined;
      } catch (err) {
        const e = err as Error & { code?: string };
        // Syntax the stripper does not take on purpose (enums, namespaces) is not a syntax error.
        if (e.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return undefined;
        return e.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ? short(e.message) : undefined;
      }
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const r = await run(process.execPath, ['--check', file], SYNTAX_CHECK.ms);
      if (r.code === 0 || r.code === null) return undefined;
      const lines = r.out.split('\n').map((l) => l.trim()).filter(Boolean);
      const at = lines[0]?.match(/:(\d+)$/)?.[1];
      const msg = lines.find((l) => /^SyntaxError/.test(l));
      return msg ? short(`${msg}${at ? ` (line ${at})` : ''}`) : undefined;
    }
    if (ext === '.py') {
      const exe = await pythonExe();
      if (!exe) return undefined;
      const r = await run(exe, ['-c', PY_PARSE, file], SYNTAX_CHECK.ms);
      if (r.code === 0 || r.code === null) return undefined;
      const lines = r.out.split('\n').map((l) => l.trim()).filter(Boolean);
      const msg = lines.findLast((l) => /Error/.test(l));
      const at = r.out.match(/line (\d+)/)?.[1];
      return msg ? short(`${msg}${at ? ` (line ${at})` : ''}`) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The line added to a write's result when the file no longer parses. */
export async function syntaxNote(file: string, content: string): Promise<string> {
  const p = await syntaxProblem(file, content);
  return p ? `\nSYNTAX ERROR: the file as it is now does not parse: ${p}. Fix this before anything else.` : '';
}
