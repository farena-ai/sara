import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fromFolder,fromZip,hashFiles} from '../../src/packages.ts';
import {splitListing} from '../../src/store/checks.ts';
const root=process.cwd(),id='sql-migration-reviewer',out=join(root,'outputs/developer-addons/sql');
const receipt=JSON.parse(readFileSync(join(out,id+'-receipt.json'),'utf8')),zip=readFileSync(join(out,id+'.zip'));
const runtime=(files:ReturnType<typeof fromFolder>)=>splitListing(files).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));
const source=runtime(fromFolder(join(root,'store/plugins',id))),archive=runtime(fromZip(zip));
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(zip),receipt.archiveSha256);assert.equal(hashFiles(source),receipt.approvedSha);assert.equal(hashFiles(archive),receipt.approvedSha);assert.equal(receipt.contentSha,receipt.approvedSha);
assert.deepEqual(Object.fromEntries(source.map(f=>[f.path,sha(f.data)])),receipt.fileHashes);
const file=(name:string)=>source.find(f=>f.path===name)!.data;
assert.deepEqual(file('sara-plugin.mjs'),readFileSync(join(root,'examples/plugins/sara-plugin.mjs')));assert.deepEqual(file('LICENSE'),readFileSync(join(root,'LICENSE')));
for(const f of source.filter(f=>/\.(mjs|json|md)$/.test(f.path))){const s=f.data.toString('utf8');assert.ok(s.endsWith('\n')&&!s.endsWith('\n\n'),f.path+': exactly one EOF newline');}
const result={id,node:process.version,authoringSara:receipt.authoringSara,targetSara:receipt.targetSara,archiveSha256:sha(zip),contentSha:hashFiles(source),runtimeFiles:source.length,archiveEqualsSource:true,approvedEqualsSource:true,sdkUnchanged:true,fullLicenseUnchanged:true,exactEof:true,claims:{osSandbox:false,chatApproval:false,complete268App:false,selectedWorkspace:false}};
writeFileSync(join(out,'frozen-byte-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
