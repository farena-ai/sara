// R1B2/R1B3 follow-ups: her canon writes as a chip in the transcript, the "In scene" chip opens the
// scene card, and a chip on each line that became canon. Invented people only (Alex, Priya).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createScene, getScene, linkSeat, sceneChipFor, setCanon } from '../src/shared-scenes-policy.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const NOW = '2026-11-05T12:00:00.000Z';

test('scene chip lists the lines of this chat that are canon (current, from a line, not her writes)', () => {
  const temp = tempDir();
  const app = makeApp(temp.dir, { now: new Date(NOW) });
  try {
    app.settings.update({ ownerName: 'Alex' });
    const web = app.store.createConversation({ title: 'Web story' });
    const scene = createScene(app, { title: 'The Ember Road', premise: 'A caravan crosses the dunes.' });
    const rev = () => getScene(app, scene.id).scene.revision;
    linkSeat(app, scene.id, { conversationId: web.id, expectedRevision: rev(), confirmAudience: true });
    const line = app.store.addMessage(web.id, 'user', 'The caravan halts at the well.');
    setCanon(app, scene.id, { expectedRevision: rev(), key: 'well', fromMessageId: line.id });
    setCanon(app, scene.id, { expectedRevision: rev(), key: 'typed', text: 'The dunes are endless.' });
    const chip = sceneChipFor(app, web.id)!;
    assert.equal(chip.id, scene.id);
    assert.deepEqual(chip.lines, [{ messageId: line.id, key: 'well' }]);
  } finally {
    app.store.close();
    temp.cleanup();
  }
});

/** A tiny DOM for web/scenes.js. */
class N {
  children: N[] = []; listeners: Record<string, Function> = {}; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  textContent = ''; className = ''; id = ''; title = ''; type = ''; hidden = false; tag: string;
  classList = { add: (c: string) => { this.className += ` ${c}`; }, contains: (_c: string) => false };
  constructor(tag: string) { this.tag = tag; }
  append(...n: N[]) { this.children.push(...n); }
  prepend(...n: N[]) { this.children.unshift(...n); }
  replaceChildren(...n: N[]) { this.children = n; }
  querySelectorAll() { return []; }
  focus() {}
  scrollIntoView() {}
  after(n: N) { this.children.push(n); }
  remove() {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(k: string, f: Function) { this.listeners[k] = f; }
  querySelector(sel: string): N | null { return sel === '#scene-chip' ? this.children.find(c => c.id === 'scene-chip') ?? null : sel === '#chat-title' ? this : null; }
}

function loadScenes() {
  const wrap = new N('div');
  const box = new N('div');
  const opened: string[] = [];
  const calls: string[] = [];
  const document = { createElement: (tag: string) => new N(tag), body: new N('body'), querySelector: (s: string) => (s === '#chat-head .title-wrap' ? wrap : s === '#scenes-box' ? box : new N('x')) };
  const sandbox: any = { document, t: (s: string, v: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (_m, k) => v[k] ?? ''), console };
  runInNewContext(`${readFileSync(join(ROOT, 'web/scenes.js'), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '')}\nthis.m = { initScenes, renderSceneChip, canonChip, lineCanonChip };`, sandbox);
  const api = async (p: string) => { calls.push(p); return { scene: { id: 7, title: 'The Ember Road', premise: '', status: 'active', revision: 1, adult: false }, seats: [], canon: [], options: [] }; };
  sandbox.m.initScenes({ api, openSettings: async (page: string) => { opened.push(page); } });
  return { m: sandbox.m, wrap, opened, calls };
}

test('the In scene chip is a button that opens that scene card', async () => {
  const f = loadScenes();
  f.m.renderSceneChip({ scene: { id: 7, title: 'The Ember Road', status: 'active', audience: 'owner' } });
  const chip = f.wrap.children.find(c => c.id === 'scene-chip')!;
  assert.equal(chip.tag, 'button');
  await chip.listeners.click();
  assert.deepEqual(f.opened, ['co-continuity']);
  assert.ok(f.calls.includes('/scenes/7'), 'the scene card is opened');
});

test('her canon writes and canon lines show as chips that open the scene', async () => {
  const f = loadScenes();
  const conv = { scene: { id: 7, title: 'The Ember Road', status: 'active', audience: 'owner', lines: [{ messageId: 12, key: 'well' }] } };
  const tool = (args: Record<string, unknown>, status = 'ok') => ({ role: 'tool', meta: { name: 'scene_canon', args, status } });
  const saved = f.m.canonChip(tool({ action: 'set', key: 'inn', text: 'The inn burned.', expectedRevision: 2 }), conv);
  assert.equal(saved.textContent, 'Saved to the scene: inn');
  assert.equal(f.m.canonChip(tool({ action: 'retire', key: 'inn', expectedRevision: 3 }), conv).textContent, 'Removed from the scene: inn');
  assert.equal(f.m.canonChip(tool({ action: 'read' }), conv), undefined, 'reading is not a write');
  assert.equal(f.m.canonChip(tool({ action: 'set', key: 'inn' }, 'error'), conv), undefined, 'a failed write shows nothing');
  assert.equal(f.m.canonChip(tool({ action: 'set', key: 'inn' }), {}), undefined, 'not a scene chat');
  assert.equal(f.m.canonChip({ role: 'tool', meta: { name: 'shell', args: {}, status: 'ok' } }, conv), undefined);
  await saved.listeners.click();
  assert.deepEqual(f.opened, ['co-continuity']);
  assert.equal(f.m.lineCanonChip({ id: 12, role: 'user' }, conv).textContent, 'Canon: well');
  assert.equal(f.m.lineCanonChip({ id: 13, role: 'user' }, conv), undefined);
});
