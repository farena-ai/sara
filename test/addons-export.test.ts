import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIVATE } from '../scripts/public-export.ts';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { ROOT } from './helpers.ts';
import { REPO_OUTPUTS_READONLY } from './repo-outputs.ts';

const isPrivate = (path: string) => PRIVATE.some((pattern) => pattern.test(path));

test('public export keeps website-only tools with their private template boundary', () => {
  for (const path of ['scripts/build-addons-site.ts', 'scripts/check-addons-site.mjs', 'scripts/addons-output-path.ts', 'test/addons-site.test.ts', 'test/addons-mcp.test.ts', 'store/addons/mcp-catalog.json', 'store/addons/packs.json', 'docs/store/website/addons/frame.html']) {
    assert.equal(isPrivate(path), true, `${path}: private catalog tooling must not ship with missing inputs`);
  }
  for (const path of ['scripts/package-addons.ts', 'test/addons-bundle.test.ts', 'test/addons-knowledge.test.ts', 'test/addons-workflows.test.ts', 'store/plugins/daily-briefing/main.mjs', 'store/mcp/dbhub.json']) {
    assert.equal(isPrivate(path), false, `${path}: usable source and behavior tests stay public`);
  }
});

test('destructive public export rejects prefix siblings, root outputs and linked ancestors', { skip: REPO_OUTPUTS_READONLY }, async () => {
  const api = await import('../scripts/public-export.ts');
  assert.equal(typeof (api as any).assertExportOutput, 'function', 'Export deletion needs a strict disposable-directory boundary.');
  const guard = (api as any).assertExportOutput;
  mkdirSync(join(ROOT, 'outputs/addons'), { recursive: true });
  const fixture = mkdtempSync(join(ROOT, 'outputs/addons/export-guard-'));
  const root = join(fixture, 'project');
  const outside = join(fixture, 'outside');
  mkdirSync(join(root, 'outputs'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'preserve');
  try {
    assert.throws(() => guard(join(root, 'outputs-important'), root, true), /outputs|descendant/i);
    assert.throws(() => guard(join(root, 'outputs'), root, true), /dedicated|descendant/i);
    const link = join(root, 'outputs', 'linked');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => guard(join(link, 'export'), root, true), /link|junction/i);
    const used = join(root, 'outputs', 'used'); mkdirSync(used); writeFileSync(join(used, 'data'), 'not implicitly disposable');
    assert.throws(() => guard(used, root, false), /replace|disposable|empty/i);
    assert.equal(guard(used, root, true), used);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'preserve');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('public export refuses tracked public sources aliased through a private directory junction before replacing output', { skip: REPO_OUTPUTS_READONLY }, () => {
  const fixture = mkdtempSync(join(ROOT, 'outputs/addons/export-source-'));
  const linked = join(fixture, 'public'); let madeLink = false;
  try {
    mkdirSync(join(fixture, 'scripts')); mkdirSync(join(fixture, 'docs/ops'), { recursive: true }); mkdirSync(linked);
    cpSync(new URL('../scripts/public-export.ts', import.meta.url), join(fixture, 'scripts/public-export.ts'));
    writeFileSync(join(linked, 'ledger.txt'), 'public fixture');
    writeFileSync(join(fixture, 'docs/ops/ledger.txt'), 'SYNTHETIC_PRIVATE_OPERATIONAL_NOTE');
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['add', 'scripts/public-export.ts', 'public/ledger.txt', 'docs/ops/ledger.txt'], { cwd: fixture });
    rmSync(linked, { recursive: true }); symlinkSync(join(fixture, 'docs/ops'), linked, process.platform === 'win32' ? 'junction' : 'dir'); madeLink = true;
    const out = join(fixture, 'outputs/export'); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'sentinel'), 'prior reviewed export');
    const result = spawnSync(process.execPath, [join(fixture, 'scripts/public-export.ts'), '--out', 'outputs/export', '--replace'], { cwd: fixture, encoding: 'utf8', env: { ...process.env, SARA_PRIVATE_PATTERNS: join(fixture, 'absent-patterns.json') } });
    assert.notEqual(result.status, 0, 'a private-tree alias must not produce a successful public export');
    assert.match(result.stderr + result.stdout, /source.*link|source.*junction/i);
    assert.equal(readFileSync(join(out, 'sentinel'), 'utf8'), 'prior reviewed export');
    assert.equal(existsSync(join(out, 'public/ledger.txt')), false);
    assert.equal(readFileSync(join(fixture, 'docs/ops/ledger.txt'), 'utf8'), 'SYNTHETIC_PRIVATE_OPERATIONAL_NOTE');
  } finally { if (madeLink) unlinkSync(linked); rmSync(fixture, { recursive: true, force: true }); }
});

test('release collector passes a native Node path when MSYS argument conversion is disabled', { skip: REPO_OUTPUTS_READONLY }, () => {
  const fixture = mkdtempSync(join(ROOT, 'outputs/addons/collector-native-path-'));
  const version = '3.12.4';
  const write = (path: string, content: string | Buffer) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), content); };
  try {
    write('scripts/release-assets.sh', readFileSync(new URL('../scripts/release-assets.sh', import.meta.url)));
    write('scripts/check-release-presentation.ts', "console.log('Synthetic presentation checker reached');\n");
    write('package.json', JSON.stringify({ type: 'module', version }) + '\n');
    write('clients/vscode/package.json', '{"version":"1.0.0"}\n');
    write('CHANGELOG.md', `## ${version}\n\nSynthetic release.\n`);
    write('deploy/get-sara.sh', '#!/bin/sh\nprintf synthetic\n');
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, [join(fixture, 'scripts/release-assets.sh').replaceAll('\\', '/'), version], { cwd: fixture, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Synthetic presentation checker reached/);
    assert.equal(readFileSync(join(fixture, 'outputs/release', version, 'get-sara.sh'), 'utf8'), '#!/bin/sh\nprintf synthetic\n');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
