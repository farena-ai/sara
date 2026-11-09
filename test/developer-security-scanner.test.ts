import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {scan} from '../store/plugins/secret-scanner/engine.mjs';

test('Unicode escape variants and single-quote escapes withhold all paths',()=>{
 for(const text of ['{"password":"\\u0074iny"}',"'api_key'='it\\'s secret'",'{"api_key":"\\uD83D\\uDD11"}']) {
  const report=scan({files:[{path:'ordinary.json',text},{path:'%74iny/file',text:'token=other'}]});
  assert.equal(report.findings.length,2);assert.ok(report.findings.every((f:any)=>f.path==='[redacted-path]'));
 }
});

test('quoted finding and UTF8 input caps refuse without partial results',()=>{
 assert.equal(scan({files:[{path:'x',text:'"password":"tiny"\n'.repeat(120)}]}).findings.length,120);
 assert.throws(()=>scan({files:[{path:'x',text:'"password":"tiny"\n'.repeat(121)}]}),{message:'limit'});
 assert.throws(()=>scan({files:[{path:'x',text:'界'.repeat(32768)}]}),{message:'input'});
});

test('private-key bodies never echo through repeated paths',()=>{
 const body='synthetic-private-body';
 const text='-----BEGIN PRIVATE KEY-----\n'+body+'\n-----END PRIVATE KEY-----';
 const report=scan({files:[{path:'key.pem',text},{path:body+'/file',text:'password=other'}]});
 assert.ok(!JSON.stringify(report).includes(body));assert.ok(report.findings.every((f:any)=>f.path==='[redacted-path]'));
});

test('quoted JSON password and api_key produce two value-free findings',()=>{
 const values=['synthetic-review-password','synthetic-review-key'];
 const report=scan({files:[{path:'config.json',text:JSON.stringify({password:values[0],api_key:values[1]})}]});
 assert.deepEqual(report.findings.map((f:any)=>f.detector),['credential-assignment','credential-assignment']);
 for(const value of values) assert.ok(!JSON.stringify(report).includes(value));
});

test('quoted spaces, JSON escapes and Unicode redact decoded/raw/encoded cross-file paths',()=>{
 for(const value of ['two words, with } punctuation','quote"slash\\tail','caf\u00e9\u754c','line\nsecret','tiny']) {
  const raw=JSON.stringify(value).slice(1,-1);
  for(const path of [value.replace(/\n/g,'_')+'/file',raw+'/file',encodeURIComponent(value)+'/file']) {
   const report=scan({files:[{path:'config.json',text:JSON.stringify({password:value})},{path,text:'token=other'}]});
   const serialized=JSON.stringify(report);
   assert.equal(report.findings.length,2);
   assert.equal(report.findings[1].path,'[redacted-path]');
   for(const secret of [value,raw,encodeURIComponent(value),createHash('sha256').update(value).digest('hex')]) assert.ok(!serialized.includes(secret),'value-free result');
  }
 }
});

test('matching quote styles, bare assignments, CRLF and JSON closing punctuation preserve coordinates',()=>{
 const text='{"password":"alpha"}\r\n\'api_key\': \'two words\'\rTOKEN=bare}\r\n{"api_key":unquoted}';
 const report=scan({files:[{path:'config.txt',text}]});
 assert.deepEqual(report.findings.map((f:any)=>[f.line,f.column]),[[1,2],[2,1],[3,1],[4,2]]);
 const repeated=scan({files:[{path:'config.json',text:'{"password":unquoted}'},{path:'unquoted/file',text:'token=other'}]});
 assert.equal(repeated.findings[1].path,'[redacted-path]');
 for(const text of ['"password\': "mismatch"',"'api_key\": 'mismatch'",'notpassword=value']) assert.equal(scan({files:[{path:'x',text}]}).findings.length,0);
});

test('unsupported or unbounded quoted assignments fail closed with static errors',()=>{
 for(const text of ['password="unterminated','password="bad\\q"','password="'+ 'x'.repeat(513)+'"','password='+ 'x'.repeat(513),'password=`unsupported`']) {
  assert.throws(()=>scan({files:[{path:'x',text}]}),{message:'input'});
 }
});
