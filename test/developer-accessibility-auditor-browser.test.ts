import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';import {createHash} from 'node:crypto';
import {audit} from '../store/plugins/accessibility-auditor/audit.mjs';
import {recordedEvidence} from '../tools/developer-accessibility-auditor/recorded-evidence.mjs';
test('recorded independent axe/sandboxed Chromium observations agree with current offline semantics (not a fresh capture)',()=>{
 const path=new URL('./fixtures/developer/accessibility-auditor/recorded-browser-evidence.json',import.meta.url);assert.ok(existsSync(path),'public actual recorded browser fixture exists without private outputs');const recorded=JSON.parse(readFileSync(path,'utf8'));assert.equal(recorded.kind,'recorded-owned-browser-observations');assert.equal(recorded.freshCapture,false);const r=recorded.evidence;assert.equal(r.playwright,'1.62.1');assert.equal(r.axe,'4.10.3');assert.equal(r.sandbox,true);assert.equal(r.requests,0);assert.equal(r.browserClosed,true);assert.equal(r.contextsClosed,22);assert.equal(r.records.length,4);
 const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
 assert.equal(recorded.schemaVersion,1);assert.match(recorded.provenance.sourceEvidenceSha256,/^[a-f0-9]{64}$/);
 for(const [key,name] of [['captureSourceSha256','capture-owned.mjs'],['projectionSourceSha256','recorded-evidence.mjs']]){assert.equal(recorded.provenance[key],r[key]);assert.equal(r[key],hash(readFileSync(new URL('../tools/developer-accessibility-auditor/'+name,import.meta.url))));}
 assert.equal(r.namingCasesSha256,hash(readFileSync(new URL('./fixtures/developer/accessibility-auditor/naming-cases.json',import.meta.url))));
 const cases=JSON.parse(readFileSync(new URL('./fixtures/developer/accessibility-auditor/naming-cases.json',import.meta.url),'utf8'));
 assert.equal(new Set(r.namingRecords.map((n:any)=>n.viewport+'/'+n.id)).size,18);
 for(const n of r.namingRecords){const c=cases.find((c:any)=>c.id===n.id);assert.ok(c);assert.equal(n.html,'<!doctype html><html lang="en"><title>Owned naming oracle</title><body>'+c.body+'</body></html>');assert.equal(n.oracle.accessibleText,c.name);}
 // Inject private canaries at every object depth: only explicit schema fields survive.
 const contaminated=structuredClone(r);function poison(value:any){if(Array.isArray(value)){value.forEach(poison);}else if(value&&typeof value==='object'){Object.values(value).forEach(poison);Object.assign(value,{processID:123,profilePath:'private-profile-canary',modulePath:'private-module-canary',logs:{private:'private-log-canary'}});}}poison(contaminated);
 assert.deepEqual(recordedEvidence(JSON.stringify(contaminated)).evidence,r);assert.throws(()=>recordedEvidence(JSON.stringify({...r,browserClosed:false})));
 assert.equal(r.namingRecords.length,18);for(const n of r.namingRecords){assert.deepEqual(audit({html:n.html}),n.structural);assert.equal(n.sourceSha256,createHash('sha256').update(n.html).digest('hex'));assert.ok(n.ariaSnapshot.startsWith('- '));}
 for(const record of r.records){const html=readFileSync(new URL(`./fixtures/developer/accessibility-auditor/${record.variant}.html`,import.meta.url),'utf8');assert.equal(record.sourceSha256,createHash('sha256').update(html).digest('hex'));const actual=audit({html});assert.deepEqual(record.structural,actual.findings);assert.equal(record.matches.length,record.variant==='candidate'?4:0);for(const m of record.matches){assert.ok(actual.findings.some((f:any)=>f.rule===m.rule&&f.element.ordinal===m.ordinal));assert.ok(m.axeTargetVerified);if(m.rule!=='document-lang-missing'){assert.ok(m.rect.width>0);assert.ok(m.rect.height>0);assert.equal(m.visible,true);}assert.equal(m.tag,actual.findings.find((f:any)=>f.element.ordinal===m.ordinal)?.element.tag);}
 }
});
