import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
test('real instrumented LCOV identifies an untested changed branch with source reference',async()=>{
 mkdirSync(resolve(root,'outputs/developer-addons/evidence'),{recursive:true});
 const out=resolve(root,'outputs/developer-addons/evidence/instrumented.lcov');
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const stage=resolve(root,'outputs/developer-addons/evidence/instrumented');mkdirSync(stage,{recursive:true});
 for(const name of ['branch.mjs','branch.test.mjs'])copyFileSync(resolve(root,'test/fixtures/developer/evidence',name),resolve(stage,name));
 const run=spawnSync(process.execPath,['--test-isolation=none','--experimental-test-coverage','--test-reporter=lcov','--test-reporter-destination='+out,'--test',resolve(stage,'branch.test.mjs')],{cwd:stage,encoding:'utf8',env});
 writeFileSync(resolve(root,'outputs/developer-addons/evidence-fix/instrumentation-run.json'),JSON.stringify({pid:run.pid,status:run.status,signal:run.signal,error:run.error?.message??null,stderr:run.stderr,exited:true},null,2));
 assert.equal(run.status,0,run.stderr);
 const lcov=readFileSync(out,'utf8');assert.match(lcov,/BRDA:/);
 const {analyzeCoverage}=await import('../tools/developer-evidence/coverage.mjs');
 const source=readFileSync(resolve(root,'test/fixtures/developer/evidence/branch.mjs'),'utf8');
 const report=analyzeCoverage({lcov,sources:[{path:'branch.mjs',text:source}],changes:[{path:'branch.mjs',start:2,end:6}]});
 assert.ok(report.branches.some((b:any)=>b.count===0&&b.changed&&b.sourceLine>=2));
 assert.equal(report.files[0].branchStatus,'partial');assert.equal(report.complete,true);
 // R2-09: mutate actual reporter records, not fabricated passing instrumentation.
 for(const altered of [lcov.replace(/FNF:\d+/, 'FNF:0').replace(/FNH:\d+/,'FNH:99'),lcov.replace(/FN:1,classify/,'FN:999999,classify'),lcov.replace(/FNDA:1,classify/,'FNDA:1,missing'),lcov.replace(/FN:1,classify/,'FN:1,classify\nFN:1,classify'),lcov.replace(/FNDA:1,classify/,'FNDA:1,classify\nFNDA:1,classify'),lcov.replace(/FNDA:1,classify\r?\n/,'')])assert.throws(()=>analyzeCoverage({lcov:altered,sources:[{path:'branch.mjs',text:source}],changes:[]}));
});
