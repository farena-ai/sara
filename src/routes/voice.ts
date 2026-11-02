// Voice: voice settings and notes, calls (ringing), video frames, push notifications, live-call status.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../auth.ts';
import { callRules, type CallRules, cleanCallRules } from '../calls.ts';
import { type AppContext, resolveChain } from '../chat.ts';
import { type Expressive, EXPRESSIVE_SAMPLE, type VoiceTone } from '../expressive.ts';
import { isGroupChannel } from '../group.ts';
import { as400, cookies, HttpError, readJson, readRaw, safeDecode, SECURITY_HEADERS, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { OPENAI_LIVE_MODELS, OPENAI_LIVE_VOICES } from '../live.ts';
import { privateLocalOn } from '../net-guard.ts';
import { localVoiceInstallable, localVoiceMissing, localVoiceSupported } from '../platform.ts';
import { cancelInstall, engineAfterInstall, INSTALL_MB, installJob, startInstall } from '../voice-install.ts';
import type { Conversation as VideoConv } from '../store.ts';
import { cameraState, type CameraTarget, checkFrame, FRAME_MAX_BYTES, modelSees, parseVideoSettings, VideoError, videoSettings } from '../video.ts';
import { DEFAULT_VOICE, openaiSpeak, speechText, VOICE_VAULT, VoiceError, type VoiceSettings, xaiSpeak, xaiVoices } from '../voice.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createVoiceRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, ctxOf, demoCalls, grokSignedIn, me, opts, rootDir, speech, videos, visitorKey, xaiKey, xaiKeySync } = ctx;
  /** Phase 48: live calls: which voice service, how it's paid for, or why there's none. */
  const liveView = () => {
    const c = speech.liveChoice();
    return c.engine ? { available: true, engine: c.engine, how: c.how, billedTo: c.billedTo, setting: speech.settings().live ?? 'auto' } : { available: false, engine: null, how: null, message: c.message, setting: speech.settings().live ?? 'auto' };
  };
  const openaiLiveKeyInfo = () => {
    const k = speech.openaiRealtimeKey();
    return k ? { source: k.source, ...(k.provider ? { provider: k.provider } : {}) } : null;
  };
  const videoErr = (err: unknown): never => {
    if (err instanceof VideoError) throw new HttpError(err.status, err.message, err.params ? { params: err.params } : undefined);
    throw err;
  };
  /** Where this conversation's camera pictures would go: the live call's voice service, or the model that answers. */
  const cameraTarget = async (cx: AppContext, conv: VideoConv): Promise<CameraTarget> => {
    if (ctx.liveCall && !ctx.liveCall.ended && ctx.liveCall.conversationId === conv.id) return { kind: 'live', engine: ctx.liveCall.engine };
    const choice = speech.liveChoice();
    // A live call about to start (live calls chosen and set up; private ones never go to a live service).
    if ((speech.settings().calls ?? 'live') === 'live' && choice.engine && !conv.private && !privateLocalOn()) return { kind: 'live', engine: choice.engine };
    const s = cx.settings.get();
    const visionSet = Boolean(s.routes?.vision && s.providers.some((p) => p.id === s.routes!.vision!.providerId));
    try {
      const first = resolveChain(cx, conv, visionSet ? 'vision' : 'turn')[0];
      if (!first) return { kind: 'classic', error: 'Pick a model first (Settings → Models).' };
      return { kind: 'classic', provider: first.provider.config, model: first.model, sees: await modelSees(first.provider.config, first.model, Date.now()) };
    } catch (err) {
      return { kind: 'classic', error: (err as Error).message };
    }
  };
  const cameraFor = async (cx: AppContext, conv: VideoConv) =>
    cameraState({
      group: isGroupChannel(conv.channel),
      partner: Boolean(conv.partner),
      privateConv: Boolean(conv.private),
      privateLocal: privateLocalOn(),
      lastBlockAt: cx.store.lastSafetyEventAt('minor_sexual_block', conv.id)?.getTime(),
      now: app.now().getTime(),
      target: await cameraTarget(cx, conv),
    });
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a === 'push') {
      const push = app.push;
      if (!push) throw new HttpError(404, 'Push is not available');
      const view = () => ({
        publicKey: push.publicKey,
        preview: push.settings.preview,
        devices: push.list().map(({ endpoint, ...d }) => ({ ...d, id: endpoint.slice(-12) })),
        // iPhone app (Phase 17): whether a key is set (never the key itself) and the registered iPhones.
        apns: push.apns ? { keySet: Boolean(push.apns.key()), keyId: push.apns.key()?.keyId ?? null, bundleId: push.apns.key()?.bundleId ?? null, devices: push.apns.devices().map((d) => ({ id: d.token.slice(-12), label: d.label, sandbox: d.sandbox, createdAt: d.createdAt, lastOkAt: d.lastOkAt })) } : null,
      });
      if (!b && method === 'GET') return send(res, 200, await view());
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        if (body.preview !== undefined) app.settings.update({ push: { ...push.settings, preview: Boolean(body.preview) } });
        return send(res, 200, await view());
      }
      if (b === 'subscribe' && method === 'POST') {
        const body = await readJson(req);
        const sub = body.subscription as { endpoint: string; keys: { p256dh: string; auth: string } } | undefined;
        // The page's origin (browsers send it on POST) becomes the VAPID contact; Apple requires https.
        const origin = typeof req.headers.origin === 'string' && req.headers.origin !== 'null' ? req.headers.origin : `http://${req.headers.host}`;
        try {
          push.subscribe(sub ?? ({} as never), origin, typeof body.label === 'string' ? body.label : '', auth.sessionId(cookies(req)[SESSION_COOKIE]));
        } catch (err) {
          throw as400(err);
        }
        return send(res, 200, await view());
      }
      if (b === 'unsubscribe' && method === 'POST') {
        const body = await readJson(req);
        push.unsubscribe(String(body.endpoint ?? ''));
        return send(res, 200, await view());
      }
      if (b === 'apns' && push.apns) {
        const body = method === 'GET' ? {} : await readJson(req);
        if (method === 'PUT') {
          try {
            push.apns.setKey(body.p8 ? (body as never) : null);
          } catch (err) {
            throw as400(err);
          }
          return send(res, 200, await view());
        }
        if (method === 'POST' && c === 'register') {
          try {
            push.apns.register(String(body.token ?? ''), body.sandbox === true, typeof body.label === 'string' ? body.label : 'iPhone', auth.sessionId(cookies(req)[SESSION_COOKIE]), typeof body.profile === 'string' ? body.profile : undefined);
          } catch (err) {
            throw as400(err);
          }
          return send(res, 200, { ok: true });
        }
        if (method === 'POST' && c === 'unregister') {
          push.apns.unregister(String(body.token ?? ''));
          return send(res, 200, await view());
        }
        // Remove an iPhone from Settings (by the short id shown there).
        if (method === 'POST' && c === 'remove') {
          const d = push.apns.devices().find((x) => x.token.slice(-12) === String(body.id ?? ''));
          if (d) push.apns.unregister(d.token);
          return send(res, 200, await view());
        }
      }
      if (b === 'test' && method === 'POST') {
        const r = await push.sendAll({ title: app.persona.name, body: trOwner("It's me. Notifications work. 💛", app.settings.get()), url: '/', tag: 'test' });
        return send(res, 200, r);
      }
    }

    if (a === 'voice') {
      const cfg = (): VoiceSettings => {
        return speech.settings();
      };
      if (!b && method === 'GET') {
        return send(res, 200, {
          settings: cfg(),
          local: app.voice?.available ?? { stt: false, tts: false },
          localSupported: localVoiceSupported(),
          ...(localVoiceSupported() ? {} : { localNote: `${localVoiceMissing()}.` }),
          voices: app.voice?.voices() ?? [],
          notes: { hear: speech.canHearNotes(), send: speech.canSendNotes() },
          expressiveSample: EXPRESSIVE_SAMPLE,
          keys: { openai: Boolean(app.vault.get(VOICE_VAULT.openai)), elevenlabs: Boolean(app.vault.get(VOICE_VAULT.elevenlabs)), xai: Boolean(app.vault.get(VOICE_VAULT.xai)), xaiShared: !app.vault.get(VOICE_VAULT.xai) && Boolean(xaiKeySync()), grokSubscription: grokSignedIn(), openaiRealtime: openaiLiveKeyInfo() },
          // Phase 48: live calls with Grok or OpenAI.
          live: liveView(),
          openaiLive: { voices: OPENAI_LIVE_VOICES, models: OPENAI_LIVE_MODELS },
          // Phase 126 part C: her own hearing and voices on a Windows or Mac server (owner only).
          install: { installable: !opts.member && localVoiceInstallable() && !(app.voice?.available.stt && app.voice?.available.tts), mb: INSTALL_MB, job: installJob() },
        });
      }
      // Phase 126 part C (WAKE.md §7): Install hearing and voices on this computer (≈ 650 MB, checked before use).
      if (b === 'install' && method === 'POST') {
        if (opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
        if (c === 'cancel') {
          cancelInstall();
          return send(res, 200, { job: installJob() });
        }
        if (!localVoiceInstallable()) throw new HttpError(400, process.platform === 'linux' ? 'Use: sudo ./deploy/install-voice.sh' : 'Local voice can’t be installed on this computer.');
        if (privateLocalOn()) throw new HttpError(409, 'Nothing leaves this computer is on, so nothing is downloaded. Switch it off for the download (Settings → Privacy).');
        if (!app.voice) throw new HttpError(503, 'Voice isn’t ready yet.');
        const voiceEngine = app.voice;
        const j = startInstall(voiceEngine.dir, () => {
          voiceEngine.reload();
          const v = cfg();
          const patch = engineAfterInstall(v);
          if (Object.keys(patch).length) app.settings.update({ voice: { ...(app.settings.get().voice ?? {}), ...patch } as VoiceSettings });
        });
        return send(res, 202, { job: j });
      }
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        const cur = cfg();
        const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (v === undefined ? d : allowed.includes(v as T) ? (v as T) : (() => { throw new HttpError(400, 'Invalid value "{value}"', { params: { value: String(v) } }); })());
        const o = (body.openai ?? {}) as Record<string, unknown>;
        const e = (body.elevenlabs ?? {}) as Record<string, unknown>;
        const x = (body.xai ?? {}) as Record<string, unknown>;
        const r = (body.openaiRealtime ?? {}) as Record<string, unknown>;
        const str = (v: unknown, d: string, max = 200) => (v === undefined ? d : String(v).trim().slice(0, max));
        const next: VoiceSettings = {
          stt: pick(body.stt, ['off', 'local', 'openai'] as const, cur.stt),
          tts: pick(body.tts, ['off', 'local', 'openai', 'elevenlabs', 'xai'] as const, cur.tts),
          localVoice: body.localVoice === undefined ? cur.localVoice : String(body.localVoice),
          speed: body.speed === undefined ? cur.speed : Math.min(1.6, Math.max(0.6, Number(body.speed) || 1)),
          calls: pick(body.calls, ['live', 'classic'] as const, cur.calls ?? 'live'),
          live: pick(body.live, ['auto', 'grok', 'openai'] as const, cur.live ?? 'auto'),
          openaiRealtime: {
            voiceId: pick(r.voiceId, OPENAI_LIVE_VOICES, (cur.openaiRealtime?.voiceId ?? 'marin') as (typeof OPENAI_LIVE_VOICES)[number]),
            model: pick(r.model, OPENAI_LIVE_MODELS, (OPENAI_LIVE_MODELS as readonly string[]).includes(cur.openaiRealtime?.model ?? '') ? (cur.openaiRealtime!.model as (typeof OPENAI_LIVE_MODELS)[number]) : OPENAI_LIVE_MODELS[0]),
          },
          noteReplies: pick(body.noteReplies, ['voice', 'always', 'never'] as const, cur.noteReplies ?? 'voice'),
          expressive: pick(body.expressive, ['off', 'subtle', 'lively'] as const, cur.expressive ?? 'subtle'),
          tone: pick(body.tone, ['natural', 'warm', 'bright', 'calm'] as const, cur.tone ?? 'natural'),
          followMood: body.followMood === undefined ? cur.followMood !== false : Boolean(body.followMood),
          // Phase 69: how often she looks at your camera on video calls, and how many pictures per call.
          video: (() => {
            try {
              return parseVideoSettings(body.video, videoSettings(cur.video));
            } catch (err) {
              return videoErr(err);
            }
          })(),
          openai: { baseUrl: str(o.baseUrl, cur.openai.baseUrl, 300), sttModel: str(o.sttModel, cur.openai.sttModel), ttsModel: str(o.ttsModel, cur.openai.ttsModel), ttsVoice: str(o.ttsVoice, cur.openai.ttsVoice) },
          elevenlabs: { voiceId: str(e.voiceId, cur.elevenlabs.voiceId), model: str(e.model, cur.elevenlabs.model) },
          xai: { voiceId: str(x.voiceId, cur.xai.voiceId, 100) || 'eve', language: str(x.language, cur.xai.language, 20) || 'en' },
        };
        if (!/^https?:\/\//.test(next.openai.baseUrl)) throw new HttpError(400, 'Speech API URL must start with http(s)://');
        if (typeof body.openaiKey === 'string') body.openaiKey ? app.vault.set(VOICE_VAULT.openai, body.openaiKey.trim()) : app.vault.delete(VOICE_VAULT.openai);
        if (typeof body.elevenlabsKey === 'string') body.elevenlabsKey ? app.vault.set(VOICE_VAULT.elevenlabs, body.elevenlabsKey.trim()) : app.vault.delete(VOICE_VAULT.elevenlabs);
        if (typeof body.xaiKey === 'string') body.xaiKey ? app.vault.set(VOICE_VAULT.xai, body.xaiKey.trim()) : app.vault.delete(VOICE_VAULT.xai);
        app.settings.update({ voice: next });
        return send(res, 200, next);
      }
      if (b === 'xai-sample' && method === 'GET') {
        // A short sample in one Grok voice, to choose by ear. Nothing is saved to the settings;
        // each sample is kept on the server, so listening again costs nothing.
        const u = new URL(req.url ?? '/', 'http://x');
        const voiceId = u.searchParams.get('voice') ?? '';
        const lang = u.searchParams.get('lang') || 'en';
        if (!/^[\w-]{1,64}$/.test(voiceId) || !/^[\w-]{1,10}$/.test(lang)) throw new HttpError(400, 'Unknown voice');
        const name = app.persona.name;
        const text = lang === 'en' || lang === 'auto' ? `Hi, it's ${name}. This is how I'd sound if you pick this voice.` : `${name}.`;
        const dir = join(rootDir, 'cache', 'voice-samples');
        const file = join(dir, `${voiceId}-${lang}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.mp3`);
        let data: Buffer;
        if (existsSync(file)) data = readFileSync(file);
        else {
          const key = await xaiKey().catch(() => undefined);
          if (!key) throw new HttpError(400, 'Sign in to Grok first (Models → Subscriptions), or add an xAI key.');
          try {
            data = (await xaiSpeak({ voiceId, language: lang === 'auto' ? 'en' : lang }, key, text, 1)).data;
          } catch (err) {
            throw as400(err);
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, data);
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': data.length, 'cache-control': 'private, max-age=86400', ...SECURITY_HEADERS });
        return void res.end(data);
      }
      if (b === 'openai-sample' && method === 'GET') {
        // Phase 48: a short sample of an OpenAI live-call voice, made with OpenAI's text-to-speech
        // (gpt-4o-mini-tts has the same voices as the Realtime API), on the key live calls use.
        const voiceId = new URL(req.url ?? '/', 'http://x').searchParams.get('voice') ?? '';
        if (!(OPENAI_LIVE_VOICES as readonly string[]).includes(voiceId)) throw new HttpError(400, 'Unknown voice');
        const text = `Hi, it's ${app.persona.name}. This is how I'd sound on a call if you pick this voice.`;
        const dir = join(rootDir, 'cache', 'voice-samples');
        const file = join(dir, `openai-${voiceId}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.mp3`);
        let data: Buffer;
        if (existsSync(file)) data = readFileSync(file);
        else {
          const k = speech.openaiRealtimeKey();
          if (!k) throw new HttpError(400, 'Add an OpenAI API key first (the speech API key below, or an OpenAI model provider).');
          try {
            data = (await openaiSpeak({ ...DEFAULT_VOICE.openai, baseUrl: 'https://api.openai.com/v1', ttsModel: 'gpt-4o-mini-tts', ttsVoice: voiceId }, k.key, text, 1)).data;
          } catch (err) {
            throw as400(err);
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, data);
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': data.length, 'cache-control': 'private, max-age=86400', ...SECURITY_HEADERS });
        return void res.end(data);
      }
      if (b === 'xai-voices' && method === 'GET') {
        const key = await xaiKey().catch(() => undefined);
        if (!key) return send(res, 200, { voices: [] });
        return send(res, 200, { voices: await xaiVoices(key).catch(() => []) });
      }
      if (b === 'transcribe' && method === 'POST') {
        const audio = await readRaw(req, 15 * 1024 * 1024);
        try {
          const text = await speech.transcribe(audio);
          return send(res, 200, { text });
        } catch (err) {
          if (err instanceof VoiceError) throw new HttpError(400, err.message);
          throw err;
        }
      }
      if (b === 'speak' && method === 'POST') {
        const body = await readJson(req);
        // Phase 37: the raw text goes in (her *sighs* and "haha" become Grok voice's speech tags).
        const raw = String(body.text ?? '').slice(0, 2400);
        if (!speechText(raw)) throw new HttpError(400, 'Nothing to say');
        const level = ['off', 'subtle', 'lively'].includes(String(body.expressive)) ? (String(body.expressive) as Expressive) : undefined;
        const tone = ['natural', 'warm', 'bright', 'calm'].includes(String(body.tone)) ? (String(body.tone) as VoiceTone) : undefined;
        try {
          const audio = await speech.speak(raw, body.voice ? String(body.voice) : undefined, { expressive: level, tone });
          res.writeHead(200, { 'content-type': audio.type, 'content-length': audio.data.length, 'cache-control': 'no-store', ...SECURITY_HEADERS });
          return void res.end(audio.data);
        } catch (err) {
          if (err instanceof VoiceError) throw new HttpError(400, err.message);
          throw err;
        }
      }
    }

    // Phase 26: calls from her (Settings → Voice → Calls from her).
    if (a === 'calls' && app.calls) {
      const calls = app.calls;
      if (!b && method === 'GET') return send(res, 200, { rules: callRules(app), ring: calls.current ?? null });
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        let next: CallRules;
        try {
          next = cleanCallRules(body, callRules(app));
        } catch (err) {
          throw as400(err);
        }
        app.settings.update({ calls: next });
        return send(res, 200, { rules: next, ring: calls.current ?? null });
      }
      if (b === 'test' && method === 'POST') {
        // "Call me now" to try it: rings every signed-in app, rules aside (it's the owner asking).
        const body = await readJson(req);
        let conv = typeof body.conversationId === 'string' ? app.store.getConversation(body.conversationId) : undefined;
        conv ??= app.store.listConversations()[0] ?? app.store.createConversation({ title: 'Calls' });
        if (conv.partner) throw new HttpError(400, 'Not in a partner chat.');
        const out = calls.ring({ kind: 'test', reason: me('This is a test call from Sara, to check that calls reach you'), conversationId: conv.id });
        if ('skipped' in out) throw new HttpError(409, out.skipped);
        return send(res, 200, { ring: out.ring });
      }
      if (b && (c === 'decline' || c === 'cancel') && method === 'POST') {
        const ok = c === 'decline' ? calls.decline(safeDecode(b)) : calls.cancel(safeDecode(b));
        if (!ok) throw new HttpError(404, 'That call is no longer ringing.');
        return send(res, 200, { ok: true });
      }
    }

    // Phase 69: video calls: GET /api/video/<conversation> (can her camera pictures reach her?),
    // POST …/start and …/end (one video call's limits), POST …/frame (one JPEG; ?ask=1 = "Look at this").
    if (a === 'video' && b) {
      // The picture is read first (bounded), so a refusal never leaves an unread body on the socket.
      const raw = c === 'frame' && method === 'POST' ? await readRaw(req, FRAME_MAX_BYTES + 1) : undefined;
      const cx = ctxOf(b);
      const conv = cx.store.getConversation(b);
      if (!conv) throw new HttpError(404, 'Conversation not found');
      const now = app.now().getTime();
      const view = async () => {
        const sess = videos.get(conv.id, now);
        return { camera: await cameraFor(cx, conv), settings: videoSettings(speech.settings().video), session: sess ? { used: sess.gate.used, perCall: sess.gate.settings.perCall, lookEvery: sess.gate.settings.lookEvery } : null };
      };
      if (!c && method === 'GET') return send(res, 200, await view());
      if (c === 'start' && method === 'POST') {
        await readJson(req).catch(() => ({}));
        if (isGroupChannel(conv.channel)) throw new HttpError(400, 'Video calls aren’t available in group chats.');
        if (conv.partner) throw new HttpError(404, 'Conversation not found');
        videos.start(conv.id, videoSettings(speech.settings().video), now);
        return send(res, 200, await view());
      }
      if (c === 'end' && method === 'POST') {
        await readJson(req).catch(() => ({}));
        return send(res, 200, { ended: videos.end(conv.id) });
      }
      if (c === 'frame' && method === 'POST') {
        const st = await cameraFor(cx, conv);
        if (!st.allowed) throw new HttpError(403, st.message ?? 'The camera can’t be used here.', st.params ? { params: st.params } : undefined);
        const sess = videos.get(conv.id, now);
        if (!sess) throw new HttpError(409, 'Start the video call first.');
        try {
          checkFrame(raw!);
        } catch (err) {
          videoErr(err);
        }
        const ask = new URL(req.url ?? '/', 'http://x').searchParams.get('ask') === '1';
        let count: { used: number; left: number } = { used: 0, left: 0 };
        try {
          count = sess.gate.take(now, ask);
        } catch (err) {
          videoErr(err);
        }
        sess.lastAt = now;
        if (ctx.liveCall && !ctx.liveCall.ended && ctx.liveCall.conversationId === conv.id) {
          if (!ctx.liveCall.frame(raw!, ask)) throw new HttpError(409, 'She can’t see pictures on this call.');
          return send(res, 200, { ok: true, via: 'live', ...count });
        }
        // Classic calls: kept in memory for the next thing you say (or "Look at this"), then dropped.
        videos.keep(conv.id, raw!, now, ask);
        return send(res, 200, { ok: true, via: 'next-reply', ...count });
      }
      throw new HttpError(404, 'Not found');
    }

    if (a === 'live' && !b && method === 'GET') {
      // Live voice calls: available when the voice service chosen in Settings → Voice is usable
      // (Grok realtime voice or OpenAI Realtime); says which one and who pays for it.
      if (opts.demo) {
        // Demo: calls only with the reviewer code (calls are off when none is set).
        const d = demoCalls.view(visitorKey(req));
        const v = liveView();
        if (!d.enabled) return send(res, 200, { available: false, engine: null, how: null, message: 'Live calls are off in the demo.', demo: d, inCall: false });
        return send(res, 200, { available: v.available, engine: v.engine, how: v.how, ...(v.available ? { billedTo: 'the demo server' } : { message: 'Live calls are not available on the demo right now.' }), demo: d, inCall: false });
      }
      return send(res, 200, { ...liveView(), inCall: Boolean(ctx.liveCall && !ctx.liveCall.ended) });
    }
    return NEXT;
  };
}
