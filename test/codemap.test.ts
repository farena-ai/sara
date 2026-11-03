// Phase 50: the code map. Extractors on fixture snippets for each language, .gitignore and size
// skips, incremental re-indexing, the code tools' outputs (compact, file:line), refs and deps on a
// small multi-file project, meaning search with a fake embedder, the chat hook that keeps the map
// fresh after her file tools write, the Map API (owner only), and how fast it maps Sara herself.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { embedTarget } from '../src/embeddings.ts';
import { extract, langOf, chunkLines, identWords, type Lang } from '../src/codemap/extract.ts';
import { IgnoreRules } from '../src/codemap/ignore.ts';
import { CodeMaps } from '../src/codemap/index.ts';
import { CodeMapStore } from '../src/codemap/store.ts';
import { codeFind, createCodeTools, outline } from '../src/codemap/tools.ts';
import { buildSystemPrompt, loadPersona } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, fakeEmbedder, makeApp, ROOT, tempDir, text } from './helpers.ts';

const FIX = join(ROOT, 'test', 'fixtures', 'codemap');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
const names = (lang: Lang, file: string) => {
  const r = extract(lang, fixture(file));
  return { r, sym: (n: string) => r.symbols.find((s) => s.name === n), list: r.symbols.map((s) => `${s.kind}:${s.parent ? `${s.parent}.` : ''}${s.name}@${s.line}`) };
};

/** A temp folder whose cleanup runs after everything registered with `close` (Windows: close databases first). */
function scratch(t: { after: (fn: () => void) => void }): { dir: string; close: (fn: () => void) => void } {
  const { dir, cleanup } = tempDir();
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const fn of closers.reverse()) fn();
    cleanup();
  });
  return { dir, close: (fn) => closers.push(fn) };
}

function ctxFor(dir: string): ToolContext {
  return { workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none', network: true, detail: '' } };
}

/** A copy of the small multi-file fixture project in a temp workspace. */
function project(t: { after: (fn: () => void) => void }) {
  const { dir, close } = scratch(t);
  const ws = join(dir, 'ws');
  cpSync(join(FIX, 'proj'), ws, { recursive: true });
  const maps = new CodeMaps({ cacheDir: join(dir, 'cache') });
  close(() => maps.close());
  return { dir, ws, maps };
}

test('extract: TypeScript (functions, classes, methods, interfaces, types, consts, imports; strings and comments ignored)', () => {
  const { r, sym, list } = names('typescript', 'sample.ts');
  assert.deepEqual(
    list.filter((x) => !x.startsWith('const:Color')),
    ['interface:Shape@10', 'type:Size@14', 'const:LIMIT@18', 'function:double@20', 'function:loadText@22', 'function:helper@28', 'class:Circle@32', 'method:Circle.constructor@35', 'method:Circle.area@39', 'method:Circle.unit@43', 'method:Circle.hidden@47'],
  );
  assert.equal(sym('loadText')!.end, 26, 'a "{" in a string does not change where the body ends');
  assert.equal(sym('helper')!.end, 30, 'a regex with a brace does not either');
  assert.equal(sym('Circle')!.end, 50);
  assert.equal(sym('Circle')!.exported, true, 'export default Circle');
  assert.equal(sym('helper')!.exported, false);
  assert.equal(sym('hidden')!.exported, false, 'private method');
  assert.ok(!r.symbols.some((s) => s.name === 'fakeInComment'), 'commented-out code is not a symbol');
  assert.deepEqual(r.imports.map((i) => `${i.spec}@${i.line}`), ['node:fs@2', 'node:fs@3', 'node:path@4']);
  assert.match(r.imports[2].names!, /join, dirname/, 'a braced import over several lines');
  // Enums and namespaces (not in the typechecked fixture: erasable syntax only).
  const more = extract('typescript', 'export enum Color {\n  Red,\n}\nnamespace NS {\n  export const x = 1;\n}\n');
  assert.deepEqual(more.symbols.map((s) => `${s.kind}:${s.name}@${s.line}-${s.end}`), ['enum:Color@1-3', 'namespace:NS@4-6']);
});

test('extract: JavaScript CommonJS (require, exports.x, module.exports.y)', () => {
  const { r, list } = names('javascript', 'sample.js');
  assert.ok(list.includes('function:parse@5'));
  assert.ok(r.symbols.some((s) => s.name === 'run' && s.exported && s.kind === 'function'));
  assert.ok(r.symbols.some((s) => s.name === 'VERSION' && s.exported));
  assert.deepEqual(r.imports.map((i) => i.spec), ['fs', './helper']);
});

test('extract: Python (def, class, methods, imports; docstrings are not code)', () => {
  const { r, sym, list } = names('python', 'sample.py');
  assert.deepEqual(list, ['const:MAX_ITEMS@10', 'function:top_level@13', 'class:Animal@17', 'method:Animal.__init__@20', 'method:Animal.speak@23', 'method:Animal._private@26', 'function:fetch_all@30']);
  assert.equal(sym('Animal')!.end, 27);
  assert.equal(sym('_private')!.exported, false);
  assert.deepEqual(r.imports.map((i) => i.spec), ['os', 'sys', 'collections', '.utils']);
});

test('extract: Go (func, methods with receivers, struct/interface, import blocks)', () => {
  const { r, sym, list } = names('go', 'sample.go');
  assert.deepEqual(list, ['struct:Point@11', 'interface:Namer@15', 'const:Version@19', 'function:NewPoint@21', 'method:Point.String@27', 'function:helper@31']);
  assert.equal(sym('NewPoint')!.end, 25);
  assert.equal(sym('helper')!.exported, false);
  assert.deepEqual(r.imports.map((i) => i.spec), ['fmt', 'strings', 'os']);
});

test('extract: Rust (fn, struct, enum, trait, impl blocks, macros, use, mod; lifetimes and char literals)', () => {
  const { r, sym, list } = names('rust', 'sample.rs');
  for (const want of ['struct:Thing@7', 'enum:Kind@11', 'trait:Describe@16', 'impl:Describe for Thing@20', 'method:Thing.describe@21', 'impl:Thing@27', 'method:Thing.new@28', 'function:run@33', 'function:private_helper@37', 'macro:square@39']) assert.ok(list.includes(want), want);
  assert.equal(sym('run')!.exported, true);
  assert.equal(sym('private_helper')!.exported, false);
  assert.equal(r.symbols.find((s) => s.name === 'describe' && s.parent === 'Thing')!.end, 24, "'{' as a char literal is not a brace");
  assert.deepEqual(r.imports.map((i) => i.spec), ['std::collections::HashMap', 'crate::util', 'mod:util']);
});

test('extract: Java, Kotlin and C# (types, methods, constructors, imports)', () => {
  const java = names('java', 'Sample.java').list;
  for (const want of ['class:Sample@6', 'constructor:Sample.Sample@9', 'method:Sample.names@13', 'method:Sample.helper@20', 'interface:Sample.Listener@24', 'method:Listener.onEvent@25']) assert.ok(java.includes(want), `java ${want}: ${java}`);
  const kt = names('kotlin', 'Sample.kt');
  for (const want of ['class:User@5', 'class:Repo@7', 'method:Repo.find@8', 'function:topLevel@15', 'object:Registry@17', 'method:Registry.register@18']) assert.ok(kt.list.includes(want), `kotlin ${want}: ${kt.list}`);
  assert.equal(kt.sym('User')!.end, 5, 'a class without a body ends on its line');
  const cs = names('csharp', 'Sample.cs');
  for (const want of ['interface:IStore@6', 'method:IStore.Save@8', 'class:Store@11', 'constructor:Store.Store@13', 'method:Store.Save@17', 'method:Store.LoadAsync@22']) assert.ok(cs.list.includes(want), `c# ${want}: ${cs.list}`);
  assert.deepEqual(cs.r.imports.map((i) => i.spec), ['System', 'System.Collections.Generic']);
});

test('extract: C and C++ (functions, structs, typedefs, macros, classes, includes; prototypes skipped)', () => {
  const c = names('c', 'sample.c');
  assert.deepEqual(c.list, ['macro:MAX_LEN@4', 'struct:point@6', 'type:Point@9', 'function:add@13', 'function:helper@18', 'function:main@25']);
  assert.equal(c.sym('helper')!.exported, false, 'static');
  assert.deepEqual(c.r.imports.map((i) => i.spec), ['<stdio.h>', 'util.h']);
  const cpp = names('cpp', 'sample.cpp');
  for (const want of ['namespace:geo@4', 'class:geo.Square@6', 'method:Square.Square@8', 'method:Square.area@9', 'function:total@14', 'function:geo_free_function@22']) assert.ok(cpp.list.includes(want), `c++ ${want}: ${cpp.list}`);
});

test('extract: Markdown headings (not inside code fences); languages by file name; chunks cover every line once', () => {
  const md = names('markdown', 'README.md');
  assert.deepEqual(md.list, ['heading:Fixture project@1', 'heading:Install@5', 'heading:Usage@12']);
  assert.equal(langOf('src/a.tsx'), 'typescript');
  assert.equal(langOf('Makefile'), 'text');
  assert.equal(langOf('package-lock.json'), undefined);
  assert.equal(langOf('app.min.js'), undefined);
  assert.equal(langOf('photo.png'), undefined);
  for (const [lang, file] of [['typescript', 'sample.ts'], ['python', 'sample.py'], ['rust', 'sample.rs'], ['markdown', 'README.md']] as [Lang, string][]) {
    const lines = fixture(file).split('\n');
    const chunks = chunkLines(lines.length, extract(lang, fixture(file)).symbols, lines);
    let next = 1;
    for (const ch of chunks) {
      assert.equal(ch.start, next, `${file}: chunks are contiguous`);
      next = ch.end + 1;
    }
    assert.equal(next, lines.length + 1, `${file}: every line is in a chunk`);
  }
  const ts = fixture('sample.ts').split('\n');
  const cls = chunkLines(ts.length, extract('typescript', fixture('sample.ts')).symbols, ts).find((c) => c.symbol === 'Circle')!;
  assert.deepEqual([cls.start, cls.end], [32, 50], 'a class is one chunk');
  // Long files without symbols: ~60-line windows.
  const long = chunkLines(150, []);
  assert.deepEqual(long.map((c) => [c.start, c.end]), [[1, 60], [61, 120], [121, 150]]);
  assert.match(identWords('readPdfFile snake_case_name'), /read pdf file.*snake case name/);
});

test('ignore rules: names, globs, folders, anchored paths, ** and ordered negations', () => {
  const r = new IgnoreRules('# comment\n*.log\nbuild/\n/out\ndocs/tmp\n**/gen/*.ts\nsecret?.txt\n!keep.log\n');
  assert.equal(r.ignores('a/b/x.log', false), true);
  assert.equal(r.ignores('keep.log', false), false, 'a later negation re-includes the file');
  assert.equal(r.decision('src/main.ts', false), undefined, 'no matching rule has no decision');
  const excludedAgain = new IgnoreRules('*.log\n!keep.log\nkeep.log\n');
  assert.equal(excludedAgain.ignores('keep.log', false), true, 'the last matching rule wins');
  const escaped = new IgnoreRules('\\!literal.ts\n');
  assert.equal(escaped.ignores('!literal.ts', false), true, 'an escaped leading ! is literal');
  assert.equal(r.ignores('build', true), true);
  assert.equal(r.ignores('build', false), false, 'folder-only rule');
  assert.equal(r.ignores('out', true), true);
  assert.equal(r.ignores('src/out', true), false, 'anchored to the .gitignore folder');
  assert.equal(r.ignores('docs/tmp', true), true);
  assert.equal(r.ignores('a/gen/x.ts', false), true);
  assert.equal(r.ignores('secret1.txt', false), true);
  assert.equal(r.ignores('src/main.ts', false), false);
});

test('store: nested rules can re-include a file but cannot revive an ignored parent', (t) => {
  const { dir, close } = scratch(t);
  const ws = join(dir, 'ws');
  const put = (rel: string, body: string) => {
    mkdirSync(join(ws, rel, '..'), { recursive: true });
    writeFileSync(join(ws, rel), body);
  };
  put('.gitignore', '*.ts\n!skip.ts\nsecret/\n!secret/keep.ts\nignored/\n!ignored/\n!ignored/keep.ts\n!node_modules/\n!.hidden/\n');
  put('src/.gitignore', '!keep.ts\nskip.ts\n');
  put('src/keep.ts', 'export const kept = true;\n');
  put('src/skip.ts', 'export const skipped = true;\n');
  put('src/other.ts', 'export const inherited = true;\n');
  put('secret/keep.ts', 'export const hidden = true;\n');
  put('ignored/keep.ts', 'export const folder = true;\n');
  put('node_modules/keep.ts', 'export const dependency = true;\n');
  put('.hidden/keep.ts', 'export const dot = true;\n');
  const store = new CodeMapStore(ws, join(dir, 'map.db'));
  close(() => store.close());
  const r = store.refreshAll();
  assert.deepEqual(store.files().map((f) => f.path), ['ignored/keep.ts', 'src/keep.ts']);
  assert.equal(r.ignored, 3, 'nested exclusions and the ignored parent are counted');
});

test('store: skips .git, node_modules, dist, .gitignored, binary and >1 MB files; links are not followed', (t) => {
  const { dir, close } = scratch(t);
  const ws = join(dir, 'ws');
  const put = (rel: string, body: string | Buffer) => {
    mkdirSync(join(ws, rel, '..'), { recursive: true });
    writeFileSync(join(ws, rel), body);
  };
  put('src/app.ts', 'export function app() {}\n');
  put('src/gen/out.ts', 'export function generated() {}\n');
  put('src/gen/.gitignore', 'out.ts\n');
  put('.gitignore', 'secret/\n*.log\n');
  put('secret/key.ts', 'export const key = 1;\n');
  put('debug.log', 'x');
  put('node_modules/lib/index.js', 'function lib() {}\n');
  put('dist/app.js', 'function built() {}\n');
  put('.git/config.ts', 'x');
  put('vendor/v.go', 'package v\nfunc V() {}\n');
  put('big.ts', `export const big = '${'x'.repeat(1024 * 1024 + 10)}';\n`);
  put('weird.ts', Buffer.from([0x65, 0x78, 0x00, 0x01, 0x02]));
  put('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const store = new CodeMapStore(ws, join(dir, 'map.db'));
  close(() => store.close());
  const r = store.refreshAll();
  assert.deepEqual(store.files().map((f) => f.path), ['src/app.ts']);
  assert.deepEqual(r.skippedBig, ['big.ts']);
  assert.deepEqual(r.skippedBinary, ['weird.ts']);
  assert.equal(r.ignored, 2, 'secret/ and src/gen/out.ts (a .log file is not a source file anyway)');
});

test('store: incremental re-index (only the changed file; touched-but-same is not re-read; deleted files leave)', (t) => {
  const { ws, maps } = project(t);
  const store = maps.get(ws);
  const first = store.refreshAll();
  assert.equal(first.reindexed.length, 7, `first index: ${first.reindexed}`);
  assert.equal(store.refreshAll().reindexed.length, 0, 'nothing changed');
  // Change one file.
  const greet = join(ws, 'src', 'greet.ts');
  writeFileSync(greet, `${readFileSync(greet, 'utf8')}\nexport function farewell(name: string): string {\n  return 'bye ' + name;\n}\n`);
  const second = store.refreshAll();
  assert.deepEqual(second.reindexed, ['src/greet.ts']);
  assert.ok(store.findSymbols('farewell').hits.some((s) => s.path === 'src/greet.ts' && s.line === 8));
  // Touch without changing the content: the hash matches, no re-index.
  const later = new Date(Date.now() + 5000);
  utimesSync(join(ws, 'src', 'counter.ts'), later, later);
  assert.deepEqual(store.refreshAll().reindexed, []);
  // Delete one.
  rmSync(join(ws, 'src', 'pdf-reader.ts'));
  const third = store.refreshAll();
  assert.deepEqual(third.removed, ['src/pdf-reader.ts']);
  assert.equal(store.findSymbols('readPdfPages').total, 0);
});

test('store: a scan with a tiny budget stops and carries on (never one long block)', (t) => {
  const { ws, maps } = project(t);
  const store = maps.get(ws);
  let steps = 0;
  let r = store.refresh(0);
  while (!r.done) {
    steps++;
    r = store.refresh(0);
    assert.ok(steps < 1000);
  }
  assert.ok(steps >= 2, `took ${steps} steps`);
  assert.equal(store.status().files, 7);
});

test('tools: code_map outline is compact and names entry points; folders and files outline with lines', async (t) => {
  const { ws, maps } = project(t);
  const tools = Object.fromEntries(createCodeTools(() => maps).map((x) => [x.spec.name, x]));
  for (const tl of Object.values(tools)) assert.equal(tl.defaultPermission, 'auto', `${tl.spec.name} is read-only`);
  const out = await tools.code_map.run({}, ctxFor(ws));
  assert.ok(out.length < 2500, `outline is ${out.length} chars`);
  assert.match(out, /7 files/);
  assert.match(out, /package\.json "fixture-proj" · main src\/main\.ts · scripts: start=node src\/main\.ts/);
  assert.match(out, /README\.md: Fixture proj/);
  assert.match(out, /main\(\): src\/main\.ts/);
  assert.match(out, /src\/ \(5 · /);
  assert.match(out, /Most imported: .*src\/util\/text\.ts \(1\)/);
  const file = await tools.code_map.run({ path: 'src/util/text.ts' }, ctxFor(ws));
  assert.match(file, /L2-4 fn shout \(exported\)/);
  assert.match(file, /Imported by: src\/greet\.ts/);
  const folder = await tools.code_map.run({ path: 'src/util' }, ctxFor(ws));
  assert.match(folder, /src\/util\/: 1 files/);
  assert.match(await tools.code_map.run({ path: 'nope' }, ctxFor(ws)), /Nothing mapped under "nope"/);
});

test('tools: code_find (symbol → file:line + signature; words; no hits), code_refs and code_deps on a multi-file project', async (t) => {
  const { ws, maps } = project(t);
  const tools = Object.fromEntries(createCodeTools(() => maps).map((x) => [x.spec.name, x]));
  const sym = await tools.code_find.run({ query: 'greet' }, ctxFor(ws));
  assert.match(sym.split('\n')[1], /^src\/greet\.ts:4  fn greet  — export function greet\(name: string\): string \{$/);
  const method = await tools.code_find.run({ query: 'Counter.add' }, ctxFor(ws));
  assert.match(method.split('\n')[1], /^src\/counter\.ts:4  method Counter\.add/);
  const words = await tools.code_find.run({ query: 'upper-cases text', kind: 'text' }, ctxFor(ws));
  assert.match(words.split('\n')[0], /^src\/util\/text\.ts:1  \[shout\]  \/\*\* Upper-cases text/);
  assert.match(await tools.code_find.run({ query: 'zebra unicorn', kind: 'text' }, ctxFor(ws)), /Nothing found/);
  const refs = await tools.code_refs.run({ symbol: 'shout' }, ctxFor(ws));
  assert.match(refs, /Defined: src\/util\/text\.ts:2 fn shout \(exported\)/);
  assert.match(refs, /Used 2 times in 1 file:\nsrc\/greet\.ts:1  import \{ shout \} from '\.\/util\/text\.ts';\nsrc\/greet\.ts:5  return shout\(`hello \$\{name\}`\);/);
  assert.match(refs, /src\/util\/text\.ts is imported \(with this name\) by: src\/greet\.ts/);
  assert.match(await tools.code_refs.run({ symbol: 'whisper' }, ctxFor(ws)), /No uses found/);
  const deps = await tools.code_deps.run({ file: 'greet.ts' }, ctxFor(ws));
  assert.match(deps, /^src\/greet\.ts\nImports from this workspace \(1\): src\/util\/text\.ts \(L1\)\nImported by \(1\): src\/main\.ts:2$/);
  const main = await tools.code_deps.run({ file: 'src/main.ts' }, ctxFor(ws));
  assert.match(main, /src\/greet\.ts \(L2\), src\/counter\.ts \(L3\)/);
  assert.match(main, /Nothing in the workspace imports it/);
  // Every hit line has file:line.
  for (const l of words.split('\n').filter((x) => !x.startsWith('('))) assert.match(l, /^[\w/.-]+:\d+ /);
});


test('meaning search: finds code by what it does with a (fake) embedder; without one it says so and uses words', async (t) => {
  const { dir, close } = scratch(t);
  const ws = join(dir, 'ws');
  cpSync(join(FIX, 'proj'), ws, { recursive: true });
  const url = await fakeEmbedder(t);
  const target = { config: { id: 'emb', label: 'Fake', kind: 'openai-compatible' as const, baseUrl: url }, model: 'fake-embed' };
  const maps = new CodeMaps({ cacheDir: join(dir, 'cache'), target: () => target });
  close(() => maps.close());
  const store = maps.get(ws);
  store.refreshAll();
  let n = 0;
  for (let k; (k = await store.indexVectors(target, 100)); ) n += k;
  assert.equal(n, store.status().chunks);
  // "welcome someone" shares no word with greet.ts ("greet", "hello"), only the meaning.
  assert.deepEqual(store.findWords('welcome someone'), []);
  const out = await codeFind(maps, store, 'welcome someone', 'meaning');
  assert.match(out.split('\n')[0], /^src\/greet\.ts:\d+  \[greet\]/);
  const hits = await store.findMeaning(target, 'welcome someone', 3);
  assert.equal(hits[0].by, 'meaning');
  // Found both ways ranks first.
  const both = await store.findMeaning(target, 'pdf pages', 3);
  assert.equal(both[0].path, 'src/pdf-reader.ts');
  assert.equal(both[0].by, 'both');
  // No embeddings job: a note, and word search.
  const plain = new CodeMaps({ cacheDir: join(dir, 'cache2') });
  close(() => plain.close());
  const s2 = plain.get(ws);
  s2.refreshAll();
  const noMeaning = await codeFind(plain, s2, 'pdf pages', 'meaning');
  assert.match(noMeaning, /Meaning search isn't set up/);
  assert.match(noMeaning, /src\/pdf-reader\.ts:\d+/);
});

test('chat: her write_file in a workspace keeps the map fresh (touch → background step); coding prompt points at the code tools', async (t) => {
  const { dir, close } = scratch(t);
  const app = makeApp(dir, { now: new Date() });
  app.now = () => new Date();
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  const maps = new CodeMaps({ cacheDir: join(dir, 'cache', 'codemap'), target: () => embedTarget(app) });
  app.codemap = maps;
  for (const tl of createCodeTools(() => app.codemap)) app.tools.add(tl);
  close(() => {
    maps.close();
    app.store.close();
  });
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  cpSync(join(FIX, 'proj'), ws, { recursive: true });
  maps.get(ws).refreshAll();
  app.script.push([call('c1', 'write_file', { path: 'src/fresh.ts', content: 'export function brandNewThing(): number {\n  return 1;\n}\n' })], text('Added it.'));
  for await (const ev of runTurn(app, conv.id, 'add a brandNewThing function')) void ev;
  const system = app.requests[0].messages[0].content;
  assert.match(system, /start unfamiliar work with code_map/);
  assert.match(system, /code_refs/);
  // The write marked the map for a look; background steps (each time-limited, so a busy machine
  // may need a few) pick the new file up.
  const found = () => maps.get(ws).findSymbols('brandNewThing').hits.some((s) => s.path === 'src/fresh.ts' && s.line === 1);
  for (let i = 0; i < 20 && !found(); i++) await maps.tick();
  assert.ok(found());
  // A chat (not coding) prompt has no code-map line.
  const chat = buildSystemPrompt(loadPersona(join(ROOT, 'persona', 'sara.json')), { now: new Date(), tools: ['code_map', 'read_file'], coding: false });
  assert.doesNotMatch(chat, /code_map \(the layout/);
});

test('Map API: owner only (401 signed out, 403 in the demo); tree, file detail, search, refresh', async (t) => {
  const { dir, close } = scratch(t);
  const clock = { now: new Date() };
  const app = makeApp(dir, clock);
  const maps = new CodeMaps({ cacheDir: join(dir, 'cache', 'codemap') });
  app.codemap = maps;
  const ws = workspaceDir(dir, 'proj1');
  cpSync(join(FIX, 'proj'), ws, { recursive: true });
  const auth = new OwnerAuth(dir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mkdirSync(join(dir, 'demo'), { recursive: true });
  const demoApp = makeApp(join(dir, 'demo'), clock);
  demoApp.codemap = maps;
  const demo = createSaraServer({ app: demoApp, auth: new OwnerAuth(join(dir, 'demo'), () => clock.now), webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>((r) => demo.listen(0, '127.0.0.1', r));
  close(() => {
    server.close();
    demo.close();
    maps.close();
    app.store.close();
    demoApp.store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/api/codemap/proj1`)).status, 401);
  const dbase = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
  const d = await fetch(`${dbase}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const dcookie = d.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(`${dbase}/api/codemap/proj1`, { headers: { cookie: dcookie } })).status, 403, 'not in the demo');
  const tree = (await (await fetch(`${base}/api/codemap/proj1`, { headers: owner })).json()) as { done: boolean; files: { path: string; symbols: number; importedBy: number }[] };
  assert.equal(tree.done, true);
  assert.deepEqual(tree.files.map((f) => f.path), ['README.md', 'package.json', 'src/counter.ts', 'src/greet.ts', 'src/main.ts', 'src/pdf-reader.ts', 'src/util/text.ts']);
  assert.equal(tree.files.find((f) => f.path === 'src/greet.ts')!.importedBy, 1);
  const file = (await (await fetch(`${base}/api/codemap/proj1/file?path=${encodeURIComponent('src/greet.ts')}`, { headers: owner })).json()) as { symbols: { name: string; line: number }[]; imports: { resolved: string }[]; importedBy: { path: string }[] };
  assert.deepEqual(file.symbols.map((s) => `${s.name}@${s.line}`), ['greet@4']);
  assert.equal(file.imports[0].resolved, 'src/util/text.ts');
  assert.deepEqual(file.importedBy.map((i) => i.path), ['src/main.ts']);
  assert.equal((await fetch(`${base}/api/codemap/proj1/file?path=nope.ts`, { headers: owner })).status, 404);
  const found = (await (await fetch(`${base}/api/codemap/proj1/find?q=shout`, { headers: owner })).json()) as { kind: string; hits: { path: string; line: number }[] };
  assert.equal(found.kind, 'symbol');
  assert.deepEqual(found.hits.map((h) => `${h.path}:${h.line}`), ['src/util/text.ts:2']);
  const words = (await (await fetch(`${base}/api/codemap/proj1/find?q=${encodeURIComponent('pdf pages')}`, { headers: owner })).json()) as { kind: string; note?: string; hits: { path: string }[] };
  assert.equal(words.kind, 'text');
  assert.match(words.note!, /Meaning search isn't set up/);
  assert.equal(words.hits[0].path, 'src/pdf-reader.ts');
  writeFileSync(join(ws, 'src', 'extra.ts'), 'export const extra = 1;\n');
  const rf = (await (await fetch(`${base}/api/codemap/proj1/refresh`, { method: 'POST', headers: owner })).json()) as { done: boolean; reindexed: number };
  assert.deepEqual([rf.done, rf.reindexed], [true, 1]);
  assert.equal((await fetch(`${base}/api/codemap/..%2F..`, { headers: owner })).status, 400, 'workspace names only');
});

test('performance: maps Sara herself (src, web, test) in well under 10 s of CPU per 1,000 files; one changed file in under 1 s', (t) => {
  const { dir, close } = scratch(t);
  const ws = join(dir, 'sara');
  for (const d of ['src', 'web', 'test']) cpSync(join(ROOT, d), join(ws, d), { recursive: true });
  const store = new CodeMapStore(ws, join(dir, 'map.db'));
  close(() => store.close());
  // PL2d (C5): CPU time of this process (the full suite beside it doesn't count) and per 1,000 files
  // (the copy of src, web and test grows every release).
  const cpuMs = () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  };
  const t0 = cpuMs();
  const r = store.refreshAll();
  const first = cpuMs() - t0;
  const st = store.status();
  const target = join(ws, 'src', 'safety.ts');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\nexport function addedForTheTest(): number {\n  return 42;\n}\n`);
  const t1 = cpuMs();
  const again = store.refreshAll();
  const second = cpuMs() - t1;
  const bytes = statSync(join(dir, 'map.db')).size + (() => {
    try {
      return statSync(join(dir, 'map.db-wal')).size;
    } catch {
      return 0;
    }
  })();
  t.diagnostic(`codemap perf: ${st.files} files, ${st.symbols} symbols, ${st.chunks} chunks; first index ${Math.round(first)} ms of CPU (${Math.round((first * 1000) / st.files)} per 1,000 files); re-index of one file ${Math.round(second)} ms; database ${(bytes / 1048576).toFixed(1)} MB`);
  assert.ok(r.reindexed.length > 150, `${r.reindexed.length} files`);
  assert.ok((first * 1000) / st.files < 10_000, `first index ${first} ms of CPU for ${st.files} files: under 10 s per 1,000 files`);
  assert.deepEqual(again.reindexed, ['src/safety.ts']);
  assert.ok(second < 1000, `re-index ${second} ms`);
  assert.ok(store.findSymbols('addedForTheTest').hits.length === 1);
  // The outline of a real repository stays small.
  assert.ok(outline(store).length < 3000);
});
