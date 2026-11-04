import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const path = new URL('../web/recovery.js',import.meta.url);
class Node {
 children:any[]=[]; listeners:Record<string,Function>={}; textContent=''; value=''; disabled=false; checked=false; hidden=false; attrs:Record<string,string>={}; focused=false; open=false;
 tag=''; className=''; constructor(tag='',className='',text=''){this.tag=tag;this.className=className;this.textContent=text;}
 append(...n:any[]){this.children.push(...n);} replaceChildren(...n:any[]){this.children=n;} setAttribute(k:string,v:string){this.attrs[k]=v;} addEventListener(k:string,f:Function){this.listeners[k]=f;} focus(){this.focused=true;} showModal(){this.open=true;} close(){this.open=false;this.listeners.close?.();} remove(){} querySelectorAll(){return this.children.filter(n=>n.tag==='button');}
}
function fixture(data:any={}) {
 assert.ok(existsSync(path),'recovery module must exist');
 const root=new Node(),body=new Node();const calls:any[]=[];let draft='',conv='chat-a',owner=true,pending=false;
 const api=async(p:string,o:any={})=>{calls.push([p,o]);if(data.error)throw new Error('unavailable');return data[p]??(p==='/jobs'?[]:p==='/team'?{tasks:[]}:p==='/deliveries'?{deliveries:[]}:{});};
 const sandbox:any={document:{createElement:(tag:string)=>new Node(tag),body,activeElement:new Node()},navigator:{clipboard:{writeText:async(s:string)=>{data.copied=s;}}},t:(s:string)=>s};
 runInNewContext(readFileSync(path,'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','' )+'\nthis.createRecovery=createRecovery;',sandbox);
 const recovery=sandbox.createRecovery({root,api,isOwner:()=>owner,hasPendingChat:()=>pending,getDraft:()=>draft,getConversation:()=>conv,useDraft:(s:string)=>{draft=s;}});
 const all=(n:any):any[]=>[n,...n.children.flatMap(all)];const button=(text:string)=>all(body).concat(all(root)).find(n=>n.tag==='button'&&n.textContent===text);
 return {root,body,calls,data,recovery,button,all,setDraft:(s:string)=>draft=s,getDraft:()=>draft,setConv:(s:string)=>conv=s,setPending:(v:boolean)=>pending=v,setOwner:(v:boolean)=>owner=v};
}
test('Q3 Recovery renders held and unknown states without asserting global delivery guarantees',async()=>{const f=fixture({'/deliveries':{deliveries:[{id:'x',bridge:'telegram',state:'outcome_unknown'},{id:'y',bridge:'discord',state:'queued',held:true}]}});await f.recovery.refresh();const text=f.all(f.root).map(n=>n.textContent).join(' ');assert.match(text,/Outcome unknown/);assert.match(text,/Queued — held/);assert.match(text,/plugins/i);assert.doesNotMatch(text,/exactly.once guaranteed/i);});
test('Q3 restart review never sends and preserves a current draft and conversation',async()=>{const f=fixture({'/jobs/1/recovery':{draft:'historical task',conversationId:'chat-a',warning:'May repeat effects'}});f.setDraft('my unsent words');await f.recovery.reviewJob(1);assert.equal(f.getDraft(),'my unsent words');assert.equal(f.button('Use in chat').disabled,true);await f.button('Copy').listeners.click();assert.equal(f.data.copied,'historical task');assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/jobs/1/recovery');});
test('Q3 explicit use fills only same empty conversation and does not submit',async()=>{const f=fixture({'/jobs/2/recovery':{draft:'reviewed task',conversationId:'chat-a'}});await f.recovery.reviewJob(2);await f.button('Use in chat').listeners.click();assert.equal(f.getDraft(),'reviewed task');assert.equal(f.calls.length,1);});
test('Q3 conversation changes and late drafts fail closed at click time',async()=>{const f=fixture({'/jobs/2/recovery':{draft:'task',conversationId:'chat-a'}});await f.recovery.reviewJob(2);f.setConv('other');await f.button('Use in chat').listeners.click();assert.equal(f.getDraft(),'');assert.match(f.all(f.body).map(n=>n.textContent).join(' '),/draft|conversation/);});
test('Q3 prohibited roles make no requests or recovery controls',async()=>{const f=fixture();f.setOwner(false);await f.recovery.refresh();await f.recovery.reviewJob(1);assert.equal(f.calls.length,0);assert.equal(f.root.children.length,0);});
test('Q3 delivery resolution sends original state CAS and distinguishes human evidence',async()=>{const f=fixture({'/deliveries':{deliveries:[{id:'x',state:'outcome_unknown',bridge:'telegram'}]}});await f.recovery.refresh();await f.button('I confirmed receipt').listeners.click();const c=f.calls.find(x=>x[0]==='/deliveries/x/resolve');assert.deepEqual(JSON.parse(JSON.stringify(c[1].body)),{expectedState:'outcome_unknown',decision:'confirmed_received'});});
test('Q3 interrupted team requires explicit risk acknowledgment',async()=>{const f=fixture({'/team':{tasks:[{id:3,status:'interrupted',goal:'task'}]}});await f.recovery.refresh();await f.button('Resume team').listeners.click();const confirm=f.button('Resume after acknowledgment');assert.equal(confirm.disabled,true);const check=f.all(f.body).find(n=>n.tag==='input');check.checked=true;check.listeners.change();await confirm.listeners.click();assert.equal(f.calls.find(x=>x[0]==='/team/3/resume')[1].body.acknowledgeUnknown,true);});
test('Q3 failed review does not provide copy or executable draft',async()=>{const f=fixture({error:true});await f.recovery.reviewJob(1);assert.equal(f.button('Copy'),undefined);assert.match(f.all(f.root).map(n=>n.textContent).join(' '),/unavailable/i);});
test('Q3 attachment-only review displays safe metadata without executable draft',async()=>{const f=fixture({'/deliveries':{deliveries:[{id:'x',state:'queued',held:true,bridge:'telegram'}]},'/deliveries/x/review':{text:'',attachments:[{name:'fixture.txt',mime:'text/plain',size:9}]}});await f.recovery.refresh();await f.button('Review message').listeners.click();assert.match(f.all(f.body).map(n=>n.textContent).join(' '),/fixture.txt/);assert.equal(f.button('Use in chat').disabled,true);assert.equal(f.getDraft(),'');});
test('Q3 stale resolution errors remain visible without claiming confirmation',async()=>{const f=fixture({'/deliveries':{deliveries:[{id:'x',state:'outcome_unknown',bridge:'telegram'}]}});await f.recovery.refresh();f.data.error=true;await f.button('I confirmed receipt').listeners.click();assert.match(f.all(f.root).map(n=>n.textContent).join(' '),/Recovery unavailable/);assert.doesNotMatch(f.all(f.root).map(n=>n.textContent).join(' '),/Human confirmed receipt/);});
test('Q3 late unsent draft and empty review remain protected',async()=>{const f=fixture({'/jobs/2/recovery':{draft:'task',conversationId:'chat-a'}});await f.recovery.reviewJob(2);f.setDraft('late draft');await f.button('Use in chat').listeners.click();assert.equal(f.getDraft(),'late draft');});
test('Q3 failed review opens a visible accessible error dialog and restores focus',async()=>{const f=fixture({error:true});await f.recovery.reviewJob(1);const d=f.body.children.find(n=>n.tag==='dialog');assert.ok(d,'chat launch errors must be visible even when Settings is closed');assert.equal(d.attrs['aria-labelledby'],'recovery-dialog-title');assert.match(f.all(d).map(n=>n.textContent).join(' '),/unavailable/);await f.button('Close').listeners.click();assert.equal(d.open,false);});
test('Q3 even a whitespace-only existing draft is preserved',async()=>{const f=fixture({'/jobs/2/recovery':{draft:'task',conversationId:'chat-a'}});f.setDraft('  ');await f.recovery.reviewJob(2);assert.equal(f.button('Use in chat').disabled,true);assert.equal(f.getDraft(),'  ');});

test('Q3 pending attachments, edits or chat activity block draft placement',async()=>{const f=fixture({'/jobs/2/recovery':{draft:'task',conversationId:'chat-a'}});f.setPending(true);await f.recovery.reviewJob(2);assert.equal(f.button('Use in chat').disabled,true);assert.equal(f.getDraft(),'');});
test('Q3 real app recovery wiring blocks a reopened server run and rechecks watch at placement', async () => {
 const appSource=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
 const wiring=/const recovery = createRecovery\([\s\S]*?\n\}\);/.exec(appSource)?.[0];
 assert.ok(wiring,'actual app recovery wiring exists');
 const root=new Node(),body=new Node(),input=new Node(),settings=new Node();
 const state={currentId:'chat-a',photos:[],docs:[],editing:null,streaming:null,watch:42};
 const sandbox:any={state,api:async()=>({draft:'reviewed restart',conversationId:'chat-a'}),isMember:()=>false,
  $:(selector:string)=>({'#recovery-content':root,'#input':input,'#settings':settings})[selector],
  document:{createElement:(tag:string)=>new Node(tag),body:Object.assign(body,{classList:{contains:()=>false}}),activeElement:new Node()},
  t:(s:string)=>s,navigator:{clipboard:{writeText:async()=>{}}}};
 runInNewContext(readFileSync(path,'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','')+'\n'+wiring+'\nthis.recovery=recovery;',sandbox);
 const all=(n:any):any[]=>[n,...n.children.flatMap(all)];
 const use=()=>all(body).filter(n=>n.tag==='button'&&n.textContent==='Use in chat').at(-1);
 await sandbox.recovery.reviewJob(2);
 assert.equal(use().disabled,true,'server watch without local streaming must keep recovery copy-only');
 state.watch=0;await sandbox.recovery.reviewJob(2);
 assert.equal(use().disabled,false,'idle current conversation permits explicit draft use');
 state.watch=42;await use().listeners.click();
 assert.equal(input.value,'','server activity starting after preview must still block placement');
});
test('Q3 command restart shows the actual timeout-only warning without agent budget claims',async()=>{const warning='This restarts the whole command. Previous effects may already have happened. The timeout is the execution bound; this command has no token or dollar cap. Review before sending; current chat policies and approvals still apply.';const f=fixture({'/jobs/2/recovery':{draft:'command data',conversationId:'chat-a',warning}});await f.recovery.reviewJob(2);const text=f.all(f.body).map(n=>n.textContent).join(' ');assert.match(text,/timeout is the execution bound/);assert.doesNotMatch(text,/separate bounded budget/);});
test('Q3 delivery pagination keeps earlier unknowns reachable and preserves state CAS',async()=>{
 const f=fixture({'/deliveries':{deliveries:[{id:'old',state:'outcome_unknown',bridge:'telegram'}],nextCursor:'100'},'/deliveries?filter=unresolved&cursor=100':{deliveries:[{id:'later',state:'queued',held:true,bridge:'discord'}],nextCursor:null}});
 await f.recovery.refresh();assert.ok(f.button('Load more deliveries'));await f.button('Load more deliveries').listeners.click();
 assert.equal(f.all(f.root).filter(n=>n.tag==='button'&&n.textContent==='I confirmed receipt').length,2,'both pages remain available');
 await f.button('I confirmed receipt').listeners.click();assert.equal(f.calls.find(x=>x[0]==='/deliveries/old/resolve')[1].body.expectedState,'outcome_unknown');
 assert.equal(f.all(f.root).filter(n=>n.tag==='button'&&n.textContent==='I confirmed receipt').length,1,'resolved old item removed without losing later page');
 assert.equal(f.button('Load more deliveries'),undefined);
});
test('Q3 all-history filter and refresh reset pagination without mixing pages',async()=>{
 const f=fixture({'/deliveries':{deliveries:[{id:'unknown',state:'outcome_unknown',bridge:'telegram'}],nextCursor:'100'},'/deliveries?filter=all':{deliveries:[{id:'acked',state:'acknowledged',bridge:'discord'}],nextCursor:null}});
 await f.recovery.refresh();await f.button('All history').listeners.click();assert.match(f.all(f.root).map(n=>n.textContent).join(' '),/Platform acknowledged/);assert.equal(f.button('Load more deliveries'),undefined);assert.equal(f.button('All history').attrs['aria-pressed'],'true');
 await f.button('Unresolved').listeners.click();assert.ok(f.button('Load more deliveries'));await f.button('Refresh recovery').listeners.click();assert.equal(f.calls.at(-1)[0],'/deliveries');
});
test('Q3 load-more failure preserves prior rows and offers a retry with visible error',async()=>{
 const f=fixture({'/deliveries':{deliveries:[{id:'old',state:'outcome_unknown',bridge:'telegram'}],nextCursor:'100'}});await f.recovery.refresh();f.data.error=true;await f.button('Load more deliveries').listeners.click();assert.match(f.all(f.root).map(n=>n.textContent).join(' '),/Recovery unavailable/);assert.ok(f.button('I confirmed receipt'));assert.equal(f.button('Load more deliveries').disabled,false);
});
test('Q3 actual app draft placement closes Recovery, Today and Settings before focusing chat', async()=>{
 const wiring=/const recovery = createRecovery\([\s\S]*?\n\}\);/.exec(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'))![0];
 const root=new Node(),body=new Node(),input=new Node(),settings=new Node();settings.open=true;let today=true;let dialog:Node|undefined;const focus:any[]=[];
 (input as any).dispatchEvent=()=>{};input.focus=()=>{focus.push({recoveryOpen:dialog?.open,today,settingsOpen:settings.open});};
 const sandbox:any={state:{currentId:'chat-a',photos:[],docs:[],editing:null,streaming:null,watch:null},api:async()=>({draft:'reviewed restart',conversationId:'chat-a'}),isMember:()=>false,
 $:(q:string)=>({'#recovery-content':root,'#input':input,'#settings':settings})[q],todayOpen:()=>today,closeToday:()=>{today=false;},Event:class{},
 document:{createElement:(tag:string)=>{const n=new Node(tag);if(tag==='dialog')dialog=n;return n;},body:Object.assign(body,{classList:{contains:()=>false}}),activeElement:new Node()},t:(s:string)=>s};
 runInNewContext(readFileSync(path,'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','')+'\n'+wiring+'\nthis.recovery=recovery;',sandbox);
 await sandbox.recovery.reviewJob(2);const all=(n:any):any[]=>[n,...n.children.flatMap(all)];await all(body).find(n=>n.tag==='button'&&n.textContent==='Use in chat').listeners.click();
 assert.equal(input.value,'reviewed restart');assert.deepEqual(focus,[{recoveryOpen:false,today:false,settingsOpen:false}]);
});
test('Q3 live queued deliveries may still send and cannot be human-resolved',async()=>{
 for(const held of [false,undefined]){const f=fixture({'/deliveries':{deliveries:[{id:'live',state:'queued',held,bridge:'telegram'}]},'/deliveries/live/review':{text:'live message'}});await f.recovery.refresh();const text=f.all(f.root).map(n=>n.textContent).join(' ');assert.match(text,/Queued — waiting; may still send/);assert.doesNotMatch(text,/Held after interruption/);assert.equal(f.button('I confirmed receipt'),undefined);assert.equal(f.button('I confirmed no receipt'),undefined);assert.equal(f.button('Dismiss review'),undefined);await f.button('Review message').listeners.click();assert.match(f.all(f.body).map(n=>n.textContent).join(' '),/still in the live queue/);}
});
test('Q3 only explicitly held queued records offer human resolution',async()=>{
 const f=fixture({'/deliveries':{deliveries:[{id:'held',state:'queued',held:true,bridge:'telegram'}]}});await f.recovery.refresh();assert.match(f.all(f.root).map(n=>n.textContent).join(' '),/Queued — held/);assert.ok(f.button('I confirmed receipt'));await f.button('I confirmed no receipt').listeners.click();assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(x=>x[0]==='/deliveries/held/resolve')[1].body)),{expectedState:'queued',decision:'confirmed_not_received'});
});
test('Q3 unavailable delivery payload has no dead review action but retains human resolution',async()=>{
 const f=fixture({'/deliveries':{deliveries:[{id:'no-payload',state:'outcome_unknown',reviewAvailable:false,bridge:'telegram'}]}});await f.recovery.refresh();assert.equal(f.button('Review message'),undefined);assert.ok(f.button('I confirmed receipt'));
});
test('Q3 All history resolution removes review action and retains original transport state',async()=>{
 const f=fixture({'/deliveries':{deliveries:[]},'/deliveries?filter=all':{deliveries:[{id:'old',state:'outcome_unknown',reviewAvailable:true,bridge:'telegram'}]}});await f.recovery.refresh();await f.button('All history').listeners.click();assert.ok(f.button('Review message'));await f.button('I confirmed receipt').listeners.click();assert.equal(f.button('Review message'),undefined);const text=f.all(f.root).map(n=>n.textContent).join(' ');assert.match(text,/Outcome unknown/);assert.match(text,/Human confirmed receipt/);assert.doesNotMatch(text,/Platform acknowledged — not proof/);
});
test('Q3 async disabled launch button restores exact opener after Escape focus loss',async()=>{
 const root=new Node(),body=new Node();let active:any=body;const data={'/jobs':[{id:1,status:'interrupted',recovery:{mode:'restart-review'}}],'/team':{tasks:[]},'/deliveries':{deliveries:[]},'/jobs/1/recovery':{draft:'review data',conversationId:'chat-a'}};
 const create=(tag:string)=>{const n=new Node(tag);let disabled=false;Object.defineProperty(n,'disabled',{get:()=>disabled,set:(value:boolean)=>{disabled=value;if(value&&active===n)active=body;}});n.focus=()=>{if(!disabled)active=n;};return n;};
 const sandbox:any={document:{createElement:create,body,get activeElement(){return active;}},t:(s:string)=>s,setTimeout,queueMicrotask,navigator:{}};
 runInNewContext(readFileSync(path,'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','')+'\nthis.createRecovery=createRecovery;',sandbox);
 const recovery=sandbox.createRecovery({root,api:async(p:keyof typeof data)=>{await Promise.resolve();return data[p];},isOwner:()=>true,getDraft:()=>'',getConversation:()=> 'chat-a',useDraft:()=>{}});
 await recovery.refresh();const all=(n:any):any[]=>[n,...n.children.flatMap(all)];const launch=all(root).find(n=>n.tag==='button'&&n.textContent==='Review restart');launch.focus();await launch.listeners.click();const dialog=all(body).find(n=>n.tag==='dialog');assert.ok(dialog.open);dialog.close();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(active,launch,'Escape close must restore actual opener, not body after disable');assert.equal(launch.disabled,false);
});
