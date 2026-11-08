/// <reference path="../../node_modules/@types/node/index.d.ts" />
// Exact-byte readback of the Data add-ons' qualification evidence (docs/ops/DEVELOPER_DATA_QUALIFICATION.md).
//
//   node tools/developer-data/verify-qualified.ts [--zip <signed data-contract-validator-1.0.1.zip>]
//
// Each add-on is checked against the evidence for the version its folder now carries:
// - 1.0.0 (both add-ons first): the receipts in outputs/developer-addons/data and data-fix (Ajv 8.17.1 /
//   protobufjs 7.5.4 bytes, the focused 66/66 gate, the inclusion oracle, channel cleanup);
// - Data Contract Validator 1.0.1 (security rebuild, sequence 5): the folder and Store runtime hashes, the
//   rebuilt protobuf.cjs / validator.mjs, no 7.5.4 / 8.17.1 string in any shipped file and, with --zip
//   (or the sequence-5 receipts next to this checkout), the signed package's sha256, size and runtime hash.
// A version with no recorded evidence is refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromFolder, fromZip, hashFiles } from '../../src/packages.ts';
import { splitListing } from '../../src/store/checks.ts';

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const runtime = (files: ReturnType<typeof fromFolder>) => splitListing(files).pkg.filter((f) => !['CHANGES.md', 'icon.png'].includes(f.path));

interface Release101 { folderSha: string; runtimeSha: string; packageSha256: string; packageBytes: number; files: Record<string, string>; forbidden: string[] }
/** Evidence per add-on and version beyond the 1.0.0 receipts (the doc's tables, verbatim). */
export const EVIDENCE: Record<string, Record<string, Release101>> = {
  'data-contract-validator': {
    '1.0.1': {
      folderSha: '00b3d225764ce8de6258401452cd78111dafb756a4aa784774bc961601301694',
      runtimeSha: '50e3d3bbf998336ea9d690fbb4696aa3ab52acadcab96acfbf7b5f5a8fd1726a',
      packageSha256: 'b270dd285da6dc1b0f75bf4898e9cd1c29d036f64b0ff9f85f4ee9ad0c0f8fbc',
      packageBytes: 253_383,
      files: { 'protobuf.cjs': '1ddc0afd1734b9bd67b30798ea186f228ec623a69c4df681d12e429f68af72a1', 'validator.mjs': '915a92b0f3270dcbe7ccf6ef5afc87f405043f703353f0a20d661db0671d731b' },
      forbidden: ['7.5.4', '8.17.1'],
    },
  },
};

/** Verifies an add-on folder (and optionally its signed package) against the evidence for its version. */
export function verifyRelease(id: string, dir: string, zip?: string): { id: string; version: string; folderSha: string; runtimeSha: string; package: string } {
  const version = String(json(join(dir, 'sara-plugin.json')).version);
  const e = EVIDENCE[id]?.[version];
  if (!e) throw new Error(`no qualification evidence for ${id} ${version}`);
  const all = fromFolder(dir);
  for (const [name, want] of Object.entries(e.files)) assert.equal(sha(readFileSync(join(dir, name))), want, `${id} ${version}: ${name} is not the qualified rebuild`);
  // The runtime files (what the package ships); CHANGES.md may name the old versions it replaced.
  for (const f of runtime(all)) for (const s of e.forbidden) assert.ok(!f.data.includes(Buffer.from(s)), `${id} ${version}: ${f.path} still mentions ${s}`);
  const folderSha = hashFiles(all), runtimeSha = hashFiles(runtime(all));
  assert.equal(folderSha, e.folderSha, `${id} ${version}: folder contentSha`);
  assert.equal(runtimeSha, e.runtimeSha, `${id} ${version}: Store runtime contentSha`);
  let pkg = 'not checked';
  if (zip) {
    const bytes = readFileSync(zip);
    assert.equal(sha(bytes), e.packageSha256, `${id} ${version}: signed package sha256`);
    assert.equal(bytes.length, e.packageBytes, `${id} ${version}: signed package size`);
    const inner = runtime(fromZip(bytes));
    assert.equal(hashFiles(inner), e.runtimeSha, `${id} ${version}: the package's runtime files`);
    for (const f of inner) for (const s of e.forbidden) assert.ok(!f.data.includes(Buffer.from(s)), `${id} ${version}: ${f.path} in the package mentions ${s}`);
    pkg = sha(bytes);
  }
  return { id, version, folderSha, runtimeSha, package: pkg };
}

/** The original 1.0.0 readback (receipts under outputs/, which are local-only). */
function verify100(ids: string[]) {
  const out = 'outputs/developer-addons/data', fix = 'outputs/developer-addons/data-fix';
  const packages = [];
  for (const id of ids) {
    const dir = `store/plugins/${id}`, receipt = json(`${out}/${id}-receipt.json`), archive = readFileSync(`${out}/${id}.zip`), source = runtime(fromFolder(dir)), files = runtime(fromZip(archive));
    assert.equal(sha(archive), receipt.archiveSha256); assert.equal(hashFiles(files), receipt.approvedSha); assert.equal(hashFiles(source), receipt.approvedSha); assert.equal(receipt.contentSha, receipt.approvedSha);
    const fileHashes = Object.fromEntries(source.map((f) => [f.path, sha(f.data)])); assert.deepEqual(fileHashes, receipt.fileHashes);
    assert.equal(sha(readFileSync(`${dir}/sara-plugin.mjs`)), sha(readFileSync('examples/plugins/sara-plugin.mjs')));
    assert.equal(receipt.saraVersion, '2.68.0'); assert.ok(Object.values(receipt.checks).every(Boolean));
    const cleanup = json(`${fix}/${id}-cleanup.json`); assert.ok(cleanup.stopAllAwaited && cleanup.toolsRemoved && cleanup.storesClosed && cleanup.scratchRemoved);
    packages.push({ id, archiveSha256: sha(archive), approvedSha: receipt.approvedSha, archiveBytes: archive.length, fileHashes, reviewedChecks: receipt.reviewedChecks, cleanup });
  }
  const log = readFileSync(`${fix}/11-final-focused.log`, 'utf8');
  const count = (key: string) => Number(log.match(new RegExp('ℹ ' + key + ' (\\d+)'))?.[1] ?? NaN);
  assert.equal(count('tests'), 66); assert.equal(count('pass'), 66); for (const key of ['fail', 'skipped', 'cancelled']) assert.equal(count(key), 0);
  const oracle = json(`${fix}/inclusion-oracle.json`); assert.equal(oracle.cases, 22); assert.equal(oracle.comparisons, oracle.results.reduce((n: number, r: { payloads: number }) => n + r.payloads, 0));
  const channels = json(`${fix}/channel-cleanup.json`); assert.equal(channels.length, 12); assert.ok(channels.every((c: { exited: boolean; pid: number }) => c.exited && Number.isInteger(c.pid)));
  if (ids.includes('data-contract-validator')) {
    const original = json(`${fix}/original/source-hashes.json`); for (const name of ['validator.mjs', 'protobuf.cjs']) assert.equal(sha(readFileSync(`store/plugins/data-contract-validator/${name}`)), original[`store/plugins/data-contract-validator/${name}`]);
    // Root whitespace gate removed exactly one extra EOF newline, not any notice substance.
    assert.equal(sha(Buffer.concat([readFileSync('store/plugins/data-contract-validator/THIRD_PARTY_LICENSES.md'), Buffer.from('\n')])), original['store/plugins/data-contract-validator/THIRD_PARTY_LICENSES.md']);
  }
  return { focused: { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') }, oracle: { cases: oracle.cases, comparisons: oracle.comparisons, finiteOnly: true }, channels: channels.length, packages, out, fix };
}

function main(argv: string[]) {
  const at = argv.indexOf('--zip');
  const seq5 = resolve('..', 'Sara-Addons', 'outputs', 'developer-addons', 'dcv-seq5', 'publish-v5', 'v1', 'packages', 'data-contract-validator-1.0.1.zip');
  const zip = at >= 0 ? argv[at + 1] : existsSync(seq5) ? seq5 : undefined;
  const ids = ['database-fixture-studio', 'data-contract-validator'];
  const versions = Object.fromEntries(ids.map((id) => [id, String(json(`store/plugins/${id}/sara-plugin.json`).version)]));
  const old = ids.filter((id) => versions[id] === '1.0.0');
  const newer = ids.filter((id) => versions[id] !== '1.0.0').map((id) => verifyRelease(id, `store/plugins/${id}`, id === 'data-contract-validator' ? zip : undefined));
  const v100 = old.length ? verify100(old) : undefined;
  const report = { authoringVersion: json('package.json').version, targetVersion: '2.68.0', node: process.version, versions, ...(v100 ? { focused: v100.focused, oracle: v100.oracle, channels: v100.channels, packages: v100.packages } : {}), releases: newer, scope: 'Working source bytes, official target pack/smoke, real PluginManager and registered tools; 1.0.1: the recorded rebuild hashes and, with the signed package, its bytes. Not full 2.68 app/chat/OS fence/full or exported suite/typecheck/publication.', ...(v100 ? { originalPreserved: `${v100.fix}/original` } : {}) };
  if (v100) {
    writeFileSync(`${v100.fix}/final-verification.json`, JSON.stringify(report, null, 2) + '\n');
    writeFileSync(`${v100.out}/final-verification.json`, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ...report, packages: (v100?.packages ?? []).map(({ fileHashes: _f, ...p }) => p) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
