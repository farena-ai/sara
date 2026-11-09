import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
// @ts-expect-error Standalone JS.
import {analyze,sha} from '../store/plugins/localization-qa/engine.mjs';
const input=()=>JSON.parse(readFileSync('test/fixtures/developer/localization-qa/captured-input.json','utf8'));
test('tracked real browser evidence binds source and derives exact overflow, unchanged controls never flag',()=>{
 const a=input(),r=analyze(a);assert.equal(r.layout,'measured');assert.deepEqual(r.findings.map((f:any)=>f.kind),['missing-key','extra-key','interpolation','rendered-overflow','rendered-overflow']);assert.deepEqual(r.findings.filter((f:any)=>f.kind==='rendered-overflow').map((f:any)=>[f.ref,f.viewport,f.horizontalPixels]),[['k002',390,192],['k002',900,192]]);
 assert.equal(a.evidence.htmlSha,sha(readFileSync('test/fixtures/developer/localization-qa/app.html')));assert.equal(a.evidence.captureSha,sha(readFileSync('tools/developer-localization-qa/capture.mjs')));
});
for(const [name,mutate] of Object.entries({missing:(a:any):any=>a.evidence.rows.pop(),duplicate:(a:any):any=>a.evidence.rows.push(a.evidence.rows[0]),wrongText:(a:any):any=>a.evidence.rows[0].t.textSha='0'.repeat(64),wrongCatalog:(a:any):any=>a.evidence.baseSha='0'.repeat(64),negative:(a:any):any=>a.evidence.rows[0].t.width=-1,nonfinite:(a:any):any=>a.evidence.rows[0].t.x=Infinity,wrongViewport:(a:any):any=>a.evidence.rows[0].viewport=500,baselineOverflow:(a:any):any=>a.evidence.rows[0].b.scrollWidth+=100,outside:(a:any):any=>a.evidence.rows[0].t.x=10000,textHeight:(a:any):any=>a.evidence.rows[0].t.textHeight=999,wrongRef:(a:any):any=>a.evidence.rows[0].ref='k032',verdict:(a:any):any=>a.evidence.rows[0].overflow=true,wrongDpr:(a:any):any=>a.evidence.dpr=2,wrongFixture:(a:any):any=>a.evidence.fixture='arbitrary-app',wrongHtml:(a:any):any=>a.evidence.htmlSha='0'.repeat(64),fractionalScroll:(a:any):any=>a.evidence.rows[0].t.scrollWidth+=0.2,geometrySwap:(a:any):any=>a.evidence.rows[0].t.y+=1}))test('render evidence refuses '+name,()=>{const a=input();mutate(a);assert.throws(()=>analyze(a));});
test('does not use length for overflow: replacing translated measured width with consistent fit removes finding',()=>{
 const a=input();for(const row of a.evidence.rows.filter((r:any)=>r.ref==='k002')){row.t.textWidth=100;row.t.scrollWidth=180;}
 assert.equal(analyze(a).findings.filter((x:any)=>x.kind==='rendered-overflow').length,0); // Coherent forged boxes are NOT authenticated: explicit documented trust boundary.
});
test('rejects impossible duplicate cell positions even with distinct catalog identities',()=>{
 const a=input();a.evidence.rows[1].b.y=a.evidence.rows[0].b.y;a.evidence.rows[1].t.y=a.evidence.rows[0].t.y;assert.throws(()=>analyze(a));
});
