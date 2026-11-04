import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { makeApp, tempDir, ROOT } from './helpers.ts';
import { runInNewContext } from 'node:vm';
import { checklist } from '../src/checklist.ts';
const { rankPages, SETTINGS_KEYWORDS } = await import(pathToFileURL(join(ROOT, 'web/settings-search.js')).href);
const first = await import(pathToFileURL(join(ROOT, 'web/first-run.js')).href);
const source = (file: string) => readFileSync(new URL('../web/' + file, import.meta.url), 'utf8');
test('Q2 intended settings tasks outrank incidental mentions', () => {
 const pages = ['dh-data', 'ab-tools', 'her-voice', 'models-default', 'dh-backups'].map(id => ({ id, title:id, keywords: SETTINGS_KEYWORDS[id] ?? [], head: 'backup restore voice connect model permissions' }));
 for (const [q, id] of [['backup','dh-backups'],['restore','dh-backups'],['voice','her-voice'],['connect model','models-default'],['permissions','ab-tools']]) assert.equal(rankPages(q,pages)[0].id,id,q);
});
test('Q2 readiness distinguishes configuration, first reply and chosen path', () => {
 assert.equal(first.todayAction({ readiness:{modelConfigured:false,firstReply:false}},false,false),'model');
 assert.equal(first.todayAction({ readiness:{modelConfigured:true,firstReply:false}},false,false),'message');
 assert.equal(first.todayAction({ path:'coding',readiness:{modelConfigured:true,firstReply:true}},false,false),'project');
 assert.equal(first.todayAction({ readiness:{modelConfigured:false,firstReply:false}},true,false),'message');
 assert.equal(first.todayAction({ readiness:{modelConfigured:false,firstReply:false}},false,true),'message');
 assert.equal(first.todayAction({path:'coding',items:[{id:'project',done:true}],readiness:{modelConfigured:true,firstReply:true}},false,false),'plan');
 assert.equal(first.todayAction({path:'both',readiness:{modelConfigured:true,firstReply:true}},false,false),'plan');
});
test('Q2 search renders metadata cards with real links instead of whole matching forms', () => {
 assert.match(source('settings-nav.js'), /export function paintSettingsResults/);
 assert.match(source('settings-nav.js'), /view=settings:/);
 assert.doesNotMatch(source('app.js'), /p\.hidden = !hits\.has\(p\)/);
});
test('Q2 visible main skip and intentional motion / touch targets', () => {
 assert.match(source('index.html'), /id="skip-main"/);
 assert.match(source('style.css'), /min-width: 28px; min-height: 28px/);
 assert.doesNotMatch(source('style.css'), /\.tour-ring[^\n]*transition: all/);
});

test('Q2 readiness requires a completed personal reply, not an attempt, block, import or partial', (t) => {
 const {dir, cleanup} = tempDir();
 const app = makeApp(dir, {now:new Date('2026-11-04T12:00:00Z')});
 t.after(() => {app.store.close(); cleanup();});
 const input = {devices:[],pushDevices:0,personaCustom:false};
 const ready = () => checklist(app,input).readiness;
 assert.deepEqual(ready(),{modelConfigured:false,firstReply:false});
 app.settings.update({defaultProviderId:'fixture',defaultModel:'unprobed'});
 assert.equal(ready().modelConfigured,true);
 const c = app.store.createConversation();
 app.store.addMessage(c.id,'user','hello');
 app.store.addMessage(c.id,'assistant','blocked',{blocked:'fixture'});
 app.store.addMessage(c.id,'assistant','incomplete',{partial:true});
 app.store.addMessage(c.id,'assistant','past',{importedFrom:'fixture'});
 assert.equal(ready().firstReply,false);
 app.store.addMessage(c.id,'assistant','A useful fixture reply');
 assert.equal(ready().firstReply,true);
 assert.equal(app.providerCalls,0,'readiness never infers');
});

test('Q2 actual result renderer filters roles, opens one page by keyboard click, preserves results focus and supports modified links', () => {
 class Node {
  dataset: Record<string,string> = {};
  hidden = false;
  textContent = '';
  children: Node[] = [];
  listeners: Record<string,(e: any)=>void> = {};
  attrs: Record<string,string> = {};
  classList = {add(){},remove(){},contains(){return false;}};
  href = '';
  focused = false;
  value = 'backup';
  tag = '';
  cls = '';
  constructor(tag = '', cls = '', text = '') {this.tag=tag;this.cls=cls;this.textContent=text;}
  append(...nodes: Node[]) {this.children.push(...nodes);}
  replaceChildren(...nodes: Node[]) {this.children=nodes;}
  setAttribute(k:string,v:string) {this.attrs[k]=v;}
  getAttribute(k:string) {return this.attrs[k] ?? null;}
  querySelectorAll() {return [];}
  querySelector(q:string): Node | null {return this.children.find(n=>q==='a' ? n.tag==='a' : q.includes(n.dataset.result)) ?? null;}
  addEventListener(k:string,fn:(e:any)=>void) {this.listeners[k]=fn;}
  focus() {this.focused=true;}
 }
 const nodes: Record<string,Node> = {};
 for(const id of ['settings-results','settings-results-back','settings-search','settings-elsewhere','settings-page-title','settings-page-desc','settings-howto','settings-empty','settings','settings-nav-list']) nodes['#'+id]=new Node();
 nodes['.settings-pages']=new Node();
 const page = (id:string, extra={}) => {const n=new Node(); n.dataset={page:id,title:id,group:'Data & health',...extra}; return n;};
 const pages=[page('dh-backups'),page('owner-secret',{ownerOnly:''}),page('desktop-app'),page('you-adult'),page('household')];
 let member=false, demo=false;
 const opened: any[]=[];
 const sandbox: any = {
  document: {querySelector:(q:string)=>nodes[q] ?? null, querySelectorAll:(q:string)=> q.includes('.settings-page') ? pages : [], body:{classList:{contains:()=>demo}}},
  navigator:{userAgent:'SaraPhone/1'}, window:{}, localStorage:{getItem:()=>null},
  t:(s:string,vars:Record<string,string>={})=>Object.entries(vars).reduce((a,[k,v])=>a.replaceAll('{'+k+'}',v),s),
  foldText:(s:string)=>String(s??'').toLowerCase(),rankPages,SETTINGS_KEYWORDS,rankElsewhere:()=>[],howtoFor:()=>[],slashCommands:()=>[]
 };
 const src=source('settings-nav.js').replace(/^import .*;\n/gm,'').replaceAll('export ','');
 runInNewContext(src+'\nthis.nav = {initSettingsNav, settingsPages, paintSettingsResults, clearSettingsSearch};',sandbox);
 sandbox.nav.initSettingsNav({isMember:()=>member, el:(tag:string,cls:string,text:string)=>new Node(tag,cls,text),showSettingsTab:(...a:any[])=>opened.push(a),pageLead:()=>null,openSearchPlace(){},help:()=>({'dh-backups':['Backup description']})});
 sandbox.nav.paintSettingsResults('backup');
 assert.ok(pages.every(p=>p.hidden),'no matching form is expanded');
 const a=nodes['#settings-results'].children[0];
 assert.equal(a.href,'/#view=settings:dh-backups');
 assert.equal(a.children[2].textContent,'Backup description');
 let prevented=false;
 a.listeners.click({button:0,ctrlKey:true,preventDefault(){prevented=true;}});
 assert.equal(prevented,false);
 assert.equal(opened.length,0);
 a.listeners.click({button:0,preventDefault(){prevented=true;}});
 assert.equal(opened[0][0],'dh-backups');
 assert.equal(opened[0][1].searchResult,true);
 assert.equal(nodes['#settings-results-back'].hidden,false);
 assert.equal(nodes['#settings-search'].value,'backup');
 sandbox.nav.paintSettingsResults('backup',{focus:true});
 assert.equal(nodes['#settings-results'].children[0].focused,true);
 sandbox.nav.paintSettingsResults('impossible-query');
 assert.equal(nodes['#settings-empty'].hidden,false);
 member=true; demo=true;
 assert.deepEqual(Array.from(sandbox.nav.settingsPages(),(p:any)=>p.dataset.page),['dh-backups']);
 sandbox.nav.clearSettingsSearch();
 assert.equal(nodes['#settings-results'].hidden,true);
 assert.equal(nodes['#settings-results-back'].hidden,true);
});

test('Q2 coding member/demo primary never opens an owner-only project page', () => {
 const c = {path:'coding',items:[{id:'project',done:false}],readiness:{modelConfigured:true,firstReply:true}};
 assert.equal(first.todayAction(c,true,false),'plan');
 assert.equal(first.todayAction(c,false,true),'plan');
 assert.equal(first.todayAction(c,false,false),'project');
});

test('Q2 member readiness never reflects owner subscription sign-in', (t) => {
 const {dir,cleanup}=tempDir(); const app=makeApp(dir,{now:new Date()});
 t.after(()=>{app.store.close();cleanup();});
 app.subscriptions={grokStatus:()=>({signedIn:true}),claudeStatus:()=>({signedIn:false}),chatgpt:{status:()=>({signedIn:false})}} as never;
 const input={devices:[],pushDevices:0,personaCustom:false};
 assert.equal(checklist(app,{...input,member:true}).readiness.modelConfigured,false);
 assert.equal(checklist(app,input).readiness.modelConfigured,true);
 app.settings.update({defaultProviderId:'allowed-fixture',defaultModel:'allowed-model'});
 assert.equal(checklist(app,{...input,member:true}).readiness.modelConfigured,true);
});
test('Q2 keyboard result navigation focuses a focusable heading and Try a message clears Today inert synchronously', async () => {
 const app=source('app.js');
 const start=app.indexOf('function showSettingsTab('); const end=app.indexOf('\n}\n',start)+2;
 const section={dataset:{page:'dh-backups',title:'Backups'},querySelector:()=>null};
 let focused='';
 const node=(id:string)=>({hidden:false,textContent:'',scrollTop:0,value:'',classList:{add(){}},toggleAttribute(){},focus(){
   if(source('index.html').includes(`id="${id}" tabindex="-1"`)) focused=id;
 }});
 const nodes:any={'#settings-page-title':node('settings-page-title'),'.settings-pages':node('settings-pages'),'#settings-empty':node('settings-empty'),'#settings':node('settings'),'.settings-actions':node('settings-actions'),'#settings-search':node('settings-search')};
 runInNewContext(app.slice(start,end)+"\nshowSettingsTab('dh-backups',{focus:true});",{OLD_TABS:{},settingsPages:()=>[section],$:(q:string)=>nodes[q],document:{querySelectorAll:()=>[]},t:(s:string)=>s,showSettingsHelp(){},openGroupOf(){},localStorage:{setItem(){}}});
 assert.equal(focused,'settings-page-title');
});
test('Q2 Try a message clears Today inert synchronously and preserves drafts', async () => {
 const app=source('app.js');
 const at=app.indexOf("$('#td-ask').addEventListener('click', ");
 const callback=app.slice(at+"$('#td-ask').addEventListener('click', ".length,app.indexOf('\n});',at)+2);
 let inert=true, inputFocused=false;
 const input={value:'preserved draft',focus(){inputFocused=!inert;}};
 const context:any={todayNextAction:'message',$:(q:string)=>q==='#input'?input:{close(){}},closeToday(){inert=false;}};
 runInNewContext('this.action = '+callback,context);
 await context.action();
 assert.equal(inputFocused,true,'chat input must stop being inert before focus');
 assert.equal(input.value,'preserved draft');
});

test('Q2 model recovery reconciliation and Today Refresh reread readiness without provider inference', async () => {
 const app=source('app.js');
 const start=app.indexOf('function refreshModelSettings('); const end=app.indexOf('\n}\n',start)+2;
 let checklistReads=0,modelLists=0,renders=0,visible=true;
 const context:any={renderProviders(){renders++;},loadModels(){modelLists++;},todayOpen:()=>visible,loadChecklist(){checklistReads++;return Promise.resolve();}};
 runInNewContext(app.slice(start,end)+'\nthis.refresh = refreshModelSettings;',context);
 context.refresh();
 assert.equal(checklistReads,1,'successful recovery updates primary when Today is open');
 visible=false;context.refresh();
 assert.equal(checklistReads,1,'hidden Today refreshes through its normal open path');
 assert.equal(modelLists,2);assert.equal(renders,2);
 let todayReads=0;
 const listener=app.split('\n').find((line:string)=>line.startsWith("$('#td-refresh').addEventListener"))!;
 let refresh:any;
 runInNewContext(listener,{$:()=>({addEventListener(_k:string,fn:any){refresh=fn;}}),loadToday(force:boolean){assert.equal(force,true);todayReads++;return Promise.resolve();},loadChecklist(){checklistReads++;return Promise.resolve();},Promise});
 await refresh();
 assert.equal(todayReads,1);
 assert.equal(checklistReads,2,'explicit Refresh includes checklist readiness');
});
