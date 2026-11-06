import protobuf from './protobuf.cjs';
const scalar=new Set(['int32','uint32','sint32','fixed32','sfixed32','string','bool','float','double']);
function parse(text){
 // Syntax identity is lexical, never inferred from comment text or parser success.
 const syntax=text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,'').match(/^\s*syntax\s*=\s*"(proto[23])"\s*;/)?.[1];
 if(text.length>16384||!syntax||/\b(import|service|extend|extensions|oneof|map|group|option|reserved)\b|\[|\]|__proto__|constructor|prototype/.test(text))throw Error('unsupported proto construct');
 let depth=0;for(const c of text){if(c==='{')depth++;if(c==='}')depth--;if(depth>3||depth<0)throw Error('depth');}if(depth)throw Error('braces');
 const parsed=protobuf.parse(text,{keepCase:true});if(parsed.imports?.length||parsed.weakImports?.length)throw Error('imports');const root=parsed.root.resolveAll();
 const messages=new Map();let count=0;function walk(n){for(const x of Object.values(n.nested??{})){if(++count>80)throw Error('declarations');if(x instanceof protobuf.Type){if(x.nested)throw Error('nested declarations');if(x.fieldsArray.length>40)throw Error('fields');for(const f of x.fieldsArray){if(f.id<=0||f.id>536870911||f.id>=19000&&f.id<=19999||!scalar.has(f.type)&&!(f.resolvedType instanceof protobuf.Enum))throw Error('unsupported field');}messages.set(x.fullName,x);}else if(x instanceof protobuf.Enum){const numbers=Object.values(x.values);if(!numbers.length||numbers.length>40||numbers.some(n=>!Number.isSafeInteger(n)||n< -2147483648||n>2147483647)||syntax==='proto3'&&numbers[0]!==0)throw Error('enum');}else walk(x);}}walk(root);return {root,messages};
}
function validPayload(type,value){
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!Object.hasOwn(type.fields,k)))return false;
 if(type.verify(value))return false;
 for(const f of type.fieldsArray){if(!Object.hasOwn(value,f.name))continue;const values=f.repeated?value[f.name]:[value[f.name]];
  if(!Array.isArray(values)||values.length>100)return false;
  for(const v of values){if(['int32','sint32','sfixed32'].includes(f.type)&&(!Number.isInteger(v)||v< -2147483648||v>2147483647))return false;if(['uint32','fixed32'].includes(f.type)&&(!Number.isInteger(v)||v<0||v>4294967295))return false;if(f.type==='float'&&!Number.isFinite(Math.fround(v)))return false;if(['float','double'].includes(f.type)&&!Number.isFinite(v))return false;}
 }return true;
}
export function protoAnalyze(args,bounded){const a=parse(args.before),b=parse(args.after),breaking=[];
 for(const [name,old] of a.messages){const next=b.messages.get(name);if(!next){breaking.push(name+': message removed');continue;}
  for(const f of old.fieldsArray){const g=next.fieldsById[f.id];if(!g){breaking.push(name+': field-number removed '+f.id);continue;}if((f.resolvedType instanceof protobuf.Enum&&g.resolvedType instanceof protobuf.Enum?false:g.type!==f.type)||g.repeated!==f.repeated||g.required!==f.required)breaking.push(name+': type/wire/cardinality changed '+f.id);
   if(f.resolvedType instanceof protobuf.Enum&&g.resolvedType instanceof protobuf.Enum)for(const n of Object.values(f.resolvedType.values))if(!Object.values(g.resolvedType.values).includes(n))breaking.push(name+': enum value removed '+f.id);
  }for(const f of next.fieldsArray)if(f.required&&!old.fieldsById[f.id])breaking.push(name+': required field added '+f.id);
 }
 const type=b.root.lookupType(args.message);if(!b.messages.has(type.fullName))throw Error('message');
 const payloads=args.payloads.map(text=>{const value=JSON.parse(text);bounded(value);const valid=validPayload(type,value);if(!valid)return {valid:false,errors:[{keyword:'protobuf-payload'}]};const bytes=type.encode(type.create(value)).finish(),decoded=type.decode(bytes);for(const f of type.fieldsArray){if(!Object.hasOwn(value,f.name))continue;const original=f.repeated?value[f.name]:[value[f.name]],roundtrip=f.repeated?decoded[f.name]:[decoded[f.name]];if(original.length!==roundtrip.length||original.some((v,i)=>roundtrip[i]!== (f.type==='float'?Math.fround(v):v)))return {valid:false,errors:[{keyword:'protobuf-wire-identity'}]};}return {valid:true,errors:[],wireBytes:bytes.length};});
 return {format:'protobuf',compatible:breaking.length===0,breaking,payloads,validator:'protobufjs 7.5.4 / bounded flat scalar+enum subset'};
}
