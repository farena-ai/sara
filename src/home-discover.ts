// V2.3 (docs/design/V2HOME.md): find Home Assistant on the home network. One mDNS question for
// `_home-assistant._tcp.local` (PTR, unicast reply asked) sent from a random port, so the answer
// comes straight back to us (RFC 6762 §6.7 legacy unicast; no listener on 5353, nothing kept open).
// The answer's PTR/SRV/TXT/A records become an address to prefill. Nothing but the question is sent.
import { createSocket } from 'node:dgram';
import { outboundAllowed } from './net-guard.ts';

export const HA_SERVICE = '_home-assistant._tcp.local';
const MDNS = { host: '224.0.0.251', port: 5353 };

export interface FoundHome {
  /** The address to prefill: http://<ipv4>:<port> when known, else Home Assistant's own URL. */
  url: string;
  name: string;
  version: string;
  /** Home Assistant's own internal/base URL, when it differs from `url`. */
  alt?: string;
}

interface Deps {
  to?: { host: string; port: number };
  timeoutMs?: number;
}
let deps: Deps = {};
/** Tests and live checks point the question at a fake responder (loopback). No argument = reset. */
export function setHomeDiscoverDeps(d: Deps = {}): void {
  deps = d;
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean).map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** The question: id, one PTR question for Home Assistant, class IN with the unicast-response bit. */
export function mdnsQuery(id = 0): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id & 0xffff, 0);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0);
  tail.writeUInt16BE(0x8001, 2);
  return Buffer.concat([head, encodeName(HA_SERVICE), tail]);
}

/** A (possibly compressed) name at `at`; returns the name and where the record continues. */
function readName(msg: Buffer, at: number): { name: string; next: number } {
  const labels: string[] = [];
  let i = at;
  let next = -1;
  for (let hops = 0; hops < 40; hops++) {
    if (i >= msg.length) throw new Error('short');
    const len = msg[i];
    if (len === 0) {
      if (next < 0) next = i + 1;
      return { name: labels.join('.'), next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (i + 1 >= msg.length) throw new Error('short');
      if (next < 0) next = i + 2;
      i = ((len & 0x3f) << 8) | msg[i + 1];
      continue;
    }
    if (i + 1 + len > msg.length) throw new Error('short');
    labels.push(msg.subarray(i + 1, i + 1 + len).toString('utf8'));
    i += len + 1;
  }
  throw new Error('loop');
}

/** Every Home Assistant an mDNS answer describes (garbage = none). */
export function decodeMdns(msg: Buffer): FoundHome[] {
  try {
    if (msg.length < 12) return [];
    const counts = [4, 6, 8, 10].map((o) => msg.readUInt16BE(o));
    let i = 12;
    for (let q = 0; q < counts[0]; q++) i = readName(msg, i).next + 4;
    const ptr: string[] = [];
    const srv = new Map<string, { port: number; target: string }>();
    const txt = new Map<string, Record<string, string>>();
    const a = new Map<string, string>();
    const total = counts[1] + counts[2] + counts[3];
    for (let r = 0; r < total && i < msg.length; r++) {
      const { name, next } = readName(msg, i);
      const type = msg.readUInt16BE(next);
      const len = msg.readUInt16BE(next + 8);
      const data = next + 10;
      if (data + len > msg.length) break;
      const key = name.toLowerCase();
      if (type === 12 && key === HA_SERVICE) ptr.push(readName(msg, data).name);
      if (type === 33) srv.set(key, { port: msg.readUInt16BE(data + 4), target: readName(msg, data + 6).name.toLowerCase() });
      if (type === 16) {
        const kv: Record<string, string> = {};
        for (let j = data; j < data + len; ) {
          const l = msg[j];
          const s = msg.subarray(j + 1, j + 1 + l).toString('utf8');
          const eq = s.indexOf('=');
          if (eq > 0) kv[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
          j += l + 1;
        }
        txt.set(key, kv);
      }
      if (type === 1 && len === 4) a.set(key, [...msg.subarray(data, data + 4)].join('.'));
      i = data + len;
    }
    const out: FoundHome[] = [];
    for (const inst of ptr) {
      const k = inst.toLowerCase();
      const s = srv.get(k);
      const t = txt.get(k) ?? {};
      const own = [t.internal_url, t.base_url].find((u) => /^https?:\/\/[^\s]{1,200}$/i.test(u ?? ''))?.replace(/\/+$/, '');
      const ip = s ? a.get(s.target) : undefined;
      const url = s && ip ? `http://${ip}:${s.port}` : own ?? (s ? `http://${s.target}:${s.port}` : '');
      if (!url) continue;
      const name = (t.location_name || inst.slice(0, inst.length - HA_SERVICE.length - 1) || 'Home Assistant').slice(0, 80);
      out.push({ url, name, version: String(t.version ?? '').slice(0, 20), ...(own && own !== url ? { alt: own } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Ask once and collect answers for `timeoutMs` (default 2.5 s). Never throws: no network = none. */
export function discoverHome(o: Deps = {}): Promise<FoundHome[]> {
  const to = o.to ?? deps.to ?? MDNS;
  const wait = o.timeoutMs ?? deps.timeoutMs ?? 2_500;
  // Private local mode: Home Assistant itself is refused there (netFetch), so the question isn't asked either.
  if (!outboundAllowed(`http://${to.host}:${to.port}`)) return Promise.resolve([]);
  return new Promise((resolve) => {
    const found = new Map<string, FoundHome>();
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, wait);
    sock.on('error', finish);
    sock.on('message', (msg) => {
      for (const f of decodeMdns(msg)) if (!found.has(f.url)) found.set(f.url, f);
    });
    sock.bind(0, () => {
      try {
        if (to.host === MDNS.host) sock.setMulticastTTL(255);
      } catch {
        /* not a multicast-capable socket */
      }
      sock.send(mdnsQuery(Math.floor(Math.random() * 0xffff)), to.port, to.host, (err) => {
        if (err) finish();
      });
    });
  });
}
