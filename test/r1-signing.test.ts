// R1 (b): Windows signing through Azure Artifact Signing (signtool + the Azure.CodeSigning.Dlib dlib and a
// metadata.json), off until the owner's .secrets/azure-signing/metadata.json exists. No real credentials:
// a stand-in signtool records its arguments; the real path is only dry-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const SIGN = join(ROOT, 'desktop', 'windows', 'sign.sh');
const bash = process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].find(existsSync) : '/bin/bash';

function run(args: string[], env: Record<string, string>): { code: number; out: string } {
  const r = spawnSync(bash!, [SIGN.replace(/\\/g, '/'), ...args], { encoding: 'utf8', env: { ...process.env, SARA_SIGNTOOL: '', SARA_SIGN_DLIB: '', ...env }, timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

test('the secrets folder is gitignored and never in the repository', () => {
  const ig = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ig, /^\.secrets\/$/m);
  // Only where this is a git work tree (the server suite runs from an exported copy without .git).
  if (spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree']).status !== 0) return;
  const r = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '.secrets/azure-signing/metadata.json']);
  assert.equal(r.status, 0, '.secrets/azure-signing/metadata.json is ignored');
});

test('no metadata.json: the build says unsigned and goes on', { skip: !bash }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const f = join(dir, 'Sara.exe');
    writeFileSync(f, 'MZ');
    const r = run([f], { SARA_SIGN_DIR: join(dir, 'none') });
    assert.equal(r.code, 0);
    assert.match(r.out, /unsigned \(no Azure signing set up\)/);
    assert.equal(run(['--check'], { SARA_SIGN_DIR: join(dir, 'none') }).code, 1, '--check says not set up');
  } finally {
    cleanup();
  }
});

test('with metadata: signtool sign with the dlib, SHA256 and the Microsoft timestamp, then verify /pa', { skip: !bash }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const sd = join(dir, 'azure-signing');
    mkdirSync(join(sd, 'dlib', 'bin', 'x64'), { recursive: true });
    writeFileSync(join(sd, 'metadata.json'), JSON.stringify({ Endpoint: 'https://eus.codesigning.azure.net', CodeSigningAccountName: 'backstage', CertificateProfileName: 'sara-public' }));
    writeFileSync(join(sd, 'dlib', 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll'), 'dll');
    const log = join(dir, 'calls.txt').replace(/\\/g, '/');
    const tool = join(dir, 'signtool.sh');
    writeFileSync(tool, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(tool, 0o755);
    // A temp folder mounted noexec (the server suite's /dev/shm) can't run the stand-in: nothing to check there.
    if (process.platform !== 'win32') {
      const probe = join(dir, 'probe.sh');
      writeFileSync(probe, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(probe, 0o755);
      if (spawnSync(probe, []).error) return;
    }
    const a = join(dir, 'Sara.exe');
    const b = join(dir, 'Sara-Setup-1.0.0.exe');
    writeFileSync(a, 'MZ');
    writeFileSync(b, 'MZ');
    const env = { SARA_SIGN_DIR: sd, SARA_SIGNTOOL: tool, SARA_SIGN_SKIP_AZ: '1' };
    // Dry run: commands printed, nothing called.
    const dry = run(['--dry-run', a], env);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /would sign/);
    assert.ok(!existsSync(log), 'a dry run calls nothing');
    const r = run([a, b], env);
    assert.equal(r.code, 0, r.out);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 4, 'sign + verify for each file');
    assert.match(calls[0]!, /^sign \/v \/debug \/fd SHA256 \/tr http:\/\/timestamp\.acs\.microsoft\.com \/td SHA256 \/dlib .*Azure\.CodeSigning\.Dlib\.dll \/dmdf .*metadata\.json .*Sara\.exe$/);
    assert.match(calls[1]!, /^verify \/pa \/v .*Sara\.exe$/);
    assert.match(calls[3]!, /^verify \/pa \/v .*Sara-Setup-1\.0\.0\.exe$/);
    assert.match(r.out, /signed: Sara\.exe/);
  } finally {
    cleanup();
  }
});

test('a broken metadata.json or a missing dlib stops the build instead of shipping unsigned', { skip: !bash }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const sd = join(dir, 'azure-signing');
    mkdirSync(sd, { recursive: true });
    const f = join(dir, 'Sara.exe');
    writeFileSync(f, 'MZ');
    writeFileSync(join(sd, 'metadata.json'), JSON.stringify({ Endpoint: 'https://evil.example', CodeSigningAccountName: 'a', CertificateProfileName: 'b' }));
    const bad = run([f], { SARA_SIGN_DIR: sd, SARA_SIGNTOOL: f, SARA_SIGN_SKIP_AZ: '1' });
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /Endpoint/);
    writeFileSync(join(sd, 'metadata.json'), JSON.stringify({ Endpoint: 'https://wus2.codesigning.azure.net/', CodeSigningAccountName: 'a', CertificateProfileName: 'b' }));
    const nodll = run([f], { SARA_SIGN_DIR: sd, SARA_SIGNTOOL: f, SARA_SIGN_SKIP_AZ: '1' });
    assert.notEqual(nodll.code, 0);
    assert.match(nodll.out, /Azure\.CodeSigning\.Dlib\.dll/);
    assert.match(nodll.out, /WINDOWS_SIGNING\.md/);
  } finally {
    cleanup();
  }
});

test('build-installer signs the exes before packing and the installer after; ship-release points at the real secrets', () => {
  const b = readFileSync(join(ROOT, 'desktop', 'windows', 'build-installer.sh'), 'utf8');
  const pack = b.indexOf('"$ISCC" /Q');
  const signExes = b.indexOf('sign.sh" "$STAGE/Sara.exe" "$STAGE/SaraService.exe"');
  assert.ok(pack > 0 && signExes > 0 && signExes < pack, 'exes signed before Inno packs them');
  assert.ok(b.indexOf('sign.sh" "$OUT/Sara-Setup-$VERSION.exe"') > pack, 'the installer signed after');
  assert.ok(b.indexOf('sign.sh" "$OUT/Sara-Setup-$VERSION.exe"') < b.indexOf('sha256sum "$OUT/Sara-Setup-$VERSION.exe"'), 'the checksum is of the signed file');
  assert.match(readFileSync(join(ROOT, 'docs', 'ops', 'ship-release.sh'), 'utf8'), /SARA_SIGN_DIR="\$ROOT\/\.secrets\/azure-signing"/);
  const doc = readFileSync(join(ROOT, 'docs', 'ops', 'WINDOWS_SIGNING.md'), 'utf8');
  for (const s of ['Microsoft.ArtifactSigning.Client', 'az login', 'CertificateProfileName', 'metadata.json', 'signtool verify /pa']) assert.ok(doc.includes(s), s);
});

test('V0.6 the Inno uninstaller is signed too: SignTool + SignedUninstaller only when signing is set up', () => {
  const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
  const setup = iss.slice(iss.indexOf('[Setup]'), iss.indexOf('\n[', iss.indexOf('[Setup]') + 1));
  // Guarded: without /DSignTool ISCC builds an unsigned Setup exactly as before.
  assert.match(setup, /#ifdef SignTool\r?\nSignTool=\{#SignTool\}\r?\nSignedUninstaller=yes\r?\n#endif/);
  const b = readFileSync(join(ROOT, 'desktop', 'windows', 'build-installer.sh'), 'utf8');
  // The same Azure path: Inno calls sign.sh for Setup and its uninstaller ($f = the file, quoted by Inno).
  assert.match(b, /if bash "\$HERE\/sign\.sh" --check/);
  assert.ok(b.includes(String.raw`ISS_SIGN=(/DSignTool=sarasign "/Ssarasign=\$q$(winpath "$(command -v bash)")\$q \$q$(winpath "$HERE/sign.sh")\$q \$f")`), 'the sign tool runs sign.sh');
  assert.match(b, /"\$ISCC" \/Q [^\n]*"\$\{ISS_SIGN\[@\]\}"/, 'ISCC gets the sign tool');
  // Inno already signed Setup when signing is on; unsigned builds still say so after packing.
  assert.match(b, /if \[\[ \$\{#ISS_SIGN\[@\]\} == 0 \]\]; then bash "\$HERE\/sign\.sh" "\$OUT\/Sara-Setup-\$VERSION\.exe"; fi/);
  assert.match(readFileSync(join(ROOT, 'docs', 'ops', 'WINDOWS_SIGNING.md'), 'utf8'), /uninstaller/i);
});
