import { compareContracts } from './contract-diff.mjs';
import { repoMap, snapshotDocument } from './repo-map.mjs';
import { tools, validateArgs } from './schemas.mjs';
import { closed, boundedResult } from './validation.mjs';
import { checkAbort } from './paths.mjs';
import { labels } from './labels.mjs';
export function serve(input,output,home,locale='en') {
 let phase='new',buffer=Buffer.alloc(0);const active=new Map();
 const write=m=>output.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
 const error=(id,code,message)=>write({id,error:{code,message}});
 async function call(id,p) {
  if(active.size>=2 || active.has(id)) return error(id,-32600,'request-limit-or-duplicate');
  const controller=new AbortController();active.set(id,controller);const deadline=setTimeout(()=>controller.abort(),20000);
  try {
   // Yield once: a same-frame cancellation can prevent all filesystem work.
   await new Promise(r=>setImmediate(r));checkAbort(controller.signal);
   closed(p,['name','arguments']);const args=validateArgs(p.name,p.arguments);const l=labels(args.locale??locale);let result;
   if(p.name==='repo_map') {const {locale:_,...opts}=args;result=await repoMap(home,opts,controller.signal);result.summary=l.map;}
   else {const b=await snapshotDocument(home,args.before,controller.signal),a=await snapshotDocument(home,args.after,controller.signal);checkAbort(controller.signal);result={...compareContracts(b.document,a.document),summary:'',scope:l.scope,evidence:{before:b.evidence,after:a.evidence}};result.summary=result.compatible?l.compatible:l.breaking;}
   checkAbort(controller.signal);boundedResult(result);write({id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
  } catch(e) {
   const code=controller.signal.aborted?'cancelled':safeCode(e);write({id,result:{isError:true,content:[{type:'text',text:`${labels(p?.arguments?.locale??locale).error}: ${code}`}]}});
  }finally{clearTimeout(deadline);active.delete(id);}
 }
 function handle(m) {
  if(!m || m.jsonrpc!=='2.0' || typeof m.method!=='string' || (m.id!==undefined && !(typeof m.id==='number' && Number.isSafeInteger(m.id) || typeof m.id==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(m.id)))) return error(null,-32600,'invalid-request');
  const {id,method,params}=m;
  if(method==='notifications/cancelled' && id===undefined) {active.get(params?.requestId)?.abort();return;}
  if(method==='notifications/initialized' && id===undefined && phase==='initializing') {phase='ready';return;}
  if(id===undefined) return;
  if(method==='initialize' && phase==='new') {
   if(params?.protocolVersion!=='2025-06-18') return error(id,-32602,'unsupported-protocol');phase='initializing';write({id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'developer-workbench',version:'0.1.0'}}});return;
  }
  if(method==='shutdown' && phase!=='new') {phase='shutdown';for(const c of active.values())c.abort();write({id,result:null});return;}
  if(phase!=='ready') return error(id,-32000,'not-ready');
  if(method==='tools/list') {try{closed(params??{},[]);}catch{return error(id,-32602,'invalid-parameters');}return write({id,result:{tools:tools(locale)}});}
  if(method==='tools/call') {void call(id,params);return;}
  error(id,-32601,'unknown-method');
 }
 input.on('data',chunk=>{
  buffer=Buffer.concat([buffer,Buffer.from(chunk)]);
  if(buffer.length>524288){error(null,-32600,'input-budget');buffer=Buffer.alloc(0);input.destroy();for(const c of active.values())c.abort();return;}
  let nl;while((nl=buffer.indexOf(10))>=0){const line=buffer.subarray(0,nl);buffer=buffer.subarray(nl+1);if(!line.length)continue;let m;try{m=JSON.parse(line.toString('utf8'));}catch{error(null,-32700,'invalid-json');continue;}try{handle(m);}catch{error(m?.id??null,-32602,'invalid-parameters');}}
 });
 input.on('end',()=>{for(const c of active.values())c.abort();});
}
const safeCode=e=>typeof e?.message==='string' && /^[a-z][a-z0-9-]{1,60}$/.test(e.message)?e.message:'analysis-refused';
