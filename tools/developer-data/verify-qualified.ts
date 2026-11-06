/// <reference path="../../node_modules/@types/node/index.d.ts" />
// Exact-byte readback after the focused actual-manager/official-packer gate.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fromFolder,fromZip,hashFiles} from '../../src/packages.ts';
import {splitListing} from '../../src/store/checks.ts';
const out='outputs/developer-addons/data',fix='outputs/developer-addons/data-fix';
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const runtime=(files:ReturnType<typeof fromFolder>)=>splitListing(files).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));
const packages=[];
for(const id of ['database-fixture-studio','data-contract-validator']){
 const dir=`store/plugins/${id}`,receipt=json(`${out}/${id}-receipt.json`),archive=readFileSync(`${out}/${id}.zip`),source=runtime(fromFolder(dir)),files=runtime(fromZip(archive));
 assert.equal(sha(archive),receipt.archiveSha256);assert.equal(hashFiles(files),receipt.approvedSha);assert.equal(hashFiles(source),receipt.approvedSha);assert.equal(receipt.contentSha,receipt.approvedSha);
 const fileHashes=Object.fromEntries(source.map(f=>[f.path,sha(f.data)]));assert.deepEqual(fileHashes,receipt.fileHashes);
 assert.equal(sha(readFileSync(`${dir}/sara-plugin.mjs`)),sha(readFileSync('examples/plugins/sara-plugin.mjs')));
 assert.equal(receipt.saraVersion,'2.68.0');assert.ok(Object.values(receipt.checks).every(Boolean));
 const cleanup=json(`${fix}/${id}-cleanup.json`);assert.ok(cleanup.stopAllAwaited&&cleanup.toolsRemoved&&cleanup.storesClosed&&cleanup.scratchRemoved);
 packages.push({id,archiveSha256:sha(archive),approvedSha:receipt.approvedSha,archiveBytes:archive.length,fileHashes,reviewedChecks:receipt.reviewedChecks,cleanup});
}
const log=readFileSync(`${fix}/11-final-focused.log`,'utf8');
const count=(key:string)=>Number(log.match(new RegExp('ℹ '+key+' (\\d+)'))?.[1]??NaN);
assert.equal(count('tests'),66);assert.equal(count('pass'),66);for(const key of ['fail','skipped','cancelled'])assert.equal(count(key),0);
const oracle=json(`${fix}/inclusion-oracle.json`);assert.equal(oracle.cases,22);assert.equal(oracle.comparisons,oracle.results.reduce((n:number,r:any)=>n+r.payloads,0));
const channels=json(`${fix}/channel-cleanup.json`);assert.equal(channels.length,12);assert.ok(channels.every((c:any)=>c.exited&&Number.isInteger(c.pid)));
const original=json(`${fix}/original/source-hashes.json`);for(const name of ['validator.mjs','protobuf.cjs'])assert.equal(sha(readFileSync(`store/plugins/data-contract-validator/${name}`)),original[`store/plugins/data-contract-validator/${name}`]);
// Root whitespace gate removed exactly one extra EOF newline, not any notice substance.
assert.equal(sha(Buffer.concat([readFileSync('store/plugins/data-contract-validator/THIRD_PARTY_LICENSES.md'),Buffer.from('\n')])),original['store/plugins/data-contract-validator/THIRD_PARTY_LICENSES.md']);
const report={authoringVersion:json('package.json').version,targetVersion:'2.68.0',node:process.version,focused:{tests:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped'),cancelled:count('cancelled')},oracle:{cases:oracle.cases,comparisons:oracle.comparisons,finiteOnly:true},channels:channels.length,packages,scope:'Working source bytes, official target pack/smoke, real PluginManager and registered tools. Not full 2.68 app/chat/OS fence/full or exported suite/typecheck/publication.',originalPreserved:`${fix}/original`};
writeFileSync(`${fix}/final-verification.json`,JSON.stringify(report,null,2)+'\n');writeFileSync(`${out}/final-verification.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,packages:packages.map(({fileHashes,...p})=>p)},null,2));
