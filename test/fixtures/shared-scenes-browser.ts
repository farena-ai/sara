import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../../src/auth.ts';
import { createSaraServer } from '../../src/server.ts';
import { RELEASE_API } from '../../src/updates.ts';
import { LookBuilder } from '../../src/look.ts';
import { getScene, sceneCanonForTurn } from '../../src/shared-scenes-policy.ts';
import { noteRoom } from '../../src/bridges/rooms.ts';
import { makeApp, ROOT, tempDir } from '../helpers.ts';

/** Actual app on loopback with invented temporary data; no owner profile, provider or outbound call. */
export async function startScenesBrowserFixture() {
  const temp = tempDir(); const clock = { now: new Date('2026-11-05T12:00:00.000Z') }; const app = makeApp(temp.dir, clock);
  let server: ReturnType<typeof createSaraServer> | undefined; let closed = false;
  const originalFetch = globalThis.fetch; const unexpectedOutbound: string[] = [];
  const close = async () => {
    if (closed) return; closed = true;
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server!.close(() => resolve())); }
    try { app.store.close(); } finally { globalThis.fetch = originalFetch; temp.cleanup(); }
  };
  try {
    globalThis.fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (['127.0.0.1', 'host.docker.internal'].includes(url.hostname) && url.port === '11434' && url.pathname === '/api/tags') return Response.json({ models: [] });
      unexpectedOutbound.push(`blocked-${url.origin}${url.pathname}`); throw Error('Synthetic scenes fixture permits no outbound calls');
    };
    app.settings.update({ usePath: 'coding', ownerName: 'Alex', persona: { innerLife: false, typing: 'instant' }, proactive: { enabled: false }, providers: [] } as never);
    app.store.createConversation({ channel: 'discord', channelKey: 'alex-dm', title: 'Discord DM with Alex' });
    // R1B3: a fixture Discord room (no bridge runs; the room row is what the Discord bridge records).
    app.settings.update({ discord: { enabled: true } } as never);
    noteRoom(app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: 'tavern', parentTitle: 'Moonlight Guild' });
    const room = app.store.createConversation({ channel: 'discord', channelKey: 'tavern-1', partner: 'people in a Discord channel', title: 'Discord: #tavern · Moonlight Guild' });
    app.store.addMessage(room.id, 'user', "[Priya]: Priya's ranger Ash joins the caravan at the well.");
    app.store.addMessage(room.id, 'assistant', 'Welcome aboard, Ash. The caravan waits for no one.');
    app.look = new LookBuilder({ dataDir: temp.dir, key: async () => undefined });
    const auth = new OwnerAuth(temp.dir);
    server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), updaterFetch: async input => {
      if (String(input) !== RELEASE_API) { unexpectedOutbound.push('unexpected-updater-destination'); throw Error('Unexpected updater destination'); }
      return Response.json({ tag_name: 'v0.0.0', draft: false, prerelease: false });
    } });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    /** R1B2: a fact she saved with scene_canon in a linked chat (the host capability, no model call). */
    const herCanon = (sceneId: number, conversationId: string, key: string, value: string) => {
      const step = app.store.addMessage(conversationId, 'assistant', 'Noted in the story.');
      const canon = sceneCanonForTurn(app, conversationId, {});
      if (!canon) throw Error('fixture conversation is not an eligible scene seat');
      return canon.set({ key, text: value, expectedRevision: getScene(app, sceneId).scene.revision }, step.id);
    };
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: auth.newToken!, providerRequests: () => app.requests.length, unexpectedOutbound, herCanon, roomId: room.id, close };
  } catch (error) { await close(); throw error; }
}
