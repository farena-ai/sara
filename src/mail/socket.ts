// M1: the encrypted connection to the owner's own IMAP / SMTP server, with the socket broker's
// helpers (src/plugins/net.ts): the guard first (private local mode blocks it), the name resolved
// once, public addresses only (a program on this computer only for Proton Mail Bridge), TLS always
// (implicit on 993/465, STARTTLS by Sara on 143/587/1143/1025 before anything else is sent),
// certificates checked against the host name. The socket is wrapped in the small shape the email
// bridge's IMAP and SMTP code takes (plugins/email/imap.mjs, smtp.mjs).
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { checkOutbound } from '../net-guard.ts';
import { addressAllowed, connectTcp, defaultLookup, isLoopbackAddress, loopbackMailOverride, startTls, upgrade } from '../plugins/net.ts';

/** What plugins/email/imap.mjs and smtp.mjs expect of a socket. */
export interface WireSocket {
  onData(fn: (b: Buffer) => void): void;
  onClose(fn: (why: string) => void): void;
  write(b: Buffer): Promise<void>;
  close(): Promise<void>;
}

const STARTTLS: Record<number, 'imap' | 'smtp'> = { 143: 'imap', 1143: 'imap', 587: 'smtp', 1025: 'smtp' };

export interface OpenOpts {
  /** Proton Mail Bridge: loopback only, its own certificate pinned (trusted on first use). */
  loopback?: boolean;
  fingerprint?: string;
  /** Tests: a CA for the stand-in server, a DNS answer, and the stand-in on loopback (only under node --test). */
  ca?: string;
  lookup?: (host: string) => Promise<string[]>;
  testLoopback?: boolean;
}

export async function openMailSocket(host: string, port: number, opts: OpenOpts = {}): Promise<{ sock: WireSocket; greeting?: string; fingerprint?: string }> {
  checkOutbound(`tcp://${isIP(host) === 6 ? `[${host}]` : host}:${port}`, 'your mail server', Boolean(opts.loopback));
  const addrs = isIP(host) ? [host] : await (opts.lookup ?? defaultLookup)(host).catch(() => [] as string[]);
  if (!addrs.length) throw new Error(`${host} couldn't be found`);
  const test = loopbackMailOverride(opts.testLoopback) && addrs.every(isLoopbackAddress);
  for (const ip of addrs) {
    if (opts.loopback ? !isLoopbackAddress(ip) : !test && addressAllowed(ip, 'public', false)) throw new Error(opts.loopback ? `${host} isn't this computer (Proton Mail Bridge runs on this computer: 127.0.0.1)` : `${host} (${ip}) is a private or local address; Sara only connects to public mail servers`);
  }
  const plain = await connectTcp(addrs[0], port);
  const kind = STARTTLS[port];
  const greeting = kind ? await startTls(plain, kind, 'sara.localdomain') : undefined;
  const t: TLSSocket = await upgrade(plain, host, opts.ca, opts.loopback ? { loopback: true, ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}) } : undefined);
  const fingerprint = opts.loopback ? t.getPeerCertificate?.()?.fingerprint256 : undefined;
  let closed = false;
  const sock: WireSocket = {
    onData: (fn) => void t.on('data', fn),
    onClose: (fn) => {
      t.on('close', () => fn('closed'));
      t.on('error', (e) => fn(e.message));
    },
    write: (b) => new Promise((res, rej) => (closed ? rej(new Error('closed')) : t.write(b, (err) => (err ? rej(err) : res())))),
    close: async () => {
      closed = true;
      t.end();
      t.destroy();
    },
  };
  t.on('error', () => undefined);
  return { sock, ...(greeting !== undefined ? { greeting } : {}), ...(fingerprint ? { fingerprint } : {}) };
}
