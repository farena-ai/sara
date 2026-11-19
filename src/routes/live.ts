// Live voice calls: the WebSocket upgrade at /api/live/<conversation id> (owner only, same site).
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { deviceLabel } from '../auth.ts';
import { openingNote } from '../calls.ts';
import { isGroupChannel } from '../group.ts';
import { memberRouteCheck } from '../household.ts';
import { isSameOrigin, safeDecode } from '../http.ts';
import { LiveCall } from '../live.ts';
import { acceptWebSocket, refuseUpgrade } from '../ws.ts';
import type { RouteCtx } from './context.ts';
import { en } from '../i18n.ts';

export function createLiveUpgrade(ctx: RouteCtx): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const { app, demoAccepted, demoCalls, demoOwner, isAuthed, me, offApp, offStore, opts, speech, videos, visitorKey } = ctx;
  // Live voice calls: /api/live/<conversation id> upgrades to a WebSocket (owner only, same site).
  return (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = /^\/api\/live\/([^/]+)$/.exec(url.pathname);
      if (!m) return refuseUpgrade(socket, 404, 'Not Found');
      if (!isSameOrigin(req)) return refuseUpgrade(socket, 403, 'Forbidden');
      if (!isAuthed(req)) return refuseUpgrade(socket, 401, 'Unauthorized');
      // Phase 71: a member's calls follow their account's state and the voice switch.
      if (opts.member && memberRouteCheck(opts.member.record(), 'GET', ['live'])) return refuseUpgrade(socket, 403, 'Forbidden');
      let convId = '';
      try {
        convId = safeDecode(m[1]);
      } catch {
        return refuseUpgrade(socket, 404, 'Not Found');
      }
      // Demo (app review): only with the reviewer code, in the visitor's own conversation, within
      // the per-call and daily limits; never answering a ring (she doesn't call in the demo).
      if (opts.demo) {
        const visitor = visitorKey(req);
        if (!demoCalls.enabled) return refuseUpgrade(socket, 403, 'Forbidden');
        if (!offStore.getConversation(convId) || demoOwner.get(convId) !== visitor) return refuseUpgrade(socket, 404, 'Not Found');
        if (!demoAccepted.has(visitor) || !demoCalls.unlocked(visitor) || url.searchParams.get('ring')) return refuseUpgrade(socket, 403, 'Forbidden');
        const choice = speech.liveChoice();
        let key: string | undefined;
        try {
          key = choice.engine ? await speech.liveKey(choice.engine) : undefined;
        } catch (err) {
          console.error('demo live call key:', (err as Error).message);
        }
        const ws = acceptWebSocket(req, socket, head);
        if (!ws) return;
        if (!key || !choice.engine) {
          ws.send(JSON.stringify({ type: 'ended', reason: en('Live calls are not available on the demo right now.') }));
          return ws.close(1000);
        }
        if (ctx.liveCall && !ctx.liveCall.ended) {
          ws.send(JSON.stringify({ type: 'ended', reason: en('Another demo call is going on. Try again in a few minutes.') }));
          return ws.close(1000);
        }
        const go = demoCalls.begin(visitor);
        if (!go.ok) {
          ws.send(JSON.stringify({ type: 'ended', reason: go.reason }));
          return ws.close(1000);
        }
        const minutes = Math.max(1, Math.round(go.maxMs / 60_000));
        // Hardening L3: if setting the call up throws, the demo call slot is freed (not stuck until a restart).
        try {
          ctx.liveCall = new LiveCall(offApp, convId, ws, key, {
            engine: choice.engine,
            video: url.searchParams.get('video') === '1',
            ...(opts.liveConnect ? { connect: opts.liveConnect } : {}),
            maxMs: go.maxMs,
            maxReason: go.byBudget ? 'That’s all the demo calling for today. Try again tomorrow.' : `Demo calls last up to ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            onEnd: () => go.done(),
          });
          ctx.liveCall.start();
        } catch (err) {
          go.done();
          console.error('demo live call:', (err as Error).message);
          const why = 'The call couldn’t start. Try again in a moment.';
          if (ctx.liveCall && !ctx.liveCall.ended) ctx.liveCall.end(why);
          else {
            try {
              ws.send(JSON.stringify({ type: 'ended', reason: why }));
              ws.close(1000);
            } catch {
              /* already closed */
            }
          }
        }
        return;
      }
      const conv = app.store.getConversation(convId);
      if (!conv || conv.partner) return refuseUpgrade(socket, 404, 'Not Found');
      // Phase 66: calls are one to one; a group chat has none.
      if (isGroupChannel(conv.channel)) {
        const gws = acceptWebSocket(req, socket, head);
        if (!gws) return;
        gws.send(JSON.stringify({ type: 'ended', reason: en('Calls aren’t available in group chats.') }));
        return gws.close(1000);
      }
      if (!app.settings.get().disclosureAcceptedAt) return refuseUpgrade(socket, 403, 'Forbidden');
      // Security review: a private conversation only goes to hardware the owner controls, and live
      // calls run on a cloud voice service (her character, memories and earlier lines would go
      // along). Say so plainly instead of calling.
      if (conv.private) {
        const pws = acceptWebSocket(req, socket, head);
        if (!pws) return;
        const r = url.searchParams.get('ring');
        if (r) app.calls?.decline(r);
        pws.send(JSON.stringify({ type: 'ended', reason: me('Live calls are off in private conversations: the call would go through a cloud voice service. Use voice notes or a normal conversation for a call.'), private: true }));
        return pws.close(1000);
      }
      // Phase 48: Grok or OpenAI, per Settings → Voice → "Live calls with".
      const choice = speech.liveChoice();
      let key: string | undefined;
      try {
        key = choice.engine ? await speech.liveKey(choice.engine) : undefined;
      } catch (err) {
        key = undefined;
        console.error('live call key:', (err as Error).message);
      }
      const ws = acceptWebSocket(req, socket, head);
      if (!ws) return;
      if (!key || !choice.engine) {
        // Her call can't connect: stop ringing everywhere, and she sends it as a message.
        const r = url.searchParams.get('ring');
        if (r) app.calls?.decline(r);
        ws.send(JSON.stringify({ type: 'ended', reason: me(choice.engine ? 'The voice service sign-in could not be used; check Settings → Voice.' : choice.message) }));
        return ws.close(1000);
      }
      // Answering a call from her: the first device wins; she starts by saying why she called.
      const ringId = url.searchParams.get('ring');
      let opening: string | undefined;
      if (ringId) {
        const ring = app.calls?.answer(ringId, deviceLabel(req.headers['user-agent']));
        if (!ring || ring.conversationId !== conv.id) {
          ws.send(JSON.stringify({ type: 'ended', reason: en('This call was already answered or has ended.') }));
          return ws.close(1000);
        }
        opening = openingNote(ring, app.settings.get().ownerName?.trim() || 'the owner');
      }
      ctx.liveCall?.end('A new call started on another device.');
      ctx.liveCall = new LiveCall(app, conv.id, ws, key, { engine: choice.engine, video: url.searchParams.get('video') === '1', onEnd: () => videos.drop(conv.id), ...(opts.liveConnect ? { connect: opts.liveConnect } : {}), ...(opening ? { opening } : {}) });
      ctx.liveCall.start();
    })().catch((err) => {
      console.error('live call failed:', err);
      socket.destroy();
    });
  };
}
