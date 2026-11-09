const fail=()=>{throw new Error('Invalid supplied coverage');};
const pathOK=p=>typeof p==='string'&&p.length<=160&&/^[\w.-]+(?:\/[\w.-]+)*$/.test(p)&&!p.split('/').some(x=>x==='.'||x==='..');
export function analyzeCoverage({lcov,sources,changes}) {
 if(typeof lcov!=='string'||lcov.length>100000||!Array.isArray(sources)||sources.length>20||!Array.isArray(changes)||changes.length>100)fail();
 const source=new Map();for(const s of sources){if(!pathOK(s.path)||source.has(s.path)||typeof s.text!=='string'||s.text.length>30000)fail();source.set(s.path,s.text.split(/\r?\n/));}
 for(const c of changes)if(!source.has(c.path)||!Number.isSafeInteger(c.start)||!Number.isSafeInteger(c.end)||c.start<1||c.end<c.start||c.end>source.get(c.path).length)fail();
 const files=[],branches=[];let current=null;
 const number=s=>{if(!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s)))fail();return Number(s);};
 for(const [index,line] of lcov.split(/\r?\n/).entries()) {
  if(!line||line.startsWith('TN:'))continue;
  if(line.startsWith('SF:')) {const path=line.slice(3);if(current||!pathOK(path)||!source.has(path)||files.some(f=>f.path===path))fail();current={path,lines:[],branches:[],functions:new Map(),hits:new Map(),totals:{}};files.push(current);continue;}
  if(!current)fail();
  if(line==='end_of_record'){
   const t=current.totals;if(current.functions.size!==current.hits.size||[...current.hits.keys()].some(k=>!current.functions.has(k)))fail();for(const [key,actual] of [['FNF',current.functions.size],['FNH',[...current.hits.values()].filter(n=>n>0).length],['BRF',current.branches.length],['BRH',current.branches.filter(b=>b.count>0).length],['LF',current.lines.length],['LH',current.lines.filter(b=>b.count>0).length]])if(t[key]!==undefined&&t[key]!==actual)fail();current=null;continue;
  }
  const [kind,...rest]=line.split(':');const val=rest.join(':');
  if(kind==='BRDA'||kind==='DA'){
   const parts=val.split(',');if(parts.length!==(kind==='BRDA'?4:2))fail();const loc=number(parts[0]);if(loc<1||loc>source.get(current.path).length)fail();
   const count=kind==='BRDA'&&parts[3]==='-'?null:number(parts.at(-1));
   const entry={path:current.path,sourceLine:loc,count,lcovLine:index+1,changed:changes.some(c=>c.path===current.path&&loc>=c.start&&loc<=c.end)};
   if(kind==='BRDA'){entry.block=number(parts[1]);entry.branch=number(parts[2]);if(current.branches.some(b=>b.sourceLine===loc&&b.block===entry.block&&b.branch===entry.branch))fail();current.branches.push(entry);branches.push(entry);}
   else {if(current.lines.some(b=>b.sourceLine===loc))fail();current.lines.push(entry);}
  }else if(['BRF','BRH','LF','LH','FNF','FNH'].includes(kind)){if(current.totals[kind]!==undefined)fail();current.totals[kind]=number(val);}
  else if(kind==='FN'||kind==='FNDA'){
   const comma=val.indexOf(',');if(comma<1)fail();const n=number(val.slice(0,comma)),name=val.slice(comma+1);if(!name||name.length>200||/[\x00-\x1f\x7f]/.test(name))fail();
   const map=kind==='FN'?current.functions:current.hits;if(map.size>=2000||map.has(name))fail();if(kind==='FN'&&(n<1||n>source.get(current.path).length))fail();map.set(name,n);
  }else fail();
 }
 if(current||!files.length)fail();
 const result={complete:files.length===sources.length&&files.every(f=>f.branches.length>0&&f.branches.every(b=>b.count!==null)),files:files.map(f=>({path:f.path,branchStatus:f.branches.length?(f.branches.every(b=>b.count>0)?'covered':'partial'):'missing',lines:f.lines})),branches};
 if(JSON.stringify(result).length>24000)fail();return result;
}
