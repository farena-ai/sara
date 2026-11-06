import { plugin } from './sara-plugin.mjs';
import { options, object, identifier, text, refine, result, schema, idSchema, textSchema } from './workflow.mjs';
import translations from './labels.json' with { type: 'json' };
const title = 'Research notebook';
const description = 'Keep a bounded, explicitly supplied source notebook: CRUD, exact-content dedupe, Markdown export and optional quote-checked synthesis. No web retrieval.';
const KEY = 'notebook-v1';
function item(value) {
  const s = object(value, ['id', 'kind', 'title', 'text', 'url', 'sourceIds'], 'item');
  identifier(s.id); text(s.title, 'title', 80); text(s.text, 'notebook text', 2000);
  if (!['source', 'note'].includes(s.kind)) throw new Error('kind must be source or note.');
  if (s.url !== undefined) {
    text(s.url, 'source URL', 500); let url;
    try { url = new URL(s.url); } catch { throw new Error('Source URL must be valid HTTPS, no credentials.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Source URL must be HTTPS, no credentials.');
    if (s.kind !== 'source') throw new Error('Only source records have a URL.');
  }
  if (s.sourceIds !== undefined && (!Array.isArray(s.sourceIds) || s.sourceIds.length > 12 || new Set(s.sourceIds).size !== s.sourceIds.length)) throw new Error('sourceIds must be a unique array of at most 12 source IDs.');
  for (const id of s.sourceIds ?? []) identifier(id);
  if (s.kind === 'source' && s.sourceIds?.length) throw new Error('Source records cannot reference other sources; use a note.');
  return { id: s.id, kind: s.kind, title: s.title, text: s.text, ...(s.url ? { url: s.url } : {}), sourceIds: s.sourceIds ?? [] };
}
function validate(state) {
  object(state, ['version', 'items'], 'stored notebook');
  if (state.version !== 1 || !Array.isArray(state.items) || state.items.length > 32) throw new Error('Notebook shape is invalid; prior storage was preserved.');
  const items = state.items.map(item);
  if (new Set(items.map((s) => s.id)).size !== items.length) throw new Error('Stored notebook has duplicate IDs; prior storage preserved.');
  for (const entry of items) for (const id of entry.sourceIds) if (!items.some((s) => s.id === id && s.kind === 'source')) throw new Error(`Missing source reference: ${id}`);
  if (Buffer.byteLength(JSON.stringify({ version: 1, items }), 'utf8') > 50000) throw new Error('Notebook exceeds 50000 bytes. Delete or export entries first; nothing changed.');
  return { version: 1, items };
}
async function run(input, sara) {
  const args = options(input, ['operation', 'id', 'ids', 'item', 'overwrite']);
  const fields = { put: ['item', 'overwrite'], get: ['id'], list: [], delete: ['id'], export: [], synthesize: ['ids'] };
  if (!Object.hasOwn(fields, args.operation)) throw new Error('operation must be put, get, list, delete, export or synthesize.');
  for (const key of ['id', 'ids', 'item', 'overwrite']) if (args[key] !== undefined && !fields[args.operation].includes(key)) throw new Error(`${key} is not valid for ${args.operation}.`);
  if (args.refine !== undefined) throw new Error('Use operation synthesize to explicitly request a model; refine is not supported for notebooks.');
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new Error('overwrite must be a boolean.');
  // Validate incoming mutations before accessing storage.
  const incoming = args.operation === 'put' ? item(args.item) : null;
  if (['get', 'delete'].includes(args.operation)) identifier(args.id);
  const state = validate(await sara.kv.get(KEY) ?? { version: 1, items: [] });
  let report = { status: 'local-notebook', items: state.items.map(({ text: body, ...meta }) => ({ ...meta, characters: body.length })) };
  const save = async (items) => {
    const next = validate({ version: 1, items });
    const receipt = await sara.kv.set(KEY, next);
    if (receipt.ok !== true) throw new Error('Notebook write was not confirmed; no saved claim made.');
  };
  if (args.operation === 'put') {
    const existing = state.items.find((s) => s.id === incoming.id);
    const duplicate = state.items.find((s) => s.kind === incoming.kind && s.text === incoming.text && (s.url ?? '') === (incoming.url ?? '') && JSON.stringify(s.sourceIds) === JSON.stringify(incoming.sourceIds));
    if (existing && JSON.stringify(existing) !== JSON.stringify(incoming) && !args.overwrite) throw new Error('ID exists with different content. Set overwrite:true explicitly to replace it.');
    if (duplicate && (!existing || JSON.stringify(existing) === JSON.stringify(incoming))) report = { status: 'deduplicated', saved: false, duplicateOf: duplicate.id };
    else { await save([...state.items.filter((s) => s.id !== incoming.id), incoming]); report = { status: 'saved-locally', saved: true, id: incoming.id }; }
  } else if (args.operation === 'get' || args.operation === 'delete') {
    const found = state.items.find((s) => s.id === args.id);
    if (!found) throw new Error(`Unknown notebook ID: ${args.id}`);
    if (args.operation === 'get') report = { status: 'local-notebook-item', item: found };
    else {
      if (state.items.some((s) => s.sourceIds.includes(args.id))) throw new Error('Source is referenced by notes. Delete or update those notes explicitly first.');
      await save(state.items.filter((s) => s.id !== args.id)); report = { status: 'deleted-locally', deleted: args.id };
    }
  } else if (args.operation === 'export') {
    const block = (s) => s.split('\n').map((l) => `    ${l}`).join('\n');
    report = { status: 'export-text-only', markdown: '# Research notebook — supplied material\n\nNo web verification. Notes are hypotheses, not established facts.\n\n' + state.items.map((s) => `## ${s.id} (${s.kind})\n\n${block(s.title)}\n\n${block(s.text)}\n\nSources: ${s.sourceIds.join(', ') || 'none supplied'}${s.url ? `\n\nSource address (not fetched):\n\n${block(s.url)}` : ''}`).join('\n\n'), savedFile: false };
  } else if (args.operation === 'synthesize') {
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 12 || new Set(args.ids).size !== args.ids.length) throw new Error('Select 1–12 unique notebook IDs.');
    const selected = args.ids.map((id) => { identifier(id); const s = state.items.find((s) => s.id === id); if (!s) throw new Error(`Unknown notebook ID: ${id}`); return s; });
    if (selected.reduce((n, s) => n + s.text.length, 0) > 5000) throw new Error('Selected synthesis exceeds 5000 characters. Select a smaller explicit set; nothing sent.');
    report = { status: 'synthesis-proposed-not-saved', sources: selected.map(({ id, kind, sourceIds }) => ({ id, kind, sourceIds })), model: await refine(sara, selected.map((s) => ({ id: s.id, label: `${s.kind}: ${s.title}`, text: s.text })), 'Research synthesis: preserve source IDs; notes are hypotheses; quotations do not prove an interpretation', args.language) };
  }
  return result(title, report, translations[sara.lang] ?? {});
}
// One writer per plugin process; avoid concurrent lost updates without another database/harness.
let queue = Promise.resolve();
const requirements = "put requires item; overwrite is put-only. get/delete require id. list/export accept no selection. synthesize requires 1–12 unique ids (<=5000 combined text); never saves. No refine. URLs: source-only HTTPS, no credentials; refs: existing sources only. Store: 32 items/50000 bytes.";
const tools = [{ name: 'notebook', description: `${requirements} ${description}`, permission: 'ask', parameters: schema({ operation: { type: 'string', enum: ['put', 'get', 'list', 'delete', 'export', 'synthesize'] }, id: idSchema, ids: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: idSchema, description: 'synthesize only; existing IDs, combined selected text at most 5000 code units.' }, item: { type: 'object', additionalProperties: false, properties: { id: idSchema, kind: { type: 'string', enum: ['source', 'note'] }, title: textSchema(80, 'Supplied title.'), text: textSchema(2000, 'Supplied notebook text.'), url: textSchema(500, 'Optional source-only HTTPS URL without credentials; never fetched.'), sourceIds: { type: 'array', minItems: 0, maxItems: 12, uniqueItems: true, items: idSchema, description: 'Existing source-kind IDs only; sources may have no nonempty references. Notes may reference sources.' } }, required: ['id', 'kind', 'title', 'text'] }, overwrite: { type: 'boolean', description: 'put only; true explicitly replaces an existing ID. Referenced sources must remain sources.' } }, ['operation'], false), run: (args, sara) => { if (args?.operation === 'synthesize') return run(args, sara); const pending = queue.then(() => run(args, sara)); queue = pending.catch(() => {}); return pending; } }];
plugin({ tools, init: (sara) => { tools[0].description = `${translations[sara.lang]?.[requirements] ?? requirements} ${translations[sara.lang]?.[description] ?? description}`; } });
