import test from 'node:test';
import assert from 'node:assert/strict';
const baseline={tables:[{name:'items',columns:[{name:'id',type:'INTEGER'},{name:'label',type:'TEXT'}],rows:3}]};
// @ts-expect-error Reviewed native JavaScript module.
async function engine(){return import('../store/plugins/sql-migration-reviewer/engine.mjs');}
test('reject unsafe migration and actually rehearse safe migration in disposable SQLite',async()=>{
 const {rehearse}=await engine();
 const bad=rehearse({baseline,sql:'DROP TABLE items;'});assert.equal(bad.status,'rejected');assert.equal(bad.executedStatements,0);
 const ok=rehearse({baseline,sql:'CREATE TABLE archive (id INTEGER, label TEXT); CREATE INDEX items_id ON items (id);'});
 assert.equal(ok.status,'rehearsed');assert.equal(ok.executedStatements,2);assert.equal(ok.before.tables[0].rows,3);assert.equal(ok.after.tables.length,2);
 assert.equal(ok.after.indexes.length,1);assert.deepEqual(ok.after.indexes[0].columns,['id']);assert.equal(ok.dialect,'sqlite');assert.equal(ok.scope,'synthetic-disposable-memory-only');assert.deepEqual(ok.sqliteLimits,{tempStore:2,maxPageCount:256,trustedSchema:0,journalMode:'memory'});assert.deepEqual(ok.rollback,ok.before);assert.equal(ok.dataPreserved,true);assert.equal(ok.authorizerEnforced,true);assert.equal(ok.closed,true);
});
