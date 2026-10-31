// HTTP API + static web UI. No framework; node:http only.
import { netFetch, privateLocalOn } from './net-guard.ts';
import { createReadStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { appLanguage, en, trOwner } from './i18n.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { qrSvg } from './qr.ts';
import { DemoCallGate } from './demo-calls.ts';
import { newChallenge, verifyAssertion, verifyRegistration } from './webauthn.ts';
import { Updater } from './updates.ts';
import { LiveCall, type ConnectUpstream } from './live.ts';
import { CallBroker } from './calls.ts';
import { speechOf } from './speech.ts';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { DEVICE_TOKEN_PREFIX, deviceLabel, LoginLimiter, OwnerAuth, SESSION_COOKIE } from './auth.ts';
import { cleanLimits as cleanMemberLimits, COST_LIMITS, HouseholdError, INVITE_HOURS, LEAVING_DAYS, MESSAGE_LIMITS, memberRouteCheck, type MemberRecord, type ModelPick, type PairRegistry } from './household.ts';
import type { FirstClaim } from './claim.ts';
import { cleanScope, DeviceFlow } from './device-flow.ts';
import { handleOpenAI } from './openai-api.ts';
import { handleMcp } from './mcp-server.ts';
import { AlexaService } from './alexa.ts';
import { DEFAULT_APP_NAME, KeyLimiter } from './other-apps.ts';
import { usageLine } from './usage.ts';
import { cleanMore } from './budget.ts';
import { MAX_IMAGES_PER_MESSAGE, UploadError } from './uploads.ts';
import { TogetherStore } from './together.ts';
import { runTurn, type TurnOptions, type AppContext, type ChatEvent } from './chat.ts';
import { cameraState, FRAME_MAX_BYTES, SAFETY_PAUSE_MS, VideoSessions, videoSettings } from './video.ts';
import { DISCLOSURE_TEXT, disclosureText } from './safety.ts';
import { personalize } from './identity.ts';
import { stripTypeScriptTypes } from 'node:module';
import { identityOf } from './persona.ts';
import { cleanTags, CONVERSATION_MODES, Store, type Conversation, type ConversationMode, type StoredMessage } from './store.ts';
import { clampBanter, GROUP_CHANNEL, groupRooms, isGroupChannel, MAX_MEMBERS, MIN_MEMBERS, TURN_STYLES, type GroupRoom, type TurnStyle } from './group.ts';
import { runGroupRound, type RoundMember } from './group-round.ts';
import { ToolRegistry } from './tools/registry.ts';
import { clip } from './tools/types.ts';
import { exportAll } from './export.ts';
import { type AppInfo } from './health.ts';
import { summarizeConversation } from './memory-worker.ts';
import { as400, clientIp, cookies, fromSaraApp, HttpError, isSameOrigin, MAX_BODY, MIME, PHOTO_BODY, readJson, readRaw, safeDecode, SECURITY_HEADERS, send, validWorkspace } from './http.ts';
import { NEXT, type ActiveTurn, type RouteCtx } from './routes/context.ts';
import { createLibraryRoutes } from './routes/library.ts';
import { createCodingRoutes } from './routes/coding.ts';
import { createEvalRoutes } from './routes/evals.ts';
import { createSkillRoutes } from './routes/skills.ts';
import { createPluginRoutes } from './routes/plugins.ts';
import { createAgentRoutes } from './routes/agents.ts';
import { createHookRoutes } from './routes/hooks.ts';
import { createPlannerRoutes } from './routes/planner.ts';
import { createBoardRoutes, DEMO_CARD_ACTIONS } from './routes/board.ts';
import { createMemoryRoutes } from './routes/memory.ts';
import { createPeopleRoutes } from './routes/people.ts';
import { createConnectionsRoutes, createHomeAssistantApi } from './routes/connections.ts';
import { createAdminRoutes } from './routes/admin.ts';
import { createModelsRoutes } from './routes/models.ts';
import { createHerRoutes } from './routes/her.ts';
import { createVoiceRoutes } from './routes/voice.ts';
import { createLiveUpgrade } from './routes/live.ts';
import { createHandsRoutes, createHandsUpgrade } from './routes/hands.ts';

// Kept exported from here for main.ts and the tests.
export { clientIp, fromPhoneApp, fromSaraApp, proxyTrust } from './http.ts';
export { HA_CHANNEL } from './routes/connections.ts';

function validMode(v: unknown): ConversationMode {
  if (!CONVERSATION_MODES.includes(v as ConversationMode)) throw new HttpError(400, 'mode must be chat or coding');
  return v as ConversationMode;
}

function tagsOrThrow(v: unknown): string[] {
  try {
    return cleanTags(v);
  } catch (err) {
    throw as400(err);
  }
}

export interface ServerOptions {
  app: AppContext;
  auth: OwnerAuth;
  webDir: string;
  /** Version info for the health page. */
  info?: AppInfo;
  /** Send the Secure flag on cookies (set when served over HTTPS / behind a TLS proxy). */
  secureCookies?: boolean;
  /**
   * Trust X-Forwarded-For from a local reverse proxy (SARA_TRUST_PROXY=1). Security review (L7):
   * `{ secret }` trusts it only on requests carrying the X-Sara-Proxy header with that per-install
   * secret (Caddy adds it); `{ secret: '' }` never trusts it (tailscale serve can't add a header),
   * so rate limits count by connection. X-Forwarded-Proto is trusted either way.
   */
  trustProxy?: boolean | { secret: string };
  /** Tests: a fake voice service for live calls. */
  liveConnect?: ConnectUpstream;
  /** Demo server for app review and trying Sara out (SARA_DEMO=1, Phase 16). */
  demo?: boolean;
  /** Tests: where to look for the sara-updater.path unit (default /etc/systemd/system). */
  updaterUnitDir?: string;
  /** Tests: which system's way of updating to use (default: this one's; linux when updaterUnitDir is set). */
  updaterPlatform?: NodeJS.Platform;
  /** Tests: a stand-in for the network when checking for a new release (Windows/macOS). */
  updaterFetch?: typeof fetch;
  /** Demo: messages per day for everyone together (SARA_DEMO_DAILY, default 300). */
  demoDaily?: number;
  /** Demo: the reviewer code that unlocks live calls (SARA_DEMO_CALL_CODE; unset = no calls in the demo). */
  demoCallCode?: string;
  /** Demo: minutes of live calls per day for everyone together (SARA_DEMO_CALL_MINUTES_PER_DAY, default 30). */
  demoCallMinutesPerDay?: number;
  /** Tests: the demo call limits (per call, clock). */
  demoCallPerCallMs?: number;
  /** Accept reports from other Sara servers and apps (the app developer's inbox, Phase 19). */
  reportInbox?: boolean;
  /** Where this server sends reports for the developer (SARA_REPORT_TO; "off" = never). */
  reportTo?: string;
  /** Phase 31: all companions on this server (the app above is one of them). */
  companions?: import('./companions.ts').CompanionManager;
  /** Phase 59: first sign-in in the browser on a new server (src/claim.ts); shared by every companion. */
  claim?: FirstClaim;
  /**
   * Phase 71: household mode. `member` is set for a member's space (their record, read live), and
   * makes this server answer only the member routes (src/household.ts → MEMBER_ROUTES). `household`
   * is set for the owner's space: the admin page and joining with an invite.
   */
  member?: MemberHooks;
  household?: HouseholdHooks;
  /** Phase 71: sign-in registries shared by every space (device codes, pairing codes, passkey challenges). */
  deviceFlow?: DeviceFlow;
  pairs?: PairRegistry;
  challenges?: Map<string, { purpose: 'signin' | 'register' | 'confirm'; expires: number }>;
  /** Phase 71: the space this server belongs to ('owner' or a member id), for the shared registries. */
  spaceId?: string;
  /** Phase 71: whether anyone on this server has a passkey (the sign-in page offers passkey sign-in). */
  anyPasskeys?: () => boolean;
  /** Phase 72: her Alexa skill, shared by every space (main.ts routes each linked Alexa to its person). */
  alexa?: AlexaService;
}

/** Phase 71: what a member's space needs from main.ts. */
export interface MemberHooks {
  record: () => MemberRecord | undefined;
  /** Every companion of this member, for their own export and usage. */
  apps: () => AppContext[];
  /** Deletes this member's whole space (asked by the member, re-authenticated). */
  deleteSelf: () => Promise<void>;
}

/** Phase 71: the owner's household admin, implemented in main.ts (it builds and stops spaces). */
export interface HouseholdHooks {
  store: import('./household.ts').HouseholdStore;
  /** The owner's chat models a member may be given. */
  models: () => (ModelPick & { label: string })[];
  /** Uses an invite: makes the member's space; returns their token (shown once) and a session cookie value. */
  join: (code: string, confirm18: unknown, deviceLabel: string) => Promise<{ token: string; session: { value: string; maxAgeSeconds: number } }>;
  usage: (id: string) => ReturnType<typeof import('./household.ts').memberUsage> | null;
  /** Deletes a member's space now (after Remove). */
  deleteNow: (id: string) => Promise<void>;
  /** Signs a member out everywhere (suspend, remove). */
  signOutAll: (id: string) => void;
}

/** A soft square picture with a companion's initial (until she has a look of her own). */
export function initialPicture(name: string): string {
  const letter = ([...name.trim()][0] ?? '?').toUpperCase().replace(/[<>&"']/g, '?');
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},55%,72%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},50%,52%)"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="256" dy="0.35em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="240" font-weight="600" fill="#fff">${letter}</text></svg>`;
}

/** The cookie (and header) naming the companion the app is talking to. */
export const COMPANION_COOKIE = 'sara_companion';

/**
 * Phase 31: which companion a request is for. A conversation in the path decides (so links and
 * notifications from any companion open in the right place); otherwise the app's choice, from
 * the x-sara-companion header or the sara_companion cookie; otherwise the first companion.
 */
export function pickCompanion(companions: import('./companions.ts').CompanionManager, req: IncomingMessage): import('./companions.ts').Companion {
  const path = (req.url ?? '/').split('?')[0];
  const conv = /^\/api\/(?:conversations|live)\/([0-9a-f-]{36})(?:\/|$)/.exec(path)?.[1];
  if (conv) {
    const owner = companions.byConversation(conv);
    if (owner) return owner;
  }
  const ring = /^\/api\/calls\/([\w-]{6,64})\/(?:decline|cancel)$/.exec(path)?.[1];
  if (ring) {
    const owner = companions.byRing(ring);
    if (owner) return owner;
  }
  const h = req.headers['x-sara-companion'];
  const want = (Array.isArray(h) ? h[0] : h) || cookies(req)[COMPANION_COOKIE];
  return companions.get(want) ?? companions.main;
}

// Pairing codes: 12 letters/digits without look-alikes (about 59 bits), shown as XXXX-XXXX-XXXX.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_LEN = 12;
const PAIR_MS = 10 * 60_000;
export function newPairCode(): string {
  let s = '';
  // Rejection sampling keeps every character equally likely.
  while (s.length < PAIR_LEN) for (const b of randomBytes(PAIR_LEN)) if (b < 248 && s.length < PAIR_LEN) s += PAIR_ALPHABET[b % 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
/** Typing is forgiving: lower case, spaces and dashes are fine; O→0 and I/L→1 aren't in the alphabet. */
export const normalizePairCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createSaraServer(opts: ServerOptions): Server {
  const { app, auth } = opts;
  const limiter = new LoginLimiter();
  // Device-code start/poll get their own budget: an app (or a flood of them) can't lock the owner
  // out of signing in, and sign-in failures don't block apps.
  const deviceLimiter = new LoginLimiter(20);
  const active = new Map<string, ActiveTurn>();
  app.isBusy = (id) => active.has(id);
  const webRoot = resolve(opts.webDir);
  // Built-in wording names the owner's companion (written for "Sara"/she, see identity.ts).
  const me = (t: string) => personalize(t, identityOf(app.persona));
  // Her voice and hearing (Grok voice key or sign-in, speech APIs, the on-server voice).
  const speech = speechOf(app);
  const grokSignedIn = () => speech.grokSignedIn();
  const xaiKeySync = () => speech.xaiKeySync();
  const xaiKey = () => speech.xaiKey();
  // Phase 11: one live call at a time.
  let liveCall: LiveCall | undefined;
  // Phase 26: Sara calls you (rings every signed-in app; the first to answer gets the call).
  app.calls ??= new CallBroker(app, { canCall: () => speech.hasXai(), canSpeak: () => speech.canSendNotes() || ((app.settings.get().voice?.tts ?? 'local') === 'local' && Boolean(app.voice)) });
  app.calls.setInCall(() => Boolean(liveCall && !liveCall.ended));
  // Phase 69: video calls (the owner's optional camera): limits and, for classic calls, the newest
  // picture, in memory only (src/video.ts).
  const videos = new VideoSessions();
  // identity.ts is shared with the browser: served with its types stripped (no build step).
  let identityJs: string | undefined;

  // Secure when configured, or (Phase 24) whenever the page is served over https: directly, or
  // through a trusted reverse proxy that says so.
  const isHttps = (req: IncomingMessage) => Boolean((req.socket as { encrypted?: boolean }).encrypted) || (Boolean(opts.trustProxy) && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https');
  const cookieFor = (req: IncomingMessage) => (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${opts.secureCookies || isHttps(req) ? '; Secure' : ''}`;

  function isAuthed(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    // Phase 52: an app the owner approved with a device code (it was approved while signed in, so
    // it works with two-step sign-in on too; signing it out under Devices ends it).
    if (header?.startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`)) {
      // Phase 57: an API key for another app only works on /v1 and /mcp, never on the app's own API.
      const id = opts.demo ? undefined : auth.deviceTokenId(header.slice(7));
      // Phase 100: an agent's key (A2A) only works on /a2a.
      return id !== undefined && auth.deviceKind(id) !== 'api' && auth.deviceKind(id) !== 'a2a';
    }
    // Phase 24: with two-step sign-in on, the owner token alone is no longer enough.
    if (header?.startsWith('Bearer ')) {
      const ok = !auth.twoStepOn && auth.verifyToken(header.slice(7));
      // Phase 59: the owner token was used, so the server has its owner: browser setup ends.
      if (ok) auth.markSignedIn();
      return ok;
    }
    return auth.verifySession(cookies(req)[SESSION_COOKIE]);
  }

  function projectOrThrow(raw: unknown) {
    const id = Number(raw);
    const p = app.planner?.projects(true).find((x) => x.id === id);
    if (!p) throw new HttpError(400, 'That project does not exist.');
    return p;
  }

  function savePhotos(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new HttpError(400, 'images must be a list.');
    if (raw.length > MAX_IMAGES_PER_MESSAGE) throw new HttpError(400, 'Send up to {n} photos at a time.', { params: { n: MAX_IMAGES_PER_MESSAGE } });
    if (raw.length && !app.uploads) throw new HttpError(400, 'Photos are not available on this server.');
    try {
      return raw.map((d) => app.uploads!.save(String(d)).id);
    } catch (err) {
      if (err instanceof UploadError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  function requireDisclosure(req: IncomingMessage): void {
    if (opts.demo ? !demoAccepted.has(visitorKey(req)) : !app.settings.get().disclosureAcceptedAt) throw new HttpError(403, 'Accept the disclosure first.');
  }

  // ---------- Demo server (Phase 16, SARA_DEMO=1) ----------
  // For app review and trying Sara out. Every visitor gets their own conversations, kept only in
  // memory (off the record: never on disk, no memory, no tools) and gone after a few idle hours.
  // Settings and everything else that changes the server are refused. Each visitor accepts the
  // AI disclosure themselves. Daily message limits keep the model bill small.
  const DEMO_IDLE_MS = 6 * 3600_000;
  const DEMO_TURNS_PER_VISITOR = 40;
  const DEMO_TURNS_PER_DAY = opts.demoDaily ?? 300;
  const demoAccepted = new Set<string>();
  const demoOwner = new Map<string, string>(); // conversation id → visitor
  const demoTurns = new Map<string, number>();
  let demoDay = '';
  let demoTotal = 0;
  // Live calls in the demo, for app review: only with the reviewer code, 5 minutes a call, and a
  // daily budget of minutes for everyone together.
  const demoCalls = new DemoCallGate({ code: opts.demo ? opts.demoCallCode : undefined, ...(opts.demoCallMinutesPerDay !== undefined ? { minutesPerDay: opts.demoCallMinutesPerDay } : {}), ...(opts.demoCallPerCallMs !== undefined ? { perCallMs: opts.demoCallPerCallMs } : {}), now: Date.now });
  if (demoCalls.refused) console.warn(`demo calls: ${demoCalls.refused}`);
  /** Who is asking: the signed-in device (cookie), or the owner token. */
  const visitorKey = (req: IncomingMessage): string => auth.sessionId(cookies(req)[SESSION_COOKIE]) ?? 'token';
  function demoTurnAllowed(req: IncomingMessage): void {
    if (!opts.demo) return;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== demoDay) {
      demoDay = day;
      demoTotal = 0;
      demoTurns.clear();
    }
    const k = visitorKey(req);
    const n = demoTurns.get(k) ?? 0;
    if (n >= DEMO_TURNS_PER_VISITOR || demoTotal >= DEMO_TURNS_PER_DAY) throw new HttpError(429, 'That’s all for the demo today. Install Sara on your own server for unlimited use.');
    demoTurns.set(k, n + 1);
    demoTotal++;
  }
  /** What a demo visitor may change: their own conversations, signing out. Everything else is read-only. */
  // Phase 99: 'boards' (the demo's sample board, per visitor, in memory) and its card actions below.
  const DEMO_WRITES = new Set(['conversations', 'disclosure', 'logout', 'demo', 'reports', 'boards']);
  /** Security review: routes an app signed in with a device code may not use (sign-in settings, devices, approving apps). */
  // Phase 100: 'agents' (A2A keys and peers) too.
  const DEVICE_TOKEN_DENIED = new Set(['devices', 'device', 'security', 'passkey', 'two-step', 'owner-token', 'pair', 'other-apps', 'hands', 'agents', 'hooks']);
  /**
   * Phase 24 (security review): what a demo visitor may read. Everyone on the demo is "signed in",
   * so owner-only pages (backups, files, health details, accounts, devices…) must be listed out,
   * not left open.
   */
  const DEMO_READS = new Set(['live', 'session', 'conversations', 'events', 'persona', 'look', 'sara', 'memories', 'memory', 'projects', 'tasks', 'notes', 'reminders', 'planner', 'scrapbook', 'today', 'tags', 'find', 'approvals', 'jobs', 'setup', 'checklist', 'review', 'briefing', 'providers', 'tools', 'settings', 'uploads', 'reports', 'boards']);
  if (opts.demo) {
    setInterval(() => {
      const cutoff = Date.now() - DEMO_IDLE_MS;
      for (const c of offStore.listConversations()) if (Date.parse(c.updatedAt) < cutoff && !active.has(c.id)) (offStore.deleteConversation(c.id), demoOwner.delete(c.id));
      // Demo sign-ins last a day.
      for (const d of auth.devices()) {
        if (Date.parse(d.createdAt) >= Date.now() - 24 * 3600_000) continue;
        auth.signOut(d.id);
        // Hardening L3: the reviewer-code unlock (and the accepted notice) end with the session.
        demoCalls.forget(d.id);
        demoAccepted.delete(d.id);
      }
      prunePush();
    }, 10 * 60_000).unref();
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === '/identity.js') {
      identityJs ??= stripTypeScriptTypes(readFileSync(join(webRoot, '..', 'src', 'identity.ts'), 'utf8'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      return void res.end(req.method === 'HEAD' ? undefined : identityJs);
    }
    if (pathname === '/manifest.webmanifest') {
      // The installed app is named after the companion (only for the signed-in owner).
      const m = JSON.parse(readFileSync(join(webRoot, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
      if (isAuthed(req)) m.name = m.short_name = app.persona.name;
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      return void res.end(req.method === 'HEAD' ? undefined : JSON.stringify(m));
    }
    const rel = pathname === '/' ? 'index.html' : pathname === '/pair' ? 'pair.html' : pathname === '/device' ? 'device.html' : pathname === '/privacy' ? 'privacy.html' : pathname === '/support' ? 'support.html' : pathname === '/help' ? 'help.html' : safeDecode(pathname).replace(/^\/+/, '');
    // Phase 31: a companion without a look of her own yet shows her initial, not Sara's face.
    if (app.companionId && app.companionId !== 'main' && isAuthed(req) && !app.look?.custom && /^(sara-portrait|sara-avatar)\.jpg$|^sara\/[\w-]+\.jpg$/.test(rel)) {
      const svg = initialPicture(app.persona.name);
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      return void res.end(req.method === 'HEAD' ? undefined : svg);
    }
    // A custom look replaces the built-in art for the signed-in owner.
    const custom = isAuthed(req) ? app.look?.fileFor(rel) : undefined;
    if (!custom && isAuthed(req) && app.look?.missing(rel)) throw new HttpError(404, 'Not found');
    if (custom) {
      const cs = statSync(custom);
      const ctag = `"l${cs.size.toString(36)}-${Math.floor(cs.mtimeMs).toString(36)}"`;
      if (req.headers['if-none-match'] === ctag) {
        res.writeHead(304, { etag: ctag, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
        return void res.end();
      }
      const head = readFileSync(custom).subarray(0, 4);
      res.writeHead(200, { 'content-type': head[0] === 0x89 ? 'image/png' : head[0] === 0x52 ? 'image/webp' : 'image/jpeg', 'cache-control': 'no-cache', etag: ctag, ...SECURITY_HEADERS });
      if (req.method === 'HEAD') return void res.end();
      return void createReadStream(custom).pipe(res);
    }
    const file = resolve(webRoot, normalize(rel));
    if (file !== webRoot && !file.startsWith(webRoot + sep)) throw new HttpError(404, 'Not found');
    const target = existsSync(file) && statSync(file).isFile() ? file : join(webRoot, 'index.html');
    const st = statSync(target);
    // Always revalidate so a new version is picked up on the next load; unchanged files cost a 304.
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      return void res.end();
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag,
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(target).pipe(res);
  }

  /**
   * Runs a turn. The turn keeps going if the browser disconnects (reload, closed tab); only the
   * Stop endpoint cancels it. Progress is visible through `activity` on the conversation.
   */
  /**
   * Runs one turn with activity tracking (busy state, activity bar, approvals, Stop). Used by the
   * web stream and by the chat bridges (Telegram, Discord) via app.runTracked.
   */
  // Off the record (Phase 14): conversations kept only in this process's memory. Nothing is
  // written to disk (so nothing reaches backups); no memory notes, no mood changes, no tools (they
  // could leave files), no photos. Closing it, or a server restart, makes it gone for good.
  // The safety layer (disclosure, crisis help, the minor block) works exactly as usual.
  class OffRecordStore extends Store {
    // How long she's known the owner still comes from the real history.
    override firstOwnerMessageAt() {
      return app.store.firstOwnerMessageAt();
    }
  }
  const offStore = new OffRecordStore(':memory:', app.now);
  const noTools = new ToolRegistry([]);
  // Demo: every visitor's conversations share this store, so what she reads through her context
  // ("lately in your other conversations") must never list them: another visitor's chat would
  // reach her chat or call. The demo's own routes use offStore directly and filter by visitor.
  const ctxStore: OffRecordStore = opts.demo
    ? new Proxy(offStore, {
        get: (t, k) => {
          if (k === 'listConversations') return () => [];
          const v = Reflect.get(t, k, t) as unknown;
          return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(t) : v;
        },
      })
    : offStore;
  // Phase 78: off the record means no run snapshots either (`runs` unset: nothing is recorded).
  const offOverrides: Partial<AppContext> = { runs: undefined, store: ctxStore, memory: undefined, inner: undefined, tools: noTools, uploads: undefined, moments: undefined, momentsWorker: undefined, together: app.together ? new TogetherStore(offStore.db, app.now) : undefined };
  const offApp = new Proxy(app, { get: (t, k: string) => (k in offOverrides ? offOverrides[k as keyof AppContext] : t[k as keyof AppContext]) }) as AppContext;
  /** The context a conversation lives in (off-the-record ones are only in memory). */
  const ctxOf = (id: string): AppContext => (offStore.getConversation(id) ? offApp : app);

  async function runTracked(conversationId: string, content: string, onEvent: (ev: ChatEvent) => void, opts: TurnOptions = {}): Promise<void> {
    if (active.has(conversationId)) throw new HttpError(409, me('Sara is still working on this conversation. Wait for her or press Stop.'), { errorKey: 'Sara is still working on this conversation. Wait for her or press Stop.' });
    const controller = new AbortController();
    const turn: ActiveTurn = { controller, startedAt: app.now().toISOString(), status: 'thinking', detail: '', approvals: new Map() };
    active.set(conversationId, turn);
    let lastText = '';
    let failed = false;
    const cx = ctxOf(conversationId);
    // Other devices showing this conversation follow along (never for off-the-record ones).
    const shared = cx === app;
    if (shared) app.events?.publish({ type: 'turn', conversationId, state: 'started' });
    const partner = Boolean(cx.store.getConversation(conversationId)?.partner);
    const started = Date.now();
    let firstToken = 0;
    try {
      for await (const ev of runTurn(cx, conversationId, content, controller.signal, opts)) {
        trackActivity(turn, ev);
        onEvent(ev);
        // Phase 30: how long until her reply starts (health history).
        if (ev.type === 'token' && !firstToken) firstToken = Date.now() - started;
        if (ev.type === 'token') lastText += ev.text;
        if (ev.type === 'tool_call' || ev.type === 'tool_result') lastText = '';
        if (ev.type === 'error') failed = true;
        // She needs the owner's OK: a notification (shown only when the app isn't in front).
        if (ev.type === 'approval' && !partner) void app.push?.notifyOwner(trOwner('Sara needs your OK', app.settings.get(), undefined, identityOf(app.persona)), ev.summary, conversationId, `ok-${ev.id}`).catch(() => {});
      }
      // A long job finished while the owner may be away.
      const secs = (app.now().getTime() - Date.parse(turn.startedAt)) / 1000;
      if (!partner && !failed && !controller.signal.aborted && secs >= 60) void app.push?.notifyOwner(trOwner('Sara finished', app.settings.get(), undefined, identityOf(app.persona)), lastText.trim() || trOwner('Done.', app.settings.get()), conversationId, `done-${conversationId}`).catch(() => {});
      app.healthHistory?.turn(firstToken || null, failed);
    } finally {
      active.delete(conversationId);
      // Phase 49: her testing browser closes with the turn.
      void app.browsers?.close(conversationId).catch(() => {});
      if (shared) app.events?.publish({ type: 'turn', conversationId, state: 'ended' });
    }
  }
  app.runTracked = runTracked;
  // Phase 99: a card's Stop ends the turn working it (the same as Stop in the chat).
  app.stopTurn = (conversationId) => {
    const t = active.get(conversationId);
    if (!t) return false;
    t.controller.abort(new Error('stopped'));
    return true;
  };
  // Planned shutdown (restart, update): stop running turns so they save what they have.
  app.stopAllTurns = async () => {
    for (const t of active.values()) t.controller.abort(new Error('restart'));
    for (let i = 0; i < 40 && active.size; i++) await new Promise((r) => setTimeout(r, 50));
  };

  // Phase 57: a change another app asked for (an MCP write tool) that needs the owner's OK: an
  // approval card in that app's conversation, like her own actions. It runs only after Allow, and
  // what happened is posted there (and fed to her as an app note).
  const externalTurns = new Map<string, number>();
  function requestApproval(conversationId: string, name: string, summary: string, args: Record<string, unknown>, run: () => Promise<string>): void {
    let turn = active.get(conversationId);
    if (turn && !externalTurns.has(conversationId)) throw new Error(me('Sara is busy in that conversation: try again when she has answered.'));
    if (!turn) {
      turn = { controller: new AbortController(), startedAt: app.now().toISOString(), status: 'waiting', detail: summary, approvals: new Map() };
      active.set(conversationId, turn);
      externalTurns.set(conversationId, 0);
      app.events?.publish({ type: 'turn', conversationId, state: 'started' });
    }
    if (turn.approvals.size >= 10) throw new Error('Ten changes are already waiting for the owner there.');
    const t = turn;
    const { id, decision } = app.approvals.request(conversationId, t.controller.signal);
    const callId = `app-${id}`;
    t.approvals.set(callId, { type: 'approval', approvalId: id, id: callId, name, summary, args });
    t.status = 'waiting';
    t.detail = summary;
    externalTurns.set(conversationId, (externalTurns.get(conversationId) ?? 0) + 1);
    void app.push?.notifyOwner(trOwner('Sara needs your OK', app.settings.get(), undefined, identityOf(app.persona)), summary, conversationId, `ok-${id}`).catch(() => {});
    void decision
      .then(async (ok) => {
        let text: string;
        let status = ok ? 'ok' : 'stopped';
        try {
          text = ok ? await run() : `Declined: ${summary}`;
        } catch (err) {
          text = `Couldn't do it (${summary}): ${(err as Error).message}`;
          status = 'error';
        }
        const msg = app.store.addMessage(conversationId, 'notice', `job:${text}`, { status });
        app.events?.publish({ type: 'message', conversationId, message: { id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt, meta: { status } }, reason: 'job' });
      })
      .finally(() => {
        t.approvals.delete(callId);
        const n = (externalTurns.get(conversationId) ?? 1) - 1;
        if (n > 0) return void externalTurns.set(conversationId, n);
        externalTurns.delete(conversationId);
        if (active.get(conversationId) === t) active.delete(conversationId);
        app.events?.publish({ type: 'turn', conversationId, state: 'ended' });
      });
  }
  // Phase 57: other apps (OpenAI-compatible /v1, MCP /mcp): per-key limits.
  const appLimiter = new KeyLimiter(60);

  /** Runs a turn with nobody streaming it; her reply is published as a message (→ notifications). */
  async function runBackground(conversationId: string, content: string, opts: TurnOptions = {}): Promise<void> {
    const cx = ctxOf(conversationId);
    let replyId = 0;
    try {
      await runTracked(conversationId, content, (ev) => {
        if (ev.type === 'done') replyId = ev.messageId;
      }, opts);
    } catch (err) {
      console.warn(`background reply: ${(err as Error).message}`);
      return;
    }
    const msg = replyId ? cx.store.messages(conversationId).find((m) => m.id === replyId) : undefined;
    if (!msg || msg.role !== 'assistant' || !msg.content.trim() || cx !== app) return;
    // Marked so the Android app's regular check shows it too.
    app.store.updateMessageMeta(msg.id, { background: true });
    app.events?.publish({ type: 'message', conversationId, message: { id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt, meta: { ...(msg.meta ?? {}), background: true } }, reason: 'reply' });
  }

  async function streamChat(req: IncomingMessage, res: ServerResponse, conversationId: string, content: string, opts: TurnOptions = {}): Promise<void> {
    if (active.has(conversationId)) throw new HttpError(409, me('Sara is still working on this conversation. Wait for her or press Stop.'), { errorKey: 'Sara is still working on this conversation. Wait for her or press Stop.' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
      ...SECURITY_HEADERS,
    });
    const write = (chunk: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    };
    // Heartbeat keeps proxies from timing out during long tool runs.
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
    try {
      await runTracked(conversationId, content, (ev) => write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`), opts);
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  // ---------- Phase 66: group chats (see src/group.ts, docs/GROUP_CHATS.md) ----------
  const rooms = () => groupRooms(app.rootDir ?? app.dataDir);
  const companionApp = (id: string): AppContext | undefined => opts.companions?.get(id)?.app ?? (id === (app.companionId ?? 'main') ? app : undefined);
  /** A room as the apps see it: members with their name and colour (a removed companion is marked gone). */
  const roomView = (room: GroupRoom) => ({
    id: room.id,
    title: room.title,
    turnStyle: room.turnStyle,
    banter: room.banter,
    private: room.private,
    createdAt: room.createdAt,
    members: room.members.map((id, i) => {
      const a = companionApp(id);
      return { id, name: a?.persona.name ?? '?', color: i, ...(a ? {} : { gone: true }) };
    }),
  });
  /** The room a group conversation belongs to, with each member's own copy of it. */
  function roomOf(conv: Conversation): { room: GroupRoom; members: RoundMember[] } | undefined {
    if (!isGroupChannel(conv.channel)) return undefined;
    const room = rooms().get(conv.channelKey);
    if (!room) return undefined;
    const members = room.members.flatMap((id, i): RoundMember[] => {
      const a = companionApp(id);
      const copy = a?.store.findChannelConversation(GROUP_CHANNEL, room.id);
      return a && copy ? [{ id, app: a, convId: copy.id, speaker: { id, name: a.persona.name, color: i } }] : [];
    });
    return { room, members };
  }
  const groupInfo = (conv: Conversation) => {
    const room = isGroupChannel(conv.channel) ? rooms().get(conv.channelKey) : undefined;
    return room ? { group: roomView(room) } : {};
  };
  /** One round in a group chat, streamed like a turn (each reply starts with a `speaker` event). */
  async function streamGroup(res: ServerResponse, conv: Conversation, content: string): Promise<void> {
    const r = roomOf(conv);
    if (!r) throw new HttpError(404, 'This group chat is gone.');
    if (r.members.length < MIN_MEMBERS) throw new HttpError(400, 'This group chat needs at least two of its companions.');
    const rs = rooms();
    if (rs.isBusy(r.room.id) || active.has(conv.id)) throw new HttpError(409, 'The group is still answering. Wait for them or press Stop.');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive', ...SECURITY_HEADERS });
    const write = (chunk: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    };
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
    const controller = new AbortController();
    const turn: ActiveTurn = { controller, startedAt: app.now().toISOString(), status: 'thinking', detail: '', approvals: new Map() };
    rs.setBusy(r.room.id, controller);
    active.set(conv.id, turn);
    app.events?.publish({ type: 'turn', conversationId: conv.id, state: 'started' });
    try {
      for await (const ev of runGroupRound({ room: r.room, rooms: rs, members: r.members, viewerId: app.companionId ?? 'main', text: content, signal: controller.signal })) {
        if (ev.type === 'speaker') {
          turn.status = 'thinking';
          turn.detail = ev.speaker?.name ?? '';
        } else if (ev.type !== 'retract' && ev.type !== 'group_done') trackActivity(turn, ev);
        write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      rs.setBusy(r.room.id, null);
      active.delete(conv.id);
      app.events?.publish({ type: 'turn', conversationId: conv.id, state: 'ended' });
      if (!res.writableEnded) res.end();
    }
  }

  function trackActivity(turn: ActiveTurn, ev: ChatEvent): void {
    switch (ev.type) {
      case 'token':
        turn.status = 'writing';
        turn.detail = '';
        break;
      case 'tool_call':
        turn.status = 'running';
        turn.detail = ev.summary;
        break;
      case 'tool_progress':
        turn.status = 'writing';
        turn.detail = ev.path ? `writing ${ev.path} (${Math.round(ev.chars / 1024)} KB so far)` : `preparing ${ev.name} (${Math.round(ev.chars / 1024)} KB so far)`;
        break;
      case 'tool_building':
        // Phase 63: a call still being written (another device watching sees what).
        turn.status = 'writing';
        turn.detail = ev.path ? `writing ${ev.path}${ev.lines ? ` (${ev.lines} lines so far)` : ''}` : `preparing ${ev.name}`;
        break;
      case 'approval':
        turn.status = 'waiting';
        turn.detail = ev.summary;
        turn.approvals.set(ev.id, ev);
        break;
      case 'tool_running':
        turn.approvals.delete(ev.id);
        turn.status = 'running';
        turn.detail = ev.summary;
        break;
      case 'sandbox_running':
        // Phase 80: the command is being tried in a throwaway copy first.
        turn.approvals.delete(ev.id);
        turn.status = 'running';
        turn.detail = 'trying it in a sandbox copy';
        break;
      case 'tool_result':
        turn.approvals.delete(ev.id);
        turn.status = 'thinking';
        turn.detail = '';
        break;
    }
  }

  function activityView(conversationId: string) {
    const t = active.get(conversationId);
    return t ? { status: t.status, detail: t.detail, startedAt: t.startedAt, approvals: [...t.approvals.values()] } : null;
  }

  let pairing: { hash: Buffer; expires: number } | undefined;
  /** Phase 71: whose space this server is ('owner' or a member id), for the shared sign-in registries. */
  const spaceId = opts.spaceId ?? 'owner';
  // Phase 52: device-code sign-in requests (in memory, 10 minutes).
  const deviceFlow = opts.deviceFlow ?? new DeviceFlow();
  /** The device id when the request came with a device token (apps can't approve other apps). */
  const deviceTokenOf = (req: IncomingMessage) => {
    const h = req.headers.authorization;
    return h?.startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`) ? auth.deviceTokenId(h.slice(7)) : undefined;
  };
  // Phase 24: passkey challenges (one use, 5 minutes).
  const challenges = opts.challenges ?? new Map<string, { purpose: 'signin' | 'register' | 'confirm'; expires: number }>();
  const issueChallenge = (purpose: 'signin' | 'register' | 'confirm') => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
    // Separate room for sign-in and for adding passkeys, so a flood of one can't block the other.
    if ([...challenges.values()].filter((v) => v.purpose === purpose).length >= 200) throw new HttpError(429, 'Too many passkey requests. Try again in a few minutes.');
    const c = newChallenge();
    challenges.set(c, { purpose, expires: now + 5 * 60_000 });
    return c;
  };
  const takeChallenge = (c: string, purpose: 'signin' | 'register' | 'confirm'): string => {
    const v = challenges.get(c);
    challenges.delete(c);
    if (!v || v.purpose !== purpose || v.expires < Date.now()) throw new Error('This passkey request has expired. Try again.');
    return c;
  };
  const clientChallenge = (clientDataJSON: unknown): string => {
    try {
      return String((JSON.parse(Buffer.from(String(clientDataJSON ?? ''), 'base64url').toString('utf8')) as { challenge?: string }).challenge ?? '');
    } catch {
      return '';
    }
  };
  /** The site a passkey belongs to: the page's own origin (which must be this server). */
  const passkeySite = (req: IncomingMessage): { origin: string; rpId: string } => {
    const origin = String(req.headers.origin ?? '');
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new HttpError(400, 'Passkeys work from the web page only.');
    }
    if (u.host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused.');
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new HttpError(400, 'Passkeys need a secure (https) address.');
    return { origin: u.origin, rpId: u.hostname };
  };
  // Phase 23: updates from Settings.
  // Phase 31: the server's own folder (each companion's app.dataDir is her own folder).
  const rootDir = app.rootDir ?? app.dataDir;
  // Phase 72: her Alexa skill. main.ts hands every space one shared service (links name a person and
  // a companion); a server built alone (tests) answers for its own companions.
  const alexa =
    opts.alexa ??
    new AlexaService({
      dir: rootDir,
      skillId: () => app.settings.get().alexa?.skillId,
      quick: () => app.settings.get().alexa?.quick === true,
      resolve: (l) => (l.space !== spaceId ? undefined : (opts.companions?.get(l.companion)?.app ?? (l.companion === (app.companionId ?? 'main') ? app : undefined))),
    });
  const updater = new Updater({ dataDir: rootDir, version: opts.info?.version ?? 'dev', platform: opts.updaterPlatform ?? (opts.updaterUnitDir ? 'linux' : process.platform), ...(opts.updaterFetch ? { fetch: opts.updaterFetch } : {}), ...(opts.updaterUnitDir ? { unitDir: opts.updaterUnitDir, statusDir: rootDir } : {}) });
  const info = opts.info ?? { version: 'dev', revision: null, startedAt: new Date().toISOString() };
  /** After sign-outs: notifications stop for devices that are no longer signed in. */
  const prunePush = () => app.push?.prune(new Set(auth.devices().map((d) => d.id)));

  // ---------- Wave 3: route modules (src/routes/*.ts), built once from this closure ----------
  const ctx: RouteCtx = {
    active,
    app,
    me,
    offStore,
    opts,
    projectOrThrow,
    rootDir,
    alexa,
    auth,
    ctxOf,
    demoOwner,
    spaceId,
    visitorKey,
    webRoot,
    prunePush,
    requireDisclosure,
    runBackground,
    streamChat,
    info,
    updater,
    demoCalls,
    grokSignedIn,
    speech,
    videos,
    xaiKey,
    xaiKeySync,
    get liveCall() {
      return liveCall;
    },
    set liveCall(v) {
      liveCall = v;
    },
    demoAccepted,
    isAuthed,
    offApp,
  };
  const libraryRoutes = createLibraryRoutes(ctx);
  const codingRoutes = createCodingRoutes(ctx);
  const evalRoutes = createEvalRoutes(ctx);
  const skillRoutes = createSkillRoutes(ctx);
  const pluginRoutes = createPluginRoutes(ctx);
  const agentRoutes = createAgentRoutes(ctx);
  const hookRoutes = createHookRoutes(ctx);
  // Phase 100: her address on the Agent Card is the one the peer used (https behind a trusted proxy).
  if (app.a2a) app.a2a.baseOf = (req) => `${isHttps(req) ? 'https' : 'http'}://${String(req.headers.host ?? 'localhost')}`;
  const plannerRoutes = createPlannerRoutes(ctx);
  const boardRoutes = createBoardRoutes(ctx);
  const memoryRoutes = createMemoryRoutes(ctx);
  // Phase 101 (ST6): people cards (src/routes/people.ts).
  const peopleRoutes = createPeopleRoutes(ctx);
  const connectionsRoutes = createConnectionsRoutes(ctx);
  const adminRoutes = createAdminRoutes(ctx);
  const modelsRoutes = createModelsRoutes(ctx);
  const herRoutes = createHerRoutes(ctx);
  const voiceRoutes = createVoiceRoutes(ctx);
  const homeAssistantApi = createHomeAssistantApi(ctx);
  // Phase 87: computer use (src/routes/hands.ts); a Stop pressed on the computer stops the turn here.
  const handsRoutes = createHandsRoutes(ctx);
  app.hands?.onStop((conversationId) => active.get(conversationId)?.controller.abort());

  async function api(req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<void> {
    const [a, b, c] = parts;
    const cookie = cookieFor(req);
    /** For routes that run before the sign-in check: a JSON request from this site only. */
    const sameSiteOnly = () => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
      if (!isSameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused.');
    };

    if (a === 'health' && !b && method === 'GET') return send(res, 200, { ok: true });
    // The developer's report inbox: open to every Sara server and app, but small and rate-limited.
    if (a === 'public' && b === 'report' && method === 'POST' && opts.reportInbox && app.reports) {
      const body = await readJson(req, 16 * 1024);
      try {
        if (!app.reports.receive(clientIp(req, opts.trustProxy), body)) throw new HttpError(429, 'Too many reports from here. Try again later.');
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw as400(err);
      }
      return send(res, 202, { ok: true });
    }

    // Phase 52: device-code sign-in for the terminal client and the VS Code extension. The app
    // asks for a code (counted like a cheap sign-in attempt) and polls with its secret.
    if (a === 'device' && (b === 'start' || b === 'poll') && method === 'POST' && !opts.demo) {
      sameSiteOnly();
      const ip = clientIp(req, opts.trustProxy);
      if (deviceLimiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const body = await readJson(req);
      if (b === 'start') {
        if (body.scope === 'hands' && (opts.member || !app.hands)) throw new HttpError(403, 'Only the owner can pair Linux hands on this server.');
        deviceLimiter.fail(ip, Date.now(), 1);
        let r;
        try {
          // Hardening M4: an app may ask for less than full access (Home Assistant asks for its own scope).
          r = deviceFlow.start(body.name, deviceLabel(req.headers['user-agent']), ip, cleanScope(body.scope));
        } catch (err) {
          throw new HttpError(429, (err as Error).message);
        }
        const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
        app.events?.publish({ type: 'device', pending: deviceFlow.pending().length });
        // Security review: no code in the link: the owner types the code the app shows.
        return send(res, 200, { ...r, verifyUrl: `${origin}/device`, approveIn: 'Settings → Data & health → Devices and sign-in' });
      }
      const r = deviceFlow.poll(String(body.pollToken ?? ''));
      if (r.status === 'expired') deviceLimiter.fail(ip, Date.now(), 0.2);
      return send(res, r.status === 'expired' ? 410 : 200, r.status === 'approved' ? { status: 'approved', token: r.token, deviceId: r.deviceId, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}) } : { status: r.status });
    }

    if (a === 'login' && method === 'POST') {
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const body = await readJson(req);
      if (!auth.verifyToken(String(body.token ?? ''))) {
        limiter.fail(ip);
        throw new HttpError(401, 'Wrong owner token.');
      }
      // Phase 24: two-step sign-in asks for the code from the authenticator app too.
      if (auth.twoStepOn) {
        if (!body.code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', { twoStep: true });
        if (!auth.checkTwoStep(String(body.code))) {
          limiter.fail(ip);
          throw new HttpError(401, 'That code is wrong or was already used. Wait for the next one.', { twoStep: true });
        }
      }
      limiter.reset(ip);
      // Phase 59: the owner has signed in: browser setup (src/claim.ts) closes for good.
      auth.markSignedIn();
      const session = auth.createSession(deviceLabel(req.headers['user-agent']));
      res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
      // The token has been used: the copy kept for the installer to show isn't needed any more.
      rmSync(join(app.dataDir, 'first-token.txt'), { force: true });
      return send(res, 200, { ok: true });
    }

    // Phase 71: joining with an invite (docs/HOUSEHOLD.md). Only the owner's space answers it; the
    // invite code is the proof (one use, expires), and the new member confirms 18+.
    if (a === 'household' && b === 'join' && !c && opts.household && !opts.member && !opts.demo && (method === 'GET' || method === 'POST')) {
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      if (method === 'GET') {
        const inv = opts.household.store.checkInvite(new URL(req.url ?? '/', 'http://x').searchParams.get('code') ?? '');
        if (!inv) {
          limiter.fail(ip, Date.now(), 0.5);
          throw new HttpError(404, 'That invite is wrong, was already used, or has expired. Ask for a new one.');
        }
        return send(res, 200, { invite: inv });
      }
      sameSiteOnly();
      const body = await readJson(req);
      let joined;
      try {
        joined = await opts.household.join(String(body.code ?? ''), body.confirm18, deviceLabel(req.headers['user-agent']));
      } catch (err) {
        if (err instanceof HouseholdError) {
          if (err.status === 404) limiter.fail(ip);
          throw new HttpError(err.status, err.message);
        }
        throw err;
      }
      limiter.reset(ip);
      res.setHeader('set-cookie', cookie(joined.session.value, joined.session.maxAgeSeconds));
      return send(res, 200, { ok: true, token: joined.token });
    }

    // Phase 59: first sign-in in the browser on a new server (src/claim.ts, docs/THREAT_MODEL.md).
    // GET tells the sign-in page whether setup is open; POST claims the server: a new owner token
    // (the one in the log stops working), shown once, and this browser is signed in.
    if (a === 'claim' && !b && !opts.demo && (method === 'GET' || method === 'POST')) {
      const claim = opts.claim;
      if (method === 'GET') return send(res, 200, claim ? claim.status() : { open: false });
      sameSiteOnly();
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const body = await readJson(req);
      if (!claim) throw new HttpError(404, 'This server already has an owner. Sign in with the owner token.');
      const check = claim.check(ip, body.code);
      if (!check.ok) {
        if (check.wrongCode) {
          limiter.fail(ip);
          claim.failed();
        }
        throw new HttpError(check.status, check.message);
      }
      claim.finish();
      // A fresh token, without setupPending: setup never reopens on this server.
      const token = auth.resetToken();
      limiter.reset(ip);
      rmSync(join(app.dataDir, 'first-token.txt'), { force: true });
      const session = auth.createSession(deviceLabel(req.headers['user-agent']));
      res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
      console.log(`Sara was set up in the browser (${claim.mode === 'browser' ? 'behind the platform login' : 'with the setup code'}) from ${ip}. The owner token printed earlier no longer works.`);
      return send(res, 200, { ok: true, token });
    }

    // Phase 24: passkey sign-in (no token, no code: the passkey checks it's you).
    if (a === 'passkey' && (b === 'signin-options' || b === 'signin') && method === 'POST') {
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const site = passkeySite(req);
      const body = await readJson(req);
      if (b === 'signin-options') {
        limiter.fail(ip, Date.now(), 0.2); // asking is cheap but not free: 50 asks = one failed sign-in budget
        if (!(opts.anyPasskeys?.() ?? auth.passkeys().length > 0)) throw new HttpError(404, 'No passkeys yet: sign in with the owner token, then add one in Settings → Devices and sign-in.');
        return send(res, 200, { challenge: issueChallenge('signin'), rpId: site.rpId, userVerification: 'required', timeout: 120_000 });
      }
      const id = String(body.id ?? '');
      const key = auth.passkey(id);
      try {
        if (!key) throw new Error("This passkey isn't registered here (it may have been removed).");
        const count = verifyAssertion(
          { id, clientDataJSON: String(body.clientDataJSON ?? ''), authenticatorData: String(body.authenticatorData ?? ''), signature: String(body.signature ?? '') },
          key,
          { challenge: takeChallenge(clientChallenge(body.clientDataJSON), 'signin'), ...site },
        );
        auth.usedPasskey(id, count);
      } catch (err) {
        limiter.fail(ip);
        throw new HttpError(401, (err as Error).message);
      }
      limiter.reset(ip);
      const session = auth.createSession(deviceLabel(req.headers['user-agent']));
      res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
      return send(res, 200, { ok: true });
    }

    // Phase 16: sign in a new phone or computer with a one-time code (or by scanning its QR code)
    // instead of typing the owner token. Codes last 10 minutes and work once.
    if (a === 'pair' && b === 'redeem' && method === 'POST') {
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const body = await readJson(req);
      const given = normalizePairCode(String(body.code ?? ''));
      // Phase 71: with the shared registry, a code only works in the space it was made in.
      const ok = opts.pairs ? given.length === PAIR_LEN && opts.pairs.take(spaceId, given) : pairing && pairing.expires > Date.now() && given.length === PAIR_LEN && timingSafeEqual(createHash('sha256').update(given).digest(), pairing.hash);
      if (!ok) {
        limiter.fail(ip);
        throw new HttpError(401, 'That code is wrong or has expired. Make a new one in Settings → Devices and sign-in.');
      }
      pairing = undefined;
      limiter.reset(ip);
      const session = auth.createSession(deviceLabel(req.headers['user-agent']));
      res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
      return send(res, 200, { ok: true });
    }

    if (a === 'logout' && method === 'POST') {
      sameSiteOnly();
      // Signing out forgets this device, so the old cookie can't be reused.
      const id = auth.sessionId(cookies(req)[SESSION_COOKIE]);
      if (id) auth.signOut(id);
      res.setHeader('set-cookie', cookie('', 0));
      return send(res, 200, { ok: true });
    }

    if (a === 'session' && method === 'GET') {
      const authed = isAuthed(req);
      return send(res, 200, {
        authenticated: authed,
        // The companion's name is private to the owner; the sign-in page stays generic.
        disclosure: authed ? disclosureText(app.persona.name, appLanguage(app.settings.get())) : DISCLOSURE_TEXT.replace(/^Sara is/, 'This is'),
        disclosureAccepted: authed ? (opts.demo ? demoAccepted.has(visitorKey(req)) : Boolean(app.settings.get().disclosureAcceptedAt)) : false,
        ...(opts.demo ? { demo: true } : {}),
        // Phase 24: the sign-in page offers "Sign in with a passkey" when one exists.
        ...(!authed && !opts.demo && (opts.anyPasskeys?.() ?? auth.passkeys().length > 0) ? { passkeys: true } : {}),
        // Phase 71: who is signed in (the owner, or a household member and their account's state).
        ...(authed && !opts.demo ? (opts.member ? { role: 'member', member: (({ name, status, deleteAfter, limits }) => ({ name, status, deleteAfter: deleteAfter ?? null, voice: limits.voice, pictures: limits.pictures }))(opts.member.record() ?? ({ name: '', status: 'suspended', limits: { voice: false, pictures: false } } as unknown as MemberRecord)) } : { role: 'owner', ...(opts.household ? { household: true } : {}) }) : {}),
        // Phase 59: a new server that can be set up in the browser (only while nobody has signed in).
        ...(() => {
          const st = !authed && !opts.demo && auth.setupPending ? opts.claim?.status() : undefined;
          return st && (st.open || st.closed) ? { claim: st } : {};
        })(),
        ...(authed ? { identity: identityOf(app.persona) } : {}),
        // Phase 67: the header badge while nothing may leave this computer.
        ...(authed && privateLocalOn() ? { privateLocal: true } : {}),
        // 2.18: the version this server runs, so open pages notice an update and reload (web/update-check.js). Not in the demo.
        ...(authed && !opts.demo ? { version: info.version } : {}),
        // Phase 53: the app language (the page loads its translations before showing anything).
        ...(authed ? { language: app.settings.get().language ?? 'auto', appLanguage: appLanguage(app.settings.get()) } : {}),
        // Phase 16: servers that had adult content before the switch existed ask once (web only).
        ...(authed && app.settings.get().adultMode?.ask && !fromSaraApp(req) ? { adultAsk: true } : {}),
      });
    }

    // Google sends the browser back here after the owner allowed (or refused) access. The session
    // cookie is SameSite=Strict, so it isn't sent on this cross-site return: the one-time `state`
    // (made for the signed-in owner, 10 minutes) is what proves it. The small page then forwards
    // to the app as a same-site navigation, so the owner arrives signed in.
    if (a === 'google' && b === 'callback' && method === 'GET' && app.google) {
      const url = new URL(req.url ?? '/', 'http://x');
      let result = 'connected';
      const error = url.searchParams.get('error');
      if (error) result = error === 'access_denied' ? 'refused' : 'failed';
      else {
        try {
          await app.google.finish(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '');
        } catch (err) {
          result = 'failed';
          console.warn(`google sign-in: ${(err as Error).message}`);
        }
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/#google=${result}"><title>Google</title><p>Back to the app… <a href="/#google=${result}">continue</a></p>`);
    }

    if (a === 'demo' && b === 'start' && method === 'POST' && opts.demo) {
      sameSiteOnly();
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      limiter.fail(ip); // counts toward the same per-address limit as sign-ins
      const session = auth.createSession(`Demo · ${deviceLabel(req.headers['user-agent'])}`);
      res.setHeader('set-cookie', cookie(session.value, Math.min(session.maxAgeSeconds, 24 * 3600)));
      return send(res, 200, { ok: true });
    }

    if (!isAuthed(req)) throw new HttpError(401, 'Sign in first.');
    // Phase 71: a household member's space answers only the member routes (src/household.ts).
    if (opts.member) {
      const chk = memberRouteCheck(opts.member.record(), method, parts);
      if (chk) throw new HttpError(chk.status, chk.message, chk.ownerOnly ? { ownerOnly: true } : undefined);
    }
    // Security review: an app signed in with a device code (terminal, VS Code) can chat and work,
    // but can't change how you sign in, list or sign out devices, make pairing codes or let in
    // other apps: those need you in the web app.
    if (deviceTokenOf(req) && DEVICE_TOKEN_DENIED.has(a) && !(a === 'device' && (b === 'logout' || b === 'whoami'))) {
      throw new HttpError(403, 'Apps signed in with a device code can\'t change sign-in settings or devices. Use the web app (Settings → Devices and sign-in).');
    }
    // Hardening M4: Home Assistant's token only talks with her in the conversations it made.
    {
      const devId = deviceTokenOf(req);
      if (devId && auth.deviceKind(devId) === 'home-assistant') return homeAssistantApi(req, res, method, parts, devId);
    }
    // Phase 69: the camera is off on the demo server (video calls show her picture only).
    if (opts.demo && a === 'video') {
      if (method !== 'GET') {
        await readRaw(req, FRAME_MAX_BYTES + 1).catch(() => undefined);
        throw new HttpError(403, 'The camera is off on the demo server.');
      }
      return send(res, 200, { camera: cameraState({ demo: true, privateLocal: privateLocalOn(), now: Date.now(), target: { kind: 'none' } }), settings: videoSettings(), session: null });
    }
    if (opts.demo && method !== 'GET' && !DEMO_WRITES.has(a) && !(a === 'tasks' && parts[2] && DEMO_CARD_ACTIONS.has(parts[2]))) throw new HttpError(403, 'Not available in the demo.');
    if (opts.demo && method === 'GET' && !DEMO_READS.has(a)) throw new HttpError(403, 'Not available in the demo.');

    // Cross-site request guard (in addition to SameSite=Strict cookies).
    if (method !== 'GET' && !isSameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused.');

    // Demo (app review): the reviewer code unlocks live calls for this demo session.
    if (a === 'demo' && b === 'call-code' && method === 'POST' && opts.demo) {
      const body = await readJson(req);
      if (!demoCalls.enabled) throw new HttpError(403, 'Live calls are off in the demo.');
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      // Hardening L3: a daily cap on wrong codes from all addresses together.
      if (demoCalls.lockedToday) throw new HttpError(429, 'Too many wrong reviewer codes today. Try again tomorrow.');
      if (!demoCalls.unlock(visitorKey(req), body.code)) {
        limiter.fail(ip);
        throw new HttpError(403, 'That reviewer code is not right.');
      }
      return send(res, 200, { ok: true, demo: demoCalls.view(visitorKey(req)) });
    }

    if (a === 'disclosure' && b === 'accept' && method === 'POST') {
      if (opts.demo) {
        demoAccepted.add(visitorKey(req));
        return send(res, 200, { ok: true });
      }
      app.settings.update({ disclosureAcceptedAt: app.now().toISOString() });
      return send(res, 200, { ok: true });
    }

    // Models: providers, model jobs, subscriptions, local models, private local mode, usage: src/routes/models.ts.
    if ((await modelsRoutes(req, res, method, parts)) !== NEXT) return;
    // Admin: settings, backups, logs, doctor, status, health history, updates, access, desktop apps, safety stats, search, tools, MCP, checklist: src/routes/admin.ts.
    if ((await adminRoutes(req, res, method, parts)) !== NEXT) return;

    // Coding: workspaces, approvals, jobs, starters, GitHub, code projects, code map, recipes, team, previews, SSH: src/routes/coding.ts.
    if ((await codingRoutes(req, res, method, parts)) !== NEXT) return;
    // Phase 84: the eval loop (owner-only; src/routes/evals.ts).
    if ((await evalRoutes(req, res, method, parts)) !== NEXT) return;
    // Phase 96: skills (Settings → Abilities → Skills; each person's own; src/routes/skills.ts).
    if ((await skillRoutes(req, res, method, parts)) !== NEXT) return;
    // Phase 98: plugins (Settings → Abilities → Plugins; the owner's only; src/routes/plugins.ts).
    if ((await pluginRoutes(req, res, method, parts)) !== NEXT) return;
    // Phase 100: other agents (A2A; Settings → Connections → Other agents; the owner's only; src/routes/agents.ts).
    if ((await agentRoutes(req, res, method, parts)) !== NEXT) return;
    if ((await hookRoutes(req, res, method, parts)) !== NEXT) return;
    // Phase 87: computer use: the computers, the live view, step thumbnails (src/routes/hands.ts).
    if ((await handsRoutes(req, res, method, parts)) !== NEXT) return;

    // Connections: Google, Home Assistant, chat bridges, Alexa, other apps, reports, the event stream: src/routes/connections.ts.
    if ((await connectionsRoutes(req, res, method, parts)) !== NEXT) return;

    // Her: persona, character files and cards, look, avatar, together, gallery, adult mode, companions, phone widgets: src/routes/her.ts.
    if ((await herRoutes(req, res, method, parts)) !== NEXT) return;

    // Voice: voice settings and notes, calls (ringing), video frames, push notifications, live-call status: src/routes/voice.ts.
    if ((await voiceRoutes(req, res, method, parts)) !== NEXT) return;

    // Planner: tasks, projects, places, reminders, notes, Today, briefing, review, leave-by, story: src/routes/planner.ts.
    // Phase 99 (ST4): boards, columns and card actions (before the planner's task routes): src/routes/board.ts.
    if ((await boardRoutes(req, res, method, parts)) !== NEXT) return;
    if ((await plannerRoutes(req, res, method, parts)) !== NEXT) return;

    // Document library, chat-history imports and data export/import: src/routes/library.ts.
    if ((await libraryRoutes(req, res, method, parts)) !== NEXT) return;

    // Memory: memories, scrapbook, moments, photos, uploads, find: src/routes/memory.ts.
    if ((await memoryRoutes(req, res, method, parts)) !== NEXT) return;
    if ((await peopleRoutes(req, res, method, parts)) !== NEXT) return;
    // Phase 16: Adult mode. Off by default; on only from a web browser with the 18+ confirmation.
    if (a === 'pair' && !b && method === 'POST') {
      // A new code replaces any earlier one.
      const code = newPairCode();
      pairing = { hash: createHash('sha256').update(normalizePairCode(code)).digest(), expires: opts.pairs ? opts.pairs.issue(spaceId, code) : Date.now() + PAIR_MS };
      const origin = typeof req.headers.origin === 'string' && req.headers.origin !== 'null' ? req.headers.origin : `http://${req.headers.host}`;
      const url = `${origin}/pair#${code}`;
      return send(res, 200, { code, url, expiresAt: new Date(pairing.expires).toISOString(), qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(url)).toString('base64')}` });
    }
    if (a === 'pair' && !b && method === 'DELETE') {
      pairing = undefined;
      opts.pairs?.clear(spaceId);
      return send(res, 200, { ok: true });
    }
    /**
     * Security review: changing how you sign in needs proof it's really you, not only a session
     * cookie (which could have been taken from an unlocked device): the owner token, or the
     * current code when two-step sign-in is on.
     */
    const confirmIdentity = (body: Record<string, unknown>, opt: { passkey?: boolean } = {}) => {
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      let ok = false;
      // A passkey assertion made just now for this purpose (where the route allows one).
      const pk = body.passkey as Record<string, unknown> | undefined;
      if (opt.passkey && pk && typeof pk === 'object') {
        const id = String(pk.id ?? '');
        const key = auth.passkey(id);
        try {
          if (!key) throw new Error('unknown passkey');
          const count = verifyAssertion(
            { id, clientDataJSON: String(pk.clientDataJSON ?? ''), authenticatorData: String(pk.authenticatorData ?? ''), signature: String(pk.signature ?? '') },
            key,
            { challenge: takeChallenge(clientChallenge(pk.clientDataJSON), 'confirm'), ...passkeySite(req) },
          );
          auth.usedPasskey(id, count);
          ok = true;
        } catch {
          ok = false;
        }
      } else ok = auth.twoStepOn ? auth.checkTwoStep(String(body.code ?? '')) : auth.verifyToken(String(body.token ?? ''));
      if (!ok) {
        limiter.fail(ip);
        throw new HttpError(403, auth.twoStepOn ? 'Enter the current code from your authenticator app to confirm.' : opts.member ? en('Enter your member token to confirm.') : 'Enter your owner token to confirm.', { confirm: auth.twoStepOn ? 'code' : 'token' });
      }
    };
    // ---------- Phase 71: household mode (docs/HOUSEHOLD.md) ----------
    if (a === 'household') {
      if (opts.demo) throw new HttpError(403, 'Not available in the demo.');
      const herr = (err: unknown): never => {
        if (err instanceof HouseholdError) throw new HttpError(err.status, err.message, err.message.includes('{n}') ? { params: { n: 20 } } : undefined);
        throw err;
      };
      // A member's own account (memberRouteCheck already limited this space to household/me…).
      if (opts.member) {
        const rec = opts.member.record();
        if (!rec || b !== 'me') throw new HttpError(404, 'Not found');
        if (!c && method === 'GET') {
          const models = app.settings.get().providers;
          return send(res, 200, {
            name: rec.name,
            status: rec.status,
            createdAt: rec.createdAt,
            deleteAfter: rec.deleteAfter ?? null,
            limits: { ...rec.limits, models: rec.limits.models.map((m) => ({ ...m, label: models.find((p) => p.id === m.providerId)?.label ?? m.providerId })) },
            today: app.member?.today() ?? { messages: 0, usd: 0 },
            companions: opts.member.apps().length,
          });
        }
        if (c === 'export' && !parts[3] && method === 'GET') {
          const file = {
            format: 'sara-member-export',
            version: 1,
            exportedAt: app.now().toISOString(),
            companions: opts.member.apps().map((x) => ({ id: x.companionId ?? 'main', name: x.persona.name, persona: x.persona, data: exportAll(x) })),
          };
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="sara-my-data-${app.now().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
          return void res.end(JSON.stringify(file, null, 2));
        }
        if (c === 'delete' && !parts[3] && method === 'POST') {
          // Deleting everything needs proof it's really them (their member token, two-step code or a passkey).
          confirmIdentity(await readJson(req), { passkey: true });
          res.setHeader('set-cookie', cookie('', 0));
          send(res, 200, { ok: true });
          await opts.member.deleteSelf().catch((err: Error) => console.warn(`household: deleting an account failed: ${err.message}`));
          return;
        }
        throw new HttpError(404, 'Not found');
      }
      const H = opts.household;
      if (!H) throw new HttpError(404, 'Not found');
      const memberView = (m: MemberRecord) => ({ id: m.id, name: m.name, status: m.status, createdAt: m.createdAt, deleteAfter: m.deleteAfter ?? null, limits: m.limits, usage: H.usage(m.id) });
      const view = () => ({
        members: H.store.members().map(memberView),
        invites: H.store.invites(),
        models: H.models(),
        options: { hours: INVITE_HOURS, messages: MESSAGE_LIMITS, cost: COST_LIMITS, leavingDays: LEAVING_DAYS },
      });
      if (!b && method === 'GET') return send(res, 200, view());
      if (b === 'invites' && !c && method === 'POST') {
        const body = await readJson(req);
        try {
          const limits = cleanMemberLimits(body.limits, H.models());
          const { code, invite } = H.store.invite({ name: body.name, hours: body.hours, confirm18: body.confirm18, limits });
          const origin = typeof req.headers.origin === 'string' && req.headers.origin !== 'null' ? req.headers.origin : `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
          const url = `${origin}/#join=${code}`;
          return send(res, 200, { code, url, invite, qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(url)).toString('base64')}`, ...view() });
        } catch (err) {
          return herr(err);
        }
      }
      if (b === 'invites' && c && !parts[3] && method === 'DELETE') {
        if (!H.store.revokeInvite(c)) throw new HttpError(404, 'That invite is gone.');
        return send(res, 200, view());
      }
      if (b === 'members' && c) {
        const d = parts[3];
        const cur = H.store.get(c);
        if (!cur) throw new HttpError(404, 'No such member.');
        try {
          if (!d && method === 'PUT') {
            const body = await readJson(req);
            if (body.limits !== undefined) H.store.setLimits(c, cleanMemberLimits(body.limits, H.models(), cur.limits));
            if (body.name !== undefined) H.store.rename(c, body.name);
            return send(res, 200, view());
          }
          if ((d === 'suspend' || d === 'resume') && !parts[4] && method === 'POST') {
            await readJson(req);
            H.store.setStatus(c, d === 'suspend' ? 'suspended' : 'active');
            return send(res, 200, view());
          }
          if (d === 'remove' && !parts[4] && method === 'POST') {
            await readJson(req);
            H.store.markLeaving(c);
            return send(res, 200, view());
          }
          if (!d && method === 'DELETE') {
            if (cur.status !== 'leaving') throw new HttpError(409, 'Remove them first (they get a few days to download their data).');
            await H.deleteNow(c);
            return send(res, 200, view());
          }
        } catch (err) {
          return herr(err);
        }
      }
      throw new HttpError(404, 'Not found');
    }

    // Phase 24: passkeys and two-step sign-in (Settings → Devices and sign-in).
    if (a === 'security' && !b && method === 'GET') return send(res, 200, { passkeys: auth.passkeys(), twoStep: auth.twoStepOn });
    // Security review: a passkey can confirm it's you (approving an app's device code).
    if (a === 'passkey' && b === 'confirm-options' && method === 'POST') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const site = passkeySite(req);
      await readJson(req);
      if (!auth.passkeys().length) throw new HttpError(404, 'No passkeys yet.');
      return send(res, 200, { challenge: issueChallenge('confirm'), rpId: site.rpId, userVerification: 'required', timeout: 120_000 });
    }
    if (a === 'passkey' && b === 'register-options' && method === 'POST') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const site = passkeySite(req);
      confirmIdentity(await readJson(req));
      const owner = app.settings.get().ownerName?.trim() || 'Owner';
      return send(res, 200, {
        challenge: issueChallenge('register'),
        rp: { id: site.rpId, name: `${app.persona.name} (Sara)` },
        // One owner per server: a fixed user handle, so a new passkey replaces an old one on the same device.
        user: { id: Buffer.from(`sara-owner:${site.rpId}`).toString('base64url'), name: owner, displayName: owner },
        pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: 'public-key', alg })),
        excludeCredentials: auth.passkeys().map((p) => ({ type: 'public-key', id: p.id })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout: 120_000,
      });
    }
    if (a === 'passkey' && b === 'register' && method === 'POST') {
      const site = passkeySite(req);
      const body = await readJson(req);
      try {
        const k = verifyRegistration({ clientDataJSON: String(body.clientDataJSON ?? ''), attestationObject: String(body.attestationObject ?? '') }, { challenge: takeChallenge(clientChallenge(body.clientDataJSON), 'register'), ...site });
        auth.addPasskey({ ...k, label: String(body.label ?? '').trim() || deviceLabel(req.headers['user-agent']) });
      } catch (err) {
        throw as400(err);
      }
      return send(res, 200, { passkeys: auth.passkeys(), twoStep: auth.twoStepOn });
    }
    if (a === 'passkey' && b === 'remove' && !c && method === 'POST') {
      const body = await readJson(req);
      confirmIdentity(body);
      if (!auth.removePasskey(String(body.id ?? ''))) throw new HttpError(404, 'No such passkey');
      return send(res, 200, { passkeys: auth.passkeys(), twoStep: auth.twoStepOn });
    }
    if (a === 'two-step') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const body = method === 'POST' ? await readJson(req) : {};
      if (b === 'start' && method === 'POST') {
        confirmIdentity(body);
        try {
          const t = auth.startTwoStep(app.settings.get().ownerName?.trim() || 'owner');
          return send(res, 200, { secret: t.secret, url: t.url, qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(t.url)).toString('base64')}` });
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      }
      if (b === 'confirm' && method === 'POST') {
        if (auth.twoStepOn) throw new HttpError(409, 'Two-step sign-in is already on.');
        if (!auth.checkTwoStep(String(body.code ?? ''))) throw new HttpError(400, "That code doesn't match. Check the time on your phone and use the newest code.");
        // Devices that signed in with the token alone are signed out; this one stays.
        const me = auth.sessionId(cookies(req)[SESSION_COOKIE]);
        const signedOut = auth.signOut('others', me);
        prunePush();
        return send(res, 200, { twoStep: true, signedOut });
      }
      if (b === 'stop' && method === 'POST') {
        try {
          auth.stopTwoStep(String(body.code ?? ''));
        } catch (err) {
          throw as400(err);
        }
        return send(res, 200, { twoStep: false });
      }
    }
    // Phase 52: device-code requests waiting for the owner (Settings → Devices, or /device with the typed code).
    if (a === 'device') {
      if (b === 'logout' && method === 'POST') {
        const id = deviceTokenOf(req);
        if (!id) throw new HttpError(400, 'Only an app signed in with a device code can sign itself out here.');
        auth.signOut(id);
        prunePush();
        return send(res, 200, { ok: true });
      }
      if (b === 'whoami' && method === 'GET') {
        const id = deviceTokenOf(req);
        const d = id ? auth.devices().find((x) => x.id === id) : undefined;
        return send(res, 200, { companion: app.persona.name, device: d ? { id: d.id, label: d.label, scope: d.kind === 'home-assistant' ? 'home-assistant' : 'full' } : null, disclosureAccepted: Boolean(app.settings.get().disclosureAcceptedAt), disclosure: disclosureText(app.persona.name, appLanguage(app.settings.get())) });
      }
      // Approving needs the owner in a browser (or the owner token): an app can't let in another app.
      if (deviceTokenOf(req)) throw new HttpError(403, 'Approve new apps in the web app (Settings → Devices and sign-in).');
      if (b === 'pending' && method === 'GET') {
        const code = new URL(req.url ?? '/', 'http://x').searchParams.get('code');
        if (code) {
          const p = deviceFlow.find(code);
          if (!p) throw new HttpError(404, 'That code is wrong, was already used, or has expired. Start the sign-in again in the app.');
          return send(res, 200, { request: p });
        }
        // Phase 71: a member types the code their app shows; the server's waiting list is the owner's.
        return send(res, 200, { pending: opts.member ? [] : deviceFlow.pending() });
      }
      if ((b === 'approve' || b === 'deny') && method === 'POST') {
        const body = await readJson(req);
        const code = String(body.code ?? '');
        if (b === 'deny') {
          if (!deviceFlow.deny(code)) throw new HttpError(404, 'That request is no longer waiting.');
          app.events?.publish({ type: 'device', pending: deviceFlow.pending().length });
          return send(res, 200, { ok: true });
        }
        // Security review: a session cookie alone isn't enough to let in an app that keeps a token
        // for weeks: confirm with the owner token, the current two-step code, or a passkey.
        if (!deviceFlow.find(code)) throw new HttpError(404, 'That code is wrong, was already used, or has expired. Start the sign-in again in the app.');
        confirmIdentity(body.confirmation && typeof body.confirmation === 'object' ? body.confirmation as Record<string, unknown> : body, { passkey: true });
        const r = deviceFlow.approve(code, (name, scope) => {
          if (scope === 'hands') {
            if (opts.member || !app.hands) throw new HttpError(403, 'Only the owner can pair Linux hands on this server.');
            return auth.createHandsToken(`Sara's hands on ${name}`);
          }
          return auth.createDeviceToken(name, scope === 'home-assistant' ? 'home-assistant' : undefined);
        });
        if (!r) throw new HttpError(404, 'That request is no longer waiting (it may have expired).');
        app.events?.publish({ type: 'device', pending: deviceFlow.pending().length });
        return send(res, 200, { ok: true, name: r.name });
      }
    }
    // Phase 57: an API key for another app (shown once). Like letting in an app: prove it's you.
    if (a === 'devices' && b === 'api-key' && !c && method === 'POST') {
      const body = await readJson(req);
      confirmIdentity(body, { passkey: true });
      const label = String(body.label ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || DEFAULT_APP_NAME;
      try {
        const k = auth.createApiKey(label);
        return send(res, 200, { key: k.token, id: k.id, label });
      } catch (err) {
        throw as400(err);
      }
    }
    // Phase 87: Sara's hands on this computer (docs/design/COMPUTER_USE.md §3.2). The desktop app's
    // signed-in page asks for the token after the owner switched on "Let Sara use this computer";
    // like letting in an app, it needs proof it's really you. The token goes to the app's native
    // part (DPAPI / Keychain) and is never shown. Members only with the owner's switch on.
    if (a === 'hands' && (b === 'pair' || b === 'renew') && !c && method === 'POST') {
      if (opts.demo || !app.hands) throw new HttpError(404, 'Not found');
      if (opts.member && !app.hands.allowed()) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      const body = await readJson(req);
      if (b === 'renew') {
        const r = auth.renewHandsToken(String(body.token ?? ''));
        if (!r) throw new HttpError(401, 'That computer is no longer signed in: switch "Let Sara use this computer" off and on again.');
        return send(res, 200, r);
      }
      confirmIdentity(body, { passkey: true });
      const computer = String(body.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'this computer';
      try {
        const r = auth.createHandsToken(`Sara's hands on ${computer}`);
        app.hands.forgetMissing();
        return send(res, 200, { ...r, label: `Sara's hands on ${computer}` });
      } catch (err) {
        throw as400(err);
      }
    }
    if (a === 'devices') {
      const current = auth.sessionId(cookies(req)[SESSION_COOKIE]);
      if (!b && method === 'GET') return send(res, 200, { devices: auth.devices().map((d) => ({ ...d, current: d.id === current })) });
      if (b === 'others' && method === 'DELETE') {
        const n = auth.signOut('others', current);
        app.hands?.forgetMissing();
        prunePush();
        return send(res, 200, { signedOut: n });
      }
      if (b && method === 'DELETE') {
        const n = auth.signOut(b);
        app.hands?.forgetMissing();
        prunePush();
        if (b === current) res.setHeader('set-cookie', cookie('', 0));
        return send(res, 200, { signedOut: n });
      }
    }
    if (a === 'owner-token' && b === 'rotate' && method === 'POST') {
      // A new owner token: every device is signed out; this one gets a fresh session.
      const body = await readJson(req);
      const ip = clientIp(req, opts.trustProxy);
      if (limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
      let token: string;
      try {
        token = auth.rotateToken(String(body.current ?? ''), { clearPasskeys: body.keepPasskeys !== true });
      } catch (err) {
        limiter.fail(ip);
        throw as400(err);
      }
      const session = auth.createSession(deviceLabel(req.headers['user-agent']));
      prunePush();
      res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
      return send(res, 200, { token });
    }
    if (a === 'setup') {
      // First-run guide: is setup needed, and what can be found on this machine without typing.
      if (!b && method === 'GET') {
        const s = app.settings.get();
        // Phase 71: a member's models are set up by the owner: no first-run guide.
        if (opts.member) return send(res, 200, { done: true, ownerName: s.ownerName ?? '', ollama: [], subscriptions: { grok: false, claude: false, chatgpt: false } });
        const done = Boolean(s.setupDone) || (s.providers.length > 0 && Boolean(s.ownerName));
        const ollama: { url: string; models: number }[] = [];
        if (!done || /[?&]detect\b/.test(req.url ?? '')) {
          const hosts = ['127.0.0.1', 'host.docker.internal'];
          await Promise.all(
            hosts.map(async (h) => {
              try {
                const r = await netFetch(`http://${h}:11434/api/tags`, { signal: AbortSignal.timeout(1500) });
                if (!r.ok) return;
                const j = (await r.json()) as { models?: { name: string }[] };
                ollama.push({ url: `http://${h}:11434/v1`, models: (j.models ?? []).filter((m) => !/embed/i.test(m.name)).length });
              } catch {
                /* not there */
              }
            }),
          );
        }
        const subs = app.subscriptions;
        return send(res, 200, {
          done,
          ownerName: s.ownerName ?? '',
          ollama: ollama.slice(0, 1),
          subscriptions: { grok: subs?.grokStatus().signedIn ?? false, claude: subs?.claudeStatus().signedIn ?? false, chatgpt: Boolean(subs?.chatgpt.status().signedIn) },
        });
      }
      if (b === 'done' && method === 'POST') {
        app.settings.update({ setupDone: true });
        return send(res, 200, { done: true });
      }
    }
    if (a === 'tags' && !b && method === 'GET') return send(res, 200, { tags: app.store.allTags() });
    // Phase 66: group chats (two to four companions in one conversation).
    if (a === 'groups') {
      const cm = opts.companions;
      if (!cm || opts.demo) throw new HttpError(403, 'Not available in the demo.');
      if (!b && method === 'GET') return send(res, 200, { rooms: rooms().list().map(roomView), styles: TURN_STYLES });
      if (!b && method === 'POST') {
        const body = await readJson(req);
        const ids = Array.isArray(body.members) ? [...new Set(body.members.map((x) => String(x)))] : [];
        if (ids.length < MIN_MEMBERS || ids.length > MAX_MEMBERS) throw new HttpError(400, 'Pick 2 to 4 companions.');
        if (ids.some((id) => !cm.get(id))) throw new HttpError(400, 'No such companion.');
        const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Group chat';
        const turnStyle: TurnStyle = (TURN_STYLES as readonly string[]).includes(String(body.turnStyle)) ? (String(body.turnStyle) as TurnStyle) : 'fits';
        const room = rooms().create({ title, members: ids, turnStyle, banter: clampBanter(body.banter), private: body.private === true }, app.now());
        const copies = ids.map((id) => cm.get(id)!.app.store.createConversation({ title, channel: GROUP_CHANNEL, channelKey: room.id, private: room.private }));
        const mine = ids.indexOf(app.companionId ?? 'main');
        // Made from a companion who isn't in it: the app switches to the first member.
        return send(res, 201, { room: roomView(room), conversationId: copies[Math.max(0, mine)].id, companion: mine >= 0 ? null : ids[0] });
      }
      if (b && !c && method === 'PATCH') {
        const room = rooms().get(b);
        if (!room) throw new HttpError(404, 'This group chat is gone.');
        const body = await readJson(req);
        const title = body.title !== undefined ? String(body.title).replace(/\s+/g, ' ').trim().slice(0, 80) || room.title : undefined;
        const turnStyle = body.turnStyle !== undefined && (TURN_STYLES as readonly string[]).includes(String(body.turnStyle)) ? (String(body.turnStyle) as TurnStyle) : undefined;
        const updated = rooms().update(b, { ...(title ? { title } : {}), ...(turnStyle ? { turnStyle } : {}), ...(body.banter !== undefined ? { banter: clampBanter(body.banter) } : {}) })!;
        if (title) for (const id of room.members) {
          const a = companionApp(id);
          const copy = a?.store.findChannelConversation(GROUP_CHANNEL, room.id);
          if (a && copy) a.store.updateConversation(copy.id, { title });
        }
        return send(res, 200, { room: roomView(updated) });
      }
    }
    if (a === 'conversations') {
      if (!b && method === 'GET') {
        const mine = (id: string) => !opts.demo || demoOwner.get(id) === visitorKey(req);
        const off = offStore.listConversations().filter((c) => mine(c.id)).map((c) => ({ ...c, offRecord: true, working: active.has(c.id) }));
        return send(res, 200, opts.demo ? off : [...off, ...app.store.listConversations().map((c) => ({ ...c, working: active.has(c.id) || (isGroupChannel(c.channel) && rooms().isBusy(String(c.channelKey))), ...groupInfo(c) }))]);
      }
      if (!b && method === 'POST') {
        const body = await readJson(req);
        if (body.offRecord || opts.demo) {
          const conv = offStore.createConversation({ title: opts.demo ? 'New conversation' : 'Off the record' });
          if (opts.demo) demoOwner.set(conv.id, visitorKey(req));
          return send(res, 201, { ...conv, offRecord: true });
        }
        const project = body.projectId !== undefined && body.projectId !== null ? projectOrThrow(body.projectId) : null;
        return send(
          res,
          201,
          app.store.createConversation({
            providerId: body.providerId ? String(body.providerId) : null,
            model: body.model ? String(body.model) : null,
            projectId: project?.id ?? null,
            // A project's workspace is the default for its new conversations.
            ...(body.workspace !== undefined ? { workspace: validWorkspace(body.workspace) } : project?.workspace ? { workspace: project.workspace } : {}),
            ...(body.mode !== undefined ? { mode: validMode(body.mode) } : {}),
            ...(body.private !== undefined ? { private: Boolean(body.private) } : {}),
          }),
        );
      }
      if (b) {
        const cx = ctxOf(b);
        const offRecord = cx !== app;
        // Demo visitors only ever see their own conversations.
        if (opts.demo && (!offRecord || demoOwner.get(b) !== visitorKey(req))) throw new HttpError(404, 'Conversation not found');
        const conv = cx.store.getConversation(b);
        if (!conv) throw new HttpError(404, 'Conversation not found');
        const view = (m: StoredMessage) => ({
          ...m,
          content: m.role === 'notice' ? m.content.replace(/^\w+:/, '') : m.role === 'tool' ? clip(app.redactor.redact(m.content), 4000) : m.content,
          ...(m.meta ? { meta: app.redactor.redactValue(m.meta) } : {}),
          kind: m.role === 'notice' ? m.content.split(':')[0] : undefined,
        });
        const pageOpts = () => {
          const sp = new URL(req.url ?? '/', 'http://x').searchParams;
          const limit = sp.has('limit') ? Math.min(1000, Math.max(20, Number(sp.get('limit')) || 150)) : undefined;
          const before = sp.has('before') ? Number(sp.get('before')) || undefined : undefined;
          return { limit, before };
        };
        // Phase 22: pins (shown above the conversation, wherever they are in it).
        const pins = () => cx.store.pinnedMessages(b).map((m) => ({ id: m.id, role: m.role, snippet: m.content.replace(/\s+/g, ' ').slice(0, 160), createdAt: m.createdAt }));
        // Phase 37: what you're doing together in this conversation.
        if (c === 'together' && cx.together) {
          if (method === 'GET') return send(res, 200, { activity: cx.together.activity(b) ?? null });
          if (method === 'POST') {
            const body = await readJson(req);
            if (conv.partner) throw new HttpError(400, 'Not in chats with other people.');
            try {
              cx.together.start(b, String(body.kind ?? ''), typeof body.topic === 'string' ? body.topic : undefined);
            } catch (err) {
              throw as400(err);
            }
            return send(res, 200, { activity: cx.together.activity(b) });
          }
          if (method === 'DELETE') {
            cx.together.end(b);
            return send(res, 200, { activity: null });
          }
        }
        if (!c && method === 'GET') {
          // Phase 22: ?limit=N sends only the latest N messages (long conversations load fast);
          // without it, everything (phone apps and older clients).
          const { limit } = pageOpts();
          const page = limit ? cx.store.messagesPage(b, { limit }) : { messages: cx.store.messages(b), earlier: 0 };
          return send(res, 200, { ...conv, ...(offRecord ? { offRecord: true } : {}), ...groupInfo(conv), messages: page.messages.map(view), earlier: page.earlier, pinned: pins(), activity: activityView(b), together: cx.together?.activity(b) ?? null });
        }
        if (c === 'messages' && !parts[3] && method === 'GET') {
          const { limit, before } = pageOpts();
          const page = cx.store.messagesPage(b, { limit: limit ?? 150, ...(before ? { before } : {}) });
          return send(res, 200, { messages: page.messages.map(view), earlier: page.earlier });
        }
        if (c === 'messages' && parts[3] && !parts[4] && method === 'PATCH') {
          const body = await readJson(req);
          const m = cx.store.messageById(Number(parts[3]));
          if (!m || m.conversationId !== b) throw new HttpError(404, 'Message not found');
          if (body.pinned !== undefined) {
            if (m.role !== 'user' && m.role !== 'assistant') throw new HttpError(400, 'Only messages from you or her can be pinned.');
            if (body.pinned === true && cx.store.pinnedMessages(b).length >= 50) throw new HttpError(400, 'Up to 50 pinned messages per conversation.');
            cx.store.updateMessageMeta(m.id, { pinned: body.pinned === true });
          }
          return send(res, 200, { pinned: pins() });
        }
        if (!c && method === 'PATCH') {
          const body = await readJson(req);
          // Phase 66: renaming a group chat renames the room and every member's copy.
          const grp = roomOf(conv);
          if (grp && body.title !== undefined && String(body.title).trim()) {
            const title = String(body.title).replace(/\s+/g, ' ').trim().slice(0, 80);
            rooms().update(grp.room.id, { title });
            for (const m of grp.members) if (m.convId !== b) m.app.store.updateConversation(m.convId, { title });
          }
          return send(
            res,
            200,
            cx.store.updateConversation(b, {
              ...(body.title !== undefined ? { title: String(body.title).slice(0, 120) } : {}),
              // Demo visitors keep the model the demo was set up with.
              ...(body.providerId !== undefined && !opts.demo ? { providerId: body.providerId ? String(body.providerId) : null } : {}),
              ...(body.model !== undefined && !opts.demo ? { model: body.model ? String(body.model) : null } : {}),
              ...(body.workspace !== undefined ? { workspace: validWorkspace(body.workspace) } : {}),
              ...(body.mode !== undefined ? { mode: validMode(body.mode) } : {}),
              ...(body.private !== undefined ? { private: Boolean(body.private) } : {}),
              ...(body.projectId !== undefined ? { projectId: body.projectId === null ? null : projectOrThrow(body.projectId).id } : {}),
              ...(body.archived !== undefined ? { archived: Boolean(body.archived) } : {}),
              ...(body.tags !== undefined ? { tags: tagsOrThrow(body.tags) } : {}),
            }),
          );
        }
        if (!c && method === 'DELETE') {
          active.get(b)?.controller.abort();
          // Phase 66: deleting a group chat deletes it for every companion in it (and what each learned there, if asked).
          const grp = roomOf(conv);
          if (grp) {
            const forget = new URL(req.url ?? '/', 'http://x').searchParams.get('forget') === '1';
            let forgotten = 0;
            for (const m of grp.members) {
              if (forget && m.app.memory) forgotten += m.app.memory.deleteForConversation(m.convId);
              m.app.store.deleteConversation(m.convId);
              m.app.events?.publish({ type: 'memory', conversationId: m.convId });
            }
            rooms().remove(grp.room.id);
            return send(res, 200, { ok: true, forgotten });
          }
          // What she learned from it stays unless the owner asks her to forget it too.
          const forgotten = new URL(req.url ?? '/', 'http://x').searchParams.get('forget') === '1' && cx.memory ? cx.memory.deleteForConversation(b) : 0;
          cx.store.deleteConversation(b);
          // Documents read once in it go too (kept ones stay in her library).
          cx.library?.deleteForConversation(b);
          app.uploads?.prune(app.store.imagesInUse());
          app.events?.publish({ type: 'memory', conversationId: b });
          return send(res, 200, { ok: true, forgotten });
        }
        if (c === 'memories' && method === 'GET') return send(res, 200, { count: cx.memory?.countForConversation(b) ?? 0 });
        // Phase 52: tokens and estimated cost of this conversation (the line under the chat).
        if (c === 'usage' && method === 'GET') {
          const u = cx.usage?.forConversation(b);
          return send(res, 200, u ? { ...u, line: usageLine(u) } : { calls: 0, line: '' });
        }
        if (c === 'remember' && method === 'POST') {
          if (!cx.memory) throw new HttpError(404, 'Memory is not available');
          if (active.has(b)) throw new HttpError(409, me('Sara is still working in this conversation.'), { errorKey: 'Sara is still working in this conversation.' });
          const r = await summarizeConversation(cx, cx.memory, b);
          if (r.error) throw new HttpError(502, 'Couldn\'t write the summary: {error}', { params: { error: r.error } });
          return send(res, 200, r);
        }
        if (c === 'stop' && method === 'POST') {
          const t = active.get(b);
          t?.controller.abort();
          // Phase 66: Stop in a group chat ends the whole round, from any member's copy.
          const roundStopped = isGroupChannel(conv.channel) && rooms().stop(String(conv.channelKey));
          return send(res, 200, { stopped: Boolean(t) || roundStopped });
        }
        if (c === 'messages' && method === 'POST' && isGroupChannel(conv.channel)) {
          requireDisclosure(req);
          const body = await readJson(req);
          if ((Array.isArray(body.images) && body.images.length) || (Array.isArray(body.docs) && body.docs.length)) throw new HttpError(400, 'Photos and documents can’t be sent in group chats yet.');
          if (body.background === true) throw new HttpError(400, 'Group chats answer in the app only for now.');
          const content = String(body.content ?? '').trim();
          if (!content) throw new HttpError(400, 'Message is empty');
          if (content.length > 100_000) throw new HttpError(413, 'Message too long');
          return streamGroup(res, conv, content);
        }
        if ((c === 'retry' || c === 'continue') && method === 'POST' && isGroupChannel(conv.channel)) throw new HttpError(400, 'Regenerate, edit and continue aren’t available in group chats yet.');
        if (c === 'messages' && method === 'POST') {
          requireDisclosure(req);
          // Photos are refused off the record and in the demo, so those never need the big limit.
          const body = await readJson(req, offRecord || opts.demo ? MAX_BODY : PHOTO_BODY);
          if (offRecord && Array.isArray(body.images) && body.images.length) throw new HttpError(400, "Photos can't be sent off the record (they would be saved).");
          const images = savePhotos(body.images);
          // Phase 44: documents uploaded to her library (or for this chat) just before sending.
          const docs = Array.isArray(body.docs)
            ? body.docs.slice(0, 10).flatMap((v) => {
                const d = app.library?.get(Number(v));
                return d && (d.keep || d.conversationId === b) ? [{ id: d.id, name: d.name, keep: d.keep }] : [];
              })
            : [];
          const content = String(body.content ?? '').trim() || (images.length ? '(photo)' : docs.length ? '(document)' : '');
          if (!content) throw new HttpError(400, 'Message is empty');
          if (content.length > 100_000) throw new HttpError(413, 'Message too long');
          demoTurnAllowed(req);
          // Phase 69: a classic video call: the newest camera picture goes with this message (in memory
          // only, never saved), unless the camera was paused by a safety block meanwhile.
          const blockedAt = cx.store.lastSafetyEventAt('minor_sexual_block', b)?.getTime();
          const frameBuf = body.liveFrame === true && !(blockedAt !== undefined && app.now().getTime() - blockedAt < SAFETY_PAUSE_MS) ? videos.take(b, app.now().getTime()) : undefined;
          const liveFrame = frameBuf ? { liveFrame: { image: { mime: 'image/jpeg', data: frameBuf.toString('base64') }, ask: body.liveFrameAsk === true } } : body.videoCall === true ? { videoCall: true } : {};
          // Phase 18: from a notification's Reply box or the share sheet, the phone doesn't wait.
          // The reply arrives like her other messages: as an event, so as a notification too.
          if (body.background === true) {
            if (active.has(b)) throw new HttpError(409, me('Sara is still working on this conversation. Wait for her or press Stop.'), { errorKey: 'Sara is still working on this conversation. Wait for her or press Stop.' });
            void runBackground(b, content, { ...(images.length ? { images } : {}), ...(docs.length ? { docs } : {}) });
            return send(res, 202, { ok: true });
          }
          return streamChat(req, res, b, content, { ...(images.length ? { images } : {}), ...(docs.length ? { docs } : {}), ...liveFrame });
        }
        // Regenerate the last reply, or edit the last owner message and answer it again.
        if (c === 'retry' && method === 'POST') {
          requireDisclosure(req);
          if (active.has(b)) throw new HttpError(409, me('Sara is still working on this conversation. Wait for her or press Stop.'), { errorKey: 'Sara is still working on this conversation. Wait for her or press Stop.' });
          const body = await readJson(req);
          const lastUser = cx.store.messages(b).filter((m) => m.role === 'user').at(-1);
          if (!lastUser) throw new HttpError(400, 'There is no message to answer again.');
          const content = body.content !== undefined ? String(body.content) : lastUser.content;
          if (!content.trim()) throw new HttpError(400, 'Message is empty');
          if (content.length > 100_000) throw new HttpError(413, 'Message too long');
          // Photos stay with the message when it is regenerated or edited.
          const images = Array.isArray(lastUser.meta?.images) ? (lastUser.meta.images as string[]) : [];
          cx.store.deleteMessagesFrom(b, lastUser.id);
          return streamChat(req, res, b, content, images.length ? { images } : {});
        }
        // Continue a reply that was cut off (restart, error, stop) without a new message.
        if (c === 'continue' && method === 'POST') {
          requireDisclosure(req);
          const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
          const lastUser = cx.store.messages(b).filter((m) => m.role === 'user').at(-1);
          if (!lastUser) throw new HttpError(400, 'Nothing to continue.');
          // Phase 79: "Continue with N more" after a reply stopped at its budget: an explicit override
          // with exactly that amount, recorded on the reply that stopped and on the new run.
          if (body.budget !== undefined) {
            const more = cleanMore(body.budget);
            if (!more) throw new HttpError(400, 'Say how much more: tokens, steps, dollars or minutes.');
            if (active.has(b)) throw new HttpError(409, me('Sara is still working on this conversation. Wait for her or press Stop.'), { errorKey: 'Sara is still working on this conversation. Wait for her or press Stop.' });
            const stoppedAt = cx.store.messages(b).filter((m) => m.role === 'assistant' && m.id > lastUser.id).findLast((m) => (m.meta?.budget as { stage?: string } | undefined)?.stage === 'reached');
            if (!stoppedAt) throw new HttpError(400, 'The last reply didn\'t stop at its budget, so there is nothing to continue with more.');
            cx.store.updateMessageMeta(stoppedAt.id, { budget: { ...(stoppedAt.meta!.budget as object), continued: { more, at: app.now().toISOString() } } });
            return streamChat(req, res, b, lastUser.content, { resume: true, budgetMore: more });
          }
          return streamChat(req, res, b, lastUser.content, { resume: true });
        }
      }
    }

    throw new HttpError(404, 'Not found');
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    // Over https, browsers are told to keep using https for this site (a year).
    if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      // Phase 49: app previews, authorised by the token in the address only (never the session
      // cookie), from the raw request target (not normalised). See src/preview.ts.
      const rawTarget = req.url ?? '/';
      if (rawTarget === '/preview' || rawTarget.startsWith('/preview/') || rawTarget.startsWith('/preview?')) {
        if (!app.previews || opts.demo) throw new HttpError(404, 'Not found');
        return await app.previews.handle(req, res, rawTarget);
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      // Phase 57: other apps, with an API key: the OpenAI-compatible API and the MCP server.
      // Phase 71: a paused or leaving member's API keys stop working.
      if (opts.member && (url.pathname === '/v1' || url.pathname.startsWith('/v1/') || url.pathname === '/mcp' || url.pathname === '/mcp/') && opts.member.record()?.status !== 'active') throw new HttpError(403, 'This account is paused on this server.');
      if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
        return await handleOpenAI(req, res, url.pathname, { app, auth, ...(opts.companions ? { companions: opts.companions } : {}), demo: Boolean(opts.demo), limiter: appLimiter });
      }
      // Phase 72: Alexa (signed by Amazon; checked in src/alexa.ts before anything is read).
      if (url.pathname === '/alexa' || url.pathname === '/alexa/') return await alexa.handle(req, res, { demo: Boolean(opts.demo) });
      // Phase 100 (STAPLES §8.2): A2A. The public card and /a2a/v1 exist only when the owner switched
      // "Let other agents reach her" on, never on the demo or in a household member's space.
      if (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/a2a/v1' || url.pathname.startsWith('/a2a/')) {
        if (app.a2a && !opts.member && !opts.demo && (await app.a2a.handle(req, res, url.pathname))) return;
        await readRaw(req, 64 * 1024).catch(() => undefined);
        throw new HttpError(404, 'Not found');
      }
      // Phase 102 (STAPLES §10.2): webhooks. The URL and the signature are the only keys: no cookie,
      // no session, no CSRF token ever counts here. Never on the demo or in a household member's space.
      if (url.pathname === '/hook' || url.pathname.startsWith('/hook/')) {
        const token = url.pathname.slice(6);
        if (app.hooks && !opts.member && !opts.demo && token && !token.includes('/')) return await app.hooks.receive(req, res, token, clientIp(req, opts.trustProxy));
        await readRaw(req, 256 * 1024).catch(() => undefined);
        return send(res, 404, { error: 'Not found' });
      }
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
        return await handleMcp(req, res, { app, auth, demo: Boolean(opts.demo), version: info.version, limiter: appLimiter, requestApproval });
      }
      if (url.pathname.startsWith('/api/')) {
        const parts = url.pathname.slice(5).split('/').filter(Boolean).map(safeDecode);
        await api(req, res, method, parts);
      } else if (method === 'GET' || method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    } catch (err) {
      // Phase 71: a member's attempt to change the owner's keys (src/household.ts memberVault) is a 403.
      const status = err instanceof HttpError ? err.status : err instanceof HouseholdError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? en('Internal error') : (err as Error).message, ...(err instanceof HttpError ? err.extra : err instanceof HouseholdError ? { ownerOnly: true } : {}) });
      else res.end();
    }
  });

  // Keep idle connections longer than Node's 5 s default: apps (SillyTavern, the API, MCP clients,
  // a reverse proxy) reuse a connection between messages, and a reuse racing the server's close
  // fails with "connection reset". 65 s is longer than common proxies' own idle limit.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Live voice calls: /api/live/<conversation id> upgrades to a WebSocket (src/routes/live.ts).
  // Phase 87: /api/hands is the hands channel (src/routes/hands.ts); everything else is a live call.
  const liveUpgrade = createLiveUpgrade(ctx);
  const handsUpgrade = createHandsUpgrade(ctx);
  server.on('upgrade', (req, socket, head) => ((req.url ?? '').split('?')[0] === '/api/hands' ? handsUpgrade : liveUpgrade)(req, socket, head));
  return server;
}
