// tools/developer-data/verify-qualified.ts knows the Data Contract Validator 1.0.1 evidence
// (docs/ops/DEVELOPER_DATA_QUALIFICATION.md, "1.0.1 security rebuild"), not only the 1.0.0 receipts.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EVIDENCE, verifyRelease } from '../tools/developer-data/verify-qualified.ts';
import { ROOT, tempDir } from './helpers.ts';

const DCV = join(ROOT, 'store', 'plugins', 'data-contract-validator');
const SIGNED_ZIP = join(ROOT, '..', 'Sara-Addons', 'outputs', 'developer-addons', 'dcv-seq5', 'publish-v5', 'v1', 'packages', 'data-contract-validator-1.0.1.zip');

test('the 1.0.1 evidence is the one recorded in the qualification doc', () => {
  const e = EVIDENCE['data-contract-validator']['1.0.1'];
  assert.equal(e.folderSha, '00b3d225764ce8de6258401452cd78111dafb756a4aa784774bc961601301694');
  assert.equal(e.runtimeSha, '50e3d3bbf998336ea9d690fbb4696aa3ab52acadcab96acfbf7b5f5a8fd1726a');
  assert.equal(e.packageSha256, 'b270dd285da6dc1b0f75bf4898e9cd1c29d036f64b0ff9f85f4ee9ad0c0f8fbc');
  assert.equal(e.packageBytes, 253_383);
  assert.deepEqual(Object.keys(e.files).sort(), ['protobuf.cjs', 'validator.mjs']);
});

test('the shipped 1.0.1 source verifies: folder and runtime hashes, the rebuilt libraries, no old version strings', () => {
  const r = verifyRelease('data-contract-validator', DCV);
  assert.equal(r.version, '1.0.1');
  assert.equal(r.folderSha, EVIDENCE['data-contract-validator']['1.0.1'].folderSha);
  assert.equal(r.runtimeSha, EVIDENCE['data-contract-validator']['1.0.1'].runtimeSha);
  assert.equal(r.package, 'not checked');
});

test('changed bytes, a leftover old library version and an unknown version are refused', () => {
  const { dir, cleanup } = tempDir();
  try {
    const copy = join(dir, 'dcv');
    cpSync(DCV, copy, { recursive: true });
    appendFileSync(join(copy, 'protobuf.cjs'), '\n');
    assert.throws(() => verifyRelease('data-contract-validator', copy), /protobuf\.cjs/);
    cpSync(DCV, join(dir, 'dcv2'), { recursive: true });
    appendFileSync(join(dir, 'dcv2', 'README.md'), '\nBuilt with protobufjs 7.5.4.\n');
    assert.throws(() => verifyRelease('data-contract-validator', join(dir, 'dcv2')), /7\.5\.4/);
    cpSync(DCV, join(dir, 'dcv3'), { recursive: true });
    const m = join(dir, 'dcv3', 'sara-plugin.json');
    writeFileSync(m, JSON.stringify({ ...JSON.parse(readFileSync(m, 'utf8')), version: '9.9.9' }));
    assert.throws(() => verifyRelease('data-contract-validator', join(dir, 'dcv3')), /no qualification evidence for data-contract-validator 9\.9\.9/);
  } finally {
    cleanup();
  }
});

test('the signed 1.0.1 package (when its receipts folder is on this PC) matches the recorded sha256, size and runtime hash', { skip: !existsSync(SIGNED_ZIP) && 'no Sara-Addons receipts next to this checkout' }, () => {
  const r = verifyRelease('data-contract-validator', DCV, SIGNED_ZIP);
  assert.equal(r.package, 'b270dd285da6dc1b0f75bf4898e9cd1c29d036f64b0ff9f85f4ee9ad0c0f8fbc');
});

