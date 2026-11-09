export const invalid=()=>{throw new Error('Invalid supplied evidence');};
export const pathOK=p=>typeof p==='string'&&p.length<=160&&/^[\w.-]+(?:\/[\w.-]+)*$/.test(p)&&!p.split('/').some(x=>['.','..','__proto__','constructor','prototype'].includes(x));
export function scopedFiles(files){if(!Array.isArray(files)||!files.length||files.length>20)invalid();let size=0;const seen=new Set();for(const f of files){if(!pathOK(f.path)||seen.has(f.path)||typeof f.text!=='string'||f.text.length>100000)invalid();seen.add(f.path);size+=f.text.length;}if(size>150000)invalid();}
// Scan a complete bounded quoted token; never treat an escaped delimiter as closure.
export function quotedToken(text,start=0,max=2000){
 const q=text[start];if(q!=='"'&&q!=="'")invalid();let value='',i=start+1;
 for(;i<text.length;i++){
  const c=text[i];if(c===q)return {value,raw:text.slice(start+1,i),end:i+1};
  if(c<' '||value.length>=max||i-start>max*6+2)invalid();
  if(c!=='\\'){value+=c;continue;}
  const e=text[++i],esc={'"':'"',"'":"'",'\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
  if(e==='u'){const hex=text.slice(i+1,i+5);if(!/^[0-9a-fA-F]{4}$/.test(hex))invalid();value+=String.fromCharCode(parseInt(hex,16));i+=4;}
  else if(Object.hasOwn(esc,e))value+=esc[e];else invalid();
 }
 invalid();
}
// Validate every token and decoded member identity before JSON materialization.
export function parseEvidenceJSON(text,onMember=()=>{}){
 if(typeof text!=='string'||text.length>100000)invalid();let i=0,tokens=0;
 const ws=()=>{while(/[\t\r\n ]/.test(text[i]??'!'))i++;};
 function string(){const start=i;if(text[i]!=='"')invalid();const token=quotedToken(text,i,100000);i=token.end;let value;try{value=JSON.parse(text.slice(start,i));}catch{invalid();}return {...token,value};}
 function value(depth){if(depth>15||++tokens>20000)invalid();ws();const c=text[i];
  if(c==='{'){i++;ws();const keys=new Set();if(text[i]==='}'){i++;return;}
   while(true){ws();const key=string().value;if(keys.has(key)||['__proto__','constructor','prototype'].includes(key))invalid();keys.add(key);ws();if(text[i++]!==':')invalid();ws();const start=i;value(depth+1);onMember(key,text.slice(start,i));ws();if(text[i]==='}'){i++;return;}if(text[i++]!==',')invalid();}
  }
  if(c==='['){i++;ws();if(text[i]===']'){i++;return;}while(true){value(depth+1);ws();if(text[i]===']'){i++;return;}if(text[i++]!==',')invalid();}}
  if(c==='"'){string();return;}
  const match=text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!match)invalid();i+=match[0].length;
 }
 value(0);ws();if(i!==text.length)invalid();try{return JSON.parse(text);}catch{invalid();}
}
export function redactor(files,values){
 if(!Array.isArray(values)||values.length>100||values.some(v=>typeof v!=='string'||!v.length||v.length>2000))invalid();const secrets=new Set(values);
 const sensitive=k=>/password|secret|token|authorization|cookie|credential|private.?key|connection.?string/i.test(k);
 function scanAssignments(line){
  const assignments=/\b(?:password|secret|token|authorization|cookie|credential|private.?key|connection.?string)\s*[=:]\s*/gi;
  for(const m of line.matchAll(assignments)){
   const start=m.index+m[0].length;let value;
   if(line[start]==='"'||line[start]==="'"){const token=quotedToken(line,start);if(!/^\s*(?:#.*)?$/.test(line.slice(token.end)))invalid();if(token.raw)secrets.add(token.raw);value=token.value;}
   else {value=line.slice(start).split(/\s/)[0];if(!value||value.length>2000||/^[\[{]/.test(value))invalid();}
   if(value)secrets.add(value);
  }
 }
 for(const f of files)for(const line of f.text.split(/\r?\n/)){
  if(line.trim().startsWith('{')||line.trim().startsWith('['))parseEvidenceJSON(line,(key,raw)=>{
   if(sensitive(key)){if(raw[0]!=='"')invalid();const token=quotedToken(raw);if(token.value)secrets.add(token.value);if(token.raw)secrets.add(token.raw);}
   else if(raw[0]==='"')scanAssignments(JSON.parse(raw));
  });else scanAssignments(line);
 }
 for(const f of files){
  for(const m of f.text.matchAll(/\bBearer\s+([^\s"']+)/gi))secrets.add(m[1]);
  for(const m of f.text.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+):([^\s@/]+)@/gi)){secrets.add(m[1]);secrets.add(m[2]);}
  for(const m of f.text.matchAll(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g)){secrets.add(m[0]);for(const part of m[2].split(/\r?\n/).filter(Boolean))secrets.add(part);}
 }
 const sorted=[...secrets].sort((a,b)=>b.length-a.length);
 return s=>{s=String(s);for(const v of sorted)s=s.split(v).join('[REDACTED]');return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'�');};
}
export function bounded(value){if(Buffer.byteLength(JSON.stringify(value),'utf8')>24000)invalid();return value;}
export function timeStatus(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return 'ambiguous-or-missing';const d=value.slice(0,10);if(new Date(Date.parse(d+'T00:00:00Z')).toISOString().slice(0,10)!==d)return 'ambiguous-or-missing';return 'zoned';}
