// Phase 89 (computer use CU3, docs/design/COMPUTER_USE.md §4.4): the dev tunnel. Her browser on the
// owner's computer reaches the dev server one of her background jobs runs here, at a real
// http://127.0.0.1:<port> address there, so storage, service workers and hot-reload WebSockets work
// (a preview link can't: its origin is opaque).
//
// How it works: the server asks the hands device for `c.tunnel {tunnel, port}`; the device opens a
// listener on 127.0.0.1 only (the same port when it's free there, else a free one) and answers with
// that local port. Each connection the Sara browser makes to it becomes a stream multiplexed over
// the hands WebSocket:
//   device → server  {t:'s', ev:'open', tunnel, sid}           a new local connection
//   server → device  {t:'s', ev:'ok', sid} | {t:'s', ev:'close', sid, why}
//   both ways        binary: header {s: sid} + bytes            (≤ 64 KB a frame)
//   both ways        {t:'s', ev:'end', sid}                     no more bytes from this side
//   both ways        {t:'s', ev:'close', sid}                   the stream is gone
//   both ways        {t:'s', ev:'pause' | 'resume', sid}        flow control (the other side stops reading)
//   server → device  req c.untunnel {tunnel}                    the tunnel ends (listener and streams close)
//
// Rules (here; the device enforces its own: loopback only, ports ≥ 1024, at most 4 tunnels and 64
// streams each, everything closes with the connection, on Stop and on c.untunnel):
// - only a port that a process of one of her running jobs in that workspace listens on, checked with
//   the operating system like previews (src/preview.ts), re-checked every 30 s and before streams;
//   never the Sara server's own port; one built-in test page (the owner's "Try the dev tunnel");
// - streams open only for a tunnel this server made, on that device's own connection; the server
//   connects only to 127.0.0.1:<that port>, through src/net-guard.ts (checkOutbound);
// - it ends when the job ends, when the owner or Stop ends the task, when the device disconnects,
//   after 30 minutes without traffic, or after 12 hours; the owner can close it in Settings;
// - owner-only like the rest of computer use (a member only with the owner's switch, and members
//   have no coding jobs to tunnel to);
// - while open, other programs on the owner's computer could reach that loopback port too (the
//   same as any dev server there): documented in the help.
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { checkOutbound } from './net-guard.ts';
import { portsInOutput, type PreviewJobs } from './preview.ts';
import { treeListensOn } from './ports.ts';
import { acceptWebSocket } from './ws.ts';

export const TUNNEL_LIMITS = {
  /** Tunnels open at once per computer. */
  perDevice: 4,
  /** Connections at once through one tunnel. */
  streams: 64,
  /** Closed after this long without traffic. */
  idleMs: 30 * 60_000,
  /** Closed after this long whatever happens. */
  ttlMs: 12 * 60 * 60_000,
  /** The built-in test page lives this long. */
  testMs: 5 * 60_000,
  /** Bytes kept for a stream before its connection to the app is up. */
  preConnect: 1024 * 1024,
  /** Bytes per binary frame. */
  chunk: 64 * 1024,
  /** Above this much unsent on the hands connection, reading from the app pauses. */
  highWater: 4 * 1024 * 1024,
};
const RECHECK_MS = 30_000;

/**
 * Phase 89 (CU3): on a Windows server, Git Bash's fork/exec emulation can leave the dev server's
 * process with a parent that has already exited, so the process-tree check can't see that a script
 * runner's server (npm run dev, npx …) belongs to her job. Running the server program itself works.
 */
const WIN_HINT =
  process.platform === 'win32'
    ? ' On this Windows server, if the job is running and listening, start the server program itself instead of a script runner, for example "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort" instead of "npm run dev": then Sara can see it is hers.'
    : '';

export class TunnelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
  }
}

/** What the tunnels need from the hands hub (kept small: no import cycle). */
export interface TunnelLink {
  connected(deviceId: string): boolean;
  ops(deviceId: string): string[] | undefined;
  request(deviceId: string, op: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; deadlineMs?: number; what?: string }): Promise<{ result: Record<string, unknown> }>;
  send(deviceId: string, data: string | Buffer): boolean;
  buffered(deviceId: string): number;
  publish(ev: Record<string, unknown>): void;
}

export interface TunnelView {
  id: string;
  deviceId: string;
  conversationId: string;
  workspace: string;
  /** The port on the server (her job's). */
  port: number;
  /** The port on the owner's computer (http://127.0.0.1:<localPort>). */
  localPort: number;
  url: string;
  kind: 'job' | 'test';
  jobId: number;
  jobLabel: string;
  createdAt: string;
  lastUsed: string;
  streams: number;
  bytesIn: number;
  bytesOut: number;
}

interface Stream {
  sid: number;
  socket?: Socket;
  pending: Buffer[];
  pendingBytes: number;
  connected: boolean;
  /** The device said it sends no more. */
  endIn: boolean;
  /** The app said it sends no more. */
  endOut: boolean;
  /** The device asked us to stop sending (its side is full). */
  paused: boolean;
  /** Reading from the app is held while the hands connection is backed up. */
  held: boolean;
  /** We asked the device to pause until the app's socket drains. */
  draining: boolean;
}

interface Entry {
  id: string;
  deviceId: string;
  conversationId: string;
  workspace: string;
  port: number;
  localPort: number;
  kind: 'job' | 'test';
  jobId: number;
  jobLabel: string;
  jobs?: PreviewJobs;
  createdAt: number;
  lastUsed: number;
  checkedAt: number;
  expiresAt: number;
  streams: Map<number, Stream>;
  bytesIn: number;
  bytesOut: number;
  /** The built-in test page's own little server (kind 'test'). */
  test?: Server;
}

export interface TunnelOptions {
  now?: () => number;
  /** Does the process tree of `pid` listen on `port`? (Tests inject a stand-in.) */
  owns?: (pid: number, port: number) => Promise<boolean>;
  /** Ports Sara herself listens on (never tunnelled). */
  ownPorts?: () => number[];
}

/** The tunnels of one hands hub (one person's computers). */
export class Tunnels {
  readonly #link: TunnelLink;
  readonly #entries = new Map<string, Entry>();
  /** Streams per computer by the device's stream id (ids are the device's, unique per connection). */
  readonly #streams = new Map<string, Map<number, { e: Entry; s: Stream }>>();
  readonly #now: () => number;
  readonly #owns: (pid: number, port: number) => Promise<boolean>;
  #ownPorts: () => number[];
  #sweeper?: NodeJS.Timeout;

  constructor(link: TunnelLink, opts: TunnelOptions = {}) {
    this.#link = link;
    this.#now = opts.now ?? Date.now;
    this.#owns = opts.owns ?? ((pid, port) => treeListensOn(pid, port));
    this.#ownPorts = opts.ownPorts ?? (() => []);
  }

  /** The server's own ports (set once it listens). */
  setOwnPorts(fn: () => number[]): void {
    this.#ownPorts = fn;
  }

  #view(e: Entry): TunnelView {
    return {
      id: e.id,
      deviceId: e.deviceId,
      conversationId: e.conversationId,
      workspace: e.workspace,
      port: e.port,
      localPort: e.localPort,
      url: `http://127.0.0.1:${e.localPort}`,
      kind: e.kind,
      jobId: e.jobId,
      jobLabel: e.jobLabel,
      createdAt: new Date(e.createdAt).toISOString(),
      lastUsed: new Date(e.lastUsed).toISOString(),
      streams: e.streams.size,
      bytesIn: e.bytesIn,
      bytesOut: e.bytesOut,
    };
  }

  list(filter: { deviceId?: string; conversationId?: string } = {}): TunnelView[] {
    this.sweep();
    return [...this.#entries.values()].filter((e) => (!filter.deviceId || e.deviceId === filter.deviceId) && (!filter.conversationId || e.conversationId === filter.conversationId)).map((e) => this.#view(e));
  }

  get(id: string): TunnelView | undefined {
    const e = this.#entries.get(id);
    return e ? this.#view(e) : undefined;
  }

  /** The open tunnel on that computer whose local address is 127.0.0.1:`localPort`, if any. */
  byLocalPort(deviceId: string, localPort: number): TunnelView | undefined {
    const e = [...this.#entries.values()].find((x) => x.deviceId === deviceId && x.localPort === localPort);
    return e ? this.#view(e) : undefined;
  }

  /** Which of her running jobs in the workspace listens on `port` (the OS check), if any. */
  async #ownerJob(port: number, workspace: string, jobs: PreviewJobs): Promise<{ id: number; label: string } | undefined> {
    for (const job of jobs.running().filter((j) => j.workspace === workspace)) {
      const pid = jobs.pidOf(job.id);
      if (pid && (await this.#owns(pid, port).catch(() => false))) return { id: job.id, label: job.label.slice(0, 120) };
    }
    return undefined;
  }

  #checkDevice(deviceId: string): void {
    if (!this.#link.connected(deviceId)) throw new TunnelError('offline', 'That computer is not connected right now.');
    const ops = this.#link.ops(deviceId) ?? [];
    if (!ops.includes('c.tunnel')) throw new TunnelError('unsupported', "The Sara app on that computer can't open a dev tunnel yet: it needs updating (Sara 2.22 or later).");
    if (this.list({ deviceId }).length >= TUNNEL_LIMITS.perDevice) throw new TunnelError('limit', `Already ${TUNNEL_LIMITS.perDevice} dev tunnels open on that computer: close one first (or stop its job).`);
  }

  /**
   * Opens (or reuses) a tunnel from the owner's computer to a port one of her running jobs in
   * `workspace` listens on. Without a port, the newest port her jobs' output mentions is tried.
   */
  async open(spec: { deviceId: string; conversationId: string; workspace: string; port?: number; jobs: PreviewJobs | undefined; signal?: AbortSignal }): Promise<TunnelView> {
    if (!spec.jobs) throw new TunnelError('no_job', 'Background jobs are not available here.');
    const running = spec.jobs.running().filter((j) => j.workspace === spec.workspace);
    if (!running.length) throw new TunnelError('no_job', 'Nothing is running in this workspace. Start the dev server first with start_job (for example "npm run dev" or "npx vite --port 5173 --strictPort"), then open it.');
    let ports: number[];
    if (spec.port !== undefined) {
      if (!Number.isInteger(spec.port) || spec.port < 1024 || spec.port > 65535) throw new TunnelError('bad_port', 'Pick a port between 1024 and 65535.');
      ports = [spec.port];
    } else {
      ports = [...new Set(running.flatMap((j) => portsInOutput(j.tail)))];
      if (!ports.length) throw new TunnelError('no_port', "I couldn't find a port in your jobs' output yet. Wait for the dev server to say where it listens, or say the port.");
    }
    for (const port of ports) {
      if (this.#ownPorts().includes(port)) {
        if (spec.port !== undefined) throw new TunnelError('own_port', "That's Sara's own port: the dev tunnel is only for apps your jobs run.");
        continue;
      }
      const job = await this.#ownerJob(port, spec.workspace, spec.jobs);
      if (!job) continue;
      // One tunnel per computer, workspace and port: the same one is used again.
      const same = [...this.#entries.values()].find((e) => e.deviceId === spec.deviceId && e.workspace === spec.workspace && e.port === port && e.kind === 'job' && e.jobs === spec.jobs);
      if (same) {
        same.conversationId = spec.conversationId;
        same.lastUsed = this.#now();
        same.jobId = job.id;
        same.jobLabel = job.label;
        return this.#view(same);
      }
      this.#checkDevice(spec.deviceId);
      return this.#start({ deviceId: spec.deviceId, conversationId: spec.conversationId, workspace: spec.workspace, port, kind: 'job', jobId: job.id, jobLabel: job.label, jobs: spec.jobs, ...(spec.signal ? { signal: spec.signal } : {}) });
    }
    throw new TunnelError(
      'not_owned',
      `${spec.port !== undefined ? `Port ${spec.port} isn't` : `None of the ports in your jobs' output (${ports.join(', ')}) is`} opened by one of your running background jobs in this workspace, so the dev tunnel won't reach it. The app must run as a background job (start_job) and listen on 127.0.0.1${spec.port !== undefined ? `:${spec.port}` : ''}; check it with job_status.${WIN_HINT}`,
    );
  }

  /**
   * The owner's "Try the dev tunnel": a small built-in page (storage, a live WebSocket, a POST and a
   * large file) served here on a loopback port of its own, opened through a tunnel for 5 minutes.
   */
  async openTest(deviceId: string, signal?: AbortSignal): Promise<TunnelView> {
    this.#checkDevice(deviceId);
    // One test tunnel per computer at a time.
    for (const e of [...this.#entries.values()]) if (e.deviceId === deviceId && e.kind === 'test') this.close(e.id, 'a new test started');
    const server = testPageServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    try {
      return await this.#start({ deviceId, conversationId: '', workspace: '', port, kind: 'test', jobId: 0, jobLabel: 'Dev tunnel test page', test: server, ...(signal ? { signal } : {}) });
    } catch (err) {
      server.close();
      server.closeAllConnections?.();
      throw err;
    }
  }

  async #start(s: { deviceId: string; conversationId: string; workspace: string; port: number; kind: 'job' | 'test'; jobId: number; jobLabel: string; jobs?: PreviewJobs; test?: Server; signal?: AbortSignal }): Promise<TunnelView> {
    const id = randomBytes(9).toString('hex');
    let r: { result: Record<string, unknown> };
    try {
      r = await this.#link.request(s.deviceId, 'c.tunnel', { tunnel: id, port: s.port, label: s.jobLabel.slice(0, 80) }, { ...(s.signal ? { signal: s.signal } : {}), deadlineMs: 15_000, what: `opening a dev tunnel to port ${s.port}` });
    } catch (err) {
      const e = err as Error & { code?: string };
      throw new TunnelError(e.code ?? 'error', e.message);
    }
    const localPort = Number(r.result.localPort);
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
      void this.#untunnel(s.deviceId, id);
      throw new TunnelError('error', "The computer didn't open a usable local port for the tunnel.");
    }
    const now = this.#now();
    const e: Entry = { id, deviceId: s.deviceId, conversationId: s.conversationId, workspace: s.workspace, port: s.port, localPort, kind: s.kind, jobId: s.jobId, jobLabel: s.jobLabel, ...(s.jobs ? { jobs: s.jobs } : {}), createdAt: now, lastUsed: now, checkedAt: now, expiresAt: now + (s.kind === 'test' ? TUNNEL_LIMITS.testMs : TUNNEL_LIMITS.ttlMs), streams: new Map(), bytesIn: 0, bytesOut: 0, ...(s.test ? { test: s.test } : {}) };
    this.#entries.set(id, e);
    this.#arm();
    this.#link.publish({ deviceId: s.deviceId, tunnel: 'open', tunnelId: id, port: s.port, localPort, ...(s.conversationId ? { conversationId: s.conversationId } : {}) });
    return this.#view(e);
  }

  #arm(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => {
      this.sweep();
      if (!this.#entries.size) {
        clearInterval(this.#sweeper);
        this.#sweeper = undefined;
      }
    }, 30_000);
    this.#sweeper.unref?.();
  }

  /** Ends tunnels that are idle, too old, or whose job is gone. */
  sweep(): void {
    const now = this.#now();
    for (const e of [...this.#entries.values()]) {
      if (now >= e.expiresAt) this.close(e.id, 'it was open for its whole time');
      else if (now - e.lastUsed > TUNNEL_LIMITS.idleMs && !e.streams.size) this.close(e.id, 'nothing used it for 30 minutes');
      else if (e.kind === 'job' && e.jobs && (!e.jobs.pidOf(e.jobId) || !e.jobs.running().some((j) => j.id === e.jobId))) this.close(e.id, 'its job ended');
    }
  }

  async #untunnel(deviceId: string, id: string): Promise<void> {
    if (!this.#link.connected(deviceId)) return;
    await this.#link.request(deviceId, 'c.untunnel', { tunnel: id }, { deadlineMs: 5000 }).catch(() => {});
  }

  /** Ends one tunnel: its streams close here and (with `tell`) the device closes its listener. */
  close(id: string, why = 'closed', tell = true): boolean {
    const e = this.#entries.get(id);
    if (!e) return false;
    this.#entries.delete(id);
    for (const s of [...e.streams.values()]) this.#closeStream(e, s, tell, why);
    e.test?.close();
    e.test?.closeAllConnections?.();
    if (tell) void this.#untunnel(e.deviceId, id);
    this.#link.publish({ deviceId: e.deviceId, tunnel: 'closed', tunnelId: id, why, ...(e.conversationId ? { conversationId: e.conversationId } : {}) });
    return true;
  }

  /** A job ended: its tunnels end with it. */
  jobEnded(jobId: number, jobs?: PreviewJobs): number {
    let n = 0;
    for (const e of [...this.#entries.values()]) if (e.kind === 'job' && e.jobId === jobId && (!jobs || e.jobs === jobs) && this.close(e.id, 'its job ended')) n++;
    return n;
  }

  /** Stop on that computer or in the chat, or it disconnected (`tell` false): every tunnel there ends. */
  closeDevice(deviceId: string, why: string, tell = true): number {
    let n = 0;
    for (const e of [...this.#entries.values()]) if (e.deviceId === deviceId && this.close(e.id, why, tell)) n++;
    this.#streams.delete(deviceId);
    return n;
  }

  closeAll(): void {
    for (const id of [...this.#entries.keys()]) this.close(id, 'the server is stopping', false);
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }

  // ---- streams (called by the hub for {t:'s'} messages and binary frames with an `s` header) ----

  #sendTo(deviceId: string, msg: Record<string, unknown>): void {
    this.#link.send(deviceId, JSON.stringify({ t: 's', ...msg }));
  }

  #closeStream(e: Entry, s: Stream, tell: boolean, why?: string): void {
    if (!e.streams.has(s.sid)) return;
    e.streams.delete(s.sid);
    this.#streams.get(e.deviceId)?.delete(s.sid);
    s.socket?.destroy();
    if (tell) this.#sendTo(e.deviceId, { ev: 'close', sid: s.sid, ...(why ? { why } : {}) });
  }

  /** A control message for a stream from the device. */
  text(deviceId: string, m: Record<string, unknown>): void {
    const ev = String(m.ev ?? '');
    const sid = Number(m.sid);
    if (!Number.isInteger(sid) || sid < 0 || sid > 2 ** 31) return;
    if (ev === 'open') return this.#open(deviceId, String(m.tunnel ?? ''), sid);
    const f = this.#streams.get(deviceId)?.get(sid);
    if (!f) return;
    const { e, s } = f;
    e.lastUsed = this.#now();
    if (ev === 'end') {
      s.endIn = true;
      if (s.socket && s.connected) s.socket.end();
      if (s.endOut) this.#closeStream(e, s, false);
    } else if (ev === 'close') this.#closeStream(e, s, false);
    else if (ev === 'pause') {
      s.paused = true;
      s.socket?.pause();
    } else if (ev === 'resume') {
      s.paused = false;
      if (!s.held) s.socket?.resume();
    }
  }

  /** Bytes from the device for a stream (the Sara browser's side). */
  data(deviceId: string, sid: number, buf: Buffer): void {
    const f = Number.isInteger(sid) ? this.#streams.get(deviceId)?.get(sid) : undefined;
    if (!f) return this.#sendTo(deviceId, { ev: 'close', sid, why: 'no such stream' });
    const { e, s } = f;
    e.lastUsed = this.#now();
    e.bytesIn += buf.length;
    if (!s.connected || !s.socket) {
      s.pendingBytes += buf.length;
      if (s.pendingBytes > TUNNEL_LIMITS.preConnect) return this.#closeStream(e, s, true, 'too much before the app answered');
      s.pending.push(buf);
      return;
    }
    if (!s.socket.write(buf) && !s.draining) {
      // The app is slow to read: the device stops sending until it drains.
      s.draining = true;
      this.#sendTo(deviceId, { ev: 'pause', sid });
      s.socket.once('drain', () => {
        s.draining = false;
        if (e.streams.has(sid)) this.#sendTo(deviceId, { ev: 'resume', sid });
      });
    }
  }

  #open(deviceId: string, tunnel: string, sid: number): void {
    const e = this.#entries.get(tunnel);
    // Only a tunnel this server made, on that same computer.
    if (!e || e.deviceId !== deviceId) return this.#sendTo(deviceId, { ev: 'close', sid, why: 'no such tunnel' });
    const now = this.#now();
    if (now >= e.expiresAt) {
      this.close(e.id, 'it was open for its whole time');
      return this.#sendTo(deviceId, { ev: 'close', sid, why: 'the tunnel ended' });
    }
    let per = this.#streams.get(deviceId);
    if (!per) {
      per = new Map();
      this.#streams.set(deviceId, per);
    }
    if (per.has(sid)) return this.#sendTo(deviceId, { ev: 'close', sid, why: 'that stream id is in use' });
    if (e.streams.size >= TUNNEL_LIMITS.streams) return this.#sendTo(deviceId, { ev: 'close', sid, why: 'too many connections at once' });
    const s: Stream = { sid, pending: [], pendingBytes: 0, connected: false, endIn: false, endOut: false, paused: false, held: false, draining: false };
    e.streams.set(sid, s);
    per.set(sid, { e, s });
    e.lastUsed = now;
    void this.#connect(e, s);
  }

  async #connect(e: Entry, s: Stream): Promise<void> {
    // Her job must still be the one listening there (checked again every 30 s, like previews).
    if (e.kind === 'job') {
      const pid = e.jobs?.pidOf(e.jobId);
      let ok = pid !== undefined;
      if (ok && this.#now() - e.checkedAt > RECHECK_MS) {
        ok = await this.#owns(pid!, e.port).catch(() => false);
        e.checkedAt = this.#now();
      }
      if (!ok) {
        this.close(e.id, 'its job no longer listens on that port');
        return;
      }
    }
    if (!e.streams.has(s.sid)) return;
    if (this.#ownPorts().includes(e.port)) {
      this.close(e.id, "that is Sara's own port");
      return;
    }
    try {
      // The one way out (loopback only, so private local mode allows it too).
      checkOutbound(`http://127.0.0.1:${e.port}/`, 'dev tunnel');
    } catch (err) {
      return this.#closeStream(e, s, true, (err as Error).message);
    }
    const sock = netConnect({ host: '127.0.0.1', port: e.port });
    s.socket = sock;
    sock.setNoDelay(true);
    sock.on('connect', () => {
      if (!e.streams.has(s.sid)) return void sock.destroy();
      s.connected = true;
      this.#sendTo(e.deviceId, { ev: 'ok', sid: s.sid });
      for (const b of s.pending.splice(0)) sock.write(b);
      s.pendingBytes = 0;
      if (s.endIn) sock.end();
      if (s.paused) sock.pause();
    });
    sock.on('data', (chunk: Buffer) => {
      e.lastUsed = this.#now();
      e.bytesOut += chunk.length;
      for (let i = 0; i < chunk.length; i += TUNNEL_LIMITS.chunk) this.#link.send(e.deviceId, packStream(s.sid, chunk.subarray(i, i + TUNNEL_LIMITS.chunk)));
      // The hands connection is backed up: stop reading from the app for a moment.
      if (!s.held && this.#link.buffered(e.deviceId) > TUNNEL_LIMITS.highWater) {
        s.held = true;
        sock.pause();
        const wait = setInterval(() => {
          if (!e.streams.has(s.sid) || this.#link.buffered(e.deviceId) < TUNNEL_LIMITS.highWater / 4) {
            clearInterval(wait);
            s.held = false;
            if (!s.paused && e.streams.has(s.sid)) sock.resume();
          }
        }, 25);
        wait.unref?.();
      }
    });
    sock.on('end', () => {
      s.endOut = true;
      if (!e.streams.has(s.sid)) return;
      this.#sendTo(e.deviceId, { ev: 'end', sid: s.sid });
      if (s.endIn) this.#closeStream(e, s, true);
    });
    sock.on('error', (err) => this.#closeStream(e, s, true, (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? `nothing listens on port ${e.port} on the server now` : 'the app closed the connection'));
    sock.on('close', () => this.#closeStream(e, s, true));
  }
}

/** A binary stream frame: 4-byte header length, {"s":sid}, bytes (the hands binary framing). */
export function packStream(sid: number, data: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify({ s: sid }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, data]);
}

// ---- the built-in test page ("Try the dev tunnel", the conformance check) ----
/** A large file with a checksum the page verifies (bytes really cross the tunnel intact). */
const BIG = (() => {
  const n = 300 * 1024;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = 97 + ((i * 7 + (i >> 9)) % 26);
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum * 31 + b[i]) >>> 0;
  return { body: b, sum };
})();

export const TUNNEL_TEST_TITLE = 'Sara dev tunnel test';

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>${TUNNEL_TEST_TITLE}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui,sans-serif;margin:2rem;max-width:40rem}li{margin:.4rem 0}.ok{color:#137333}.bad{color:#b3261e}</style></head>
<body><h1>Dev tunnel test</h1><p>This page comes from Sara's server through the dev tunnel. It checks what a preview link can't do.</p>
<ul><li id="origin">Address: …</li><li id="storage">Storage: checking…</li><li id="live">Live connection: checking…</li><li id="post">Sending data: checking…</li><li id="big">Large file: checking…</li></ul>
<p id="summary">Checking…</p>
<script>
(function () {
  var done = { storage: false, live: false, post: false, big: false };
  function set(id, ok, text) { var el = document.getElementById(id); el.textContent = text; el.className = ok ? 'ok' : 'bad'; done[id] = ok; sum(); }
  function sum() { var all = done.storage && done.live && done.post && done.big; document.getElementById('summary').textContent = all ? 'All checks passed.' : 'Checking…'; }
  document.getElementById('origin').textContent = 'Address: ' + location.origin;
  try { var n = Number(localStorage.getItem('sara-tunnel-visits') || 0) + 1; localStorage.setItem('sara-tunnel-visits', String(n)); set('storage', true, 'Storage: works (visit ' + n + ')'); } catch (e) { set('storage', false, 'Storage: blocked (' + e.name + ')'); }
  try {
    var ws = new WebSocket('ws://' + location.host + '/live');
    ws.onmessage = function (m) { if (String(m.data) === 'hello from the dev server') { set('live', true, 'Live connection: works (hot reload can reach the page)'); ws.close(); } };
    ws.onerror = function () { set('live', false, 'Live connection: failed'); };
  } catch (e) { set('live', false, 'Live connection: failed'); }
  fetch('/echo', { method: 'POST', body: 'ping-' + 'x'.repeat(20000) }).then(function (r) { return r.text(); }).then(function (t) { set('post', t === 'echo:20005', 'Sending data: ' + (t === 'echo:20005' ? 'works' : 'wrong answer')); }, function () { set('post', false, 'Sending data: failed'); });
  fetch('/big.txt').then(function (r) { return r.text(); }).then(function (t) { var s = 0; for (var i = 0; i < t.length; i++) s = (Math.imul(s, 31) + t.charCodeAt(i)) >>> 0; set('big', s === ${BIG.sum} && t.length === ${BIG.body.length}, 'Large file: ' + (s === ${BIG.sum} ? 'arrived intact (' + t.length + ' bytes)' : 'damaged')); }, function () { set('big', false, 'Large file: failed'); });
})();
</script></body></html>`;

function testPageServer(): Server {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    const head = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { ...head, 'content-type': 'text/html; charset=utf-8' });
      return void res.end(TEST_PAGE);
    }
    if (path === '/big.txt') {
      res.writeHead(200, { ...head, 'content-type': 'text/plain; charset=us-ascii', 'content-length': String(BIG.body.length) });
      return void res.end(BIG.body);
    }
    if (path === '/echo' && req.method === 'POST') {
      let n = 0;
      req.on('data', (c: Buffer) => (n += c.length));
      req.on('end', () => {
        res.writeHead(200, { ...head, 'content-type': 'text/plain' });
        res.end(`echo:${n}`);
      });
      return;
    }
    res.writeHead(404, { ...head, 'content-type': 'text/plain' });
    res.end('Not found');
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url ?? '').split('?')[0] !== '/live') return void socket.destroy();
    const ws = acceptWebSocket(req, socket, head);
    ws?.send('hello from the dev server');
  });
  return server;
}
