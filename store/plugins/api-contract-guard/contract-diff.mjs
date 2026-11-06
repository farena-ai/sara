import { validateDocument, resolve, pointer as ptr, methods, LIMITS, boundedResult, refuse } from './validation.mjs';
// Accepted inputs are contravariant; produced responses are covariant.
export function compareContracts(before, after) {
  validateDocument(before); validateDocument(after);
  const findings = []; let visits=0;
  const add = (code, severity, b, a) => {
    if(findings.some(f=>f.code===code && f.before===b && f.after===a)) return;
    if(findings.length >= LIMITS.findings) refuse('finding-budget');
    findings.push({code,severity,before:b,after:a});
  };
  const resB=(v,p)=>resolve(before,v,p), resA=(v,p)=>resolve(after,v,p), stable=v=>JSON.stringify(v);
  function schema(rawB,rawA,pb,pa,mode,seen=new Set()) {
    if(++visits>LIMITS.nodes) refuse('comparison-budget');
    // Internal booleans represent absent/unrestricted or forbidden fallback, not public boolean schemas.
    if(rawB===false || rawA===false) {
      if(mode==='request' ? rawB!==false : rawA!==false) add('additional-properties-incompatible','breaking',pb,pa);
      return;
    }
    const br=rawB===true?{value:{},at:pb}:resB(rawB,pb),ar=rawA===true?{value:{},at:pa}:resA(rawA,pa),b=br.value,a=ar.value;pb=br.at;pa=ar.at;
    const pair=`${pb}\n${pa}\n${mode}\n${rawB===true}\n${rawA===true}`;if(seen.has(pair)) return;seen=new Set(seen);seen.add(pair);
    const input=mode==='request',subset=(x,y)=>x===y || x==='integer' && y==='number' || y===undefined;
    if(!(input?subset(b.type,a.type):subset(a.type,b.type))) add('type-incompatible','breaking',pb,pa);
    if(input && b.nullable===true && a.nullable!==true || !input && b.nullable!==true && a.nullable===true) add('nullable-incompatible','breaking',pb,pa);
    const be=b.enum,ae=a.enum;
    if(input && ae && (!be || be.some(v=>!ae.some(x=>stable(x)===stable(v))))) add('enum-narrowed','breaking',pb,pa);
    if(!input && be && (!ae || ae.some(v=>!be.some(x=>stable(x)===stable(v))))) add('response-enum-widened','breaking',pb,pa);
    for(const k of ['format','readOnly','writeOnly']) if(stable(b[k])!==stable(a[k])) add('schema-constraint-changed','breaking',pb,pa);
    const bp=b.properties??{},ap=a.properties??{},bre=new Set(b.required??[]),are=new Set(a.required??[]);
    // A named property overrides additionalProperties. Compare its effective schema on BOTH sides.
    // Omitted fallback is unconstrained; use the actual containing pointer when it is implicit.
    const fallback=(s,p)=>({value:s.additionalProperties??true,at:Object.hasOwn(s,'additionalProperties')?`${p}/additionalProperties`:p});
    const effective=(s,props,k,p)=>Object.hasOwn(props,k)?{value:props[k],at:`${p}/properties/${ptr(k)}`}:fallback(s,p);
    for(const k of [...new Set([...Object.keys(bp),...Object.keys(ap)])].sort()) {
      const eb=effective(b,bp,k,pb),ea=effective(a,ap,k,pa);
      if(input && are.has(k) && !bre.has(k)) add('required-field-added','breaking',eb.at,ea.at);
      if(!input && bre.has(k) && !are.has(k)) add('response-required-field-removed','breaking',eb.at,ea.at);
      schema(eb.value,ea.value,eb.at,ea.at,mode,seen);
      if(!Object.hasOwn(bp,k) && Object.hasOwn(ap,k)) add('field-added','compatible',eb.at,ea.at);
    }
    const fb=fallback(b,pb),fa=fallback(a,pa);
    schemaFallback(fb,fa);
    function schemaFallback(x,y) {
      // Unrestricted leaves have no object/array children; avoid recursively expanding them forever.
      if(x.value===true && y.value===true) return;
      schema(x.value,y.value,x.at,y.at,mode,seen);
    }
    if(b.items && a.items) schema(b.items,a.items,`${pb}/items`,`${pa}/items`,mode,seen);
    else if(!b.items && a.items && input || b.items && !a.items && !input) add('items-incompatible','breaking',pb,pa);
  }
  function content(b,a,pb,pa,mode) {
    for(const mime of Object.keys(b??{}).sort()) {
      const pbb=`${pb}/${ptr(mime)}`,paa=`${pa}/${ptr(mime)}`;
      if(!a?.[mime]) {add('media-type-removed','breaking',pbb,pa);continue;}
      const bs=b[mime].schema,as=a[mime].schema;
      if(bs && as) schema(bs,as,`${pbb}/schema`,`${paa}/schema`,mode);
      else if(mode==='request' ? !bs && as : bs && !as) add('schema-incompatible','breaking',pbb,paa);
    }
    for(const mime of Object.keys(a??{}).sort()) if(!b?.[mime]) add('media-type-added',mode==='response' && Object.keys(b??{}).length?'breaking':'compatible',pb,`${pa}/${ptr(mime)}`);
  }
  function parameters(doc,item,op,p) {
    const map=new Map();
    for(const [list,at] of [[item.parameters??[],`${p.slice(0,p.lastIndexOf('/'))}/parameters`],[op.parameters??[],`${p}/parameters`]]) list.forEach((v,i)=>{const r=resolve(doc,v,`${at}/${i}`),id=`${r.value.in}:${r.value.in==='header'?r.value.name.toLowerCase():r.value.name}`;map.set(id,r);});
    return map;
  }
  for(const path of [...new Set([...Object.keys(before.paths),...Object.keys(after.paths)])].sort()) for(const method of methods) {
    const bi=before.paths[path],ai=after.paths[path],b=bi?.[method],a=ai?.[method],p=`/paths/${ptr(path)}`,op=`${p}/${method}`;
    if(b && !a) {add('operation-removed','breaking',op,p);continue;}
    if(!b && a) {add('operation-added','compatible','/paths',op);continue;}
    if(!a) continue;
    const bp=parameters(before,bi,b,op),ap=parameters(after,ai,a,op);
    for(const [id,ar] of ap) {
      const br=bp.get(id);
      if(ar.value.required && !br?.value.required) add('required-parameter-added','breaking',br?.at??op,ar.at);
      if(br) {for(const k of ['style','explode','allowReserved']) if(stable(br.value[k])!==stable(ar.value[k])) add('parameter-encoding-changed','breaking',br.at,ar.at);schema(br.value.schema,ar.value.schema,`${br.at}/schema`,`${ar.at}/schema`,'request');}
      else if(!ar.value.required) add('parameter-added','compatible',op,ar.at);
    }
    for(const [id,br] of bp) if(!ap.has(id)) add('parameter-removed','breaking',br.at,op);
    const bb=b.requestBody?resB(b.requestBody,`${op}/requestBody`):undefined,ab=a.requestBody?resA(a.requestBody,`${op}/requestBody`):undefined;
    if(ab?.value.required && !bb?.value.required) add('required-request-body-added','breaking',bb?.at??op,ab.at);
    if(bb && ab) content(bb.value.content,ab.value.content,`${bb.at}/content`,`${ab.at}/content`,'request');
    else if(bb && !ab) add('request-body-removed','breaking',bb.at,op);
    for(const status of Object.keys(b.responses).sort()) {
      const pbb=`${op}/responses/${status}`;
      if(!a.responses[status]) {add('response-removed','breaking',pbb,`${op}/responses`);continue;}
      const br=resB(b.responses[status],pbb),ar=resA(a.responses[status],pbb);content(br.value.content,ar.value.content,`${br.at}/content`,`${ar.at}/content`,'response');
    }
    for(const status of Object.keys(a.responses).sort()) if(!b.responses[status]) add('response-added','breaking',`${op}/responses`,`${op}/responses/${status}`);
  }
  findings.sort((a,b)=>a.before.localeCompare(b.before,'en') || a.after.localeCompare(b.after,'en') || a.code.localeCompare(b.code,'en'));
  return boundedResult({compatible:!findings.some(f=>f.severity==='breaking'),complete:true,findings});
}
