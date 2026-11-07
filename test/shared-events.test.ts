// B1 follow-up: browsers allow 6 HTTP/1.1 connections per server, and every open tab held its own
// /api/events stream, so with a few tabs (or one more streaming reply) every button press waited.
// One tab now holds the stream for all tabs of the browser and passes its events on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ROOT } from './helpers.ts';

function browser(opts: { locks?: boolean } = {}) {
  const sources: FakeES[] = [];
  class FakeES {
    static CLOSED = 2;
    readyState = 0; url: string; onerror: ((e: unknown) => void) | null = null; listeners = new Map<string, Set<Function>>();
    constructor(url: string) { this.url = url; sources.push(this); }
    addEventListener(type: string, fn: Function) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }
    emit(type: string, data?: string) { if (type === 'open') this.readyState = 1; for (const fn of this.listeners.get(type) ?? []) fn({ type, data }); }
    close() { this.readyState = 2; }
  }
  const channels = new Set<FakeBC>();
  class FakeBC {
    name: string; onmessage: ((m: { data: unknown }) => void) | null = null;
    constructor(name: string) { this.name = name; channels.add(this); }
    postMessage(data: unknown) { for (const c of channels) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data: structuredClone(data) })); }
    close() { channels.delete(this); }
  }
  // Web Locks: one holder per name, the rest wait in order; an aborted waiter leaves the queue.
  const held = new Map<string, boolean>(); const waiting = new Map<string, { cb: () => Promise<unknown>; signal?: AbortSignal }[]>();
  const grant = (name: string) => {
    const q = waiting.get(name) ?? [];
    while (q.length && q[0].signal?.aborted) q.shift();
    const next = q.shift();
    if (!next) return;
    held.set(name, true);
    void Promise.resolve(next.cb()).finally(() => { held.set(name, false); grant(name); });
  };
  const locks = { request: (name: string, options: { signal?: AbortSignal }, cb: () => Promise<unknown>) => {
    if (!waiting.has(name)) waiting.set(name, []);
    waiting.get(name)!.push({ cb, signal: options.signal });
    if (!held.get(name)) grant(name);
    return Promise.resolve();
  } };
  const env = { EventSource: FakeES, BroadcastChannel: FakeBC, navigator: opts.locks === false ? {} : { locks } };
  const sandbox: any = { ...env, setTimeout, queueMicrotask, structuredClone, AbortController, Promise, Map, Set };
  runInNewContext(`${readFileSync(join(ROOT, 'web/shared-events.js'), 'utf8').replaceAll('export ', '')}\nthis.sharedEvents = sharedEvents;`, sandbox);
  return { sources, open: (url = '/api/events') => sandbox.sharedEvents(url, env) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('two tabs share one /api/events stream; both get every event', async () => {
  const b = browser();
  const got: string[] = [];
  const tab1 = b.open(); tab1.addEventListener('message', (e: { data: string }) => got.push(`1:${e.data}`));
  const tab2 = b.open(); tab2.addEventListener('message', (e: { data: string }) => got.push(`2:${e.data}`));
  await tick();
  assert.equal(b.sources.length, 1, 'one connection for the whole browser');
  b.sources[0].emit('open');
  b.sources[0].emit('message', '{"n":1}');
  await tick();
  assert.deepEqual(got.sort(), ['1:{"n":1}', '2:{"n":1}']);
  assert.equal(tab2.readyState, 1, 'the other tab knows the stream is open');
});

test('when the tab holding the stream closes, another tab takes over', async () => {
  const b = browser();
  const got: string[] = [];
  const tab1 = b.open(); tab1.addEventListener('job', () => got.push('1'));
  const tab2 = b.open(); tab2.addEventListener('job', (e: { data: string }) => got.push(`2:${e.data}`));
  await tick();
  tab1.close();
  await tick();
  assert.equal(b.sources.length, 2);
  assert.equal(b.sources[0].readyState, 2, 'the old stream is closed');
  b.sources[1].emit('job', 'x');
  await tick();
  assert.deepEqual(got, ['2:x']);
  // A closed tab that never held the lock never opens a stream later.
  const tab3 = b.open(); tab3.close(); tab2.close();
  await tick();
  assert.equal(b.sources.length, 2);
});

test('a stream that ends (signed out) is reported as closed in every tab', async () => {
  const b = browser();
  const errors: number[] = [];
  const tab1 = b.open(); tab1.onerror = () => errors.push(1);
  const tab2 = b.open(); tab2.onerror = () => errors.push(2);
  await tick();
  b.sources[0].readyState = 2;
  b.sources[0].onerror?.({});
  await tick();
  assert.deepEqual(errors.sort(), [1, 2]);
  assert.equal(tab1.readyState, 2);
  assert.equal(tab2.readyState, 2);
});

test('without Web Locks or BroadcastChannel each tab keeps its own stream', () => {
  const b = browser({ locks: false });
  b.open(); b.open();
  assert.equal(b.sources.length, 2);
});
