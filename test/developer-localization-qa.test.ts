import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Standalone pure JavaScript module.
import {analyze, catalog, tokens} from '../store/plugins/localization-qa/engine.mjs';
test('compares decoded flat catalogs without echoing source keys or values; layout remains unmeasured',()=>{
 const r=analyze({base:'{"welcome":"Hi {name}","absent":"Private value"}',target:'{"welcome":"Hola {other}","extra":"Secret"}',grammar:'named-v1'});
 assert.equal(r.status,'findings');assert.equal(r.layout,'not-measured');
 assert.deepEqual(r.findings.map((f:any)=>f.kind),['missing-key','extra-key','interpolation']);
 assert.ok(!JSON.stringify(r).includes('welcome'));assert.ok(!JSON.stringify(r).includes('Private'));
});
test('rejects duplicate decoded catalog keys before materialization, flat strings only',()=>{
 for(const raw of ['{"a":"first","\\u0061":"last"}','{"__proto__":"x"}','{"a":{}}','[]','null','{}','{"a":"x",}','{"a":1}','{"a":"x"} trailing'])assert.throws(()=>catalog(raw));
 assert.deepEqual(Object.keys(catalog('{"a\\\"b":"x","emoji":"😀"}')),['a"b','emoji']);
});
test('closed named grammar respects multiplicity, backslash escaping and placeholder types, rejects ICU',()=>{
 assert.deepEqual(tokens(String.raw`literal \{name\} \\ {name} {n:number} {name:string}`),['n:number','name:string','name:string']);
 for(const text of ['{n, plural, one {a} other {b}}','{{name}}','{x:date}','{x','x}','\\q','{x:number:other}'])assert.throws(()=>tokens(text));
 for(const [a,b] of [['{x}{x}','{x}'],['{x:number}','{x}'],['{x}',String.raw`\{x\}`]])assert.equal(analyze({base:JSON.stringify({a}),target:JSON.stringify({a:b}),grammar:'named-v1'}).findings[0].kind,'interpolation');
 assert.throws(()=>analyze({base:'{"a":"{n, plural, other {x}}"}',target:'{"b":"valid"}',grammar:'named-v1'}));
});
