import {createHash} from 'node:crypto';
export const sha=text=>createHash('sha256').update(text).digest('hex');
const refuse=()=>{throw Error('Invalid or unsupported bounded input');};
export function catalog(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>24000)refuse();
 let i=0;const ws=()=>{while(/[\x20\t\r\n]/.test(raw[i]??'!'))i++;};
 const string=()=>{ws();if(raw[i]!=='"')refuse();const start=i++;let ended=false;while(i<raw.length){const c=raw[i++];if(c==='\\'){i++;continue;}if(c==='"'){ended=true;break;}if(c.charCodeAt(0)<32)refuse();}if(!ended)refuse();return JSON.parse(raw.slice(start,i));};
 ws();if(raw[i++]!=='{')refuse();const out=Object.create(null);ws();if(raw[i]==='}')refuse();
 while(true){const k=string();if(!k.length||k.length>128||['__proto__','constructor','prototype'].includes(k)||Object.hasOwn(out,k))refuse();ws();if(raw[i++]!==':')refuse();const v=string();if(v.length>512||Object.keys(out).length>=32)refuse();out[k]=v;ws();const c=raw[i++];if(c==='}')break;if(c!==',')refuse();}
 ws();if(i!==raw.length)refuse();return out;
}
export function tokens(text){
 const out=[];let i=0;
 while(i<text.length){
  if(text[i]==='\\'){if(!['\\','{','}'].includes(text[i+1]))refuse();i+=2;}
  else if(text[i]==='{'){const end=text.indexOf('}',i+1);if(end<0)refuse();const part=text.slice(i+1,end);if(!/^[a-zA-Z][a-zA-Z0-9_]{0,31}(?::(?:string|number))?$/.test(part))refuse();out.push(part.includes(':')?part:part+':string');i=end+1;}
  else if(text[i]==='}')refuse();else i++;
 }
 return out.sort();
}
// Inspect descriptors before any property reads or serialization. JSON transport cannot carry
// callbacks; this also fails closed on hostile direct in-process objects (not Proxy isolation).
function safe(value,seen=new Set(),depth=0,state={nodes:0}){
 if(++state.nodes>5000||depth>12)refuse();
 if(value===null||typeof value==='boolean'||typeof value==='string'||(typeof value==='number'&&Number.isFinite(value)))return;
 if(typeof value!=='object'||seen.has(value))refuse();seen.add(value);
 const array=Array.isArray(value),proto=Object.getPrototypeOf(value);if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)refuse();
 for(const key of Reflect.ownKeys(value)){
  if(array&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||['toJSON','__proto__','constructor','prototype'].includes(key)||(array&&!/^(0|[1-9][0-9]*)$/.test(key)))refuse();safe(d.value,seen,depth+1,state);
 }
 if(array&&Object.keys(value).length!==value.length)refuse();seen.delete(value);
}
function shape(obj,required,optional=[]){if(!obj||Array.isArray(obj)||typeof obj!=='object'||required.some(k=>!Object.hasOwn(obj,k))||Object.keys(obj).some(k=>!required.includes(k)&&!optional.includes(k)))refuse();}
function layoutEvidence(e,base,target,args){
 shape(e,['fixture','htmlSha','captureSha','baseSha','targetSha','renderer','browserVersion','dpr','font','viewports','rows']);
 if(e.fixture!=='localization-owned-v1'||e.htmlSha!=='a6918227c1173ca6cb492a292668bc17a1f03b914bce6fcab3c2ea55749662d3'||! /^[0-9a-f]{64}$/.test(e.captureSha)||e.baseSha!==sha(args.base)||e.targetSha!==sha(args.target)||e.renderer!=='chromium'||!/^\d{1,3}(?:\.\d{1,5}){3}$/.test(e.browserVersion)||e.dpr!==1||e.font!=='16px Arial'||JSON.stringify(e.viewports)!=='[390,900]'||!Array.isArray(e.rows))refuse();
 const keys=Object.keys(base).sort(),common=keys.filter(k=>Object.hasOwn(target,k)),seen=new Set(),findings=[];
 if(!common.length||e.rows.length!==common.length*2)refuse();
 const metrics=(m,text,viewport)=>{
  shape(m,['x','y','width','height','scrollWidth','scrollHeight','textWidth','textHeight','textSha']);
  for(const k of ['x','y','width','height','scrollWidth','scrollHeight','textWidth','textHeight'])if(typeof m[k]!=='number'||!Number.isFinite(m[k])||m[k]<0||m[k]>32768)refuse();
  if(m.textSha!==sha(text)||m.width!==180||m.height!==24||m.x+m.width>viewport||m.y+m.height>720||!Number.isInteger(m.scrollWidth)||!Number.isInteger(m.scrollHeight)||m.scrollWidth<m.width||m.scrollHeight<m.height||Math.abs(m.scrollWidth-Math.max(m.width,m.textWidth))>1||Math.abs(m.scrollHeight-Math.max(m.height,m.textHeight))>1||(!text.length?m.textWidth!==0:m.textWidth<=0)||m.textHeight>2000)refuse();
 };
 const origins=new Map();
 for(const row of e.rows){
  shape(row,['ref','viewport','b','t']);if(!/^k\d{3}$/.test(row.ref)||![390,900].includes(row.viewport))refuse();
  const key=keys[Number(row.ref.slice(1))-1],id=row.ref+':'+row.viewport;
  if(!common.includes(key)||seen.has(id))refuse();seen.add(id);metrics(row.b,base[key],row.viewport);metrics(row.t,target[key],row.viewport);
  const origin=row.b.y-common.indexOf(key)*32;if(row.b.x!==16||origin<40||origin>120||(origins.has(row.viewport)&&Math.abs(origins.get(row.viewport)-origin)>0.01))refuse();origins.set(row.viewport,origin);
  if(row.b.x!==row.t.x||row.b.y!==row.t.y||row.b.scrollWidth>row.b.width+1||row.b.scrollHeight>row.b.height+1)refuse();
  if(row.t.scrollWidth>row.t.width+1||row.t.scrollHeight>row.t.height+1)findings.push({kind:'rendered-overflow',side:'base',ref:row.ref,viewport:row.viewport,horizontalPixels:Math.max(0,row.t.scrollWidth-row.t.width),verticalPixels:Math.max(0,row.t.scrollHeight-row.t.height)});
 }
 return findings.sort((a,b)=>a.ref.localeCompare(b.ref)||a.viewport-b.viewport);
}
export function analyze(args){
 safe(args);shape(args,['base','target','grammar'],['evidence']);const serialized=JSON.stringify(args);if(serialized.length>65536||Buffer.byteLength(serialized)>180000)refuse();
 if(args.grammar!=='named-v1')refuse();const base=catalog(args.base),target=catalog(args.target);const bk=Object.keys(base).sort(),tk=Object.keys(target).sort(),findings=[];
 const bt=Object.fromEntries(bk.map(k=>[k,tokens(base[k])])),tt=Object.fromEntries(tk.map(k=>[k,tokens(target[k])]));
 const ref=(keys,key)=>'k'+String(keys.indexOf(key)+1).padStart(3,'0');
 for(const key of bk)if(!Object.hasOwn(target,key))findings.push({kind:'missing-key',side:'base',ref:ref(bk,key)});
 for(const key of tk)if(!Object.hasOwn(base,key))findings.push({kind:'extra-key',side:'target',ref:ref(tk,key)});
 for(const key of bk)if(Object.hasOwn(target,key)&&JSON.stringify(bt[key])!==JSON.stringify(tt[key]))findings.push({kind:'interpolation',side:'base',ref:ref(bk,key)});
 if(Object.hasOwn(args,'evidence')){findings.push(...layoutEvidence(args.evidence,base,target,args));}
 return {status:findings.length?'findings':'catalog-checked',layout:Object.hasOwn(args,'evidence')?'measured':'not-measured',findings};
}
