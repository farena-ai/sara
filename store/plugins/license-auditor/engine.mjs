import parse from './vendor/index.cjs';
import { inventory } from './npm-lock.mjs';
function atom(n) { return n.license+(n.plus?'+':'')+(n.exception?' WITH '+n.exception:''); }
function expression(s) { if(typeof s!=='string'||s.length>256||!s.length) throw new Error('input'); return parse(s); }
function leaves(n) { return n.conjunction?[...leaves(n.left),...leaves(n.right)]:[atom(n)]; }
export function audit(args) {
  if(!args||Object.keys(args).some(k=>!['lock','metadata','policy'].includes(k))) throw new Error('input');
  const data=inventory(args.lock);
  if(!Array.isArray(args.metadata)||args.metadata.length>60||!args.policy||Object.keys(args.policy).some(k=>!['allow','deny'].includes(k))) throw new Error('input');
  for(const key of ['allow','deny']) { const xs=args.policy[key]; if(!Array.isArray(xs)||xs.length>60) throw new Error('input'); for(const x of xs) if(leaves(expression(x)).length!==1) throw new Error('input'); }
  const allow=new Set(args.policy.allow.map(s=>atom(expression(s)))),deny=new Set(args.policy.deny.map(s=>atom(expression(s)))), supplied=new Map();
  for(const m of args.metadata) {
    if(!m||Object.keys(m).some(k=>!['path','expression'].includes(k))||!data.packages.some(p=>p.path===m.path)||supplied.has(m.path)||typeof m.expression!=='string'||m.expression.length>256) throw new Error('input');
    supplied.set(m.path,m.expression);
  }
  function evaluate(n) {
    if(n.conjunction) { const a=evaluate(n.left),b=evaluate(n.right);
      if(n.conjunction==='and') return a==='denied'||b==='denied'?'denied':a==='allowed'&&b==='allowed'?'allowed':'review';
      return a==='allowed'||b==='allowed'?'allowed':a==='denied'&&b==='denied'?'denied':'review';
    }
    const a=atom(n); return deny.has(a)?'denied':allow.has(a)?'allowed':'review';
  }
  return {status:'completed',lockfileVersion:data.lockfileVersion,packages:data.packages.map(p=>{
    const value=supplied.get(p.path)??p.license;
    let decision='unknown',license;
    if(value!==undefined) { try { const tree=expression(value); decision=evaluate(tree); license=value; } catch { decision='review'; } }
    return {path:p.path,name:p.name,version:p.version,decision,...(license?{expression:license}:{})};
  })};
}
