import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { REPO_OUTPUTS_READONLY } from './repo-outputs.ts';
import { fromFolder, hashFiles } from '../src/packages.ts';
import { NATIVE_CANDIDATE_IDS } from '../src/addons/discovery.ts';

const ROOT = resolve(import.meta.dirname, '..');
const IDS = ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard'];
const BUILTINS = ['email', 'imessage', 'matrix', 'signal', 'whatsapp'];
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const sorted = (values: readonly string[]) => [...values].sort();

test('runtime candidate allowlist matches the approved public projection', () => {
  assert.deepEqual(sorted(NATIVE_CANDIDATE_IDS), sorted(IDS));
});

function verifyPayload(payload: string): void {
  assert.deepEqual(sorted(readdirSync(join(payload, 'store'))), ['plugins'], 'runtime store contains no catalogs, MCP recipes or website authoring');
  assert.deepEqual(sorted(readdirSync(join(payload, 'store/plugins'))), sorted(IDS), 'only the twelve approved candidate roots ship');
  assert.deepEqual(sorted(readdirSync(join(payload, 'plugins'))), BUILTINS, 'all five existing builtins ship');
  for (const relative of [...IDS.map(id => `store/plugins/${id}`), ...BUILTINS.map(id => `plugins/${id}`)]) {
    const source = fromFolder(join(ROOT, relative));
    const actual = fromFolder(join(payload, relative));
    assert.equal(hashFiles(actual), hashFiles(source), `${relative}: every SDK, import, manifest and asset byte is preserved`);
    assert.deepEqual(sorted(actual.map(file => file.path)), sorted(source.map(file => file.path)), `${relative}: complete file inventory`);
  }
}

function fixture(body: (folder: string) => void): void {
  mkdirSync(join(ROOT, 'outputs/a1'), { recursive: true });
  const folder = mkdtempSync(join(ROOT, 'outputs/a1/task6-payload-'));
  let passed = false;
  try { body(folder); passed = true; }
  finally { if (passed) rmSync(folder, { recursive: true, force: true }); }
}

function candidateBlock(recipe: string): string {
  const block = /CANDIDATE_PLUGINS=\([\s\S]*?\n\)[\s\S]*?for id in "\$\{CANDIDATE_PLUGINS\[@\]\}"; do\n[\s\S]*?\ndone/.exec(recipe)?.[0];
  assert.ok(block, 'recipe must copy the explicit local candidate allowlist');
  const list = /CANDIDATE_PLUGINS=\(([\s\S]*?)\n\)/.exec(block)![1].trim().split(/\s+/);
  assert.deepEqual(sorted(list), sorted(NATIVE_CANDIDATE_IDS), 'shell allowlist matches the approved projection IDs');
  return block;
}

for (const [name, path, destination] of [
  ['Linux install/update', 'deploy/install.sh', '$APP_DIR'],
  ['Windows staging', 'desktop/windows/build-installer.sh', '$STAGE/server'],
  ['Mac staging', 'desktop/mac/build.sh', '$S'],
] as const) {
  test(`${name} copy recipe delivers complete candidate and builtin packages`, { skip: REPO_OUTPUTS_READONLY }, () => {
    const recipe = read(path);
    const candidates = candidateBlock(recipe);
    const base = path === 'deploy/install.sh'
      ? /for item in src [^\n]+; do\n[\s\S]*?\ndone/.exec(recipe)?.[0]
      : recipe.split('\n').find(line => /^cp -[rR] /.test(line) && line.includes('"$ROOT/src"'));
    assert.ok(base, 'actual base payload copy commands are present');
    fixture(folder => {
      const payload = join(folder, 'runtime');
      mkdirSync(payload);
      const shellPath = (value: string) => value.replaceAll('\\', '/');
      // Run only the real bounded copy commands, never the installers/builders or their services.
      const runCopy = () => {
        const result = spawnSync(bash, ['-euo', 'pipefail', '-c', `ROOT=$1; SRC_DIR=$1; APP_DIR=$2; STAGE=$3; S=$2\nmkdir -p "$STAGE/server"\n${base}\n${candidates}`, 'payload-fixture', shellPath(ROOT), shellPath(payload), shellPath(folder)], {
          cwd: folder, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
        });
        assert.equal(result.status, 0, `${name}: real copy commands failed: ${result.stderr || result.error}`);
      };
      runCopy();
      const actual = destination === '$STAGE/server' ? join(folder, 'server') : payload;
      verifyPayload(actual);
      if (path === 'deploy/install.sh') {
        writeFileSync(join(actual, 'store/plugins/daily-briefing/stale-unshipped.mjs'), 'obsolete package file');
        mkdirSync(join(actual, 'store/plugins/stale-package'));
        const data = join(folder, 'synthetic-data'); mkdirSync(data);
        writeFileSync(join(data, 'sentinel'), 'keep owner data');
        runCopy();
        verifyPayload(actual);
        assert.equal(readFileSync(join(data, 'sentinel'), 'utf8'), 'keep owner data');
        assert.equal(existsSync(join(actual, 'store/plugins/daily-briefing/stale-unshipped.mjs')), false, 'update replaces the managed candidate subtree');
      }
    });
  });
}

test('Docker COPY recipe delivers only selected complete candidate packages and five builtins', { skip: REPO_OUTPUTS_READONLY }, () => {
  const recipe = read('Dockerfile').replace(/\\\n\s*/g, ' ');
  const candidateSources = [...recipe.matchAll(/^COPY (store\/plugins\/\S+) /gm)].map(match => match[1]);
  assert.deepEqual(sorted(candidateSources), sorted(NATIVE_CANDIDATE_IDS.map(id => `store/plugins/${id}`)), 'image explicitly includes all twelve candidates');
  fixture(folder => {
    const payload = join(folder, 'runtime'); mkdirSync(payload);
    for (const line of recipe.split('\n').filter(line => /^COPY\s/.test(line))) {
      const words = line.trim().split(/\s+/).slice(1);
      assert.ok(words.length >= 2 && words.every(word => /^[\w./-]+$/.test(word)), `Unsupported COPY: ${line}`);
      const destination = words.pop()!;
      for (const source of words) {
        const target = join(payload, destination, ...(destination.endsWith('/') ? [source.split('/').at(-1)!] : []));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(ROOT, source), target, { recursive: true });
      }
    }
    verifyPayload(payload);
  });
});
