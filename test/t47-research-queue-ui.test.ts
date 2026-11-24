// C23: the web side of more than one research run. The card functions are run with a small
// stand-in for the page: a waiting run says so with its place in line and has its own Stop; the
// runs that are not over are listed apart, oldest first; buttons act on their own run only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

interface FakeEl {
  tag: string;
  className: string;
  textContent: string;
  type?: string;
  children: FakeEl[];
  dataset: Record<string, string>;
  handlers: Record<string, () => void>;
  append: (...c: FakeEl[]) => void;
  addEventListener: (type: string, f: () => void) => void;
  setAttribute: (k: string, v: string) => void;
}
const fakeDocument = {
  createElement(tag: string): FakeEl {
    const e: FakeEl = {
      tag,
      className: '',
      textContent: '',
      children: [],
      dataset: {},
      handlers: {},
      append: (...c) => void e.children.push(...c),
      addEventListener: (type, f) => void (e.handlers[type] = f),
      setAttribute: () => undefined,
    };
    return e;
  },
};

test('t47 research ui: a waiting run says its place in line, keeps polling and has its own Stop; runs that are not over are listed apart', async () => {
  (globalThis as { document?: unknown }).document = fakeDocument;
  // naming.js needs the server (it imports /identity.js): English text with its {values} filled stands in.
  const naming = 'data:text/javascript,' + encodeURIComponent('export const t = (s, p) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? String(p[k]) : m)); export const serverText = (d, f) => f;');
  const src = readFileSync(join(ROOT, 'web', 'research-card.js'), 'utf8').replace("'./naming.js'", JSON.stringify(naming));
  const card = await import('data:text/javascript,' + encodeURIComponent(src));
  assert.match(card.statusLine({ status: 'queued', queuePos: 1 }), /^Waiting its turn: it starts when/);
  assert.equal(card.statusLine({ status: 'queued', queuePos: 3 }), 'Waiting its turn: number 3 in line.');
  assert.equal(card.working('queued'), true, 'a waiting run is polled until its turn comes');
  assert.equal(card.working('paused'), false);

  const calls: string[] = [];
  const act = (path: string) => void calls.push(path);
  const labels = (run: object) => (card.runButtons(run, act, { open: false }) as FakeEl).children.map((b) => b.textContent);
  assert.deepEqual(labels({ id: 7, status: 'queued' }), ['Stop']);
  assert.deepEqual(labels({ id: 8, status: 'running' }), ['Pause', 'Write the report now', 'Stop']);
  // Each row's buttons act on that run only.
  const q = card.runButtons({ id: 7, status: 'queued' }, act, {}) as FakeEl;
  const r = card.runButtons({ id: 8, status: 'running' }, act, {}) as FakeEl;
  q.children[0].handlers.click();
  r.children.at(-1)!.handlers.click();
  r.children[0].handlers.click();
  assert.deepEqual(calls, ['/research/7/stop', '/research/8/stop', '/research/8/pause']);

  const runs = [
    { id: 9, status: 'queued' },
    { id: 5, status: 'done' },
    { id: 8, status: 'running' },
    { id: 6, status: 'stopped' },
    { id: 7, status: 'paused' },
    { id: 4, status: 'plan' },
    { id: 3, status: 'failed' },
  ];
  assert.deepEqual(card.activeRuns(runs).map((x: { id: number }) => x.id), [4, 7, 8, 9], 'not over, oldest first');
  assert.deepEqual(card.activeRuns(undefined), []);
});
