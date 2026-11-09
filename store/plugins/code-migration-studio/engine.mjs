import {lstatSync,realpathSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join,resolve,posix} from 'node:path';
import {createHash} from 'node:crypto';
import {parse,traverse} from './parser.mjs';
import labels from './labels.json' with {type:'json'};
export const LIMITS=Object.freeze({files:32,fileBytes:262144,edits:512,resultBytes:49152});
export const CODEMODS=Object.freeze({'rename-named-import':[1]});
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=()=>{throw new Error('Migration refused: unsupported, unselected, linked, changed, conflicting, unparsable or over budget. No files were changed.');};
const RESERVED=new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval undefined NaN Infinity'.split(' '));
const IDENT=/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/,SEG='[A-Za-z0-9_][A-Za-z0-9._-]{0,127}';
const FILE=new RegExp(`^(?:${SEG}/){0,7}${SEG}\\.(?:m?js)$`),MODULE=new RegExp(`^(?:@?${SEG}/){0,7}${SEG}$`);
const KEYS=['operation','codemod','version','module','from','to','files'];
function admit(a){
 if(!a||Object.getPrototypeOf(a)!==Object.prototype)fail();
 const op=Object.getOwnPropertyDescriptor(a,'operation');if(!op||!('value' in op))fail();
 const keys=op.value==='preview'?KEYS:op.value==='apply'?[...KEYS,'planSha']:fail();
 const own=Reflect.ownKeys(a);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();
 for(const k of own){const d=Object.getOwnPropertyDescriptor(a,k);if(!d||!('value' in d)||!d.enumerable)fail();}
 if(!Object.hasOwn(CODEMODS,a.codemod)||!CODEMODS[a.codemod].includes(a.version))fail();
 if(typeof a.module!=='string'||!MODULE.test(a.module)||a.module.split('/').some(s=>s==='.'||s==='..'))fail();
 for(const n of [a.from,a.to])if(typeof n!=='string'||!IDENT.test(n)||RESERVED.has(n))fail();
 if(a.from===a.to)fail();
 const f=a.files;if(!Array.isArray(f)||Object.getPrototypeOf(f)!==Array.prototype)fail();
 const ld=Object.getOwnPropertyDescriptor(f,'length');if(!ld||ld.value<1||ld.value>LIMITS.files)fail();
 const fk=Reflect.ownKeys(f);if(fk.length!==ld.value+1||fk.some(k=>k!=='length'&&(typeof k!=='string'||!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=ld.value)))fail();
 for(let i=0;i<ld.value;i++){const d=Object.getOwnPropertyDescriptor(f,String(i));if(!d||!('value' in d)||typeof d.value!=='string'||!FILE.test(d.value)||d.value.split('/').some(s=>s==='.'||s==='..'))fail();}
 if(new Set(f).size!==f.length)fail();
 if(op.value==='apply'&&(typeof a.planSha!=='string'||!/^[a-f0-9]{64}$/.test(a.planSha)))fail();
}
function workspace(){const home=resolve(process.cwd()),ws=join(home,'migration-v1','workspace');for(const p of [home,join(home,'migration-v1'),ws])dir(p);return ws;}
function dir(p){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(p)!==p)fail();}
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs].join(':');
function readSelected(ws,rel){
 const parts=rel.split('/');let p=ws;for(const seg of parts.slice(0,-1)){p=join(p,seg);dir(p);}
 const full=join(ws,...parts),s=lstatSync(full);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>LIMITS.fileBytes||realpathSync(full)!==full)fail();
 const bytes=readFileSync(full);if(bytes.length!==s.size)fail();
 return {full,bytes,stamp:stamp(s),source:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
}
const program=src=>parse(src,{sourceType:'module',errorRecovery:false});
function targets(spec,file,module){
 if(spec.startsWith('./')||spec.startsWith('../')){const r=posix.normalize(posix.join(posix.dirname(file),spec));return !r.startsWith('../')&&r===module;}
 return spec===module;
}
// rename-named-import@1: rename one named import from one module; rewrite only references bound to it.
function migrate(rel,source,a){
 const ast=program(source),edits=[];
 traverse(ast,{
  ImportDeclaration(path){
   if(!targets(path.node.source.value,rel,a.module))return;
   if(path.node.importKind&&path.node.importKind!=='value')fail();
   for(const s of path.node.specifiers){
    if(s.type==='ImportNamespaceSpecifier')fail(); // member access through a namespace is not resolved
    if(s.type!=='ImportSpecifier')continue;
    if(s.imported.type!=='Identifier')fail();
    if(s.imported.name!==a.from)continue;
    if(s.local.name!==a.from){edits.push([s.imported.start,s.imported.end,a.to]);continue;}
    const binding=path.scope.getBinding(a.from);if(!binding||binding.constantViolations.length)fail();
    if(path.scope.hasBinding(a.to,{noGlobals:true}))fail();
    edits.push([s.start,s.end,a.to]);
    for(const ref of binding.referencePaths){
     if(ref.scope.hasBinding(a.to,{noGlobals:true})||ref.scope.hasGlobal?.(a.to))fail();
     const parent=ref.parent;
     if(parent.type==='ExportSpecifier')fail();
     if(parent.type==='ObjectProperty'&&parent.shorthand&&parent.value===ref.node){edits.push([parent.start,parent.end,`${a.from}: ${a.to}`]);continue;}
     if(ref.node.type!=='Identifier')fail();
     edits.push([ref.node.start,ref.node.end,a.to]);
    }
   }
  },
  ExportNamedDeclaration(path){if(path.node.source&&targets(path.node.source.value,rel,a.module))fail();},
  ExportAllDeclaration(path){if(targets(path.node.source.value,rel,a.module))fail();},
  // Dynamic imports cannot be migrated safely; refuse any that is not a literal of another module.
  ImportExpression(path){const arg=path.node.source;if(!arg||arg.type!=='StringLiteral'||targets(arg.value,rel,a.module))fail();},
  Import(path){const arg=path.parent.arguments?.[0];if(!arg||arg.type!=='StringLiteral'||targets(arg.value,rel,a.module))fail();},
 });
 edits.sort((x,y)=>x[0]-y[0]);for(let i=1;i<edits.length;i++)if(edits[i][0]<edits[i-1][1])fail();
 let out=source;for(const [s,e,t] of [...edits].reverse())out=out.slice(0,s)+t+out.slice(e);
 program(out); // the migrated snapshot must still parse
 const lineCol=i=>{const before=source.slice(0,i).split('\n');return [before.length,before.at(-1).length+1];};
 return {after:out,edits:edits.map(([s,e,t])=>{const [line,column]=lineCol(s);return {line,column,before:source.slice(s,e),after:t};})};
}
function preview(a){
 const ws=workspace(),files=[];let edits=0;
 for(const rel of a.files){
  const r=readSelected(ws,rel),m=migrate(rel,r.source,a);edits+=m.edits.length;if(edits>LIMITS.edits)fail();
  files.push({path:rel,status:m.edits.length?'changed':'unchanged',beforeSha256:sha(r.bytes),afterSha256:sha(Buffer.from(m.after,'utf8')),edits:m.edits,_full:r.full,_before:r.bytes,_after:Buffer.from(m.after,'utf8')});
 }
 const body={format:'sara-migration-plan-v1',codemod:a.codemod,version:a.version,module:a.module,from:a.from,to:a.to,files:files.map(f=>[f.path,f.beforeSha256,f.afterSha256])};
 return {planSha:sha(JSON.stringify(body)),files,ws};
}
function apply(plan){
 const written=[],changed=plan.files.filter(f=>f.status==='changed'),tmpOf=f=>join(f._full,'..',`.${f.path.split('/').at(-1)}.${plan.planSha.slice(0,12)}.tmp`);
 try{
  for(const f of changed){
   writeFileSync(tmpOf(f),f._after,{flag:'wx'});
   const now=readSelected(plan.ws,f.path);if(sha(now.bytes)!==f.beforeSha256)fail();
   renameSync(tmpOf(f),f._full);written.push(f);
  }
  for(const f of plan.files)if(sha(readSelected(plan.ws,f.path).bytes)!==f.afterSha256)fail();
 }catch(e){
  for(const f of changed)rmSync(tmpOf(f),{force:true});
  for(const f of written)try{writeFileSync(f._full,f._before);}catch{}
  throw e;
 }
 return written.map(f=>f.path);
}
export async function handle(args,lang='en'){
 const l=labels[lang]??labels.en;
 try{
  admit(args);
  const plan=preview(args),changed=plan.files.filter(f=>f.status==='changed').length;
  const report={format:'sara-migration-report-v1',operation:args.operation,codemod:args.codemod,version:args.version,module:args.module,from:args.from,to:args.to,planSha:plan.planSha,migratedParses:true,scope:'operator-staged-selected-workspace-v1',files:plan.files.map(({_full,_before,_after,...f})=>f),applied:false};
  let lines=[l.previewed,`${l.files}: ${changed}/${plan.files.length}`];
  if(args.operation==='apply'){
   if(args.planSha!==plan.planSha||!changed)fail();
   report.written=apply(plan);report.applied=true;report.verified=true;lines=[l.applied,`${l.files}: ${changed}/${plan.files.length}`];
  }
  const content=JSON.stringify(report);if(Buffer.byteLength(content)>LIMITS.resultBytes)fail();
  return {content,card:{title:l.title,lines}};
 }catch{fail();}
}
