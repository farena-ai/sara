import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const VERSION = '3.12.4';
const REPO = 'https://github.com/farena-ai/sara';
const READMES = ['README.md', 'README.es.md', 'README.fr.md', 'README.de.md', 'README.pt-BR.md', 'README.it.md'];
const LABELS = ['Status:', 'Estado:', 'État :', 'Status:', 'Status:', 'Stato:'];
const START = '<!-- sara:recent-releases:start -->';
const END = '<!-- sara:recent-releases:end -->';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sara-release-presentation-'));
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ type: 'module', version: VERSION }, null, 2));
  for (const [index, file] of READMES.entries()) {
    write(file, `# Sara\n\n<a href="${REPO}/releases/latest">Descargar</a>\n<a href="docs/INSTALL.md">Installer</a>\n<a href="${REPO}">★ Stella</a>\n\n> **${LABELS[index]}** ${VERSION}, disponible.\n\n## Novedades\n\n${START}\nVersions récentes.\n\n| Version | Nouveautés |\n| --- | --- |\n| **[${VERSION}](${REPO}/releases/tag/v${VERSION})** | Une amélioration. |\n| [3.11.0](${REPO}/releases/tag/v3.11.0) | Plus ancien. |\n${END}\n`);
  }
  const verify = (file = '') => {
    const withinTemp = relative(resolve(tmpdir()), resolve(root));
    assert.ok(withinTemp && !isAbsolute(withinTemp) && withinTemp !== '..' && !withinTemp.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
    assert.ok(basename(root).startsWith('sara-release-presentation-'));
    const withinFixture = relative(root, resolve(root, file));
    assert.ok(!isAbsolute(withinFixture) && withinFixture !== '..' && !withinFixture.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  };
  return {
    root, write, verify,
    mutate(file: string, change: (text: string) => string) { write(file, change(readFileSync(join(root, file), 'utf8'))); },
    copyScript(file: string) {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(join(ROOT, 'scripts', file), join(root, 'scripts', file));
    },
    close() {
      verify();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('collector refuses stale localized presentation before touching existing artifacts', () => {
  const f = fixture();
  try {
    f.copyScript('release-assets.sh');
    if (existsSync(join(ROOT, 'scripts/check-release-presentation.ts'))) f.copyScript('check-release-presentation.ts');
    f.write('clients/vscode/package.json', '{"version":"1.0.0"}\n');
    f.write('CHANGELOG.md', `## ${VERSION}\n\nSynthetic release.\n`);
    f.write(`outputs/release/${VERSION}/sentinel`, 'existing artifact bytes\n');
    f.mutate('README.fr.md', (text) => text.replace(`**État :** ${VERSION}`, '**État :** 3.11.0'));
    f.verify(`outputs/release/${VERSION}`);
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, [join(f.root, 'scripts/release-assets.sh').replaceAll('\\', '/'), VERSION], { cwd: f.root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, 'stale localized presentation must stop collection');
    assert.equal(readFileSync(join(f.root, `outputs/release/${VERSION}/sentinel`), 'utf8'), 'existing artifact bytes\n');
    assert.match(result.stderr, /README\.fr\.md:.*status/i);
  } finally { f.close(); }
});

async function checker() {
  const module = await import('../scripts/check-release-presentation.ts');
  return module.checkReleasePresentation;
}

test('accepts six current localized READMEs and the actual canonical presentation without writes', async () => {
  const check = await checker();
  const f = fixture();
  try {
    const before = READMES.map((file) => readFileSync(join(f.root, file), 'utf8'));
    check(f.root);
    check(f.root, VERSION);
    assert.deepEqual(READMES.map((file) => readFileSync(join(f.root, file), 'utf8')), before);
    check(ROOT);
  } finally { f.close(); }
});

const mutations: [string, string, (text: string) => string, RegExp][] = [
  ['English stale status', 'README.md', (s) => s.replace(`**Status:** ${VERSION}`, '**Status:** 3.11.0'), /status/],
  ['French stale status', 'README.fr.md', (s) => s.replace(`**État :** ${VERSION}`, '**État :** 3.11.0'), /status/],
  ['missing status', 'README.it.md', (s) => s.replace(/^> .*\n/m, ''), /status/],
  ['linked rather than plain status version', 'README.es.md', (s) => s.replace(`**Estado:** ${VERSION}`, `**Estado:** [${VERSION}](${REPO})`), /status/],
  ['duplicate status', 'README.md', (s) => s.replace('## Novedades', `> **Estado:** ${VERSION}\n\n## Novedades`), /status/],
  ['missing start marker', 'README.de.md', (s) => s.replace(START, ''), /marker/],
  ['missing end marker', 'README.pt-BR.md', (s) => s.replace(END, ''), /marker/],
  ['duplicate start marker', 'README.fr.md', (s) => `${s}\n${START}`, /marker/],
  ['duplicate end marker', 'README.md', (s) => `${s}\n${END}`, /marker/],
  ['reversed markers', 'README.md', (s) => s.replace(START, 'PLACEHOLDER').replace(END, START).replace('PLACEHOLDER', END), /marker/],
  ['old first release version', 'README.it.md', (s) => s.replace(`**[${VERSION}]`, '**[3.11.0]'), /first release/],
  ['old first release tag', 'README.es.md', (s) => s.replace(`/releases/tag/v${VERSION}`, '/releases/tag/v3.11.0'), /first release/],
  ['wrong release repository', 'README.fr.md', (s) => s.replace(`${REPO}/releases/tag/v${VERSION}`, `https://github.com/other/sara/releases/tag/v${VERSION}`), /first release/],
  ['release URL suffix', 'README.md', (s) => s.replace(`/releases/tag/v${VERSION}`, `/releases/tag/v${VERSION}-preview`), /first release/],
  ['empty recent table', 'README.md', (s) => s.replace(/\|.*\n/g, ''), /first release/],
  ['stale row before current release', 'README.md', (s) => s.replace(`| **[${VERSION}]`, `| [3.11.0](${REPO}/releases/tag/v3.11.0) | Old first. |\n| **[${VERSION}]`), /first release/],
  ['commented current row before visible stale release', 'README.fr.md', (s) => s.replace(/^(\| \*\*\[3\.12\.4\].*)$/m, '<!--\n$1\n-->'), /first release/],
  ['fenced current row before visible stale release', 'README.es.md', (s) => s.replace(/^(\| \*\*\[3\.12\.4\].*)$/m, '```markdown\n$1\n```'), /first release/],
  ['missing download action', 'README.de.md', (s) => s.replace(`${REPO}/releases/latest`, `${REPO}/releases`), /download/],
  ['wrong download repository', 'README.it.md', (s) => s.replace(`${REPO}/releases/latest`, 'https://github.com/other/sara/releases/latest'), /download/],
  ['download URL suffix', 'README.md', (s) => s.replace(`${REPO}/releases/latest`, `${REPO}/releases/latest-preview`), /download/],
  ['missing installation action', 'README.fr.md', (s) => s.replace('href="docs/INSTALL.md"', 'href="docs/OTHER.md"'), /install/],
  ['missing repository action', 'README.es.md', (s) => s.replace(`href="${REPO}"`, `href="${REPO}-private"`), /repository/],
  ['footer action cannot replace intro action', 'README.pt-BR.md', (s) => `${s.replace(`href="${REPO}"`, 'href="LICENSE"')}\n[★](${REPO})`, /repository/],
  ['bare URL cannot replace action', 'README.md', (s) => s.replace(`<a href="${REPO}">★ Stella</a>`, REPO), /repository/],
  ['data attribute cannot replace clickable action', 'README.md', (s) => s.replace(`href="${REPO}"`, `data-href="${REPO}"`), /repository/],
  ['commented action cannot replace action', 'README.md', (s) => s.replace(`<a href="${REPO}">★ Stella</a>`, `<!-- <a href="${REPO}">★ Stella</a> -->`), /repository/],
  ...[
    ['single backtick', '`', ''],
    ['double backtick with embedded shorter run', '``', '` '],
    ['triple backtick with embedded shorter runs', '```', '` `` '],
    ['single backtick with embedded longer run', '`', '`` '],
    ['double backtick with embedded longer run', '``', '``` '],
  ].map(([name, delimiter, contents]): [string, string, (text: string) => string, RegExp] => [
    `inline-code ${name} action cannot replace action`, 'README.md',
    (s) => s.replace(`<a href="${REPO}">★ Stella</a>`, `${delimiter} ${contents}[Star](${REPO}) ${delimiter}`), /repository/,
  ]),
  ['inline-code HTML action cannot replace action', 'README.md', (s) => s.replace(`<a href="${REPO}">★ Stella</a>`, '`<a href="' + REPO + '">Star</a>`'), /repository/],
  ['inline-code current row before visible stale release', 'README.md', (s) => s.replace(/^(\| \*\*\[3\.12\.4\].*)$/m, '``\n$1\n``'), /first release/],
];

for (const [name, file, change, reason] of mutations) {
  test(`rejects ${name} with a bounded file/reason diagnostic`, async () => {
    const check = await checker();
    const f = fixture();
    try {
      f.mutate(file, change);
      assert.throws(() => check(f.root), (error: Error) => {
        assert.ok(error.message.startsWith(`${file}: `), error.message);
        assert.match(error.message, reason);
        assert.equal(error.message.includes('Une amélioration'), false);
        assert.equal(error.message.includes(f.root), false);
        assert.equal(error.message.includes('\n'), false);
        return true;
      });
    } finally { f.close(); }
  });
}

for (const file of READMES) {
  for (const missing of [true, false]) {
    test(`rejects ${missing ? 'missing' : 'empty'} ${file}`, async () => {
      const check = await checker();
      const f = fixture();
      try {
        if (missing) rmSync(join(f.root, file)); else f.write(file, ' \n\t');
        assert.throws(() => check(f.root), new RegExp(`^Error: ${file.replaceAll('.', '\\.')}:.+(read|empty)`));
      } finally { f.close(); }
    });
  }
}

test('accepts Markdown actions and CRLF without requiring any English labels', async () => {
  const check = await checker();
  const f = fixture();
  try {
    f.mutate('README.md', (s) => s.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '[$2]($1)').replace('**Status:**', '**公開版：:**').replaceAll('\n', '\r\n'));
    check(f.root);
  } finally { f.close(); }
});

for (const [name, example] of [
  ['single-backtick span', '`[Example](https://example.invalid)`'],
  ['differing unmatched backtick runs', '``` [Example](https://example.invalid)``'],
  ['double-backtick span containing shorter runs', '`` ` [Example](https://example.invalid) ` ``'],
  ['triple-backtick span containing shorter runs', '``` ` `` [Example](https://example.invalid) ```'],
  ['unmatched backtick run', '`` unmatched '],
]) {
  test(`accepts a real action adjacent to ${name}`, async () => {
    const check = await checker();
    const f = fixture();
    try {
      f.mutate('README.md', (s) => s.replace(`<a href="${REPO}">★ Stella</a>`, `${example}[Star](${REPO})`));
      check(f.root);
    } finally { f.close(); }
  });
}

test('validates package JSON and semantic version before any README', async () => {
  const check = await checker();
  const f = fixture();
  try {
    for (const text of ['not JSON', '{}', '{"version":3}', '{"version":"03.2.1"}', '{"version":"3.2"}', '{"version":"3.2.1-01"}', '{"version":"3.2.1\\nPRIVATE_FIXTURE"}']) {
      f.write('package.json', text);
      assert.throws(() => check(f.root), /^Error: package\.json: (cannot read valid JSON|invalid release version)$/);
    }
    f.write('package.json', JSON.stringify({ version: VERSION }));
    for (const version of ['3.12.5', '../3.12.4', `${VERSION}\nPRIVATE_FIXTURE`, '03.12.4']) {
      assert.throws(() => check(f.root, version), /^Error: package\.json: (release version does not match package version|invalid release version)$/);
    }
  } finally { f.close(); }
});

test('accepts matching prerelease and build semantic versions', async () => {
  const check = await checker();
  const f = fixture();
  try {
    const version = '3.12.4-rc.2+build.7';
    f.write('package.json', JSON.stringify({ version }));
    for (const file of READMES) f.mutate(file, (s) => s.replaceAll(VERSION, version));
    check(f.root, version);
  } finally { f.close(); }
});

test('real CLI uses its module root, rejects stale copy and extra arguments without leaking inputs', () => {
  const f = fixture();
  try {
    f.copyScript('check-release-presentation.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, [join(f.root, 'scripts/check-release-presentation.ts'), ...args], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(run(VERSION).status, 0);
    assert.equal(run('3.12.5').stderr.trim(), 'package.json: release version does not match package version');
    const excess = run(VERSION, 'PRIVATE_FIXTURE');
    assert.equal(excess.status, 1);
    assert.equal(excess.stderr.trim(), 'check-release-presentation.ts: expected at most one release version');
    f.mutate('README.es.md', (s) => s.replace(`**Estado:** ${VERSION}`, '**Estado:** 3.11.0 PRIVATE_FIXTURE'));
    const stale = run();
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, '');
    assert.equal(stale.stderr.trim(), 'README.es.md: status version is missing, ambiguous or stale');
  } finally { f.close(); }
});

test('rejects a trailing newline in package or explicit semantic versions', async () => {
  const check = await checker();
  const f = fixture();
  try {
    assert.throws(() => check(f.root, `${VERSION}\n`), /^Error: package\.json: invalid release version$/);
    f.write('package.json', JSON.stringify({ version: `${VERSION}\n` }));
    assert.throws(() => check(f.root), /^Error: package\.json: invalid release version$/);
  } finally { f.close(); }
});

test('collector keeps normal successful copy, checksum and notes behavior in a contained fixture', () => {
  const f = fixture();
  try {
    f.copyScript('release-assets.sh');
    f.copyScript('check-release-presentation.ts');
    f.write('clients/vscode/package.json', '{"version":"1.0.0"}\n');
    f.write('CHANGELOG.md', `## ${VERSION}\n\nSynthetic release.\n\n## 3.11.0\n\nOld release.\n`);
    f.write('deploy/get-sara.sh', '#!/bin/sh\nprintf synthetic\n');
    f.write(`outputs/release/${VERSION}/sentinel`, 'old artifact\n');
    f.verify(`outputs/release/${VERSION}`);
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, [join(f.root, 'scripts/release-assets.sh').replaceAll('\\', '/'), VERSION], { cwd: f.root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const out = join(f.root, 'outputs/release', VERSION);
    assert.equal(existsSync(join(out, 'sentinel')), false);
    assert.equal(readFileSync(join(out, 'get-sara.sh'), 'utf8'), '#!/bin/sh\nprintf synthetic\n');
    assert.match(readFileSync(join(out, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  get-sara\.sh\r?\n$/);
    assert.match(readFileSync(join(out, 'notes.md'), 'utf8'), /Synthetic release\./);
    assert.equal(readFileSync(join(out, 'notes.md'), 'utf8').includes('Old release'), false);
  } finally { f.close(); }
});
