import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
for(const bad of ['{',JSON.stringify({lockfileVersion:1}),JSON.stringify({lockfileVersion:3,packages:{}})]) test('npm analyzers reject malformed/unsupported lock '+bad.slice(0,18),async()=>{
 for(const id of ['license-auditor','sbom-builder']) {const {handle}=await import(`../store/plugins/${id}/workflow.mjs`);await assert.rejects(()=>handle(id==='sbom-builder'?{lock:bad}:{lock:bad,metadata:[],policy:{allow:[],deny:[]}}));}
});
test('SBOM rejects links, traversal, malformed SRI and oversized inventory',async()=>{
 const {build}=await import('../store/plugins/sbom-builder/engine.mjs');
 for(const extra of [{'node_modules/link':{version:'1.0.0',link:true}},{'../escape':{version:'1.0.0'}},{'node_modules/bad':{version:'1.0.0',integrity:'sha256-bad'}},Object.fromEntries(Array.from({length:61},(_,i)=>['node_modules/p'+i,{version:'1.0.0'}]))]) assert.throws(()=>build({lock:JSON.stringify({...fixture,packages:{...fixture.packages,...extra}})}));
});
test('license unknown, custom, malformed expressions stay review or unknown without source echo',async()=>{
 const {audit}=await import('../store/plugins/license-auditor/engine.mjs');
 for(const expression of ['LicenseRef-custom','MIT AND','not-a-real-license']) {
  const r=audit({lock:JSON.stringify(fixture),metadata:[{path:'node_modules/a',expression}],policy:{allow:['MIT'],deny:[]}});
  assert.equal(r.packages.find((p:any)=>p.name==='a').decision,'review');
 }
 assert.throws(()=>audit({lock:JSON.stringify(fixture),metadata:[{path:'outside',expression:'MIT'}],policy:{allow:[],deny:[]}}));
});
test('scanner detects AWS/private-key/bearer and visibly refuses amplified or invalid requests',async()=>{
 const {handle}=await import('../store/plugins/secret-scanner/workflow.mjs');
 const text=[['AK','IA','A'.repeat(16)].join(''),['-----BEGIN ','PRIVATE KEY-----'].join(''),'Bearer '+ 'B'.repeat(24)].join('\n');
 const r=JSON.parse((await handle({files:[{path:'fixture.txt',text}]})).content);
 assert.deepEqual(r.findings.map((f:any)=>f.detector),['aws-access-key','private-key','bearer-token']);
 for(const files of [[{path:'x',text:'password=x\n'.repeat(121)}],[{path:'x',text:'a'.repeat(32769)}],Array(13).fill({path:'x',text:''}),[{path:'bad\u0000path',text:''}]]) await assert.rejects(()=>handle({files}));
 assert.equal(JSON.parse((await handle({files:[{path:'empty.txt',text:''}]})).content).findings.length,0);
});
test('provenance performs actual SHA256 + Ed25519 and rejects tamper, wrong key and identity', async () => {
 const {verifyArtifact,signingPayload}=await import('../store/plugins/artifact-provenance-verifier/engine.mjs');
 const keys=generateKeyPairSync('ed25519'), other=generateKeyPairSync('ed25519');
 const artifact=Buffer.from('synthetic artifact bytes');
 const digest=createHash('sha256').update(artifact).digest('hex');
 const identity='synthetic/release@1.0.0';
 const args={algorithm:'ed25519',artifactBase64:artifact.toString('base64'),sha256:digest,identity,expectedIdentity:identity,publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),expectedKeySha256:createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex'),signatureBase64:sign(null,signingPayload(identity,digest),keys.privateKey).toString('base64')};
 assert.equal(verifyArtifact(args).verified,true);
 for(const change of [{artifactBase64:Buffer.from('tamper').toString('base64')},{identity:'other/identity'},{expectedIdentity:'different'},{expectedKeySha256:'0'.repeat(64)},{publicKeyPem:other.publicKey.export({type:'spki',format:'pem'}).toString()},{signatureBase64:Buffer.alloc(64).toString('base64')}]) assert.equal(verifyArtifact({...args,...change}).verified,false);
 assert.throws(()=>verifyArtifact({...args,algorithm:'rsa'}));
});
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
for(const version of [2,3]) test(`npm-generated lock v${version}: actual nested versions, SPDX audit and schema-valid CycloneDX output`,async()=>{
 const lock=readFileSync(new URL(`./fixtures/developer/security/npm-generated-v${version}.json`,import.meta.url),'utf8');
 const {build}=await import('../store/plugins/sbom-builder/engine.mjs');const {audit}=await import('../store/plugins/license-auditor/engine.mjs');
 const r=build({lock});assert.equal(validateBom(r.bom),true,JSON.stringify(validateBom.errors));
 assert.equal(r.bom.components.length,4);assert.deepEqual(r.bom.components.filter((c:any)=>c.name==='is-number').map((c:any)=>c.version).sort(),['6.0.0','7.0.0']);
 assert.ok(r.bom.components.every((c:any)=>c.hashes[0].alg==='SHA-512'&&c.hashes[0].content.length===128));
 assert.equal(r.bom.components.find((c:any)=>c.group==='@types').purl,'pkg:npm/%40types/estree@1.0.6');
 assert.ok(audit({lock,metadata:[],policy:{allow:['MIT'],deny:[]}}).packages.every((p:any)=>p.decision==='allowed'));
 const out=new URL('../outputs/developer-addons/security/',import.meta.url);mkdirSync(out,{recursive:true});writeFileSync(new URL(`npm-generated-v${version}.cdx.json`,out),JSON.stringify(r.bom,null,2)+'\n');
});
test('UTF8 output amplification refuses explicitly instead of host-clipping JSON',async()=>{
 const {handle}=await import('../store/plugins/secret-scanner/workflow.mjs');
 await assert.rejects(()=>handle({files:[{path:'界'.repeat(160),text:'password=small\n'.repeat(120)}]}));
});
import { Ajv } from '../tools/developer-security/node_modules/ajv/dist/ajv.js';
const bomSchema=JSON.parse(readFileSync(new URL('../tools/developer-security/bom-1.5.schema.json',import.meta.url),'utf8'));
const spdxSchema=JSON.parse(readFileSync(new URL('../tools/developer-security/spdx.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false,validateFormats:false});
ajv.addSchema(spdxSchema);
ajv.addSchema(JSON.parse(readFileSync(new URL('../tools/developer-security/jsf-0.82.schema.json',import.meta.url),'utf8')));
const validateBom=ajv.compile(bomSchema);
test('SBOM emits deterministic CycloneDX1.5 nested/scoped inventory passing official schema', async () => {
 const {build}=await import('../store/plugins/sbom-builder/engine.mjs');
 for(const version of [2,3]) {
  const lock={...fixture,lockfileVersion:version};
  const report=build({lock:JSON.stringify(lock)});
  assert.deepEqual(report,build({lock:JSON.stringify(lock)}));
  assert.equal(validateBom(report.bom),true,JSON.stringify(validateBom.errors));
  assert.equal(report.bom.components.length,4);
  assert.equal(new Set(report.bom.components.map((x:any)=>x['bom-ref'])).size,4);
  const c=report.bom.components.find((x:any)=>x.group==='@demo');
  assert.equal(c.purl,'pkg:npm/%40demo/c@3.0.0');
  assert.deepEqual(c.hashes,[{alg:'SHA-256',content:'0'.repeat(64)}]);
 }
 assert.equal(validateBom({bomFormat:'CycloneDX',specVersion:'1.5',version:1,components:[{type:'library'}]}),false);
});
test('all standalone SDK copies and bundled npm parsers are byte-identical; schemas are executable/closed',async()=>{
 const sdk=readFileSync(new URL('../examples/plugins/sara-plugin.mjs',import.meta.url));
 for(const id of ['secret-scanner','license-auditor','sbom-builder','artifact-provenance-verifier']) {
  assert.ok(sdk.equals(readFileSync(new URL(`../store/plugins/${id}/sara-plugin.mjs`,import.meta.url))));
  const {parameters}=await import(`../store/plugins/${id}/workflow.mjs`);
  const validate=ajv.compile(parameters);assert.equal(validate({unexpected:true}),false);
  function closed(s:any) {if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(Object.keys(s.properties).sort(),[...s.required].sort());Object.values(s.properties).forEach(closed);}if(s.type==='array')closed(s.items);}
  closed(parameters);
 }
 assert.ok(readFileSync(new URL('../store/plugins/license-auditor/npm-lock.mjs',import.meta.url)).equals(readFileSync(new URL('../store/plugins/sbom-builder/npm-lock.mjs',import.meta.url))));
});
test('provenance rejects noncanonical encodings, malformed keys, non-Ed25519 keys and oversize payloads',async()=>{
 const {verifyArtifact}=await import('../store/plugins/artifact-provenance-verifier/engine.mjs');
 // @ts-expect-error Pure synthetic-fixture generator.
 const {fixtureArgs}=await import('../tools/developer-security/fixtures.mjs');const args=fixtureArgs('artifact-provenance-verifier');
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
 for(const change of [{artifactBase64:'YQ'},{publicKeyPem:'not a public key'},{signatureBase64:'Z'.repeat(88)},{artifactBase64:Buffer.alloc(32770).toString('base64')},{publicKeyPem:rsa.publicKey.export({type:'spki',format:'pem'}).toString()},{sha256:'A'.repeat(64)}]) assert.throws(()=>verifyArtifact({...args,...change}));
});
const fixture = JSON.parse(readFileSync(new URL('./fixtures/developer/security/package-lock-v3.json',import.meta.url),'utf8'));

test('license policy follows npm nested paths and actual SPDX AND/OR/WITH semantics', async () => {
  const { audit } = await import('../store/plugins/license-auditor/engine.mjs');
  const result=audit({lock:JSON.stringify(fixture),metadata:[{path:'node_modules/a',expression:'MIT OR GPL-3.0-only'},{path:'node_modules/a/node_modules/b',expression:'MIT AND GPL-3.0-only'},{path:'node_modules/@demo/c',expression:'GPL-2.0-only WITH Classpath-exception-2.0'}],policy:{allow:['MIT','GPL-2.0-only WITH Classpath-exception-2.0'],deny:['GPL-3.0-only']}});
  assert.deepEqual(result.packages.map((p:any)=>[p.path,p.decision]),[['node_modules/@demo/c','allowed'],['node_modules/a','allowed'],['node_modules/a/node_modules/b','denied'],['node_modules/unknown','unknown']]);
  assert.equal(audit({lock:JSON.stringify(fixture),metadata:[],policy:{allow:[],deny:[]}}).packages[0].decision,'review');
  assert.throws(()=>audit({lock:'{}',metadata:[],policy:{allow:[],deny:[]}}));
});

test('license policy canonicalizes atomic rules and deny wins over allow',async()=>{
 const {audit}=await import('../store/plugins/license-auditor/engine.mjs');
 const result=audit({lock:JSON.stringify(fixture),metadata:[],policy:{allow:[' MIT '],deny:[]}});
 assert.equal(result.packages.find((p:any)=>p.name==='a').decision,'allowed');
 const denied=audit({lock:JSON.stringify(fixture),metadata:[],policy:{allow:['MIT'],deny:['MIT']}});
 assert.equal(denied.packages.find((p:any)=>p.name==='a').decision,'denied');
});
test('secret values repeated in a different file path are redacted, not hashed',async()=>{
 const {scan}=await import('../store/plugins/secret-scanner/engine.mjs');
 const r=scan({files:[{path:'config.env',text:'password=tiny'},{path:'tiny/source.env',text:'token=other'}]});
 assert.ok(!JSON.stringify(r).includes('tiny'));
 assert.equal(r.findings[1].path,'[redacted-path]');
});
test('secret scanner finds supplied multiline credentials without exposing values or their hashes', async () => {
  const { scan } = await import('../store/plugins/secret-scanner/engine.mjs');
  const token = ['gh','p_', 'Q'.repeat(36)].join('');
  const low = 'tiny';
  const files = [{path:'src/config.env',text:`ok\nTOKEN=${token}\npassword=${low}\n`}];
  const report = scan({files});
  assert.ok(report.findings.some((f:any)=> f.detector==='github-token' && f.line===2 && f.path==='src/config.env'));
  assert.ok(report.findings.some((f:any)=>f.detector==='credential-assignment' && f.line===3));
  assert.deepEqual(scan({files}),report);
  const output=JSON.stringify(report);
  for(const value of [token, low, createHash('sha256').update(low).digest('hex')]) assert.ok(!output.includes(value));
  assert.ok(report.findings.every((f:any)=> /^[a-f0-9]{64}$/.test(f.id)));
});
