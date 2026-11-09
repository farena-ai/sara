import assert from 'node:assert/strict';
import test from 'node:test';

export const base = () => ({ openapi: '3.0.3', info: { title: 'Synthetic API', version: '1' }, paths: { '/pets': { get: { responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } } } } } } } });
async function engine(): Promise<any> {
  let mod; try { mod = await import('../tools/developer-workbench/contract-diff.mjs'); } catch {}
  assert.ok(mod?.compareContracts, 'bounded semantic compare engine exists'); return mod;
}
test('semantic tracer: removed operation breaks; added operation is compatible with exact pointers', async () => {
  const { compareContracts } = await engine();
  const before = base(), after = base(); delete (after.paths['/pets'] as any).get;
  const r = compareContracts(before, after);
  assert.equal(r.compatible, false); assert.equal(r.complete, true);
  assert.deepEqual(r.findings, [{ code: 'operation-removed', severity: 'breaking', before: '/paths/~1pets/get', after: '/paths/~1pets' }]);
  const added = base(); (added.paths as any)['/health'] = { get: { responses: { '200': { description: 'OK' } } } };
  const a = compareContracts(base(), added); assert.equal(a.compatible, true);
  assert.ok(a.findings.some((f: any) => f.code === 'operation-added' && f.after === '/paths/~1health/get'));
  assert.deepEqual(compareContracts(before, after), r);
});
test('closed bounded validation refuses malformed, remote/executable refs, deep/large/non-JSON and unsupported semantics without echoing values', async () => {
  const { compareContracts } = await engine();
  const bad: any[] = [null, {}, { ...base(), openapi: '2.0' }, { ...base(), paths: [] }];
  const external = base(); (external as any).components = { schemas: { X: { $ref: 'https://private.example/SECRET_VALUE' } } }; bad.push(external);
  const executable = base(); (executable as any)['x-code'] = 'SECRET_VALUE'; bad.push(executable);
  const unsupported = base(); (unsupported.paths['/pets'].get.responses['200'].content['application/json'].schema as any).oneOf = []; bad.push(unsupported);
  const huge = base(); huge.info.title = 'x'.repeat(300000); bad.push(huge);
  const deep = base(); let o: any = deep; for (let i=0; i<50; i++) o = o.extra = {}; bad.push(deep);
  const nan = base(); (nan as any).n = NaN; bad.push(nan);
  for (const b of bad) assert.throws(() => compareContracts(b, base()), e => e instanceof Error && !e.message.includes('SECRET_VALUE'));
});
test('privacy, output amplification and optional response constraints fail closed', async () => {
 const {compareContracts}=await engine();
 const secret:any=base();secret.paths['/secret_TOKEN_VALUE'] = secret.paths['/pets'];delete secret.paths['/pets'];assert.throws(()=>compareContracts(secret,base()),/structural/);
 const old:any=base();old.paths['/pets'].get.responses['200'].content['application/json'].schema.required=[];const next=structuredClone(old);delete next.paths['/pets'].get.responses['200'].content['application/json'].schema.properties.id;
 assert.equal(compareContracts(old,next).compatible,false,'removing an optional response constraint allows incompatible returned values');
 const many:any=base();for(let i=0;i<140;i++)many.paths['/x'+i]={get:{responses:{'200':{description:'OK'}}}};
 assert.throws(()=>compareContracts(many,{...base(),paths:{}}),/budget/);
 const missing:any=base();missing.components={schemas:{X:{$ref:'#/components/schemas/Absent'}}};assert.throws(()=>compareContracts(missing,base()),/missing-local-ref/);
 const amplified:any=base();for(let i=0;i<100;i++)amplified.paths['/'+('segment/'.repeat(12))+i]={get:{responses:{'200':{description:'OK'}}}};assert.throws(()=>compareContracts(amplified,{...base(),paths:{}}),/output-budget/);
 const alias:any=base();alias.components={schemas:{A:{$ref:'#/components/schemas/B'},B:{$ref:'#/components/schemas/A'}}};assert.throws(()=>compareContracts(alias,base()),/cycle/);
});
test('request versus response variance, inherited parameters and recursive local references are compared semantically', async () => {
  const { compareContracts } = await engine();
  const req = () => { const d:any=base(); d.paths['/pets'].post = { requestBody: { content: { 'application/json': { schema: { type:'object', properties:{name:{type:'string',enum:['a','b']}}, required:[] } } } }, responses: {'204':{description:'OK'}} }; return d; };
  let a=req(), b=req(); b.paths['/pets'].post.requestBody.content['application/json'].schema.required=['name'];
  assert.ok(compareContracts(a,b).findings.some((f:any)=>f.code==='required-field-added' && f.severity==='breaking'));
  a=req(); b=req(); b.paths['/pets'].post.requestBody.content['application/json'].schema.properties.name.enum=['a'];
  assert.ok(compareContracts(a,b).findings.some((f:any)=>f.code==='enum-narrowed' && f.severity==='breaking'));
  const c:any=base(); c.paths['/pets'].parameters=[{in:'query',name:'limit',required:true,schema:{type:'integer'}}];
  assert.ok(compareContracts(base(),c).findings.some((f:any)=>f.code==='required-parameter-added'));
  const response:any=base(); response.paths['/pets'].get.responses['200'].content['application/json'].schema.required=[];
  assert.ok(compareContracts(base(),response).findings.some((f:any)=>f.code==='response-required-field-removed' && f.before.endsWith('/properties/id')));
  const changed:any=base(); changed.paths['/pets'].get.responses['200'].content['application/json'].schema.properties.id.type='string';
  assert.ok(compareContracts(base(),changed).findings.some((f:any)=>f.code==='type-incompatible'));
  const recursive:any=base(); recursive.components={schemas:{Node:{type:'object',properties:{next:{$ref:'#/components/schemas/Node'},name:{type:'string',enum:['a','b']}}}}};
  recursive.paths['/pets'].get.responses['200'].content['application/json'].schema={$ref:'#/components/schemas/Node'};
  const next=structuredClone(recursive); next.components.schemas.Node.properties.name.enum=['a','b','c'];
  const rr=compareContracts(recursive,next); assert.equal(rr.compatible,false); assert.ok(rr.findings.some((f:any)=>f.code==='response-enum-widened' && f.after.startsWith('/components/schemas/Node')));
  assert.equal(compareContracts(recursive,recursive).compatible,true);
  const optional=req(); optional.paths['/pets'].post.requestBody.content['application/json'].schema.properties.extra={type:'boolean'};
  assert.equal(compareContracts(req(),optional).compatible,false,'an optional named schema restricts the old unconstrained fallback');
  const closed=req(); closed.paths['/pets'].post.requestBody.content['application/json'].schema.additionalProperties=false;
  const closedAdded=structuredClone(closed); closedAdded.paths['/pets'].post.requestBody.content['application/json'].schema.properties.extra={type:'boolean'};
  assert.equal(compareContracts(closed,closedAdded).compatible,true,'adding an optional field to a closed request object widens acceptance');
});
