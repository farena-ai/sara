import test from 'node:test';import assert from 'node:assert/strict';import {audit} from '../store/plugins/accessibility-auditor/audit.mjs';
const doc=(s:string)=>'<!doctype html><html lang="en"><title>Owned</title><body>'+s+'</body></html>';
test('implicit native label associates only first labelable descendant; hidden referenced label text counts',()=>{
 const r=audit({html:doc('<label>Name<input><input></label><label hidden for="x">Hidden name</label><input id="x"><label><button>Action</button><input></label>')});
 const controls=r.findings.filter(f=>f.rule==='control-label-missing');assert.equal(controls.length,2);assert.deepEqual(controls.map(f=>f.element.offset),[doc('<label>Name<input>').length-'</body></html>'.length,doc('<label>Name<input><input></label><label hidden for="x">Hidden name</label><input id="x"><label><button>Action</button>').length-'</body></html>'.length]);
});
test('hard bounds and coordinate oracle cover CRLF Unicode, duplicate/ref privacy, array/object traps and no mutation',()=>{
 let calls=0;for(const key of ['toJSON','other']){const x:any={html:doc('')};Object.defineProperty(x,key,{get(){calls++;return ()=>{calls++;};}});assert.throws(()=>audit(x));}assert.equal(calls,0);
 const a:any={html:doc('')};a[Symbol('hidden')]=1;assert.throws(()=>audit(a));assert.throws(()=>audit(Object.create({html:doc('')})));
 const html='<!doctype html>\r\n<html lang="en"><title>😀</title><body>\r\n<img src="SECRET_URL"><div id="PRIVATE_ID"></div><div id="PRIVATE_ID"></div><button aria-controls="SECRET_REF">Name</button></body></html>';
 const input=Object.freeze({html}),r=audit(input);for(const f of r.findings){assert.equal(html[f.element.offset],'<');assert.ok(html.slice(f.element.offset,f.element.endOffset).startsWith('<'+f.element.tag));const before=html.slice(0,f.element.offset),lines=before.split(/\r\n|\r|\n/);assert.equal(f.element.line,lines.length);assert.equal(f.element.column,lines.at(-1)!.length+1);}assert.ok(!JSON.stringify(r).match(/SECRET|PRIVATE/));assert.equal(input.html,html);
 const cases=[doc('<p>'+'x'.repeat(5800)+'</p>'),doc('<b></b>'.repeat(70)),doc('<label for="x">Name</label><input id="x">'),doc('<button aria-labelledby="hidden">Name</button><span hidden id="hidden">Referenced</span>')];for(const html of cases){const r=audit({html});assert.ok(r.findings.length<=64);assert.ok(Buffer.byteLength(JSON.stringify(r))<=20000);}
});
