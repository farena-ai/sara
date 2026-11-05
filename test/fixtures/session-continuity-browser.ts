import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../../src/auth.ts';
import { createSaraServer } from '../../src/server.ts';
import { RELEASE_API } from '../../src/updates.ts';
import { LookBuilder } from '../../src/look.ts';
import { continuityForTurn, inspectSessionHandoffs } from '../../src/session-continuity.ts';
import { makeApp, ROOT, tempDir } from '../helpers.ts';

/** Actual app, invented temporary data and loopback only; no owner profile or inference. */
export async function startSessionContinuityBrowserFixture() {
  const temp = tempDir(); const clock = { now: new Date('2026-11-05T12:00:00.000Z') }; const app = makeApp(temp.dir, clock);
  let server: ReturnType<typeof createSaraServer> | undefined; let keep = false; let closed = false;
  const originalFetch = globalThis.fetch; const unexpectedOutbound: string[] = []; let syntheticUpdateChecks = 0;
  const close = async () => {
    if (closed) return; closed = true;
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server!.close(() => resolve())); }
    try { app.store.close(); } finally { globalThis.fetch = originalFetch; if (!keep) temp.cleanup(); }
  };
  try {
    globalThis.fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (['127.0.0.1', 'host.docker.internal'].includes(url.hostname) && url.port === '11434' && url.pathname === '/api/tags') return Response.json({ models: [] });
      unexpectedOutbound.push(`blocked-${url.origin}${url.pathname}`); throw Error('Synthetic continuity fixture permits no outbound calls');
    };
    const preservedChats = { whileBusy: 'queue', queueMax: 10, pickup: { mode: 'off', within: 60, lines: 6, folder: false, apps: { discord: false } }, btw: { model: 'local', dailyCap: 20 } };
    app.settings.update({ usePath: 'coding', persona: { innerLife: false, typing: 'instant' }, proactive: { enabled: false }, providers: [], chats: preservedChats } as never);
    const source = app.store.createConversation({ title: '<b>Source session</b>' });
    app.store.addMessage(source.id, 'user', 'Synthetic context only');
    const target = app.store.createConversation({ title: 'Continuity target' });
    app.store.addMessage(target.id, 'user', 'Synthetic target');
    const other = app.store.createConversation({ title: 'Keep other target' });
    const raw = '<img src=x onerror="window.__continuityPwned=1">';
    const write = (text = raw) => {
      // Fixture host remains the authenticated synthetic owner; this is never a browser API.
      const before = app.settings.get().chats;
      app.settings.update({ chats: { ...before, continuity: { enabled: true } } });
      try {
        const current = inspectSessionHandoffs(app, target.id).handoffs.find(record => record.sourceConversationId === source.id)?.id ?? 0;
        return continuityForTurn(app, source.id)!.handoff({ targetId: target.id, text, expectedId: current }).record;
      } finally { app.settings.update({ chats: before }); }
    };
    write(); continuityForTurn(app, source.id)!.handoff({ targetId: other.id, text: 'Keep this other target context', expectedId: 0 });
    app.look = new LookBuilder({ dataDir: temp.dir, key: async () => undefined });
    const auth = new OwnerAuth(temp.dir); server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), updaterFetch: async input => {
      if (String(input) !== RELEASE_API) { unexpectedOutbound.push('unexpected-updater-destination'); throw Error('Unexpected updater destination'); }
      syntheticUpdateChecks++;
      return Response.json({ tag_name: 'v0.0.0', draft: false, prerelease: false });
    } });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: auth.newToken!, targetId: target.id, otherId: other.id, raw, dataDir: temp.dir, write, advancePastExpiry: () => { clock.now = new Date(clock.now.getTime() + 86400001); }, retained: (id = target.id) => Number(app.store.db.prepare('SELECT COUNT(*) AS n FROM session_handoffs WHERE target_conversation_id=?').get(id)?.n ?? 0), inspect: (id = target.id) => inspectSessionHandoffs(app, id), chats: () => app.settings.get().chats, preservedChats, syntheticUpdateChecks: () => syntheticUpdateChecks, providerRequests: () => app.requests.length, unexpectedOutbound, close, preserve: () => { keep = true; } };
  } catch (error) { await close(); throw error; }
}
