// PRQ (docs/ops/PRQ_DESIGN.md): the program catalog and detection per OS with a fake file system,
// PATH and version output. Nothing here looks at the real computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProgramId, program, programFor, PROGRAMS } from '../src/prereqs/catalog.ts';
import { compareVersions, detect, type DetectEnv } from '../src/prereqs/detect.ts';

function env(platform: DetectEnv['platform'], files: string[], o: Partial<DetectEnv> = {}): DetectEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform,
    pathVar: '',
    vars: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local', USERPROFILE: 'C:\\Users\\o', HOME: platform === 'darwin' ? '/Users/o' : '/home/o' },
    exists: (f) => set.has(f.toLowerCase()),
    list: (dir) => [...new Set(files.filter((f) => f.toLowerCase().startsWith(dir.toLowerCase() + (platform === 'win32' ? '\\' : '/'))).map((f) => f.slice(dir.length + 1).split(/[\\/]/)[0]))],
    ...o,
  };
}

test('prq catalog: every program has an id, a vendor page and a way to detect it on each OS', () => {
  for (const p of PROGRAMS) {
    assert.ok(isProgramId(p.id));
    assert.match(p.url, /^https:\/\//);
    for (const os of ['win32', 'darwin', 'linux'] as const) assert.ok(p.detect.commands.length || p.detect.paths[os]?.length, `${p.id} ${os}`);
  }
  assert.deepEqual(PROGRAMS.map((p) => p.winget), ['Google.Chrome', 'astral-sh.uv', 'Docker.DockerDesktop', 'OpenJS.NodeJS.LTS', 'Python.Python.3.12', 'BlenderFoundation.Blender', 'Gyan.FFmpeg']);
  assert.equal(isProgramId('chrome; rm -rf /'), false);
  assert.equal(isProgramId('__proto__'), false);
});

test('prq catalog: recipe needs map to programs (no new recipe field)', () => {
  assert.equal(programFor('app:Google Chrome'), 'chrome');
  assert.equal(programFor('app:Blender with the add-on running'), 'blender');
  assert.equal(programFor('npx'), 'node');
  assert.equal(programFor('uv'), 'uv');
  assert.equal(programFor('uvx'), 'uv');
  assert.equal(programFor('docker'), 'docker');
  assert.equal(programFor('app:ComfyUI'), undefined);
  // The shipped recipes: playwright/chrome-devtools → chrome, markitdown/qdrant → uv, github → docker, blender → blender, the npx ones → node
  // (storybook talks to the owner's own Storybook over http: nothing to install where Sara runs).
  const dir = join(import.meta.dirname, '..', 'store', 'mcp');
  const want: Record<string, string[]> = { playwright: ['chrome', 'node'], 'chrome-devtools': ['chrome', 'node'], markitdown: ['uv'], qdrant: ['uv'], github: ['docker'], blender: ['uv', 'blender'], dbhub: ['node'], context7: ['node'], drawio: ['node'] };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const got = new Set([r.mcp.command, ...(r.mcp.needs ?? [])].filter(Boolean).map((n: string) => programFor(n)).filter(Boolean));
    for (const id of want[r.id] ?? []) assert.ok(got.has(id as never), `${r.id} needs ${id}`);
  }
});

test('prq detect: Windows finds Chrome in Program Files, not on PATH', () => {
  const chrome = program('chrome');
  assert.deepEqual(detect(chrome, env('win32', [])), { id: 'chrome', found: false });
  const d = detect(chrome, env('win32', ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']));
  assert.equal(d.found, true);
  assert.equal(d.onPath, false);
  assert.equal(d.path, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  const user = detect(chrome, env('win32', ['C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe']));
  assert.equal(user.found, true);
});

test('prq detect: PATH first (Windows .exe/.cmd), then the WinGet links folder (PATH refresh)', () => {
  const uv = program('uv');
  const onPath = detect(uv, env('win32', ['D:\\tools\\uvx.exe'], { pathVar: 'C:\\Windows;"D:\\tools"' }));
  assert.equal(onPath.found, true);
  assert.equal(onPath.onPath, true);
  assert.equal(onPath.dir, 'D:\\tools');
  // Just installed by winget: Sara's own PATH is stale, the links folder has it.
  const fresh = detect(uv, env('win32', ['C:\\Users\\o\\AppData\\Local\\Microsoft\\WinGet\\Links\\uvx.exe'], { pathVar: 'C:\\Windows' }));
  assert.equal(fresh.found, true);
  assert.equal(fresh.onPath, false);
  assert.equal(fresh.dir, 'C:\\Users\\o\\AppData\\Local\\Microsoft\\WinGet\\Links');
});

test('prq detect: node needs npx beside it, and a version of at least 22', () => {
  const node = program('node');
  assert.equal(detect(node, env('linux', ['/usr/bin/node'], { pathVar: '/usr/bin' })).found, false, 'node without npx is not enough for npx recipes');
  const v = (out: string) => () => out;
  const ok = detect(node, env('linux', ['/usr/bin/node', '/usr/bin/npx'], { pathVar: '/usr/bin', version: v('v24.11.0\n') }));
  assert.equal(ok.found, true);
  assert.equal(ok.version, '24.11.0');
  assert.equal(ok.old, undefined);
  const old = detect(node, env('linux', ['/usr/bin/node', '/usr/bin/npx'], { pathVar: '/usr/bin', version: v('v18.19.1') }));
  assert.equal(old.old, true);
  const win = detect(node, env('win32', ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\npx.cmd']));
  assert.equal(win.found, true);
  assert.equal(win.path, 'C:\\Program Files\\nodejs\\node.exe');
});

test('prq detect: macOS apps, Linux paths, and one wildcard folder (Blender versions)', () => {
  assert.equal(detect(program('chrome'), env('darwin', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])).found, true);
  assert.equal(detect(program('chrome'), env('linux', ['/usr/bin/google-chrome-stable'], { pathVar: '/usr/local/bin:/usr/bin' })).found, true);
  assert.equal(detect(program('uv'), env('linux', ['/home/o/.local/bin/uvx'], { pathVar: '/usr/bin' })).dir, '/home/o/.local/bin');
  const b = detect(program('blender'), env('win32', ['C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe', 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe']));
  assert.equal(b.path, 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe');
  assert.equal(detect(program('python'), env('linux', ['/usr/bin/python3'], { pathVar: '/usr/bin', version: () => 'Python 3.8.10' })).old, true);
  assert.equal(compareVersions('3.12.1', '3.10.0'), 1);
  assert.equal(compareVersions('22.0.0', '22'), 0);
});
