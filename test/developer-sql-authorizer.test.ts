import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants as C} from 'node:sqlite';
// @ts-expect-error Reviewed native JavaScript module.
import {rehearse} from '../store/plugins/sql-migration-reviewer/engine.mjs';
const baseline={tables:[{name:'items',columns:[{name:'id',type:'INTEGER'}],rows:3}]};
// Inject at native compile boundary, AFTER the recognizer. This demonstrates the
// independent authorizer's denial rather than merely checking the string filter.
for(const sql of ['DROP TABLE items','DELETE FROM items','INSERT INTO items VALUES(8)','UPDATE items SET id=8',"ATTACH ':memory:' AS other",'PRAGMA user_version=1','BEGIN',"SELECT load_extension('not-a-library')",'SELECT random()','CREATE VIEW view_x AS SELECT * FROM items','CREATE TRIGGER trig AFTER INSERT ON items BEGIN SELECT 1; END','CREATE VIRTUAL TABLE vt USING fts5(x)'])test('native authorizer independently denies '+sql.split(' ').slice(0,2).join(' '),()=>{
 const prepare=DatabaseSync.prototype.prepare,authorizer=DatabaseSync.prototype.setAuthorizer;const denies:number[]=[];
 try{
  DatabaseSync.prototype.setAuthorizer=function(cb){return authorizer.call(this,cb?((...a:Parameters<NonNullable<typeof cb>>)=>{const r=cb(...a);if(r===C.SQLITE_DENY)denies.push(a[0]);return r;}):null);};
  DatabaseSync.prototype.prepare=function(source,...options){return prepare.call(this,source==='CREATE INDEX ix ON items (id)'?sql:source,...options);};
  const r=rehearse({baseline,sql:'CREATE INDEX ix ON items (id)'});assert.equal(r.status,'rejected');assert.equal(r.reason,'sqlite-compile-or-execution-refusal');assert.equal(r.executedStatements,0);assert.equal(r.rollbackVerified,true);assert.deepEqual(r.rollback,r.before);assert.equal(r.closed,true);assert.ok(denies.length>=2,'probe and migration compile both denied');
 }finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.setAuthorizer=authorizer;}
});
