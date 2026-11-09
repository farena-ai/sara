import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READMES = ['README.md', 'README.es.md', 'README.fr.md', 'README.de.md', 'README.pt-BR.md', 'README.it.md'];
const EMAIL = '12345+sara-fixture@users.noreply.github.com';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Sara Fixture', '-c', `user.email=${EMAIL}`, '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sara-readme-'));
  const source = join(dir, 'private');
  const publicDir = join(dir, 'public');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  mkdirSync(publicDir);
  for (const script of ['publish-public.ts', 'public-export.ts', 'public-readme.ts']) {
    if (existsSync(join(ROOT, 'scripts', script))) copyFileSync(join(ROOT, 'scripts', script), join(source, 'scripts', script));
  }
  writeFileSync(join(source, 'package.json'), '{"type":"module","version":"2.65.0"}\n');
  writeFileSync(join(source, 'runtime.ts'), 'private future runtime\n');
  writeFileSync(join(source, 'AGENTS.md'), 'private operational notes\n');
  for (const file of READMES) writeFileSync(join(source, file), `# New ${file}\nInstall Sara and star the project.\n`);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'Private independent root');
  git(publicDir, 'init', '-q', '-b', 'main');
  for (const file of READMES) writeFileSync(join(publicDir, file), `# Old ${file}\n`);
  writeFileSync(join(publicDir, 'runtime.ts'), 'released runtime\n');
  writeFileSync(join(publicDir, 'release.bin'), Buffer.from([0, 255, 42, 8]));
  writeFileSync(join(publicDir, '.gitattributes'), '*.md text eol=lf\n');
  git(publicDir, 'add', '-A');
  git(publicDir, 'commit', '-qm', 'Public independent root');
  git(publicDir, 'tag', '-a', 'v2.65.0', '-m', 'Immutable existing release');
  git(publicDir, 'branch', 'maintenance');
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '--bare', '-q', publicDir, remote);
  const before = git(remote, 'for-each-ref', '--format=%(objectname) %(refname)');
  const base = git(publicDir, 'rev-parse', 'HEAD');
  // Git for Windows may decode a rewritten file:///C:/ URL as the invalid /C:/ path.
  // Use its native absolute local prefix; Unix keeps the normal file URL fixture.
  const localPrefix = process.platform === 'win32' ? `${dir.replaceAll('\\', '/')}/` : `${pathToFileURL(dir).href}/`;
  const env = { ...process.env, SARA_PUBLIC_NAME: 'Sara Fixture', SARA_PUBLIC_EMAIL: EMAIL, SARA_PUBLIC_COAUTHORS: '', SARA_PRIVATE_PATTERNS: join(dir, 'private-patterns.json'), GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'), GIT_CONFIG_SYSTEM: join(dir, 'no-system-config'), GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${localPrefix}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/readme-fixture/', GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' };
  // Empty identity overrides are removed so the publisher's explicit no-reply config is authoritative.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete (env as Record<string, string | undefined>)[key];
  return { dir, source, publicDir, remote, before, base, env, run(extra: string[] = [], readmeOnly = true) { return spawnSync(process.execPath, [join(source, 'scripts', 'publish-public.ts'), ...(readmeOnly ? ['--readme-only'] : []), '--repo', 'readme-fixture/remote', ...extra], { cwd: source, env, encoding: 'utf8' }); }, close() { rmSync(dir, { recursive: true, force: true }); } };
}

function denied(f: ReturnType<typeof fixture>, pattern: RegExp) {
  const result = f.run(['--push']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr + result.stdout, pattern);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'), f.before, 'rejection must leave all remote refs intact');
}

test('README-only CLI makes one no-reply public child, preserving every other blob, mode and release tag', () => {
  const f = fixture();
  try {
    // Exercise normal Git line-ending normalization rather than requiring raw source byte equality.
    writeFileSync(join(f.source, 'README.md'), '# New README.md\r\nInstall Sara and star the project.\r\n');
    const result = f.run(['--push']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const head = git(f.remote, 'rev-parse', 'main');
    assert.equal(git(f.remote, 'rev-parse', 'main^'), f.base);
    assert.deepEqual(git(f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n').sort(), [...READMES].sort());
    const outside = (revision: string) => git(f.remote, 'ls-tree', '-r', revision).split('\n').filter((line) => !READMES.includes(line.split('\t')[1]!));
    assert.deepEqual(outside(head), outside(f.base));
    assert.equal(git(f.remote, 'show', 'main:runtime.ts'), 'released runtime');
    const protectedRefs = (refs: string) => refs.split('\n').filter((line) => !line.endsWith(' refs/heads/main'));
    assert.deepEqual(protectedRefs(git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)')), protectedRefs(f.before));
    assert.equal(git(f.remote, 'log', '-1', '--format=%ae%n%ce', 'main'), `${EMAIL}\n${EMAIL}`);
    assert.equal(git(f.remote, 'rev-list', '--count', 'main'), '2');
    assert.throws(() => git(f.remote, 'cat-file', '-e', `${git(f.source, 'rev-parse', 'HEAD')}^{commit}`));
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags'), f.before.split('\n').filter((line) => line.includes('refs/tags/')).join('\n'));
    assert.equal(git(f.remote, 'show', 'main:README.md'), '# New README.md\nInstall Sara and star the project.');
    assert.equal(existsSync(join(f.source, 'outputs', 'public-export')), false, 'does not export pending private runtime or helper files');
  } finally { f.close(); }
});

test('preview updates only the disposable clone and leaves remote refs unchanged', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'), f.before);
    assert.equal(git(join(f.source, 'outputs', 'public-repo'), 'rev-parse', 'HEAD^'), f.base);
  } finally { f.close(); }
});

for (const kind of ['missing', 'directory', 'source-link-mode', 'public-link-mode', 'empty-base', 'private-history', 'wrong-root-author', 'personal-identity', 'secret', 'private-pattern', 'no-op', 'output-link', 'output-parent-link', 'untracked-source', 'empty-input', 'missing-public', 'non-main-base', 'inherited-identity', 'non-readme-hook', 'readme-link-hook', 'secret-hook', 'tag-hook'] as const) {
  test(`README-only CLI rejects ${kind} before changing remote refs`, (t) => {
    const f = fixture();
    try {
      let pattern = /README|regular|symlink|history|public repository|identity|no-reply|secret|private|Nothing changed|existing|outputs/i;
      if (kind === 'missing') rmSync(join(f.source, 'README.fr.md'));
      if (kind === 'directory') { rmSync(join(f.source, 'README.fr.md')); mkdirSync(join(f.source, 'README.fr.md')); }
      if (kind === 'source-link-mode') { const blob = git(f.source, 'hash-object', '-w', 'README.fr.md'); git(f.source, 'update-index', '--cacheinfo', `120000,${blob},README.fr.md`); }
      if (kind === 'public-link-mode') {
        const blob = git(f.publicDir, 'hash-object', '-w', 'README.fr.md');
        git(f.publicDir, 'update-index', '--cacheinfo', `120000,${blob},README.fr.md`);
        git(f.publicDir, 'commit', '-qm', 'Unsafe public link');
        git(f.publicDir, 'push', '-q', f.remote, 'main');
        f.before = git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)');
      }
      if (kind === 'empty-base') { git(f.remote, 'update-ref', '-d', 'refs/heads/main'); git(f.remote, 'update-ref', '-d', 'refs/tags/v2.65.0'); f.before = git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'); }
      if (kind === 'private-history') { git(f.source, 'push', '-q', f.remote, 'HEAD:refs/heads/main', '--force'); f.before = git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'); }
      if (kind === 'wrong-root-author') f.env.SARA_PUBLIC_EMAIL = '67890+other@users.noreply.github.com';
      if (kind === 'personal-identity') f.env.SARA_PUBLIC_EMAIL = 'person@example.test';
      if (kind === 'secret') writeFileSync(join(f.source, 'README.md'), 'credential: gh' + 'p_' + 'a'.repeat(32));
      if (kind === 'private-pattern') { writeFileSync(join(f.dir, 'private-patterns.json'), JSON.stringify({ patterns: [{ kind: 'fixture private marker', re: 'PRIVATE_FIXTURE_MARKER' }] })); writeFileSync(join(f.source, 'README.md'), 'PRIVATE_FIXTURE_MARKER'); }
      if (kind === 'no-op') for (const file of READMES) writeFileSync(join(f.source, file), readFileSync(join(f.publicDir, file)));
      if (kind === 'untracked-source') git(f.source, 'rm', '--cached', 'README.fr.md');
      if (kind === 'empty-input') writeFileSync(join(f.source, 'README.fr.md'), '');
      if (kind === 'missing-public') { git(f.publicDir, 'rm', 'README.fr.md'); git(f.publicDir, 'commit', '-qm', 'Missing public README'); git(f.publicDir, 'push', '-q', f.remote, 'main'); f.before = git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'); }
      if (kind === 'non-main-base') git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/maintenance');
      if (kind === 'inherited-identity') Object.assign(f.env, { GIT_AUTHOR_EMAIL: 'unexpected@example.test' });
      if (kind === 'output-parent-link') symlinkSync(f.publicDir, join(f.source, 'outputs'), 'junction');
      if (kind === 'output-link') { mkdirSync(join(f.source, 'outputs')); symlinkSync(f.publicDir, join(f.source, 'outputs', 'public-repo'), 'junction'); }
      if (kind === 'non-readme-hook' || kind === 'readme-link-hook' || kind === 'secret-hook' || kind === 'tag-hook') {
        const hooks = join(f.dir, 'hooks'); mkdirSync(hooks);
        // Git can only run these hooks where the temporary folder allows programs (the server's
        // /tmp is mounted noexec). Probe with a harmless script and skip there instead of failing.
        if (process.platform !== 'win32') {
          const probe = join(hooks, 'exec-probe');
          writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          if (spawnSync(probe, [], { cwd: hooks }).status !== 0) { t.skip('the temporary folder does not allow running programs (noexec), so git hooks cannot run here'); return; }
          rmSync(probe);
        }
        writeFileSync(join(hooks, 'pre-commit'), kind === 'non-readme-hook'
          ? '#!/bin/sh\nprintf changed > runtime.ts\ngit add -- runtime.ts\n'
          : kind === 'readme-link-hook'
            ? '#!/bin/sh\nblob=$(git hash-object README.md)\ngit update-index --cacheinfo 120000,$blob,README.md\n'
            : kind === 'secret-hook'
              ? '#!/bin/sh\nprintf credential:gh' + 'p_' + 'a'.repeat(32) + ' > README.md\ngit add -- README.md\n'
              : '#!/bin/sh\ngit tag injected-tag\n', { mode: 0o755 });
        f.env.GIT_CONFIG_COUNT = '3';
        Object.assign(f.env, { GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: hooks.replaceAll('\\', '/') });
        pattern = /README|refs|tags|scope|regular/i;
      }
      denied(f, pattern);
      if (kind === 'output-link') assert.equal(git(f.publicDir, 'rev-parse', 'HEAD'), f.base, 'never follow an output link to overwrite an outside repository');
    } finally { f.close(); }
  });
}


test('ordinary full release still exports runtime, preserves executable mode, and creates its version tag', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, 'package.json'), '{"type":"module","version":"2.65.1"}\n');
    git(f.source, 'update-index', '--chmod=+x', 'runtime.ts');
    const result = f.run(['--push'], false);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(git(f.remote, 'show', 'main:runtime.ts'), 'private future runtime');
    assert.match(git(f.remote, 'ls-tree', 'main', 'runtime.ts'), /^100755 /);
    assert.equal(git(f.remote, 'rev-parse', 'v2.65.1^{}'), git(f.remote, 'rev-parse', 'main'));
    assert.equal(git(f.remote, 'rev-parse', 'v2.65.0^{}'), f.base);
    assert.throws(() => git(f.remote, 'cat-file', '-e', 'main:AGENTS.md'));
  } finally { f.close(); }
});

for (const readmeOnly of [true, false]) {
  for (const identity of ['AUTHOR', 'COMMITTER'] as const) {
    test(`${readmeOnly ? 'README-only' : 'full release'} rejects ${identity.toLowerCase()} email disguised by a no-reply display name`, () => {
      const f = fixture();
      try {
        if (!readmeOnly) writeFileSync(join(f.source, 'package.json'), '{"type":"module","version":"2.65.1"}\n');
        Object.assign(f.env, {
          [`GIT_${identity}_NAME`]: `Fixture ${EMAIL}`,
          [`GIT_${identity}_EMAIL`]: 'unexpected@example.test',
        });
        const result = f.run(['--push'], readmeOnly);
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stderr + result.stdout, /identity|author|committer|email/i);
        assert.equal(git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'), f.before, 'invalid metadata must never reach any remote ref');
      } finally { f.close(); }
    });
  }
}

test('ordinary full preview explicitly replaces its prior disposable export without publishing', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, 'package.json'), '{"type":"module","version":"2.65.1"}\n');
    const first = f.run([], false);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const exportDir = join(f.source, 'outputs', 'public-export');
    writeFileSync(join(exportDir, 'stale.txt'), 'old disposable export');
    writeFileSync(join(f.source, 'runtime.ts'), 'fresh second preview\n');
    const second = f.run([], false);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(readFileSync(join(exportDir, 'runtime.ts'), 'utf8'), 'fresh second preview\n');
    assert.equal(existsSync(join(exportDir, 'stale.txt')), false);
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(objectname) %(refname)'), f.before);
  } finally { f.close(); }
});

test('README-only also publishes the tracked images the READMEs show, and nothing else', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.source, 'docs', 'screenshots'), { recursive: true });
    writeFileSync(join(f.source, 'docs', 'screenshots', 'new-look.webp'), Buffer.from([82, 73, 70, 70, 1, 2, 3]));
    writeFileSync(join(f.source, 'docs', 'screenshots', 'unused.webp'), Buffer.from([9, 9]));
    for (const file of READMES) writeFileSync(join(f.source, file), `# New ${file}\n<img src="docs/screenshots/new-look.webp" alt="">\n`);
    git(f.source, 'add', '-A');
    git(f.source, 'commit', '-qm', 'Screens');
    const result = f.run(['--push']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const head = git(f.remote, 'rev-parse', 'main');
    assert.deepEqual(git(f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n').sort(), [...READMES, 'docs/screenshots/new-look.webp'].sort());
    assert.equal(git(f.remote, 'show', 'main:runtime.ts'), 'released runtime');
  } finally { f.close(); }
});

test('README-only refuses an image the READMEs show that is not tracked in the source', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.source, 'docs', 'screenshots'), { recursive: true });
    writeFileSync(join(f.source, 'docs', 'screenshots', 'local-only.webp'), Buffer.from([1]));
    for (const file of READMES) writeFileSync(join(f.source, file), `# New ${file}\n![x](docs/screenshots/local-only.webp)\n`);
    denied(f, /image.*tracked/i);
  } finally { f.close(); }
});
