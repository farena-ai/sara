export function validate(value,schema){
 if(schema.enum&&!schema.enum.includes(value))throw Error();
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
  if(Object.keys(value).some(k=>['__proto__','constructor','prototype'].includes(k)||!Object.hasOwn(schema.properties,k)))throw Error();
  for(const key of schema.required??[])if(!Object.hasOwn(value,key))throw Error();
  for(const [key,v] of Object.entries(value))validate(v,schema.properties[key]);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??100))throw Error();for(const item of value)validate(item,schema.items);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??100000)||schema.pattern&&!new RegExp(schema.pattern).test(value))throw Error();
 }else if(schema.type==='integer'){
  if(!Number.isSafeInteger(value)||value<(schema.minimum??-Number.MAX_SAFE_INTEGER)||value>(schema.maximum??Number.MAX_SAFE_INTEGER))throw Error();
 }else if(schema.type==='boolean'&&typeof value!=='boolean')throw Error();
}
