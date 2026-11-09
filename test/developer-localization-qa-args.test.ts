import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {checkArgs} from '../src/plugins/manager.ts';
// @ts-expect-error Standalone JS.
import {analyze} from '../store/plugins/localization-qa/engine.mjs';
// @ts-expect-error Standalone workflow.
import {parameters,handle} from '../store/plugins/localization-qa/workflow.mjs';
const request=(value:string,n=23)=>{const raw=JSON.stringify(Object.fromEntries(Array.from({length:n},(_,i)=>['q'+i,value])));return {base:raw,target:raw,grammar:'named-v1'};};
test('D1 reviewer quote witness must REFUSE, matching actual manager argument cap',()=>{
 const args=request('"'.repeat(512));assert.equal(args.base.length,23750);assert.equal(JSON.stringify(args).length,94832);assert.equal(checkArgs(parameters,args),'the arguments are too large');assert.throws(()=>analyze(args));assert.throws(()=>handle(args));
});
test('real checkArgs and analyzer agree exactly at 65536/65537 serialized UTF-16 units across escaping, Unicode and optional evidence',()=>{
 const captured=JSON.parse(readFileSync('test/fixtures/developer/localization-qa/captured-input.json','utf8'));
 for(const literal of ['ASCII','"','/','\\\\','\n\t\u0000','é😀'])for(const measured of [false,true]){
  const value='"'.repeat(360)+literal.repeat(8);
  const args:any=measured?structuredClone(captured):request(value,1);
  // Legal JSON trailing whitespace pads raw catalogs without changing decoded values or evidence geometry.
  // Large quote catalogs cover escaping amplification; padding targets the exact total envelope.
  if(measured){const common=JSON.parse(args.base);for(let i=0;i<18;i++)common['extra'+i]=value;args.base=JSON.stringify(common);const target=JSON.parse(args.target);for(let i=0;i<18;i++)target['other'+i]=value;args.target=JSON.stringify(target);
   // Only original common keys have measurements; added baseline-only keys need no rows, but shift refs.
   const keys=Object.keys(common).sort(),oldKeys=Object.keys(JSON.parse(captured.base)).sort();for(const row of args.evidence.rows)row.ref='k'+String(keys.indexOf(oldKeys[Number(row.ref.slice(1))-1])+1).padStart(3,'0');
  }else{Object.assign(args,request(value,18));}
  // Extend with raw whitespace; both catalogs must stay within their independent UTF-8 budgets.
  const missing=65536-JSON.stringify(args).length;
  assert.ok(missing>=0);
  const baseRoom=23999-Buffer.byteLength(args.base),targetRoom=23999-Buffer.byteLength(args.target);
  assert.ok(missing<=baseRoom+targetRoom);
  const b=Math.min(baseRoom,missing);args.base+=' '.repeat(b);args.target+=' '.repeat(missing-b);
  if(measured){ // Evidence binds the exact raw inputs, including whitespace.
   const {createHash}=requireCrypto;args.evidence.baseSha=createHash('sha256').update(args.base).digest('hex');args.evidence.targetSha=createHash('sha256').update(args.target).digest('hex');
  }
  assert.equal(JSON.stringify(args).length,65536);assert.equal(checkArgs(parameters,args),undefined);assert.doesNotThrow(()=>analyze(args));
  args.target+=' ';assert.equal(JSON.stringify(args).length,65537);assert.equal(checkArgs(parameters,args),'the arguments are too large');assert.throws(()=>analyze(args));
 }
});
import * as requireCrypto from 'node:crypto';
test('valid Unicode 25690 UTF-16 units / 33882 UTF-8 bytes stays host-usable',()=>{
 const args={base:JSON.stringify(Object.fromEntries(Array.from({length:32},(_,i)=>['base'+i,'x'.repeat(512)]))),target:JSON.stringify(Object.fromEntries(Array.from({length:32},(_,i)=>['target'+i,'😀'.repeat(128)]))),grammar:'named-v1'};
 assert.equal(JSON.stringify(args).length,25690);assert.equal(Buffer.byteLength(JSON.stringify(args)),33882);assert.equal(checkArgs(parameters,args),undefined);assert.equal(analyze(args).findings.length,64);
});
