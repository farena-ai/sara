import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ids} from './fixtures.mjs';
import {reviewCases} from './review-fixtures.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=resolve(root,'outputs/developer-addons/evidence-fix');
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>readFileSync(resolve(root,p));
const old=JSON.parse(read('outputs/developer-addons/evidence-fix/original/evidence/qualification.json'));
const current=JSON.parse(read('outputs/developer-addons/evidence/qualification.json'));
const modules={'coverage-explorer':'coverage','log-explorer':'logs','incident-workbench':'incident','environment-config-doctor':'environment'};
const packages=ids.map(id=>{
 const previous=old.packages.find(p=>p.id===id),now=current.packages.find(p=>p.id===id),changed=[];
 for(const name of [modules[id],'safety','validate'])assert.ok(read(`tools/developer-evidence/${name}.mjs`).equals(read(`store/plugins/${id}/${name}.mjs`)));
 for(const [name,sha] of Object.entries(previous.files)){if(now.files[name]!==sha)changed.push(name);}
 for(const name of ['parameters.json','labels.json','sara-plugin.json','sara-plugin.mjs'])assert.equal(previous.files[name],now.files[name],id+'/'+name+' changed');
 assert.equal(hash(read(`outputs/developer-addons/evidence-fix/original/evidence/${id}.zip`)),previous.archiveSha256);
 assert.equal(hash(read(`outputs/developer-addons/evidence/${id}.zip`)),now.archiveSha256);
 return {id,changed,reviewCases:reviewCases(id).length,approvedSha:now.approvedSha,archiveSha256:now.archiveSha256,generatedCopiesIdentical:true,schemasLocalesManifestSDKUnchanged:true,originalArchiveHashVerified:true};
});
const channelExits=readdirSync(resolve(out,'cleanup')).map(n=>JSON.parse(readFileSync(resolve(out,'cleanup',n))));
assert.equal(channelExits.length,24);assert.ok(channelExits.every(e=>e.exitObserved));
const instrumentation=JSON.parse(readFileSync(resolve(out,'instrumentation-run.json')));assert.equal(instrumentation.status,0);assert.equal(instrumentation.error,null);assert.equal(instrumentation.stderr,'');
const result={tests:current.tests,pass:current.pass,fail:current.fail,packages,channelReviewInvocations:packages.reduce((n,p)=>n+p.reviewCases*6,0),hostReviewInvocations:packages.reduce((n,p)=>n+p.reviewCases,0),channelExits,instrumentation,limits:['No full/shared typecheck or full suite while peers write','No full 2.68 application, OS sandbox, normal chat approval, accounts/services/network/model/paid/CI/publication qualification'],frozen:true};
writeFileSync(resolve(out,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
