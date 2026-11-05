import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('actor workspace conversation drafts and immutable requests survive reload without crossing scopes', async () => {
  // @ts-expect-error Browser module is exercised directly under Node.
  const { BusinessDrafts } = await import('../web/business-state.js');
  const entries = new Map<string, string>(); const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) };
  const a = new BusinessDrafts(storage, 'actor-a', 'session-a');
  a.save('workspace-a', 'conversation-a', { text: 'Private draft', documentIds: [] });
  const payload = a.begin('workspace-a', 'conversation-a', { text: 'Private draft', documentIds: [], modelPolicy: 'policy', acknowledgeDisclosure: true });
  a.save('workspace-b', 'conversation-b', { text: 'Different draft', documentIds: [] });
  assert.equal(a.read('workspace-b', 'conversation-b').text, 'Different draft');
  assert.equal(new BusinessDrafts(storage, 'actor-b', 'session-a').read('workspace-a', 'conversation-a').text, '');
  const resumed = new BusinessDrafts(storage, 'actor-a', 'session-a');
  assert.deepEqual(resumed.pending('workspace-a', 'conversation-a'), payload);
  assert.deepEqual(resumed.begin('workspace-a', 'conversation-a', { text: 'Changed' }), payload);
  resumed.clear(); assert.equal(resumed.read('workspace-a', 'conversation-a').text, '');
});

test('late scoped mutations preserve newer stores and cannot resurrect logout or replace another request', async () => {
  // @ts-expect-error Browser module is exercised directly under Node.
  const { BusinessDrafts } = await import('../web/business-state.js');
  const entries = new Map<string, string>(); const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) };
  const first = new BusinessDrafts(storage, 'a', 's');
  const original = first.begin('w1', 'c1', { text: 'Original' });
  const afterBoot = new BusinessDrafts(storage, 'a', 's');
  afterBoot.save('w2', 'c2', { text: 'New draft after boot', documentIds: ['doc'] });
  const newer = afterBoot.begin('w2', 'c2', { text: 'New pending' });
  first.finish('w1', 'c1', original.requestId);
  assert.equal(afterBoot.read('w2', 'c2').text, 'New draft after boot');
  const reload = new BusinessDrafts(storage, 'a', 's');
  assert.equal(reload.read('w2', 'c2').text, 'New draft after boot');
  assert.equal(reload.pending('w2', 'c2').requestId, newer.requestId);
  first.finish('w2', 'c2', original.requestId);
  assert.equal(reload.pending('w2', 'c2').requestId, newer.requestId);
  afterBoot.clear();
  first.markReady('w2', 'c2', true, newer.requestId);
  first.save('w1', 'c1', { text: 'Late callback', documentIds: [] });
  assert.equal(entries.size, 0);
  const fresh = new BusinessDrafts(storage, 'a', 's');
  fresh.save('w2', 'c2', { text: 'Fresh after access check', documentIds: [] });
  first.clear(); first.finish('w2', 'c2', newer.requestId);
  assert.equal(fresh.read('w2', 'c2').text, 'Fresh after access check');
});

test('unknown transport remains immutable after a later pre-admission refusal', async () => {
  // @ts-expect-error Browser module is exercised directly under Node.
  const { BusinessDrafts } = await import('../web/business-state.js');
  const entries = new Map<string, string>(); const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) };
  const drafts = new BusinessDrafts(storage, 'a', 's');
  const original = drafts.begin('w', 'c', { text: 'Original' });
  drafts.uncertain('w', 'c', original.requestId);
  drafts.unsubmitted('w', 'c', original.requestId);
  assert.equal(drafts.pending('w', 'c').requestId, original.requestId);
});

test('renderer loss before catch preserves original binding in a fresh module realm after a refused retry', async () => {
  const source = readFileSync(new URL('../web/business-state.js', import.meta.url), 'utf8');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const FirstRealm = (await import(moduleUrl + '#before-crash')).BusinessDrafts;
  const FreshRealm = (await import(moduleUrl + '#after-crash')).BusinessDrafts;
  const entries = new Map<string, string>(); const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) };
  const first = new FirstRealm(storage, 'a', 's');
  first.save('w', 'c', { text: 'Original before crash', documentIds: ['doc'] });
  const original = first.begin('w', 'c', { text: 'Original before crash', documentIds: ['doc'] });
  first.dispatch('w', 'c', original.requestId);
  // Only serialized Storage crosses the realm boundary; the original catch never runs.
  const recovered = new FreshRealm(storage, 'a', 's');
  recovered.markReady('w', 'c', true, original.requestId);
  const retry = recovered.begin('w', 'c', { text: 'Must not replace' });
  const attempt = recovered.dispatch('w', 'c', retry.requestId);
  recovered.unsubmitted('w', 'c', retry.requestId, attempt);
  assert.deepEqual(recovered.pending('w', 'c'), original);
  assert.equal(recovered.read('w', 'c').text, 'Original before crash');
});

test('only the owning first live dispatch may release a definitively refused request', async () => {
  // @ts-expect-error Browser module is exercised directly under Node.
  const { BusinessDrafts } = await import('../web/business-state.js');
  const entries = new Map<string, string>(); const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) };
  const first = new BusinessDrafts(storage, 'a', 's');
  const original = first.begin('w', 'c', { text: 'Fresh request' });
  const attempt = first.dispatch('w', 'c', original.requestId);
  assert.equal(JSON.parse(storage.getItem(first.key)!)['w/c'].uncertain, true);
  first.unsubmitted('w', 'c', original.requestId, attempt);
  assert.equal(first.pending('w', 'c'), undefined);
  const next = first.begin('w', 'c', { text: 'Next request' });
  const oldAttempt = first.dispatch('w', 'c', next.requestId);
  const reconstructed = new BusinessDrafts(storage, 'a', 's');
  reconstructed.dispatch('w', 'c', next.requestId);
  first.unsubmitted('w', 'c', next.requestId, oldAttempt);
  assert.equal(first.pending('w', 'c').requestId, next.requestId);
});
