import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fromFolder } from '../src/packages.ts';
import { checkPlugin } from '../src/store/checks.ts';
import { REPO_OUTPUTS_READONLY } from './repo-outputs.ts';

for (const id of ['inbox-triage','content-studio','image-workshop','spreadsheet-assistant','travel-planner','home-dashboard']) {
  test(`${id}: official package readiness, copied SDK, translations and exact tool declarations`, async t => {
    const dir = resolve('store/plugins', id);
    const report = checkPlugin(fromFolder(dir), { saraVersion: '2.65.0', firstParty: true });
    assert.equal(report.ready, true, JSON.stringify(report.results.filter(x => !x.ok)));
    assert.deepEqual(readFileSync(resolve(dir, 'sara-plugin.mjs')), readFileSync('examples/plugins/sara-plugin.mjs'));
    const m = JSON.parse(readFileSync(resolve(dir, 'sara-plugin.json'), 'utf8'));
    for (const lang of ['es','fr','de','pt-BR','it']) for (const key of [m.name,m.description]) assert.ok(m.i18n[lang][key]);
    assert.equal(m.sara, '>=2.65.0'); assert.equal(m.permissions.hooks, undefined); assert.equal(m.schedules, undefined); assert.equal(m.permissions.callTools, undefined); assert.equal(m.permissions.network, undefined);
    const c = await workflowChannel(id); t.after(c.close);
    assert.deepEqual(c.ready.tools.map((x: any) => x.name), m.permissions.tools);
    assert.ok(c.ready.tools.every((x: any) => x.parameters.type === 'object' && x.permission === 'ask'));
  });
}

const ids = ['inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard'];
const contentArgs = { brief: 'Garden opening', audience: 'Neighbors', tone: 'warm', channel: 'newsletter' };
const travelArgs = { start: '2026-12-01', end: '2026-12-03', currency: 'USD', budget: 100, preferences: 'Walking', options: [] };
for (const id of ids) {
  test(`${id}: no hidden startup actions, unknown tool and malformed/oversize arguments rejected`, async t => {
    const c = await workflowChannel(id); t.after(c.close);
    assert.deepEqual(c.ready.tools.map((x: any) => x.name), ['workflow']);
    assert.equal(c.ready.tools[0].permission, 'ask');
    await new Promise(r => setTimeout(r, 30)); assert.deepEqual(c.calls, []);
    assert.equal((await c.tool({}, 'not_declared')).type, 'error');
    for (const args of [{}, [], 'bad', { unknown: true }, { unknown: 'a'.repeat(24001) }]) assert.equal((await c.tool(args)).type, 'error');
    assert.deepEqual(c.calls, []);
  });
}
for (const [label, csv] of Object.entries({ unclosed: 'a\n"oops', quoteAfterText: 'a\nhi"oops', afterQuote: 'a\n"hi"x', width: 'a,b\n1', duplicate: 'a,a\n1,2', emptyHeader: ',b\n1,2', empty: '', overCell: 'a\n' + 'x'.repeat(1001), overRows: 'a\n' + '1\n'.repeat(51), overColumns: Array.from({length:13}, (_, i) => `h${i}`).join(','), overflow: 'a\n1e308\n1e308' })) {
  test(`sheet refuses ${label}`, async t => {
    const c = await workflowChannel('spreadsheet-assistant'); t.after(c.close);
    assert.equal((await c.tool({ csv })).type, 'error');
  });
}
test('sheet: escaped quotes, BOM, empty cells, header-only and hostile formula prefixes', async t => {
  const c = await workflowChannel('spreadsheet-assistant'); t.after(c.close);
  const r = output(await c.tool({ csv: '\uFEFFname,n\n"a""b",1e2\nempty,\n" @cmd",+3\n"\t=evil",text' }));
  assert.equal(r.rows, 4); assert.equal(r.columns[1].numeric, 2); assert.equal(r.columns[1].sum, 103); assert.equal(r.columns[1].empty, 1);
  assert.equal(r.formulaEscapes, 3); assert.match(r.export.text, /"a""b"/);
  const h = output(await c.tool({ csv: 'a,b' })); assert.equal(h.rows, 0); assert.equal(h.columns[0].sum, null);
  assert.equal((await c.tool({ csv: 'a\n1', filter: { column: 'missing', equals: 'x' } })).type, 'error');
  assert.equal((await c.tool({ csv: 'a\n1', filter: [] })).type, 'error');
});
test('inbox: empty input stays empty; duplicate IDs, bad fields and excessive batches fail', async t => {
  const c = await workflowChannel('inbox-triage'); t.after(c.close);
  assert.deepEqual(output(await c.tool({ messages: [] })).items, []);
  const msg = { id: 'm', subject: 'Question', body: 'Can you review?' };
  for (const messages of [[msg, msg], Array(9).fill(msg), [{...msg, body: 1}], [{...msg, id: ''}], [{...msg, subject: 'a'.repeat(181)}], [{...msg, send: true}]]) assert.equal((await c.tool({ messages })).type, 'error');
  assert.deepEqual(c.calls.map(m=>m.op), []);
});
for (const fixture of [{ error: 'route unavailable' }, { text: '' }, { text: 'x'.repeat(1401) }]) {
  test(`content: refuses model error/empty/oversize (${Object.keys(fixture)[0]}-${fixture.text?.length ?? 0})`, async t => {
    const c = await workflowChannel('content-studio', () => fixture); t.after(c.close);
    assert.equal((await c.tool({ ...contentArgs, useModel: true })).type, 'error'); assert.equal(c.calls.length, 1);
  });
}
test('content: oversized source and invalid types fail before model invocation', async t => {
  const c = await workflowChannel('content-studio'); t.after(c.close);
  for (const bad of [{brief:'a'.repeat(601)}, {audience:[]}, {useModel:'yes'}, {channel:'publish'}, {tone:''}]) assert.equal((await c.tool({...contentArgs, ...bad, useModel: bad.useModel ?? true})).type, 'error');
  assert.deepEqual(c.calls, []);
});
test('image: load empty, prepare without saving, clear and KV refusal', async t => {
  const c = await workflowChannel('image-workshop', fixtureHost()); t.after(c.close);
  assert.equal(output(await c.tool({action:'load'})).status, 'empty');
  const brief = { action:'prepare', brief:'Garden', style:'illustration', aspect:'16:9' };
  assert.equal(output(await c.tool(brief)).generated, false);
  assert.equal(output(await c.tool({action:'load'})).status, 'empty');
  assert.equal(output(await c.tool({action:'clear'})).cleared, true);
  for (const bad of [{style:'unknown'}, {seed:1.5}, {seed:-1}, {aspect:'wide'}, {brief:'x'.repeat(601)}]) assert.equal((await c.tool({...brief, ...bad})).type, 'error');
  const denied = await workflowChannel('image-workshop', () => ({error:'KV refused fixture'})); t.after(denied.close);
  assert.equal((await denied.tool({...brief,action:'save'})).type, 'error');
});
test('travel: empty options expose unplanned dates; invalid dates, budget, source and confirmation fail', async t => {
  const c = await workflowChannel('travel-planner'); t.after(c.close);
  const r = output(await c.tool(travelArgs)); assert.equal(r.unplannedDates.length, 3); assert.equal(r.suppliedTotal, 0);
  for (const bad of [{start:'2026-02-30'}, {end:'2026-11-01'}, {end:'2027-01-20'}, {budget:-1}, {budget:'10'}, {currency:'usd'}, {options:[{confirmed:false}]}, {options:[{id:'a',title:'Museum',date:'2026-12-10',amount:1,source:'Supplied',checked:'2026-11-01',confirmed:true}]}]) assert.equal((await c.tool({...travelArgs, ...bad})).type, 'error');
});
test('home: empty snapshot, unapproved metadata and all control/token fields refused', async t => {
  const c = await workflowChannel('home-dashboard'); t.after(c.close);
  const args = { observedAt:'2026-11-05T12:00:00Z',devices:[],scenes:[] };
  assert.deepEqual(output(await c.tool(args)).devices, []);
  for (const bad of [{observedAt:'2026-02-30T12:00:00Z'}, {token:'not-a-token'}, {action:'unlock'}, {devices:[{id:'lock.front',name:'Front',state:'locked',approved:false}]}, {devices:[{id:'light.desk',name:'Desk',state:'on',approved:true,action:'turn_on'}]}]) assert.equal((await c.tool({...args,...bad})).type, 'error');
  assert.deepEqual(c.calls.map(m=>m.op), []);
});

import { workflowChannel, fixtureHost, output } from './addons-workflows-channel.ts';

const localeFixtures: Record<string, any> = {
 'inbox-triage': {messages:[{id:' source 🌻 ',subject:'Source subject',body:'Please review source text.'}]},
 'content-studio': {...contentArgs,brief:'Source brief 🌻'},
 'image-workshop': {action:'prepare',brief:'Source brief 🌻',style:'product',aspect:'1:1',avoid:'Source avoid'},
 'spreadsheet-assistant': {csv:'source header\nsource cell'},
 'travel-planner': {...travelArgs,options:[{id:' source 🌻 ',date:'2026-12-01',title:'Source title',amount:1,source:'Source receipt',checked:'2026-11-01',confirmed:true}]},
 'home-dashboard': {observedAt:'2026-11-05T12:00:00Z',devices:[{id:'light.desk',name:'Source name',state:'Source state',approved:true}],scenes:[{id:'scene.evening',name:'Source scene',approved:true}]}
};
for(const lang of ['es','fr','de','pt-BR','it']) for(const id of ids) test(`N5 ${id} actual ready, prose and native card in ${lang}`,async t=>{
 const c=await workflowChannel(id,fixtureHost(),lang); t.after(c.close);
 const en=await workflowChannel(id,fixtureHost()); t.after(en.close);
 const args=localeFixtures[id], result=await c.tool(args), r=output(result), english=output(await en.tool(args));
 assert.notEqual(c.ready.tools[0].description,en.ready.tools[0].description);
 assert.deepEqual(c.ready.tools[0].parameters,en.ready.tools[0].parameters);
 const card=result.card; assert.ok(card.title); assert.ok(card.lines.length>0);
 assert.equal(c.messages.filter(m=>m.type==='result' && m.id===result.id && m.card).length,1);
 const manifest=JSON.parse(readFileSync(resolve('store/plugins',id,'sara-plugin.json'),'utf8'));
 assert.equal(card.title,manifest.i18n[lang][manifest.name]);
 const changed=(a:any,b:any)=>{assert.equal(typeof a,'string');assert.notEqual(a,b);};
 if(id==='inbox-triage'){assert.equal(r.items[0].id,args.messages[0].id);assert.equal(r.items[0].actionRequest,args.messages[0].body);assert.equal(r.items[0].priority,english.items[0].priority);for(const k of ['reason','draftReply','draftStatus'])changed(r.items[0][k],english.items[0][k]);assert.ok(r.items[0].draftReply.includes('Source subject'));changed(r.warning,english.warning);}
 if(id==='content-studio'){assert.ok(r.draft.includes(args.brief));assert.ok(r.draft.includes(args.audience));assert.equal(r.tone,args.tone);assert.equal(r.channel,args.channel);assert.equal(r.export.text,r.draft);changed(r.draft,english.draft);r.outline.forEach((v:string,i:number)=>changed(v,english.outline[i]));r.assumptions.forEach((v:string,i:number)=>changed(v,english.assumptions[i]));assert.ok(r.assumptions[1].includes(args.tone));}
 if(id==='image-workshop'){assert.equal(r.brief,args.brief);assert.equal(r.avoid,args.avoid);assert.ok(r.prompt.includes(args.brief));assert.ok(r.prompt.includes(args.avoid));assert.equal(r.style,args.style);assert.equal(r.generated,false);changed(r.prompt,english.prompt);changed(r.prerequisite,english.prerequisite);}
 if(id==='spreadsheet-assistant'){assert.equal(r.export.text,english.export.text);assert.equal(r.columns[0].name,'source header');changed(r.warning,english.warning);}
 if(id==='travel-planner'){assert.deepEqual(r.itinerary,english.itinerary);assert.equal(r.preferences,args.preferences);assert.equal(r.currency,args.currency);assert.equal(r.booked,false);changed(r.priceStatus,english.priceStatus);r.unknowns.forEach((v:string,i:number)=>changed(v,english.unknowns[i]));}
 if(id==='home-dashboard'){assert.equal(r.devices[0].suppliedState,'Source state');assert.equal(r.devices[0].name,'Source name');assert.deepEqual(r.scenes,english.scenes);assert.equal(r.live,false);changed(r.devices[0].freshness,english.devices[0].freshness);changed(r.prerequisite,english.prerequisite);changed(r.limitation,english.limitation);}
 assert.deepEqual(c.calls, []); assert.ok(JSON.stringify(r).length<=3800);
 const bad=await c.tool({unexpected:'source text'}), badEn=await en.tool({unexpected:'source text'});
 assert.equal(bad.type,'error');assert.notEqual(bad.error,badEn.error);
});
for(const lang of ['es','fr','de','pt-BR','it']) test(`N3 model is asked for caller language ${lang}`,async t=>{
 const c=await workflowChannel('content-studio',m=>{assert.equal(m.op,'model');assert.ok(m.prompt.includes(`language: ${lang}`));return {text:'FIXTURE 🌻'};},lang);t.after(c.close);
 assert.equal(output(await c.tool({...contentArgs,useModel:true})).draft,'FIXTURE 🌻');
});

test('N4 ready schemas publish exact nested fields and practical bounds', async t => {
 for(const id of ids) {
  const c=await workflowChannel(id); t.after(c.close); const p=c.ready.tools[0].parameters;
  assert.equal(p.additionalProperties,false);
  const visit=(s:any)=>{ if(s.type==='object'){assert.equal(s.additionalProperties,false); assert.ok(s.properties); for(const v of Object.values(s.properties)) visit(v);} if(s.type==='array'){assert.equal(s.minItems,0); assert.ok(s.maxItems<=8); visit(s.items);} if(s.type==='string'){assert.ok(Number.isInteger(s.minLength));assert.ok(s.maxLength>0);} if(s.type==='number'||s.type==='integer'){assert.ok(s.minimum>=0);assert.ok(s.maximum>0);} }; visit(p);
  if(id==='inbox-triage') assert.deepEqual(p.properties.messages.items.required,['id','subject','body']);
  if(id==='travel-planner') { assert.deepEqual(p.properties.options.items.required,['id','date','title','amount','source','checked','confirmed']); assert.ok(p.properties.currency.enum.includes('KWD')); }
  if(id==='home-dashboard') {assert.equal(p.properties.devices.items.properties.approved.const,true); assert.match('scene.evening',new RegExp(p.properties.scenes.items.properties.id.pattern));}
  if(id==='image-workshop') {assert.equal(p.properties.seed.maximum,2147483647); assert.match(c.ready.tools[0].description,/version|Version/);}
 }
});

test('N6 workflow channel uses actual permission-limited native shim and minimal environment', async t => {
 const c=await workflowChannel('inbox-triage'); t.after(c.close);
 assert.ok(c.launch.args.includes('--permission')); assert.ok(c.launch.args.includes('--no-addons'));
 assert.ok(c.launch.args.some((a:string)=>a.endsWith('plugin-host.mjs'))); assert.equal(c.launch.args.some((a:string)=>a.startsWith('--allow-net')),false);
 assert.deepEqual(Object.keys(c.launch.env).sort(),['PATH','SystemRoot']);
});

test('N6 actual Node/shim fences refuse file read/write, process spawn and direct fetch (not a full OS sandbox)', { skip: REPO_OUTPUTS_READONLY }, async t => {
 const c=await workflowChannel('inbox-triage');t.after(c.close);
 const folder=resolve('outputs/addons/workflows-fixes');mkdirSync(folder,{recursive:true});
 const probe=resolve(folder,'permission-probe.mjs'), forbidden=resolve(folder,'must-not-exist.txt');
 t.after(()=>{rmSync(probe,{force:true});rmSync(forbidden,{force:true});});
 const code=`import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
 const outcomes={};for(const [key,fn] of Object.entries({read:()=>readFileSync(${JSON.stringify(resolve('package.json'))}),write:()=>writeFileSync(${JSON.stringify(forbidden)},'forbidden'),spawn:()=>spawnSync(process.execPath,['--version']),fetch:()=>fetch('https://example.invalid/never-requested')})){try{fn();outcomes[key]='UNEXPECTED';}catch(e){outcomes[key]=e.code??e.message;}}process.stdout.write(JSON.stringify(outcomes)+'\\n');`;
 writeFileSync(probe,code);
 const args=[...c.launch.args];args[1]=`--allow-fs-read=${probe}`;args[args.length-1]=probe;
 const r=spawnSync(process.execPath,args,{env:c.launch.env,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);
 const out=JSON.parse(r.stdout.trim());for(const key of ['read','write','spawn'])assert.equal(out[key],'ERR_ACCESS_DENIED');assert.match(out.fetch,/only through sara.fetch/);
});

test('N4 schema-boundary fixtures agree with handler on nested fields, lengths, enums and extra properties',async t=>{
 const accepts=(s:any,v:any):boolean=>{
  if(s.type==='object')return v!==null&&typeof v==='object'&&!Array.isArray(v)&&s.required.every((k:string)=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>Object.hasOwn(s.properties,k)&&accepts(s.properties[k],v[k]));
  if(s.type==='array')return Array.isArray(v)&&v.length>=s.minItems&&v.length<=s.maxItems&&v.every(x=>accepts(s.items,x));
  if(s.type==='string')return typeof v==='string'&&v.length>=s.minLength&&v.length<=s.maxLength&&(!s.pattern||new RegExp(s.pattern).test(v))&&(!s.enum||s.enum.includes(v));
  if(s.type==='boolean')return typeof v==='boolean'&&(!Object.hasOwn(s,'const')||v===s.const);
  if(s.type==='number'||s.type==='integer')return typeof v==='number'&&Number.isFinite(v)&&v>=s.minimum&&v<=s.maximum&&(s.type!=='integer'||Number.isInteger(v));
  return false;
 };
 for(const id of ids){const c=await workflowChannel(id,fixtureHost());t.after(c.close);const schema=c.ready.tools[0].parameters,args=localeFixtures[id];
  assert.equal(accepts(schema,args),true);assert.equal((await c.tool(args)).type,'result');
  const bad:any[]=[{...args,extra:true}];
  const required=structuredClone(args);delete required[schema.required[0]];bad.push(required);
  if(id==='inbox-triage')bad.push({messages:[{...args.messages[0],body:'x'.repeat(1501)}]},{messages:[{...args.messages[0],extra:true}]},{messages:Array(9).fill(args.messages[0])});
  if(id==='content-studio')bad.push({...args,brief:'x'.repeat(601)},{...args,channel:'publish'});
  if(id==='image-workshop')bad.push({...args,seed:2147483648},{...args,seed:1.5},{...args,style:'unknown'});
  if(id==='spreadsheet-assistant')bad.push({...args,csv:'x'.repeat(12001)},{...args,filter:{column:'a',equals:'x',extra:true}});
  if(id==='travel-planner')bad.push({...args,options:[{...args.options[0],confirmed:false}]},{...args,currency:'ZZZ'},{...args,budget:10000001});
  if(id==='home-dashboard')bad.push({...args,devices:[{...args.devices[0],approved:false}]},{...args,scenes:[{...args.scenes[0],id:'light.x'}]});
  for(const a of bad){assert.equal(accepts(schema,a),false,JSON.stringify(a).slice(0,200));assert.equal((await c.tool(a)).type,'error');}
 }
});

test('N7 image validates stored versioned presets and requires persistence acknowledgements', async t => {
 const args={action:'save',brief:'Vase',style:'product',aspect:'1:1'};
 for (const stored of [{generated:true,image:'https://fake.invalid/image'}, {brief:'old'}, {version:99}, {version:1,brief:'x'.repeat(25000)}, {version:1,brief:'Vase',style:'product',aspect:'1:1',avoid:'',seed:null,generated:true}]) {
  let state:unknown=structuredClone(stored); const original=structuredClone(state); let writes=0;
  const c=await workflowChannel('image-workshop',m=>m.op==='kv.get'?{value:state}:(writes++,state=m.value,{ok:true})); t.after(c.close);
  for(const request of [{action:'load'},args,{action:'clear'}]) assert.equal((await c.tool(request)).type,'error');
  assert.deepEqual(state,original); assert.equal(writes,0);
 }
 for (const receipt of [{ok:false},{}, {ok:'true'}, {error:'refused'}]) {
  let state:unknown=null;
  const c=await workflowChannel('image-workshop',m=>m.op==='kv.get'?{value:state}:receipt); t.after(c.close);
  assert.equal((await c.tool(args)).type,'error'); assert.equal((await c.tool({action:'clear'})).type,'error'); assert.equal(state,null);
 }
 const validPreset={version:1,brief:'Intact',style:'product',aspect:'1:1',avoid:'',seed:null};
 for(const receipt of [{ok:false},{}, {ok:'true'}, {error:'refused'}]) {
  const state=structuredClone(validPreset);
  const c=await workflowChannel('image-workshop',m=>m.op==='kv.get'?{value:state}:receipt);t.after(c.close);
  for(const request of [args,{action:'clear'}]) assert.equal((await c.tool(request)).type,'error');
  assert.equal(output(await c.tool({action:'load'})).brief,'Intact');assert.deepEqual(state,validPreset);
 }
 const lying=await workflowChannel('image-workshop',m=>m.op==='kv.get'?{value:validPreset}:{ok:true});t.after(lying.close);
 assert.equal((await lying.tool(args)).type,'error');assert.equal((await lying.tool({action:'clear'})).type,'error');
 let state:any=null;
 const c=await workflowChannel('image-workshop',m=>m.op==='kv.get'?{value:state}:(state=structuredClone(m.value),{ok:true})); t.after(c.close);
 const saved=output(await c.tool(args)); assert.equal(saved.saved,true); assert.equal(state.version,1); assert.equal(state.generated,undefined); assert.equal(state.prompt,undefined);
 const loaded=output(await c.tool({action:'load'})); assert.equal(loaded.generated,false); assert.equal(loaded.brief,'Vase');
 assert.equal(output(await c.tool({action:'clear'})).cleared,true); assert.equal(state,null);
});

test('N3 content rejects forbidden model Unicode without modifying supplied material', async t => {
 for (const draft of ['\u0000','\u0001bad','\u007fbad','\u0085bad','\ud800','\udc00','x\ud800y']) {
  const c=await workflowChannel('content-studio',()=>({text:draft})); t.after(c.close);
  assert.equal((await c.tool({...contentArgs,useModel:true})).type,'error');
 }
 const c=await workflowChannel('content-studio',()=>({text:'Valid 🌻\n\ttext'})); t.after(c.close);
 assert.equal(output(await c.tool({...contentArgs,useModel:true})).draft,'Valid 🌻\n\ttext');
 const local=await workflowChannel('content-studio'); t.after(local.close);
 const brief='Supplied \u0000 \ud800 🌻'; assert.ok(output(await local.tool({...contentArgs,brief})).draft.includes(brief));
});

test('N2 travel uses exact currency minor units and rejects unsupported precision', async t => {
 const c = await workflowChannel('travel-planner'); t.after(c.close);
 const option = (amount: number, id: string) => ({id,date:'2026-12-01',title:'Walk',amount,source:'Supplied',checked:'2026-11-01',confirmed:true});
 const r = output(await c.tool({...travelArgs,budget:0.3,options:[option(0.1,'a'),option(0.2,'b')]}));
 assert.equal(r.suppliedTotal,0.3); assert.equal(r.remainingBudget,0); assert.equal(r.overBudget,false);
 for (const [currency,budget] of [['USD',0.001],['JPY',0.1],['ZZZ',1],['KWD',0.0001]] as const) assert.equal((await c.tool({...travelArgs,currency,budget})).type,'error');
 for (const [currency,budget] of [['JPY',3],['KWD',0.003],['EUR',0.03]] as const) {
   const r=output(await c.tool({...travelArgs,currency,budget,options:[option(budget,'a')]})); assert.equal(r.remainingBudget,0); assert.equal(r.overBudget,false);
 }
 assert.equal((await c.tool({...travelArgs,options:[option(0.001,'a')]})).type,'error');
 const kwd=output(await c.tool({...travelArgs,currency:'KWD',budget:0.003,options:[option(0.001,'a'),option(0.002,'b')]}));assert.equal(kwd.suppliedTotal,0.003);assert.equal(kwd.remainingBudget,0);assert.equal(kwd.overBudget,false);
 const largest=output(await c.tool({...travelArgs,currency:'KWD',budget:10000000,options:Array.from({length:8},(_,i)=>option(10000000,String(i)))}));assert.equal(largest.suppliedTotal,80000000);assert.equal(largest.remainingBudget,-70000000);assert.equal(largest.overBudget,true);
 assert.equal((await c.tool({...travelArgs,options:Array.from({length:9},(_,i)=>option(10000000,String(i)))})).type,'error');
});

test('supplied identifiers and CSV exact filter whitespace are preserved, not normalized', async t => {
  const inbox = await workflowChannel('inbox-triage'); t.after(inbox.close);
  assert.equal(output(await inbox.tool({ messages: [{ id: ' m1 ', subject: 'Question', body: 'Please review.' }] })).items[0].id, ' m1 ');
  const csv = await workflowChannel('spreadsheet-assistant'); t.after(csv.close);
  assert.equal(output(await csv.tool({ csv: 'a\n x \ny', filter: { column: 'a', equals: ' x ' } })).selectedRows, 1);
});

test('content: local brief produces reviewable draft and Markdown export without publishing', async t => {
  const c = await workflowChannel('content-studio'); t.after(c.close);
  const r = output(await c.tool({ brief: 'Launch a community garden', audience: 'Neighbors', tone: 'warm', channel: 'newsletter' }));
  assert.match(r.draft, /community garden/); assert.match(r.export.text, /Neighbors/);
  assert.equal(r.published, false); assert.deepEqual(c.calls.map(m=>m.op), []);
});

test('content: explicitly requested model draft uses one capped broker call, fixtures only', async t => {
  const c = await workflowChannel('content-studio', m => { assert.equal(m.op, 'model'); assert.equal(m.maxTokens, 600); assert.ok(m.prompt.length < 8000); return { text: 'FIXTURE MODEL: Neighbors can grow together.' }; }); t.after(c.close);
  const r = output(await c.tool({ brief: 'Launch a community garden', audience: 'Neighbors', tone: 'warm', channel: 'newsletter', useModel: true }));
  assert.equal(r.draft, 'FIXTURE MODEL: Neighbors can grow together.'); assert.deepEqual(c.calls.map(m=>m.op), ['model']); assert.equal(r.published, false);
});

test('image: store structured prompt preset and export honest preparation, never fake generation', async t => {
  const c = await workflowChannel('image-workshop', fixtureHost()); t.after(c.close);
  const r = output(await c.tool({ action: 'save', brief: 'A ceramic vase', style: 'product', aspect: '1:1', avoid: 'logos', seed: 42 }));
  assert.match(r.prompt, /ceramic vase/); assert.equal(r.generated, false); assert.equal(r.seed, 42);
  assert.deepEqual(output(await c.tool({ action: 'load' })).brief, 'A ceramic vase');
  assert.ok(c.calls.every(m => m.op.startsWith('kv.')));
  assert.match(r.prerequisite, /exact.*MCP.*schema/i);
});

test('sheet: real CSV quoted commas/newlines, numeric profiling, exact filter and safe export', async t => {
  const c = await workflowChannel('spreadsheet-assistant'); t.after(c.close);
  const r = output(await c.tool({ csv: 'name,amount,note\r\n"Alex, A",2.5,"line one\nline two"\r\nBea,-1,=SUM(A1)\r\n', filter: { column: 'name', equals: 'Bea' } }));
  assert.equal(r.rows, 2); assert.equal(r.selectedRows, 1);
  assert.deepEqual(r.columns[1], { name: 'amount', empty: 0, numeric: 2, sum: 1.5, min: -1, max: 2.5, mean: 0.75 });
  assert.match(r.export.text, /'=SUM\(A1\)/); assert.match(r.export.text, /'-1/);
  assert.equal(r.formulaEscapes, 2); assert.deepEqual(c.calls.map(m=>m.op), []);
});

test('travel: validate supplied dates, budget and confirmed options; label estimates, no booking', async t => {
  const c = await workflowChannel('travel-planner'); t.after(c.close);
  const r = output(await c.tool({ start: '2026-12-01', end: '2026-12-03', currency: 'USD', budget: 300, preferences: 'Museums and walking', options: [{ id: 'o1', date: '2026-12-02', title: 'Museum', amount: 25, source: 'Owner confirmed museum price list', checked: '2026-11-01', confirmed: true }] }));
  assert.equal(r.days, 3); assert.equal(r.suppliedTotal, 25); assert.equal(r.remainingBudget, 275);
  assert.equal(r.itinerary[0].sourceId, 'o1'); assert.equal(r.booked, false);
  assert.match(r.priceStatus, /not live quotes/i); assert.deepEqual(c.calls.map(m=>m.op), []);
});

test('home: list approved supplied metadata as non-live snapshot, prepare only', async t => {
  const c = await workflowChannel('home-dashboard'); t.after(c.close);
  const r = output(await c.tool({ observedAt: '2026-11-05T12:00:00Z', devices: [{ id: 'light.desk', name: 'Desk lamp', state: 'on', approved: true }], scenes: [{ id: 'scene.evening', name: 'Evening', approved: true }] }));
  assert.equal(r.devices[0].id, 'light.desk'); assert.equal(r.scenes[0].id, 'scene.evening');
  assert.equal(r.live, false); assert.equal(r.controlled, false); assert.deepEqual(c.calls.map(m=>m.op), []);
  assert.match(r.prerequisite, /home_status/);
});

test('sheet: preserve boundary whitespace and quoted trailing empty fields', async t => {
  const c = await workflowChannel('spreadsheet-assistant'); t.after(c.close);
  const r = output(await c.tool({ csv: ' name ,note\nAlex,  padded  ' }));
  assert.equal(r.columns[0].name, ' name '); assert.match(r.export.text, /Alex,  padded  \r\n$/);
});

test('inbox: supplied IDs, priorities, requests and reviewable replies; no sending', async t => {
  const c = await workflowChannel('inbox-triage'); t.after(c.close);
  const r = output(await c.tool({ messages: [{ id: 'm1', subject: 'Urgent invoice', body: 'Please review today.' }, { id: 'm2', subject: 'Newsletter', body: 'News only.' }] }));
  assert.equal(r.items[0].id, 'm1'); assert.equal(r.items[0].priority, 'high');
  assert.equal(r.items[0].actionRequest, 'Please review today.');
  assert.match(r.items[0].draftReply, /review|received/i); assert.equal(r.items[1].priority, 'low');
  assert.equal(r.sent, false); assert.deepEqual(c.calls.map(m=>m.op), []);
});
