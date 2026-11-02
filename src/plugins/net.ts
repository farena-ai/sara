// Phase 117 (docs/design/BRIDGES3.md §3.1 P1): the socket broker. A plugin never touches a socket:
// on a fenced host it has no network at all (bubblewrap --unshare-all, Seatbelt without network),
// so Sara opens TCP or TLS connections for it and relays the bytes over the plugin channel. The
// plugin keeps the protocol (JSON-RPC lines for signal-cli, IMAP, SMTP); Sara keeps the rules:
//
// - Only the endpoints in its manifest (`permissions.connect`, ≤ 4), and the host always comes from
//   the owner's own setting (`setting:<key>`), read when the socket opens. Whatever host the plugin
//   names in `net.open` is ignored: the setting wins.
// - `where: 'local'`: loopback only, or private addresses (RFC 1918, fc00::/7, a Docker service
//   name resolving to one) when the owner ticked the plugin's `onOtherMachine` switch. Public
//   addresses are refused. `where: 'public'`: public addresses only (the `sara.fetch` rule).
// - The name is resolved once and the connection is pinned to the first address (no rebinding).
// - `tls: 'required'`: implicit TLS at once, or on 143 (IMAP) and 587 (SMTP) Sara does the STARTTLS
//   exchange itself and hands over only the encrypted socket. Certificates are always checked
//   against the host name (SNI, rejectUnauthorized); no setting turns that off. Tests inject a CA.
// - Caps: 4 sockets per plugin process; `net.write` has its own budget (600 a minute, 16 MB a
//   minute; over it writes are refused for the rest of the minute); ≤ 256 KB a write and a data
//   line; reads pause while the plugin's stdin is more than 4 MB behind; idle sockets close after
//   35 minutes (just over IMAP IDLE's 29). Every open and close is logged.
// - Private local mode refuses every `net.open` and closes open sockets when it is switched on
//   (both bridges send her words off this computer: signal-cli to Signal, SMTP to the provider).
// - Phase 117 part B, a TEST-ONLY override (docs/EMAIL_BRIDGE.md, "Testing with a stand-in server"):
//   a stand-in mail server on this computer can only be reached when `SARA_TEST_ALLOW_LOOPBACK_MAIL=1`
//   is set in Sara's environment, or when a test passes `testLoopback` while running under `node
//   --test` (NODE_TEST_CONTEXT). Never on by default, no setting turns it on. With it, a `public`
//   endpoint also accepts a loopback address (127.0.0.0/8, ::1; nothing else private), the port typed
//   in the host setting (`localhost:7891`) is the one connected to (the manifest port still decides
//   implicit TLS or STARTTLS), and `SARA_TEST_MAIL_CA` (a PEM file) is trusted for TLS. Certificates
//   are still checked against the host name. Every such connection is logged as a test override.
import { readFileSync } from 'node:fs';
import { isIP, Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { assertOnline, checkOutbound, onPrivateLocalChange, privateLocalOn } from '../net-guard.ts';
import { isPrivateAddress } from '../tools/builtin.ts';
import { realClock, type Clock } from '../bridges/sendq.ts';
import { OTHER_MACHINE_SETTING, STARTTLS_PORTS, type ConnectEndpoint } from './manifest.ts';

export const MAX_SOCKETS = 4;
export const WRITE_MAX = 256 * 1024;
export const WRITES_PER_MINUTE = 600;
export const WRITE_BYTES_PER_MINUTE = 16 * 1024 * 1024;
export const BACKLOG_MAX = 4 * 1024 * 1024;
export const IDLE_MS = 35 * 60_000;
export const CONNECT_MS = 15_000;

export class NetDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetDenied';
  }
}

export interface NetDeps {
  endpoints: readonly ConnectEndpoint[];
  /** The plugin's current settings for this companion (the host is read from them at open). */
  settings: () => Record<string, string | number | boolean>;
  /** Sends one line to the plugin (`net.data`, `net.closed`). */
  send: (msg: Record<string, unknown>) => boolean;
  /** Bytes queued on the plugin's stdin (reads pause above 4 MB). */
  backlog: () => number;
  log: (kind: 'call' | 'denied', text: string) => void;
  /** Tests: DNS, a CA for the fake servers, the idle clock. No environment variable loosens anything. */
  lookup?: (host: string) => Promise<string[]>;
  ca?: string | Buffer | (string | Buffer)[];
  clock?: Clock;
  /** Her own name for SMTP's EHLO during STARTTLS. */
  ehloName?: string;
  /** Tests only: allow a loopback stand-in mail server (honoured only under `node --test`). */
  testLoopback?: boolean;
}

/** The test-only loopback override (see the top of this file): never on by default. */
export function loopbackMailOverride(testLoopback?: boolean): boolean {
  if (process.env.SARA_TEST_ALLOW_LOOPBACK_MAIL === '1') return true;
  return testLoopback === true && Boolean(process.env.NODE_TEST_CONTEXT);
}

/** The override's extra CA (a PEM file named by SARA_TEST_MAIL_CA), only with SARA_TEST_ALLOW_LOOPBACK_MAIL=1. */
function overrideCa(): string | undefined {
  const f = process.env.SARA_TEST_MAIL_CA;
  if (process.env.SARA_TEST_ALLOW_LOOPBACK_MAIL !== '1' || !f) return undefined;
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
}

interface Held {
  id: string;
  endpoint: string;
  host: string;
  port: number;
  tls: string;
  since: number;
  sock: Socket | TLSSocket;
  idle: unknown;
  closed: boolean;
}

/** Splits "host", "host:port", "[v6]:port". */
export function splitAddress(raw: string): { host: string; port?: number } | undefined {
  const s = raw.trim();
  if (!s || s.length > 255 || /[\s/@?#]/.test(s) || /^[a-z]+:\/\//i.test(s)) return undefined;
  let host = s;
  let port: number | undefined;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(s);
  if (v6) {
    host = v6[1];
    port = v6[2] ? Number(v6[2]) : undefined;
  } else if (isIP(s) === 6) host = s;
  else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s);
    if (!m) return undefined;
    host = m[1];
    port = m[2] ? Number(m[2]) : undefined;
  }
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  if (!isIP(host) && !/^(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.?$/i.test(host)) return undefined;
  return { host: host.toLowerCase().replace(/\.$/, ''), ...(port ? { port } : {}) };
}

const v4 = (ip: string): number[] | undefined => {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  return m ? m.slice(1).map(Number) : undefined;
};
export function isLoopbackAddress(ip: string): boolean {
  const q = v4(ip);
  if (q) return q[0] === 127;
  return ip === '::1';
}
/** RFC 1918 and IPv6 unique-local: the home network or a Docker network. */
export function isHomeNetworkAddress(ip: string): boolean {
  const q = v4(ip);
  if (q) return q[0] === 10 || (q[0] === 172 && q[1] >= 16 && q[1] <= 31) || (q[0] === 192 && q[1] === 168);
  return isIP(ip) === 6 && /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/** Whether an address may be used for an endpoint (`otherMachine`: the owner's switch). */
export function addressAllowed(ip: string, where: 'local' | 'public', otherMachine: boolean): string | undefined {
  if (where === 'public') return isPrivateAddress(ip) ? 'it is a private or local address, and this connection may only go to a public server' : undefined;
  if (isLoopbackAddress(ip)) return undefined;
  if (isHomeNetworkAddress(ip)) return otherMachine ? undefined : 'it is on your home network; switch on "runs on another machine on my network" to allow that';
  return 'it is not on this computer, and this connection may only go to a program on this computer or your home network';
}

/** The sockets of one plugin process. */
export class PluginSockets {
  readonly #d: NetDeps;
  readonly #held = new Map<string, Held>();
  readonly #clock: Clock;
  #seq = 0;
  #writes: { at: number; bytes: number }[] = [];
  #unsub: () => void;
  #pausedTimer: NodeJS.Timeout | undefined;

  constructor(d: NetDeps) {
    this.#d = d;
    this.#clock = d.clock ?? realClock;
    this.#unsub = onPrivateLocalChange((on) => {
      if (on) this.closeAll('private local mode is on ("Nothing leaves this computer")');
    });
  }

  get size(): number {
    return this.#held.size;
  }

  list(): { socket: string; endpoint: string; host: string; port: number; tls: string; since: string }[] {
    return [...this.#held.values()].map((h) => ({ socket: h.id, endpoint: h.endpoint, host: h.host, port: h.port, tls: h.tls, since: new Date(h.since).toISOString() }));
  }

  #deny(why: string): never {
    this.#d.log('denied', `net.open: ${why}`);
    throw new NetDenied(why);
  }

  /** `net.open {endpoint, port?}` → `{socket, tls?}`. */
  async open(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ep = this.#d.endpoints.find((e) => e.id === String(msg.endpoint ?? ''));
    if (!ep) return this.#deny(`"${String(msg.endpoint ?? '').slice(0, 30)}" isn't one of the connections in its manifest`);
    try {
      assertOnline('plugin connections');
    } catch {
      return this.#deny('private local mode is on ("Nothing leaves this computer")');
    }
    if (this.#held.size >= MAX_SOCKETS) return this.#deny(`it already has ${MAX_SOCKETS} connections open`);
    if (msg.host !== undefined) this.#d.log('denied', `net.open: it named a host of its own (${String(msg.host).slice(0, 60)}); the address in its settings is used`);
    const settings = this.#d.settings();
    const key = ep.host.slice('setting:'.length);
    const addr = splitAddress(String(settings[key] ?? ''));
    if (!addr) return this.#deny(`the address in its setting "${key}" is missing or isn't a host name or address`);
    let port: number;
    if (ep.ports === 'setting') {
      if (!addr.port) return this.#deny(`the address in "${key}" has no port (like 127.0.0.1:7583)`);
      port = addr.port;
    } else {
      const want = msg.port === undefined ? (addr.port ?? ep.ports[0]) : Number(msg.port);
      if (!ep.ports.includes(want)) return this.#deny(`port ${want} isn't one of ${ep.ports.join(', ')}`);
      port = want;
    }
    const other = settings[OTHER_MACHINE_SETTING] === true;
    // The guard itself (src/net-guard.ts): a local endpoint is a home-network target at most.
    try {
      checkOutbound(`tcp://${isIP(addr.host) === 6 ? `[${addr.host}]` : addr.host}:${port}`, 'a plugin connection', ep.where === 'local');
    } catch {
      return this.#deny('private local mode is on ("Nothing leaves this computer")');
    }
    const lookup = this.#d.lookup ?? defaultLookup;
    const addrs = isIP(addr.host) ? [addr.host] : await lookup(addr.host).catch(() => [] as string[]);
    if (!addrs.length) return this.#deny(`${addr.host} couldn't be found`);
    // Every address the name has must be allowed (a name can't mix a public and a private answer).
    for (const ip of addrs) {
      if (ep.where === 'public' && isLoopbackAddress(ip) && loopbackMailOverride(this.#d.testLoopback)) continue;
      const bad = addressAllowed(ip, ep.where, other);
      if (bad) return this.#deny(`${addr.host} (${ip}): ${bad}`);
    }
    const ip = addrs[0];
    // The test-only override: a loopback stand-in for a public mail server, on the port typed in the setting.
    const testOverride = ep.where === 'public' && loopbackMailOverride(this.#d.testLoopback) && addrs.every(isLoopbackAddress);
    const connectPort = testOverride && addr.port ? addr.port : port;
    if (testOverride) this.#d.log('call', `TEST OVERRIDE (SARA_TEST_ALLOW_LOOPBACK_MAIL): a stand-in mail server on this computer at ${addr.host}:${connectPort} for port ${port}`);
    const ca = this.#d.ca ?? (testOverride ? overrideCa() : undefined);
    let sock: Socket | TLSSocket;
    let tlsInfo: Record<string, unknown> | undefined;
    let greeting: string | undefined;
    try {
      const plain = await connectTcp(ip, connectPort);
      if (ep.tls === 'required') {
        const kind = STARTTLS_PORTS[port];
        if (kind) greeting = await startTls(plain, kind, this.#d.ehloName ?? 'sara.localdomain');
        sock = await upgrade(plain, addr.host, ca);
        const t = sock as TLSSocket;
        const cert = t.getPeerCertificate?.();
        tlsInfo = { protocol: t.getProtocol?.() ?? null, cipher: t.getCipher?.()?.name ?? null, peer: (cert && (cert.subject?.CN as string | undefined)) ?? null, ...(kind ? { starttls: kind } : {}) };
      } else sock = plain;
    } catch (err) {
      return this.#deny(`${addr.host}:${port}: ${(err as Error).message.slice(0, 200)}`);
    }
    if (privateLocalOn()) {
      sock.destroy();
      return this.#deny('private local mode is on ("Nothing leaves this computer")');
    }
    const id = `s${++this.#seq}`;
    const h: Held = { id, endpoint: ep.id, host: addr.host, port, tls: tlsInfo ? String(tlsInfo.protocol ?? 'TLS') : 'none', since: this.#clock.now(), sock, idle: undefined, closed: false };
    this.#held.set(id, h);
    this.#touch(h);
    sock.on('data', (chunk: Buffer) => {
      this.#touch(h);
      for (let i = 0; i < chunk.length; i += WRITE_MAX) this.#d.send({ v: 1, type: 'net.data', socket: id, data: chunk.subarray(i, i + WRITE_MAX).toString('base64') });
      if (this.#d.backlog() > BACKLOG_MAX) this.#backpressure();
    });
    sock.on('error', () => undefined);
    sock.on('close', () => this.#gone(h, 'closed by the other side'));
    this.#d.log('call', `connected to ${addr.host}:${port}${tlsInfo ? `, ${String(tlsInfo.protocol ?? 'TLS')}${tlsInfo.starttls ? ' (STARTTLS by Sara)' : ''}` : ''} (${ep.id})`);
    return { socket: id, ...(tlsInfo ? { tls: tlsInfo } : {}), ...(greeting !== undefined ? { greeting } : {}) };
  }

  /** `net.write {socket, data}` (base64, ≤ 256 KB), in its own budget. */
  write(msg: Record<string, unknown>): Record<string, unknown> {
    const h = this.#held.get(String(msg.socket ?? ''));
    if (!h || h.closed) throw new NetDenied('no such connection (it may have closed)');
    if (privateLocalOn()) {
      this.closeAll('private local mode is on ("Nothing leaves this computer")');
      throw new NetDenied('private local mode is on');
    }
    const data = Buffer.from(String(msg.data ?? ''), 'base64');
    if (data.length > WRITE_MAX) throw new NetDenied('a write over 256 KB');
    const now = this.#clock.now();
    this.#writes = this.#writes.filter((w) => now - w.at < 60_000);
    const bytes = this.#writes.reduce((n, w) => n + w.bytes, 0);
    if (this.#writes.length >= WRITES_PER_MINUTE || bytes + data.length > WRITE_BYTES_PER_MINUTE) {
      this.#d.log('denied', `net.write: over ${WRITES_PER_MINUTE} writes or 16 MB a minute; paused for the rest of the minute`);
      throw new NetDenied('paused: more than 600 writes or 16 MB in a minute');
    }
    this.#writes.push({ at: now, bytes: data.length });
    this.#touch(h);
    h.sock.write(data);
    return { ok: true };
  }

  close(msg: Record<string, unknown>): Record<string, unknown> {
    const h = this.#held.get(String(msg.socket ?? ''));
    if (!h) return { ok: true };
    this.#end(h, 'closed by the plugin');
    return { ok: true };
  }

  closeAll(reason: string): void {
    for (const h of [...this.#held.values()]) this.#end(h, reason);
  }

  /** The process stopped: everything goes (and the private-mode listener). */
  dispose(): void {
    this.closeAll('the plugin stopped');
    this.#unsub();
    clearInterval(this.#pausedTimer);
  }

  #touch(h: Held): void {
    if (h.idle !== undefined) this.#clock.clearTimeout(h.idle);
    h.idle = this.#clock.setTimeout(() => this.#end(h, 'idle for 35 minutes'), IDLE_MS);
  }

  #backpressure(): void {
    if (this.#pausedTimer) return;
    for (const h of this.#held.values()) h.sock.pause();
    this.#pausedTimer = setInterval(() => {
      if (this.#d.backlog() > BACKLOG_MAX / 2) return;
      clearInterval(this.#pausedTimer);
      this.#pausedTimer = undefined;
      for (const h of this.#held.values()) if (!h.closed) h.sock.resume();
    }, 50);
    this.#pausedTimer.unref?.();
  }

  #end(h: Held, reason: string): void {
    if (h.closed) return;
    h.sock.destroy();
    this.#gone(h, reason);
  }

  #gone(h: Held, reason: string): void {
    if (h.closed) return;
    h.closed = true;
    if (h.idle !== undefined) this.#clock.clearTimeout(h.idle);
    this.#held.delete(h.id);
    this.#d.log('call', `closed ${h.host}:${h.port} (${reason})`);
    this.#d.send({ v: 1, type: 'net.closed', socket: h.id, reason });
  }
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  return (await lookup(host, { all: true })).map((x) => x.address);
}

function connectTcp(ip: string, port: number): Promise<Socket> {
  return new Promise((resolveConn, reject) => {
    const s = new Socket();
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('no answer within 15 s'));
    }, CONNECT_MS);
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    s.connect({ host: ip, port }, () => {
      clearTimeout(timer);
      s.removeAllListeners('error');
      resolveConn(s);
    });
  });
}

/** Reads CRLF lines from a plain socket until `done` says so (≤ 16 KB, 15 s). */
function readUntil(s: Socket, done: (lines: string[]) => boolean): Promise<string[]> {
  return new Promise((resolveRead, reject) => {
    let buf = '';
    const lines: string[] = [];
    const timer = setTimeout(() => finish(new Error('the server did not answer within 15 s')), CONNECT_MS);
    const onData = (c: Buffer) => {
      buf += c.toString('latin1');
      if (buf.length > 16_384) return finish(new Error('the server sent too much before encryption'));
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
        if (done(lines)) {
          if (buf.length) return finish(new Error('the server sent data before encryption started'));
          return finish();
        }
      }
    };
    const onClose = () => finish(new Error('the server closed the connection'));
    const finish = (err?: Error) => {
      clearTimeout(timer);
      s.off('data', onData);
      s.off('close', onClose);
      s.off('error', onClose);
      s.pause();
      if (err) {
        s.destroy();
        reject(err);
      } else resolveRead(lines);
    };
    s.on('data', onData);
    s.once('close', onClose);
    s.once('error', onClose);
    s.resume();
  });
}

/**
 * STARTTLS, done by Sara (BRIDGES3 §12 Q10): nothing of the plugin's is sent before encryption.
 * IMAP: greeting, `a0 STARTTLS`, `a0 OK`. SMTP: 220 greeting, EHLO, 250 with STARTTLS, `STARTTLS`,
 * 220. Returns the greeting (the plugin re-sends CAPABILITY / EHLO over TLS as the RFCs say).
 */
async function startTls(s: Socket, kind: 'imap' | 'smtp', ehlo: string): Promise<string> {
  if (kind === 'imap') {
    const g = await readUntil(s, (l) => l.length >= 1);
    if (!/^\* (OK|PREAUTH)\b/i.test(g[0])) throw new Error('the mail server did not greet as IMAP');
    s.write('a0 STARTTLS\r\n');
    const r = await readUntil(s, (l) => l.some((x) => /^a0 /i.test(x)));
    if (!/^a0 OK\b/i.test(r.at(-1)!)) throw new Error("the mail server can't switch to encryption (STARTTLS), so nothing was sent");
    return g[0];
  }
  const smtpDone = (l: string[]) => /^\d{3} /.test(l.at(-1) ?? '');
  const g = await readUntil(s, smtpDone);
  if (!/^220[ -]/.test(g[0])) throw new Error('the mail server did not greet as SMTP');
  s.write(`EHLO ${ehlo}\r\n`);
  const caps = await readUntil(s, smtpDone);
  if (!/^250/.test(caps.at(-1)!) || !caps.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new Error("the mail server doesn't offer encryption (STARTTLS), so nothing was sent");
  s.write('STARTTLS\r\n');
  const r = await readUntil(s, smtpDone);
  if (!/^220 /.test(r.at(-1)!)) throw new Error("the mail server refused to switch to encryption, so nothing was sent");
  return g.join('\n');
}

function upgrade(s: Socket, host: string, ca: NetDeps['ca']): Promise<TLSSocket> {
  return new Promise((resolveTls, reject) => {
    // The certificate is checked against the host the owner typed (SNI only for names).
    const t = tlsConnect({ socket: s, host, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) });
    const timer = setTimeout(() => {
      t.destroy();
      reject(new Error('the encrypted connection did not start within 15 s'));
    }, CONNECT_MS);
    t.once('secureConnect', () => {
      clearTimeout(timer);
      t.removeAllListeners('error');
      if (!t.authorized) {
        t.destroy();
        reject(new Error(`the server's certificate isn't valid (${String(t.authorizationError)})`));
        return;
      }
      resolveTls(t);
    });
    t.once('error', (err) => {
      clearTimeout(timer);
      t.destroy();
      reject(new Error(`the encrypted connection failed: ${err.message}`));
    });
  });
}
