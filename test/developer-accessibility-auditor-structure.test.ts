import test from 'node:test';import assert from 'node:assert/strict';
import {audit} from '../store/plugins/accessibility-auditor/audit.mjs';
const doc=(s:string,attrs='lang="en"')=>'<!doctype html><html '+attrs+'><head><title>Owned</title></head><body>'+s+'</body></html>';
const rules=(s:string)=>audit({html:doc(s)}).findings.map((f:any)=>f.rule);
test('closed structural rules derive lang/name/id/ref evidence and preserve positives',()=>{
 const r=audit({html:doc('<img><button></button><input><div id="x"></div><p id="x"></p><button aria-labelledby="missing"></button>','')});
 assert.deepEqual(new Set(r.findings.map((f:any)=>f.rule)),new Set(['document-lang-missing','img-alt-missing','button-name-missing','control-label-missing','id-duplicate','aria-ref-missing']));
 assert.deepEqual(rules('<img alt=""><img role="presentation"><img aria-label="Picture"><button>Save</button><input id="a"><label for="a">Name</label><label>Other<input></label><button aria-labelledby="n"></button><p id="n">Name</p><input title="Name">'),[]);
});
test('hidden inert template suppression; ARIA name preference and duplicates do not manufacture missing names',()=>{
 assert.deepEqual(rules('<div hidden><img><button></button><input></div><div inert><img></div><div aria-hidden="true"><input></div><template><img></template><input type="hidden">'),[]);
 assert.deepEqual(rules('<button aria-labelledby="n" aria-label="Fallback"></button><p id="n">Name</p>'),[]);
 assert.deepEqual(rules('<label for="x">Name</label><input id="x"><input id="x">'),['id-duplicate','id-duplicate']);
 const r=audit({html:doc('<div id="a">Name</div><div id="a">Other</div><button aria-labelledby="a"></button>')});
 assert.ok(r.findings.some((f:any)=>f.rule==='aria-ref-ambiguous'));assert.ok(!r.findings.some((f:any)=>f.rule==='button-name-missing'));assert.equal(r.coverage,'requires-browser');
});
test('CSS script shadow foreign unknown naming semantics cannot produce an all-pass or certain rendered claim',()=>{
 for(const s of ['<style>img{display:none}</style><img>','<script>void 0</script><button></button>','<template shadowrootmode="open"><img></template>','<svg><title>Picture</title></svg>','<x-control></x-control>','<button><canvas></canvas></button>']){
 const r=audit({html:doc(s)});assert.equal(r.coverage,'requires-browser');assert.ok(r.unsupported.length);assert.ok(r.findings.every((f:any)=>f.status==='static-finding'));
 }
});
test('actual HTML5 tree order, entities and raw text are parsed rather than scanned',()=>{
 const html=doc('<table><img alt="ok"><tr><td>&lt;img&gt;</td></tr></table><!-- <img> --><script type="text/plain">"<img>"</script>');
 assert.deepEqual(audit({html}).findings,[]);
});
test('atomic resource/input admission rejects callbacks before they execute and output amplification',()=>{
 let calls=0;const hostile:any={};Object.defineProperty(hostile,'html',{get(){calls++;return doc('<img>');}});assert.throws(()=>audit(hostile));assert.equal(calls,0);
 const a:any=[];Object.defineProperty(a,'toJSON',{value(){calls++;return {};}});assert.throws(()=>audit(a));assert.equal(calls,0);
 for(const args of [{html:doc(''),extra:'PRIVATE_CANARY'},{html:'x'.repeat(6001)},{html:doc('<div>'.repeat(40)+'<img>'+'</div>'.repeat(40))},{html:doc('<img>'.repeat(150))},{html:doc('<i></i>'.repeat(520))},null])assert.throws(()=>audit(args));
 const r=audit({html:doc('<img>'.repeat(32))});assert.ok(Buffer.byteLength(JSON.stringify(r))<16000);assert.ok(!JSON.stringify(r).includes('all-pass'));
});
