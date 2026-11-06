// Validate this deliberately small, closed schema vocabulary at every handler boundary.
export function validate(value,schema) {
 if(schema.type==='object') { if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(value,k))) throw new Error('input'); for(const k of Object.keys(value)) validate(value[k],schema.properties[k]); }
 else if(schema.type==='array') { if(!Array.isArray(value)||value.length<schema.minItems||value.length>schema.maxItems) throw new Error('input'); value.forEach(x=>validate(x,schema.items)); }
 else if(schema.type==='string') { if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)||schema.enum&&!schema.enum.includes(value)||schema.pattern&&!new RegExp(schema.pattern).test(value)) throw new Error('input'); }
 else throw new Error('schema');
}
