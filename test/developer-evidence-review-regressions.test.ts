import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIncident} from '../tools/developer-evidence/incident.mjs';
import {checkEnvironment} from '../tools/developer-evidence/environment.mjs';
import {analyzeCoverage} from '../tools/developer-evidence/coverage.mjs';
import {searchLogs} from '../tools/developer-evidence/logs.mjs';

const logs=(setup:string,secret:string,path='events')=>searchLogs({files:[{path:'setup',format:'line',text:setup},{path,format:'line',text:'2026-11-05T10:00:00Z incident '+secret}],query:'incident',sensitiveValues:[],limit:10});
test('R2-01 complete escaped assignments protect decoded and raw cross-file secrets',()=>{
 for(const [raw,decoded] of [[String.raw`prefix\"猫tail`,'prefix"猫tail'],[String.raw`folder\\secret`,'folder\\secret'],[String.raw`prefix\u732btail`,'prefix猫tail'],[String.raw`line\nsecret`,'line\nsecret']]){
  const report=JSON.stringify(logs('password="'+raw+'"',decoded+' '+raw));
  assert.ok(!report.includes(JSON.stringify(decoded).slice(1,-1)),report);
  assert.ok(!report.includes(JSON.stringify(raw).slice(1,-1)),report);
 }
 assert.ok(!JSON.stringify(logs('password="private_path"','private_path','private_path.log')).includes('private_path'));
});
test('R2-02 duplicate decoded JSON keys refuse before any output',()=>{
 for(const setup of ['{"password":"firstsecret","password":"secondsecret","message":"setup"}',String.raw`{"password":"firstsecret","pass\u0077ord":"secondsecret"}`,'{"nested":{"x":1,"x":2}}'])assert.throws(()=>logs(setup,'firstsecret','firstsecret.log'),/^Error: Invalid supplied evidence$/);
});
test('R2-07 chronology uses private epochs and original path ties before redaction',()=>{
 const files=[{path:'z11',kind:'alert',text:JSON.stringify({timestamp:'2026-11-05T11:00:00Z',event:'second',incident:'i'})},{path:'a',kind:'deployment',text:JSON.stringify({timestamp:'2026-11-05T11:00:00+01:00',event:'first',incident:'i'})},{path:'z10',kind:'metric',text:JSON.stringify({timestamp:'2026-11-05T11:00:00Z',event:'tie-before',incident:'i'})}];
 for(const sensitiveValues of [['11'],['10'],['+01:00'],['z10']]){const r=buildIncident({files,incident:'i',sensitiveValues,limit:10});assert.deepEqual(r.timeline.map((e:any)=>e.event),['first','tie-before','second']);assert.ok(!JSON.stringify(r).includes('epoch'));assert.deepEqual(Object.keys(r.timeline[0]).sort(),['event','kind','line','path','timeStatus','timestamp','utc']);}
});
const envRules=[{name:'TOKEN',type:'string',required:true,secret:true,minLength:4}];
test('R2-08 JSON duplicate names and malformed quoted dotenv refuse',()=>{
 for(const text of ['{"TOKEN":"x","TOKEN":"synthetic-good"}',String.raw`{"TOKEN":"x","T\u004fKEN":"synthetic-good"}`])assert.throws(()=>checkEnvironment({format:'json',text,rules:envRules}));
 for(const text of ['TOKEN="bad"tail"',String.raw`TOKEN="bad\"`])assert.throws(()=>checkEnvironment({format:'dotenv',text,rules:envRules}));
 for(const text of [String.raw`TOKEN="good\"quote" # comment`,String.raw`TOKEN="good\\path\n\r\t\u732b"`,"TOKEN='good value' # comment"]){const r=checkEnvironment({format:'dotenv',text,rules:envRules});assert.equal(r.valid,true);assert.ok(!JSON.stringify(r).includes('good'));}
});
test('R2-01 empty recognized values do not create an empty redaction literal',()=>{assert.match(logs('password=""','ordinary').matches[0].message,/incident ordinary/);});
test('R2-01 assignments inside ordinary JSON message strings remain discoverable',()=>{assert.ok(!JSON.stringify(logs(JSON.stringify({message:'password=embeddedPrivate'}),'embeddedPrivate','embeddedPrivate.log')).includes('embeddedPrivate'));});
test('R2-01/R2-02 parser bounds and supported Unicode retain fail-closed privacy',()=>{
 for(const text of ['{"password":123}','{"password":null}','{"password":{}}','{"constructor":"private"}','{"a":[{"x":1,"x":2}]}','{"password":"bad\\q"}', '{"a":'.repeat(17)+'0'+'}'.repeat(17)])assert.throws(()=>logs(text,'private'),/^Error: Invalid supplied evidence$/);
 for(const value of ['猫🐱','a\nb\tc','back\\slash'])assert.ok(!JSON.stringify(logs(JSON.stringify({password:value}),value)).includes(JSON.stringify(value).slice(1,-1)));
});
test('R2-01 malformed or unsupported sensitive values refuse atomically without echo',()=>{
 for(const value of ['"unterminated','"bad\\q"','"bad"tail','"bad\\"', '"'+ 'x'.repeat(2001)+'"'])assert.throws(()=>logs('password='+value,'incident'),/^Error: Invalid supplied evidence$/);
});
