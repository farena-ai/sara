import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';import {fromFolder,fromZip,hashFiles} from '../../src/packages.ts';import {splitListing} from '../../src/store/checks.ts';
const root=process.cwd(),out=join(root,'outputs/developer-addons/code-graph');const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');const inventory=[];
const runtime=(files:ReturnType<typeof fromFolder>)=>splitListing(files).pkg.filter(f=>!['CHANGES.md','icon.png'].includes(f.path));
const fix=join(root,'outputs/developer-addons/code-graph-fix');
const original=Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(fix,'original/source-inventory.json'),'utf8'))).map(([path,hash])=>[path.replaceAll('\\','/'),hash]));
for(const [path,hash] of Object.entries(original))assert.equal(sha(readFileSync(join(fix,'original/source',path))),hash,'preserved original source bytes');
const regressions=JSON.parse(readFileSync(join(root,'test/fixtures/developer/code-graph/review.json'),'utf8'));
for(const name of ['parser.mjs','THIRD_PARTY_LICENSES.md','package-lock.json','vendor-review.json'])assert.equal(sha(readFileSync(join(root,'tools/developer-code-graph',name))),original['tools/developer-code-graph/'+name],'reviewed pinned vendor unchanged');
for(const id of ['change-impact-analyzer','architecture-guard']){
 const oldReceipt=JSON.parse(readFileSync(join(fix,'original/code-graph',id+'-receipt.json'),'utf8')),oldZip=readFileSync(join(fix,'original/code-graph',id+'.zip'));
 assert.equal(sha(oldZip),oldReceipt.archiveSha256);assert.equal(hashFiles(runtime(fromZip(oldZip))),oldReceipt.approvedSha);assert.equal(hashFiles(runtime(fromFolder(join(fix,'original/source/store/plugins',id)))),oldReceipt.approvedSha);
 const dir=join(root,'store/plugins',id),receipt=JSON.parse(readFileSync(join(out,id+'-receipt.json'),'utf8')),zip=readFileSync(join(out,id+'.zip')),files=runtime(fromZip(zip)),source=runtime(fromFolder(dir));
 assert.equal(sha(zip),receipt.archiveSha256);assert.equal(hashFiles(files),receipt.approvedSha);assert.equal(hashFiles(source),receipt.approvedSha);assert.equal(receipt.approvedSha,receipt.contentSha);
 for(const f of files)assert.equal(sha(f.data),receipt.fileHashes[f.path]);for(const name of ['graph.mjs','schemas.mjs','parser.mjs','THIRD_PARTY_LICENSES.md'])assert.deepEqual(readFileSync(join(dir,name)),readFileSync(join(root,'tools/developer-code-graph',name)));
 assert.deepEqual(readFileSync(join(dir,'sara-plugin.mjs')),readFileSync(join(root,'examples/plugins/sara-plugin.mjs')));
 assert.equal(sha(readFileSync(join(dir,'LICENSE'))),original['store/plugins/'+id+'/LICENSE'],'full standalone MIT grant unchanged');
 assert.equal(receipt.reviewChecks.length,regressions.length);for(const [i,row] of regressions.entries()){const actual=receipt.reviewChecks[i];assert.equal(actual.name,row.name);if(row.refused)assert.equal(actual.refused,true);else{assert.equal(actual.complete,row.complete);assert.equal(actual.resultCard,true);}}
 for(const name of ['LICENSE','THIRD_PARTY_LICENSES.md']){const s=readFileSync(join(dir,name),'utf8');assert.equal(s,s.trimEnd()+'\n');assert.ok(s.includes('Permission is hereby granted'));}
 assert.deepEqual(JSON.parse(readFileSync(join(out,id+'-cleanup.json'),'utf8')),{id,stopAllAwaited:true,toolsRemoved:true,storesClosed:true,scratchRemoved:true});
 const total=fromFolder(dir).reduce((n,f)=>n+f.data.length,0);assert.ok(total<5*1024*1024);inventory.push({id,packageBytes:total,archiveBytes:zip.length,archiveSha256:sha(zip),approvedSha:receipt.approvedSha,parserSha256:sha(readFileSync(join(dir,'parser.mjs'))),sourceArchiveApprovedEqual:true});
}
const lock=JSON.parse(readFileSync(join(root,'tools/developer-code-graph/package-lock.json'),'utf8'));for(const [path,p] of Object.entries(lock.packages) as [string,any][]){if(path)assert.ok(p.integrity&&p.resolved,'every dependency has registry resolution and integrity');}
const vendor=JSON.parse(readFileSync(join(root,'tools/developer-code-graph/vendor-review.json'),'utf8'));assert.ok(vendor.packages.every((p:any)=>p.license==='MIT'));const summary={node:process.version,rootVersion:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,tmpdir:(await import('node:os')).tmpdir(),inventory,vendorPackages:vendor.packages.length,lockedPrereleases:vendor.packages.filter((p:any)=>p.version.includes('-')),claims:{osSandbox:false,chatApproval:false,full268Application:false,fullRootSuite:false,exportedSourceSuite:false,signedPublished:false}};
writeFileSync(join(out,'final-byte-verification.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
const channels=JSON.parse(readFileSync(join(out,'channel-cleanup.json'),'utf8'));assert.equal(channels.records.length,12);assert.equal(new Set(channels.records.map((r:any)=>r.id+'/'+r.lang)).size,12);assert.ok(channels.records.every((r:any)=>r.exited===true));
const evidence=JSON.parse(readFileSync(join(fix,'review-evidence.json'),'utf8'));assert.ok(evidence.pointers>0&&evidence.lexicalBindings>0);assert.equal(evidence.callOwners,evidence.targetNodes);
const current=Object.fromEntries([...Object.keys(original),'test/developer-code-graph-review.test.ts','test/fixtures/developer/code-graph/review.json'].sort().map(path=>[path,sha(readFileSync(join(root,path)))]));
const changed=Object.keys(current).filter(path=>current[path]!==original[path]);
writeFileSync(join(fix,'final-source-inventory.json'),JSON.stringify({hash:'sha256',files:current,changed,reviewFixtureCount:regressions.length,evidence,channels:channels.records.length,reviewedVendorUnchanged:true,claims:summary.claims},null,2)+'\n');
console.log(JSON.stringify({sourceFiles:Object.keys(current).length,changedFiles:changed.length,reviewFixtureCount:regressions.length,evidence,channels:channels.records.length}));
