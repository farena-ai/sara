import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
  tag: string; children: Element[] = []; listeners: Record<string, Function> = {};
  textContent = ''; value = ''; disabled = false; hidden = false; required = false;
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; className = ''; id = ''; type = ''; focused = false;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, action: Function) { this.listeners[key] = action; }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap(walk).filter(n => n.tag === tag); }
  focus() { this.focused = true; }
}
const walk = (n: Element): Element[] => [n, ...n.children.flatMap(walk)];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const record = (id = 1, logic = 'Saved logic') => ({ id, workspace: 'fixture', path: '.', logic, blockers: ['Pending review'], nextSteps: ['Run checks'], createdAt: '2026-11-05T12:00:00.000Z', sourceConversationId: null });
function fixture(handler: (path: string, options: any) => any = () => ({ current: null, history: [] })) {
  const path = new URL('../web/project-checkpoints.js', import.meta.url);
  assert.ok(existsSync(path), 'checkpoint renderer must exist');
  const calls: any[] = [];
  const t = (s: string, values: any = {}) => s.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
  const context: any = { document: { createElement: (tag: string) => new Element(tag) }, t };
  runInNewContext(readFileSync(path, 'utf8').replaceAll('export ', '') + '\nthis.render = renderProjectCheckpoint;', context);
  const root = context.render({ workspace: 'fixture', path: '.', t, api: async (p: string, o: any = {}) => { calls.push([p, o]); return handler(p, o); } });
  const find = (text: string) => walk(root).find(n => n.tag === 'button' && n.textContent === text)!;
  const field = (name: string) => walk(root).find(n => n.dataset.field === name)!;
  const input = (name: string, value: string) => { const n = field(name); n.value = value; n.listeners.input(); };
  const submit = () => walk(root).find(n => n.tag === 'form')!.listeners.submit({ preventDefault() {} });
  return { root, calls, find, field, input, submit, text: () => walk(root).map(n => n.textContent).join(' ') };
}

test('checkpoint first save uses expectedId zero and renders returned time, source and history', async () => {
  const f = fixture((_p, o) => o.method === 'POST' ? record() : { current: null, history: [] });
  await tick(); f.input('logic', 'My logic'); f.input('blockers', 'One\nTwo'); f.input('next1', 'First'); f.input('next3', 'Third');
  await f.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1)[1].body)), { workspace: 'fixture', path: '.', logic: 'My logic', blockers: ['One', 'Two'], nextSteps: ['First', 'Third'], expectedId: 0 });
  assert.match(f.text(), /2026-11-05T12:00:00.000Z/); assert.match(f.text(), /Owner editor/); assert.match(f.text(), /Saved history/);
});
test('replacement requires explicit confirmation and captures the current id', async () => {
  const f = fixture((_p, o) => o.method === 'POST' ? record(8) : { current: record(7), history: [record(7)] });
  await tick(); f.input('logic', 'Replacement'); await f.submit();
  assert.equal(f.calls.length, 1); await f.find('Confirm replace').listeners.click();
  assert.equal(f.calls.at(-1)[1].body.expectedId, 7); assert.equal(f.calls.at(-1)[1].body.logic, 'Replacement');
});
test('clear requires confirmation, clears only its exact scope and preserves fields', async () => {
  const f = fixture((_p, o) => o.method === 'DELETE' ? { ok: true } : { current: record(7), history: [record(7)] });
  await tick(); f.input('logic', 'Unsent draft'); await f.find('Clear checkpoint history').listeners.click();
  assert.equal(f.calls.length, 1); await f.find('Confirm clear').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1)[1].body)), { workspace: 'fixture', path: '.', expectedId: 7 });
  assert.equal(f.field('logic').value, 'Unsent draft'); assert.match(f.text(), /No saved checkpoint/);
});
test('400 preserves drafts and allows corrected retry without reload', async () => {
  let rejects = true;
  const f = fixture((_p, o) => { if (o.method === 'POST') { if (rejects) throw Object.assign(Error('validation'), { status: 400 }); return record(); } return { current: null, history: [] }; });
  await tick(); f.input('logic', 'Draft'); f.input('next1', 'Next'); await f.submit();
  assert.equal(f.field('logic').value, 'Draft'); assert.equal(f.find('Save checkpoint').disabled, false);
  rejects = false; f.input('logic', 'Corrected'); await f.submit(); assert.equal(f.calls.filter(c => c[1].method === 'POST').length, 2);
});
test('409 preserves drafts and requires explicit reload to accept the latest saved state', async () => {
  let current = record(1);
  const f = fixture((_p, o) => { if (o.method === 'POST') { current = record(2, 'Other writer'); throw Object.assign(Error('conflict'), { status: 409 }); } return { current, history: [current] }; });
  await tick(); f.input('logic', 'Keep this draft'); await f.submit(); await f.find('Confirm replace').listeners.click();
  assert.equal(f.field('logic').value, 'Keep this draft'); assert.equal(f.find('Replace checkpoint').disabled, true); assert.match(f.text(), /changed elsewhere/);
  await f.find('Reload saved checkpoint').listeners.click(); assert.equal(f.field('logic').value, 'Other writer'); assert.equal(f.find('Replace checkpoint').disabled, false);
});
test('uncertain write keeps draft and locks repeated mutation until reload', async () => {
  const f = fixture((_p, o) => { if (o.method) throw Error('lost response'); return { current: null, history: [] }; });
  await tick(); f.input('logic', 'Draft'); f.input('next1', 'Next'); await f.submit(); await f.submit();
  assert.equal(f.field('logic').value, 'Draft'); assert.equal(f.calls.filter(c => c[1].method === 'POST').length, 1); assert.match(f.text(), /could not be confirmed/);
});
test('delayed initial read and explicit reload never overwrite newer typing', async () => {
  let resolve: (value: any) => void = () => {};
  const f = fixture(() => new Promise(r => { resolve = r; }));
  f.input('logic', 'Early typing'); resolve({ current: record(), history: [record()] }); await tick();
  assert.equal(f.field('logic').value, 'Early typing');
  const reload = f.find('Reload saved checkpoint').listeners.click(); f.input('logic', 'Newer typing'); resolve({ current: record(2), history: [record(2)] }); await reload;
  assert.equal(f.field('logic').value, 'Newer typing'); assert.match(f.text(), /kept your draft/);
});
test('changing a field cancels pending confirmation and busy requests cannot double submit', async () => {
  let finish: (value: any) => void = () => {};
  const f = fixture((_p, o) => o.method === 'POST' ? new Promise(r => { finish = r; }) : { current: record(), history: [record()] });
  await tick(); await f.submit(); const oldConfirm = f.find('Confirm replace'); f.input('logic', 'Edited'); await oldConfirm.listeners.click();
  assert.equal(f.calls.length, 1); await f.submit(); const confirm = f.find('Confirm replace'); const pending = confirm.listeners.click(); await confirm.listeners.click(); await f.submit();
  assert.equal(f.calls.filter(c => c[1].method === 'POST').length, 1); finish(record(2)); await pending;
});
test('raw markup remains text, fields have labels and tips and lists reject oversized input', async () => {
  const raw = '<img src=x onerror=alert(1)>';
  const f = fixture(() => ({ current: record(1, raw), history: [record(1, raw)] })); await tick();
  assert.ok(walk(f.root).some(n => n.textContent === raw)); assert.equal(walk(f.root).some(n => n.tag === 'img'), false);
  for (const name of ['logic', 'blockers', 'next1', 'next2', 'next3']) { const field = f.field(name); assert.ok(walk(f.root).some(n => n.tag === 'label' && (n as any).htmlFor === field.id)); assert.ok(field.attrs['aria-describedby']); }
  f.input('blockers', 'a\nb\nc\nd\ne\nf'); await f.submit(); assert.equal(f.calls.length, 1); assert.match(f.text(), /at most five/);
});

test('failed initial read preserves typing and explicit retry restores access', async () => {
  let reject = true;
  const f = fixture(() => { if (reject) throw Error('read offline'); return { current: record(), history: [record()] }; });
  f.input('logic', 'Early draft'); await tick();
  assert.equal(f.field('logic').value, 'Early draft'); assert.equal(f.find('Save checkpoint').disabled, true);
  reject = false; await f.find('Reload saved checkpoint').listeners.click();
  assert.equal(f.field('logic').value, 'Saved logic'); assert.equal(f.find('Replace checkpoint').disabled, false);
});
test('out-of-order reads use the newest request and a save retains only five history entries', async () => {
  const pending: ((value: any) => void)[] = [];
  const f = fixture((_p, o) => o.method === 'POST' ? record(9) : new Promise(resolve => pending.push(resolve)));
  const latest = f.find('Reload saved checkpoint').listeners.click();
  pending[1]({ current: record(8, 'Newest read'), history: [8, 7, 6, 5, 4].map(id => record(id)) }); await latest;
  pending[0]({ current: record(1, 'Stale read'), history: [record(1)] }); await tick();
  assert.equal(f.field('logic').value, 'Newest read'); await f.submit(); await f.find('Confirm replace').listeners.click();
  const historyRows = f.root.children[3].children[1];
  assert.equal(historyRows.children.length, 5); assert.doesNotMatch(f.text(), /Stale read/);
});
test('typing during conflict reload retains both the draft and reconciliation lock', async () => {
  let resolve: (value: any) => void = () => {};
  let reads = 0;
  const f = fixture((_p, o) => {
    if (o.method === 'POST') throw Object.assign(Error('stale'), { status: 409 });
    if (++reads === 1) return { current: record(), history: [record()] };
    return new Promise(r => { resolve = r; });
  });
  await tick(); await f.submit(); await f.find('Confirm replace').listeners.click();
  const reload = f.find('Reload saved checkpoint').listeners.click(); f.input('logic', 'Still typing'); resolve({ current: record(2), history: [record(2)] }); await reload;
  assert.equal(f.field('logic').value, 'Still typing'); assert.equal(f.find('Replace checkpoint').disabled, true);
});

function projectPage(handler: (path: string, options: any) => any) {
  const select = Object.assign(new Element('select'), { value: 'main', options: [{}] });
  const box = new Element('div');
  const calls: any[] = [];
  const document = { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }) };
  const context: any = {
    document, state: {}, t: (s: string, values: any = {}) => s.replace(/\{(\w+)\}/g, (_, key) => String(values[key])),
    Option: class extends Element { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } },
    $: (selector: string) => selector === '#pj-ws' ? select : box,
    el: (tag: string, className = '', textContent = '') => Object.assign(new Element(tag), { className, textContent }),
    emptyState: () => new Element('empty'),
    api: async (path: string, options: any = {}) => { calls.push([path, options]); return handler(path, options); },
  };
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const parent = app.slice(app.indexOf('// ---------- Phase 40: coding projects'), app.indexOf("$('#pj-ws').addEventListener('change'"));
  runInNewContext(readFileSync(new URL('../web/project-checkpoints.js', import.meta.url), 'utf8').replaceAll('export ', '') + '\n' + parent + '\nthis.load = loadCodeProjects;', context);
  return { box, select, calls, load: context.load as () => Promise<void>, text: () => walk(box).map(n => n.textContent).join(' ') };
}
const projectList = (name: string) => ({ projects: [{ path: '.', facts: { name, languages: [], commands: {}, conventions: [] }, notes: [] }] });

test('parent discards late workspace projects before constructing checkpoint writers', async () => {
  const pending: ((value: any) => void)[] = [];
  const f = projectPage(path => path.startsWith('/code-projects?') ? new Promise(resolve => pending.push(resolve)) : { current: null, history: [] });
  const first = f.load(); f.select.value = 'other'; const second = f.load();
  pending[1](projectList('Other project')); await second;
  const editor = walk(f.box).find(n => n.className.split(' ').includes('project-checkpoint'));
  pending[0](projectList('Main project')); await first;
  assert.match(f.text(), /Other project/); assert.doesNotMatch(f.text(), /Main project/);
  assert.equal(walk(f.box).find(n => n.className.split(' ').includes('project-checkpoint')), editor);
  assert.equal(f.calls.filter(([path]) => path.startsWith('/code-projects/checkpoints?workspace=main')).length, 0);
});

test('parent guards obsolete errors, empty results and same-workspace loads', async () => {
  const pending: { resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  const f = projectPage(path => path.startsWith('/code-projects?') ? new Promise((resolve, reject) => pending.push({ resolve, reject })) : { current: null, history: [] });
  const first = f.load(); const second = f.load();
  pending[1].resolve(projectList('Newest project')); await second;
  pending[0].reject(Error('Obsolete failure')); await first;
  assert.match(f.text(), /Newest project/); assert.doesNotMatch(f.text(), /Obsolete failure/);
  const third = f.load(); f.select.value = 'other';
  const loading = f.box.children[0]; pending[2].resolve({ projects: [] }); await third;
  assert.equal(f.box.children[0], loading, 'selection guard protects replacement even before the next load');
  const fourth = f.load(); f.select.value = 'main';
  const latestLoading = f.box.children[0]; pending[3].reject(Error('Changed selection failure')); await fourth;
  assert.equal(f.box.children[0], latestLoading);
});

test('note writes stay local, serialize, deduplicate returned ids and preserve checkpoint drafts on failure', async () => {
  let finish: (value: any) => void = () => {};
  let failDelete = true;
  const note = { id: 1, kind: 'note', text: 'Confirmed note' };
  const f = projectPage((path, options) => {
    if (path.startsWith('/code-projects?')) return projectList('Main project');
    if (path.startsWith('/code-projects/checkpoints?')) return { current: null, history: [] };
    if (options.method === 'DELETE') { if (failDelete) throw Error('Synthetic delete error'); return { deleted: true }; }
    return new Promise(resolve => { finish = resolve; });
  });
  await f.load(); await tick();
  const editor = walk(f.box).find(n => n.className.split(' ').includes('project-checkpoint'))!;
  const logic = walk(editor).find(n => n.dataset.field === 'logic')!;
  logic.value = 'Keep unsaved work'; logic.listeners.input();
  const add = walk(f.box).find(n => n.tag === 'button' && n.textContent === 'Add note')!;
  const input = walk(f.box).find(n => n.tag === 'input' && !n.dataset.field)!;
  input.value = 'Confirmed note'; const first = add.listeners.click(); const repeated = add.listeners.click();
  assert.equal(add.disabled, true); assert.equal(f.calls.filter(([, o]) => o.method === 'POST').length, 1);
  finish(note); await first; await repeated;
  assert.equal(input.value, ''); assert.equal(add.disabled, false);
  input.value = 'Confirmed note'; const duplicate = add.listeners.click(); finish(note); await duplicate;
  const notes = walk(f.box).find(n => n.className === 'pj-notes')!;
  assert.equal(notes.children.length, 1);
  const remove = walk(notes).find(n => n.tag === 'button')!;
  await remove.listeners.click();
  assert.match(f.text(), /Synthetic delete error/); assert.equal(remove.disabled, false); assert.equal(notes.children.length, 1);
  failDelete = false; await remove.listeners.click();
  assert.equal(notes.children.length, 0); assert.equal(logic.value, 'Keep unsaved work');
  assert.equal(walk(f.box).find(n => n.className.split(' ').includes('project-checkpoint')), editor);
  assert.equal(f.calls.filter(([path]) => path.startsWith('/code-projects?')).length, 1);
});

test('failed note additions preserve input, report text safely and unlock retry', async () => {
  let fail = true;
  const f = projectPage((path, options) => {
    if (path.startsWith('/code-projects?')) return projectList('Main project');
    if (options.method === 'POST') {
      if (fail) throw Error('<img src=x onerror=alert(1)>');
      return { id: 1, kind: 'note', text: 'Retry note' };
    }
    return { current: null, history: [] };
  });
  await f.load(); await tick();
  const input = walk(f.box).find(n => n.tag === 'input' && !n.dataset.field)!;
  const add = walk(f.box).find(n => n.tag === 'button' && n.textContent === 'Add note')!;
  input.value = 'Retry note'; await add.listeners.click();
  assert.equal(input.value, 'Retry note'); assert.equal(add.disabled, false); assert.equal(input.disabled, false);
  assert.match(f.text(), /<img src=x onerror=alert\(1\)>/); assert.equal(walk(f.box).some(n => n.tag === 'img'), false);
  fail = false; await add.listeners.click();
  assert.equal(input.value, ''); assert.doesNotMatch(f.text(), /onerror/);
  assert.equal(walk(f.box).find(n => n.className === 'pj-notes')!.children.length, 1);
});
