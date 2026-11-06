import {parse,traverse} from './parser.mjs';
import {admit} from './schemas.mjs';
const order=(a,b)=>a<b?-1:a>b?1:0;
// Type syntax is erased, but TS expression wrappers still carry runtime values.
const erased=p=>!!p.findParent(x=>x.isTSType()||x.isTSTypeAnnotation()||x.isTSInterfaceDeclaration()||x.isTSTypeAliasDeclaration());
function valueContext(p){
 while(p.parentPath&&(p.parentPath.isTSAsExpression()||p.parentPath.isTSNonNullExpression()||p.parentPath.isTSTypeAssertion()))p=p.parentPath;
 const parent=p.parentPath;
 if((parent.isCallExpression()||parent.isOptionalCallExpression())&&p.key==='callee')return true;
 if(parent.isExportDefaultDeclaration()&&p.key==='declaration')return true;
 if(parent.isVariableDeclarator()&&p.key==='init'&&parent.node.id.type==='Identifier')return parent.scope.getBinding(parent.node.id.name)?.constant===true;
 return false;
}
function pointer(p){const keys=[];while(p?.parentPath){if(p.listKey)keys.unshift(p.listKey,String(p.key));else keys.unshift(String(p.key));p=p.parentPath;}return '/program/'+keys.join('/');}
function evidence(file,p){const ptr=pointer(p);if(ptr.length>1024)throw Error('evidence pointer budget');return {path:file.path,start:p.node.start,end:p.node.end,line:p.node.loc.start.line,column:p.node.loc.start.column,pointer:ptr};}
function base(input){
 const modules=new Map(),symbols=new Map(),calls=[],imports=[],issues=[];let nodes=0,work=0;
 const issue=(code,file,p)=>{if(issues.length>=256)throw Error('issue budget');issues.push({code,evidence:evidence(file,p)});};
 for(const file of [...input.files].sort((a,b)=>order(a.path,b.path))){
  const ast=parse(file.source,{sourceType:'module',plugins:[...(file.path.endsWith('.ts')||file.path.endsWith('.tsx')?['typescript']:[]),...(file.path.endsWith('.jsx')||file.path.endsWith('.tsx')?['jsx']:[])],errorRecovery:false});
  const m={file,ast,bindings:new Map(),exports:new Map(),stars:[],pending:[],module:{id:file.path+':module',path:file.path,symbol:'<module>',start:0}};
  modules.set(file.path,m);symbols.set(m.module.id,m.module);
  traverse(ast,{enter(p){
   const n=p.node;if(++nodes>6000)throw Error('AST node budget');
   if(symbols.size>256||imports.length>256||m.pending.length>1024)throw Error('graph budget');
   if(p.getAncestry().length>100)throw Error('AST depth budget');
   if(n.type==='TSModuleDeclaration'||n.type==='TSImportEqualsDeclaration'||n.type==='TSExportAssignment')throw Error('Unsupported TypeScript namespace/module');
   if(['ImportExpression','NewExpression','ClassDeclaration','ClassExpression','ObjectMethod','ClassMethod','JSXElement','JSXFragment','TaggedTemplateExpression','AssignmentExpression','UpdateExpression','WithStatement'].includes(n.type))issue('unsupported-runtime-edge',file,p);
   if(p.isFunctionDeclaration()||p.isFunctionExpression()||p.isArrowFunctionExpression()){
    let ident=n.id;if(p.parentPath.isVariableDeclarator()&&p.parentPath.node.id.type==='Identifier')ident=p.parentPath.node.id;
    const s={id:file.path+':'+n.start,path:file.path,symbol:ident?.name??'@'+n.start,start:n.start,evidence:evidence(file,p)};symbols.set(s.id,s);n._graph=s;
    if(ident)m.bindings.set(ident.start,{symbol:s});if(n.id)m.bindings.set(n.id.start,{symbol:s});
    if(!p.isFunctionDeclaration()&&!erased(p)&&!valueContext(p))issue('escaped-callable-value',file,p);
   }
   if(p.isImportDeclaration()){
    const edge={from:file.path,specifier:n.source.value,kind:n.importKind==='type'?'type':'import',bindings:n.specifiers.map(s=>({imported:s.type==='ImportDefaultSpecifier'?'default':s.type==='ImportNamespaceSpecifier'?'*':s.imported.name??s.imported.value,local:s.local.name,typeOnly:n.importKind==='type'||s.importKind==='type'})),evidence:evidence(file,p)};imports.push(edge);
    for(const s of n.specifiers)m.bindings.set(s.local.start,{edge,typeOnly:s.importKind==='type',name:s.type==='ImportDefaultSpecifier'?'default':s.type==='ImportNamespaceSpecifier'?'*':s.imported.name??s.imported.value});
   }
   if(p.isExportNamedDeclaration()){
    let edge;if(n.source){edge={from:file.path,specifier:n.source.value,kind:n.exportKind==='type'?'type':'reexport',bindings:n.specifiers.map(s=>({imported:s.local?.name??'*',exported:s.exported.name??s.exported.value,typeOnly:n.exportKind==='type'||s.exportKind==='type'})),evidence:evidence(file,p)};imports.push(edge);}
    for(const s of p.get('specifiers'))m.exports.set(s.node.exported.name??s.node.exported.value,s.node.exportKind==='type'||n.exportKind==='type'?{}:edge?{edge,name:s.node.local?.name??'*'}:{binding:s.scope.getBinding(s.node.local.name)});
    if(n.declaration&&n.exportKind!=='type'){const decl=p.get('declaration');if(!decl.node.type.startsWith('TS'))for(const name of Object.keys(decl.getOuterBindingIdentifiers()))m.exports.set(name,{binding:(decl.isFunctionDeclaration()?decl.scope.parent:decl.scope).getBinding(name)});}
   }
   if(p.isExportDefaultDeclaration()){const d=p.get('declaration');m.exports.set('default',{path:d});}
   if(p.isExportAllDeclaration()){const edge={from:file.path,specifier:n.source.value,kind:n.exportKind==='type'?'type':'reexport',evidence:evidence(file,p)};imports.push(edge);m.stars.push(edge);}
   if(p.isCallExpression()||p.isOptionalCallExpression())m.pending.push(p);
   if((p.isReferencedIdentifier()||p.isMemberExpression())&&!erased(p)){
    const parent=p.parentPath;
    if(!valueContext(p)&&!(parent.isMemberExpression()&&!parent.node.computed&&p.key==='object')&&!parent.isExportSpecifier())m.pending.push({reference:p});
   }
  }});
 }
 function resolveModule(edge){
  let candidates=[];const spec=edge.specifier;
  if(spec.startsWith('.')){
   const parts=edge.from.split('/');parts.pop();for(const part of spec.split('/')){if(part==='..'){if(!parts.length){issues.push({code:'outside-snapshot-module',evidence:edge.evidence});return null;}parts.pop();}else if(part!=='.'&&part!=='')parts.push(part);}
   const target=parts.join('/');candidates=[target,...['.ts','.tsx','.js','.jsx'].map(e=>target+e),...['.ts','.tsx','.js','.jsx'].map(e=>target+'/index'+e)];
   if(/\.(js|jsx)$/.test(target))candidates.push(target.replace(/\.jsx?$/,'.ts'),target.replace(/\.jsx?$/,'.tsx'));
  }else{const pkg=input.packages.find(x=>x.name===spec);if(pkg)candidates=[pkg.root+'/'+pkg.entry];}
  const matches=[...new Set(candidates)].filter(x=>modules.has(x));
  if(matches.length!==1){issues.push({code:matches.length?'ambiguous-module':'unresolved-module',evidence:edge.evidence});return null;}return matches[0];
 }
 for(const edge of imports)edge.to=resolveModule(edge);
 // ResolveExport uses distinct states: a star cycle contributes no binding (absent),
 // while ambiguity and unresolved dependencies must survive every outer barrel/alias.
 const absent={state:'absent'},ambiguous={state:'ambiguous'},unresolved={state:'unresolved'};
 const resolved=(symbol,identity=symbol.id)=>({state:'resolved',symbol,identity});
 function resolveExportBinding(m,b,seen){
  const result=resolveBinding(m,b,seen);
  // Imported bindings retain the original module binding identity. A distinct
  // local alias is a distinct export, even when its callable value is identical.
  if(!b||m.bindings.get(b.identifier.start)?.edge)return result;
  if(result.state==='ambiguous'||result.state==='unresolved')return result;
  return resolved(result.symbol??null,m.file.path+':export-binding:'+b.identifier.start);
 }
 function resolveExport(path,name,seen=new Set()){
  if(++work>20000||seen.size>100)throw Error('resolution budget');
  const key=path+'#'+name;if(seen.has(key))return absent;seen=new Set(seen);seen.add(key);const m=modules.get(path);if(!m)return unresolved;
  const item=m.exports.get(name);
  // Explicit exports shadow all stars, including ambiguous ones.
  if(item){if(item.edge)return item.edge.to?resolveExport(item.edge.to,item.name,seen):unresolved;if(item.binding)return resolveExportBinding(m,item.binding,seen);if(item.path){const result=resolveExpression(m,item.path,seen);return result.state==='absent'?unresolved:result;}return absent;}
  if(name==='default')return absent;
  let found=absent,unknown=false;
  for(const edge of m.stars){if(edge.kind==='type')continue;const result=edge.to?resolveExport(edge.to,name,seen):unresolved;
   if(result.state==='ambiguous')return ambiguous;
   if(result.state==='unresolved'){unknown=true;continue;}
   if(result.state==='resolved'){if(found.state==='resolved'&&found.identity!==result.identity)return ambiguous;found=result;}
  }
  return unknown?unresolved:found;
 }
 function resolveBinding(m,b,seen=new Set()){
  if(++work>20000||seen.size>100)throw Error('resolution budget');
  if(!b)return absent;if(!b.constant)return unresolved;const key=m.file.path+':binding:'+b.identifier.start;if(seen.has(key))return unresolved;seen=new Set(seen);seen.add(key);
  const item=m.bindings.get(b.identifier.start);if(item?.symbol)return resolved(item.symbol);if(item?.edge)return !item.typeOnly&&item.name!=='*'&&item.edge.kind!=='type'?(item.edge.to?resolveExport(item.edge.to,item.name,seen):unresolved):absent;
  if(b.path.isVariableDeclarator())return resolveExpression(m,b.path.get('init'),seen);return unresolved;
 }
 function resolveExpression(m,p,seen=new Set()){
  if(!p?.node)return absent;if(p.node._graph)return resolved(p.node._graph);
  if(p.isIdentifier())return resolveBinding(m,p.scope.getBinding(p.node.name),seen);
  if(p.isTSAsExpression()||p.isTSNonNullExpression()||p.isTSTypeAssertion())return resolveExpression(m,p.get('expression'),seen);
  if(p.isMemberExpression()&&!p.node.computed&&p.get('object').isIdentifier()){
   const b=p.scope.getBinding(p.node.object.name),item=b&&m.bindings.get(b.identifier.start);if(b?.constant&&!item?.typeOnly&&item?.edge.kind!=='type'&&item?.name==='*')return item.edge.to?resolveExport(item.edge.to,p.node.property.name,seen):unresolved;
  }return absent;
 }
 for(const m of modules.values())for(const candidate of m.pending){
  if(candidate.reference){const result=resolveExpression(m,candidate.reference);if(result.state==='resolved'&&result.symbol||result.state==='ambiguous')issue('escaped-callable-reference',m.file,candidate.reference);continue;}
  const p=candidate;
  const enclosing=p.findParent(x=>x.isFunction());if(enclosing&&!enclosing.node._graph){issue('unsupported-call-owner',m.file,p);continue;}
  const result=resolveExpression(m,p.get('callee')),to=result.state==='resolved'?result.symbol:null;const owner=enclosing?.node._graph??m.module;
  if(to){if(calls.length>=256)throw Error('call evidence budget');const callee=p.get('callee'),b=callee.isIdentifier()?callee.scope.getBinding(callee.node.name):callee.isMemberExpression()&&callee.get('object').isIdentifier()?callee.scope.getBinding(callee.node.object.name):null;calls.push({from:owner,to,binding:b?{name:b.identifier.name,...evidence(m.file,b.path.node===b.identifier?b.path:b.path.get(b.path.isImportSpecifier()||b.path.isImportDefaultSpecifier()||b.path.isImportNamespaceSpecifier()?'local':'id'))}:null,evidence:evidence(m.file,p)});}else issue('unresolved-call',m.file,p);
 }
 return {modules,symbols,calls,imports,issues};
}
export function impact(input){
 admit(input,'impact');
 const g=base(input),changed=input.changes.map(c=>{const matches=[...g.symbols.values()].filter(s=>s.path===c.path&&s.symbol===c.symbol);if(matches.length!==1)throw Error('Change must identify one declaration');return matches[0];});
 const distances=new Map(changed.map(s=>[s.id,0]));let again=true;while(again){again=false;for(const e of g.calls){if(distances.has(e.to.id)&&(!distances.has(e.from.id)||distances.get(e.from.id)>distances.get(e.to.id)+1)){distances.set(e.from.id,distances.get(e.to.id)+1);again=true;}}}
 const callers=[...g.symbols.values()].filter(s=>distances.has(s.id)&&!changed.some(c=>c.id===s.id)).map(s=>({...s,distance:distances.get(s.id)})).sort((a,b)=>order(a.path,b.path)||a.start-b.start);
 const reached=[...changed,...callers];const packages=[...new Set(reached.flatMap(s=>input.packages.filter(p=>s.path.startsWith(p.root+'/')).map(p=>p.name)))].sort(order);
 const tests=input.files.filter(f=>f.kind==='test'&&reached.some(s=>s.path===f.path)).map(f=>f.path).sort(order);
 return {scope:'supplied-static-direct-calls',complete:g.issues.length===0,changed,callers,packages,tests,calls:g.calls,imports:g.imports,issues:g.issues};
}
const inside=(path,prefix)=>path===prefix||path.startsWith(prefix+'/');
export function architecture(input){
 admit(input,'architecture');
 const g=base(input),rules=input.rules,findings=[],edges=g.imports.filter(e=>e.to);
 for(const edge of edges)if(rules.forbidden.some(r=>inside(edge.from,r.from)&&inside(edge.to,r.to)))findings.push({code:'forbidden-import',edge});
 const layer=path=>rules.layers.find(l=>inside(path,l.prefix))?.name;
 for(const edge of edges){const from=layer(edge.from),to=layer(edge.to);if((!from||!to||!rules.allowed.some(a=>a.from===from&&a.to===to))&&rules.defaultPolicy==='deny')findings.push({code:'layer-violation',edge});}
 // One deterministic closed witness per strongly connected component (not all simple cycles).
 let next=0;const stack=[],state=new Map(),components=[];
 function visit(v){const s={index:next,low:next++,active:true};state.set(v,s);stack.push(v);for(const e of edges.filter(e=>e.from===v)){const w=state.get(e.to);if(!w){visit(e.to);s.low=Math.min(s.low,state.get(e.to).low);}else if(w.active)s.low=Math.min(s.low,w.index);}if(s.low===s.index){const component=[];let w;do{w=stack.pop();state.get(w).active=false;component.push(w);}while(w!==v);components.push(component.sort(order));}}
 for(const v of [...g.modules.keys()])if(!state.has(v))visit(v);
 const cycles=[];for(const c of components.sort((a,b)=>order(a[0],b[0]))){if(c.length===1&&!edges.some(e=>e.from===c[0]&&e.to===c[0]))continue;const start=c[0];function find(v,seen,route){for(const e of edges.filter(e=>e.from===v&&c.includes(e.to))){if(e.to===start)return [...route,e];if(!seen.has(e.to)){const r=find(e.to,new Set([...seen,e.to]),[...route,e]);if(r)return r;}}return null;}const witness=find(start,new Set([start]),[]);if(witness)cycles.push({paths:[start,...witness.map(e=>e.to)],edges:witness});}
 return {scope:'supplied-static-module-dependencies',direction:'importer-to-imported',dependencyKinds:['import','reexport','type'],defaultPolicy:rules.defaultPolicy,complete:g.issues.length===0,policySatisfied:g.issues.length?null:findings.length===0&&cycles.length===0,imports:g.imports,findings,cycles,issues:g.issues};
}
