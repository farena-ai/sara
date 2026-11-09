import {lstatSync,realpathSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import labels from './labels.json' with {type:'json'};
export const LIMITS=Object.freeze({sourceFiles:64,depth:6,sourceBytes:1048576,scriptBytes:262144,outputFiles:64,outputBytes:4194304,buildMs:5000,resultBytes:49152});
export const RUNNER='sara-repro-runner-v1';
const SOURCE_DATE_EPOCH=1767225600; // fixed, shared by both builds (2026-01-01T00:00:00Z)
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=()=>{throw new Error('Build comparison refused: unsupported, changed, failed, timed out or over budget. Nothing was changed.');};
const NAME=/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
function admit(a){
 if(!a||Object.getPrototypeOf(a)!==Object.prototype)fail();
 const op=Object.getOwnPropertyDescriptor(a,'operation');if(!op||!('value' in op))fail();
 const keys=op.value==='plan'?['operation','profile']:op.value==='compare'?['operation','profile','planSha']:fail();
 const own=Reflect.ownKeys(a);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();
 for(const k of own){const d=Object.getOwnPropertyDescriptor(a,k);if(!d||!('value' in d)||!d.enumerable)fail();}
 if(typeof a.profile!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(a.profile))fail();
 if(op.value==='compare'&&(typeof a.planSha!=='string'||!/^[a-f0-9]{64}$/.test(a.planSha)))fail();
}
const decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
function dir(p){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(p)!==p)fail();}
function file(p,max){const s=lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size>max||realpathSync(p)!==p)fail();const b=readFileSync(p);if(b.length!==s.size)fail();return b;}
// Snapshot the reviewed profile into memory once; both builds receive copies of these exact bytes.
function snapshot(profile){
 const home=resolve(process.cwd()),base=join(home,'repro-v1',profile);
 for(const p of [home,join(home,'repro-v1'),base,join(base,'source')])dir(p);
 const script=file(join(base,'build.js'),LIMITS.scriptBytes),inputs={};let total=0,count=0;
 const walk=(p,rel,depth)=>{if(depth>LIMITS.depth)fail();dir(p);for(const name of readdirSync(p).sort()){if(!NAME.test(name)||name.endsWith('.'))fail();const full=join(p,name),r=rel?rel+'/'+name:name,s=lstatSync(full);
  if(s.isSymbolicLink())fail();if(s.isDirectory()){walk(full,r,depth+1);continue;}if(++count>LIMITS.sourceFiles)fail();const b=file(full,LIMITS.sourceBytes);total+=b.length;if(total>LIMITS.sourceBytes)fail();inputs[r]=decode(b);}};
 walk(join(base,'source'),'',0);
 const sourceSha=sha(JSON.stringify(Object.keys(inputs).sort().map(k=>[k,sha(inputs[k])])));
 return {script:decode(script),scriptSha:sha(script),inputs,sourceSha,count};
}
function makePlan(a,s){
 const body={format:'sara-repro-plan-v1',profile:a.profile,buildScriptSha256:s.scriptSha,sourceTreeSha256:s.sourceSha,sourceFiles:s.count,toolchain:{node:process.version,runner:RUNNER},sourceDateEpoch:SOURCE_DATE_EPOCH,variation:['clock','buildRoot'],isolation:'two fresh node:vm contexts, string code generation and wasm disabled, inside the permission-limited plugin process'};
 return {...body,planSha:sha(JSON.stringify(body)),executed:false};
}
const OUT=/^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){0,7}$/;
function build(s,clockMs,buildRoot){
 const ctx=vm.createContext({},{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'}),o={timeout:LIMITS.buildMs};
 // Controlled clock: the only time source the build can observe.
 new vm.Script(`(()=>{const R=Date,T=${clockMs};class D extends R{constructor(...a){if(a.length)super(...a);else super(T);}static now(){return T;}}globalThis.Date=D;})();`).runInContext(ctx,o);
 new vm.Script(s.script,{filename:'build.js'}).runInContext(ctx,o);
 ctx.__inputs=JSON.stringify(s.inputs);ctx.__env=JSON.stringify({buildRoot,sourceDateEpoch:SOURCE_DATE_EPOCH});
 const raw=new vm.Script('(()=>{if(typeof build!=="function")return null;const r=build(JSON.parse(__inputs),JSON.parse(__env));return JSON.stringify(r);})()').runInContext(ctx,o);
 if(typeof raw!=='string')fail();const out=JSON.parse(raw);
 if(!out||typeof out!=='object'||Array.isArray(out))fail();const paths=Object.keys(out).sort();if(!paths.length||paths.length>LIMITS.outputFiles)fail();
 let total=0;const files={};for(const p of paths){if(!OUT.test(p)||typeof out[p]!=='string')fail();const b=Buffer.from(out[p],'utf8');total+=b.length;if(total>LIMITS.outputBytes)fail();files[p]=b;}
 return files;
}
const lineOf=(t,i)=>t.slice(0,i).split('\n').length;
function explain(ta,tb,A,B){
 const reps=t=>{const d=new Date(t);return [['timestamp','iso',d.toISOString()],['timestamp','utc',d.toUTCString()],['timestamp','epoch-ms',String(t)],['timestamp','epoch-s',String(Math.floor(t/1000))]];};
 const ra=[...reps(A.clockMs),['path','build-root',A.buildRoot]],rb=[...reps(B.clockMs),['path','build-root',B.buildRoot]];
 let na=ta,nb=tb;const evidence=[];
 for(let i=0;i<ra.length;i++){const [kind,format,va]=ra[i],vb=rb[i][2],ia=na.indexOf(va),ib=nb.indexOf(vb);
  if(ia>=0&&ib>=0)evidence.push({kind,format,line:lineOf(na,ia),a:va,b:vb});
  na=na.split(va).join(`\u0000${i}\u0000`);nb=nb.split(vb).join(`\u0000${i}\u0000`);}
 if(na!==nb||!evidence.length)return null;
 return {causes:[...new Set(evidence.map(e=>e.kind))].sort(),evidence};
}
function firstDiff(a,b){const n=Math.min(a.length,b.length);for(let i=0;i<n;i++)if(a[i]!==b[i])return i;return n;}
function compare(plan,s){
 const clockA=Date.now(),clockB=clockA+86400000+1234,builds=[{clockMs:clockA,buildRoot:`/sara-repro/${plan.planSha.slice(0,8)}/build-a`},{clockMs:clockB,buildRoot:`/sara-repro/${plan.planSha.slice(0,8)}/build-b`}];
 const outA=build(s,builds[0].clockMs,builds[0].buildRoot),outB=build(s,builds[1].clockMs,builds[1].buildRoot);
 const files=[];let unexplained=0,explained=0;
 for(const path of [...new Set([...Object.keys(outA),...Object.keys(outB)])].sort()){
  const a=outA[path],b=outB[path],f={path,sha256:[a?sha(a):null,b?sha(b):null],bytes:[a?a.length:null,b?b.length:null]};
  if(!a||!b){f.status=a?'missing-in-b':'missing-in-a';unexplained++;}
  else if(f.sha256[0]===f.sha256[1])f.status='identical';
  else{const e=explain(a.toString('utf8'),b.toString('utf8'),builds[0],builds[1]);
   if(e){f.status='explained';f.causes=e.causes;f.evidence=e.evidence;explained++;}else{f.status='unexplained';f.firstDifferenceOffset=firstDiff(a,b);unexplained++;}}
  files.push(f);
 }
 const tree=i=>sha(JSON.stringify(files.map(f=>[f.path,f.sha256[i]])));
 builds.forEach((b,i)=>{b.treeSha256=tree(i);b.files=Object.keys(i?outB:outA).length;});
 return {format:'sara-repro-report-v1',operation:'compare',planSha:plan.planSha,profile:plan.profile,toolchain:plan.toolchain,sourceTreeSha256:plan.sourceTreeSha256,buildScriptSha256:plan.buildScriptSha256,executed:true,independentBuilds:2,reproducible:builds[0].treeSha256===builds[1].treeSha256,explained,unexplained,builds,files};
}
export async function handle(args,lang='en'){
 const l=labels[lang]??labels.en;
 try{
  admit(args);
  const s=snapshot(args.profile),plan=makePlan(args,s);
  let result=plan,lines=[l.planned,`${l.files}: ${s.count}`];
  if(args.operation==='compare'){
   if(args.planSha!==plan.planSha)fail();
   result=compare(plan,s);const again=snapshot(args.profile);if(again.scriptSha!==s.scriptSha||again.sourceSha!==s.sourceSha)fail();
   const differing=result.files.filter(f=>f.status!=='identical').length;
   lines=[result.reproducible?l.reproducible:result.unexplained?l.unexplained:l.explained,`${l.files}: ${result.files.length}; ${l.differing}: ${differing}`];
  }
  const content=JSON.stringify(result);if(Buffer.byteLength(content)>LIMITS.resultBytes)fail();
  return {content,card:{title:l.title,lines}};
 }catch{fail();}
}
