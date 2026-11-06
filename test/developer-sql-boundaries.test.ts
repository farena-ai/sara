import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
// @ts-expect-error Reviewed native JavaScript module.
import {rehearse} from '../store/plugins/sql-migration-reviewer/engine.mjs';
const baseline={tables:[{name:'items',columns:[{name:'id',type:'INTEGER'}],rows:4}]};
test('admission never invokes hidden getters/toJSON or inherited/prototype values',()=>{
 let calls=0;const a:any={baseline,sql:'CREATE TABLE x (id INTEGER)'};
 Object.defineProperty(a,'hidden',{get(){calls++;return 'secret';}});
 assert.equal(rehearse(a).status,'rejected');assert.equal(calls,0);
 const b:any={baseline,sql:'CREATE TABLE x (id INTEGER)'};Object.defineProperty(b,'sql',{get(){calls++;return 'CREATE TABLE x (id INTEGER)';},enumerable:true});assert.equal(rehearse(b).status,'rejected');assert.equal(calls,0);
 const rows:any=[];Object.defineProperty(rows,'toJSON',{value:()=>{calls++;return []}});assert.equal(rehearse({baseline:{tables:rows},sql:'CREATE TABLE x (id INTEGER)'}).status,'rejected');assert.equal(calls,0);
 assert.equal(rehearse(Object.assign(Object.create({ambient:true}),{baseline,sql:'CREATE TABLE x (id INTEGER)'})).status,'rejected');
});
test('fixed source/token/statement/baseline/depth budgets refuse before SQLite',()=>{
 const cyclic:any={};cyclic.self=cyclic;for(const args of [cyclic,{baseline,sql:' '.repeat(8193)},{baseline,sql:'CREATE TABLE x (id INTEGER);'.repeat(9)},{baseline:{tables:[{...baseline.tables[0],rows:101}]},sql:'CREATE TABLE x (id INTEGER)'}])assert.equal(rehearse(args).status,'rejected');
});
test('effective runtime authorizer refusal, not existence alone',()=>{
 const old=DatabaseSync.prototype.setAuthorizer;
 try{DatabaseSync.prototype.setAuthorizer=function(){};const r=rehearse({baseline,sql:'CREATE TABLE x (id INTEGER)'});assert.equal(r.status,'unsupported-runtime');assert.equal(r.closed,true);}finally{DatabaseSync.prototype.setAuthorizer=old;}
});
const unsafe=[
 'DROP TABLE items','DELETE FROM items','ALTER TABLE items DROP COLUMN id','ALTER TABLE items ADD COLUMN x TEXT','ATTACH DATABASE \'file:secret\' AS p','PRAGMA writable_schema=ON','BEGIN','COMMIT','VACUUM INTO \'outside.db\'','SELECT load_extension(\'x\')','WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x',
 'CREATE VIEW x AS SELECT * FROM items','CREATE TRIGGER x AFTER INSERT ON items BEGIN DELETE FROM items; END','CREATE VIRTUAL TABLE x USING fts5(a)',
 'CREATE TABLE x (id INTEGER DEFAULT (random()))','CREATE TABLE x (id INTEGER CHECK (load_extension(\'x\')))','CREATE TABLE x (id INTEGER GENERATED ALWAYS AS (1))','CREATE TABLE x AS SELECT * FROM items','CREATE UNIQUE INDEX x ON items (id)','CREATE INDEX x ON items ((random()))','CREATE INDEX x ON items (id) WHERE id=1',
 'CREATE TABLE x (id INTEGER); DROP TABLE items','CREATE TABLE x (id INTEGER); SELECT 1','CREATE TABLE x (id INTEGER) garbage','CREATE TABLE x (id INTEGER)\0; DROP TABLE items','CREATE TABLE x (id INTEGER);;','CREATE TABLE x (id INTEGER) /* unterminated','CREATE TABLE "x""; DROP TABLE items" (id INTEGER)','CREATE TABLE [x] (id INTEGER)',"CREATE TABLE 'x' (id INTEGER)", 'CREATE TABLE sqlite_secret (id INTEGER)'
];
for(const sql of unsafe)test('closed additive grammar refuses unsafe form #'+unsafe.indexOf(sql),()=>{const r=rehearse({baseline,sql});assert.equal(r.status,'rejected');assert.equal(r.executedStatements,0);assert.ok(!JSON.stringify(r).includes(sql));});
test('SQLite semantic collision after first DDL rolls back the whole transaction',()=>{
 const r=rehearse({baseline,sql:'CREATE TABLE fresh (id INTEGER); CREATE TABLE ITEMS (id INTEGER);'});assert.equal(r.status,'rejected');assert.equal(r.executedStatements,1);assert.deepEqual(r.rollback,r.before);assert.equal(r.rollbackVerified,true);assert.equal(r.closed,true);
});
test('SQLite semantics reject duplicate columns, reserved syntax and missing index targets',()=>{
 for(const sql of ['CREATE TABLE x (id INTEGER, ID TEXT)','CREATE TABLE select (id INTEGER)','CREATE INDEX x ON absent (id)','CREATE INDEX x ON items (missing)']){const r=rehearse({baseline,sql});assert.equal(r.status,'rejected');assert.equal(r.rollbackVerified,true);}
});
test('comments, quoted identifiers and mixed case are compiled fully by SQLite',()=>{
 const r=rehearse({baseline,sql:'-- start\n cReAtE /* keyword gap */ TABLE "new_table" ("id" INTEGER NOT NULL, label TEXT); -- tail\n CREATE INDEX ix ON items ("id"); /* end */'});assert.equal(r.status,'rehearsed');assert.equal(r.executedStatements,2);assert.equal(r.dataPreserved,true);assert.equal(r.rollbackVerified,true);
});
test('independent rehearsals leave no persistent database state',()=>{for(let i=0;i<3;i++){const r=rehearse({baseline,sql:'CREATE TABLE fresh (id INTEGER)'});assert.equal(r.status,'rehearsed');assert.equal(r.before.tables.length,1);assert.equal(r.after.tables.length,2);assert.equal(r.closed,true);}});
