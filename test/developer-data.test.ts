import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const root='../store/plugins/database-fixture-studio/engine.mjs';
export const fixture={seed:42,tables:[{name:'parent',rows:3,columns:[{name:'id',type:'integer',primaryKey:true},{name:'code',type:'text',unique:true,notNull:true,maxLength:24}]},{name:'child',rows:5,columns:[{name:'id',type:'integer',primaryKey:true},{name:'parent_id',type:'integer',notNull:true,references:{table:'parent',column:'id'}},{name:'score',type:'integer',notNull:true,min:2,max:7}]}]};
test('Create deterministic synthetic relational fixtures satisfying known constraints',async()=>{
 const engine=await import(root).catch(()=>null); assert.ok(engine?.generate,'fixture generation feature exists');
 const a=engine.generate(fixture),b=engine.generate(fixture);assert.deepEqual(a,b);assert.equal(a.synthetic,true);
 const db=new DatabaseSync(':memory:');try{db.exec(a.sql);assert.equal(db.prepare('SELECT count(*) AS n FROM child JOIN parent ON parent.id=child.parent_id').get()!.n,5);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.throws(()=>db.exec('INSERT INTO child VALUES(99,999,3)'),/FOREIGN KEY/);assert.throws(()=>db.exec('INSERT INTO child VALUES(99,1,99)'),/CHECK/);assert.throws(()=>db.exec('INSERT INTO parent VALUES(99,NULL)'),/NOT NULL/);assert.throws(()=>db.exec("INSERT INTO parent SELECT 99,code FROM parent LIMIT 1"),/UNIQUE/);}finally{db.close();}
});
