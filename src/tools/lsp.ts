// C13 (docs/ops/C13_DESIGN.md): her read-only language-server tools (src/lsp.ts): diagnostics for
// a file, go to definition, find references, hover. They run on their own (nothing changes); when
// no server for the language is on this computer they say so instead of failing.
import { type LspEngine, NoServer } from '../lsp.ts';
import { displayPath, resolveInside } from './workspace.ts';
import { clip, num, str, ToolError, type Tool, type ToolContext } from './types.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const at = { path: { type: 'string', description: 'File inside the workspace' }, line: { type: 'integer', description: '1-based line' }, column: { type: 'integer', description: '1-based column (the start of the name)' } };

export function createLspTools(engine: () => LspEngine | undefined): Tool[] {
  const rel = (args: Record<string, unknown>, ctx: ToolContext) => displayPath(ctx.workspaceDir, resolveInside(ctx.workspaceDir, str(args, 'path')));
  const guard = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NoServer) return `${err.message} Use read_file and search instead.`;
      if (err instanceof ToolError) throw err;
      throw new ToolError((err as Error).message);
    }
  };
  const need = () => {
    const e = engine();
    if (!e) throw new ToolError('Language servers are not available here.');
    return e;
  };
  const pos = (args: Record<string, unknown>) => ({ line: Math.max(1, num(args, 'line', 1)), column: Math.max(1, num(args, 'column', 1)) });
  const locs = (list: { path: string; line: number; column: number }[]) => list.map((l) => `${l.path}:${l.line}:${l.column}`).join('\n');

  const diagnostics: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'code_diagnostics', description: "The language server's errors and warnings for one file (TypeScript/JavaScript, Python, Go, Rust when their server is installed). Read only.", parameters: obj({ path: at.path }, ['path']) },
    summarize: (a) => `problems in ${String(a.path ?? '')}`,
    run: (args, ctx) =>
      guard(async () => {
        const p = rel(args, ctx);
        const d = await need().diagnostics(ctx.workspaceDir, p);
        if (!d.length) return `${p}: no problems reported.`;
        return clip(`${d.length} problem${d.length === 1 ? '' : 's'}:\n${d.map((x) => `${p}:${x.line}:${x.column} ${x.severity} ${x.message}${x.source ? ` (${x.source})` : ''}`).join('\n')}`, 20_000);
      }),
  };
  const definition: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'code_definition', description: 'Where the name at a position is defined (language server). Read only.', parameters: obj(at, ['path', 'line', 'column']) },
    summarize: (a) => `definition at ${String(a.path ?? '')}:${String(a.line ?? '')}`,
    run: (args, ctx) =>
      guard(async () => {
        const { line, column } = pos(args);
        const l = await need().definition(ctx.workspaceDir, rel(args, ctx), line, column);
        return l.length ? `Defined at:\n${locs(l)}` : 'No definition found there.';
      }),
  };
  const references: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'code_references', description: 'Every place the name at a position is used (language server). Read only.', parameters: obj(at, ['path', 'line', 'column']) },
    summarize: (a) => `references at ${String(a.path ?? '')}:${String(a.line ?? '')}`,
    run: (args, ctx) =>
      guard(async () => {
        const { line, column } = pos(args);
        const l = await need().references(ctx.workspaceDir, rel(args, ctx), line, column);
        return l.length ? clip(`${l.length} reference${l.length === 1 ? '' : 's'}:\n${locs(l)}`, 20_000) : 'No references found.';
      }),
  };
  const hover: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'code_hover', description: 'The type and documentation of the name at a position (language server). Read only.', parameters: obj(at, ['path', 'line', 'column']) },
    summarize: (a) => `type info at ${String(a.path ?? '')}:${String(a.line ?? '')}`,
    run: (args, ctx) =>
      guard(async () => {
        const { line, column } = pos(args);
        return (await need().hover(ctx.workspaceDir, rel(args, ctx), line, column)) ?? 'Nothing to show there.';
      }),
  };
  return [diagnostics, definition, references, hover];
}
