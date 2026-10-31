// Device-only D-Bus wire client. Unix sockets only; no TCP, fd passing or external packages.
import { createConnection, type Socket } from 'node:net';

const MAX = 8 * 1024 * 1024;
type Type = { code: string; children: Type[] };
export interface Variant { signature: string; value: unknown }
export const variant = (signature: string, value: unknown): Variant => ({ signature, value });
function types(signature: string): Type[] {
  if (signature.length > 255) throw new Error('D-Bus signature too long');
  let i = 0;
  const one = (depth = 0): Type => {
    if (depth > 32) throw new Error('D-Bus signature too deep');
    const code = signature[i++];
    if ('ybnqiuxtdhsogv'.includes(code ?? '') && code) return { code, children: [] };
    if (code === 'a') return { code, children: [one(depth + 1)] };
    if (code === '(' || code === '{') {
      const children: Type[] = [];
      while (i < signature.length && signature[i] !== (code === '(' ? ')' : '}')) children.push(one(depth + 1));
      if (signature[i++] !== (code === '(' ? ')' : '}') || !children.length || (code === '{' && children.length !== 2)) throw new Error('Invalid D-Bus signature');
      return { code, children };
    }
    throw new Error('Invalid D-Bus signature');
  };
  const out: Type[] = [];
  while (i < signature.length) out.push(one());
  return out;
}
const alignment = (t: Type): number => ({ y: 1, g: 1, v: 1, n: 2, q: 2, b: 4, i: 4, u: 4, h: 4, s: 4, o: 4, a: 4, x: 8, t: 8, d: 8, '(': 8, '{': 8 })[t.code]!;
class Writer {
  data = Buffer.alloc(MAX);
  pos: number;
  constructor(offset: number) { this.pos = offset; }
  align(n: number): void { this.pos = Math.ceil(this.pos / n) * n; }
  room(n: number): void { if (this.pos + n > MAX) throw new Error('D-Bus value too large'); }
  uint(n: number, bytes = 4): void { this.room(bytes); this.data.writeUIntLE(n, this.pos, bytes); this.pos += bytes; }
  put(t: Type, value: unknown): void {
    this.align(alignment(t));
    const c = t.code;
    if (c === 's' || c === 'o' || c === 'g') {
      const s = String(value);
      if (s.includes('\0') || (c === 'o' && !/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(s))) throw new Error('Invalid D-Bus string/path');
      if (c === 'g') types(s);
      const b = Buffer.from(s);
      if (c === 'g' && b.length > 255) throw new Error('D-Bus signature too long');
      this.uint(b.length, c === 'g' ? 1 : 4); this.room(b.length + 1); b.copy(this.data, this.pos); this.pos += b.length; this.uint(0, 1);
    } else if (c === 'v') {
      const v = value as Variant;
      const ts = types(v.signature);
      if (ts.length !== 1) throw new Error('A D-Bus variant needs one type');
      this.put({ code: 'g', children: [] }, v.signature); this.put(ts[0], v.value);
    } else if (c === 'a') {
      const child = t.children[0];
      const list = child.code === '{' && !Array.isArray(value) ? Object.entries(value as object) : Array.from(value as Iterable<unknown>);
      const at = this.pos; this.uint(0); this.align(alignment(child)); const start = this.pos;
      for (const x of list) this.put(child, x);
      this.data.writeUInt32LE(this.pos - start, at);
    } else if (c === '(' || c === '{') {
      const values = value as unknown[];
      if (!Array.isArray(values) || values.length !== t.children.length) throw new Error('D-Bus struct arity');
      t.children.forEach((ch, i) => this.put(ch, values[i]));
    } else {
      this.room(alignment(t));
      if (c === 'y') this.uint(Number(value), 1);
      else if (c === 'b') this.uint(value ? 1 : 0);
      else if (c === 'u' || c === 'h') this.uint(Number(value));
      else if (c === 'q') this.uint(Number(value), 2);
      else if (c === 'n') { this.data.writeInt16LE(Number(value), this.pos); this.pos += 2; }
      else if (c === 'i') { this.data.writeInt32LE(Number(value), this.pos); this.pos += 4; }
      else if (c === 'x' || c === 't') { if (c === 'x') this.data.writeBigInt64LE(BigInt(value as bigint), this.pos); else this.data.writeBigUInt64LE(BigInt(value as bigint), this.pos); this.pos += 8; }
      else if (c === 'd') { this.data.writeDoubleLE(Number(value), this.pos); this.pos += 8; }
    }
  }
}
class Reader {
  data: Buffer; pos: number; little: boolean;
  constructor(data: Buffer, offset = 0, little = true) { this.data = data; this.pos = offset; this.little = little; }
  need(n: number): void { if (n < 0 || this.pos + n > this.data.length) throw new Error('Truncated D-Bus value'); }
  align(n: number): void { const next = Math.ceil(this.pos / n) * n; this.need(next - this.pos); this.pos = next; }
  uint(bytes = 4): number { this.need(bytes); const n = this.little ? this.data.readUIntLE(this.pos, bytes) : this.data.readUIntBE(this.pos, bytes); this.pos += bytes; return n; }
  get(t: Type): unknown {
    this.align(alignment(t)); const c = t.code;
    if (c === 's' || c === 'o' || c === 'g') {
      const n = this.uint(c === 'g' ? 1 : 4); this.need(n + 1);
      const s = this.data.subarray(this.pos, this.pos + n).toString('utf8'); this.pos += n;
      if (this.uint(1) !== 0 || s.includes('\0')) throw new Error('Invalid D-Bus string');
      return s;
    }
    if (c === 'v') { const signature = this.get({ code: 'g', children: [] }) as string; const ts = types(signature); if (ts.length !== 1) throw new Error('Invalid D-Bus variant'); return variant(signature, this.get(ts[0])); }
    if (c === 'a') {
      const n = this.uint(); const child = t.children[0]; this.align(alignment(child)); this.need(n); const end = this.pos + n;
      const list: unknown[] = []; while (this.pos < end) list.push(this.get(child));
      if (this.pos !== end) throw new Error('Invalid D-Bus array length');
      if (child.code !== '{') return list;
      const dict = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of list as [string, unknown][]) Object.defineProperty(dict, k, { value: v, enumerable: true, configurable: true });
      return { ...dict };
    }
    if (c === '(' || c === '{') return t.children.map((ch) => this.get(ch));
    this.need(alignment(t));
    if (c === 'y' || c === 'q' || c === 'u' || c === 'h') return this.uint(alignment(t));
    if (c === 'b') { const n = this.uint(); if (n > 1) throw new Error('Invalid D-Bus boolean'); return Boolean(n); }
    let n: number | bigint;
    if (c === 'i') n = this.little ? this.data.readInt32LE(this.pos) : this.data.readInt32BE(this.pos);
    else if (c === 'n') n = this.little ? this.data.readInt16LE(this.pos) : this.data.readInt16BE(this.pos);
    else if (c === 'x') n = this.little ? this.data.readBigInt64LE(this.pos) : this.data.readBigInt64BE(this.pos);
    else if (c === 't') n = this.little ? this.data.readBigUInt64LE(this.pos) : this.data.readBigUInt64BE(this.pos);
    else n = this.little ? this.data.readDoubleLE(this.pos) : this.data.readDoubleBE(this.pos);
    this.pos += alignment(t); return n;
  }
}
export function encodeValues(signature: string, values: unknown[], offset = 0): Buffer {
  const w = new Writer(offset); const ts = types(signature);
  if (ts.length !== values.length) throw new Error('D-Bus signature/body arity');
  ts.forEach((t, i) => w.put(t, values[i])); return Buffer.from(w.data.subarray(offset, w.pos));
}
export function decodeValues(signature: string, data: Buffer): unknown[] { const r = new Reader(data); const values = types(signature).map((t) => r.get(t)); if (r.pos !== data.length) throw new Error('D-Bus body length mismatch'); return values; }
export interface Message {
  type: number; serial: number; flags?: number; path?: string; interface?: string; member?: string;
  error?: string; replySerial?: number; destination?: string; sender?: string; signature?: string; body?: unknown[];
}
const FIELDS = ['path', 'interface', 'member', 'error', 'replySerial', 'destination', 'sender', 'signature'] as const;
export function encodeMessage(m: Message): Buffer {
  const body = encodeValues(m.signature ?? '', m.body ?? []);
  const fields = FIELDS.flatMap((key, i) => m[key] === undefined || m[key] === '' ? [] : [[i + 1, variant(key === 'path' ? 'o' : key === 'replySerial' ? 'u' : key === 'signature' ? 'g' : 's', m[key])]]);
  const header = encodeValues('a(yv)', [fields], 12);
  const start = Math.ceil((12 + header.length) / 8) * 8;
  if (start + body.length > MAX) throw new Error('D-Bus message too large');
  const b = Buffer.alloc(start + body.length); b[0] = 108; b[1] = m.type; b[2] = m.flags ?? 0; b[3] = 1;
  b.writeUInt32LE(body.length, 4); b.writeUInt32LE(m.serial, 8); header.copy(b, 12); body.copy(b, start); return b;
}
export function messageLength(b: Buffer): number {
  if (b.length < 16) throw new Error('Truncated D-Bus header');
  if (![108, 66].includes(b[0]) || b[3] !== 1 || b[1] < 1 || b[1] > 4) throw new Error('Invalid D-Bus header');
  const u = (p: number) => b[0] === 108 ? b.readUInt32LE(p) : b.readUInt32BE(p);
  const length = Math.ceil((16 + u(12)) / 8) * 8 + u(4);
  if (length > MAX) throw new Error('D-Bus message too large'); return length;
}
export function decodeMessage(b: Buffer): Message {
  if (messageLength(b) !== b.length) throw new Error('Truncated D-Bus message/length');
  const r = new Reader(b, 12, b[0] === 108);
  const entries = r.get(types('a(yv)')[0]) as [number, Variant][];
  const m: Message = { type: b[1], flags: b[2], serial: b[0] === 108 ? b.readUInt32LE(8) : b.readUInt32BE(8) };
  for (const [id, v] of entries) if (id >= 1 && id <= 8) Object.assign(m, { [FIELDS[id - 1]]: v.value });
  r.align(8); m.body = types(m.signature ?? '').map((t) => r.get(t));
  if (r.pos !== b.length) throw new Error('D-Bus body length mismatch'); return m;
}
export function unixAddress(address: string): string {
  for (const part of address.split(';')) {
    if (!part.startsWith('unix:')) continue;
    const pairs = Object.fromEntries(part.slice(5).split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
    if (pairs.path?.startsWith('/') && !pairs.path.includes('\0')) return pairs.path;
    if (pairs.abstract && !pairs.abstract.includes('\0') && process.platform !== 'win32') return `\0${pairs.abstract}`;
    // Address parsing is portable; only the actual socket connection needs Linux.
    if (pairs.abstract && !pairs.abstract.includes('\0')) return `\0${pairs.abstract}`;
  }
  throw new Error('D-Bus requires an absolute Unix socket address');
}
export class DBus {
  #socket?: Socket; #buf = Buffer.alloc(0); #serial = 0; #binary = false;
  #auth?: { resolve: () => void; reject: (e: Error) => void };
  #pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #listeners = new Set<(m: Message) => void>();
  name = '';
  handler?: (m: Message) => Promise<{ signature?: string; body?: unknown[] }>;
  async connect(address = process.env.DBUS_SESSION_BUS_ADDRESS ?? ''): Promise<void> {
    if (process.platform === 'win32') throw new Error('D-Bus Unix sockets require Linux');
    const socket = createConnection({ path: unixAddress(address) }); this.#socket = socket;
    socket.on('data', (b: Buffer) => { try { this.#data(b); } catch (err) { this.close(err as Error); } });
    socket.on('error', (e) => this.close(e)); socket.on('close', () => this.close(new Error('D-Bus disconnected')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(new Error('D-Bus authentication timeout')); }, 5000);
      this.#auth = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      socket.once('connect', () => socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(process.getuid!())).toString('hex')}\r\n`));
    });
    this.name = String((await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'Hello'))[0]);
  }
  #data(data: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, data]);
    if (this.#buf.length > MAX) throw new Error('D-Bus receive buffer too large');
    if (!this.#binary) {
      const end = this.#buf.indexOf('\r\n'); if (end < 0) { if (this.#buf.length > 4096) throw new Error('D-Bus authentication too long'); return; }
      const line = this.#buf.subarray(0, end).toString('ascii'); this.#buf = this.#buf.subarray(end + 2);
      if (!/^OK [0-9a-f]+$/i.test(line)) throw new Error('D-Bus EXTERNAL authentication refused');
      this.#binary = true; this.#socket!.write('BEGIN\r\n'); this.#auth?.resolve(); this.#auth = undefined;
    }
    while (this.#buf.length >= 16) {
      const n = messageLength(this.#buf); if (this.#buf.length < n) break;
      const m = decodeMessage(this.#buf.subarray(0, n)); this.#buf = this.#buf.subarray(n);
      if ((m.type === 2 || m.type === 3) && m.replySerial) {
        const p = this.#pending.get(m.replySerial); if (!p) continue;
        this.#pending.delete(m.replySerial); clearTimeout(p.timer);
        if (m.type === 3) p.reject(new Error(`${m.error}: ${String(m.body?.[0] ?? 'D-Bus call failed')}`)); else p.resolve(m);
      } else if (m.type === 4) { for (const listener of this.#listeners) listener(m); }
      else if (m.type === 1 && this.handler) void this.handler(m).then((r) => this.send({ ...r, type: 2, replySerial: m.serial, destination: m.sender }), () => this.send({ type: 3, replySerial: m.serial, destination: m.sender, error: 'org.freedesktop.DBus.Error.Failed', signature: 's', body: ['Device service refused the call'] }));
    }
  }
  send(m: Omit<Message, 'serial'>): number {
    if (!this.#socket || this.#socket.destroyed) throw new Error('D-Bus not connected');
    const serial = ++this.#serial; this.#socket.write(encodeMessage({ ...m, serial })); return serial;
  }
  call(destination: string, path: string, iface: string, member: string, signature = '', body: unknown[] = [], ms = 10_000): Promise<unknown[]> {
    if (this.#pending.size >= 128) return Promise.reject(new Error('Too many pending D-Bus calls'));
    return new Promise((resolve, reject) => {
      const serial = this.#serial + 1;
      const timer = setTimeout(() => { this.#pending.delete(serial); reject(new Error(`D-Bus ${member} timed out`)); }, ms);
      this.#pending.set(serial, { resolve: (m) => resolve(m.body ?? []), reject, timer });
      try { this.send({ type: 1, destination, path, interface: iface, member, signature, body }); }
      catch (e) { clearTimeout(timer); this.#pending.delete(serial); reject(e); }
    });
  }
  onSignal(fn: (m: Message) => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  async match(rule: string): Promise<void> { await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [rule]); }
  async requestName(name: string): Promise<void> { const [result] = await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', 'su', [name, 4]); if (result !== 1) throw new Error('D-Bus service name unavailable'); }
  async owner(name: string): Promise<string> { return String((await this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', [name]))[0]); }
  close(error = new Error('D-Bus closed')): void {
    this.#auth?.reject(error); this.#auth = undefined;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.#pending.clear(); this.#listeners.clear(); const socket = this.#socket; this.#socket = undefined; socket?.destroy();
  }
}
