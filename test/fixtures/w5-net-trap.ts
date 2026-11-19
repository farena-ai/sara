// W5.2 (docs/design/W5LOCAL.md): a network trap loaded with `node --import` into a real Sara
// server (and, through NODE_OPTIONS, into every Node program it starts). It sits UNDER the net
// guard: every TCP/TLS socket, HTTP/2 session, fetch, DNS question and UDP packet the process
// tries is checked here. Anything that is not this computer is refused (nothing ever really
// leaves) and written as one JSON line to W5_TRAP_LOG, with a short stack so a new outbound path
// is easy to find. Loopback is allowed only to the ports in W5_TRAP_PORTS (the test's own fake
// model and the server itself); other loopback ports (a real Ollama, the owner's own Sara) are
// refused too and logged as `loopback`, so the test never touches a real program on this PC.
import { appendFileSync } from 'node:fs';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const LOG = process.env.W5_TRAP_LOG ?? '';
const PORTS = new Set((process.env.W5_TRAP_PORTS ?? '').split(',').filter(Boolean).map(Number));

const loopback = (host: string): boolean => {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::1' || /^::ffff:127\./.test(h);
};

function hit(kind: string, target: string, loop = false): void {
  if (!LOG) return;
  const stack = (new Error().stack ?? '').split('\n').slice(3, 12).map((l) => l.trim()).filter((l) => !l.includes('w5-net-trap'));
  try {
    appendFileSync(LOG, JSON.stringify({ kind, target, loopback: loop, pid: process.pid, stack }) + '\n');
  } catch {
    /* the trap never breaks the program it watches */
  }
}

const refused = (target: string) => Object.assign(new Error(`W5 trap: ${target} is not this computer (refused, nothing was sent)`), { code: 'ECONNREFUSED' });

/** May this host:port be reached? Logs and answers false when not. */
function allowed(kind: string, host: string, port: number | undefined): boolean {
  if (!loopback(host)) {
    hit(kind, `${host}:${port ?? ''}`);
    return false;
  }
  if (port !== undefined && !PORTS.has(Number(port))) {
    hit(kind, `${host}:${port}`, true);
    return false;
  }
  return true;
}

// TCP (and TLS, HTTP/1, HTTP/2, undici's fetch and WebSocket, which all connect through here).
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  let o = args[0] as unknown;
  if (Array.isArray(o)) o = o[0];
  let host: string | undefined;
  let port: number | undefined;
  let path: string | undefined;
  if (o && typeof o === 'object') {
    const x = o as { host?: string; port?: number | string; path?: string };
    host = x.host;
    port = x.port === undefined ? undefined : Number(x.port);
    path = x.path;
  } else if (typeof o === 'number' || (typeof o === 'string' && /^\d+$/.test(o))) {
    port = Number(o);
    host = typeof args[1] === 'string' ? (args[1] as string) : undefined;
  } else if (typeof o === 'string') path = o;
  // Unix sockets and Windows named pipes stay on this computer.
  if (path) return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  if (!allowed('socket', host ?? 'localhost', port)) {
    process.nextTick(() => this.destroy(refused(`${host}:${port}`)));
    return this;
  }
  return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

// tls.connect may be given an existing socket; a fresh one goes through the socket trap above.
const origTls = tls.connect;
(tls as { connect: unknown }).connect = function (...args: unknown[]) {
  const o = (args.find((a) => a && typeof a === 'object') ?? {}) as { host?: string; port?: number; socket?: unknown; servername?: string };
  const host = o.host ?? (typeof args[1] === 'string' ? (args[1] as string) : undefined) ?? o.servername ?? 'localhost';
  const port = o.port ?? (typeof args[0] === 'number' ? (args[0] as number) : undefined);
  if (!o.socket && !loopback(host)) hit('tls', `${host}:${port ?? ''}`);
  return (origTls as (...a: unknown[]) => tls.TLSSocket).apply(tls, args);
};

// DNS: a question about a name that is not this computer leaves the computer too.
const dnsName = (n: unknown) => (typeof n === 'string' ? n : String(n));
const origLookup = dns.lookup;
(dns as { lookup: unknown }).lookup = function (name: unknown, ...rest: unknown[]) {
  if (loopback(dnsName(name))) return (origLookup as (...a: unknown[]) => void).call(dns, name, ...rest);
  hit('dns', dnsName(name));
  const cb = rest.find((r) => typeof r === 'function') as ((e: Error) => void) | undefined;
  if (cb) process.nextTick(() => cb(Object.assign(new Error(`W5 trap: DNS lookup of ${dnsName(name)} refused`), { code: 'ENOTFOUND' })));
};
const origPLookup = dns.promises.lookup;
(dns.promises as { lookup: unknown }).lookup = async (name: unknown, ...rest: unknown[]) => {
  if (loopback(dnsName(name))) return (origPLookup as (...a: unknown[]) => Promise<unknown>)(name, ...rest);
  hit('dns', dnsName(name));
  throw Object.assign(new Error(`W5 trap: DNS lookup of ${dnsName(name)} refused`), { code: 'ENOTFOUND' });
};
for (const m of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse'] as const) {
  (dns as unknown as Record<string, unknown>)[m] = (name: unknown, ...rest: unknown[]) => {
    hit('dns', dnsName(name));
    const cb = rest.find((r) => typeof r === 'function') as ((e: Error) => void) | undefined;
    if (cb) process.nextTick(() => cb(Object.assign(new Error('W5 trap: DNS refused'), { code: 'ENOTFOUND' })));
  };
  (dns.promises as unknown as Record<string, unknown>)[m] = async (name: unknown) => {
    hit('dns', dnsName(name));
    throw Object.assign(new Error('W5 trap: DNS refused'), { code: 'ENOTFOUND' });
  };
}
for (const P of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const m of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveSrv', 'reverse']) {
    (P as unknown as Record<string, unknown>)[m] = function (name: unknown, ...rest: unknown[]) {
      hit('dns', dnsName(name));
      const cb = rest.find((r) => typeof r === 'function') as ((e: Error) => void) | undefined;
      if (cb) return void process.nextTick(() => cb(Object.assign(new Error('W5 trap: DNS refused'), { code: 'ENOTFOUND' })));
      return Promise.reject(Object.assign(new Error('W5 trap: DNS refused'), { code: 'ENOTFOUND' }));
    };
  }
}

// UDP (mDNS, SSDP, anything else): packets to other computers or multicast are dropped.
const origSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: unknown[]) {
  const fnIdx = args.findIndex((a) => typeof a === 'function');
  const strs = args.filter((a, i) => typeof a === 'string' && i > 0) as string[];
  const nums = args.filter((a, i) => typeof a === 'number' && i > 0) as number[];
  const host = strs.at(-1) ?? 'localhost';
  const port = nums.at(-1);
  if (!allowed('udp', host, port)) {
    if (fnIdx >= 0) process.nextTick(() => (args[fnIdx] as (e: Error) => void)(refused(`${host}:${port}`)));
    return;
  }
  return (origSend as (...a: unknown[]) => void).apply(this, args);
} as typeof dgram.Socket.prototype.send;

// fetch (undici): checked here too, so the log names the full address.
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let u: URL | undefined;
  try {
    u = new URL(href);
  } catch {
    /* let fetch say what is wrong */
  }
  if (u && (u.protocol === 'http:' || u.protocol === 'https:')) {
    const host = u.hostname;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!loopback(host)) {
      hit('fetch', `${u.protocol}//${u.host}${u.pathname}`);
      throw new TypeError('fetch failed', { cause: refused(u.host) });
    }
    if (!PORTS.has(port)) {
      hit('fetch', `${u.protocol}//${u.host}${u.pathname}`, true);
      throw new TypeError('fetch failed', { cause: refused(u.host) });
    }
  }
  return origFetch(input, init);
}) as typeof fetch;
