import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,cpSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),engine=join(root,'store/plugins/code-migration-studio/engine.mjs'),fx=join(root,'test/fixtures/developer/code-migration-studio/workspace');
async function studio(){assert.ok(existsSync(engine),'code migration engine has not been implemented');const p='../store/plugins/code-migration-studio/engine.mjs';return import(p);}
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function tree(dir:string){return Object.fromEntries((readdirSync(dir,{recursive:true,withFileTypes:true}) as any[]).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(dir.length+1).replaceAll('\\','/')).sort().map(p=>[p,sha(readFileSync(join(dir,p)))]));}
const selected=['src/report.mjs','src/alias.mjs','src/shadow.mjs','main.mjs'];
const codemod={codemod:'rename-named-import',version:1,module:'lib/math.mjs',from:'add',to:'sum'};
function setup(){const home=mkdtempSync(join(tmpdir(),'migrate-')),ws=join(home,'migration-v1/workspace');cpSync(fx,ws,{recursive:true});return {home,ws};}
test('previews an AST-based migration and proves approved edits stay inside the selected workspace',async()=>{
 const {handle}=await studio();const {home,ws}=setup();const outside=join(home,'outside.mjs');writeFileSync(outside,"import { add } from './migration-v1/workspace/lib/math.mjs';\n");
 try{
  process.chdir(home);const before=tree(ws),outsideBefore=sha(readFileSync(outside));
  const preview=JSON.parse((await handle({operation:'preview',...codemod,files:selected})).content);
  assert.equal(preview.applied,false);assert.equal(preview.migratedParses,true);assert.match(preview.planSha,/^[a-f0-9]{64}$/);assert.deepEqual(tree(ws),before,'preview writes nothing');
  const f=Object.fromEntries(preview.files.map((x:any)=>[x.path,x]));
  assert.deepEqual(f['src/report.mjs'].edits.map((e:any)=>[e.line,e.before,e.after]),[[1,'add','sum'],[4,'add','sum'],[6,'add','add: sum']]);
  assert.deepEqual(f['src/alias.mjs'].edits.map((e:any)=>[e.line,e.before,e.after]),[[1,'add','sum']],'alias keeps local name');
  assert.deepEqual(f['src/shadow.mjs'].edits.map((e:any)=>e.line),[1,7],'shadowed inner binding is not a reference to the import');
  for(const x of preview.files)assert.equal(x.beforeSha256,before[x.path]);
  const applied=JSON.parse((await handle({operation:'apply',...codemod,files:selected,planSha:preview.planSha})).content);
  assert.equal(applied.applied,true);assert.equal(applied.verified,true);
  const after=tree(ws);
  for(const p of Object.keys(before)){if(selected.includes(p)&&f[p].status==='changed'){assert.equal(after[p],f[p].afterSha256,p);assert.notEqual(after[p],before[p]);}else assert.equal(after[p],before[p],`${p} outside the approved selection is unchanged`);}
  assert.deepEqual(Object.keys(after),Object.keys(before),'no temporary or extra files remain');assert.equal(sha(readFileSync(outside)),outsideBefore);
  assert.match(readFileSync(join(ws,'src/shadow.mjs'),'utf8'),/const add = \(a, b\) => a \* b;/);
  // Compile and run the actual migrated snapshot.
  for(const p of selected){const c=spawnSync(process.execPath,['--check',join(ws,p)],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);}
  const run=spawnSync(process.execPath,[join(ws,'main.mjs')],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),{add:2,total:6,helper:8,three:3,product:6,five:5});
  assert.match(readFileSync(join(ws,'main.mjs'),'utf8'),/import \{ sum \} from '\.\/lib\/math\.mjs';/);
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
test('negative controls: unselected, symlinked, stale, escaping, conflicting and syntax-error inputs refuse without writes',async()=>{
 const {handle}=await studio();const {home,ws}=setup();const refuse=(a:any)=>assert.rejects(handle(a),/^Error: Migration refused:/);
 try{
  process.chdir(home);const before=tree(ws);
  const preview=JSON.parse((await handle({operation:'preview',...codemod,files:selected})).content);
  await refuse({operation:'apply',...codemod,files:[...selected,'unselected/legacy.mjs'],planSha:preview.planSha});
  await refuse({operation:'apply',...codemod,files:selected,planSha:'0'.repeat(64)});
  writeFileSync(join(ws,'src/alias.mjs'),readFileSync(join(ws,'src/alias.mjs'),'utf8')+'// edited after preview\n');await refuse({operation:'apply',...codemod,files:selected,planSha:preview.planSha});
  writeFileSync(join(ws,'src/alias.mjs'),readFileSync(join(fx,'src/alias.mjs')));
  for(const files of [['../outside.mjs'],['src/../main.mjs'],['C:/x.mjs'],['src\\report.mjs'],['missing.mjs'],['main.mjs','main.mjs'],[]])await refuse({operation:'preview',...codemod,files});
  mkdirSync(join(home,'real'));writeFileSync(join(home,'real/linked.mjs'),"import { add } from '../lib/math.mjs';\n");symlinkSync(join(home,'real'),join(ws,'linkdir'),'junction');await refuse({operation:'preview',...codemod,files:['linkdir/linked.mjs']});rmSync(join(ws,'linkdir'));
  writeFileSync(join(ws,'src/broken.mjs'),"import { add } from '../lib/math.mjs';\nexport const = add(;\n");await refuse({operation:'preview',...codemod,files:['src/broken.mjs']});rmSync(join(ws,'src/broken.mjs'));
  writeFileSync(join(ws,'src/conflict.mjs'),"import { add } from '../lib/math.mjs';\nconst sum = 1;\nexport const z = add(sum, 1);\n");await refuse({operation:'preview',...codemod,files:['src/conflict.mjs']});rmSync(join(ws,'src/conflict.mjs'));
  for(const a of [{operation:'preview',...codemod,files:selected,root:home},{operation:'preview',...codemod,version:2,files:selected},{operation:'preview',...codemod,to:'not valid',files:selected},{operation:'preview',...codemod,codemod:'regex-replace',files:selected}])await refuse(a);
  assert.deepEqual(tree(ws),before,'nothing was written by any refused request');
 }finally{process.chdir(root);rmSync(home,{recursive:true,force:true});}
});
