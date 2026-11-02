// Phase 126 (2.59.0, docs/design/WAKE.md §5, §11): Hey Sara, the server side. The devices (the Windows
// app, the Android app) listen on their own; this answers them: the phrases and keyword lines, the
// device records (on/off only from the device itself; off from anywhere), the claim (one device
// answers), and POST /api/wake/turn: hear → an ordinary turn in her "Hey Sara" conversation → the
// pieces to say, in the safety layer's order (the AI notice first, crisis resources in full, the
// reply). No audio is kept anywhere: the WAV is transcribed from memory and dropped.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../auth.ts';
import type { ChatEvent } from '../chat.ts';
import { isGroupChannel } from '../group.ts';
import { cookies, HttpError, readJson, readRaw, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { CRISIS_RESOURCES, MINOR_BLOCK_REPLY } from '../safety.ts';
import { usageScope } from '../usage.ts';
import { isWav, speechText } from '../voice.ts';
import { downloadPinned, runTar, systemTar } from '../voice-install.ts';
import {
  checkPhrase,
  cleanPlatform,
  cleanSensitivity,
  freeLabel,
  isStopWord,
  type Lexicon,
  nameOf,
  parseLexicon,
  phraseLines,
  POLL_SECONDS,
  saidNothing,
  type Sensitivity,
  spokenReply,
  stopLines,
  TALKS_IN,
  TURN_MAX_BYTES,
  TURN_MAX_SECONDS,
  type WakeDevice,
  type WakePhrase,
  type WakeSettings,
  WakeStore,
  wakeView,
  wavSeconds,
  withSensitivity,
} from '../wake.ts';
import { LEXICON, packFor, PACK_LICENCE, WAKE_PACK_VERSION } from '../wake-pack.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** The server-wide lexicon folder (set by src/main.ts to <data>/voice/wake-lexicon; one copy for every space). */
let lexiconDir: string | undefined;
export const setWakeLexiconDir = (dir: string | undefined): void => {
  lexiconDir = dir;
};
let lexCache: { file: string; mtime: number; lex: Lexicon } | undefined;
let lexJob: { state: 'downloading' | 'failed'; error?: string } | undefined;

export const IPHONE_NOTE = 'On iPhone, say “Hey Siri, ask Sara”: Apple doesn’t let apps listen for their own name.';
export const BROWSER_NOTE = 'In a browser, use the 🎙 button: a web page can’t listen when it’s closed.';
const MEMBERS_OFF = 'Hey Sara is off for members on this server. Ask the owner.';
const NOT_READY = 'Hey Sara needs her hearing and her voice: Settings → Voice.';
const PRIVATE_HEARING = 'Hey Sara is paused while Nothing leaves this computer is on, because her hearing uses the internet. Install hearing on this computer (Settings → Voice) to keep it.';

export function createWakeRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, opts, speech, ctxOf } = ctx;
  const root = app.rootDir ?? app.dataDir;
  const store = new WakeStore(root, () => app.now());
  const me = app.companionId ?? 'main';
  const alive = (id: string) => auth.devices().some((d) => d.id === id);
  const sidOf = (req: Parameters<RouteHandler>[0]) => auth.sessionId(cookies(req)[SESSION_COOKIE]);
  const companions = (): { id: string; name: string }[] => (opts.companions ? opts.companions.all().map((c) => ({ id: c.id, name: c.app.persona.name })) : [{ id: me, name: app.persona.name }]);
  const lexFile = () => join(lexiconDir ?? join(root, 'voice', 'wake-lexicon'), LEXICON.name);

  /** The lexicon, checked against its SHA-256 once per change of the file. */
  const lexicon = (): Lexicon | undefined => {
    const file = lexFile();
    if (!existsSync(file)) return undefined;
    const mtime = statSync(file).mtimeMs;
    if (lexCache?.file === file && lexCache.mtime === mtime) return lexCache.lex;
    const buf = readFileSync(file);
    if (createHash('sha256').update(buf).digest('hex') !== LEXICON.sha256) return undefined;
    lexCache = { file, mtime, lex: parseLexicon(buf.toString('utf8')) };
    return lexCache.lex;
  };

  const server = () => {
    const w = app.settings.get().wakeServer ?? {};
    return { allowed: w.allowed !== false, members: w.members !== false };
  };
  /** §19 Q12: "Hey {her name}" when the lexicon knows it (or she is Sara), else "Hey Sara". */
  const fallback = (): WakePhrase[] => {
    const name = app.persona.name?.trim() || 'Sara';
    const text = `Hey ${name}`;
    const ok = phraseLines(text, lexicon()).ok;
    return [{ text: ok ? text : 'Hey Sara', companionId: me, label: 'W1' }];
  };
  const view = () => {
    const v = wakeView(app.settings.get().wake, fallback);
    // A deleted companion's phrases go with her (§12 #7).
    const known = new Set(companions().map((c) => c.id));
    return { ...v, phrases: v.phrases.filter((p) => known.has(p.companionId)) };
  };
  const loopback = (u: string) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(u);
  /** Her hearing and her voice are set up at all; and (for private local mode) both on this computer. */
  const voiceState = () => {
    const v = speech.settings();
    const local = app.voice?.available ?? { stt: false, tts: false };
    const hearsHere = (v.stt === 'local' && local.stt) || (v.stt === 'openai' && loopback(v.openai.baseUrl));
    const saysHere = (v.tts === 'local' && local.tts) || (v.tts === 'openai' && loopback(v.openai.baseUrl));
    return { ready: v.stt !== 'off' && v.tts !== 'off', here: Boolean(hearsHere && saysHere) };
  };
  /** Why every device of this person is paused (server-side reasons), or undefined. */
  const serverPause = (): string | undefined => {
    const srv = server();
    if (!srv.allowed) return 'server-off';
    if (opts.member && !srv.members) return 'members-off';
    if (!app.settings.get().disclosureAcceptedAt) return 'disclosure';
    const vs = voiceState();
    if (privateLocalOn() && !vs.here) return 'private-hearing';
    if (!vs.ready) return 'no-voice';
    return undefined;
  };
  const withSens = (line: string, s: Sensitivity) => withSensitivity(line, s);
  /** The phrases with their keyword lines (cached in wake.json; made again when a phrase changes). */
  const phrasesWithLines = (s: Sensitivity) => {
    const lex = lexicon();
    const names = new Map(companions().map((c) => [c.id, c.name]));
    const f = store.read();
    let changed = false;
    const out: { label: string; companionId: string; companion: string; text: string; name: string; lines: string[] }[] = [];
    for (const p of view().phrases) {
      let cached = f.phrases[p.label];
      if (!cached || cached.text !== p.text || cached.companionId !== p.companionId) {
        const r = phraseLines(p.text, lex, { label: p.label });
        if (!r.ok) continue;
        cached = f.phrases[p.label] = { text: p.text, companionId: p.companionId, lines: r.lines, madeAt: app.now().toISOString() };
        changed = true;
      }
      out.push({ label: p.label, companionId: p.companionId, companion: names.get(p.companionId) ?? '', text: p.text, name: nameOf(p.text), lines: cached.lines.map((l) => withSens(l, s)) });
    }
    for (const k of Object.keys(f.phrases)) if (!out.some((o) => o.label === k)) {
      delete f.phrases[k];
      changed = true;
    }
    if (changed) store.write(f);
    return out;
  };
  const deviceView = (id: string, d: WakeDevice, mine?: string) => ({ id, label: d.label, platform: d.platform, on: d.on, paused: d.paused ?? null, offBy: d.offBy ?? null, pack: d.pack ?? null, sensitivity: d.sensitivity, personal: d.personal, chime: d.chime, lastWake: d.lastWake ?? null, lastSeen: d.lastSeen, today: store.today(d), me: id === mine });
  const publish = (device: string, state: 'on' | 'off' | 'paused', reason?: string) => app.events?.publish({ type: 'wake', device, state, ...(reason ? { reason } : {}) });
  const labelOf = (id: string) => store.read().devices[id]?.label || auth.devices().find((d) => d.id === id)?.label || 'another device';

  const config = (sid: string, url: URL) => {
    const f = store.read(alive);
    const d = f.devices[sid];
    const s = cleanSensitivity(d?.sensitivity ?? view().sensitivity);
    const paused = serverPause();
    const platform = cleanPlatform(url.searchParams.get('platform') ?? d?.platform);
    const phrases = phrasesWithLines(s);
    const pack = packFor(platform, url.searchParams.get('arch') ?? 'x64');
    return {
      on: Boolean(d?.on) && paused !== 'server-off' && paused !== 'members-off',
      ...(paused ? { paused } : d?.paused ? { paused: d.paused } : {}),
      phrases: phrases.map(({ label, companionId, name, lines }) => ({ label, companionId, name, lines })),
      stop: stopLines(phrases.map((p) => p.name), lexicon(), s),
      sensitivity: s,
      personal: d ? d.personal : platform === 'android',
      chime: d ? d.chime : true,
      starts: view().starts,
      talksIn: view().talksIn,
      followUpSeconds: view().followUpSeconds,
      pack: pack ? { version: WAKE_PACK_VERSION, ...pack, licence: PACK_LICENCE } : null,
      privateLocal: privateLocalOn(),
      pollSeconds: POLL_SECONDS,
      ...(d?.offBy ? { offBy: d.offBy } : {}),
    };
  };

  return async (req, res, method, parts) => {
    const [a, b, c, dPart] = parts;
    if (a !== 'wake') return NEXT;
    if (opts.demo) throw new HttpError(404, 'Not found');
    const sid = sidOf(req);
    const url = new URL(req.url ?? '/', 'http://x');

    // ---- the person's view (Settings → Her → Hey Sara) ----
    if (!b && method === 'GET') {
      const f = store.read(alive);
      const lex = lexicon();
      return send(res, 200, {
        settings: view(),
        ...(opts.member ? {} : { server: server() }),
        devices: Object.entries(f.devices).map(([id, d]) => deviceView(id, d, sid)),
        thisDevice: sid ?? null,
        companions: companions(),
        lexicon: { installed: Boolean(lex), state: lexJob?.state ?? null, error: lexJob?.error ?? null, mb: 3.3 },
        paused: serverPause() ?? null,
        privateLocal: privateLocalOn(),
        member: Boolean(opts.member),
        iphoneNote: IPHONE_NOTE,
        browserNote: BROWSER_NOTE,
        talksInChoices: TALKS_IN,
        liveCalls: Boolean(speech.liveChoice().engine),
      });
    }
    if (!b && method === 'PUT') {
      const body = (await readJson(req)) as WakeSettings & Record<string, unknown>;
      const cur = view();
      const next: WakeSettings = { ...(app.settings.get().wake ?? {}) };
      if (body.talksIn !== undefined) next.talksIn = TALKS_IN.includes(body.talksIn) ? body.talksIn : cur.talksIn;
      if (body.starts !== undefined) next.starts = body.starts === 'call' ? 'call' : 'question';
      if (body.followUpSeconds !== undefined) next.followUpSeconds = body.followUpSeconds === 5 || body.followUpSeconds === 8 ? body.followUpSeconds : 0;
      if (body.sensitivity !== undefined) next.sensitivity = cleanSensitivity(body.sensitivity);
      if (Array.isArray(body.phrases)) {
        if (body.phrases.length > 4) throw new HttpError(400, 'Up to 4 phrases. Remove one first.', { errors: [{ index: 4, why: 'Up to 4 phrases. Remove one first.' }] });
        const known = new Set(companions().map((x) => x.id));
        const out: WakePhrase[] = [];
        const errors: { index: number; why: string; word?: string }[] = [];
        for (const [i, raw] of body.phrases.entries()) {
          const p = raw as Partial<WakePhrase>;
          const text = String(p?.text ?? '').trim().slice(0, 64);
          const companionId = String(p?.companionId ?? me);
          if (!known.has(companionId)) {
            errors.push({ index: i, why: 'That companion isn’t one of yours.' });
            continue;
          }
          const r = checkPhrase(text, { lexicon: lexicon(), others: out.map((o) => o.text) });
          if (!r.ok) {
            errors.push({ index: i, why: r.why, ...(r.word ? { word: r.word } : {}) });
            continue;
          }
          const label = typeof p?.label === 'string' && /^W[1-4]$/.test(p.label) && !out.some((o) => o.label === p.label) ? p.label : freeLabel(out)!;
          out.push({ text, companionId, label });
        }
        if (errors.length) throw new HttpError(400, errors[0].why, { errors });
        next.phrases = out;
      }
      app.settings.update({ wake: next });
      phrasesWithLines(view().sensitivity);
      return send(res, 200, { settings: view() });
    }
    if (b === 'phrase-check' && method === 'POST') {
      const body = await readJson(req);
      const others = view().phrases.filter((p) => p.label !== body.label).map((p) => p.text);
      const r = checkPhrase(String(body.text ?? ''), { lexicon: lexicon(), others, count: body.label ? 0 : view().phrases.length });
      return send(res, 200, r);
    }
    if (b === 'server' && method === 'PUT') {
      if (opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      const body = await readJson(req);
      const cur = server();
      const next = { allowed: body.allowed === undefined ? cur.allowed : body.allowed === true, members: body.members === undefined ? cur.members : body.members === true };
      app.settings.update({ wakeServer: next });
      if (!next.allowed) for (const id of Object.keys(store.read().devices)) publish(id, 'off', 'server-off');
      return send(res, 200, { server: server() });
    }
    if (b === 'lexicon' && method === 'POST') {
      if (opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      if (privateLocalOn()) throw new HttpError(409, 'Nothing leaves this computer is on, so nothing is downloaded. Switch it off for the download (Settings → Privacy).');
      if (lexicon()) return send(res, 200, { installed: true });
      if (lexJob?.state !== 'downloading') {
        lexJob = { state: 'downloading' };
        void fetchLexicon(lexFile()).then(
          () => {
            lexJob = undefined;
          },
          (err: Error) => {
            lexJob = { state: 'failed', error: err.message };
          },
        );
      }
      return send(res, 202, { installed: false, state: 'downloading' });
    }

    // ---- the device ----
    if (b === 'config' && method === 'GET') {
      if (!sid) throw new HttpError(401, 'Sign in first.');
      return send(res, 200, config(sid, url));
    }
    if (b === 'device' && !c && method === 'PUT') {
      if (!sid) throw new HttpError(403, 'Hey Sara needs the app’s own sign-in on this device.');
      const body = await readJson(req);
      const target = typeof body.device === 'string' && body.device ? body.device : sid;
      if (body.on === true && target !== sid) throw new HttpError(403, 'Only that device can turn Hey Sara on.');
      if (body.on === true) {
        const p = serverPause();
        if (p === 'server-off') throw new HttpError(403, 'Hey Sara is off on this server. Ask the owner.');
        if (p === 'members-off') throw new HttpError(403, MEMBERS_OFF);
        if (p === 'disclosure') throw new HttpError(403, 'Read and accept the AI notice in Sara first.');
        if (p === 'no-voice') throw new HttpError(409, NOT_READY);
      }
      const known = auth.devices().find((x) => x.id === target);
      if (!known) throw new HttpError(404, 'No such device.');
      const f = store.update((f) => {
        const old = f.devices[target];
        const platform = cleanPlatform(body.platform ?? old?.platform);
        const d: WakeDevice = old ?? { platform, label: known.label, on: false, sensitivity: view().sensitivity, personal: platform === 'android', chime: true, lastSeen: app.now().toISOString(), days: {} };
        if (target === sid) {
          d.platform = platform;
          if (typeof body.label === 'string' && body.label.trim()) d.label = body.label.trim().slice(0, 60);
          if (typeof body.pack === 'string') d.pack = body.pack.slice(0, 40);
          if (body.paused === null || body.paused === '') delete d.paused;
          else if (typeof body.paused === 'string') d.paused = body.paused.slice(0, 40);
          d.lastSeen = app.now().toISOString();
        }
        if (body.sensitivity !== undefined) d.sensitivity = cleanSensitivity(body.sensitivity);
        if (typeof body.personal === 'boolean') d.personal = body.personal;
        if (typeof body.chime === 'boolean') d.chime = body.chime;
        if (typeof body.on === 'boolean') {
          d.on = body.on;
          if (body.on) delete d.offBy;
          else if (target !== sid) d.offBy = 'remote';
        }
        f.devices[target] = d;
        if (body.counters && typeof body.counters === 'object' && target === sid) store.count(f, target, body.counters as never);
      }, alive);
      if (typeof body.on === 'boolean') publish(target, body.on ? 'on' : 'off', target !== sid ? 'remote' : undefined);
      else if (typeof body.paused === 'string' && body.paused) publish(target, 'paused', body.paused);
      return send(res, 200, deviceView(target, f.devices[target], sid));
    }
    if (b === 'device' && c && dPart === 'off' && method === 'POST') {
      const f = store.update((f) => {
        const d = f.devices[c];
        if (!d) throw new HttpError(404, 'No such device.');
        d.on = false;
        d.offBy = 'remote';
      }, alive);
      publish(c, 'off', 'remote');
      return send(res, 200, deviceView(c, f.devices[c], sid));
    }
    if (b === 'device' && c && !dPart && method === 'DELETE') {
      store.update((f) => {
        delete f.devices[c];
      }, alive);
      publish(c, 'off', 'removed');
      return send(res, 200, { ok: true });
    }
    if (b === 'off' && !c && method === 'POST') {
      // Turn off everywhere: every device of this person (the owner's server-wide off is /api/wake/server).
      const f = store.update((f) => {
        for (const d of Object.values(f.devices)) if (d.on) {
          d.on = false;
          d.offBy = 'everywhere';
        }
      }, alive);
      for (const id of Object.keys(f.devices)) publish(id, 'off', 'everywhere');
      return send(res, 200, { devices: Object.entries(f.devices).map(([id, d]) => deviceView(id, d, sid)) });
    }
    if (b === 'claim' && method === 'POST') {
      if (!sid) throw new HttpError(401, 'Sign in first.');
      const body = await readJson(req);
      const p = serverPause();
      if (p === 'server-off') throw new HttpError(403, 'Hey Sara is off on this server. Ask the owner.');
      if (p === 'members-off') throw new HttpError(403, MEMBERS_OFF);
      if (p) throw new HttpError(409, p === 'private-hearing' ? PRIVATE_HEARING : p === 'disclosure' ? 'Read and accept the AI notice in Sara first.' : NOT_READY, { paused: p });
      const label = String(body.label ?? '');
      // Push-to-talk ("TALK") needs no phrase; a phrase label must be one the server knows.
      if (label !== 'TALK' && !view().phrases.some((x) => x.label === label)) throw new HttpError(409, 'Hey Sara’s words changed: reload them.', { config: config(sid, url) });
      const r = store.claim(sid, label, labelOf);
      store.update((f) => {
        const d = f.devices[sid];
        if (!d) return;
        if (r.ok) d.lastWake = app.now().toISOString();
        store.count(f, sid, { wakes: 1 });
      }, alive);
      return send(res, 200, r);
    }
    if (b === 'turn' && method === 'POST') return await wakeTurn(req, res, sid);
    throw new HttpError(404, 'Not found');
  };

  async function wakeTurn(req: Parameters<RouteHandler>[0], res: Parameters<RouteHandler>[1], sid: string | undefined): Promise<void> {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'audio/wav' && type !== 'audio/x-wav' && type !== 'audio/wave') {
      await readRaw(req, TURN_MAX_BYTES + 1).catch(() => undefined);
      throw new HttpError(415, 'Expected a WAV recording.');
    }
    const claimId = String(req.headers['x-sara-wake-claim'] ?? '');
    const wav = await readRaw(req, TURN_MAX_BYTES);
    if (!claimId) throw new HttpError(400, 'Missing X-Sara-Wake-Claim.');
    if (!isWav(wav)) throw new HttpError(415, 'Expected a WAV recording.');
    const secs = wavSeconds(wav);
    if (secs === undefined || secs > TURN_MAX_SECONDS + 0.05) throw new HttpError(413, 'Recordings are 15 seconds at most.');
    if (!sid) throw new HttpError(401, 'Sign in first.');
    const live = store.liveClaim(claimId, sid);
    if (!live) throw new HttpError(409, 'That wake has expired. Say “Hey Sara” again.');
    const srv = server();
    if (!srv.allowed) throw new HttpError(403, 'Hey Sara is off on this server. Ask the owner.');
    if (opts.member && !srv.members) throw new HttpError(403, MEMBERS_OFF);
    if (!app.settings.get().disclosureAcceptedAt) throw new HttpError(403, 'Read and accept the AI notice in Sara first.');
    if (privateLocalOn() && !voiceState().here) throw new HttpError(409, PRIVATE_HEARING, { paused: 'private-hearing' });
    const label = String(req.headers['x-sara-wake-label'] ?? live.label);
    const phrase = view().phrases.find((p) => p.label === label);
    const companionId = phrase?.companionId ?? me;
    // The phrase is for another of his companions: her own server answers it (X-Sara-Companion).
    if (companionId !== me) throw new HttpError(409, 'That phrase is for another companion.', { companion: companionId });
    const dev = store.read(alive).devices[sid];
    const names = [app.persona.name, ...view().phrases.map((p) => nameOf(p.text))];
    const done = (ended: 'nothing' | 'stop' | 'answered') => {
      store.endClaim(claimId);
      store.update((f) => store.count(f, sid, ended === 'nothing' ? { nothing: 1 } : ended === 'stop' ? { stopped: 1 } : { answered: 1 }), alive);
    };

    let heard: string;
    try {
      heard = (await speech.transcribe(wav)).trim();
    } catch (err) {
      store.endClaim(claimId);
      throw new HttpError(503, (err as Error).message);
    }
    if (saidNothing(heard)) {
      done('nothing');
      return send(res, 200, { heard: '', ended: 'nothing', spoken: [] });
    }
    if (isStopWord(heard, names)) {
      done('stop');
      return send(res, 200, { heard, ended: 'stop', spoken: [] });
    }

    // Which conversation (§5.2): her own Hey Sara one, the one open on the device, or a new one.
    const talksIn = view().talksIn;
    let conv = undefined as ReturnType<typeof app.store.getConversation>;
    if (talksIn === 'open') {
      const id = String(req.headers['x-sara-wake-conversation'] ?? '');
      const c = id && ctxOf(id) === app ? app.store.getConversation(id) : undefined;
      if (c && !c.private && !c.partner && !isGroupChannel(c.channel) && !c.endedAt) conv = c;
    }
    if (!conv && talksIn === 'new') conv = app.store.createConversation({ channel: 'web' });
    if (!conv) {
      conv = app.store.findChannelConversation('wake', 'own') ?? app.store.createConversation({ title: `Hey ${app.persona.name || 'Sara'}`, channel: 'wake', channelKey: 'own', titleSource: 'owner' });
    }
    const convId = conv.id;
    const personal = dev ? dev.personal : false;
    const spoken: { kind: 'disclosure' | 'crisis' | 'reply'; text: string }[] = [];
    let replyId = 0;
    let open = false;
    let needsOk = false;
    let failed = '';
    const run = app.runTracked;
    if (!run) throw new HttpError(503, 'Sara isn’t ready yet.');
    await new Promise<void>((resolve) => {
      const onEvent = (ev: ChatEvent) => {
        if (ev.type === 'notice' && ev.kind === 'disclosure') spoken.push({ kind: 'disclosure', text: ev.text });
        if (ev.type === 'notice' && ev.kind === 'crisis') spoken.push({ kind: 'crisis', text: CRISIS_RESOURCES });
        if (ev.type === 'image' || ev.type === 'file') open = true;
        if (ev.type === 'error') failed = ev.message;
        if (ev.type === 'done') replyId = ev.messageId;
        // An approval waits on screen as always; the device is told to look (nothing is approved by voice).
        if (ev.type === 'approval') {
          open = true;
          needsOk = true;
          resolve();
        }
      };
      usageScope
        .run({ purpose: 'wake', conversationId: convId }, () => run(convId, heard, onEvent, { via: 'wake', voiceRoom: !personal }))
        .catch((err: Error) => {
          failed = err.message;
        })
        .finally(() => resolve());
    });
    // His message carries which device heard it (never the audio).
    const mine = app.store.messages(convId).filter((m) => m.role === 'user').at(-1);
    if (mine && mine.meta?.via === 'wake') app.store.updateMessageMeta(mine.id, { device: dev?.label ?? labelOf(sid) });
    if (!needsOk) done('answered');
    else store.update((f) => store.count(f, sid, { answered: 1 }), alive);
    let reply = '';
    let more = false;
    if (replyId) {
      const msg = app.store.messages(convId).find((m) => m.id === replyId);
      if (msg?.meta?.blocked || msg?.content === MINOR_BLOCK_REPLY) reply = MINOR_BLOCK_REPLY;
      else if (msg?.content) {
        const r = spokenReply(msg.content, speechText);
        reply = r.text;
        more = r.more;
        if (Array.isArray(msg.meta?.images) || msg.meta?.files) open = true;
      }
    }
    if (needsOk && !reply) reply = 'She needs your OK in Sara.';
    if (reply) spoken.push({ kind: 'reply', text: reply });
    if (more) open = true;
    return send(res, 200, { heard, conversationId: convId, companionId, spoken, open, ...(needsOk ? { needsOk: true } : {}), ...(more ? { more: true } : {}), ...(failed && !reply ? { error: failed } : {}) });
  }
}

/** Downloads the pinned model tarball once and keeps only en.phone (checked) on the server. */
async function fetchLexicon(file: string, fetchImpl?: typeof fetch): Promise<void> {
  const dir = join(file, '..');
  const tmp = join(dir, '.download');
  mkdirSync(tmp, { recursive: true });
  const tarFile = join(tmp, 'model.tar.bz2');
  try {
    await downloadPinned(LEXICON.tar.url, LEXICON.tar.sha256, tarFile, { fetch: fetchImpl });
    await runTar(systemTar())(tarFile, tmp, [LEXICON.inTar]);
    const got = join(tmp, LEXICON.inTar);
    if (createHash('sha256').update(readFileSync(got)).digest('hex') !== LEXICON.sha256) throw new Error("The word list didn't match what Sara expects, so it wasn't kept.");
    renameSync(got, file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
