import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const engine=new URL('../store/plugins/accessibility-auditor/audit.mjs',import.meta.url);
test('HTML5 AST missing-alt evidence identifies actual element without leaking attributes',async()=>{
 assert.ok(existsSync(engine),'HTML5 structural auditor implemented');
 const {audit}=await import(engine.href);
 const html='<!doctype html>\n<html lang="en"><title>Owned</title><body><img src="PRIVATE_CANARY"></body></html>';
 const r=audit({html});
 assert.equal(r.mode,'static-structural');assert.equal(r.findings.length,1);
 assert.equal(r.findings[0].rule,'img-alt-missing');
 const e=r.findings[0].element;assert.equal(e.tag,'img');assert.equal(e.line,2);assert.equal(html.slice(e.offset,e.endOffset),'<img src="PRIVATE_CANARY">');assert.ok(e.ordinal>0);assert.equal(e.column,e.offset-html.indexOf('\n'));
 assert.match(r.sourceSha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(r).includes('PRIVATE_CANARY'));
});
