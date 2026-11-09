import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {cpus,platform,arch} from 'node:os';
import vm from 'node:vm';
import labels from './labels.json' with {type:'json'};
export const LIMITS=Object.freeze({scriptBytes:262144,worstCaseMs:20000,resultBytes:49152,bootstrap:2000});
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=()=>{throw new Error('Performance run refused: unsupported, changed, failed, timed out or over budget. Nothing was changed.');};
const KEYS=['operation','benchmark','samples','warmup','minEffectPercent','sampleTimeoutMs'];
function admit(a){
 // Inspect descriptors before reading or serializing anything (no getters/toJSON can run).
 if(!a||Object.getPrototypeOf(a)!==Object.prototype)fail();
 const op=Object.getOwnPropertyDescriptor(a,'operation');if(!op||!('value' in op))fail();
 const keys=op.value==='plan'?KEYS:op.value==='run'?[...KEYS,'planSha']:fail();
 const own=Reflect.ownKeys(a);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();
 for(const k of own){const d=Object.getOwnPropertyDescriptor(a,k);if(!d||!('value' in d)||!d.enumerable)fail();}
 const int=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail();};
 if(typeof a.benchmark!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(a.benchmark))fail();
 int(a.samples,5,60);int(a.warmup,0,20);int(a.minEffectPercent,1,100);int(a.sampleTimeoutMs,1,2000);
 if((a.samples+a.warmup)*2*a.sampleTimeoutMs>LIMITS.worstCaseMs)fail();
 if(op.value==='run'&&(typeof a.planSha!=='string'||!/^[a-f0-9]{64}$/.test(a.planSha)))fail();
}
function staged(benchmark){
 const home=resolve(process.cwd()),parts=[home,join(home,'perf-lab-v1'),join(home,'perf-lab-v1',benchmark)];
 for(const p of parts){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(p)!==p)fail();}
 const read=name=>{const p=join(parts[2],name),s=lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size>LIMITS.scriptBytes||realpathSync(p)!==p)fail();const bytes=readFileSync(p);if(bytes.length!==s.size)fail();return {bytes,source:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};};
 return {baseline:read('baseline.js'),candidate:read('candidate.js')};
}
function makePlan(a,code){
 const body={format:'sara-perf-lab-plan-v1',benchmark:a.benchmark,baselineSha256:sha(code.baseline.bytes),candidateSha256:sha(code.candidate.bytes),samples:a.samples,warmup:a.warmup,minEffectPercent:a.minEffectPercent,sampleTimeoutMs:a.sampleTimeoutMs,worstCaseMs:(a.samples+a.warmup)*2*a.sampleTimeoutMs,runtime:{node:process.version,isolation:'node:vm context, string code generation and wasm disabled, inside the permission-limited plugin process'}};
 return {...body,planSha:sha(JSON.stringify(body)),executed:false};
}
// Each side runs in its own fresh context; only primitives cross back into the host realm.
function prepare(source,name,timeout){
 const ctx=vm.createContext({},{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
 new vm.Script(source,{filename:name}).runInContext(ctx,{timeout});
 if(new vm.Script('typeof bench==="function"').runInContext(ctx,{timeout})!==true)fail();
 const call=new vm.Script('(()=>{const r=bench();return typeof r==="number"&&Number.isFinite(r);})()');
 return ()=>{const t0=process.hrtime.bigint(),ok=call.runInContext(ctx,{timeout}),t1=process.hrtime.bigint();if(ok!==true)fail();const ns=t1-t0;return ns>0n?ns:1n;};
}
const median=v=>{const s=[...v].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const relMad=v=>{const m=median(v);return median(v.map(x=>Math.abs(x-m)))/m;};
function mannWhitneyZ(b,c){
 const all=[...b.map(v=>[v,0]),...c.map(v=>[v,1])].sort((x,y)=>x[0]-y[0]),ranks=new Array(all.length);
 let ties=0;for(let i=0;i<all.length;){let j=i;while(j+1<all.length&&all[j+1][0]===all[i][0])j++;const r=(i+j+2)/2,t=j-i+1;ties+=t*t*t-t;for(let k=i;k<=j;k++)ranks[k]=r;i=j+1;}
 const n1=b.length,n2=c.length,n=n1+n2;let rc=0;all.forEach((x,i)=>{if(x[1])rc+=ranks[i];});
 const u=rc-n2*(n2+1)/2,sd=Math.sqrt(n1*n2/12*((n+1)-ties/(n*(n-1))));return sd>0?(u-n1*n2/2)/sd:0;
}
function bootstrap(b,c,seedHex){
 let s=parseInt(seedHex.slice(0,8),16)||1;const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};
 const pick=v=>{const o=new Array(v.length);for(let i=0;i<v.length;i++)o[i]=v[Math.floor(rnd()*v.length)];return o;};
 const r=[];for(let i=0;i<LIMITS.bootstrap;i++)r.push(median(pick(c))/median(pick(b)));r.sort((x,y)=>x-y);
 return [r[Math.floor(0.025*LIMITS.bootstrap)],r[Math.ceil(0.975*LIMITS.bootstrap)-1]];
}
function run(a,plan,code){
 const t=a.sampleTimeoutMs,A=prepare(code.baseline.source,'baseline.js',t),B=prepare(code.candidate.source,'candidate.js',t),base=[],cand=[];
 for(let i=0;i<a.warmup;i++){if(i%2){B();A();}else{A();B();}}
 for(let i=0;i<a.samples;i++){if(i%2){cand.push(B());base.push(A());}else{base.push(A());cand.push(B());}}
 const b=base.map(Number),c=cand.map(Number),mb=median(b),mc=median(c),noise=[relMad(b),relMad(c)],z=mannWhitneyZ(b,c),limit=1+a.minEffectPercent/100;
 const out={format:'sara-perf-lab-run-v1',operation:'run',planSha:plan.planSha,benchmark:a.benchmark,baselineSha256:plan.baselineSha256,candidateSha256:plan.candidateSha256,order:'interleaved-abba',samples:a.samples,warmup:a.warmup,minEffectPercent:a.minEffectPercent,rawSamplesNs:{baseline:base.map(String),candidate:cand.map(String)},medianNs:{baseline:mb,candidate:mc},relativeMad:noise.map(x=>Math.round(x*10000)/10000),mannWhitneyZ:Math.round(z*1000)/1000,hardware:{platform:platform(),arch:arch(),cpus:cpus().length,cpuModel:String(cpus()[0]?.model??'unknown').slice(0,80),node:process.version},executed:true,sameHostInterleaved:true};
 let status='inconclusive',reason;
 if(a.samples<10)reason='underpowered';
 else if(noise.some(x=>x>0.25))reason='noisy';
 else{
  const ci=bootstrap(b,c,plan.planSha);
  if(ci[0]>limit&&z>2.326){status='regression';reason='slower-beyond-threshold';}
  else if(ci[1]<limit){status='no-regression';reason='within-threshold';}
  else reason='effect-uncertain';
  if(status!=='inconclusive'){out.ratioCi=ci.map(x=>Math.round(x*10000)/10000);out.slowdownPercent=Math.round((mc/mb-1)*1000)/10;}
 }
 return {...out,status,reason};
}
export async function handle(args,lang='en'){
 const l=labels[lang]??labels.en;
 try{
  admit(args);
  const code=staged(args.benchmark),plan=makePlan(args,code);
  let result=plan,lines=[l.planned,`${l.samples}: ${args.samples} × 2`];
  if(args.operation==='run'){
   if(args.planSha!==plan.planSha)fail();
   result=run(args,plan,code);lines=[l[result.status],`${l.samples}: ${args.samples} × 2`];
   const again=staged(args.benchmark);if(sha(again.baseline.bytes)!==plan.baselineSha256||sha(again.candidate.bytes)!==plan.candidateSha256)fail();
  }
  const content=JSON.stringify(result);if(Buffer.byteLength(content)>LIMITS.resultBytes)fail();
  return {content,card:{title:l.title,lines}};
 }catch{fail();}
}
