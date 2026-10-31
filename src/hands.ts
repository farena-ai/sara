// Phase 87 (computer use, CU1; docs/design/COMPUTER_USE.md §2–§3): Sara's hands on your computer.
// The brain stays here; the hands live in the paired desktop app (or the reference hands in
// src/hands-ref.ts). A hands device opens its own WebSocket to /api/hands with a `hands` token and
// then only runs small typed operations ("ops") the server asks for, enforcing its own limits
// whatever the server says. This file is the server side of that channel: the connected devices,
// requests with deadlines and cancel, the pictures that come back, the live-view frames (memory
// only, never stored), events for the chat, one computer task per device at a time, and the
// per-task budget of computer actions.
//
// Protocol version 1 (text frames are JSON; binary frames carry pictures):
//   device → server  {t:'hello', v:1, app, os, screens, browser, perms, optIn, approvalsHere, logins, busy, localOnly, ops}
//   server → device  {t:'req', id, op, args, runId, deadlineMs}
//   device → server  {t:'res', id, ok:true, result} | {t:'res', id, ok:false, error:{code, message}}
//   server → device  {t:'cancel', id} | {t:'cancel', all:true}
//   device → server  {t:'ev', kind, ...}   (stopped by:'user' ends the task at once)
//   device → server  binary: 4-byte big-endian header length, JSON header {id | frame, kind, mime, w, h, viewId}, bytes
// Phase 88 (CU2) adds, all optional for older devices:
//   server → device  req.what: one plain line for the device's "Sara is working" badge
//   device → server  hello.takeover 'pause' | 'keep', hello.hotkey, hello.paused, hello.renew
//   device → server  {t:'ev', kind:'takeover' | 'resumed'}  (the person took over / pressed Resume there)
//   device → server  {t:'renew'}  →  server → device {t:'token', token, expiresAt}  (a fresh hands token)
// Phase 89 (CU3) adds the dev tunnel (src/tunnel.ts): req c.tunnel / c.untunnel, {t:'s', ev, sid}
// stream control both ways, and binary stream frames both ways (header {s: sid}, then bytes).
import { randomUUID } from 'node:crypto';
import type { EventHub } from './events.ts';
import { Tunnels } from './tunnel.ts';
import type { WsConnection } from './ws.ts';

export const HANDS_PROTOCOL = 1;
/** CU1's command set: look, read, navigate, pictures and logs. */
export const CU1_OPS = ['b.start', 'b.tabs', 'b.open', 'b.navigate', 'b.snapshot', 'b.read', 'b.screenshot', 'b.logs', 'b.request', 'b.close', 'c.ping'] as const;
/** Phase 88 (CU2): acting in the Sara browser (b.find only says what a target is, for the approval card). */
export const CU2_OPS = ['b.find', 'b.click', 'b.type', 'b.select', 'b.keys', 'b.scroll', 'b.upload', 'b.downloads'] as const;
/** Phase 89 (CU3): the dev tunnel (a loopback listener on the computer, streams over this connection). */
export const CU3_OPS = ['c.tunnel', 'c.untunnel'] as const;
/** The whole command set of a CU3 device. Still nothing on the desktop (d.*), no logins (b.login), no scripts. */
export const HANDS_OPS = [...CU1_OPS, ...CU2_OPS, ...CU3_OPS] as const;
/** Ops only the server itself sends (never from the owner's "try one op" route): the tunnel checks port ownership first. */
export const SERVER_ONLY_OPS: ReadonlySet<string> = new Set(CU3_OPS);
export type HandsOp = (typeof HANDS_OPS)[number];
/** Ops that act (they count against the device's input rate limit and stop on takeover). */
export const ACTING_OPS: ReadonlySet<string> = new Set(['b.click', 'b.type', 'b.select', 'b.keys', 'b.scroll', 'b.upload']);
export const HANDS_ERROR_CODES = ['denied_local', 'blocked_window', 'takeover', 'stopped', 'stale_view', 'not_found', 'timeout', 'perm_missing', 'rate_limited', 'unsupported'] as const;
/** Default deadline of an op (b.open waits for a whole page). */
export const DEFAULT_DEADLINE_MS = 30_000;
export const OPEN_DEADLINE_MS = 60_000;
/** Live-view frames kept per device (memory only). */
const FRAMES_KEPT = 4;
/** §7.3/§6.4: a computer task's budget (actions and minutes) before she summarizes and stops. */
export const COMPUTER_BUDGET = { steps: 60, minutes: 15 };

export class HandsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HandsError';
    this.code = code;
  }
}

export interface HandsHello {
  v: number;
  app: string;
  os?: string;
  /** The computer's name as the device reports it ("Alex's laptop"). */
  computer?: string;
  screens?: { id: string; w: number; h: number; scale: number; primary: boolean }[];
  browser?: { found: boolean; kind?: string; name?: string };
  perms?: { capture?: boolean; input?: boolean; ax?: boolean };
  optIn: { browser: boolean; desktop: boolean };
  approvalsHere?: boolean;
  logins?: string[];
  busy?: boolean;
  /** "Screenshots only to models on this computer" (§7.6): pictures never go to a cloud model. */
  localOnly?: boolean;
  /** The ops this device runs (its own allowlist). */
  ops?: string[];
  /** Phase 88: "When you move the mouse" on that computer: pause Sara (default) or let her keep control. */
  takeover?: 'pause' | 'keep';
  /** Phase 88: the stop shortcut there ("Ctrl+Alt+Esc"), for the page to show. */
  hotkey?: string;
  /** Phase 88: paused there because the person took over. */
  paused?: boolean;
  /** Phase 88: the device can take a fresh token over this connection. */
  renew?: boolean;
}

export interface HandsImage {
  kind: string;
  mime: string;
  data: Buffer;
  w?: number;
  h?: number;
  viewId?: string;
}

export interface HandsReply {
  result: Record<string, unknown>;
  images: HandsImage[];
}

export interface HandsFrame {
  n: number;
  at: string;
  mime: string;
  data: Buffer;
  w?: number;
  h?: number;
}

export interface HandsDeviceView {
  id: string;
  label: string;
  connected: boolean;
  app?: string;
  os?: string;
  computer?: string;
  browser?: HandsHello['browser'];
  optIn?: HandsHello['optIn'];
  localOnly?: boolean;
  ops?: string[];
  connectedAt?: string;
  lastSeen?: string;
  /** A conversation is using this computer right now. */
  busy: boolean;
  frames: number;
  takeover?: 'pause' | 'keep';
  hotkey?: string;
  paused?: boolean;
}

interface Pending {
  id: string;
  deviceId: string;
  op: string;
  images: HandsImage[];
  promise: Promise<HandsReply>;
  resolve: (r: HandsReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  off: () => void;
}

interface Device {
  id: string;
  label: string;
  ws?: WsConnection;
  hello?: HandsHello;
  connectedAt?: string;
  lastSeen?: string;
  frames: HandsFrame[];
  frameN: number;
  lease?: { conversationId: string; until: number };
  heartbeat?: NodeJS.Timeout;
  helloWaiters: (() => void)[];
  /** Phase 88: makes a fresh token for this device (set by the upgrade route). */
  renew?: () => { token: string; expiresAt: string } | undefined;
  lastRenew?: number;
}

/** Splits a binary frame into its JSON header and the picture bytes (undefined when malformed). */
export function parseBinary(buf: Buffer): { header: Record<string, unknown>; data: Buffer } | undefined {
  if (buf.length < 4) return undefined;
  const n = buf.readUInt32BE(0);
  if (n <= 0 || n > 4096 || buf.length < 4 + n) return undefined;
  try {
    const header = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')) as Record<string, unknown>;
    return header && typeof header === 'object' ? { header, data: Buffer.from(buf.subarray(4 + n)) } : undefined;
  } catch {
    return undefined;
  }
}

/** Builds a binary frame (used by the reference hands and tests). */
export function packBinary(header: Record<string, unknown>, data: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, data]);
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const plain = (s: unknown, n = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

/** The server's side of every hands device of one person (one hub per space). */
export class HandsHub {
  readonly #devices = new Map<string, Device>();
  readonly #pending = new Map<string, Pending>();
  readonly #frameWaiters = new Set<() => void>();
  /** Where the chat hears about live frames, stops and devices coming and going. */
  events?: EventHub;
  /** Computer use may run in this space (the owner: always; a member: the owner's switch). */
  allowed: () => boolean;
  /** The hands devices signed in here (from the device list), connected or not. */
  known: () => { id: string; label: string; lastSeen?: string }[];
  heartbeatMs = 20_000;
  leaseMs = 2 * 60_000;
  budget = { ...COMPUTER_BUDGET };
  readonly #tasks = new Map<string, { steps: number; startedAt: number }>();
  /** Phase 89: the dev tunnels to this person's computers (src/tunnel.ts). */
  readonly tunnels: Tunnels;

  constructor(opts: { events?: EventHub; allowed?: () => boolean; known?: () => { id: string; label: string; lastSeen?: string }[]; tunnels?: ConstructorParameters<typeof Tunnels>[1] } = {}) {
    if (opts.events) this.events = opts.events;
    this.allowed = opts.allowed ?? (() => true);
    this.known = opts.known ?? (() => []);
    this.tunnels = new Tunnels(
      {
        connected: (id) => this.connected(id),
        ops: (id) => this.hello(id)?.ops,
        request: (id, op, args, o) => this.request(id, op, args, o),
        send: (id, data) => {
          const ws = this.#devices.get(id)?.ws;
          if (!ws?.open) return false;
          ws.send(data);
          return true;
        },
        buffered: (id) => this.#devices.get(id)?.ws?.buffered ?? 0,
        publish: (ev) => this.#publish(ev),
      },
      opts.tunnels,
    );
  }

  #device(id: string, label = ''): Device {
    let d = this.#devices.get(id);
    if (!d) {
      d = { id, label, frames: [], frameN: 0, helloWaiters: [] };
      this.#devices.set(id, d);
    }
    if (label) d.label = label;
    return d;
  }

  #publish(ev: Record<string, unknown>): void {
    this.events?.publish({ type: 'computer', deviceId: String(ev.deviceId ?? ''), ...ev } as import('./events.ts').HubEvent);
  }

  /** A device connected (a second connection for the same device replaces the first). */
  attach(id: string, label: string, ws: WsConnection, opts: { renew?: () => { token: string; expiresAt: string } | undefined } = {}): void {
    const d = this.#device(id, label);
    if (opts.renew) d.renew = opts.renew;
    const old = d.ws;
    if (old && old !== ws) {
      this.#dropConnection(d, 'replaced by a new connection');
      try {
        old.close(4000, 'replaced');
      } catch {
        /* gone */
      }
    }
    d.ws = ws;
    d.hello = undefined;
    d.connectedAt = new Date().toISOString();
    d.lastSeen = d.connectedAt;
    ws.onMessage = (data) => {
      if (d.ws !== ws) return;
      d.lastSeen = new Date().toISOString();
      if (typeof data === 'string') this.#text(d, data);
      else this.#binary(d, data);
    };
    ws.onClose = () => {
      if (d.ws !== ws) return;
      this.#dropConnection(d, 'The computer disconnected.');
      d.ws = undefined;
      this.#publish({ deviceId: id, state: 'offline' });
    };
    clearInterval(d.heartbeat);
    d.heartbeat = setInterval(() => {
      if (d.ws !== ws || !ws.open) return clearInterval(d.heartbeat);
      // No answer for three heartbeats: the connection is dead (the device reconnects by itself).
      if (ws.lastSeen !== undefined && Date.now() - ws.lastSeen > this.heartbeatMs * 3) return ws.close(4001, 'no heartbeat');
      ws.ping?.();
    }, this.heartbeatMs);
    d.heartbeat.unref?.();
  }

  #dropConnection(d: Device, why: string): void {
    clearInterval(d.heartbeat);
    // Phase 89: the dev tunnels there end with the connection (the device closes its listeners too).
    this.tunnels.closeDevice(d.id, 'the computer disconnected', false);
    for (const p of [...this.#pending.values()]) if (p.deviceId === d.id) this.#settle(p, new HandsError('offline', why));
  }

  #text(d: Device, raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      const optIn = (m.optIn ?? {}) as Record<string, unknown>;
      d.hello = {
        v: Number(m.v) || 0,
        app: plain(m.app, 80),
        ...(m.os ? { os: plain(m.os, 80) } : {}),
        ...(m.computer ? { computer: plain(m.computer, 80) } : {}),
        ...(Array.isArray(m.screens) ? { screens: (m.screens as HandsHello['screens'])!.slice(0, 8) } : {}),
        ...(m.browser && typeof m.browser === 'object' ? { browser: { found: Boolean((m.browser as Record<string, unknown>).found), ...((m.browser as Record<string, unknown>).kind ? { kind: plain((m.browser as Record<string, unknown>).kind, 20) } : {}), ...((m.browser as Record<string, unknown>).name ? { name: plain((m.browser as Record<string, unknown>).name, 60) } : {}) } } : {}),
        ...(m.perms && typeof m.perms === 'object' ? { perms: m.perms as HandsHello['perms'] } : {}),
        optIn: { browser: optIn.browser === true, desktop: optIn.desktop === true },
        approvalsHere: m.approvalsHere === true,
        logins: Array.isArray(m.logins) ? (m.logins as unknown[]).slice(0, 50).map((x) => plain(x, 60)) : [],
        busy: m.busy === true,
        localOnly: m.localOnly === true,
        ...(Array.isArray(m.ops) ? { ops: (m.ops as unknown[]).slice(0, 80).map((x) => plain(x, 40)) } : {}),
        ...(m.takeover === 'keep' || m.takeover === 'pause' ? { takeover: m.takeover } : {}),
        ...(m.hotkey ? { hotkey: plain(m.hotkey, 30) } : {}),
        paused: m.paused === true,
        renew: m.renew === true,
      };
      for (const w of d.helloWaiters.splice(0)) w();
      this.#publish({ deviceId: d.id, state: 'online' });
      return;
    }
    if (m.t === 'res') {
      const p = this.#pending.get(String(m.id ?? ''));
      if (!p || p.deviceId !== d.id) return;
      if (m.ok === true) this.#settle(p, undefined, { result: (m.result && typeof m.result === 'object' ? m.result : {}) as Record<string, unknown>, images: p.images });
      else {
        const e = (m.error ?? {}) as Record<string, unknown>;
        this.#settle(p, new HandsError(plain(e.code, 40) || 'error', plain(e.message, 600) || 'The computer refused that.'));
      }
      return;
    }
    if (m.t === 's') {
      // Phase 89: a dev tunnel stream's control message.
      this.tunnels.text(d.id, m);
      return;
    }
    if (m.t === 'renew') {
      // Phase 88: the app renews its own token before the 90 days end (at most once per 10 minutes).
      const now = Date.now();
      if (!d.renew || (d.lastRenew && now - d.lastRenew < 10 * 60_000)) return;
      d.lastRenew = now;
      const r = d.renew();
      if (r) d.ws?.send(JSON.stringify({ t: 'token', token: r.token, expiresAt: r.expiresAt }));
      return;
    }
    if (m.t === 'ev') {
      const kind = plain(m.kind, 30);
      if ((kind === 'takeover' || kind === 'resumed') && d.hello) {
        // Phase 88: the person moved the mouse or typed in the Sara browser (or pressed Resume there).
        d.hello.paused = kind === 'takeover';
        this.#publish({ deviceId: d.id, paused: d.hello.paused, ...(d.lease ? { conversationId: d.lease.conversationId } : {}) });
        return;
      }
      if (kind === 'stopped') {
        // Stop on the computer (its button, tray or hotkey) ends the task at once.
        for (const p of [...this.#pending.values()]) if (p.deviceId === d.id) this.#settle(p, new HandsError('stopped', 'Stopped on the computer.'));
        const conv = d.lease?.conversationId;
        d.lease = undefined;
        // Stop ends her dev tunnels on that computer too.
        this.tunnels.closeDevice(d.id, 'stopped on the computer');
        this.#publish({ deviceId: d.id, stopped: true, by: m.by === 'user' ? 'user' : 'device', ...(conv ? { conversationId: conv } : {}) });
        if (conv && m.by === 'user') for (const fn of this.#stopListeners) fn(conv, d.id);
        return;
      }
      if (kind === 'optin' && d.hello) {
        const o = (m.optIn ?? {}) as Record<string, unknown>;
        d.hello.optIn = { browser: o.browser === true, desktop: o.desktop === true };
        if (typeof m.localOnly === 'boolean') d.hello.localOnly = m.localOnly;
        if (m.takeover === 'keep' || m.takeover === 'pause') d.hello.takeover = m.takeover;
      }
      this.#publish({ deviceId: d.id, ev: kind, ...(d.lease ? { conversationId: d.lease.conversationId } : {}) });
    }
  }

  readonly #stopListeners = new Set<(conversationId: string, deviceId: string) => void>();
  /** Each companion's server: a Stop pressed on the computer stops that conversation's running turn. */
  onStop(fn: (conversationId: string, deviceId: string) => void): () => void {
    this.#stopListeners.add(fn);
    return () => this.#stopListeners.delete(fn);
  }

  /** After sign-outs: computers no longer signed in lose their connection at once. */
  forgetMissing(): void {
    const ids = new Set(this.known().map((k) => k.id));
    for (const id of [...this.#devices.keys()]) if (!ids.has(id)) this.disconnect(id);
  }

  #binary(d: Device, buf: Buffer): void {
    const b = parseBinary(buf);
    if (!b) return;
    // Phase 89: bytes of a dev tunnel stream (from the Sara browser on that computer).
    if (b.header.s !== undefined) return this.tunnels.data(d.id, Number(b.header.s), b.data);
    const mime = String(b.header.mime ?? '');
    if (!IMAGE_MIMES.has(mime) || b.data.length > 8 * 1024 * 1024) return;
    const w = Number(b.header.w) || undefined;
    const h = Number(b.header.h) || undefined;
    if (b.header.frame !== undefined) {
      const f: HandsFrame = { n: ++d.frameN, at: new Date().toISOString(), mime, data: b.data, ...(w ? { w } : {}), ...(h ? { h } : {}) };
      d.frames.push(f);
      if (d.frames.length > FRAMES_KEPT) d.frames.splice(0, d.frames.length - FRAMES_KEPT);
      for (const fn of [...this.#frameWaiters]) fn();
      this.#publish({ deviceId: d.id, frame: f.n, ...(d.lease ? { conversationId: d.lease.conversationId } : {}) });
      return;
    }
    const p = this.#pending.get(String(b.header.id ?? ''));
    if (!p || p.deviceId !== d.id || p.images.length >= 4) return;
    p.images.push({ kind: plain(b.header.kind, 20) || 'shot', mime, data: b.data, ...(w ? { w } : {}), ...(h ? { h } : {}), ...(b.header.viewId ? { viewId: plain(b.header.viewId, 40) } : {}) });
  }

  #settle(p: Pending, err?: Error, ok?: HandsReply): void {
    if (!this.#pending.has(p.id)) return;
    this.#pending.delete(p.id);
    clearTimeout(p.timer);
    p.off();
    if (err) p.reject(err);
    else p.resolve(ok!);
  }

  /** Waits (a little) for a just-connected device's hello. */
  async #ready(d: Device, ms = 5000): Promise<void> {
    if (d.hello || !d.ws) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      d.helloWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /**
   * Asks a device to run one op. Resolves with its result (and any pictures that came with it);
   * rejects with a HandsError (the device's own code, or offline / timeout / stopped).
   */
  async request(deviceId: string, op: string, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal; deadlineMs?: number; runId?: number; id?: string; what?: string } = {}): Promise<HandsReply> {
    const d = this.#devices.get(deviceId);
    if (!d?.ws?.open) throw new HandsError('offline', 'That computer is not connected right now (the Sara app is closed, asleep or offline).');
    await this.#ready(d);
    if (!d.hello) throw new HandsError('offline', "That computer didn't say hello: update the Sara app there.");
    if (op.startsWith('b.') && !d.hello.optIn.browser) throw new HandsError('denied_local', '"Let Sara use this computer" is off on that computer.');
    // Phase 88: paused there because the person took over: nothing acts until they press Resume there.
    if (d.hello.paused && ACTING_OPS.has(op)) throw new HandsError('takeover', 'Paused: the owner took over the Sara browser on that computer. Wait until they press Resume there.');
    if (opts.signal?.aborted) throw new HandsError('stopped', 'Stopped.');
    // A retried request with the same id gets the first answer (the device answers it once).
    if (opts.id && this.#pending.has(opts.id)) return this.#pending.get(opts.id)!.promise;
    const id = opts.id ?? randomUUID();
    const deadlineMs = Math.max(1000, Math.min(opts.deadlineMs ?? (op === 'b.open' ? OPEN_DEADLINE_MS : DEFAULT_DEADLINE_MS), 120_000));
    let resolve!: (r: HandsReply) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<HandsReply>((a, b) => {
      resolve = a;
      reject = b;
    });
    const onAbort = () => {
      this.#cancel(d, id);
      this.#settle(p, new HandsError('stopped', 'Stopped.'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const p: Pending = {
      id,
      deviceId,
      op,
      images: [],
      promise,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.#cancel(d, id);
        this.#settle(p, new HandsError('timeout', `The computer didn't finish ${op} within ${Math.round(deadlineMs / 1000)} seconds.`));
      }, deadlineMs + 2000),
      off: () => opts.signal?.removeEventListener('abort', onAbort),
    };
    this.#pending.set(id, p);
    const what = opts.what ? plain(opts.what, 120) : '';
    d.ws.send(JSON.stringify({ t: 'req', id, op, args, ...(opts.runId ? { runId: opts.runId } : {}), deadlineMs, ...(what ? { what } : {}) }));
    // Phase 88: the chat's "Sara is working" badge (what she is doing, on which computer).
    if (op !== 'c.ping') this.#publish({ deviceId, working: true, op, ...(what ? { what } : {}), ...(d.lease ? { conversationId: d.lease.conversationId } : {}) });
    return promise;
  }

  #cancel(d: Device, id?: string): void {
    try {
      d.ws?.send(JSON.stringify(id ? { t: 'cancel', id } : { t: 'cancel', all: true }));
    } catch {
      /* closed */
    }
  }

  /** Stop: everything running on that computer is cancelled (the turn's Stop, a budget, the web Stop). */
  cancelAll(deviceId: string): number {
    const d = this.#devices.get(deviceId);
    if (!d) return 0;
    this.#cancel(d);
    let n = 0;
    for (const p of [...this.#pending.values()]) {
      if (p.deviceId !== deviceId) continue;
      this.#settle(p, new HandsError('stopped', 'Stopped.'));
      n++;
    }
    d.lease = undefined;
    // Stop ends her dev tunnels on that computer too.
    this.tunnels.closeDevice(deviceId, 'stopped');
    return n;
  }

  /** Signing a device out (Devices, or a revoked token): its connection closes now. */
  disconnect(deviceId: string): void {
    const d = this.#devices.get(deviceId);
    if (!d) return;
    this.#dropConnection(d, 'This computer was signed out.');
    try {
      d.ws?.close(4003, 'signed out');
    } catch {
      /* gone */
    }
    d.ws = undefined;
    this.#devices.delete(deviceId);
  }

  connected(deviceId: string): boolean {
    return Boolean(this.#devices.get(deviceId)?.ws?.open);
  }

  hello(deviceId: string): HandsHello | undefined {
    return this.#devices.get(deviceId)?.hello;
  }

  /** Every hands device of this space: signed in (Devices) and/or connected now. */
  devices(): HandsDeviceView[] {
    const now = Date.now();
    const out = new Map<string, HandsDeviceView>();
    for (const k of this.known()) out.set(k.id, { id: k.id, label: k.label, connected: false, busy: false, frames: 0, ...(k.lastSeen ? { lastSeen: k.lastSeen } : {}) });
    for (const d of this.#devices.values()) {
      const h = d.hello;
      const prev = out.get(d.id);
      if (!prev && !d.ws) continue;
      out.set(d.id, {
        id: d.id,
        label: prev?.label || d.label,
        connected: Boolean(d.ws?.open),
        ...(h ? { app: h.app, ...(h.os ? { os: h.os } : {}), ...(h.computer ? { computer: h.computer } : {}), ...(h.browser ? { browser: h.browser } : {}), optIn: h.optIn, localOnly: h.localOnly === true, ...(h.ops ? { ops: h.ops } : {}) } : {}),
        ...(d.connectedAt ? { connectedAt: d.connectedAt } : {}),
        ...(d.lastSeen ? { lastSeen: d.lastSeen } : prev?.lastSeen ? { lastSeen: prev.lastSeen } : {}),
        busy: Boolean(d.lease && d.lease.until > now),
        frames: d.frameN,
        ...(h?.takeover ? { takeover: h.takeover } : {}),
        ...(h?.hotkey ? { hotkey: h.hotkey } : {}),
        ...(h?.paused ? { paused: true } : {}),
      });
    }
    return [...out.values()];
  }

  /** §7.7: one computer task per device. True when this conversation may use it now (and holds it). */
  claim(deviceId: string, conversationId: string): boolean {
    const d = this.#devices.get(deviceId);
    if (!d) return false;
    const now = Date.now();
    if (d.lease && d.lease.until > now && d.lease.conversationId !== conversationId) return false;
    d.lease = { conversationId, until: now + this.leaseMs };
    return true;
  }

  release(deviceId: string, conversationId: string): void {
    const d = this.#devices.get(deviceId);
    if (d?.lease?.conversationId === conversationId) d.lease = undefined;
  }

  /** The conversation using a computer now (for the live view), if any. */
  usedBy(deviceId: string): string | undefined {
    const d = this.#devices.get(deviceId);
    return d?.lease && d.lease.until > Date.now() ? d.lease.conversationId : undefined;
  }

  /** The newest live-view frame after `after` (memory only). */
  frame(deviceId: string, after = 0): HandsFrame | undefined {
    const f = this.#devices.get(deviceId)?.frames.at(-1);
    return f && f.n > after ? f : undefined;
  }

  /** Long-poll for a newer frame (resolves undefined after `ms`). */
  waitFrame(deviceId: string, after: number, ms: number, signal?: AbortSignal): Promise<HandsFrame | undefined> {
    const now = this.frame(deviceId, after);
    if (now || ms <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => {
        const f = this.frame(deviceId, after);
        if (!f) return;
        finish(f);
      };
      const finish = (f: HandsFrame | undefined) => {
        clearTimeout(t);
        this.#frameWaiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        resolve(f);
      };
      const onAbort = () => finish(undefined);
      const t = setTimeout(() => finish(undefined), ms);
      this.#frameWaiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * §6.4: one more computer action in a task (a turn: its conversation + the owner's message it
   * answers). Throws once the task used its actions or minutes: she summarizes and stops.
   */
  spend(task: string): { steps: number; minutes: number } {
    const now = Date.now();
    for (const [k, v] of this.#tasks) if (now - v.startedAt > 6 * 3600_000) this.#tasks.delete(k);
    let t = this.#tasks.get(task);
    if (!t) {
      t = { steps: 0, startedAt: now };
      this.#tasks.set(task, t);
    }
    const minutes = (now - t.startedAt) / 60_000;
    if (t.steps >= this.budget.steps || minutes >= this.budget.minutes) {
      throw new HandsError('budget', `This task has used its computer budget (${this.budget.steps} actions or ${this.budget.minutes} minutes). Stop using the computer now: summarize what you found for the owner, and say they can tell you to continue.`);
    }
    t.steps++;
    return { steps: t.steps, minutes };
  }

  /** Closes every connection (server shutdown). */
  closeAll(): void {
    this.tunnels.closeAll();
    for (const d of this.#devices.values()) {
      clearInterval(d.heartbeat);
      try {
        d.ws?.close(1001, 'server stopping');
      } catch {
        /* gone */
      }
    }
  }
}
