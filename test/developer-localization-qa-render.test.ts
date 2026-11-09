import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
// @ts-expect-error Owned capture utility JS.
import {capture} from '../tools/developer-localization-qa/capture.mjs';
// @ts-expect-error Standalone JS.
import {analyze} from '../store/plugins/localization-qa/engine.mjs';
test('opt-in owned Chromium measures exact expanded element, controls, catalog identity; native analyzer derives verdict',{skip:process.env.SARA_LOCALIZATION_BROWSER!=='1',timeout:60000},async()=>{
 const args=await capture();const report=analyze(args);assert.equal(report.layout,'measured');
 assert.deepEqual(report.findings.filter((x:any)=>x.kind==='rendered-overflow').map((x:any)=>[x.ref,x.viewport]),[['k002',390],['k002',900]]);
 for(const kind of ['missing-key','extra-key','interpolation'])assert.ok(report.findings.some((x:any)=>x.kind===kind));
 assert.ok(args.evidence.rows.filter((x:any)=>x.ref==='k001').every((x:any)=>x.b.scrollWidth===x.t.scrollWidth));
 for(const mutate of [(a:any)=>a.evidence.rows.pop(),(a:any)=>a.evidence.rows.push(a.evidence.rows[0]),(a:any)=>a.evidence.rows[0].t.textSha='0'.repeat(64),(a:any)=>a.evidence.baseSha='0'.repeat(64),(a:any)=>a.evidence.rows[0].t.width=-1,(a:any)=>a.evidence.rows[0].t.scrollWidth=0,(a:any)=>a.evidence.rows[0].viewport=500,(a:any)=>a.evidence.rows[0].b.scrollWidth+=100,(a:any)=>a.evidence.rows[0].t.x=10000,(a:any)=>a.evidence.rows[0].t.textHeight=999]){const a=structuredClone(args);mutate(a);assert.throws(()=>analyze(a));}
 mkdirSync('outputs/developer-addons/localization-qa',{recursive:true});writeFileSync('outputs/developer-addons/localization-qa/browser-report.json',JSON.stringify(report,null,2)+'\n');
 assert.equal(args.evidence.htmlSha.length,64);assert.equal(args.evidence.dpr,1);
});
