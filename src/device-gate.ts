// C15 (docs/ops/C15_DESIGN.md): the server side of "approve a new device from chat". One gate per
// server: the sign-in step (a remote sign-in waits for approval), "ask first" for sensitive actions
// from a remote device, the approval routes, the DNS rebinding host check, the new-address notice,
// and cutting a signed-out device's open connections. The rules live in src/device-approval.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './chat.ts';
import { deviceLabel, DEVICE_TOKEN_PREFIX, SESSION_COOKIE, type OwnerAuth } from './auth.ts';
import { ACTION_WORDS, chatPrompt, cleanHosts, deviceApprovalSettings, DeviceApprovals, fill, hostAllowed, isRemoteRequest, MAX_DEVICE_CHOICES, normCode, viaProxy, type ApprovalRequest, type SensitiveAction } from './device-approval.ts';
import { clientIp, cookies, HttpError, readJson, send } from './http.ts';
import { en, trOwner } from './i18n.ts';
import { identityOf } from './persona.ts';
import { policy } from './policy-profile.ts';
import { telegramSettings } from './bridges/telegram.ts';
import { discordSettings } from './bridges/discord.ts';

export interface DeviceGate {
  approvals: DeviceApprovals;
  /** False when the Host header fails the rebinding check (the server answers 421). */
  hostOk(req: IncomingMessage): boolean;
  /** Remembers a long-lived connection's device (event stream, call): a sign-out cuts it. Returns the untrack. */
  track(req: IncomingMessage, close: () => void): () => void;
  /** Finishes a checked sign-in: a session, or (remote, switch on) a session waiting for approval. */
  signIn(req: IncomingMessage, res: ServerResponse, cookie: (value: string, maxAge: number) => string): void;
  /** Throws 428 with a code when a remote device asks for a sensitive action the owner hasn't approved yet. */
  askFirst(req: IncomingMessage, action: SensitiveAction): void;
  /** May the owner token be used as a Bearer header here (always on this computer; elsewhere only with the switch off)? */
  ownerTokenOk(req: IncomingMessage): boolean;
  /** /api/session extras for a device that waits. */
  pendingOf(req: IncomingMessage): { code: string; expiresAt: string; state: ApprovalRequest['state'] } | undefined;
  /** Routes that answer before sign-in (the asking device's own status). */
  publicRoutes(req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<boolean>;
  /** Routes for a signed-in device (the prompt list, answers, the settings). */
  routes(req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<boolean>;
}

export function createDeviceGate(o: { app: AppContext; auth: OwnerAuth; demo: boolean; member: boolean; trustProxy?: boolean | { secret: string } }): DeviceGate {
  const { app, auth } = o;
  const approvals = (app.deviceApprovals ??= new DeviceApprovals(() => app.now()));
  const settings = () => deviceApprovalSettings(app.settings.get());
  // A policy pin keeps it on (src/policy-profile.ts deviceApproval).
  const on = () => !o.demo && !o.member && (settings().on || policy().pins.deviceApproval === true);
  const live = new Map<string, Set<() => void>>();
  const tr = (t: string, params?: Record<string, unknown>) => trOwner(t, app.settings.get(), params, identityOf(app.persona));

  /** Where it comes from, in words: the address, and "through a proxy or tunnel" when the address is the proxy's. */
  const where = (req: IncomingMessage) => {
    const ip = clientIp(req, o.trustProxy ?? false);
    const fwd = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return viaProxy(req) && !o.trustProxy && fwd ? `${fwd} (${en('says the tunnel or proxy')})` : ip;
  };
  const chatLinked = () => Boolean(telegramSettings(app).ownerChatId || discordSettings(app).ownerUserId);
  const sessionOf = (req: IncomingMessage): string | undefined => {
    const cookie = cookies(req)[SESSION_COOKIE];
    const id = auth.sessionId(cookie);
    if (id) return id;
    const h = req.headers.authorization;
    if (h?.startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`)) return auth.deviceTokenId(h.slice(7));
    if (h?.startsWith('Bearer ') && auth.verifyToken(h.slice(7))) return 'owner-token';
    return undefined;
  };

  async function tell(title: string, text: string, tag: string): Promise<void> {
    await app.push?.notifyOwner(title, text, '', tag).catch(() => undefined);
    await app.bridges?.telegram?.toOwner(text).catch(() => false);
    await app.bridges?.discord?.toOwner(text).catch(() => false);
  }
  const newAddress = (label: string, ip: string) => void tell(tr('New sign-in'), tr('{label} signed in from a new address: {ip}. If that was not you, sign it out under Settings → Devices and sign-in.', { label, ip }), 'device-new-address');

  approvals.listeners.add((r, what) => {
    const view = { code: undefined, kind: r.kind, action: r.action ?? null, label: r.label, ip: r.ip, expiresAt: r.expiresAt, state: r.state };
    app.events?.publish({ type: 'device-approval', what, request: view } as never);
    if (what === 'new') {
      void tell(tr('Approve a device?'), fill(chatPrompt(r), (t) => tr(t)), `device-approval-${r.code}`);
      return;
    }
    if (r.kind !== 'sign-in') return;
    if (r.state === 'approved') {
      const ip = auth.sessionInfo(r.sessionId)?.ip ?? r.ip;
      const isNew = !auth.knownIp(ip);
      if (auth.approveSession(r.sessionId, settings().maxDevices) && isNew) newAddress(r.label, r.ip);
    } else auth.signOut(r.sessionId);
  });
  setInterval(() => approvals.sweep(), 30_000).unref();

  auth.signedOut.add((ids) => {
    for (const id of ids) {
      for (const close of live.get(id) ?? []) close();
      live.delete(id);
    }
  });

  const cookieId = (req: IncomingMessage) => {
    const c = cookies(req)[SESSION_COOKIE];
    return auth.sessionId(c) ?? auth.pendingId(c);
  };

  return {
    approvals,
    hostOk: (req) => !on() || hostAllowed(req, settings().allowedHosts),
    ownerTokenOk: (req) => !on() || !isRemoteRequest(req),
    track(req, close) {
      const id = cookieId(req);
      if (!id) return () => undefined;
      let set = live.get(id);
      if (!set) live.set(id, (set = new Set()));
      set.add(close);
      return () => void set!.delete(close);
    },
    signIn(req, res, cookie) {
      const s = settings();
      const remote = isRemoteRequest(req);
      const ip = where(req);
      const label = deviceLabel(req.headers['user-agent']);
      // Waits only when someone can answer: a device already trusted, or the owner's linked chat.
      if (on() && remote && (auth.trustedCount() > 0 || chatLinked())) {
        const session = auth.createSession(label, { pending: true, ip, remote: true });
        res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
        const r = approvals.request('sign-in', { sessionId: session.id, label, ip });
        return void send(res, 202, { ok: false, pendingApproval: { code: r.code, expiresAt: r.expiresAt, state: r.state } });
      }
      const isNew = remote && !auth.knownIp(ip) && auth.trustedCount() > 0;
      const session = auth.createSession(label, { ip, remote, maxDevices: s.maxDevices });
      res.setHeader('set-cookie', cookie(session.value, session.maxAgeSeconds));
      if (isNew) newAddress(label, ip);
      send(res, 200, { ok: true });
    },
    askFirst(req, action) {
      if (!on() || !isRemoteRequest(req)) return;
      const sid = sessionOf(req);
      if (!sid) return;
      // Nobody else could answer (the only device, no linked chat): as before.
      if (auth.trustedCount() <= 1 && !chatLinked()) return;
      if (approvals.takeGrant(sid, action)) return;
      const r = approvals.request('action', { sessionId: sid, label: auth.sessionInfo(sid)?.label ?? en('An app'), ip: where(req), action });
      throw new HttpError(428, 'Approve this on a device you already use, or reply "approve" and this code to Sara in Telegram or Discord: {code}', { params: { code: r.code }, approval: { code: r.code, expiresAt: r.expiresAt, action, what: ACTION_WORDS[action], state: r.state } });
    },
    pendingOf(req) {
      const c = cookies(req)[SESSION_COOKIE];
      if (!c || auth.sessionId(c)) return undefined;
      approvals.sweep();
      const id = auth.cookieId(c);
      const r = id ? approvals.forSession(id, 'sign-in') : undefined;
      return r ? { code: r.code, expiresAt: r.expiresAt, state: r.state } : undefined;
    },
    async publicRoutes(req, res, method, parts) {
      const [a, b, c] = parts;
      if (a !== 'device-approvals' || !b || c !== 'status' || method !== 'GET') return false;
      const r = approvals.get(b);
      const me = cookieId(req) ?? sessionOf(req);
      if (!r || !me || r.sessionId !== me) throw new HttpError(404, 'No such request.');
      send(res, 200, { state: r.state, expiresAt: r.expiresAt, kind: r.kind, action: r.action ?? null });
      return true;
    },
    async routes(req, res, method, parts) {
      const [a, b, c] = parts;
      if (a === 'device-approvals') {
        if (!b && method === 'GET') {
          // The code is never listed: the owner reads it off the device that asks.
          send(res, 200, { requests: approvals.pending().map((r) => ({ kind: r.kind, action: r.action ?? null, what: r.action ? ACTION_WORDS[r.action] : null, label: r.label, ip: r.ip, createdAt: r.createdAt, expiresAt: r.expiresAt })), on: on() });
          return true;
        }
        if (b === 'deny-all' && !c && method === 'POST') {
          send(res, 200, { refused: approvals.denyAll({ channel: 'app', sessionId: sessionOf(req) }) });
          return true;
        }
        if (b && !c && method === 'POST') {
          const body = await readJson(req);
          const r = approvals.get(normCode(b));
          if (!r) throw new HttpError(404, 'No request has that code. Check the code on the device that asks.');
          const out = approvals.answer(r.code, body.approve === true, { sessionId: sessionOf(req) ?? 'unknown', channel: 'app' });
          if (out === 'self') throw new HttpError(403, 'Answer this on another device: the device that asks cannot approve itself.');
          if (out === 'expired') throw new HttpError(410, 'That code has expired (10 minutes). Sign in again on that device for a new one.');
          if (out === 'unknown') throw new HttpError(409, 'That request was already answered.');
          send(res, 200, { state: out });
          return true;
        }
      }
      if (a === 'device-approval' && !b) {
        const view = () => ({ ...settings(), choices: MAX_DEVICE_CHOICES, available: !o.demo && !o.member });
        if (method === 'GET') {
          send(res, 200, view());
          return true;
        }
        if (method === 'PUT') {
          if (o.demo || o.member) throw new HttpError(403, 'Only the owner can change this.');
          const body = await readJson(req);
          const cur = settings();
          policy().guard('deviceApproval', body.on === false);
          if (body.on === false && cur.on) this.askFirst(req, 'approval-off');
          const max = body.maxDevices === undefined ? cur.maxDevices : Number(body.maxDevices);
          if (!MAX_DEVICE_CHOICES.includes(max as 0)) throw new HttpError(400, 'Pick a number of devices from the list.');
          app.settings.update({ deviceApproval: { on: typeof body.on === 'boolean' ? body.on : cur.on, allowedHosts: body.allowedHosts === undefined ? cur.allowedHosts : cleanHosts(body.allowedHosts), maxDevices: max, notice: body.noticeSeen === true ? false : cur.notice } } as never);
          send(res, 200, view());
          return true;
        }
      }
      return false;
    },
  };
}
