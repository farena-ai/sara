import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveCall, type Upstream } from '../src/live.ts';
import type { WsConnection } from '../src/ws.ts';
import { makeApp, tempDir } from './helpers.ts';

function fixture(partner?: string) {
  const temp = tempDir();
  const app = makeApp(temp.dir, { now: new Date('2026-11-05T15:00:00Z') });
  app.persona.name = 'Nova';
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: '2026-11-05T15:00:00Z', memory: { enabled: false } } as never);
  const conv = app.store.createConversation(partner ? { partner } : {});
  const up: Upstream = { onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
  const client: WsConnection = { open: true, send() {}, close() {} };
  const live = new LiveCall(app, conv.id, client, 'synthetic-fixture', { connect: () => up });
  const emit = (event: Record<string, unknown>) => up.onmessage?.({ data: JSON.stringify(event) });
  return {
    app, conv, live,
    start() { live.start(); up.onopen?.({}); emit({ type: 'session.updated' }); },
    hear(content: string) { emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'owner-1', transcript: content, status: 'completed' }); },
    async close() { live.end('Fixture finished.'); await new Promise<void>((resolve) => setImmediate(resolve)); app.store.close(); temp.cleanup(); },
  };
}

test('E2 live: an ordinary owner transcript has trusted provenance and actual-name legacy attribution', async () => {
  const f = fixture();
  try {
    f.start();
    f.hear('Nova is useless.');
    const owner = f.app.store.messages(f.conv.id).find((message) => message.role === 'user')!;
    assert.ok(owner, 'the real voice event stores the final transcript');
    assert.equal(owner.ownerOrigin, 'direct-v1');
    assert.equal(f.app.inner!.get().irritation, 0.45);
  } finally { await f.close(); }
});

test('E2 live: a nonowner conversation cannot read or mutate global owner-derived causes', async () => {
  const f = fixture('Casey');
  try {
    f.app.inner!.apply([{ label: 'owner-only cause marker', irritation: 0.4, tension: 0.5 }]);
    const before = f.app.inner!.get();
    assert.doesNotMatch(f.live.instructions(), /owner-only cause marker/);
    f.start();
    f.hear('You are useless.');
    assert.deepEqual(f.app.inner!.get(), before);
    assert.equal(f.app.store.messages(f.conv.id).find((message) => message.role === 'user')!.ownerOrigin ?? null, null);
  } finally { await f.close(); }
});
