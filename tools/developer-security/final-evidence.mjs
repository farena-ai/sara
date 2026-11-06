// Read back final source/archive/host receipts; this is evidence, not an assertion generator.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromFolder,fromZip,hashFiles} from '../../src/packages.ts';
import {splitListing} from '../../src/store/checks.ts';
import {ids} from './fixtures.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'../..'),out=join(root,'outputs/developer-addons/security');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtime=files=>splitListing(files).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));
const packages=ids.map(id=>{
 const receipt=JSON.parse(readFileSync(join(out,id+'-receipt.json'),'utf8'));
 const files=runtime(fromFolder(join(root,'store/plugins',id))),archive=readFileSync(join(out,id+'.zip'));
 assert.equal(hashFiles(files),receipt.approvedSha);assert.equal(hashFiles(runtime(fromZip(archive))),receipt.approvedSha);assert.equal(sha(archive),receipt.archiveSha256);
 for(const file of files)assert.equal(sha(file.data),receipt.fileHashes[file.path]);
 assert.ok(readFileSync(join(root,'examples/plugins/sara-plugin.mjs')).equals(files.find(f=>f.path==='sara-plugin.mjs').data));
 return {id,approvedSha:receipt.approvedSha,archiveSha256:receipt.archiveSha256,archiveBytes:archive.length,runtimeFiles:files.length,checks:receipt.checks};
});
const proofFiles=['tools/developer-security/bom-1.5.schema.json','tools/developer-security/spdx.schema.json','tools/developer-security/jsf-0.82.schema.json','tools/developer-security/purl-npm-definition.json','tools/developer-security/package-lock.json','tools/developer-security/fixtures.mjs','tools/developer-security/final-evidence.mjs','test/fixtures/developer/security/npm-generated-v2.json','test/fixtures/developer/security/npm-generated-v3.json','test/developer-security.test.ts','test/developer-security-channel.test.ts','test/developer-security-host.test.ts','test/developer-security-scanner.test.ts'];
const hashes=Object.fromEntries(proofFiles.map(path=>[path,sha(readFileSync(join(root,path)))]));
const finalLog=readFileSync(join(out,'focused-final.log'),'utf8');
const counts=Object.fromEntries([...finalLog.matchAll(/ℹ (tests|pass|fail|skipped) (\d+)/g)].map(m=>[m[1],Number(m[2])]));
assert.equal(counts.fail,0);assert.equal(counts.tests,counts.pass);assert.equal(packages.length,4);
assert.equal(counts.tests,56);assert.equal(counts.skipped,0);
assert.equal([...finalLog.matchAll(/actual permission-limited ready, result card and non-echo error/g)].length,24);
const contracts=JSON.parse(readFileSync(join(out,'host-contracts.json'),'utf8'));assert.equal(contracts.release,'2.68.0');assert.ok(contracts.files.every(f=>f.byteEqual));
for(const file of contracts.files) assert.equal(sha(readFileSync(join(root,file.path))),file.upstreamSha256,'current host contract: '+file.path);
const original=join(root,'outputs/developer-addons/scanner-fix/original/security');
const originalQualification=JSON.parse(readFileSync(join(original,'qualification.json'),'utf8'));
for(const pkg of packages) {
 const previous=originalQualification.packages.find(p=>p.id===pkg.id);assert.ok(previous);
 if(pkg.id==='secret-scanner') {assert.notEqual(pkg.approvedSha,previous.approvedSha);assert.notEqual(pkg.archiveSha256,previous.archiveSha256);}
 else {assert.equal(pkg.approvedSha,previous.approvedSha);assert.equal(pkg.archiveSha256,previous.archiveSha256);assert.ok(readFileSync(join(out,pkg.id+'.zip')).equals(readFileSync(join(original,pkg.id+'.zip'))));}
}
const report={scope:'Final working source, not clean committed-tree release',node:process.version,tests:counts,packageCount:packages.length,packages,sourceHashes:hashes,contractsReference:contracts.reference,contractsByteEqual:contracts.files.length,languageChannelCases:24,qualifies:['bounded explicit supplied-data analyzers','real parser and Ed25519/hash behavior','Windows node-permission subprocesses','official pack/smoke','real PluginManager registered-tool/card lifecycle','final source/archive/approval byte equality'],doesNotQualify:['OS sandbox','ordinary chat approval','automatic workspace/history scans','dependency graph completeness or artifact fetch verification','universal legal approval','Sigstore/SLSA/certificates','accounts/paid models','signed publication','full combined suite']};
report.previousEvidence={path:'outputs/developer-addons/scanner-fix/original/security',tests:originalQualification.tests,scope:'Historical older scanner bytes; not current qualification'};
report.currentTypecheck='Not run while peer lanes write; historical passing type log is not current evidence';
report.unchangedPackages=packages.filter(p=>p.id!=='secret-scanner').map(p=>p.id);
report.authoringVersion=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
writeFileSync(join(out,'qualification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
