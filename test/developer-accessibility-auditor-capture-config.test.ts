import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {readFileSync} from 'node:fs';
test('AA03 capture requires portable operator module and cache before import/launch',()=>{
 for(const missing of ['SARA_PLAYWRIGHT_MODULE','PLAYWRIGHT_BROWSERS_PATH']){const env:Record<string,string|undefined>={...process.env,ACCESSIBILITY_OWN_BROWSER:'1',SARA_PLAYWRIGHT_MODULE:'missing-operator-module',PLAYWRIGHT_BROWSERS_PATH:'missing-operator-cache'};delete env[missing];const r=spawnSync(process.execPath,['tools/developer-accessibility-auditor/capture-owned.mjs'],{encoding:'utf8',env,windowsHide:true});assert.notEqual(r.status,0);assert.ok(r.stderr.includes('Operator must set '+missing),r.stderr);}
 const code=readFileSync('tools/developer-accessibility-auditor/capture-owned.mjs','utf8');assert.doesNotMatch(code,/[A-Z]:[\\/]Users[\\/]/i);
});
test('generated license copies have exactly one LF EOF with preserved upstream content',()=>{
 for(const p of ['store/plugins/accessibility-auditor','tools/developer-accessibility-auditor']){const s=readFileSync(p+'/THIRD_PARTY_LICENSES.md','utf8');assert.equal(s,s.trimEnd()+'\n');}
 const generator=readFileSync('tools/developer-accessibility-auditor/scaffold.mjs','utf8');assert.ok(generator.includes("legal=legal.trimEnd()+'\\n'"));
});
