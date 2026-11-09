import test from 'node:test';import assert from 'node:assert/strict';import {audit} from '../store/plugins/accessibility-auditor/audit.mjs';
import {readFileSync} from 'node:fs';
import {audit as sourceAudit} from '../tools/developer-accessibility-auditor/audit-source.mjs';
test('AA02 author-named subtrees are present or explicitly uncertain, never certain absence',()=>{
 const cases=['<button aria-labelledby="n"></button><img id="n" aria-label="Save">','<button aria-labelledby="n"></button><span id="n" aria-label="Save"></span>','<span id="n" title="Save"></span><button aria-labelledby="n"></button>','<label><img aria-label="Name"><input></label>','<label><span title="Name"></span><input></label>','<button><span aria-label="Save"></span></button>'];
 for(const body of cases){for(const run of [audit,sourceAudit]){const r=run({html:doc(body)});assert.deepEqual(r.findings,[]);assert.equal(r.coverage,'requires-browser');assert.ok(r.unsupported.includes('author-named-subtree'));}}
});
test('AA02 valid empty references take precedence; visible referenced roots exclude hidden descendants',()=>{
 for(const body of ['<span id="n"></span><button aria-labelledby="n">Save</button>','<span id="n"><span hidden>Save</span></span><button aria-labelledby="n"></button>']){
  const r=audit({html:doc(body)});assert.deepEqual(r.findings,[]);assert.equal(r.coverage,'requires-browser');assert.ok(r.unsupported.includes('empty-name-reference'));
 }
 assert.deepEqual(audit({html:doc('<span hidden id="n"><span hidden>Save</span></span><button aria-labelledby="n"></button>')}).findings,[]);
});
test('source and bundled results agree for independent ASCII, NBSP, precedence and uncertainty matrix',()=>{
 const parts=['<button></button>','<label><img title="Name"><input></label>','<span id="\u00a0a">N</span><button aria-labelledby="\u00a0a"></button>','<span id="n"></span><button aria-labelledby="n" aria-label="ignored"></button>'];
 for(const body of parts)assert.deepEqual(audit({html:doc(body)}),sourceAudit({html:doc(body)}));
});
const doc=(s:string)=>'<!doctype html><html lang="en"><title>Owned</title><body>'+s+'</body></html>';
test('all 23 independent review witnesses agree source versus bundle',()=>{const cases=JSON.parse(readFileSync(new URL('./fixtures/developer/accessibility-auditor/review-cases.json',import.meta.url),'utf8'));assert.equal(cases.length,23);for(const c of cases)assert.deepEqual(audit({html:doc(c.body)}),sourceAudit({html:doc(c.body)}),c.id);});
test('AA01 IDREF lists split only HTML ASCII whitespace; exact for and IDs are preserved',()=>{
 for(const id of ['\u00a0a','a\u00a0','a\u00a0b']){const r=audit({html:doc(`<span id="${id}">Name</span><button aria-labelledby=" \t\n\f\r${id}\r\f\n\t "></button><label for="${id}">Name</label><input id="${id}x" aria-label="Name">`)});assert.deepEqual(r.findings,[]);}
 assert.deepEqual(audit({html:doc('<span id="a">A</span><span id="b">B</span><button aria-labelledby=" \ta\nb\fa\rb a "></button>')}).findings,[]);
 // Single-ID HTML for must not be trimmed, including ASCII boundary spaces.
 assert.deepEqual(audit({html:doc('<label for=" x ">Name</label><input id=" x ">')}).findings,[]);
 assert.equal(audit({html:doc('<label for=" x ">Name</label><input id="x">')}).findings[0]?.rule,'control-label-missing');
});
