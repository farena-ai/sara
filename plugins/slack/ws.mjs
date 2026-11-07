// A WebSocket client (RFC 6455) over a socket Sara holds for the plugin (docs/ops/EC1_DESIGN.md). The
// plugin has no network of its own, so Node's built-in WebSocket can't be used: this writes the
// handshake (GET with Upgrade, a random Sec-WebSocket-Key), checks the 101 and Sec-WebSocket-Accept,
// then speaks frames: masked from the client (always), text and binary messages (continuations
// joined, 4 MB at most), ping answered with pong, close answered and ended. No extensions (no
// compression), no subprotocol. Plain JavaScript, no dependencies; written for Slack's Socket Mode.
import { createHash, randomBytes } from 'node:crypto';

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 4 * 1024 * 1024;
export const HANDSHAKE_MS = 20_000;

/** Sec-WebSocket-Accept for a key (RFC 6455 §4.2.2). */
export const acceptOf = (key) => createHash('sha1').update(`${key}${GUID}`).digest('base64');

/** One frame, FIN set; masked with a fresh key when `mask` (every client frame). */
export function encodeFrame(op, payload, mask = true) {
  const n = payload.length;
  const len = n < 126 ? [n] : n < 65536 ? [126, n >> 8, n & 255] : [127, 0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const head = Buffer.from([0x80 | op, (mask ? 0x80 : 0) | len[0], ...len.slice(1)]);
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

/** Reads frames from a byte stream: `push(bytes, onFrame)` calls onFrame({ fin, op, masked, payload }). */
export class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(bytes, onFrame) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, bytes]) : Buffer.from(bytes);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1] & 127;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error('a WebSocket frame is too big');
        len = Number(big);
        at = 10;
      }
      if (len > MAX_MESSAGE) throw new Error('a WebSocket frame is too big');
      const masked = (b[1] & 128) !== 0;
      const key = masked ? b.subarray(at, at + 4) : undefined;
      if (masked) at += 4;
      if (b.length < at + len) return;
      const payload = Buffer.from(b.subarray(at, at + len));
      if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      this.buf = b.subarray(at + len);
      onFrame({ fin: (b[0] & 0x80) !== 0, op: b[0] & 15, masked, payload });
    }
  }
}

/**
 * One WebSocket connection. `connect(url)` resolves after the 101; then `onMessage(fn)` gets each text
 * message, `onClose(fn)` the reason once. `send(text)`, `close()`. `lastFrameAt` is for a watchdog.
 */
export class WebSocketClient {
  constructor(sara, endpoint) {
    this.sara = sara;
    this.endpoint = endpoint;
    this.sock = undefined;
    this.open = false;
    this.closed = false;
    this.lastFrameAt = 0;
    this.msgFn = () => undefined;
    this.closeFn = () => undefined;
    this.reader = new FrameReader();
    this.parts = [];
    this.partsOp = 0;
    this.partsLen = 0;
  }

  onMessage(fn) {
    this.msgFn = fn;
  }

  onClose(fn) {
    this.closeFn = fn;
  }

  async connect(url) {
    const u = new URL(url);
    if (u.protocol !== 'wss:') throw new Error('only wss:// addresses');
    const sock = await this.sara.net.open(`${this.endpoint}@${u.hostname}`, { port: 443 });
    this.sock = sock;
    const key = randomBytes(16).toString('base64');
    let head = Buffer.alloc(0);
    let upgraded = false;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer in ${HANDSHAKE_MS / 1000} s`)), HANDSHAKE_MS);
      timer.unref?.();
      this.fail = (err) => (clearTimeout(timer), reject(err));
      this.ok = () => (clearTimeout(timer), resolve());
    });
    sock.onData((b) => {
      if (upgraded) return this.#frames(b);
      head = Buffer.concat([head, b]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16 * 1024) this.fail(new Error('a bad WebSocket answer'));
        return;
      }
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const h = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      if (status !== 101 || !/websocket/i.test(h.upgrade ?? '') || h['sec-websocket-accept'] !== acceptOf(key)) {
        void sock.close().catch(() => undefined);
        return this.fail(new Error(`the WebSocket was refused (HTTP ${status || '?'})`));
      }
      upgraded = true;
      this.open = true;
      this.lastFrameAt = Date.now();
      this.ok();
      const rest = head.subarray(end + 4);
      if (rest.length) this.#frames(rest);
    });
    sock.onClose((why) => {
      if (!upgraded) this.fail?.(new Error(`the connection closed (${why})`));
      this.#ended(`closed (${why})`);
    });
    const path = `${u.pathname}${u.search}`;
    await sock.write(Buffer.from(`GET ${path} HTTP/1.1\r\nHost: ${u.hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: Sara/1.0\r\n\r\n`, 'latin1'));
    await ready;
  }

  #frames(bytes) {
    try {
      this.reader.push(bytes, (f) => this.#frame(f));
    } catch (err) {
      void this.close(1009);
      this.#ended(err.message);
    }
  }

  #frame(f) {
    this.lastFrameAt = Date.now();
    if (f.masked) return void this.close(1002);
    if (f.op === 9) return void this.#write(10, f.payload);
    if (f.op === 10) return;
    if (f.op === 8) {
      void this.#write(8, f.payload.subarray(0, 2)).finally(() => this.sock?.close().catch(() => undefined));
      return this.#ended(`closed by Slack (${f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005})`);
    }
    if (f.op === 1 || f.op === 2) {
      this.parts = [f.payload];
      this.partsOp = f.op;
      this.partsLen = f.payload.length;
    } else if (f.op === 0 && this.parts.length) {
      this.parts.push(f.payload);
      this.partsLen += f.payload.length;
      if (this.partsLen > MAX_MESSAGE) {
        void this.close(1009);
        return this.#ended('a message was too big');
      }
    } else return;
    if (!f.fin) return;
    const all = Buffer.concat(this.parts);
    this.parts = [];
    if (this.partsOp === 1) this.msgFn(all.toString('utf8'));
  }

  #write(op, payload) {
    if (!this.sock || this.closed) return Promise.resolve();
    return this.sock.write(encodeFrame(op, payload, true)).catch(() => undefined);
  }

  send(text) {
    return this.#write(1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    return this.#write(9, Buffer.from('sara'));
  }

  #ended(why) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.closeFn(why);
  }

  async close(code = 1000) {
    if (this.sock && !this.closed) {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      await this.#write(8, p);
    }
    const s = this.sock;
    this.#ended('closed by Sara');
    this.sock = undefined;
    if (s) await s.close().catch(() => undefined);
  }
}
