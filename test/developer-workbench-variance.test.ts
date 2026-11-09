import assert from 'node:assert/strict';
import test from 'node:test';
const enginePath='../tools/developer-workbench/contract-diff.mjs';
export function document(schema:any,mode='request'):any {
 const content={'application/json':{schema}};
 return {openapi:'3.0.3',info:{title:'Synthetic',version:'1'},paths:{'/items':{post:{...(mode==='request'?{requestBody:{content}}:{}),responses:{'200':{description:'OK',...(mode==='response'?{content}:{})}}}}}};
}
export const regressions=[
 {name:'optional request name constrains formerly unconstrained fallback',mode:'request',before:{type:'object'},after:{type:'object',properties:{tag:{type:'string'}}},payload:{tag:7}},
 {name:'removed request name now uses differently typed fallback',mode:'request',before:{type:'object',properties:{tag:{type:'integer'}},additionalProperties:{type:'string'}},after:{type:'object',additionalProperties:{type:'string'}},payload:{tag:7}},
 {name:'new response name bypasses old typed fallback',mode:'response',before:{type:'object',additionalProperties:{type:'integer'}},after:{type:'object',properties:{tag:{type:'string'}},additionalProperties:{type:'integer'}},payload:{tag:'x'}}
];
// Independent payload evaluator: no comparison implementation or finding codes used.
export function accepts(s:any,v:any,doc:any):boolean {
 if(s===false)return false;if(s===true||s===undefined)return true;
 if(s.$ref){let r=doc;for(const t of s.$ref.slice(2).split('/'))r=r[t.replace(/~1/g,'/').replace(/~0/g,'~')];return accepts(r,v,doc);}
 if(s.enum&&!s.enum.some((x:any)=>Object.is(x,v)))return false;
 const type=v===null?'null':Array.isArray(v)?'array':typeof v;
 if(s.type&&!(v===null&&s.nullable===true)&&!(s.type==='integer'?typeof v==='number'&&Number.isInteger(v):s.type===type))return false;
 if(type==='object'){
  if((s.required??[]).some((k:string)=>!Object.hasOwn(v,k)))return false;
  for(const [k,x] of Object.entries(v))if(!accepts(Object.hasOwn(s.properties??{},k)?s.properties[k]:s.additionalProperties,x,doc))return false;
 }
 if(type==='array'&&!v.every((x:any)=>accepts(s.items,x,doc)))return false;
 return true;
}
test('effective property transition matrix uses independent payload acceptance in both directions and channels',async t=>{
 const {compareContracts}=await import(enginePath);
 const fallback=[undefined,true,false,{}, {type:'integer'}, {type:'number'}, {type:'string'}, {type:'string',enum:['x']}, {$ref:'#/components/schemas/Value'}];
 const named=[undefined,{}, {type:'integer'}, {type:'number'}, {type:'string'}, {type:'string',enum:['x']}, {type:'string',nullable:true}, {$ref:'#/components/schemas/Value'}, {type:'object',properties:{leaf:{type:'integer'}},additionalProperties:false}];
 const schemas:any[]=[];
 for(const f of fallback)for(const p of named)schemas.push({type:'object',...(f===undefined?{}:{additionalProperties:f}),...(p===undefined?{}:{properties:{tag:p}})});
 const scalars:any[]=[null,false,true,0,7,1.5,'x','y',[],{}, {leaf:7},{leaf:'x'}];
 const payloads:any[]=[{},...scalars.map(tag=>({tag})),...scalars.map(other=>({other})),...scalars.map(tag=>({tag,other:7}))];
 let comparisons=0,witnesses=0,compatible=0;
 for(const mode of ['request','response'])for(const bs of schemas)for(const as of schemas){
  const b=document(bs,mode),a=document(as,mode);for(const d of [b,a])d.components={schemas:{Value:{type:'string',enum:['x','y'],nullable:true}}};
  const witness=payloads.find(v=>mode==='request'?accepts(bs,v,b)&&!accepts(as,v,a):accepts(as,v,a)&&!accepts(bs,v,b));
  const r=compareContracts(b,a);comparisons++;if(r.compatible)compatible++;
  if(witness!==undefined){witnesses++;assert.equal(r.compatible,false,JSON.stringify({mode,bs,as,witness}));}
  // Every evidence location must resolve in its actual source document (implicit fallback is parent).
  for(const f of r.findings)for(const [d,p] of [[b,f.before],[a,f.after]] as any){let v=d;for(const k of p.slice(1).split('/')){assert.ok(v!==undefined&&Object.hasOwn(v,k.replace(/~1/g,'/').replace(/~0/g,'~')),p);v=v[k.replace(/~1/g,'/').replace(/~0/g,'~')];}}
 }
 assert.ok(compatible>100,'must not classify every transition as breaking');t.diagnostic(JSON.stringify({comparisons,payloads:payloads.length,witnesses,compatible}));
});
test('supported widening, required, nested and recursive fallback transitions retain precise compatibility',async()=>{
 const {compareContracts}=await import(enginePath);
 const cases:any[]=[
  [{type:'object',additionalProperties:false},{type:'object',additionalProperties:false,properties:{tag:{type:'string'}}},true],
  [{type:'object',properties:{tag:{type:'integer'}},additionalProperties:{type:'number'}},{type:'object',additionalProperties:{type:'number'}},true],
  [{type:'object',additionalProperties:{type:'integer'}},{type:'object',properties:{tag:{type:'number'}},additionalProperties:{type:'integer'}},true],
  [{type:'object',properties:{tag:{type:'string',enum:['x']}}},{type:'object',properties:{tag:{type:'string',enum:['x','y']}}},true],
  [{type:'object',properties:{tag:{type:'string'}}},{type:'object',properties:{tag:{type:'string',nullable:true}}},true],
  [{type:'object',properties:{tag:{type:'string'}},required:['tag']},{type:'object',properties:{tag:{type:'string'}}},true]
 ];
 for(const [b,a,widening] of cases){assert.equal(compareContracts(document(b),document(a)).compatible,widening);assert.equal(compareContracts(document(a,'response'),document(b,'response')).compatible,widening);assert.equal(compareContracts(document(a),document(b)).compatible,false);assert.equal(compareContracts(document(b,'response'),document(a,'response')).compatible,false);}
 const b=document({type:'object',properties:{tag:{type:'object',properties:{leaf:{type:'integer'}}}},additionalProperties:false});const a=structuredClone(b);delete a.paths['/items'].post.requestBody.content['application/json'].schema.properties.tag.properties.leaf;
 assert.equal(compareContracts(b,a).compatible,true);assert.equal(compareContracts(a,b).compatible,false);
 const rb=document({$ref:'#/components/schemas/Node'});rb.components={schemas:{Node:{type:'object',properties:{next:{$ref:'#/components/schemas/Node'}},additionalProperties:false}}};
 const ra=structuredClone(rb);ra.components.schemas.Node.additionalProperties={type:'string'};assert.equal(compareContracts(rb,ra).compatible,true);assert.equal(compareContracts(ra,rb).compatible,false);assert.equal(compareContracts(rb,rb).compatible,true);
});
for(const c of regressions)test('review H1 regression: '+c.name,async()=>{
 const {compareContracts}=await import(enginePath);const b=document(c.before,c.mode),a=document(c.after,c.mode);
 assert.equal(accepts(c.before,c.payload,b),c.mode==='request');assert.equal(accepts(c.after,c.payload,a),c.mode==='response');
 assert.equal(compareContracts(b,a).compatible,false,'actual previously accepted payload loses the variance guarantee');
});
