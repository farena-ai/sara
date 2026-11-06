import {DatabaseSync, constants as C} from 'node:sqlite';
import {createHash} from 'node:crypto';
const fail=()=>{throw Error('Unsupported bounded SQLite input');};
const ident=s=>typeof s==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(s)&&!s.toLowerCase().startsWith('sqlite_');
const q=s=>'"'+s+'"';
const types=new Set(['INTEGER','TEXT','REAL']);
function baselineInput(b){
 if(!b||Object.keys(b).join()!=='tables'||!Array.isArray(b.tables)||b.tables.length>8)fail();
 let total=0;const names=new Set();
 for(const t of b.tables){if(!t||Object.keys(t).sort().join()!=='columns,name,rows'||!ident(t.name)||names.has(t.name.toLowerCase())||!Number.isInteger(t.rows)||t.rows<0||t.rows>100||!Array.isArray(t.columns)||!t.columns.length||t.columns.length>12)fail();names.add(t.name.toLowerCase());total+=t.rows;const cols=new Set();for(const c of t.columns){if(!c||Object.keys(c).sort().join()!=='name,type'||!ident(c.name)||cols.has(c.name.toLowerCase())||!types.has(c.type))fail();cols.add(c.name.toLowerCase());}}
 if(total>400)fail();return b;
}
// Closed additive grammar recognizer, NOT a general-purpose SQL parser.
// Every admitted original statement is subsequently compiled by SQLite itself.
function statements(sql){
 if(typeof sql!=='string'||!sql.length||Buffer.byteLength(sql)>8192||sql.includes('\0'))fail();
 const tokens=[];let i=0;
 while(i<sql.length){const c=sql[i];if(/\s/.test(c)){i++;continue;}if(sql.startsWith('--',i)){while(i<sql.length&&sql[i]!=='\n')i++;continue;}if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)fail();i=end+2;continue;}
 const start=i;let value,kind;
 if(c==='"'){i++;value='';let closed=false;while(i<sql.length){if(sql[i]==='"'){if(sql[i+1]==='"'){value+='"';i+=2;}else{i++;closed=true;break;}}else value+=sql[i++];}if(!closed||!ident(value))fail();kind='id';}
 else if(/[A-Za-z]/.test(c)){while(i<sql.length&&/[A-Za-z0-9_]/.test(sql[i]))i++;value=sql.slice(start,i);kind='word';}
 else if('(),;'.includes(c)){i++;value=c;kind='punct';}else fail();
 tokens.push({value,kind,start,end:i});if(tokens.length>512)fail();
 }
 let p=0;const out=[];const word=w=>{const t=tokens[p++];if(t?.kind!=='word'||t.value.toUpperCase()!==w)fail();};const id=()=>{const t=tokens[p++];if(!t||!['word','id'].includes(t.kind)||!ident(t.value))fail();return t.value;};const punct=w=>{if(tokens[p++]?.value!==w)fail();};
 while(p<tokens.length){const start=tokens[p].start;word('CREATE');const type=tokens[p++]?.value.toUpperCase();
 if(type==='TABLE'){id();punct('(');let cols=0;do{if(cols++)punct(',');id();const t=tokens[p++];if(t?.kind!=='word'||!types.has(t.value.toUpperCase()))fail();if(tokens[p]?.kind==='word'&&tokens[p].value.toUpperCase()==='NOT'){word('NOT');word('NULL');}if(cols>12)fail();}while(tokens[p]?.value===',');punct(')');}
 else if(type==='INDEX'){id();word('ON');id();punct('(');let cols=0;do{if(cols++)punct(',');id();if(cols>12)fail();}while(tokens[p]?.value===',');punct(')');}else fail();
 const end=tokens[p-1].end;if(p<tokens.length)punct(';');out.push(sql.slice(start,end));if(out.length>8)fail();
 }
 if(!out.length)fail();return out;
}
function evidence(db){
 const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>{
 const columns=db.prepare('PRAGMA table_info('+q(name)+')').all().map(c=>({name:c.name,type:c.type,notNull:!!c.notnull}));
 const rows=db.prepare('SELECT * FROM '+q(name)+' ORDER BY rowid').all();
 return {name,columns,rows:rows.length,dataSha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};});
 const indexes=db.prepare("SELECT name,tbl_name AS tableName FROM sqlite_schema WHERE type='index' ORDER BY name").all().map(r=>({...r,columns:db.prepare('PRAGMA index_info('+q(r.name)+')').all().map(c=>c.name)}));return {tables,indexes};
}
function enforced(db){
 if(typeof db.setAuthorizer!=='function')return false;
 let seen=0;db.setAuthorizer(()=>{seen++;return C.SQLITE_DENY;});let denied=false;
 try{db.prepare('CREATE TABLE authorizer_probe (id INTEGER)').run();}catch{denied=true;}
 db.setAuthorizer(null);return denied&&seen>0&&db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n===0;
}
function authorize(db){db.setAuthorizer((action,a,b,d,trigger)=>{
 if(trigger||d&&d!=='main')return C.SQLITE_DENY;
 if([C.SQLITE_CREATE_TABLE,C.SQLITE_CREATE_INDEX,C.SQLITE_REINDEX].includes(action))return C.SQLITE_OK;
 if([C.SQLITE_INSERT,C.SQLITE_UPDATE].includes(action)&&a==='sqlite_master')return C.SQLITE_OK;
 if(action===C.SQLITE_READ)return C.SQLITE_OK;
 return C.SQLITE_DENY;
});}
function inertInput(value){
 let nodes=0,bytes=0;const ancestors=new Set();
 const visit=(v,depth)=>{
  if(++nodes>1024||depth>8)fail();
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(bytes>16384)fail();return;}
  if(!v||typeof v!=='object'||ancestors.has(v))fail();
  const array=Array.isArray(v);if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype))fail();
  const keys=Reflect.ownKeys(v);if(keys.length>128)fail();ancestors.add(v);
  if(array&&v.length>100)fail();
  for(const key of keys){if(array&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(v,key);
   if(typeof key!=='string'||!d||!('value'in d)||!d.enumerable||['__proto__','prototype','constructor'].includes(key)||array&&!/^(0|[1-9][0-9]*)$/.test(key))fail();visit(d.value,depth+1);
  }
  if(array&&keys.length!==v.length+1)fail();ancestors.delete(v);
 };visit(value,0);return value;
}
export function rehearse(args){
 let baseline,sqls;try{inertInput(args);if(!args||Object.keys(args).sort().join()!=='baseline,sql')fail();baseline=baselineInput(args.baseline);sqls=statements(args.sql);}catch{return {status:'rejected',reason:'unsupported-or-unsafe-input',executedStatements:0,closed:true};}
 let db,report;try{
 db=new DatabaseSync(':memory:',{allowExtension:false,timeout:0});if(!enforced(db)){report={status:'unsupported-runtime',reason:'authorizer-not-enforced',executedStatements:0};return report;}
 // Only fixed, trusted setup pragmas; none is a caller-executable operation.
 db.exec('PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=256;');
 const sqliteLimits={tempStore:db.prepare('PRAGMA temp_store').get().temp_store,maxPageCount:db.prepare('PRAGMA max_page_count').get().max_page_count,trustedSchema:db.prepare('PRAGMA trusted_schema').get().trusted_schema,journalMode:db.prepare('PRAGMA journal_mode').get().journal_mode};
 if(sqliteLimits.tempStore!==2||sqliteLimits.maxPageCount!==256||sqliteLimits.trustedSchema!==0||sqliteLimits.journalMode!=='memory')throw Error('SQLite limits unsupported');
 for(const t of baseline.tables){db.exec('CREATE TABLE '+q(t.name)+' ('+t.columns.map(c=>q(c.name)+' '+c.type).join(',')+')');const insert=db.prepare('INSERT INTO '+q(t.name)+' VALUES ('+t.columns.map(()=>'?').join(',')+')');for(let i=0;i<t.rows;i++)insert.run(...t.columns.map((c,j)=>c.type==='TEXT'?`synthetic_${i}_${j}`:c.type==='REAL'?i+0.5:i));}
 const before=evidence(db);db.exec('BEGIN');let executedStatements=0;
 try{for(const sql of sqls){authorize(db);db.prepare(sql).run();executedStatements++;}db.setAuthorizer(null);const after=evidence(db);report={status:'rehearsed',executedStatements,before,after,dataPreserved:before.tables.every(t=>after.tables.some(u=>u.name===t.name&&u.dataSha256===t.dataSha256)),authorizerEnforced:true};}
 catch{report={status:'rejected',reason:'sqlite-compile-or-execution-refusal',executedStatements,before,authorizerEnforced:true};}
 finally{db.setAuthorizer(null);db.exec('ROLLBACK');}
 report.rollback=evidence(db);report.sqliteLimits=sqliteLimits;report.rollbackVerified=JSON.stringify(report.rollback)===JSON.stringify(before);return report;
 }catch{report={status:'unsupported-runtime',reason:'sqlite-runtime-refusal',executedStatements:0};return report;}finally{if(db)db.close();if(report){report.closed=true;report.dialect='sqlite';report.scope='synthetic-disposable-memory-only';}}
}
