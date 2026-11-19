// R5 (docs/PHONE_CALLS.md): Phone calls settings (owner only), Discord voice, car mode's spoken
// approvals, and the provider's public webhooks and media stream.
//   GET    /api/phone-calls                      {settings, status, estimate, calls, urls, discord}
//   PUT    /api/phone-calls                      settings → {settings, status}
//   PUT    /api/phone-calls/credentials          {sid, token} (to the vault; never sent back)
//   DELETE /api/phone-calls/credentials
//   POST   /api/phone-calls/test                 a test call to the owner's own number (only when ready)
//   POST   /api/phone-calls/calls/:id/hangup
//   PUT    /api/phone-calls/discord              {guildId, channelId, on}
//   POST   /api/phone-calls/discord/join         409 with what's missing (no voice transport yet)
//   POST   /api/car/answer                       {conversationId, approved} (car mode: "approve" said aloud)
// Public, no sign-in (the provider's signature is the key; 404 unless credentials are saved):
//   POST   /tel/twilio/voice · /tel/twilio/status · WebSocket /tel/twilio/stream
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { DISCORD_VAULT, discordSettings } from '../bridges/discord.ts';
import { voiceAnswer } from '../car-errands.ts';
import type { AppContext } from '../chat.ts';
import { discordVoiceStatus, saveDiscordVoice, DISCORD_VOICE_LINES } from '../discord-voice.ts';
import { HttpError, readJson, readRaw, send } from '../http.ts';
import { en, trOwner } from '../i18n.ts';
import { PhoneCallError, phoneCallsFor } from '../phone-calls.ts';
import { cleanTalk } from '../talk.ts';
import { interpreterRoute } from './interpreter.ts';
import { acceptWebSocket, refuseUpgrade } from '../ws.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createPhoneCallRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof PhoneCallError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  const discordBridge = () => Boolean(app.vault.get(DISCORD_VAULT)) && discordSettings(app).enabled;
  const view = () => {
    const calls = phoneCallsFor(app);
    const st = calls.status();
    const s = calls.settings();
    const dv = discordVoiceStatus(app, { bridge: discordBridge() });
    return {
      settings: s,
      status: { ...st, missing: st.missing.map(T) },
      estimate: calls.estimate().line,
      calls: calls.list(20).map((c) => ({ id: c.id, direction: c.direction, number: c.number, name: c.name, mode: c.mode, status: c.status, summary: c.summary, seconds: c.seconds, createdAt: c.createdAt })),
      urls: s.publicUrl ? { voice: `${s.publicUrl}/tel/twilio/voice`, status: `${s.publicUrl}/tel/twilio/status` } : null,
      discord: { ...dv, missing: dv.missing.map(T) },
    };
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    // V4.2: the live interpreter (src/routes/interpreter.ts).
    if (a === 'talk' && b === 'interpret') return interpreterRoute(ctx, req, res, method, parts);
    // U4.24: Talk with Sara answers a card by voice the same way, if the person allows it.
    if (a === 'car' || a === 'talk') {
      if (b !== 'answer' || method !== 'POST') throw new HttpError(404, 'Not found');
      const body = await readJson(req);
      if (a === 'talk') {
        if (ctx.opts.member && ctx.opts.member.record()?.limits?.voice === false) throw new HttpError(403, T(en('Voice is off for you on this Sara.')));
        if (!cleanTalk(app.settings.get().voice?.talk).approveByVoice) {
          const line = T(en('Tap Approve or Decline on the card.'));
          return send(res, 409, { ok: false, line, error: line });
        }
      }
      const conv = String(body.conversationId ?? '');
      if (!conv || !app.store.getConversation(conv)) throw new HttpError(404, T(en('Nothing is waiting for your OK.')));
      const r = voiceAnswer(app, ctx.active, conv, body.approved === true);
      return send(res, r.ok ? 200 : r.pcOnly || r.tapOnly ? 403 : 409, { ...r, line: T(r.line), ...(r.ok ? {} : { error: T(r.line) }) });
    }
    if (a !== 'phone-calls') return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const calls = phoneCallsFor(app);
    if (!b && method === 'GET') return send(res, 200, view());
    if (!b && method === 'PUT') {
      const body = await readJson(req);
      await wrap(() => calls.save(body));
      return send(res, 200, view());
    }
    if (b === 'credentials' && !c && method === 'PUT') {
      const body = await readJson(req);
      await wrap(() => calls.setCreds(String(body.sid ?? ''), String(body.token ?? '')));
      return send(res, 200, view());
    }
    if (b === 'credentials' && !c && method === 'DELETE') {
      calls.clearCreds();
      return send(res, 200, view());
    }
    if (b === 'test' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const s = calls.settings();
      if (!s.ownerNumber) throw new HttpError(409, T(en('Add your own number first.')));
      const call = await wrap(() => calls.place({ to: s.ownerNumber, name: app.settings.get().ownerName?.trim() || '', script: T(en('This is a test call from Sara. Say stop to hang up.')) }));
      return send(res, 200, { call: { id: call.id, number: call.number, status: call.status } });
    }
    if (b === 'calls' && c && d === 'hangup' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const id = Number(c);
      if (!Number.isInteger(id)) throw new HttpError(404, T(en('Call not found.')));
      await wrap(() => calls.hangup(id));
      return send(res, 200, { ok: true });
    }
    if (b === 'discord' && !c && method === 'PUT') {
      const body = await readJson(req);
      saveDiscordVoice(app, body);
      return send(res, 200, view());
    }
    if (b === 'discord' && c === 'join' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const st = discordVoiceStatus(app, { bridge: discordBridge() });
      if (!st.canJoin) throw new HttpError(409, (st.missing.length ? st.missing : [DISCORD_VOICE_LINES.noTransport]).map(T).join(' '));
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}

/** The provider's webhooks (POST /tel/twilio/voice and /status): no cookie, no session; the signature is checked. */
export async function phoneWebhook(app: AppContext, req: IncomingMessage, res: ServerResponse, pathname: string, search: string): Promise<void> {
  const kind = pathname === '/tel/twilio/voice' ? 'voice' : pathname === '/tel/twilio/status' ? 'status' : null;
  const raw = await readRaw(req, 64 * 1024).catch(() => Buffer.alloc(0));
  if (!kind || req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  const base = phoneCallsFor(app).settings().publicUrl;
  const sig = req.headers['x-twilio-signature'];
  const r = phoneCallsFor(app).webhook(kind, `${base}${pathname}${search}`, params, typeof sig === 'string' ? sig : undefined);
  res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' });
  res.end(r.body);
}

/** WebSocket /tel/twilio/stream: the provider's Media Stream; the call is named by its one-time token. */
export function phoneUpgrade(app: AppContext, req: IncomingMessage, socket: Duplex, head: Buffer, closed = false): void {
  const calls = phoneCallsFor(app);
  if (closed || !calls.ready()) return refuseUpgrade(socket, 404, 'Not Found');
  const ws = acceptWebSocket(req, socket, head);
  if (ws) calls.attach(ws);
}
