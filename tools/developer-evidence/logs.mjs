import {scopedFiles,redactor,invalid,bounded,timeStatus} from './safety.mjs';
export function searchLogs({files,query,sensitiveValues,limit}) {
 scopedFiles(files);if(typeof query!=='string'||!query.length||query.length>100||!Number.isInteger(limit)||limit<1||limit>100||files.some(f=>!['line','jsonl'].includes(f.format)))invalid();
 const redact=redactor(files,sensitiveValues);
 const records=[];
 for(const f of files){let prev;for(const [i,line] of f.text.split(/\r?\n/).entries()){
  if(!line)continue;
  if(f.format==='jsonl'){const obj=JSON.parse(line);records.push({path:f.path,line:i+1,endLine:i+1,timestamp:obj.timestamp??null,message:obj.message??'',search:JSON.stringify(obj)});}
  else {const m=line.match(/^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/);if(m){prev={path:f.path,line:i+1,endLine:i+1,timestamp:m[1],message:m[2],search:line};records.push(prev);}else if(prev){prev.message+='\n'+line;prev.search+='\n'+line;prev.endLine=i+1;}else records.push({path:f.path,line:i+1,endLine:i+1,timestamp:null,message:line,search:line});}
 }}
 const matches=records.filter(r=>r.search.toLowerCase().includes(query.toLowerCase()));
 return bounded({complete:matches.length<=limit&&records.every(r=>timeStatus(r.timestamp)==='zoned'),totalMatches:matches.length,matches:matches.slice(0,limit).map(({search,...r})=>({...r,path:redact(r.path),timestamp:r.timestamp?redact(r.timestamp):null,timeStatus:timeStatus(r.timestamp),message:redact(r.message)}))});
}
