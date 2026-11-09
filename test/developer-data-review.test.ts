import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../store/plugins/data-contract-validator/engine.mjs';
import {generate} from '../store/plugins/database-fixture-studio/engine.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const protobuf=createRequire(import.meta.url)('../tools/developer-data/node_modules/protobufjs');
const enumBefore='syntax="proto3"; enum Status { ZERO=0; YES=1; } message Item { Status status=1; int32 n=2; }';
test('R2-06 resolved enum declaration rename preserves actual old wire decoding',()=>{
 const after=enumBefore.replaceAll('Status','State'),old=protobuf.parse(enumBefore).root.lookupType('Item'),next=protobuf.parse(after).root.lookupType('Item');
 const value={status:1,n:2},wire=old.encode(old.create(value)).finish();assert.equal(Buffer.from(wire).toString('hex'),'08011002');assert.deepEqual(next.toObject(next.decode(wire)),value);
 const report=analyze({format:'protobuf',before:enumBefore,after,message:'Item',payloads:[JSON.stringify(value)]});assert.equal(report.compatible,true);assert.equal(report.payloads[0].valid,true);
});
for(const [label,after] of [['scalar interpretation',enumBefore.replace('int32 n','sint32 n')],['enum removal',enumBefore.replace(' YES=1;','')],['enum to scalar',enumBefore.replace('Status status','int32 status')],['cardinality',enumBefore.replace('Status status','repeated Status status')]])test('R2-06 breaking control '+label,()=>assert.equal(analyze({format:'protobuf',before:enumBefore,after,message:'Item',payloads:['{}']}).compatible,false));

const table=(name:string,columns=[{name:'id',type:'integer',primaryKey:true}])=>({name,rows:1,columns});
for(const [label,tables,sql] of [
 ['table case collision',[table('Users'),table('users')],'CREATE TABLE "Users" (id INTEGER); CREATE TABLE "users" (id INTEGER);'],
 ['column case collision',[table('Users',[{name:'id',type:'integer',primaryKey:true},{name:'ID',type:'integer',primaryKey:false}])],'CREATE TABLE "Users" (id INTEGER, ID INTEGER);'],
 ['reserved prefix',[table('sQlItE_fixture')],'CREATE TABLE "sQlItE_fixture" (id INTEGER);'],
] as const)test('R2-04 refuses SQLite '+label,()=>{const db=new DatabaseSync(':memory:');try{assert.throws(()=>db.exec(sql));assert.throws(()=>generate({seed:1,tables}));}finally{db.close();}});
test('R2-03 exact enum int32 boundaries survive independent wire round trips',()=>{
 const source='syntax="proto3"; enum E { ZERO=0; MIN=-2147483648; MAX=2147483647; } message Item { repeated E status=1; }',value={status:[-2147483648,0,2147483647]};const type=protobuf.parse(source).root.lookupType('Item');
 assert.deepEqual(type.toObject(type.decode(type.encode(value).finish())),value);assert.equal(proto(source,[JSON.stringify(value)]).payloads[0].valid,true);
 for(const status of [2147483648,-2147483649,1.5,9007199254740992])assert.equal(proto(source,[JSON.stringify({status:[status]})]).payloads[0].valid,false);
});
test('R2-03 float32 rounding is allowed but double retains exact numeric identity',()=>{
 const source='syntax="proto3"; message Item { float f=1; double d=2; }',value={f:0.1,d:0.1},type=protobuf.parse(source).root.lookupType('Item'),decoded=type.decode(type.encode(value).finish());assert.equal(decoded.f,Math.fround(value.f));assert.equal(decoded.d,value.d);assert.notEqual(decoded.f,decoded.d);assert.equal(proto(source,[JSON.stringify(value)]).payloads[0].valid,true);
});
test('R2-04 exact-case references preserve caller IDs and execute clean SQLite',()=>{
 const tables:any[]=[table('Users',[{name:'ID',type:'integer',primaryKey:true}]),{name:'Posts',rows:1,columns:[{name:'OwnerID',type:'integer',references:{table:'Users',column:'ID'}}]}],input={seed:3,tables};const result=generate(input),db=new DatabaseSync(':memory:');try{db.exec(result.sql);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Posts JOIN Users ON OwnerID=ID').get()!.n,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(Object.keys(result.tables),['Users','Posts']);}finally{db.close();}
 for(const ref of [{table:'users',column:'ID'},{table:'Users',column:'id'}]){const changed=structuredClone(input);changed.tables[1].columns[0].references=ref;assert.throws(()=>generate(changed));}
});
test('R2-03 syntax identity ignores comment text for proto2 nonzero enums',()=>assert.equal(proto('// syntax="proto3"; is just a comment\nsyntax="proto2"; enum E { FIRST=1; } message Item { optional E status=1; }',['{"status":1}']).payloads[0].valid,true));
const proto=(source:string,payloads=['{"status":0}'])=>analyze({format:'protobuf',before:source,after:source,message:'Item',payloads});
for(const n of ['2147483648','-2147483649','9007199254740993','1.5'])test(`R2-03 refuses invalid enum declaration ${n}`,()=>{
 const source=`syntax="proto3"; enum E { ZERO=0; BAD=${n}; } message Item { E status=1; }`;
 assert.throws(()=>proto(source));
});
test('R2-03 proto3 enum first member must be zero',()=>assert.throws(()=>proto('syntax="proto3"; enum E { FIRST=1; } message Item { E status=1; }')));
for(const source of ['syntax="proto3"; message Item { required int32 n=1; }','// syntax="proto3";\nmessage Item { int32 n=1; }'])test('R2-03 rejects invalid syntax '+source,()=>assert.throws(()=>proto(source,['{}'])));
test('R2-03 wire round trip refuses lossy string payload',()=>assert.equal(proto('syntax="proto3"; message Item { string status=1; }',[JSON.stringify({status:'\ud800'})]).payloads[0].valid,false));
