import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
const {PNG}=createRequire(import.meta.url)('../tools/developer-visual-regression/node_modules/pngjs');
const engine=new URL('../store/plugins/visual-regression/compare.mjs',import.meta.url);
const png=(color:number)=>{const p=new PNG({width:3,height:2});p.data.fill(255);p.data[4]=color;return PNG.sync.write(p).toString('base64');};
test('actual pixel comparison reports changed count and exact bounding rectangle, unchanged control',async()=>{
 assert.ok(existsSync(engine),'bounded PNG comparator implemented');
 const {compare}=await import(engine.href);
 const result=compare({pairs:[{viewport:'desktop',baseline:png(255),candidate:png(0)}]});
 assert.equal(result.pairs[0].changedPixels,1);assert.deepEqual(result.pairs[0].rect,{x:1,y:0,width:1,height:1});assert.equal(result.pairs[0].status,'changed');
 const same=compare({pairs:[{viewport:'phone',baseline:png(0),candidate:png(0)}]});assert.equal(same.pairs[0].changedPixels,0);assert.equal(same.pairs[0].rect,null);
});
