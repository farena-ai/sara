const obj=(properties)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str=(maxLength=96,minLength=1)=>({type:'string',minLength,maxLength});
const arr=(items,maxItems,minItems=0)=>({type:'array',items,minItems,maxItems});
const path={...str(96),pattern:'^[A-Za-z0-9_@.-]+(?:/[A-Za-z0-9_@.-]+)*$'};
const pair=obj({from:path,to:path});
const common={files:arr(obj({path,source:str(8192,0),kind:{...str(6),enum:['source','test']}}),24,1),packages:arr(obj({name:{...str(64),pattern:'^(?:@[a-z0-9_-]+/)?[a-z0-9_-]+$'},root:path,entry:path}),12)};
export const impactSchema=obj({...common,changes:arr(obj({path,symbol:str(64)}),12,1)});
export const architectureSchema=obj({...common,rules:obj({forbidden:arr(pair,24),layers:arr(obj({name:str(32),prefix:path}),12),allowed:arr(obj({from:str(32),to:str(32)}),48),defaultPolicy:{...str(5),enum:['allow','deny']}})});
function validate(v,s,depth=0){
 if(depth>12)throw Error('depth');
 if(s.type==='object'){if(!v||Array.isArray(v)||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('object');for(const k of Reflect.ownKeys(v)){if(typeof k!=='string'||['__proto__','constructor','prototype'].includes(k)||!Object.hasOwn(s.properties,k))throw Error('key');const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value'))throw Error('accessor');validate(d.value,s.properties[k],depth+1);}for(const k of s.required)if(!Object.hasOwn(v,k))throw Error('required');}
 else if(s.type==='array'){
  if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype)throw Error('array');
  const length=Object.getOwnPropertyDescriptor(v,'length');if(!length||!Object.hasOwn(length,'value')||length.value<s.minItems||length.value>s.maxItems)throw Error('array');
  const keys=Reflect.ownKeys(v);if(keys.length!==length.value+1)throw Error('array-key');
  for(const k of keys){if(k==='length')continue;if(typeof k!=='string'||!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=length.value)throw Error('array-key');const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value'))throw Error('sparse/accessor');validate(d.value,s.items,depth+1);}
 }
 else if(s.type==='string'){if(typeof v!=='string'||v.length<s.minLength||v.length>s.maxLength||s.enum&&!s.enum.includes(v)||s.pattern&&!new RegExp(s.pattern).test(v))throw Error('string');}else throw Error('schema');
}
const inside=(p,r)=>p===r||p.startsWith(r+'/');
function safePath(p){if(p.split('/').some(s=>s==='.'||s==='..'||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)||s.endsWith('.')))throw Error('path');}
export function admit(input,mode){
 validate(input,mode==='impact'?impactSchema:architectureSchema);
 let bytes=0;const seen=new Set();for(const f of input.files){safePath(f.path);if(!/\.(ts|tsx|js|jsx)$/.test(f.path)||seen.has(f.path))throw Error('file');seen.add(f.path);bytes+=Buffer.byteLength(f.source);if(Buffer.byteLength(f.source)>8192)throw Error('file-bytes');}
 for(const path of seen)if([...seen].some(other=>other!==path&&inside(path,other)))throw Error('file-ancestor-identity');
 if(bytes>32768||Buffer.byteLength(JSON.stringify(input))>48000)throw Error('input-bytes');
 const names=new Set(),roots=[];for(const p of input.packages){safePath(p.root);safePath(p.entry);if(names.has(p.name)||roots.some(r=>inside(p.root,r)||inside(r,p.root))||[...seen].some(f=>inside(p.root,f))||!seen.has(p.root+'/'+p.entry))throw Error('package-identity');names.add(p.name);roots.push(p.root);}
 if(mode==='impact'){const changes=new Set();for(const c of input.changes){safePath(c.path);const key=c.path+'#'+c.symbol;if(!seen.has(c.path)||changes.has(key))throw Error('change');changes.add(key);}}
 else{const layers=input.rules.layers,layerNames=new Set();for(const l of layers){safePath(l.prefix);if(layerNames.has(l.name)||layers.some(o=>o!==l&&(inside(o.prefix,l.prefix)||inside(l.prefix,o.prefix))))throw Error('layer');layerNames.add(l.name);}for(const a of input.rules.allowed)if(!layerNames.has(a.from)||!layerNames.has(a.to))throw Error('layer-reference');for(const r of input.rules.forbidden){safePath(r.from);safePath(r.to);}}
}
