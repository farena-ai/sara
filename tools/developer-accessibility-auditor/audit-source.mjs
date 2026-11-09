// Bounded HTML5 structural analysis. No rendering, accessible-name algorithm or WCAG verdict.
import {parse,defaultTreeAdapter} from './node_modules/parse5/dist/index.js';
import {createHash} from 'node:crypto';
const HTML='http://www.w3.org/1999/xhtml';
const TAGS=new Set('html head title base link meta style body article section nav aside h1 h2 h3 h4 h5 h6 header footer address main p hr pre blockquote ol ul menu li dl dt dd figure figcaption div a em strong small s cite q dfn abbr ruby rt rp data time code var samp kbd sub sup i b u mark bdi bdo span br wbr ins del picture source img iframe embed object param video audio track map area table caption colgroup col tbody thead tfoot tr td th form label input button select datalist optgroup option textarea output progress meter fieldset legend details summary dialog script noscript template slot canvas'.split(' '));
const REFATTRS=['aria-labelledby','aria-describedby','aria-controls','aria-owns','aria-activedescendant','aria-details','aria-errormessage','aria-flowto'];
const SPACE=/[\t\n\f\r ]+/;
function refuse(){throw Error('Bounded structural audit refused');}
function admit(value){
 if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)refuse();
 const keys=Reflect.ownKeys(value);if(keys.length!==1||keys[0]!=='html')refuse();
 const d=Object.getOwnPropertyDescriptor(value,'html');if(!d||!('value'in d)||!d.enumerable||typeof d.value!=='string'||d.value.length===0||d.value.length>6000)refuse();
 const html=d.value;if(Buffer.byteLength(html)>24000||JSON.stringify({html}).length>40000)refuse();return html;
}
export function audit(value){
 const started=performance.now(),html=admit(value);let allocations=0,parseErrors=0;
 // Stop parser allocations during parsing, not only after tree construction.
 const adapter={...defaultTreeAdapter};for(const key of ['createElement','createTextNode','createCommentNode','createDocumentFragment']){const original=adapter[key];adapter[key]=(...args)=>{if(++allocations>768)refuse();return original(...args);};}
 const root=parse(html,{treeAdapter:adapter,sourceCodeLocationInfo:true,onParseError:()=>{if(++parseErrors>32)refuse();}});
 const nodes=[],records=new Map(),ids=new Map(),unsupported=new Set();let count=0,ordinal=0;
 if(parseErrors)unsupported.add('html5-repair');
 function walk(n,depth,hidden,inTemplate){
  if(++count>512||depth>32||performance.now()-started>500)refuse();
  const attrs=new Map((n.attrs??[]).map(a=>[a.name,a.value]));const tag=n.tagName;
  if(tag){
   const entry={n,tag,attrs,ordinal:++ordinal,hidden:hidden||attrs.has('hidden')||attrs.has('inert')||attrs.get('aria-hidden')?.toLowerCase()==='true',inTemplate};nodes.push(entry);records.set(n,entry);
   if(!inTemplate&&attrs.has('id')&&attrs.get('id')){const id=attrs.get('id');if(id.length>256)refuse();ids.set(id,[...(ids.get(id)??[]),entry]);}
   if(!inTemplate){if(!TAGS.has(tag)||n.namespaceURI!==HTML)unsupported.add('unknown-or-foreign-element');if(['style','link'].includes(tag)||attrs.has('style')||attrs.has('class'))unsupported.add('css-visibility');if(tag==='script'||tag==='noscript'||[...attrs.keys()].some(k=>k.startsWith('on')))unsupported.add('script-behavior');if(['iframe','object','embed','canvas','slot','audio','video','details','dialog'].includes(tag))unsupported.add('rendered-or-interactive-semantics');if(attrs.has('shadowrootmode'))unsupported.add('shadow-dom');if(attrs.has('role')&&!['presentation','none','img','button'].includes(attrs.get('role')))unsupported.add('role-semantics');}
   hidden=entry.hidden;
  }
  for(const c of n.childNodes??[])walk(c,depth+1,hidden,inTemplate);
  if(n.content)walk(n.content,depth+1,true,true);
 }
 walk(root,0,false,false);
 const htmlNode=nodes.find(n=>n.tag==='html');if(!htmlNode?.n.sourceCodeLocation?.startTag)refuse();
 const findings=[];
 function evidence(e){const l=e.n.sourceCodeLocation?.startTag;if(!l){unsupported.add('implicit-element');return null;}return {tag:TAGS.has(e.tag)&&e.n.namespaceURI===HTML?e.tag:'other',ordinal:e.ordinal,line:l.startLine,column:l.startCol,offset:l.startOffset,endOffset:l.endOffset};}
 function finding(e,rule){const element=evidence(e);if(!element)return;if(findings.length>=64)refuse();findings.push({rule,status:'static-finding',element});}
 // Only simple text/alt presence is proven. Author naming on subtrees requires
 // a browser: do not turn an incomplete name computation into certain absence.
 function text(n,includeHidden=false){
  if(n.nodeName==='#text')return n.value.trim()?'present':'absent';
  const e=records.get(n);if(e&&(e.inTemplate||(!includeHidden&&e.hidden)||['script','style','template'].includes(e.tag)))return 'absent';
  if(e&&['aria-label','aria-labelledby','title'].some(k=>e.attrs.has(k))){unsupported.add('author-named-subtree');return 'unknown';}
  if(e&&e.tag==='img')return e.attrs.get('alt')?.trim()?'present':'absent';
  const children=(n.childNodes??[]).map(c=>text(c,includeHidden));
  return children.includes('unknown')?'unknown':children.includes('present')?'present':'absent';
 }
 function refs(e,attr){const s=e.attrs.get(attr);if(s===undefined)return null;if(s.length>512)refuse();const list=s.split(SPACE).filter(Boolean);if(list.length>16)refuse();return list;}
 // A deliberately partial name-presence check: never claim a complete accessible name.
 function namePresence(e){
  const list=refs(e,'aria-labelledby');
  if(list?.length){let resolved=false,present=false,unknown=false;for(const id of list){const targets=ids.get(id)??[];if(targets.length>1){unsupported.add('ambiguous-name-reference');unknown=true;}else if(targets.length===1){resolved=true;const target=targets[0],p=text(target.n,target.hidden);if(p==='present')present=true;if(p==='unknown')unknown=true;}}if(unknown)return 'unknown';if(resolved){if(present)return 'present';unsupported.add('empty-name-reference');return 'unknown';}}
  if(e.attrs.get('aria-label')?.trim()||e.attrs.get('title')?.trim())return 'present';
  if(e.tag==='img')return e.attrs.has('alt')?'present':'absent';
  if(e.attrs.has('placeholder')){unsupported.add('placeholder-name-fallback');return 'unknown';}
  if(e.tag==='button'){
   const p=text({childNodes:e.n.childNodes});if(p!=='absent')return p;
   if((e.n.childNodes??[]).some(c=>c.tagName&&!['span','b','i','em','strong','img','br'].includes(c.tagName))){unsupported.add('complex-name-subtree');return 'unknown';}
  }
  const id=e.attrs.get('id');if(id&&(ids.get(id)?.length??0)>1){unsupported.add('ambiguous-label-target');return 'unknown';}
  for(const label of nodes.filter(n=>n.tag==='label'&&!n.inTemplate)){
   const explicit=label.attrs.has('for');let targets=false;
   if(explicit)targets=!!id&&label.attrs.get('for')===id;
   else {
    // HTML label.control: the first labelable descendant, not every nested control.
    const stack=[...(label.n.childNodes??[])].reverse();let first=null;
    while(stack.length){const n=stack.pop(),r=records.get(n);if(r&&['button','input','meter','output','progress','select','textarea'].includes(r.tag)&&!(r.tag==='input'&&r.attrs.get('type')?.toLowerCase()==='hidden')){first=n;break;}if(n.tagName!=='template')stack.push(...[...(n.childNodes??[])].reverse());}
    targets=first===e.n;
   }
   if(targets){const p=text(label.n,label.hidden);if(p!=='absent')return p;}
  }
  return 'absent';
 }
 if(!htmlNode.attrs.get('lang')?.trim())finding(htmlNode,'document-lang-missing');
 for(const e of nodes){
  if(e.inTemplate||e.hidden)continue;
  if(e.attrs.get('id')&&(ids.get(e.attrs.get('id'))?.length??0)>1)finding(e,'id-duplicate');
  for(const attr of REFATTRS){const list=refs(e,attr);if(!list)continue;let missing=false,ambiguous=false;for(const id of list){const matches=ids.get(id)??[];if(!matches.length)missing=true;if(matches.length>1)ambiguous=true;}if(missing)finding(e,'aria-ref-missing');if(ambiguous)finding(e,'aria-ref-ambiguous');}
  if(e.n.namespaceURI!==HTML)continue;
  const role=e.attrs.get('role');if(role&&['presentation','none'].includes(role)){
   if(e.tag==='img'&&!e.attrs.has('tabindex')&&![...e.attrs.keys()].some(k=>k.startsWith('aria-')))continue;
   unsupported.add('presentation-role-conflict');continue;
  }
  if(e.tag==='img'&&namePresence(e)==='absent')finding(e,'img-alt-missing');
  if(e.tag==='button'&&namePresence(e)==='absent')finding(e,'button-name-missing');
  if(['input','select','textarea'].includes(e.tag)){
   const type=e.attrs.get('type')?.toLowerCase()??'text';if(e.tag==='input'&&['hidden','submit','reset','button','image'].includes(type)){if(type!=='hidden')unsupported.add('special-input-name');continue;}
   if(e.tag==='input'&&!['text','email','password','search','tel','url','number','checkbox','radio'].includes(type)){unsupported.add('special-input-name');continue;}
   if(namePresence(e)==='absent')finding(e,'control-label-missing');
  }
 }
 const report={mode:'static-structural',coverage:unsupported.size?'requires-browser':'bounded-structural-only',sourceSha256:createHash('sha256').update(html).digest('hex'),sourceUnits:html.length,nodeCount:count,findings,unsupported:[...unsupported].sort(),limitations:['not-rendered','not-complete-accessible-name','not-wcag-conformance','contrast-layout-focus-not-tested','no-live-capture-authority']};
 if(performance.now()-started>500||Buffer.byteLength(JSON.stringify(report))>20000)refuse();return report;
}
