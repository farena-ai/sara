import {validate as validateInput} from './validation.mjs';
import parameters from './schema.json' with {type:'json'};
import {protoAnalyze} from './proto.mjs';
import {Ajv} from './validator.mjs';
const forbidden=new Set(['__proto__','constructor','prototype']);
export function bounded(value,depth=0,budget={n:0}){if(depth>12||++budget.n>2500)throw Error('input limit');if(typeof value==='string'&&value.length>16384)throw Error('string limit');if(value&&typeof value==='object'){if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw Error('prototype');for(const k of Object.keys(value)){if(forbidden.has(k))throw Error('unsafe key');bounded(value[k],depth+1,budget);}}}
function schemaGuard(s){
 const allowed=new Set(['type','properties','required','additionalProperties','items','enum','minimum','maximum','minLength','maxLength','minItems','maxItems','description','title']);
 if(!s||typeof s!=='object'||Array.isArray(s))throw Error('schema');
 for(const k of Object.keys(s))if(!allowed.has(k))throw Error('unsupported schema keyword');
 if(s.properties)for(const c of Object.values(s.properties))schemaGuard(c);
 if(s.items)schemaGuard(s.items);
 if(s.additionalProperties!==undefined&&typeof s.additionalProperties!=='boolean')throw Error('additionalProperties');
 if(s.type&&!['object','array','string','integer','number','boolean','null'].includes(s.type))throw Error('type');
}
function equalJson(a,b){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equalJson(a[k],b[k]));
}
function compare(a,b,path,breaking){
 const add=s=>breaking.push(path+': '+s);
 if(b.type!==undefined&&a.type!==b.type&&!(a.type==='integer'&&b.type==='number'))add('type narrowed');
 for(const key of b.required??[])if(!(a.required??[]).includes(key))add('required field added '+key);
 if(b.enum&&(!a.enum||a.enum.some(v=>!b.enum.some(w=>equalJson(v,w)))))add('enum narrowed');
 for(const k of ['minimum','minLength','minItems'])if(b[k]!==undefined&&(a[k]===undefined||b[k]>a[k]))add(k+' tightened');
 for(const k of ['maximum','maxLength','maxItems'])if(b[k]!==undefined&&(a[k]===undefined||b[k]<a[k]))add(k+' tightened');
 if(b.additionalProperties===false&&a.additionalProperties!==false)add('additional properties prohibited');
 for(const [key,old] of Object.entries(a.properties??{})){const next=b.properties?.[key];if(next)compare(old,next,path+'.'+key,breaking);else if(b.additionalProperties===false)add('property removed '+key);}
 if(b.items)compare(a.items??{},b.items,path+'[]',breaking);
 for(const key of Object.keys(b.properties??{}))if(!Object.hasOwn(a.properties??{},key)&&a.additionalProperties!==false)compare({},b.properties[key],path+'.'+key,breaking);
}
export function analyze(args){validateInput(args,parameters);bounded(args);if(args.format==='protobuf')return protoAnalyze(args,bounded);if(args.format!=='json-schema')throw Error('unsupported format');
 const a=JSON.parse(args.before),b=JSON.parse(args.after);bounded(a);bounded(b);schemaGuard(a);schemaGuard(b);
 const ajv=new Ajv({strict:true,allErrors:false,ownProperties:true,validateFormats:false,logger:false});ajv.compile(a);const validate=ajv.compile(b),breaking=[];compare(a,b,'$',breaking);
 const payloads=args.payloads.map(text=>{const value=JSON.parse(text);bounded(value);const valid=validate(value);return {valid,errors:valid?[]:validate.errors.map(e=>({path:e.instancePath,keyword:e.keyword}))};});
 return {format:args.format,compatible:breaking.length===0,breaking,payloads,validator:'Ajv 8.17.1 / bounded draft-07 subset'};
}
