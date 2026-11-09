// C13 (docs/ops/C13_DESIGN.md): the language-server engine against a tiny fake server
// (test/fixtures/fake-lsp.mjs): diagnostics, go-to-definition, references and hover (1-based
// lines in, workspace-relative paths out), a time cap, a server that crashes, no server at all,
// and Sara's own environment never reaching the server.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findOnPath, LSP_SERVERS, LspEngine, languageOf } from '../src/lsp.ts';
import { createLspTools } from '../src/tools/lsp.ts';
import { ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const ws = join(dir, 'ws');
mkdirSync(join(ws, 'src'), { recursive: true });
writeFileSync(join(ws, 'src', 'a.ts'), 'function greet() {\n  return oops;\n}\ngreet();\n');
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-lsp.mjs');
const engines: LspEngine[] = [];
const engine = (mode = '', timeoutMs = 4000) => {
  const e = new LspEngine({ resolve: (lang) => (lang === 'typescript' ? { command: process.execPath, args: [FAKE], env: { FAKE_LSP_MODE: mode } } : undefined), timeoutMs });
  engines.push(e);
  return e;
};
after(() => {
  for (const e of engines) e.stopAll();
  cleanup();
});

test('languages by extension, and the known servers (none bundled)', () => {
  assert.equal(languageOf('src/x.tsx'), 'typescript');
  assert.equal(languageOf('main.py'), 'python');
  assert.equal(languageOf('a.go'), 'go');
  assert.equal(languageOf('lib.rs'), 'rust');
  assert.equal(languageOf('README.md'), undefined);
  assert.deepEqual(LSP_SERVERS.map((s) => s.bin), ['typescript-language-server', 'pyright-langserver', 'gopls', 'rust-analyzer']);
  assert.equal(findOnPath('surely-not-a-real-program-c13', { PATH: dir }), undefined);
});

test('diagnostics, definition, references and hover through a real stdio client', async () => {
  process.env.SARA_SECRET_PROBE = 'leaked';
  try {
    const e = engine();
    const diags = await e.diagnostics(ws, 'src/a.ts');
    assert.deepEqual(diags, [{ line: 2, column: 1, severity: 'error', message: 'oops is not defined', source: 'fake' }]);
    assert.equal(e.serverInfo(ws, 'typescript')?.version, 'clean', "Sara's environment is not passed to the server");
    const defs = await e.definition(ws, 'src/a.ts', 4, 1);
    assert.deepEqual(defs, [{ path: 'src/a.ts', line: 1, column: 10 }]);
    const refs = await e.references(ws, 'src/a.ts', 1, 10);
    assert.equal(refs.length, 2);
    assert.deepEqual(refs[1], { path: 'src/a.ts', line: 3, column: 1 });
    const hover = await e.hover(ws, 'src/a.ts', 1, 10);
    assert.match(hover ?? '', /function greet\(\): string \(at 0:9\)/);
    assert.deepEqual(e.running(), [{ root: ws, language: 'typescript' }]);
    e.stopAll();
    assert.deepEqual(e.running(), []);
  } finally {
    delete process.env.SARA_SECRET_PROBE;
  }
});

test('a hanging server hits the time cap; a crashing one is reported, not thrown past the tool', async () => {
  const slow = engine('hang', 300);
  await assert.rejects(slow.definition(ws, 'src/a.ts', 1, 1), /took too long/);
  const bad = engine('crash', 2000);
  await assert.rejects(bad.diagnostics(ws, 'src/a.ts'), /stopped|took too long/);
});

test('tools: graceful without a server, and paths stay inside the workspace', async () => {
  const none = new LspEngine({ resolve: () => undefined });
  engines.push(none);
  const tools = createLspTools(() => none);
  assert.deepEqual(tools.map((t) => t.spec.name), ['code_diagnostics', 'code_definition', 'code_references', 'code_hover']);
  assert.ok(tools.every((t) => t.defaultPermission === 'auto'));
  const ctx = { workspaceDir: ws, signal: AbortSignal.timeout(5000), sandbox: { mode: 'none' as const, network: false, detail: '' } };
  const out = await tools[0].run({ path: 'src/a.ts' }, ctx);
  assert.match(String(out), /No language server for typescript/);
  await assert.rejects(tools[0].run({ path: '../outside.ts' }, ctx), /outside the workspace/);
  const live = createLspTools(() => engine());
  assert.match(String(await live[0].run({ path: 'src/a.ts' }, ctx)), /src\/a\.ts:2:1 error oops is not defined/);
  assert.match(String(await live[2].run({ path: 'src/a.ts', line: 1, column: 10 }, ctx)), /2 references/);
});
