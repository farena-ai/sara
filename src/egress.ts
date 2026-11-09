// EC9 (docs/ops/EC89_DESIGN.md): the egress allowlist proxy. One small HTTP proxy per sandboxed run:
// CONNECT for HTTPS and absolute-form requests for HTTP, only to listed hosts. It resolves names
// itself and refuses a listed name that points at a private or loopback address (so a command can
// never reach Sara's own server or the LAN through it). A listed host may carry a vault key: plain
// HTTP requests to it go upstream over HTTPS with the key added here, so the key never enters the
// sandbox. Self-contained on purpose (node: imports only): the container sidecar runs this very
// file (`node egress.ts serve`) and the bubblewrap bridge runs `node egress.ts forward`.
import { request as httpRequest, createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { connect, createServer as createNetServer, isIP, type Socket } from 'node:net';

export class EgressError extends Error {}

export interface EgressEntry {
  host: string;
  /** `*.example.com`: every subdomain of example.com (not example.com itself). */
  wildcard: boolean;
  /** Only this port; without it 80 and 443. */
  port?: number;
  /** A vault secret name added as `Authorization: Bearer …` at the proxy. */
  key?: string;
}
export type EgressInput = string | { host: string; key?: string };
export const MAX_EGRESS_HOSTS = 50;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const KEY = /^[\w.:-]{1,80}$/;

function parseHost(raw: string): Omit<EgressEntry, 'key'> {
  const s = raw.trim().toLowerCase();
  const m = /^(\*\.)?([^:]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) throw new EgressError(`"${raw.slice(0, 60)}" isn't a host name.`);
  const [, star, host, port] = m;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || isIP(host) || /^\d+$/.test(labels.at(-1)!)) throw new EgressError(`"${raw.slice(0, 60)}" isn't a host name (use a name such as example.com or *.example.com).`);
  if (star && labels.length < 2) throw new EgressError('A wildcard needs a domain under it.');
  const p = port === undefined ? undefined : Number(port);
  if (p !== undefined && (p < 1 || p > 65535)) throw new EgressError(`"${raw.slice(0, 60)}" has a port outside 1-65535.`);
  return { host, wildcard: Boolean(star), ...(p !== undefined ? { port: p } : {}) };
}

/** Checks an allowlist from settings or a policy pin; throws EgressError on the first bad entry. */
export function parseAllowlist(list: unknown): EgressEntry[] {
  if (!Array.isArray(list)) throw new EgressError('The allowlist must be a list.');
  if (list.length > MAX_EGRESS_HOSTS) throw new EgressError(`At most ${MAX_EGRESS_HOSTS} hosts.`);
  return list.map((v) => {
    if (typeof v === 'string') return parseHost(v);
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { host?: unknown }).host === 'string') {
      const { host, key } = v as { host: string; key?: unknown };
      if (key !== undefined && (typeof key !== 'string' || !KEY.test(key))) throw new EgressError('A key name may only use letters, digits and . : _ -');
      return { ...parseHost(host), ...(key ? { key } : {}) };
    }
    throw new EgressError('Each entry is a host name.');
  });
}

/** The entry that lets a connection to host:port through, if any. */
export function matchEntry(entries: readonly EgressEntry[], host: string, port: number): EgressEntry | undefined {
  const h = host.toLowerCase().replace(/\.$/, '');
  return entries.find((e) => (e.wildcard ? h.endsWith(`.${e.host}`) : h === e.host) && (e.port === undefined ? port === 80 || port === 443 : port === e.port));
}

/** Loopback, private, link-local, carrier-grade NAT, unspecified and unique-local addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

export type RefusalWhy = 'not-listed' | 'private' | 'key-http-only' | 'offline';
export interface EgressRefusal {
  host: string;
  port: number;
  why: RefusalWhy;
}

export interface EgressProxyOptions {
  entries: readonly EgressEntry[];
  /** TCP on 127.0.0.1 (port 0 = any), or a Unix socket / Windows pipe path. */
  listen?: { host?: string; port?: number } | { path: string };
  /** Name → address (tests inject one; default: the system resolver). */
  resolve?: (host: string) => Promise<string>;
  /** Tests only: let names resolve to loopback (the fake targets). Never set in Sara. */
  privateOk?: boolean;
  /** Where key-bearing requests go: HTTPS (default) or, in tests, plain HTTP. */
  upstreamHttps?: boolean;
  secret?: (name: string) => string | undefined;
  /** Sara's own guard (src/net-guard.ts): false while private local mode is on. */
  outboundAllowed?: (target: string) => boolean;
  /** Once per host:port per proxy (the caller writes the audit row). */
  onRefused?: (r: EgressRefusal) => void;
}

export interface EgressProxy {
  port?: number;
  path?: string;
  server: Server;
  close(): Promise<void>;
}

const defaultResolve = async (host: string) => (await lookup(host, { verbatim: true })).address;
const HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startEgressProxy(o: EgressProxyOptions): Promise<EgressProxy> {
  const resolve = o.resolve ?? defaultResolve;
  const told = new Set<string>();
  const sockets = new Set<Socket>();
  const refuse = (host: string, port: number, why: RefusalWhy) => {
    const k = `${host}:${port}`;
    if (!told.has(k)) {
      told.add(k);
      try {
        o.onRefused?.({ host, port, why });
      } catch {
        /* the audit hook must never break the run */
      }
    }
    return `Blocked by Sara's egress allowlist: ${k}${why === 'private' ? ' (a private address)' : why === 'key-http-only' ? ' (send plain http:// to this host; Sara adds the key)' : why === 'offline' ? ' (nothing leaves this computer)' : ''}\n`;
  };
  /** The address to dial, or a refusal text. */
  const admit = async (host: string, port: number, tunnel: boolean): Promise<{ addr: string; entry: EgressEntry } | { refused: string } | { failed: string }> => {
    const entry = isIP(host) ? undefined : matchEntry(o.entries, host, port);
    if (!entry) return { refused: refuse(host, port, 'not-listed') };
    if (tunnel && entry.key) return { refused: refuse(host, port, 'key-http-only') };
    // Private local mode switched on while the run was going: nothing leaves this computer.
    if (o.outboundAllowed && !o.outboundAllowed(`https://${host}:${port}/`)) return { refused: refuse(host, port, 'offline') };
    let addr: string;
    try {
      addr = await resolve(host);
    } catch {
      return { failed: `Could not find ${host}.\n` };
    }
    if (!o.privateOk && isPrivateIp(addr)) return { refused: refuse(host, port, 'private') };
    return { addr, entry };
  };

  const server = createHttpServer(async (req, res) => {
    let u: URL;
    try {
      u = new URL(req.url ?? '');
      if (u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Only proxy requests (http://host/…) or CONNECT.\n');
      return;
    }
    const port = Number(u.port || 80);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const a = await admit(host, port, false);
    if ('refused' in a) return void res.writeHead(403, { 'content-type': 'text/plain' }).end(a.refused);
    if ('failed' in a) return void res.writeHead(502, { 'content-type': 'text/plain' }).end(a.failed);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k) && k !== 'authorization') headers[k] = v;
    headers.host = u.host;
    const tls = Boolean(a.entry.key) && o.upstreamHttps !== false;
    if (a.entry.key) {
      const value = o.secret?.(a.entry.key);
      if (!value) return void res.writeHead(502, { 'content-type': 'text/plain' }).end(`The key for ${host} isn't saved in Sara.\n`);
      headers.authorization = `Bearer ${value}`;
    } else if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const up = (tls ? httpsRequest : httpRequest)({ host: a.addr, port: tls && !u.port ? 443 : port, method: req.method, path: `${u.pathname}${u.search}`, headers, ...(tls ? { servername: host } : {}) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`${host} did not answer.\n`);
    });
    req.pipe(up);
  });
  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(req.url ?? '');
    if (!m) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    const host = m[1].toLowerCase();
    const port = Number(m[2]);
    const a = await admit(host, port, true);
    if ('refused' in a) return void client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(a.refused)}\r\n\r\n${a.refused}`);
    if ('failed' in a) return void client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const up = connect(port, a.addr, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up);
    up.on('close', () => sockets.delete(up));
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const listen = o.listen ?? {};
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    if ('path' in listen) server.listen(listen.path, ok);
    else server.listen(listen.port ?? 0, listen.host ?? '127.0.0.1', ok);
  });
  const addr = server.address();
  return {
    server,
    ...(typeof addr === 'object' && addr ? { port: addr.port } : {}),
    ...('path' in listen ? { path: listen.path } : {}),
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

/** The bubblewrap bridge: 127.0.0.1:port inside the sandbox → the proxy's socket path outside it. */
export async function startForwarder(port: number, path: string): Promise<{ server: ReturnType<typeof createNetServer>; close(): Promise<void> }> {
  const conns = new Set<Socket>();
  const server = createNetServer((c) => {
    const up = connect(path);
    conns.add(c).add(up);
    c.pipe(up).pipe(c);
    const end = () => {
      c.destroy();
      up.destroy();
      conns.delete(c);
      conns.delete(up);
    };
    c.on('error', end).on('close', end);
    up.on('error', end).on('close', end);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  return {
    server,
    close: () =>
      new Promise<void>((ok) => {
        for (const s of conns) s.destroy();
        server.close(() => ok());
      }),
  };
}

/** Where the proxy appears for programs: the standard variables (curl, git, npm, pip; Node's fetch with NODE_USE_ENV_PROXY). */
export function proxyEnv(url: string): Record<string, string> {
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1', npm_config_proxy: url, npm_config_https_proxy: url };
}

// ---- run as a program: the container sidecar (`serve`) and the bubblewrap bridge (`forward`) ----
if (import.meta.main) {
  const [mode, a, b, c] = process.argv.slice(2);
  if (mode === 'serve') {
    const entries = parseAllowlist(JSON.parse(process.env.SARA_EGRESS_ALLOW ?? '[]'));
    const secrets = JSON.parse(process.env.SARA_EGRESS_SECRETS ?? '{}') as Record<string, string>;
    delete process.env.SARA_EGRESS_SECRETS;
    const p = await startEgressProxy({ entries, listen: { host: '0.0.0.0', port: Number(process.env.SARA_EGRESS_PORT ?? 3128) }, secret: (k) => secrets[k], onRefused: (r) => console.log(`SARA-EGRESS-REFUSED ${JSON.stringify(r)}`) });
    console.log(`SARA-EGRESS-READY ${p.port}`);
  } else if (mode === 'forward') {
    await startForwarder(Number(a), b);
    if (c) (await import('node:fs')).writeFileSync(c, 'ready');
  } else {
    console.error('usage: egress.ts serve | forward <port> <socket> [readyFile]');
    process.exit(2);
  }
}
