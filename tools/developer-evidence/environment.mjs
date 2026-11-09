import {invalid,bounded,quotedToken,parseEvidenceJSON} from './safety.mjs';
export function checkEnvironment({format,text,rules}) {
 if(typeof text!=='string'||text.length>100000||!Array.isArray(rules)||!rules.length||rules.length>100)invalid();
 const names=new Set();for(const r of rules){if(!r||typeof r.name!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(r.name)||names.has(r.name)||!['string','integer','boolean','url','enum'].includes(r.type)||typeof r.required!=='boolean'||typeof r.secret!=='boolean'||Object.keys(r).some(k=>!['name','type','required','secret','min','max','minLength','values'].includes(k)))invalid();names.add(r.name);if(r.type==='enum'&&(!Array.isArray(r.values)||!r.values.length||r.values.length>20||r.values.some(v=>typeof v!=='string'||v.length>100)))invalid();for(const k of ['min','max','minLength'])if(r[k]!==undefined&&(!Number.isSafeInteger(r[k])||Math.abs(r[k])>1000000))invalid();if(r.min>r.max||r.minLength<0)invalid();}
 const values=new Map(),locations=new Map();
 if(format==='dotenv'){
  for(const [i,line] of text.split(/\r?\n/).entries()){
   if(!line.trim()||line.trimStart().startsWith('#'))continue;
   const m=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,63})\s*=\s*(.*)$/);if(!m||values.has(m[1]))invalid();let value=m[2];
   if(value.startsWith('"')||value.startsWith("'")){const token=quotedToken(value,0,100000);if(!/^\s*(?:#.*)?$/.test(value.slice(token.end)))invalid();value=token.value;}
   else value=value.replace(/\s+#.*$/,'').trim();
   values.set(m[1],value);locations.set(m[1],i+1);
  }
 }else if(format==='json'){
  let obj;try{obj=parseEvidenceJSON(text);}catch{invalid();}if(!obj||typeof obj!=='object'||Array.isArray(obj))invalid();for(const [key,value] of Object.entries(obj)){if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)||!['string','number','boolean'].includes(typeof value))invalid();values.set(key,value);}
 }else invalid();
 const findings=[];for(const [index,r] of rules.entries()){
  if(!values.has(r.name)){if(r.required)findings.push({rule:index,status:'missing',line:null});continue;}
  const value=values.get(r.name),s=String(value);let ok=false;
  if(r.type==='string')ok=typeof value==='string'&&s.length>=(r.minLength??0);
  if(r.type==='integer')ok=/^-?(?:0|[1-9]\d*)$/.test(s)&&Number.isSafeInteger(Number(s))&&Number(s)>=(r.min??-Number.MAX_SAFE_INTEGER)&&Number(s)<=(r.max??Number.MAX_SAFE_INTEGER);
  if(r.type==='boolean')ok=['true','false'].includes(s);
  if(r.type==='enum')ok=r.values.includes(s);
  if(r.type==='url'){try{const url=new URL(s);ok=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{ok=false;}}
  if(!ok)findings.push({rule:index,status:'invalid',line:locations.get(r.name)??null});
 }
 // Only rule indices, status and source locations leave this handler. Even names may contain a private value.
 return bounded({valid:!findings.length,complete:true,checked:rules.length,unknownKeys:[...values.keys()].filter(k=>!names.has(k)).length,findings});
}
