// Dependency-free, fail-closed OpenAPI JSON subset; no schema execution or fetching.
export const LIMITS = Object.freeze({ inputBytes: 262144, nodes: 12000, depth: 32, findings: 128, outputBytes: 16384 });
export const methods = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'];
export const pointer = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
export function refuse(code = 'invalid-document') { throw new Error(code); }
export function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)); }
export function closed(v, keys) { if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) refuse('unsupported-or-invalid-structure'); }
export function boundedJSON(v) {
  let nodes = 0; const active = new Set();
  function walk(x, depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) refuse('input-budget');
    if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return;
    if (typeof x === 'string') { if (x.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x)) refuse('input-budget-or-control'); return; }
    if (!Array.isArray(x) && !object(x)) refuse();
    if (active.has(x)) refuse('non-json-cycle'); active.add(x);
    for (const k of Object.keys(x)) {
      if (/(?:secret|password|credential|authorization|private[-_]?key|access[-_]?token)/i.test(k) || /[A-Za-z0-9_-]{40,}/.test(k)) refuse('sensitive-structural-identifier');
      if (k.length > 160 || /[\u0000-\u001f\u007f]/.test(k) || ['__proto__','constructor','prototype'].includes(k) || k.startsWith('x-')) refuse('unsupported-key');
      const d = Object.getOwnPropertyDescriptor(x, k); if (!d || !('value' in d)) refuse(); walk(d.value, depth + 1);
    }
    active.delete(x);
  }
  walk(v, 0); if (Buffer.byteLength(JSON.stringify(v)) > LIMITS.inputBytes) refuse('input-budget');
}
export function resolve(doc, value, at) {
  const seen = new Set();
  while (object(value) && '$ref' in value) {
    closed(value, ['$ref']); const ref = value.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/') || /~(?![01])/.test(ref) || ref.length > 512) refuse('local-ref-only');
    if (seen.has(ref)) refuse('reference-alias-cycle'); seen.add(ref);
    let target = doc;
    for (const token of ref.slice(2).split('/')) { const k = token.replace(/~1/g, '/').replace(/~0/g, '~'); if (!object(target) || !Object.hasOwn(target, k)) refuse('missing-local-ref'); target = target[k]; }
    if (!object(target)) refuse('invalid-ref-target'); value = target; at = ref.slice(1);
  }
  return { value, at };
}
export function validateDocument(doc) {
  boundedJSON(doc); closed(doc, ['openapi','info','paths','components','servers','tags','externalDocs']);
  if (!/^3\.(0|1)\.\d+$/.test(doc.openapi ?? '') || !object(doc.info) || typeof doc.info.title !== 'string' || typeof doc.info.version !== 'string' || !object(doc.paths)) refuse();
  // Every reference, even in unused components, must be local and resolvable.
  function refs(x) { if (!object(x) && !Array.isArray(x)) return; if (object(x) && '$ref' in x) resolve(doc, x, ''); for (const v of Object.values(x)) refs(v); } refs(doc);
  const checked = new Set();
  function schema(raw, at) {
    const { value: s, at: resolved } = resolve(doc, raw, at); if (checked.has(s)) return; checked.add(s);
    closed(s, ['type','properties','required','items','enum','nullable','additionalProperties','format','description','title','example','examples','default','deprecated','readOnly','writeOnly']);
    if (s.type !== undefined && !['object','array','string','integer','number','boolean','null'].includes(s.type)) refuse('unsupported-schema-type');
    for (const k of ['nullable','readOnly','writeOnly','deprecated']) if (s[k] !== undefined && typeof s[k] !== 'boolean') refuse();
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 128 || s.enum.some(v => v !== null && !['string','number','boolean'].includes(typeof v)))) refuse('invalid-enum');
    if (s.required !== undefined && (!Array.isArray(s.required) || new Set(s.required).size !== s.required.length || s.required.some(k => typeof k !== 'string' || !Object.hasOwn(s.properties ?? {}, k)))) refuse('invalid-required');
    if (s.properties !== undefined) { if (!object(s.properties)) refuse(); for (const [k,v] of Object.entries(s.properties)) schema(v, `${resolved}/properties/${pointer(k)}`); }
    if (s.type === 'array' && s.items === undefined) refuse('missing-items');
    if (s.items !== undefined) schema(s.items, `${resolved}/items`);
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') schema(s.additionalProperties, `${resolved}/additionalProperties`);
  }
  function content(c, at) { if (!object(c)) refuse(); for (const [mime, media] of Object.entries(c)) { closed(media, ['schema','example','examples']); if (media.schema !== undefined) schema(media.schema, `${at}/${pointer(mime)}/schema`); } }
  function params(p, at) {
    if (!Array.isArray(p) || p.length > 128) refuse('invalid-parameters'); const ids = new Set();
    for (let i=0;i<p.length;i++) { const {value:v,at:a} = resolve(doc,p[i],`${at}/${i}`); closed(v,['name','in','required','schema','description','deprecated','style','explode','allowReserved','example','examples']); if (typeof v.name !== 'string' || !v.name || !['query','header','path','cookie'].includes(v.in) || (v.required !== undefined && typeof v.required !== 'boolean') || (v.in === 'path' && v.required !== true)) refuse('invalid-parameter'); const id=`${v.in}:${v.name.toLowerCase()}`; if(ids.has(id)) refuse('duplicate-parameter'); ids.add(id); schema(v.schema,`${a}/schema`); }
  }
  for (const [path,item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/')) refuse('invalid-api-path'); closed(item,[...methods,'parameters','summary','description']);
    if(item.parameters !== undefined) params(item.parameters,`/paths/${pointer(path)}/parameters`);
    for (const method of methods) if (item[method] !== undefined) {
      const op=item[method], at=`/paths/${pointer(path)}/${method}`;
      closed(op,['operationId','summary','description','tags','deprecated','parameters','requestBody','responses','externalDocs']);
      if(op.parameters !== undefined) params(op.parameters,`${at}/parameters`);
      if(op.requestBody !== undefined) { const {value:b,at:a}=resolve(doc,op.requestBody,`${at}/requestBody`); closed(b,['required','content','description']); if(b.required !== undefined && typeof b.required !== 'boolean') refuse(); content(b.content,`${a}/content`); }
      if(!object(op.responses) || !Object.keys(op.responses).length) refuse('invalid-responses');
      for (const [status,raw] of Object.entries(op.responses)) { if(!/^(default|[1-5](?:\d\d|XX))$/.test(status)) refuse('invalid-response-code'); const {value:r,at:a}=resolve(doc,raw,`${at}/responses/${status}`); closed(r,['description','content']); if(typeof r.description !== 'string') refuse('invalid-response'); if(r.content !== undefined) content(r.content,`${a}/content`); }
    }
  }
  if(doc.components !== undefined) { closed(doc.components,['schemas','parameters','requestBodies','responses']); for(const [k,v] of Object.entries(doc.components.schemas ?? {})) schema(v,`/components/schemas/${pointer(k)}`); }
  return doc;
}
export function boundedResult(result) { if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) refuse('output-budget'); return result; }
