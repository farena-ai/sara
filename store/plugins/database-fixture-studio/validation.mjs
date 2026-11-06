// Deliberately small closed JSON-schema vocabulary used for tool inputs.
export function validate(v,s,depth=0){
 if(depth>14)throw Error('depth');
 if(s.type==='object'){if(!v||Array.isArray(v)||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('object');for(const k of Object.keys(v)){if(['__proto__','prototype','constructor'].includes(k)||!Object.hasOwn(s.properties,k))throw Error('key');validate(v[k],s.properties[k],depth+1);}for(const k of s.required)if(!Object.hasOwn(v,k))throw Error('required');}
 else if(s.type==='array'){if(!Array.isArray(v)||v.length<s.minItems||v.length>s.maxItems)throw Error('array');for(const x of v)validate(x,s.items,depth+1);}
 else if(s.type==='string'){if(typeof v!=='string'||v.length<s.minLength||v.length>s.maxLength||s.enum&&!s.enum.includes(v)||s.pattern&&!new RegExp(s.pattern).test(v))throw Error('string');}
 else if(s.type==='integer'){if(!Number.isSafeInteger(v)||v<s.minimum||v>s.maximum)throw Error('integer');}
 else if(s.type==='boolean'){if(typeof v!=='boolean')throw Error('boolean');}else throw Error('schema');
}
