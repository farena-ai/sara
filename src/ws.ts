// A small WebSocket server and client (RFC 6455) for live voice calls and, since Phase 49, for
// driving the testing browser over the DevTools protocol: no dependencies.
// Supports text and binary messages, fragmentation, ping/pong and close. Client frames are masked
// (browsers always do; so does our own client); server frames are not.

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkOutbound } from './net-guard.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest message accepted from the browser (audio frames are a few KB). */
const MAX_MESSAGE = 4 * 1024 * 1024;

export interface WsConnection {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
  onMessage?: (data: string | Buffer) => void;
  onClose?: (code: number) => void;
  /** Phase 87: a ping frame (the hands channel's heartbeat); the other side answers with a pong. */
  ping?(): void;
  /** Phase 87: when the last frame of any kind (a pong too) arrived, in ms since the epoch. */
  readonly lastSeen?: number;
  /** Phase 89: bytes written but not yet sent (the dev tunnel's flow control). */
  readonly buffered?: number;
}

/** Rejects an upgrade with a plain HTTP status. */
export function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.on('error', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Completes the WebSocket handshake on an HTTP upgrade and returns the connection. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | undefined {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    refuseUpgrade(socket, 400, 'Bad Request');
    return undefined;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new Connection(socket, head);
}

/**
 * Phase 49: opens a WebSocket to a ws:// address (plain, loopback use: the browser's DevTools
 * endpoint). Our frames are masked as the protocol requires of clients; messages up to `maxMessage`.
 */
export function connectWebSocket(url: string, opts: { timeoutMs?: number; maxMessage?: number; headers?: Record<string, string> } = {}): Promise<WsConnection> {
  const u = new URL(url);
  if (u.protocol !== 'ws:') return Promise.reject(new Error('Only ws:// addresses are supported.'));
  // Phase 67: the one check before connecting (private local mode allows only this computer).
  try {
    checkOutbound(u);
  } catch (err) {
    return Promise.reject(err as Error);
  }
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || 80),
      path: `${u.pathname}${u.search}`,
      // Phase 87: extra headers (the reference hands send their token as Authorization: Bearer).
      headers: { ...(opts.headers ?? {}), Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      timeout: opts.timeoutMs ?? 10_000,
    });
    req.on('upgrade', (res, socket, head) => {
      socket.on('error', () => socket.destroy());
      const want = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== want) {
        socket.destroy();
        return reject(new Error('WebSocket handshake failed (bad accept key).'));
      }
      resolve(new Connection(socket, head, { client: true, maxMessage: opts.maxMessage ?? 64 * 1024 * 1024 }));
    });
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`WebSocket handshake refused (HTTP ${res.statusCode}).`));
    });
    req.on('timeout', () => req.destroy(new Error('WebSocket connection timed out.')));
    req.on('error', reject);
    req.end();
  });
}

class Connection implements WsConnection {
  onMessage?: (data: string | Buffer) => void;
  onClose?: (code: number) => void;
  #socket: Duplex;
  #buf: Buffer = Buffer.alloc(0);
  #parts: Buffer[] = [];
  #partsType = 0;
  #partsSize = 0;
  #open = true;
  /** Client side: our frames are masked and the server's are not. */
  readonly #client: boolean;
  readonly #max: number;

  constructor(socket: Duplex, head: Buffer, opts: { client?: boolean; maxMessage?: number } = {}) {
    this.#socket = socket;
    this.#client = opts.client === true;
    this.#max = opts.maxMessage ?? MAX_MESSAGE;
    socket.on('data', (d: Buffer) => this.#data(d));
    socket.on('close', () => this.#closed(1006));
    socket.on('error', () => this.#closed(1006));
    if (head.length) this.#data(head);
  }

  get open(): boolean {
    return this.#open;
  }

  #lastSeen = Date.now();
  get lastSeen(): number {
    return this.#lastSeen;
  }

  ping(): void {
    if (this.#open) this.#frame(0x9, Buffer.alloc(0));
  }

  get buffered(): number {
    return (this.#socket as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  send(data: string | Buffer): void {
    if (!this.#open) return;
    const payload = typeof data === 'string' ? Buffer.from(data) : data;
    this.#frame(typeof data === 'string' ? 0x1 : 0x2, payload);
  }

  close(code = 1000, reason = ''): void {
    if (!this.#open) return;
    const r = Buffer.from(reason.slice(0, 100));
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.#frame(0x8, p);
    this.#socket.end();
    this.#closed(code);
  }

  #frame(opcode: number, payload: Buffer): void {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    if (!this.#client) return void this.#socket.write(Buffer.concat([head, payload]));
    head[1] |= 0x80;
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.#socket.write(Buffer.concat([head, mask, body]));
  }

  #closed(code: number): void {
    if (!this.#open) return;
    this.#open = false;
    this.#socket.destroy();
    this.onClose?.(code);
  }

  #data(d: Buffer): void {
    this.#lastSeen = Date.now();
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
    while (this.#open) {
      const b = this.#buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.#max)) return this.close(1009, 'too big');
        len = Number(big);
        off = 10;
      }
      // Servers must not mask; clients must.
      if (masked === this.#client) return this.close(1002, this.#client ? 'masked' : 'unmasked');
      if (len > this.#max) return this.close(1009, 'too big');
      const m = masked ? 4 : 0;
      if (b.length < off + m + len) return;
      const payload = Buffer.from(b.subarray(off + m, off + m + len));
      if (masked) {
        const mask = b.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.#buf = b.subarray(off + m + len);

      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code === 1005 || code === 1006 ? 1000 : code);
        return;
      }
      if (opcode === 0x9) {
        this.#frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        this.#parts = [payload];
        this.#partsType = opcode;
        this.#partsSize = payload.length;
      } else if (opcode === 0x0 && this.#parts.length) {
        this.#parts.push(payload);
        this.#partsSize += payload.length;
        if (this.#partsSize > this.#max) return this.close(1009, 'too big');
      } else return this.close(1002, 'bad frame');
      if (!fin) continue;
      const all = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
      const type = this.#partsType;
      this.#parts = [];
      try {
        this.onMessage?.(type === 0x1 ? all.toString('utf8') : all);
      } catch (err) {
        console.error('websocket message handler failed:', err);
      }
    }
  }
}
