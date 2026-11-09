import { plugin } from './sara-plugin.mjs';
import { compareContracts } from './contract-diff.mjs';
import { closed, boundedResult, boundedJSON } from './validation.mjs';
import { labels } from './labels.mjs';
const document={type:'object',description:'Explicit bounded OpenAPI 3.0/3.1 JSON document; supported subset only. Local refs only; 256 KiB, depth 32, 12000 nodes. Unsupported constraints are refused.',required:['openapi','info','paths'],properties:{openapi:{type:'string',pattern:'^3\\.(0|1)\\.[0-9]+$'},info:{type:'object',required:['title','version'],properties:{title:{type:'string',maxLength:8192},version:{type:'string',maxLength:8192}}},paths:{type:'object',description:'OpenAPI path items with operations, parameters, requestBody and responses.'},components:{type:'object',description:'Local schemas, parameters, requestBodies and responses only.'}},additionalProperties:true};
const parameters={type:'object',additionalProperties:false,required:['before','after'],properties:{before:document,after:document}};
const tool={name:'compare',description:labels('en').description,parameters,permission:'ask',run(args,sara){
 const l=labels(sara.lang);
 try {
  boundedJSON(args);closed(args,['before','after']);const r=compareContracts(args.before,args.after);
  const report={...r,summary:r.compatible?l.compatible:l.breaking,scope:l.scope,evidence:{kind:'explicit-documents',before:'before',after:'after'}};boundedResult(report);
  const lines=[report.summary,`${l.count}: ${r.findings.length}`,l.scope];
  if(r.findings.length){const f=r.findings[0],e=`${l.evidence}: before#${f.before} → after#${f.after}`;if(e.length<=200)lines.push(e);}
  return {content:JSON.stringify(report),card:{title:l.name,lines}};
 }catch(e){const code=/^[a-z][a-z0-9-]{1,60}$/.test(e?.message??'')?e.message:'analysis-refused';throw new Error(`${l.error}: ${code}`);}
}};
plugin({tools:[tool],init(sara){tool.description=labels(sara.lang).description;}});
