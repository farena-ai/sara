// The Windows app's own update check (desktop/windows/src/app-update.cpp, ed25519-verify.cpp) against
// notices signed here with a TEST key, through the test build's AppUpdateNativeChecks.exe
// (cmake -DSARA_TEST_HOOKS=ON; build dir desktop/windows/build-test, or SARA_APPUPD_NATIVE=<exe>).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signNotice, type NoticePayload } from '../src/update-notice.ts';
import { compareVersions } from '../src/updates.ts';

const EXE = process.env.SARA_APPUPD_NATIVE ?? join(import.meta.dirname, '..', 'desktop', 'windows', 'build-test', 'Release', 'AppUpdateNativeChecks.exe');
const skip = process.platform !== 'win32' ? 'Windows only' : !existsSync(EXE) ? 'build the test app first (desktop/windows: cmake -B build-test -DSARA_TEST_HOOKS=ON)' : false;
const BASE = 'https://github.com/farena-ai/sara/releases/download/';

const { privateKey } = generateKeyPairSync('ed25519');
const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
const other = createPublicKey(generateKeyPairSync('ed25519').privateKey).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

const payload = (v: string, extra: Record<string, unknown> = {}): NoticePayload =>
  ({
    version: v,
    date: '2026-11-11T12:00:00.000Z',
    minSupported: '3.0.0',
    security: false,
    assets: {
      'win32-x64': { name: `Sara-Setup-${v}.exe`, url: `${BASE}v${v}/Sara-Setup-${v}.exe`, sha256: 'a'.repeat(64), size: 1234 },
      darwin: { name: `Sara-${v}.dmg`, url: `${BASE}v${v}/Sara-${v}.dmg`, sha256: 'b'.repeat(64) },
    },
    ...extra,
  }) as NoticePayload;

function run(dir: string, notice: unknown, opts: { key?: string; seen?: string; base?: string; raw?: string } = {}): string {
  const f = join(dir, `n${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, opts.raw ?? JSON.stringify(notice));
  return execFileSync(EXE, ['verify', f, opts.key ?? pub, opts.base ?? BASE, opts.seen ?? ''], { encoding: 'utf8' }).trim();
}

test('the app checks a signed notice like the server does', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'appupd-'));
  try {
    const good = signNotice(payload('3.4.6'), privateKey);
    assert.equal(run(dir, good), `ok 3.4.6 ${'a'.repeat(64)} plain`);
    // Text the release notes may carry (quotes, backslashes, accents, emoji) survives the JSON string.
    const fancy = signNotice(payload('3.4.7', { security: true, notes: 'café 🎉 "quoted" \\ back\nline \u2028 sep' }), privateKey);
    assert.equal(run(dir, fancy), `ok 3.4.7 ${'a'.repeat(64)} security`);
    // Same text, but the JSON escaped differently (\u escapes): the bytes signed are the same.
    const escaped = JSON.stringify(fancy).replace(/é/g, '\\u00e9').replace(/🎉/g, '\\ud83c\\udf89');
    assert.equal(run(dir, null, { raw: escaped }), `ok 3.4.7 ${'a'.repeat(64)} security`);
    // Another key, a changed payload or signature, no signature: refused.
    assert.match(run(dir, good, { key: other }), /^no the signature does not match/);
    assert.match(run(dir, { ...good, payload: good.payload!.replace('3.4.6', '3.4.9') }), /^no the signature does not match/);
    const sig = Buffer.from(good.signature!, 'base64');
    sig[5] ^= 1;
    assert.match(run(dir, { ...good, signature: sig.toString('base64') }), /^no the signature does not match/);
    assert.match(run(dir, { ...good, signature: '' }), /^no the notice is not signed/);
    assert.match(run(dir, null, { raw: '{"payload": "x", "signature": ' }), /^no the notice is not readable/);
    // s + L (the same signature, not canonical) is refused as Node refuses it.
    const s = Buffer.from(good.signature!, 'base64');
    const L = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');
    let carry = 0;
    for (let i = 32; i < 64; i++) {
      const x = s[i] + L[i - 32] + carry;
      s[i] = x & 255;
      carry = x >> 8;
    }
    assert.match(run(dir, { ...good, signature: s.toString('base64') }), /^no the signature does not match/);
    // Older than one already seen; a file somewhere else; no SHA-256; an installer that isn't one.
    assert.match(run(dir, good, { seen: '3.4.8' }), /^no the notice \(3\.4\.6\) is older than one already seen \(3\.4\.8\)/);
    assert.match(run(dir, good, { seen: '3.4.6' }), /^ok 3\.4\.6/);
    const elsewhere = payload('3.4.6');
    elsewhere.assets['win32-x64'].url = 'https://example.com/Sara-Setup-3.4.6.exe';
    assert.match(run(dir, signNotice(elsewhere, privateKey)), /^no a file in the notice is not on the release page/);
    const noSha = payload('3.4.6');
    noSha.assets['win32-x64'].sha256 = 'XYZ';
    assert.match(run(dir, signNotice(noSha, privateKey)), /^no a file in the notice has no SHA-256/);
    const zip = payload('3.4.6');
    zip.assets['win32-x64'] = { name: 'Sara-3.4.6.zip', url: `${BASE}v3.4.6/Sara-3.4.6.zip`, sha256: 'c'.repeat(64) };
    assert.match(run(dir, signNotice(zip, privateKey)), /^no the Windows file in the notice is not an installer/);
    assert.match(run(dir, signNotice({ ...payload('3.4.6'), version: '3.4' }, privateKey)), /^no the notice has no version/);
    assert.match(run(dir, signNotice({ ...payload('3.4.6'), security: 'no' as unknown as boolean }, privateKey)), /^no the notice has no security flag/);
    // Many random messages: every good signature passes and every flipped bit fails (the curve arithmetic).
    for (let i = 0; i < 12; i++) {
      const p = payload(`3.${i}.${i * 7}`, { pad: 'x'.repeat(i * 37) });
      const n = signNotice(p, privateKey);
      assert.match(run(dir, n), new RegExp(`^ok 3\\.${i}\\.${i * 7} `));
      const bad = Buffer.from(n.signature!, 'base64');
      bad[(i * 5) % 64] ^= 1 << (i % 8);
      assert.match(run(dir, { ...n, signature: bad.toString('base64') }), /^no /);
    }
    // A plain Ed25519 signature made by Node outside signNotice (the same bytes as signed).
    const raw = JSON.stringify(payload('9.9.9'));
    const direct = { format: 'sara-update-notice/1', keyId: 'whatever', payload: raw, signature: sign(null, Buffer.from(raw, 'utf8'), privateKey).toString('base64') };
    assert.match(run(dir, direct), /^ok 9\.9\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the app compares versions like the server', { skip }, () => {
  for (const [a, b] of [['3.4.5', '3.4.4'], ['v3.4.5', '3.4.5'], ['3.10.0', '3.9.9'], ['3.4.5-rc1', '3.4.5'], ['0.0.0-dev', '3.4.5'], ['4', '3.99.99'], ['3.4', '3.4.0']]) {
    const want = Math.sign(compareVersions(a, b));
    assert.equal(Number(execFileSync(EXE, ['cmp', a, b], { encoding: 'utf8' }).trim()), want, `${a} vs ${b}`);
    assert.equal(Number(execFileSync(EXE, ['cmp', b, a], { encoding: 'utf8' }).trim()), -want || 0, `${b} vs ${a}`);
  }
});
