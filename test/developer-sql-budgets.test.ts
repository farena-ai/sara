import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Reviewed native JavaScript module.
import {handle} from '../store/plugins/sql-migration-reviewer/workflow.mjs';
// @ts-expect-error Reviewed native JavaScript module.
import {rehearse} from '../store/plugins/sql-migration-reviewer/engine.mjs';
const name=(p:string,i:number)=>p+i+'x'.repeat(29-String(i).length);
const columns=Array.from({length:12},(_,i)=>({name:name('c',i),type:i%3===0?'TEXT':i%3===1?'INTEGER':'REAL'}));
const baseline={tables:Array.from({length:8},(_,i)=>({name:name('t',i),columns,rows:50}))};
test('maximum admitted synthetic baseline and DDL remain bounded, complete and rolled back',async()=>{
 const sql=Array.from({length:8},(_,i)=>`CREATE TABLE ${name('n',i)} (${columns.map(c=>c.name+' '+c.type).join(', ')});`).join('\n');
 const r=rehearse({baseline,sql});assert.equal(r.status,'rehearsed');assert.equal(r.executedStatements,8);assert.equal(r.before.tables.reduce((n:number,t:any)=>n+t.rows,0),400);assert.equal(r.after.tables.length,16);assert.equal(r.rollbackVerified,true);assert.equal(r.dataPreserved,true);
 const response=await handle({baseline,sql});assert.ok(Buffer.byteLength(response.content)<=46000);assert.ok(Buffer.byteLength(JSON.stringify({v:1,type:'result',id:'r'.repeat(64),...response}))<=60000);assert.ok(!response.content.includes('synthetic_'));
});
test('explicit byte/token/depth/node/baseline bounds and closed synthetic-only inputs',()=>{
 const tiny={tables:[]};let deep:any={};for(let i=0;i<12;i++)deep={x:deep};const broad:any={};for(let i=0;i<129;i++)broad['x'+i]=null;
 for(const args of [deep,broad,{baseline:tiny,sql:'/*'+'é'.repeat(4096)+'*/ CREATE TABLE x (id INTEGER)'},{baseline:tiny,sql:'CREATE TABLE x (id INTEGER);'+', '.repeat(260)},{baseline:{tables:[{name:'x',columns,rows:100},{name:'y',columns,rows:100},{name:'z',columns,rows:100},{name:'w',columns,rows:100},{name:'v',columns,rows:1}]},sql:'CREATE TABLE a (id INTEGER)'},{baseline:{tables:[],path:'outside.db'},sql:'CREATE TABLE x (id INTEGER)'},{baseline:tiny,sql:'CREATE TABLE x (id INTEGER)',connection:'file:outside.db'},{baseline:{tables:[{name:'x',columns,rows:1,values:['private']}]},sql:'CREATE TABLE y (id INTEGER)'}])assert.equal(rehearse(args).status,'rejected');
});
test('unavailable authorizer refuses the runtime',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const old=DatabaseSync.prototype.setAuthorizer;
 try{(DatabaseSync.prototype as any).setAuthorizer=undefined;assert.equal(rehearse({baseline:{tables:[]},sql:'CREATE TABLE x (id INTEGER)'}).status,'unsupported-runtime');}finally{DatabaseSync.prototype.setAuthorizer=old;}
});
