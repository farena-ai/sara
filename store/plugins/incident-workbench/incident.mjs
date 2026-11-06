import {scopedFiles,redactor,invalid,bounded,timeStatus} from './safety.mjs';
export function buildIncident({files,incident,sensitiveValues,limit}) {
 scopedFiles(files);if(typeof incident!=='string'||!incident.length||incident.length>100||!Number.isInteger(limit)||limit<1||limit>100)invalid();
 const redact=redactor(files,sensitiveValues),events=[],ordering=new WeakMap();
 for(const f of files){if(!['deployment','metric','alert','operator-note','recovery','cause-claim'].includes(f.kind))invalid();for(const [i,line] of f.text.split(/\r?\n/).entries()){
  if(!line.trim())continue;let obj;try{obj=JSON.parse(line);}catch{invalid();}
  if(!obj||typeof obj!=='object'||Array.isArray(obj)||typeof obj.event!=='string'||obj.event.length>2000||typeof obj.incident!=='string'||Object.keys(obj).some(k=>!['timestamp','event','incident'].includes(k)))invalid();
  if(obj.incident!==incident)continue;
  const status=timeStatus(obj.timestamp);events.push({path:redact(f.path),line:i+1,kind:f.kind,event:redact(obj.event),timestamp:typeof obj.timestamp==='string'?redact(obj.timestamp):null,timeStatus:status,utc:status==='zoned'?redact(new Date(obj.timestamp).toISOString()):null});
  ordering.set(events.at(-1),{epoch:Date.parse(obj.timestamp),path:f.path,line:i+1});
 }}
 const timeline=events.filter(e=>e.timeStatus==='zoned').sort((a,b)=>{const x=ordering.get(a),y=ordering.get(b);return x.epoch-y.epoch||x.path.localeCompare(y.path)||x.line-y.line;}),unordered=events.filter(e=>e.timeStatus!=='zoned');
 // Claims remain cited claims; temporal sequence is not a causal inference.
 const causeClaims=events.filter(e=>e.kind==='cause-claim'),recoveryClaims=events.filter(e=>e.kind==='recovery');
 return bounded({complete:events.length<=limit&&unordered.length===0&&events.length>0,totalEvents:events.length,timeline:timeline.slice(0,limit),unordered:unordered.slice(0,Math.max(0,limit-Math.min(timeline.length,limit))),cause:null,recovery:null,causeClaims,recoveryClaims,missingEvidence:[...(!causeClaims.length?['cause']:[]),...(!recoveryClaims.length?['recovery']:[])]});
}
