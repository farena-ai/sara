import {lstatSync, realpathSync, opendirSync, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import labels from './labels.json' with {type:'json'};
export const LIMITS=Object.freeze({files:128,entries:256,depth:8,bytes:16777216,ms:5000,resultBytes:49152});
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=()=>{throw new Error('Cache inspection refused: unsupported, changed, unavailable or over budget. No files changed.');};
function admit(a){
 function obj(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!('value' in d)||!d.enumerable)fail();}}
 function num(v,min,max){if(!Number.isSafeInteger(v)||v<min||v>max)fail();}
 // Inspect descriptors before any property read or JSON serialization.
 if(!a||Object.getPrototypeOf(a)!==Object.prototype)fail();
 const op=Object.getOwnPropertyDescriptor(a,'operation');if(!op||!('value' in op))fail();
 if(op.value==='inspect')obj(a,['operation','cacheId']);else if(op.value==='preview')obj(a,['operation','cacheId','snapshot','policy']);else fail();
 if(a.cacheId!=='typescript')fail();
 if(a.operation==='preview'){
  if(typeof a.snapshot!=='string'||! /^[a-f0-9]{64}$/.test(a.snapshot))fail();
  const p=a.policy;obj(p,['referenceMs','minAgeMs','maxPruneBytes','retainNewest','preserve']);
  num(p.referenceMs,Date.now()-300000,Date.now()+60000);num(p.minAgeMs,0,31536000000);num(p.maxPruneBytes,0,LIMITS.bytes);num(p.retainNewest,1,LIMITS.files);
  const r=p.preserve;if(!Array.isArray(r)||Object.getPrototypeOf(r)!==Array.prototype)fail();
  const ld=Object.getOwnPropertyDescriptor(r,'length');if(!ld||!('value' in ld))fail();num(ld.value,0,128);
  const keys=Reflect.ownKeys(r);if(keys.length!==ld.value+1||keys.some(k=>k!=='length'&&(typeof k!=='string'||! /^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=ld.value)))fail();
  for(let i=0;i<ld.value;i++){const d=Object.getOwnPropertyDescriptor(r,String(i));if(!d||!('value' in d)||!d.enumerable||typeof d.value!=='string'||! /^f[0-9]{3}$/.test(d.value))fail();}
  if(new Set(r).size!==r.length)fail();
 }
 if(JSON.stringify(a).length>65536)fail();
}
function measure(){
 const started=Date.now(),home=resolve(process.cwd()),root=join(home,'owned-caches-v1','typescript');
 const check=()=>{if(Date.now()-started>LIMITS.ms)fail();};
 const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
 function dir(p){const s=lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(p)!==p)fail();return stamp(s);}
 const ancestors=[home,join(home,'owned-caches-v1'),root].map(p=>[p,dir(p)]);
 let entries=0,total=0n;const found=[],dirs=[];
 function walk(p,relative,depth){
  check();if(depth>LIMITS.depth)fail();const before=dir(p);dirs.push([p,before]);
  const names=[],listing=opendirSync(p,{bufferSize:32});
  try{for(;;){check();const entry=listing.readSync();if(!entry)break;if(++entries>LIMITS.entries)fail();names.push(entry.name);}}finally{listing.closeSync();}
  names.sort();
  for(const name of names){
   check();if(!name||name==='.'||name==='..'||/[\\/:\x00-\x1f\x7f]/.test(name)||name.endsWith('.')||name.endsWith(' ')||name.length>128)fail();
   const full=join(p,name),rel=relative?relative+'/'+name:name,s=lstatSync(full,{bigint:true});
   if(s.isSymbolicLink())fail();
   if(s.isDirectory()){walk(full,rel,depth+1);continue;}
   if(!s.isFile()||s.nlink!==1n||s.size<0n||s.size>BigInt(LIMITS.bytes)||found.length>=LIMITS.files)fail();
   total+=s.size;if(total>BigInt(LIMITS.bytes))fail();
   if(realpathSync(full)!==full)fail();
   const fd=openSync(full,'r');let digest;
   try{
    if(stamp(fstatSync(fd,{bigint:true}))!==stamp(s))fail();
    const h=createHash('sha256'),buf=Buffer.alloc(65536);let read=0n;
    for(;;){check();const n=readSync(fd,buf,0,buf.length,null);if(!n)break;read+=BigInt(n);if(read>s.size)fail();h.update(buf.subarray(0,n));}
    if(read!==s.size||stamp(fstatSync(fd,{bigint:true}))!==stamp(s))fail();digest=h.digest('hex');
   }finally{closeSync(fd);}
   if(stamp(lstatSync(full,{bigint:true}))!==stamp(s))fail();
   found.push({full,rel,stamp:stamp(s),bytes:s.size.toString(),mtimeNs:s.mtimeNs.toString(),sha256:digest});
  }
  if(dir(p)!==before)fail();
 }
 walk(root,'',0);
 for(const [p,s] of [...ancestors,...dirs])if(dir(p)!==s)fail();
 for(const f of found)if(stamp(lstatSync(f.full,{bigint:true}))!==f.stamp)fail();
 found.sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);
 check();
 const snapshot=sha(JSON.stringify({anchors:ancestors.map(([,s])=>s),dirs:dirs.map(([p,s])=>[p.slice(root.length),s]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0),files:found.map(f=>[f.rel,f.stamp,f.sha256])}));
 return {complete:true,scope:'operator-staged-native-home-v1',cacheId:'typescript',snapshot,measuredAtMs:Date.now(),totalBytes:total.toString(),files:found.map((f,i)=>({ref:'f'+String(i+1).padStart(3,'0'),bytes:f.bytes,mtimeNs:f.mtimeNs,sha256:f.sha256})),mutated:false};
}
export async function handle(args,lang='en'){
 try{
  admit(args);
  const measured=measure();
  let result=measured;
  if(args.operation==='preview'){
   if(args.snapshot!==measured.snapshot)fail();
   const p=args.policy,refs=new Set(measured.files.map(f=>f.ref));
   if(p.preserve.some(r=>!refs.has(r)))fail();
   const newest=[...measured.files].sort((a,b)=>BigInt(a.mtimeNs)>BigInt(b.mtimeNs)?-1:BigInt(a.mtimeNs)<BigInt(b.mtimeNs)?1:a.ref.localeCompare(b.ref));
   const kept=new Set([...p.preserve,...newest.slice(0,p.retainNewest).map(f=>f.ref)]);
   const eligible=measured.files.filter(f=>!kept.has(f.ref)&&BigInt(p.referenceMs)*1000000n-BigInt(f.mtimeNs)>=BigInt(p.minAgeMs)*1000000n).sort((a,b)=>BigInt(a.mtimeNs)<BigInt(b.mtimeNs)?-1:BigInt(a.mtimeNs)>BigInt(b.mtimeNs)?1:a.ref.localeCompare(b.ref));
   let estimated=0n;const candidates=[];let cutoff=false;
   for(const f of eligible){if(estimated+BigInt(f.bytes)>BigInt(p.maxPruneBytes)){cutoff=true;break;}estimated+=BigInt(f.bytes);candidates.push(f.ref);}
   result={...measured,operation:'preview',policy:p,policyProvenance:'explicit-caller-policy-v1',candidates,estimatedBytes:String(estimated),cutoff,preserved:[...kept].sort()};
  }
  const content=JSON.stringify(result);if(Buffer.byteLength(content)>LIMITS.resultBytes)fail();
  const l=labels[lang]??labels.en;
  return {content,card:{title:l[0],lines:[l[2],`${l[3]}: ${measured.files.length}; ${l[4]}: ${measured.totalBytes}`]}};
 }catch{fail();}
}
